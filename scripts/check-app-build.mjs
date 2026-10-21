#!/usr/bin/env node
/**
 * Proves the app build works where strut is installed: builds the fixture app
 * (src/apps/__fixtures__/hello) with the COMPILED engine (build/apps/build.js)
 * against the kit the server would find (src/apps/kit.ts `defaultKitDir`:
 * `@strut/kit` when pinned, else <strut>/kit/vendor) and the esbuild + Tailwind
 * it would load, and fails unless a document comes out.
 *
 *   npm run test:app-build -- [--strut <dir>] [--fixture <dir>]
 *
 * `--strut` is the directory holding build/ and kit/ (default: this checkout);
 * the Dockerfile runs it in the image. The desktop package's smoke test
 * (scripts/package-desktop.mjs --smoke) builds the same fixture through the
 * staged server instead, where esbuild's binary comes from native/.
 */
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? resolve(args[i + 1]) : dflt;
};
const strut = flag("strut", ROOT);
const fixture = flag("fixture", join(ROOT, "src", "apps", "__fixtures__", "hello"));
const fail = (m) => {
  console.error(`[app-build] FAILED: ${m}`);
  process.exit(1);
};

const { buildApp, loadEsbuild, DOCUMENT_FILE, BUILD_FILE, TOKEN_PLACEHOLDER } = await import(pathToFileURL(join(strut, "build", "apps", "build.js")).href);
const { loadKit } = await import(pathToFileURL(join(strut, "build", "apps", "kit.js")).href);

let kit;
try {
  kit = loadKit();
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
const esbuild = await loadEsbuild().catch((e) => fail(e instanceof Error ? e.message : String(e)));

const dir = await mkdtemp(join(tmpdir(), "strut-app-build-"));
try {
  await cp(fixture, dir, { recursive: true });
  const t0 = Date.now();
  const r = await buildApp(dir, {});
  if (!r.ok) fail(`the fixture did not build:\n  ${r.errors.join("\n  ")}`);
  const html = await readFile(join(dir, DOCUMENT_FILE), "utf8").catch(() => fail(`no ${DOCUMENT_FILE}`));
  const info = JSON.parse(await readFile(join(dir, BUILD_FILE), "utf8"));
  const missing = [
    ['<script type="module">', "the module script"],
    [TOKEN_PLACEHOLDER, "the token meta"],
    ["About this fixture.", "the fixture's own code"],
    [".text-emerald-600", "a Tailwind class the fixture uses"],
  ].filter(([s]) => !html.includes(s));
  if (missing.length) fail(`${DOCUMENT_FILE} lacks ${missing.map(([, what]) => what).join(", ")}`);
  if (info.kit?.version !== kit.manifest.version) fail(`${BUILD_FILE} names kit ${JSON.stringify(info.kit)}, the vendor layer is ${kit.manifest.version}`);
  console.log(
    `[app-build] OK: ${fixture} → ${DOCUMENT_FILE} (${(r.bytes / 1e6).toFixed(2)} MB) in ${Date.now() - t0} ms, ` +
      `${kit.manifest.name} ${kit.manifest.version} from ${kit.vendorDir}, esbuild ${esbuild.version}${r.warnings.length ? `; warnings: ${r.warnings.join("; ")}` : ""}`,
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
