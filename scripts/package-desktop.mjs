#!/usr/bin/env node
/**
 * Stage a self-contained strut directory for embedding in a native desktop
 * app (plans/local-desktop-and-stt.md §2.3, "phase A").
 *
 *   npm run package:desktop -- [--platform darwin-arm64] [--out dist-desktop] [--smoke] [--tar] [--skip-build] [--embeddings] [--no-stt]
 *
 * Output: <out>/strut/ containing package.json, build/ (server + steps as
 * loose files — the registry scans them), web/dist/, a production-only
 * node_modules/ copied from the repo root's — checked to be yarn.lock's
 * install, then package by package against it (see `installDeps`) — stubs for the optional packages a
 * build leaves out, only this platform's onnxruntime-node binaries — native/ — the sherpa addon and the shared
 * libraries it links, moved out of the sherpa-onnx-<platform> package so the
 * host has one directory of binaries to code-sign and nothing to sign
 * anywhere else (see `relocateNative`) — and two entry points: `desktop.js`
 * (what a host spawns: fs workspace, 127.0.0.1:0, app-support dirs, a
 * generated API key on the ready line — every default an env override) and
 * `strut` (shell wrapper over it for people who downloaded the tarball).
 * On darwin targets native/ also holds LadybugDB's addon (@ladybugdb/core,
 * pinned like sherpa), the OpenSSL 3 dylibs it links, copied from the
 * build machine's Homebrew openssl@3 and rewired to @loader_path (see
 * `relocateLadybug`), and the two extensions the graph backend REQUIRES to
 * open — libvector + libfts (`stageLadybugExtensions`: versioned with the
 * Ladybug CORE, not the npm package — 0.21.0 for @ladybugdb/core 0.21.2 —
 * from the build machine's ~/.lbdb cache when it has the target's, else
 * extension.ladybugdb.com); elsewhere, or without a matching openssl@3,
 * Ladybug is left out with a warning. `desktop.json` beside desktop.js
 * records what was staged (`ladybug`, `embeddings`, `stt`), and desktop.js
 * reads its defaults from it: with Ladybug staged the workspace backend is
 * `ladybug` and STRUT_LADYBUG_EXTENSION_DIR is native/
 * (plans/ladybug-backend.md §7.1). `--no-stt` leaves dictation out: no
 * sherpa, no native/ sherpa binaries; /audio answers 501 "stt not available".
 * Node itself is not included; the host provides one: 22.18 or newer (strut
 * needs 22; workspace custom steps are .ts, loaded by Node's own type
 * stripping, on by default from 22.18 — desktop.js refuses anything older).
 * `--tar` also writes <out>/strut-<platform>.tar.gz — the release asset
 * (.github/workflows/strut-desktop.yml).
 *
 * Two size cuts, both on by default:
 *   - the embeddings stack (@huggingface/transformers + onnxruntime-web/-node
 *     + sharp, ~200 MB) is left out — MiniLM only serves graph search,
 *     which needs a Neo4j the desktop build doesn't ship; `--embeddings`
 *     keeps it, and graph/embeddings.ts fails with a clear message without it;
 *   - sourcemaps, typings, and docs are stripped from node_modules (~100 MB).
 *
 * --smoke boots the staged copy via desktop.js from a temp directory (so
 * nothing can leak in from this checkout) with only STRUT_WORKSPACE and
 * STRUT_CACHE_DIR set, parses the ready line for port + key, and checks
 * /health (with Ladybug staged: `workspace.backend` is `ladybug` and a
 * workflow published over the API reads back — the graph store serves),
 * /audio/models (`available: true` = the sherpa addon loaded) and
 * that a custom step importing "strut" from that workspace registered; that
 * closing stdin under STRUT_EXIT_ON_STDIN_EOF=1 ends the process; and, with
 * Ladybug staged, opens and queries a temp database from the copy with
 * DYLD_* cleared, loading both extensions from native/, failing if the
 * images that loads (libssl/libcrypto, the extensions) come from anywhere
 * but native/. Each stub must answer an import with its "not in this
 * build" error.
 *
 * Not a single-file build on purpose: the step loader scans directories and
 * the sherpa addon must be a real file beside the binary either way (§2.4).
 *
 * On darwin targets sharp's addon + libvips (the browser screenshot's downscale)
 * move into native/ too (`relocateSharp`).
 *
 * The app build (plans/apps.md §2) needs two more things, both staged: the
 * kit's vendor layer at kit/vendor + its base stylesheet (built by `npm run
 * build`), and esbuild's binary, moved out of @esbuild/<platform> into
 * native/ (`relocateEsbuild`; desktop.js sets ESBUILD_BINARY_PATH to it).
 */
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true) : dflt;
};
const hostPlatform = `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
const platform = String(flag("platform", hostPlatform));
const out = resolve(ROOT, String(flag("out", "dist-desktop")));
const smoke = flag("smoke", false) === true;
const tar = flag("tar", false) === true;
const skipBuild = flag("skip-build", false) === true;
const embeddings = flag("embeddings", false) === true;
const stt = !args.includes("--no-stt");
const stage = join(out, "strut");
const native = join(stage, "native");

const SHERPA_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win-x64", "win-ia32"];
if (!SHERPA_PLATFORMS.includes(platform)) {
  console.error(`unknown platform ${platform}; one of ${SHERPA_PLATFORMS.join(", ")}`);
  process.exit(2);
}
// `.lbug_extension` is a Mach-O dylib under another name (Ladybug's vector + fts).
const NATIVE_EXT = /\.(node|dylib|so|dll|lbug_extension)$/;
// esbuild's binary, an executable with no extension (`esbuild.exe` on Windows).
const ESBUILD_BIN = /^esbuild(\.exe)?$/;
const isNative = (f) => NATIVE_EXT.test(f) || ESBUILD_BIN.test(f);
// onnxruntime-node lays its binaries out as bin/napi-v6/<os>/<arch>.
const [ortOs, ortArch] = platform.replace(/^win-/, "win32-").split("-");

const installedVersion = async (dir) => {
  try {
    return JSON.parse(await readFile(join(dir, "package.json"), "utf-8")).version;
  } catch {
    return null;
  }
};
// The version installed at the root (the lockfile's) is the one shipped, and
// a cross-stage fetches the target's addon at exactly it. Never "newest":
// upstream publishes the six platform addons from separate jobs, sometimes
// hours after the wrapper (1.13.8: wrapper 13:58 UTC, darwin-arm64 18:07
// UTC), so newest can be a version whose addon doesn't exist yet.
const sherpaVersion = stt ? await installedVersion(join(ROOT, "node_modules", "sherpa-onnx-node")) : null;
if (stt && !sherpaVersion) {
  console.error("sherpa-onnx-node isn't installed at the repo root (node_modules/sherpa-onnx-node); run `yarn install` first");
  process.exit(2);
}

const log = (m) => console.log(`[package-desktop] ${m}`);
const warn = (m) => console.warn(`[package-desktop] WARNING: ${m}`);
// Captured output of a build tool (otool, lipo, install_name_tool, codesign).
const tool = (cmd, cmdArgs) => {
  const r = spawnSync(cmd, cmdArgs, { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(" ")} failed (${r.status}): ${r.stderr || r.error?.message || ""}`);
  return r.stdout;
};

// LadybugDB, pinned to the root-installed version like sherpa. Its macOS addon
// links @rpath/libssl.3 + libcrypto.3 with only Homebrew/MacPorts rpaths, so
// a package carries OpenSSL beside it (relocateLadybug). The lib dir is the
// build machine's Homebrew openssl@3 (`brew --prefix`, else the two Homebrew
// prefixes the addon's rpaths name; not MacPorts' /opt/local/lib, whose
// libcrypto links its own libz and which ships no license file) and must
// have the target's arch. No darwin target, no macOS build host, or no such
// OpenSSL: Ladybug is left out of the package, loudly.
const ladybugVersion = await installedVersion(join(ROOT, "node_modules", "@ladybugdb", "core"));
const ladybugPlatformPkg = `@ladybugdb/core-${platform}`;
const OPENSSL_LIBS = ["libcrypto.3.dylib", "libssl.3.dylib"];
const findOpenssl = () => {
  const arch = ortArch === "x64" ? "x86_64" : ortArch;
  const brew = spawnSync("brew", ["--prefix", "openssl@3"], { encoding: "utf-8" });
  const dirs = [
    ...(brew.status === 0 ? [join(brew.stdout.trim(), "lib")] : []),
    "/opt/homebrew/opt/openssl@3/lib",
    "/usr/local/opt/openssl@3/lib",
  ];
  for (const dir of dirs) {
    const archs = OPENSSL_LIBS.map((l) => spawnSync("lipo", ["-archs", join(dir, l)], { encoding: "utf-8" }));
    if (archs.every((r) => r.status === 0 && r.stdout.trim().split(/\s+/).includes(arch))) return dir;
  }
  return null;
};
let opensslDir = null;
let ladybugSkip = null;
if (!ladybugVersion) ladybugSkip = "@ladybugdb/core isn't installed at the repo root";
else if (!platform.startsWith("darwin-")) ladybugSkip = `only darwin targets carry it for now (its OpenSSL dependency is handled for macOS only), not ${platform}`;
else if (process.platform !== "darwin") ladybugSkip = "a darwin target needs a macOS build host (otool, install_name_tool, codesign)";
else if (!(opensslDir = findOpenssl())) ladybugSkip = `no openssl@3 with ${ortArch} libssl/libcrypto on this machine (\`brew install openssl@3\`; a cross-stage needs that arch's build)`;
const ladybug = !ladybugSkip;

const run = (cmd, cmdArgs, cwd = ROOT, env = process.env) => {
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit", env });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(" ")} failed (${r.status})`);
};
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
  // The manifest says what the stage holds (installDeps copies the tree):
  // exact versions for the native packages, nothing that was left out.
  if (!embeddings) delete pkg.dependencies["@huggingface/transformers"];
  pkg.optionalDependencies = { ...pkg.optionalDependencies };
  if (stt) Object.assign(pkg.optionalDependencies, { "sherpa-onnx-node": sherpaVersion, [`sherpa-onnx-${platform}`]: sherpaVersion });
  else delete pkg.optionalDependencies["sherpa-onnx-node"];
  if (ladybug) Object.assign(pkg.optionalDependencies, { "@ladybugdb/core": ladybugVersion, [ladybugPlatformPkg]: ladybugVersion });
  else {
    delete pkg.optionalDependencies["@ladybugdb/core"];
    warn(`leaving LadybugDB out of the package: ${ladybugSkip}`);
  }
  await writeFile(join(stage, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  await cp(join(ROOT, "build"), join(stage, "build"), { recursive: true });
  await cp(join(ROOT, "web", "dist"), join(stage, "web", "dist"), { recursive: true });
  // The kit as the app build reads it (src/apps/kit.ts: <strut>/kit): the
  // vendor layer `npm run build` made, and the base stylesheet.
  if (!(await stat(join(ROOT, "kit", "vendor", "import-map.json")).catch(() => null))) throw new Error("kit/vendor is not built; run `npm run build` (or `npm run build:kit`)");
  await cp(join(ROOT, "kit", "vendor"), join(stage, "kit", "vendor"), { recursive: true });
  await mkdir(join(stage, "kit", "src", "styles"), { recursive: true });
  await copyFile(join(ROOT, "kit", "src", "styles", "base.css"), join(stage, "kit", "src", "styles", "base.css"));
  for (const f of ["desktop.js", "strut"]) {
    await cp(join(ROOT, "scripts", f), join(stage, f));
    await chmod(join(stage, f), 0o755);
  }
  await writeManifest();
  log(`staged build/ + web/dist/ + kit/vendor/ + desktop.js + strut + desktop.json → ${stage}`);
}

// What this stage holds, for desktop.js's defaults (it never sniffs
// node_modules): the workspace backend flips to ladybug only when the addon
// AND both extensions are in native/; the graph's embedder is on only when
// the embeddings stack came along. Rewritten as the relocations add to it.
const manifest = { platform, stt, ladybug, ladybugVersion: ladybug ? ladybugVersion : null, ladybugExtensions: null, embeddings };
async function writeManifest() {
  await writeFile(join(stage, "desktop.json"), JSON.stringify(manifest, null, 2) + "\n");
}

// The production tree is copied out of the repo root's node_modules — what
// `yarn install` made from yarn.lock, the tree the tests ran against — never
// resolved afresh: an `npm install` in the stage has no lockfile, so every
// range, transitive ones included, would float to npm's newest that day.
// Starting from strut's dependencies + peerDependencies (+ the optional ones
// this build keeps), each package is found the way Node would find it from
// its dependent's directory in the root tree, and copied to the same relative
// path, so the stage resolves exactly as the root does. Optional and peer
// dependencies the root doesn't have stay out (react: system-canvas-react's
// peer, only the web bundle uses it); a missing regular dependency fails.
// Other platforms' addon packages never come along; the target's, when the
// root (another platform) lacks it, is fetched at its exact pinned version.
// Before any of that, lockMatchesInstall() requires the root's
// node_modules/.yarn-integrity to list exactly yarn.lock's entries (pattern →
// resolved): the installed tree is the one yarn made from this lockfile.
// verifyLocked() then refuses any staged package whose version differs from
// the installed tree's at the same path.
// sharp (the browser screenshot's downscale) ships its addon and libvips as two
// @img packages per platform; only darwin targets relocate them (relocateSharp).
const sharpPkgs = platform.startsWith("darwin-") ? [`@img/sharp-${platform}`, `@img/sharp-libvips-${platform}`] : [];
// esbuild (the app build) ships its binary as one package per platform; the
// target's moves into native/ (relocateEsbuild).
const esbuildPkg = `@esbuild/${platform.replace(/^win-/, "win32-")}`;
const OTHER_PLATFORM_PKG = (name) =>
  (/^sherpa-onnx-(darwin|linux|win)-/.test(name) && name !== `sherpa-onnx-${platform}`) ||
  (/^@ladybugdb\/core-/.test(name) && name !== ladybugPlatformPkg) ||
  (/^@esbuild\//.test(name) && name !== esbuildPkg) ||
  (sharpPkgs.length > 0 && /^@img\/sharp-(libvips-)?(darwin|linux|linuxmusl|win32|freebsd|webcontainers|wasm32)/.test(name) && !sharpPkgs.includes(name));

async function resolveFrom(dir, name) {
  for (let d = dir; d.startsWith(ROOT); d = dirname(d)) {
    const cand = join(d, "node_modules", name);
    if (await installedVersion(cand)) return cand;
    if (d === ROOT) break;
  }
  return null;
}

async function lockedClosure(roots) {
  const dirs = new Set();
  const queue = roots.map((name) => [ROOT, name, true]);
  while (queue.length) {
    const [from, name, required] = queue.shift();
    if (OTHER_PLATFORM_PKG(name)) continue;
    const dir = await resolveFrom(from, name);
    if (!dir) {
      if (required) throw new Error(`${name}, needed by ${relative(ROOT, from) || "strut"}, isn't in the repo root's node_modules; run \`yarn install\``);
      continue;
    }
    if (dirs.has(dir)) continue;
    dirs.add(dir);
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf-8"));
    const optional = { ...pkg.optionalDependencies, ...pkg.peerDependencies };
    for (const n of Object.keys(pkg.dependencies ?? {})) if (!(n in optional)) queue.push([dir, n, true]);
    for (const n of Object.keys(optional)) queue.push([dir, n, false]);
  }
  return [...dirs];
}

// The target's addon package at an exact version, for a cross-stage. These
// packages have no dependencies; fetched into a scratch prefix, then moved in.
// The version is the wrapper's from the root tree (sherpa 1.13.7 today, not
// npm's newest), so wrapper and addon always match.
async function fetchExact(name, version, hint = "") {
  log(`${name} isn't in the root tree (another platform); fetching ${name}@${version}`);
  const tmp = await mkdtemp(join(tmpdir(), "strut-pkg-"));
  try {
    try {
      run("npm", ["install", "--prefix", tmp, "--no-save", "--no-audit", "--no-fund", "--no-package-lock", "--ignore-scripts", "--force", `${name}@${version}`]);
    } catch (e) {
      throw new Error(`${e.message}${hint}`);
    }
    const got = await installedVersion(join(tmp, "node_modules", name));
    if (got !== version) throw new Error(`fetched ${name} is ${got ?? "missing"}, expected ${version}`);
    await mkdir(dirname(join(stage, "node_modules", name)), { recursive: true });
    await cp(join(tmp, "node_modules", name), join(stage, "node_modules", name), { recursive: true });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return `node_modules/${name}`;
}

// A left-out optional dependency gets a stub that throws on import, so
// resolution stops inside the stage instead of walking up past the app
// bundle into a node_modules someone else can write (/Applications/node_modules).
// `code` matches a missing module, so callers that tell "not installed" apart
// (stt's loader, graph/embeddings.ts) behave as if it were absent.
async function writeStub(name, why) {
  const dir = join(stage, "node_modules", name);
  if (await stat(dir).catch(() => null)) throw new Error(`a stub for ${name} would overwrite the copied package at ${dir}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0-not-in-this-build", private: true, main: "index.js" }, null, 2) + "\n");
  await writeFile(
    join(dir, "index.js"),
    `// Written by strut's scripts/package-desktop.mjs: ${name} is not in this build (${why}).\n` +
      `const e = new Error(${JSON.stringify(`${name} is not in this build of strut (${why})`)});\ne.code = "ERR_MODULE_NOT_FOUND";\nthrow e;\n`,
  );
  return `node_modules/${name}`;
}

// Every package in the stage must carry the version the root has at the same
// path; `added` are the deliberate exceptions (fetched addons, stubs).
async function verifyLocked(added) {
  const bad = [];
  let n = 0;
  const walk = async (nmDir) => {
    let ents;
    try {
      ents = await readdir(nmDir);
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.startsWith(".")) continue;
      const names = e.startsWith("@") ? (await readdir(join(nmDir, e))).map((s) => join(e, s)) : [e];
      for (const name of names) {
        const dir = join(nmDir, name);
        const rel = relative(stage, dir);
        const v = await installedVersion(dir);
        if (v && !added.includes(rel)) {
          n++;
          const want = await installedVersion(join(ROOT, rel));
          if (v !== want) bad.push(`${rel}@${v} (root: ${want ?? "absent"})`);
        }
        await walk(join(dir, "node_modules"));
      }
    }
  };
  await walk(join(stage, "node_modules"));
  if (bad.length) throw new Error(`staged packages that differ from the locked root tree:\n  ${bad.join("\n  ")}`);
  log(`verified ${n} staged packages against the installed tree (same version at the same path); ${added.length} deliberate additions: ${added.join(", ") || "none"}`);
}

// yarn v1 lockfile: `"a@^1", a@1.2.3:` headers, an indented `resolved "…"`.
async function lockMatchesInstall() {
  const lock = new Map();
  let patterns = null;
  for (const line of (await readFile(join(ROOT, "yarn.lock"), "utf-8")).split("\n")) {
    if (/^\S.*:$/.test(line) && !line.startsWith("#")) patterns = line.slice(0, -1).split(/,\s*/).map((p) => p.replace(/^"|"$/g, ""));
    const m = /^\s+resolved "(.+)"$/.exec(line);
    if (m && patterns) for (const p of patterns) lock.set(p, m[1]);
  }
  let installed;
  try {
    installed = JSON.parse(await readFile(join(ROOT, "node_modules", ".yarn-integrity"), "utf-8")).lockfileEntries;
  } catch {
    installed = null;
  }
  const diff = [];
  if (!installed) diff.push("no node_modules/.yarn-integrity");
  else {
    for (const [p, r] of lock) if (installed[p] !== r) diff.push(`${p}: lock ${r}, installed ${installed[p] ?? "absent"}`);
    for (const p of Object.keys(installed)) if (!lock.has(p)) diff.push(`${p}: installed, not in yarn.lock`);
  }
  if (diff.length) throw new Error(`node_modules does not match yarn.lock; run yarn install --frozen-lockfile\n  ${diff.slice(0, 10).join("\n  ")}`);
  log(`node_modules matches yarn.lock (${lock.size} entries, .yarn-integrity)`);
}

const stubs = [];
async function installDeps() {
  await lockMatchesInstall();
  if (embeddings && platform !== hostPlatform) throw new Error("--embeddings can't be cross-staged: its sharp/onnxruntime addons come from the root tree, which is this machine's platform");
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf-8"));
  const roots = [
    ...Object.keys(pkg.dependencies ?? {}).filter((n) => embeddings || n !== "@huggingface/transformers"),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...(stt ? ["sherpa-onnx-node", `sherpa-onnx-${platform}`] : []),
    ...(ladybug ? ["@ladybugdb/core", ladybugPlatformPkg] : []),
  ].filter((n) => !OTHER_PLATFORM_PKG(n) || n === `sherpa-onnx-${platform}` || n === ladybugPlatformPkg);
  const targetAddons = [stt && `sherpa-onnx-${platform}`, ladybug && ladybugPlatformPkg].filter(Boolean);
  const fromRoot = [];
  for (const n of roots) if (!targetAddons.includes(n) || (await installedVersion(join(ROOT, "node_modules", n)))) fromRoot.push(n);
  const dirs = await lockedClosure(fromRoot);
  log(`copying ${dirs.length} production packages from the installed tree; ${embeddings ? "with" : "without"} the embeddings stack, ${stt ? `sherpa ${sherpaVersion}` : "no sherpa (--no-stt)"}, ${ladybug ? `Ladybug ${ladybugVersion}` : "no Ladybug"}`);
  for (const dir of dirs) {
    const skip = join(dir, "node_modules");
    const filter = async (src) => {
      if (src === skip || src.startsWith(skip + "/")) return false;
      // A link would point back into the checkout (or anywhere): never ship one.
      if ((await lstat(src)).isSymbolicLink()) throw new Error(`symlink inside a package, refusing to stage it: ${src}`);
      return true;
    };
    await cp(dir, join(stage, relative(ROOT, dir)), { recursive: true, filter });
  }
  const nm = join(stage, "node_modules");
  const added = [];
  for (const name of targetAddons) {
    const version = name === ladybugPlatformPkg ? ladybugVersion : sherpaVersion;
    const got = await installedVersion(join(nm, name));
    if (!got) {
      added.push(
        await fetchExact(
          name,
          version,
          name === ladybugPlatformPkg
            ? ""
            : `\n${name}@${version} may not be on npm: upstream publishes each platform addon from its own job, sometimes hours after sherpa-onnx-node itself. ` +
                `Check \`npm view ${name} versions\` and keep the root lockfile on a version whose addon has landed.`,
        ),
      );
    } else if (got !== version) throw new Error(`${name} is ${got} in the root tree, expected ${version}`);
  }
  // sharp's wrapper pins both @img packages for each platform, esbuild its
  // @esbuild/<platform>; a cross-stage has the host's in the root tree, so the
  // target's come from npm at those versions.
  for (const [wrapper, names, relocate] of [["sharp", sharpPkgs, "relocateSharp"], ["esbuild", [esbuildPkg], "relocateEsbuild"]]) {
    const pins = JSON.parse(await readFile(join(nm, wrapper, "package.json"), "utf-8")).optionalDependencies ?? {};
    for (const name of names) {
      if (!pins[name]) throw new Error(`${wrapper} pins no ${name}; its platform packages changed — update ${relocate}`);
      const got = await installedVersion(join(nm, name));
      if (!got) added.push(await fetchExact(name, pins[name]));
      else if (got !== pins[name]) throw new Error(`${name} is ${got} in the root tree, ${wrapper} pins ${pins[name]}`);
    }
  }
  if (!stt) stubs.push("sherpa-onnx-node");
  if (!ladybug) stubs.push("@ladybugdb/core");
  if (!embeddings) stubs.push("@huggingface/transformers");
  // The app build's fallback when esbuild's binary cannot run (src/apps/build.ts
  // loadEsbuild); this package carries the binary, so the fallback stops here.
  stubs.push("esbuild-wasm");
  const why = {
    "sherpa-onnx-node": "built with --no-stt",
    "@ladybugdb/core": ladybugSkip,
    "@huggingface/transformers": "the embeddings stack is left out; package:desktop --embeddings keeps it",
    "esbuild-wasm": "the package carries esbuild's own binary in native/",
  };
  for (const name of stubs) added.push(await writeStub(name, why[name]));

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
  // Never emit a package for the wrong platform: exactly the target's sherpa
  // package, and only it, must be present (none with --no-stt).
  const present = (await readdir(nm)).filter((d) => /^sherpa-onnx-(darwin|linux|win)-/.test(d));
  const want = stt ? [`sherpa-onnx-${platform}`] : [];
  if (present.join() !== want.join()) throw new Error(`expected ${want.join(", ") || "no sherpa platform package"} in the stage, found: ${present.join(", ") || "none"}`);
  if (ladybug) {
    const lb = (await readdir(join(nm, "@ladybugdb"))).filter((d) => d.startsWith("core-"));
    if (lb.join() !== ladybugPlatformPkg.slice("@ladybugdb/".length)) throw new Error(`expected only ${ladybugPlatformPkg} in the stage, found: ${lb.join(", ") || "none"}`);
  }
  await verifyLocked(added);
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

// Ladybug's addon goes into native/ the same way; @ladybugdb/core's
// lbug_native.js is the one file that names it (`join(__dirname,
// "lbugjs.node")`) and is rewritten to ../../../native. The addon is taken
// from the platform package (core/'s copy, if the root's install script made
// one, is deleted), and that package (a copy of core's JS plus the addon)
// goes, pin included. On macOS the addon links
// @rpath/libssl.3 + @rpath/libcrypto.3 with Homebrew/MacPorts rpaths only:
// fine on a developer's Mac, missing on a user's, and refused under the host's
// library validation even where present. So both dylibs are copied in from
// `opensslDir`, renamed @rpath/…, libssl pointed at @rpath/libcrypto, every
// absolute rpath replaced by @loader_path, and each changed file ad-hoc
// re-signed (install_name_tool voids signatures; the host re-signs with its
// identity). checkMachO then refuses any reference left to a build-machine path.
const LBUG_LOADER = 'const modulePath = join(__dirname, "lbugjs.node");';
const BUILD_MACHINE_PATH = /\/opt\/homebrew|\/usr\/local|\/opt\/local|\/Cellar\//;
const rpaths = (f) => [...tool("otool", ["-l", f]).matchAll(/cmd LC_RPATH\n\s+cmdsize \d+\n\s+path (.+?) \(offset \d+\)/g)].map((m) => m[1]);
const linked = (f) => tool("otool", ["-L", f]).split("\n").slice(1).map((l) => l.trim().replace(/ \(compatibility.*$/, "")).filter(Boolean);
const minos = (f) => /minos (\S+)/.exec(tool("otool", ["-l", f]))?.[1] ?? "?";

async function relocateLadybug() {
  const nm = join(stage, "node_modules");
  const core = join(nm, "@ladybugdb", "core");
  const pkgDir = join(nm, ladybugPlatformPkg);
  const loader = join(core, "lbug_native.js");
  const src = await readFile(loader, "utf-8");
  if (src.split(LBUG_LOADER).length !== 2) {
    throw new Error(`@ladybugdb/core@${ladybugVersion}: lbug_native.js no longer has exactly one \`${LBUG_LOADER}\`; its addon lookup changed — update relocateLadybug`);
  }
  await writeFile(
    loader,
    src.replace(
      LBUG_LOADER,
      `// strut's package-desktop.mjs (relocateLadybug): the addon and the OpenSSL it links live in <stage>/native.\nconst modulePath = join(__dirname, "..", "..", "..", "native", "lbugjs.node");`,
    ),
  );
  await rename(join(pkgDir, "lbugjs.node"), join(native, "lbugjs.node"));
  await rm(join(core, "lbugjs.node"), { force: true }); // the root's install script copies one here
  await rm(pkgDir, { recursive: true, force: true });
  const pkgPath = join(stage, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
  delete pkg.optionalDependencies[ladybugPlatformPkg];
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  const addon = join(native, "lbugjs.node");
  const [crypto, ssl] = OPENSSL_LIBS.map((l) => join(native, l));
  for (const l of OPENSSL_LIBS) {
    await copyFile(join(opensslDir, l), join(native, l)); // follows brew's opt/ symlink
    await chmod(join(native, l), 0o644); // brew's are read-only; install_name_tool writes in place
  }
  const sslCrypto = linked(ssl).find((d) => /\/libcrypto\.3\.dylib$/.test(d) && d !== "@rpath/libcrypto.3.dylib");
  for (const [f, extra] of [
    [crypto, ["-id", "@rpath/libcrypto.3.dylib"]],
    [ssl, ["-id", "@rpath/libssl.3.dylib", ...(sslCrypto ? ["-change", sslCrypto, "@rpath/libcrypto.3.dylib"] : [])]],
    [addon, []],
  ]) {
    const drop = rpaths(f).filter((r) => r.startsWith("/"));
    // @loader_path only where something is looked up through @rpath (not libcrypto).
    const needs = f !== crypto && !rpaths(f).includes("@loader_path");
    tool("install_name_tool", [...extra, ...drop.flatMap((r) => ["-delete_rpath", r]), ...(needs ? ["-add_rpath", "@loader_path"] : []), f]);
    tool("codesign", ["-f", "-s", "-", f]);
  }
  const license = ["LICENSE.txt", "LICENSE"].map((n) => join(opensslDir, "..", n));
  const found = [];
  for (const l of license) if (await stat(l).catch(() => null)) found.push(l);
  if (!found.length) throw new Error(`no OpenSSL license beside ${opensslDir} (looked for ${license.join(", ")}); the dylibs can't ship without it`);
  // Beside native/, not in it: native/ holds only the binaries a host signs.
  await mkdir(join(stage, "licenses"), { recursive: true });
  await copyFile(found[0], join(stage, "licenses", "OpenSSL.txt"));
  const from = await realpath(opensslDir);
  log(
    `moved lbugjs.node → native/ and bundled ${OPENSSL_LIBS.join(" + ")} from ${from} (rpath @loader_path, ad-hoc signed, license in licenses/OpenSSL.txt); ` +
      `@ladybugdb/core loads ../../../native/lbugjs.node. Minimum macOS: addon ${minos(addon)}, OpenSSL ${minos(ssl)}`,
  );
}

// The two extensions the graph backend requires (plans/ladybug-backend.md
// ruling 4), beside the addon in native/ so one directory holds every binary
// the host signs. They are versioned with the Ladybug CORE, not the npm
// package (0.21.0 for @ladybugdb/core 0.21.2), and laid out per platform —
// so the version and the build machine's platform name are read from
// Ladybug itself: an in-memory database INSTALLs + LOADs `vector` and
// SHOW_LOADED_EXTENSIONS() reports the path it put it at
// (~/.lbdb/extension/<ver>/<plat>/vector/libvector.lbug_extension). The
// target's files come from that cache when it is the target's platform, else
// from extension.ladybugdb.com at the same version. Each must be a Mach-O of
// the target's arch; checkMachO then verifies them with the rest of native/.
const LADYBUG_PLATFORM_DIR = { "darwin-arm64": "osx_arm64", "darwin-x64": "osx_amd64" };
const LADYBUG_EXTENSIONS = ["vector", "fts"];
async function stageLadybugExtensions() {
  const probe = `
const lbug = (await import("@ladybugdb/core")).default;
const db = new lbug.Database(":memory:");
const conn = new lbug.Connection(db);
await conn.query("INSTALL vector");
await conn.query("LOAD EXTENSION vector");
const rows = await (await conn.query("CALL SHOW_LOADED_EXTENSIONS() RETURN *")).getAll();
await conn.close(); await db.close();
console.log(JSON.stringify(rows));
`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { cwd: ROOT, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`Ladybug could not INSTALL + LOAD its vector extension on this machine (network to extension.ladybugdb.com needed once):\n${r.stdout}${r.stderr}`);
  const rows = JSON.parse(r.stdout.trim().split("\n").pop());
  const loaded = rows.find((row) => String(row["extension name"]).toUpperCase() === "VECTOR")?.["extension path"];
  const m = /^(.*\/extension\/([^/]+)\/([^/]+))\/vector\/libvector\.lbug_extension$/.exec(String(loaded ?? ""));
  if (!m) throw new Error(`cannot read the extension version and platform from Ladybug's loaded path: ${loaded}`);
  const [, cacheRoot, version, hostDir] = m;
  const targetDir = LADYBUG_PLATFORM_DIR[platform];
  if (!targetDir) throw new Error(`no Ladybug extension platform known for ${platform}`);
  const arch = ortArch === "x64" ? "x86_64" : ortArch;
  const from = [];
  for (const name of LADYBUG_EXTENSIONS) {
    const file = `lib${name}.lbug_extension`;
    const dest = join(native, file);
    const cached = join(cacheRoot, name, file);
    if (targetDir === hostDir && (await stat(cached).catch(() => null))) {
      await copyFile(cached, dest);
      from.push(`${file} ← ${cached}`);
    } else {
      const url = `https://extension.ladybugdb.com/v${version}/${targetDir}/${name}/${file}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`downloading ${url}: ${res.status} ${res.statusText}`);
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
      from.push(`${file} ← ${url}`);
    }
    await chmod(dest, 0o755);
    const archs = spawnSync("lipo", ["-archs", dest], { encoding: "utf-8" });
    if (archs.status !== 0 || !archs.stdout.trim().split(/\s+/).includes(arch)) {
      throw new Error(`${dest} is not a ${arch} Mach-O (lipo: ${archs.stdout.trim() || archs.stderr.trim()})`);
    }
  }
  manifest.ladybugExtensions = version;
  await writeManifest();
  log(`staged Ladybug's ${LADYBUG_EXTENSIONS.join(" + ")} extensions (${version}, ${targetDir}) → native/:\n    ${from.join("\n    ")}`);
}

// sharp's addon goes into native/ with libvips, the same way. The platform
// package's index.cjs (the "./sharp.node" export sharp requires) is rewritten to
// ../../../native/sharp.node; the addon links @rpath/libvips-cpp.<v>.dylib and
// carries rpaths into node_modules/@img only, so its rpaths are replaced by
// @loader_path and both files are ad-hoc re-signed (the host re-signs with its
// identity). Both packages stay as shells (license, package.json) without lib/.
async function relocateSharp() {
  if (!sharpPkgs.length) return;
  const [addonPkg, vipsPkg] = sharpPkgs.map((n) => join(stage, "node_modules", n));
  const addonLib = join(addonPkg, "lib");
  const vipsLib = join(vipsPkg, "lib");
  const addons = (await readdir(addonLib)).filter((f) => f.endsWith(".node"));
  const dylibs = (await readdir(vipsLib)).filter((f) => f.endsWith(".dylib"));
  if (addons.length !== 1 || dylibs.length !== 1) {
    throw new Error(`${sharpPkgs.join(" + ")}: expected one .node and one .dylib, found ${addons.join(", ") || "no .node"} and ${dylibs.join(", ") || "no .dylib"}; their layout changed — update relocateSharp`);
  }
  const index = join(addonPkg, "index.cjs");
  if (!/require\('\.\/lib\/sharp-[^']+\.node'\)/.test(await readFile(index, "utf-8"))) {
    throw new Error(`${sharpPkgs[0]}/index.cjs no longer requires ./lib/sharp-*.node; its addon lookup changed — update relocateSharp`);
  }
  await writeFile(index, "// strut's package-desktop.mjs (relocateSharp): the addon and libvips live in <stage>/native.\nmodule.exports = require('../../../native/sharp.node');\n");
  await rename(join(addonLib, addons[0]), join(native, "sharp.node"));
  await rename(join(vipsLib, dylibs[0]), join(native, dylibs[0]));
  await rm(addonLib, { recursive: true, force: true });
  await rm(vipsLib, { recursive: true, force: true });
  const addon = join(native, "sharp.node");
  const vips = join(native, dylibs[0]);
  if (!linked(addon).includes(`@rpath/${dylibs[0]}`)) throw new Error(`sharp.node doesn't link @rpath/${dylibs[0]}: ${linked(addon).join(", ")}`);
  for (const f of [addon, vips]) {
    await chmod(f, 0o644);
    const drop = rpaths(f).filter((r) => r !== "@loader_path");
    const needs = f === addon && !rpaths(f).includes("@loader_path");
    const edits = [...drop.flatMap((r) => ["-delete_rpath", r]), ...(needs ? ["-add_rpath", "@loader_path"] : [])];
    if (edits.length) tool("install_name_tool", [...edits, f]);
    tool("codesign", ["-f", "-s", "-", f]);
  }
  log(`moved sharp.node + ${dylibs[0]} → native/ (rpath @loader_path, ad-hoc signed); ${sharpPkgs[0]} loads ../../../native/sharp.node. Minimum macOS: addon ${minos(addon)}, libvips ${minos(vips)}`);
}

// esbuild's binary goes into native/ too. esbuild runs it from
// ESBUILD_BINARY_PATH when that is set — desktop.js sets it to native/esbuild
// (and src/env.ts keeps it through the env scrub) — so the emptied
// @esbuild/<platform> package goes. The binary must be byte for byte the one
// esbuild records for it (`esbuild.binaryHashes`). esbuild's own bin/ — the
// CLI, which strut never runs, and where its install script may have swapped
// a copy of the binary in — goes too.
async function relocateEsbuild() {
  const nm = join(stage, "node_modules");
  const sub = platform.startsWith("win-") ? "esbuild.exe" : "bin/esbuild";
  const bin = join(native, basename(sub));
  await rename(join(nm, esbuildPkg, sub), bin);
  await rm(join(nm, esbuildPkg), { recursive: true, force: true });
  await rm(join(nm, "esbuild", "bin"), { recursive: true, force: true });
  const esbuildJson = JSON.parse(await readFile(join(nm, "esbuild", "package.json"), "utf-8"));
  const want = esbuildJson["esbuild.binaryHashes"]?.[`${esbuildPkg}/${sub}`];
  const got = createHash("sha256").update(await readFile(bin)).digest("hex");
  if (want !== got) throw new Error(`native/${basename(sub)} has sha256 ${got}; esbuild@${esbuildJson.version} records ${want ?? "no hash"} for ${esbuildPkg}/${sub}`);
  log(`moved ${esbuildPkg}/${sub} (esbuild ${esbuildJson.version}, sha256 matches esbuild's record) → native/${basename(sub)}; desktop.js points ESBUILD_BINARY_PATH at it`);
}

// Every Mach-O in native/: no load command may name a build-machine path,
// every @rpath dependency must be in native/, and every signature present must verify.
function checkMachO(files) {
  const bad = [];
  const unsigned = [];
  for (const f of files) {
    const p = join(native, f);
    for (const r of rpaths(p)) if (BUILD_MACHINE_PATH.test(r)) bad.push(`${f}: LC_RPATH ${r}`);
    for (const d of linked(p)) {
      if (BUILD_MACHINE_PATH.test(d)) bad.push(`${f}: links ${d}`);
      const m = /^@(?:rpath|loader_path)\/(.+)$/.exec(d);
      if (m && m[1] !== f && !files.includes(m[1])) bad.push(`${f}: links ${d}, not in native/`);
    }
    const v = spawnSync("codesign", ["-v", p], { encoding: "utf-8" });
    // Upstream's x86_64 binaries ship unsigned (Intel runs them so; the host
    // signs native/ anyway). arm64 won't load unsigned code: there, and for a
    // broken signature anywhere, it's a failure.
    if (v.status !== 0 && platform === "darwin-x64" && /not signed at all/.test(v.stderr)) unsigned.push(f);
    else if (v.status !== 0) bad.push(`${f}: signature does not verify (${v.stderr.trim()})`);
  }
  if (bad.length) throw new Error(`native/ binaries reference the build machine or are broken:\n  ${bad.join("\n  ")}`);
  log(
    `checked ${files.length} Mach-O files in native/: no build-machine paths, every @rpath dependency present, signatures verify` +
      (unsigned.length ? ` (unsigned as shipped: ${unsigned.join(", ")})` : ""),
  );
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
  // Everything the host must code-sign, in one place: the addons plus the
  // shared libraries they link (relocateNative, relocateLadybug, relocateSharp) and
  // esbuild's executable (relocateEsbuild), all of which must be signed
  // and notarized inside the app bundle, not just the .node. Nothing else in
  // the package is a binary — enforced here, because the host's signing step
  // is "sign native/". --embeddings is the one exception: onnxruntime-node
  // keeps its addons in node_modules, where its loader looks.
  const inNative = (await readdir(native)).filter(isNative);
  const stray = [];
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (isNative(e.name)) stray.push(p.slice(nm.length + 1));
    }
  };
  await walk(nm);
  log(`native binaries the host must code-sign (${inNative.length}, all in native/):`);
  for (const f of inNative) console.log(`    native/${f}`);
  if (platform.startsWith("darwin-") && process.platform === "darwin") checkMachO(inNative);
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
  // A host's stdin pipe, held open until the end, where closing it must stop the process.
  env.STRUT_EXIT_ON_STDIN_EOF = "1";
  const child = spawn(process.execPath, [join(app, "desktop.js")], { cwd: tmp, env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {}); // EPIPE if it dies first; the exit check reports that
  const exited = new Promise((r) => child.on("exit", (code, signal) => r({ code, signal })));
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
    const health = await (await fetch(`${base}/health`, { headers })).json();
    if (!health.ok) failures.push("health not ok");
    if (health.dataDir !== workspace) failures.push(`dataDir ${health.dataDir} != ${workspace}`);
    // With Ladybug staged the launcher boots on the file (plans/ladybug-backend.md §7.1); the graph store must serve.
    const wantBackend = ladybug ? "ladybug" : "fs";
    if (health.workspace?.backend !== wantBackend) failures.push(`health.workspace.backend ${JSON.stringify(health.workspace)}, expected ${wantBackend}`);
    if (ladybug) {
      if (health.workspace?.path !== join(workspace, "graph", "graph.lbug")) failures.push(`health.workspace.path ${health.workspace?.path}, expected ${join(workspace, "graph", "graph.lbug")}`);
      const pub = await fetch(`${base}/workflows`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ name: "smoke-wf", steps: [{ id: "a", type: "log", config: { message: "hi" } }] }),
      });
      if (pub.status !== 201) failures.push(`publishing a workflow into the Ladybug workspace: ${pub.status} ${await pub.text()}`);
      const wfs = await (await fetch(`${base}/workflows`, { headers })).json();
      if (!wfs.some?.((w) => w.name === "smoke-wf" && w.activeVersion === "v1")) failures.push(`the published workflow did not read back from the Ladybug workspace: ${JSON.stringify(wfs).slice(0, 300)}`);
    }

    const steps = await (await fetch(`${base}/steps`, { headers })).text();
    if (!steps.includes("smoke-step")) failures.push('custom step importing "strut" from an out-of-tree workspace did not register');

    for (const path of ["/steps", "/audio/models"]) {
      const unauth = await fetch(`${base}${path}`);
      if (unauth.status !== 401) failures.push(`${path} without key: ${unauth.status}, expected 401`);
    }
    const models = await (await fetch(`${base}/audio/models`, { headers })).json();
    if (stt && !models.available) failures.push("sherpa addon did not load in the staged copy (available: false)");
    if (!models.modelDir.startsWith(cache)) failures.push(`modelDir ${models.modelDir} not under STRUT_CACHE_DIR`);
    if (!stt) {
      // Dictation left out: /audio says so instead of crashing or downloading a model.
      if (models.available !== false) failures.push(`--no-stt, yet /audio/models says available: ${models.available}`);
      const tr = await fetch(`${base}/audio/transcribe`, { method: "POST", headers, body: new Uint8Array(64) });
      const body = await tr.text();
      if (tr.status !== 501 || !body.includes("stt not available")) failures.push(`--no-stt /audio/transcribe: ${tr.status} ${body}, expected 501 "stt not available"`);
      const dl = await fetch(`${base}/audio/models/zipformer-en-kroko/download`, { method: "POST", headers });
      const dlBody = await dl.text();
      if (dl.status !== 501 || !dlBody.includes("stt not available")) failures.push(`--no-stt model download: ${dl.status} ${dlBody.slice(0, 200)}, expected 501 "stt not available"`);
    }

    // An app build through the server (POST /apps builds before it publishes):
    // the staged kit/vendor, esbuild from native/ through ESBUILD_BINARY_PATH
    // past the env scrub (no @esbuild package, esbuild-wasm a stub), Tailwind.
    const appFiles = {};
    const fixture = join(ROOT, "src", "apps", "__fixtures__", "hello");
    const readTree = async (d) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        if (e.isDirectory()) await readTree(join(d, e.name));
        else appFiles[relative(fixture, join(d, e.name))] = await readFile(join(d, e.name), "utf-8");
      }
    };
    await readTree(fixture);
    const pubApp = await fetch(`${base}/apps`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: "smoke-app", files: appFiles }) });
    const appResult = await pubApp.json().catch(() => ({}));
    if (pubApp.status !== 201 || !appResult.ok) failures.push(`building the fixture app through POST /apps: ${pubApp.status} ${JSON.stringify(appResult).slice(0, 600)}`);
    else {
      const doc = await fetch(`${base}/apps/smoke-app/${appResult.version}/files/dist/index.html`, { headers });
      if (!doc.ok || !(await doc.text()).includes('<script type="module">')) failures.push(`the built app's dist/index.html did not serve: ${doc.status}`);
      else log(`smoke: app build OK — the fixture published as smoke-app ${appResult.version}, ${(appResult.bytes / 1e6).toFixed(2)} MB`);
    }

    const ui = await fetch(`${base}/`);
    if (!ui.ok || !(await ui.text()).includes("<div id=\"app\"")) failures.push("web UI index did not serve");
  } catch (e) {
    failures.push(String(e));
  } finally {
    child.stdin.end();
    const gone = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 5000))]);
    if (!gone) {
      failures.push("STRUT_EXIT_ON_STDIN_EOF=1: still running 5 s after stdin closed");
      child.kill("SIGKILL");
    } else if (ready && gone.code !== 0) failures.push(`STRUT_EXIT_ON_STDIN_EOF=1: exited ${JSON.stringify(gone)} after stdin closed, expected code 0`);
  }
  if (/Warning: failed to load step/.test(output)) failures.push(`step load warning:\n${output}`);
  if (ladybug) failures.push(...(await smokeLadybug(app, tmp)));
  if (sharpPkgs.length) failures.push(...(await smokeSharp(app)));
  failures.push(...(await smokeStubs(app)));
  await rm(tmp, { recursive: true, force: true });
  if (failures.length) {
    console.error(`[package-desktop] SMOKE FAILED\n - ${failures.join("\n - ")}`);
    process.exit(1);
  }
  log(
    `smoke: OK — desktop.js boots with no STRUT_* env beyond the two dirs, ready line carries port + key, ` +
      `${stt ? "sherpa addon loads" : "/audio answers 501 without sherpa"}, out-of-tree custom step resolves, an app builds with native/esbuild + kit/vendor, UI serves, exits on stdin EOF, stubs answer (${stubs.join(", ")})` +
      `${ladybug ? ", the server boots on the Ladybug workspace, Ladybug opens + queries a database with OpenSSL and both extensions from native/" : ""}`,
  );
}

// From the temp copy, the way build/ code reaches it (a bare import from the
// app root): open a database, LOAD the two extensions from native/ by path
// (what STRUT_LADYBUG_EXTENSION_DIR makes the server do), write, read back.
// DYLD_* is cleared so nothing but the addon's own load commands can find a
// library. The images loaded by all that — the set difference of
// process.report's shared objects before and after, so whatever the node
// binary already linked (Homebrew's node links Homebrew's OpenSSL) doesn't
// count — must all be in native/, and must include lbugjs.node, libssl.3,
// libcrypto.3 and both extensions.
async function smokeLadybug(app, tmp) {
  const script = `
const before = new Set(process.report.getReport().sharedObjects);
const lbug = (await import("@ladybugdb/core")).default;
const db = new lbug.Database(process.argv[1]);
const conn = new lbug.Connection(db);
for (const ext of ${JSON.stringify(LADYBUG_EXTENSIONS)}) await conn.query("LOAD EXTENSION '" + process.argv[2] + "/lib" + ext + ".lbug_extension'");
await conn.query("CREATE NODE TABLE Smoke(name STRING, PRIMARY KEY(name))");
await conn.query("CREATE (:Smoke {name: 'ladybug'})");
await conn.query("CALL CREATE_FTS_INDEX('Smoke', 'smoke_fts', ['name'])");
const rows = await (await conn.query("MATCH (s:Smoke) RETURN s.name AS name")).getAll();
const loaded = process.report.getReport().sharedObjects.filter((p) => !before.has(p));
await conn.close();
await db.close();
console.log(JSON.stringify({ rows, loaded }));
`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("DYLD_") && !k.startsWith("STRUT_")));
  log("smoke: Ladybug — open, load both extensions from native/, write and query a temp database from the copy (DYLD_* cleared)");
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script, join(tmp, "smoke.lbug"), join(app, "native")], { cwd: app, env, encoding: "utf-8" });
  if (r.status !== 0) return [`Ladybug load/query failed (${r.status}):\n${r.stdout}${r.stderr}`];
  let res;
  try {
    res = JSON.parse(r.stdout.trim().split("\n").pop());
  } catch {
    return [`Ladybug smoke printed no result:\n${r.stdout}`];
  }
  const failures = [];
  if (res.rows?.[0]?.name !== "ladybug") failures.push(`Ladybug query returned ${JSON.stringify(res.rows)}`);
  const dirs = [join(app, "native") + "/", (await realpath(join(app, "native"))) + "/"];
  for (const p of res.loaded) if (!dirs.some((d) => p.startsWith(d))) failures.push(`importing Ladybug loaded ${p}, outside the copy's native/`);
  for (const want of ["lbugjs.node", ...OPENSSL_LIBS, ...LADYBUG_EXTENSIONS.map((e) => `lib${e}.lbug_extension`)]) {
    if (!res.loaded.some((p) => p.endsWith(`/${want}`))) failures.push(`${want} not among the images Ladybug loaded: ${res.loaded.join(", ") || "none"}`);
  }
  if (!failures.length) log(`smoke: Ladybug OK — query answered with both extensions loaded; the images loaded:\n    ${res.loaded.join("\n    ")}`);
  return failures;
}

// Resize a generated image with sharp from the copy, DYLD_* cleared; the images
// it loads must be in native/ and include sharp.node and libvips.
async function smokeSharp(app) {
  const script = `
const before = new Set(process.report.getReport().sharedObjects);
const sharp = (await import("sharp")).default;
const png = await sharp({ create: { width: 20, height: 10, channels: 3, background: "#fff" } }).png().toBuffer();
const small = await sharp(png).resize({ width: 12 }).png().toBuffer();
const meta = await sharp(small).metadata();
const loaded = process.report.getReport().sharedObjects.filter((p) => !before.has(p));
console.log(JSON.stringify({ width: meta.width, loaded }));
`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("DYLD_") && !k.startsWith("STRUT_")));
  log("smoke: sharp — resize an image from the copy (DYLD_* cleared)");
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: app, env, encoding: "utf-8" });
  if (r.status !== 0) return [`sharp load/resize failed (${r.status}):\n${r.stdout}${r.stderr}`];
  let res;
  try {
    res = JSON.parse(r.stdout.trim().split("\n").pop());
  } catch {
    return [`sharp smoke printed no result:\n${r.stdout}`];
  }
  const failures = [];
  if (res.width !== 12) failures.push(`sharp resized to width ${res.width}, expected 12`);
  const dirs = [join(app, "native") + "/", (await realpath(join(app, "native"))) + "/"];
  // libvips links macOS's own frameworks (ImageIO and what they pull in); anything else must be in native/.
  for (const p of res.loaded) if (!/^\/(System|usr\/lib)\//.test(p) && !dirs.some((d) => p.startsWith(d))) failures.push(`importing sharp loaded ${p}, outside the copy's native/`);
  for (const want of ["sharp.node", "libvips-cpp"]) {
    if (!res.loaded.some((p) => p.includes(`/${want}`))) failures.push(`${want} not among the images sharp loaded: ${res.loaded.join(", ") || "none"}`);
  }
  if (!failures.length) log(`smoke: sharp OK — resized; loaded from native/:\n    ${res.loaded.filter((p) => dirs.some((d) => p.startsWith(d))).join("\n    ")}`);
  return failures;
}

// Each stub answers an import with its own error, from the app root (where
// build/ resolves from) — proof resolution stops inside the stage.
async function smokeStubs(app) {
  const failures = [];
  for (const name of stubs) {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(name)}).then(() => console.log("LOADED"), (e) => console.log(e.code, e.message))`], { cwd: app, encoding: "utf-8" });
    const line = r.stdout.trim();
    if (!line.startsWith("ERR_MODULE_NOT_FOUND") || !line.includes("is not in this build of strut")) failures.push(`stub ${name}: ${line || r.stderr}`);
    else log(`smoke: stub ${name} → ${line}`);
  }
  return failures;
}

async function tarball() {
  const name = `strut-${platform}.tar.gz`;
  run("tar", ["-czf", join(out, name), "-C", out, "strut"]);
  log(`wrote ${join(out, name)} (${mb((await stat(join(out, name))).size)})`);
}

await build();
await stageFiles();
await installDeps();
await mkdir(native, { recursive: true });
if (stt) await relocateNative();
if (ladybug) {
  await relocateLadybug();
  await stageLadybugExtensions();
}
await relocateSharp();
await relocateEsbuild();
await report();
if (smoke) await smokeTest();
if (tar) await tarball();
log(`done. Host contract: plans/native-dictation-client.md §0; spawn \`node ${join(stage, "desktop.js")}\` or run \`${join(stage, "strut")} --open\``);
