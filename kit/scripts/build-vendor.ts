// Builds the kit's VENDOR LAYER (plans/apps.md §3): `vendor/` holds one
// browser ESM bundle per specifier in scripts/manifest.ts — the dependency
// set, the shadcn components and the kit itself — produced by ONE esbuild call
// with code splitting, so a module two entries share lands in one chunk and
// the page has one React. Beside the bundles:
//   import-map.json  { imports: { "<specifier>": "./<file>" } } — what the app
//                    build's appResolver consults (§2.1); aliases included
//   candidates.json  the Tailwind class candidates of the kit's own components,
//                    for the app build's compile (§2.2)
//   manifest.json    the kit's version, each package's version, the entries
// Nothing here runs in strut's server process; `npm run build:vendor`.
import { build, type Metafile, type Message } from "esbuild";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { kitDir, scanCandidates, sourceFiles, vendorDir } from "../src/node.js";
import { ALIASES, CSS_ENTRIES, JS_ENTRIES, KIT_ENTRIES, PACKAGES, outName } from "./manifest.js";

export interface VendorEntry {
  /** The specifier an app imports. */
  id: string;
  /** What esbuild resolves: the specifier, or a kit source file. */
  in: string;
  /** The output name, no extension. */
  out: string;
  kind: "js" | "css";
}

/** A direct dependency's package.json (read from the file: not every package exports it). */
const packageJson = (name: string) => JSON.parse(readFileSync(join(kitDir, "node_modules", name, "package.json"), "utf8"));

/** The specifiers the import map holds, with the file each builds to. */
export function entries(): VendorEntry[] {
  const ui = readdirSync(join(kitDir, "src/components/ui")).filter((f) => f.endsWith(".tsx")).sort();
  const list: VendorEntry[] = [];
  for (const id of JS_ENTRIES) list.push({ id, in: id, out: outName(id), kind: "js" });
  for (const id of CSS_ENTRIES) list.push({ id, in: id, out: outName(id), kind: "css" });
  for (const [id, file] of Object.entries(KIT_ENTRIES)) list.push({ id, in: file, out: outName(id), kind: "js" });
  for (const f of ui) {
    const id = `@/components/ui/${f.replace(/\.tsx$/, "")}`;
    list.push({ id, in: `src/components/ui/${f}`, out: outName(id), kind: "js" });
  }
  return list;
}

/** Each pinned package's installed version. */
export function packageVersions(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PACKAGES) out[name] = packageJson(name).version;
  return out;
}

/** The Tailwind candidates of the kit's own sources (components, hooks, the
 *  error boundary's markup). */
export function kitCandidates(): Promise<string[]> {
  return scanCandidates(sourceFiles(join(kitDir, "src")).map((f) => readFileSync(f, "utf8")));
}

export interface VendorBuild {
  outdir: string;
  imports: Record<string, string>;
  candidates: string[];
  manifest: Record<string, unknown>;
  metafile: Metafile;
  warnings: Message[];
}

/** Build everything into `outdir` (default `kit/vendor/`). */
export async function buildVendor({ outdir = vendorDir, minify = true }: { outdir?: string; minify?: boolean } = {}): Promise<VendorBuild> {
  const all = entries();
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });
  const result = await build({
    absWorkingDir: kitDir,
    entryPoints: all.map((e) => ({ in: e.in, out: e.out })),
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: ["es2022"],
    minify,
    sourcemap: false,
    legalComments: "none",
    define: { "process.env.NODE_ENV": '"production"' },
    outdir,
    chunkNames: "chunks/[name]-[hash]",
    metafile: true,
    write: true,
    logLevel: "silent",
  });
  const imports: Record<string, string> = {};
  for (const e of all) {
    const file = `${e.out}.${e.kind}`;
    if (!existsSync(join(outdir, file))) throw new Error(`vendor build wrote no ${file} for ${e.id}`);
    imports[e.id] = `./${file}`;
  }
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (!imports[target]) throw new Error(`alias ${alias} → ${target}: no such entry`);
    imports[alias] = imports[target];
  }
  const candidates = await kitCandidates();
  const pkg = JSON.parse(readFileSync(join(kitDir, "package.json"), "utf8"));
  const manifest = {
    name: pkg.name,
    version: pkg.version,
    packages: packageVersions(),
    aliases: ALIASES,
    entries: all.map((e) => e.id),
    candidates: candidates.length,
  };
  writeFileSync(join(outdir, "import-map.json"), JSON.stringify({ imports }, null, 2) + "\n");
  writeFileSync(join(outdir, "candidates.json"), JSON.stringify(candidates, null, 2) + "\n");
  writeFileSync(join(outdir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { outdir, imports, candidates, manifest, metafile: result.metafile, warnings: result.warnings };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const t0 = Date.now();
  const r = await buildVendor();
  const files = Object.entries(r.metafile.outputs);
  const total = files.reduce((n, [, o]) => n + o.bytes, 0);
  console.log(`vendor: ${Object.keys(r.imports).length} specifiers, ${files.length} files, ${(total / 1e6).toFixed(1)} MB, ${r.candidates.length} candidates, ${Date.now() - t0} ms → ${relative(process.cwd(), r.outdir)}`);
  for (const w of r.warnings) console.warn(`warning: ${w.text}${w.location ? ` (${w.location.file}:${w.location.line})` : ""}`);
}
