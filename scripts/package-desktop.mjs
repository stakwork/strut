#!/usr/bin/env node
/**
 * Stage a self-contained strut directory for embedding in a native desktop
 * app (plans/local-desktop-and-stt.md §2.3, "phase A").
 *
 *   npm run package:desktop -- [--platform darwin-arm64] [--out dist-desktop] [--smoke] [--tar] [--skip-build] [--embeddings]
 *
 * Output: <out>/strut/ containing package.json, build/ (server + steps as
 * loose files — the registry scans them), web/dist/, a production-only
 * node_modules/ (sherpa-onnx-node pinned to the version installed at the repo
 * root, i.e. the lockfile's — see `sherpaVersion` — and only this platform's
 * onnxruntime-node binaries), native/ — the sherpa addon and the shared
 * libraries it links, moved out of the sherpa-onnx-<platform> package so the
 * host has one directory of binaries to code-sign and nothing to sign
 * anywhere else (see `relocateNative`) — and two entry points: `desktop.js`
 * (what a host spawns: fs workspace, 127.0.0.1:0, app-support dirs, a
 * generated API key on the ready line — every default an env override) and
 * `strut` (shell wrapper over it for people who downloaded the tarball).
 * Node itself is not included; the host provides one (20 or newer).
 * `--tar` also writes <out>/strut-<platform>.tar.gz — the release asset
 * (.github/workflows/strut-desktop.yml).
 *
 * Two size cuts, both on by default:
 *   - the embeddings stack (@huggingface/transformers + onnxruntime-web/-node
 *     + sharp, ~200 MB) is uninstalled — MiniLM only serves graph search,
 *     which needs a Neo4j the desktop build doesn't ship; `--embeddings`
 *     keeps it, and graph/embeddings.ts fails with a clear message without it;
 *   - sourcemaps, typings, and docs are stripped from node_modules (~100 MB).
 *
 * --smoke boots the staged copy via desktop.js from a temp directory (so
 * nothing can leak in from this checkout) with only STRUT_WORKSPACE and
 * STRUT_CACHE_DIR set, parses the ready line for port + key, and checks
 * /health, /audio/models (`available: true` = the sherpa addon loaded) and
 * that a custom step importing "strut" from that workspace registered.
 *
 * Not a single-file build on purpose: the step loader scans directories and
 * the sherpa addon must be a real file beside the binary either way (§2.4).
 */
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true) : dflt;
};
const platform = String(flag("platform", `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`));
const out = resolve(ROOT, String(flag("out", "dist-desktop")));
const smoke = flag("smoke", false) === true;
const tar = flag("tar", false) === true;
const skipBuild = flag("skip-build", false) === true;
const embeddings = flag("embeddings", false) === true;
const stage = join(out, "strut");
const native = join(stage, "native");

const SHERPA_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win-x64", "win-ia32"];
if (!SHERPA_PLATFORMS.includes(platform)) {
  console.error(`unknown platform ${platform}; one of ${SHERPA_PLATFORMS.join(", ")}`);
  process.exit(2);
}
const NATIVE_EXT = /\.(node|dylib|so|dll)$/;
// onnxruntime-node lays its binaries out as bin/napi-v6/<os>/<arch>.
const [ortOs, ortArch] = platform.replace(/^win-/, "win32-").split("-");

const installedVersion = async (dir) => {
  try {
    return JSON.parse(await readFile(join(dir, "package.json"), "utf-8")).version;
  } catch {
    return null;
  }
};
// The stage's `npm install` runs in a fresh directory with no lockfile, so left
// to itself it resolves sherpa-onnx-node to whatever is newest on npm — not what
// the root lockfile pins and the tests ran against. Worse, upstream publishes
// the six platform addons from separate jobs, sometimes hours after the wrapper
// (1.13.8: wrapper 13:58 UTC, darwin-arm64 18:07 UTC), so "newest" can be a
// version whose addon for this platform doesn't exist yet. Pin the wrapper and
// the addon to the version installed at the root instead.
const sherpaVersion = await installedVersion(join(ROOT, "node_modules", "sherpa-onnx-node"));
if (!sherpaVersion) {
  console.error("sherpa-onnx-node isn't installed at the repo root (node_modules/sherpa-onnx-node); run `yarn install` first");
  process.exit(2);
}

const log = (m) => console.log(`[package-desktop] ${m}`);
const run = (cmd, cmdArgs, cwd = ROOT, env = process.env) => {
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit", env });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(" ")} failed (${r.status})`);
};
// Every npm call inside the stage resolves optional platform packages for the
// *target*, not this machine (npm ≥ 9.6.3 `os`/`cpu` config). Without this a
// cross-stage silently ships the host's sherpa addon, and even a same-platform
// `npm uninstall` later would reconcile the tree back to the host's.
const npmStage = (cmdArgs) => run("npm", cmdArgs, stage, { ...process.env, npm_config_os: ortOs, npm_config_cpu: ortArch });
const sizeOf = async (p) => {
  const s = await stat(p);
  if (!s.isDirectory()) return s.size;
  let n = 0;
  for (const e of await readdir(p)) n += await sizeOf(join(p, e));
  return n;
};
const mb = (n) => `${Math.round(n / 1e6)} MB`;

async function build() {
  if (skipBuild) return log("skipping build (--skip-build)");
  log("building server (tsc) and web UI (vite)");
  run("npm", ["run", "build"]);
  run("npm", ["run", "build:web"]);
}

async function stageFiles() {
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf-8"));
  // The host runs `node build/server.js`; drop the dev surface from the manifest.
  delete pkg.devDependencies;
  delete pkg.scripts;
  pkg.private = true;
  // Exact pins (see sherpaVersion). Listing the platform addon directly makes
  // `npm install` fetch it at this version and dedupe sherpa-onnx-node's own
  // `^` range onto it, instead of floating that range to npm's newest.
  pkg.optionalDependencies = { ...pkg.optionalDependencies, "sherpa-onnx-node": sherpaVersion, [`sherpa-onnx-${platform}`]: sherpaVersion };
  await writeFile(join(stage, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  await cp(join(ROOT, "build"), join(stage, "build"), { recursive: true });
  await cp(join(ROOT, "web", "dist"), join(stage, "web", "dist"), { recursive: true });
  for (const f of ["desktop.js", "strut"]) {
    await cp(join(ROOT, "scripts", f), join(stage, f));
    await chmod(join(stage, f), 0o755);
  }
  log(`staged build/ + web/dist/ + desktop.js + strut → ${stage}`);
}

async function installDeps() {
  log(`installing production dependencies (npm install --omit=dev); sherpa-onnx-node + sherpa-onnx-${platform} pinned at ${sherpaVersion}`);
  // optionalDependencies (sherpa-onnx-node + the pinned platform package) come
  // along; anything else sherpa's own ranges pull in is removed below.
  npmStage(["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock", "--ignore-scripts"]);
  const nm = join(stage, "node_modules");

  // One sherpa platform package.
  for (const p of SHERPA_PLATFORMS) {
    if (p === platform) continue;
    await rm(join(nm, `sherpa-onnx-${p}`), { recursive: true, force: true });
  }
  const keep = join(nm, `sherpa-onnx-${platform}`);
  if (!(await installedVersion(keep))) {
    // npm < 9.6.3 ignores npm_config_os/cpu and skips an addon that doesn't
    // match the host; --force gets it in anyway.
    log(`npm install skipped sherpa-onnx-${platform}; fetching it explicitly`);
    try {
      npmStage(["install", "--no-save", "--no-audit", "--no-fund", "--no-package-lock", "--ignore-scripts", "--force", `sherpa-onnx-${platform}@${sherpaVersion}`]);
    } catch (e) {
      throw new Error(
        `${e.message}\nsherpa-onnx-${platform}@${sherpaVersion} may not be on npm: upstream publishes each platform addon from its own job, ` +
          `sometimes hours after sherpa-onnx-node itself. Check \`npm view sherpa-onnx-${platform} versions\` and keep the root lockfile on a version whose addon has landed.`,
      );
    }
  }
  const got = await installedVersion(keep);
  if (got !== sherpaVersion) throw new Error(`sherpa-onnx-${platform} is ${got ?? "missing"} in the stage, expected ${sherpaVersion} (the version installed at the repo root)`);

  // Only this platform's onnxruntime binaries (the package ships all of them).
  const ortBin = join(nm, "onnxruntime-node", "bin", "napi-v6");
  try {
    for (const os of await readdir(ortBin)) {
      if (os !== ortOs) {
        await rm(join(ortBin, os), { recursive: true, force: true });
        continue;
      }
      for (const arch of await readdir(join(ortBin, os))) {
        if (arch !== ortArch) await rm(join(ortBin, os, arch), { recursive: true, force: true });
      }
    }
  } catch {
    /* onnxruntime-node absent — nothing to prune */
  }
  if (!embeddings) {
    // npm removes the package and everything only it depended on, and drops
    // it from the staged package.json so the manifest matches the build.
    log("removing the embeddings stack (@huggingface/transformers and its deps); --embeddings keeps it");
    npmStage(["uninstall", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock", "--ignore-scripts", "@huggingface/transformers"]);
  }
  await rm(join(nm, ".package-lock.json"), { force: true });
  // Never emit a package for the wrong platform: exactly the target's sherpa
  // package, and only it, must be present.
  const present = (await readdir(nm)).filter((d) => /^sherpa-onnx-(darwin|linux|win)-/.test(d));
  if (present.length !== 1 || present[0] !== `sherpa-onnx-${platform}`) {
    throw new Error(`expected only sherpa-onnx-${platform} in the stage, found: ${present.join(", ") || "none"} (npm ≥ 9.6.3 needed for cross-staging)`);
  }
  await strip(nm);
}

// The addon finds its shared libraries relative to its own location (on
// macOS via @rpath with @loader_path as its only usable rpath — `otool -l`;
// $ORIGIN on Linux; the loading module's directory on Windows), so they must
// stay beside it — but nothing says beside it inside node_modules. Move the
// set into <stage>/native/, one directory holding every binary in the package
// and nothing else, so the host signs that directory and never has to pick
// Mach-O files out of a package folder. sherpa-onnx-node's
// `addon-static-import.js` is the first thing its addon.js tries and the one
// file that hard-codes `../sherpa-onnx-<platform>/sherpa-onnx.node`; it
// becomes the redirect. The emptied platform package (index.js, package.json,
// README — nothing loads them) goes away, and so does its manifest pin.
async function relocateNative() {
  const nm = join(stage, "node_modules");
  const pkgDir = join(nm, `sherpa-onnx-${platform}`);
  const wrapper = join(nm, "sherpa-onnx-node");
  const addonJs = await readFile(join(wrapper, "addon.js"), "utf-8").catch(() => "");
  if (!addonJs.includes("require('./addon-static-import')")) {
    throw new Error(`sherpa-onnx-node@${sherpaVersion}: addon.js no longer starts from ./addon-static-import; its addon lookup changed — update relocateNative`);
  }
  await mkdir(native, { recursive: true });
  const moved = [];
  let dropped = null;
  for (const f of await readdir(pkgDir)) {
    if (!NATIVE_EXT.test(f)) continue;
    // The C++ API wrapper library. Nothing in the package links it (the addon
    // links the C API and onnxruntime; the C API links onnxruntime): one less
    // binary to sign.
    if (/sherpa-onnx-cxx-api\./.test(f)) {
      dropped = f;
      continue;
    }
    await rename(join(pkgDir, f), join(native, f));
    moved.push(f);
  }
  if (!moved.includes("sherpa-onnx.node")) throw new Error(`no sherpa-onnx.node in ${pkgDir}; moved ${moved.join(", ") || "nothing"}`);
  await rm(pkgDir, { recursive: true, force: true });
  await writeFile(
    join(wrapper, "addon-static-import.js"),
    `// Written by strut's scripts/package-desktop.mjs (relocateNative). The addon
// and the shared libraries it links live in ../../native — one directory
// holding every binary the host code-signs — instead of a
// sherpa-onnx-<platform> package. The libraries must stay beside the addon:
// it finds them relative to its own location.
module.exports = require('../../native/sherpa-onnx.node');
`,
  );
  // stageFiles listed the platform package to pin the install; it is not in
  // the tree any more, so it leaves the manifest too.
  const pkgPath = join(stage, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
  if (pkg.optionalDependencies) delete pkg.optionalDependencies[`sherpa-onnx-${platform}`];
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  log(`moved ${moved.join(", ")} → native/${dropped ? `; dropped ${dropped} (nothing links it)` : ""}; sherpa-onnx-node now loads ../../native/sherpa-onnx.node`);
}

// Sourcemaps, typings, and docs are dead weight in a shipped app. Licenses
// stay. Only node_modules is touched (strut's own build/ keeps its .d.ts).
const STRIP_EXT = [".map", ".d.ts", ".d.mts", ".d.cts", ".md", ".markdown"];
const STRIP_NAMES = new Set(["CHANGELOG", "CHANGES", "HISTORY", ".github", ".vscode", ".idea"]);
async function strip(dir) {
  let files = 0;
  let bytes = 0;
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const base = e.name.replace(/\.(md|txt|markdown)$/i, "");
      if (STRIP_NAMES.has(base) || STRIP_NAMES.has(e.name)) {
        bytes += await sizeOf(p);
        files++;
        await rm(p, { recursive: true, force: true });
        continue;
      }
      if (e.isDirectory()) {
        await walk(p);
        continue;
      }
      if (/^licen[cs]e/i.test(e.name)) continue;
      if (STRIP_EXT.some((x) => e.name.endsWith(x))) {
        bytes += (await stat(p)).size;
        files++;
        await rm(p, { force: true });
      }
    }
  };
  await walk(dir);
  log(`stripped ${files} sourcemap/typing/doc files (${mb(bytes)}) from node_modules`);
}

async function report() {
  const nm = join(stage, "node_modules");
  const total = await sizeOf(stage);
  const rows = [];
  for (const e of await readdir(nm)) {
    if (e.startsWith(".")) continue;
    if (e.startsWith("@")) {
      for (const s of await readdir(join(nm, e))) rows.push([`${e}/${s}`, await sizeOf(join(nm, e, s))]);
    } else rows.push([e, await sizeOf(join(nm, e))]);
  }
  rows.push(["native/ (outside node_modules)", await sizeOf(native)]);
  rows.sort((a, b) => b[1] - a[1]);
  log(`staged ${stage}: ${mb(total)} total, ${rows.length - 1} packages; largest:`);
  for (const [name, size] of rows.slice(0, 8)) console.log(`    ${mb(size).padStart(7)}  ${name}`);
  // Everything the host must code-sign, in one place: the addon plus the
  // shared libraries it links (relocateNative), all of which must be signed
  // and notarized inside the app bundle, not just the .node. Nothing else in
  // the package is a binary — enforced here, because the host's signing step
  // is "sign native/". --embeddings is the one exception: onnxruntime-node
  // and sharp keep their addons in node_modules, where their loaders look.
  const inNative = (await readdir(native)).filter((f) => NATIVE_EXT.test(f));
  const stray = [];
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (NATIVE_EXT.test(e.name)) stray.push(p.slice(nm.length + 1));
    }
  };
  await walk(nm);
  log(`native binaries the host must code-sign (${inNative.length}, all in native/):`);
  for (const f of inNative) console.log(`    native/${f}`);
  if (stray.length) {
    if (!embeddings) throw new Error(`binaries outside native/, which the host would not sign: ${stray.join(", ")}`);
    log(`plus ${stray.length} kept in node_modules by --embeddings (their loaders look there):`);
    for (const a of stray) console.log(`    node_modules/${a}`);
  }
}

async function smokeTest() {
  // Run from a temp copy so resolution can't fall back into this checkout.
  const tmp = await mkdtemp(join(tmpdir(), "strut-desktop-"));
  const app = join(tmp, "strut");
  const workspace = join(tmp, "Application Support", "workspace");
  const cache = join(tmp, "cache");
  log(`smoke: copying stage → ${app}`);
  await cp(stage, app, { recursive: true });
  await mkdir(join(workspace, "steps", "custom"), { recursive: true });
  await writeFile(
    join(workspace, "steps", "custom", "smoke-step.ts"),
    `import { z, defineStep } from "strut";
export default defineStep({
  type: "smoke-step",
  input: z.object({ name: z.string() }),
  output: z.string(),
  async run({ input }) { return "hi " + input.name; },
});
`,
  );
  // Only the two dirs, so the launcher's own defaults (fs backend, loopback,
  // port 0, generated key) are what gets tested. Strip any STRUT_* from the
  // developer's shell so they can't paper over a missing default.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("STRUT_")));
  env.STRUT_WORKSPACE = workspace;
  env.STRUT_CACHE_DIR = cache;
  log(`smoke: node desktop.js from a foreign cwd (workspace + cache under ${tmp})`);
  const child = spawn(process.execPath, [join(app, "desktop.js")], { cwd: tmp, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let stdout = "";
  child.stdout.on("data", (d) => ((output += d), (stdout += d)));
  child.stderr.on("data", (d) => (output += d));
  const deadline = Date.now() + 30_000;
  let ready = null;
  while (Date.now() < deadline && !ready) {
    if (child.exitCode !== null) break;
    ready = stdout
      .split("\n")
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((j) => j?.event === "ready");
    if (!ready) await new Promise((r) => setTimeout(r, 100));
  }
  const failures = [];
  try {
    if (!ready) throw new Error(`no ready line within 30 s:\n${output}`);
    if (ready.host !== "127.0.0.1") failures.push(`ready.host ${ready.host}, expected 127.0.0.1`);
    if (!(ready.port > 0)) failures.push(`ready.port ${ready.port}`);
    if (typeof ready.key !== "string" || ready.key.length < 32) failures.push(`ready.key missing or short: ${JSON.stringify(ready.key)}`);
    const { port, key } = ready;
    const base = `http://127.0.0.1:${port}`;
    const headers = { authorization: `Bearer ${key}` };
    if (!output.includes(`strut ui: ${base}/?key=${key}`)) failures.push("launcher did not print the UI URL on stderr");
    const health = await (await fetch(`${base}/health`)).json();
    if (!health.ok) failures.push("health not ok");
    if (health.dataDir !== workspace) failures.push(`dataDir ${health.dataDir} != ${workspace}`);

    const steps = await (await fetch(`${base}/steps`)).text();
    if (!steps.includes("smoke-step")) failures.push('custom step importing "strut" from an out-of-tree workspace did not register');

    const unauth = await fetch(`${base}/audio/models`);
    if (unauth.status !== 401) failures.push(`/audio/models without key: ${unauth.status}, expected 401`);
    const models = await (await fetch(`${base}/audio/models`, { headers })).json();
    if (!models.available) failures.push("sherpa addon did not load in the staged copy (available: false)");
    if (!models.modelDir.startsWith(cache)) failures.push(`modelDir ${models.modelDir} not under STRUT_CACHE_DIR`);

    const ui = await fetch(`${base}/`);
    if (!ui.ok || !(await ui.text()).includes("<div id=\"app\"")) failures.push("web UI index did not serve");
  } catch (e) {
    failures.push(String(e));
  } finally {
    child.kill("SIGTERM");
  }
  if (/Warning: failed to load step/.test(output)) failures.push(`step load warning:\n${output}`);
  await rm(tmp, { recursive: true, force: true });
  if (failures.length) {
    console.error(`[package-desktop] SMOKE FAILED\n - ${failures.join("\n - ")}`);
    process.exit(1);
  }
  log("smoke: OK — desktop.js boots with no STRUT_* env beyond the two dirs, ready line carries port + key, addon loads, out-of-tree custom step resolves, UI serves");
}

async function tarball() {
  const name = `strut-${platform}.tar.gz`;
  run("tar", ["-czf", join(out, name), "-C", out, "strut"]);
  log(`wrote ${join(out, name)} (${mb((await stat(join(out, name))).size)})`);
}

await build();
await stageFiles();
await installDeps();
await relocateNative();
await report();
if (smoke) await smokeTest();
if (tar) await tarball();
log(`done. Host contract: plans/native-dictation-client.md §0; spawn \`node ${join(stage, "desktop.js")}\` or run \`${join(stage, "strut")} --open\``);
