// Builds the kit's VENDOR LAYER (plans/apps.md §3): a FROZEN MODULE TREE —
// every file the specifiers in scripts/manifest.ts reach (the dependency
// set, the shadcn components and the kit itself), copied out of
// kit/node_modules as the packages ship them, module by module — so the app
// build bundles each app from the original modules and tree-shakes it: an app
// that imports three icons gets three icons, not lucide-react's 1 600 (§2.5).
// The first kit (0.1) froze one pre-bundled, minified chunk per specifier
// instead; module boundaries and `sideEffects` were lost in it, and every app
// carried ~1.2 MB before its own first line.
//
// esbuild resolves every import ONCE, here (platform browser, production),
// and the answers are recorded, so the app build never resolves a package
// again and never reads a node_modules:
//   files/…          the modules, at their path under the kit with every
//                    `node_modules` segment written `_m` (npm never packs a
//                    nested node_modules). A `.js` file whose package says
//                    `"type": "module"` is written `.mjs`, and the kit's own
//                    TypeScript is compiled to `.mjs` — esbuild reads neither
//                    `type` nor a tsconfig for a path a plugin hands it, and
//                    both change how a module is read (node-mode interop)
//   modules.json     { "<file>": { links: { "<specifier>": "<file>" | null },
//                    pure?: true } } — each import as esbuild resolved it
//                    (null: a module the package's `browser` field disables),
//                    and whether the package declares the file free of side
//                    effects (`sideEffects`), which esbuild also does not read
//                    for a plugin's path
//   import-map.json  { imports: { "<specifier>": "./files/…" | "./<name>.css" } }
//                    — what the app build's appResolver consults (§2.1);
//                    aliases included
//   <name>.css       the stylesheet entries, bundled
//   candidates.json  the Tailwind class candidates of the kit's own components
//   manifest.json    the kit's version, each package's version, the entries
// One React per page holds by construction: every import of `react`, from
// anywhere in the tree, is the one file the table names. Nothing here runs in
// strut's server process; `yarn build:vendor`.
import { build, transform, type Metafile, type Message } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
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

/** One module of the tree, as `modules.json` records it. */
export interface VendorModule {
  /** Each import's specifier → the file it resolved to; null = disabled (an empty module). */
  links: Record<string, string | null>;
  /** The package declares the file free of side effects. */
  pure?: true;
}

/** A direct dependency's package.json (read from the file: not every package exports it). */
const packageJson = (name: string) => JSON.parse(readFileSync(join(kitDir, "node_modules", name, "package.json"), "utf8"));

/** The specifiers the import map holds, with what each builds from. */
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

// ── package.json, read the way a bundler reads it ──────────────────────────

const pkgCache = new Map<string, Record<string, unknown> | null>();
function readPkg(dir: string): Record<string, unknown> | null {
  if (!pkgCache.has(dir)) {
    const file = join(dir, "package.json");
    pkgCache.set(dir, existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);
  }
  return pkgCache.get(dir)!;
}

/** The package root a file sits in: the directory right under its last
 *  `node_modules` (`node_modules/@scope/name`), or the kit for its own sources. */
function packageRoot(abs: string): string {
  const parts = relative(kitDir, abs).split("/");
  const at = parts.lastIndexOf("node_modules");
  if (at < 0) return kitDir;
  const n = parts[at + 1]?.startsWith("@") ? 3 : 2;
  return join(kitDir, ...parts.slice(0, at + n));
}

/** The nearest package.json from a file up to its package root — the
 *  nearest that declares `key`, when one is named. */
function nearest(abs: string, key?: string): { dir: string; pkg: Record<string, unknown> } | null {
  const root = packageRoot(abs);
  for (let dir = dirname(abs); ; dir = dirname(dir)) {
    const pkg = readPkg(dir);
    if (pkg && (key === undefined || key in pkg)) return { dir, pkg };
    if (dir === root || dir === kitDir || dir === dirname(dir)) return null;
  }
}

/** A `sideEffects` glob as a regex over the path relative to its package.json:
 *  a pattern without a slash matches the file name anywhere (webpack's and
 *  esbuild's rule). */
function sideEffectsGlob(pattern: string): RegExp {
  const p = pattern.replace(/^\.\//, "");
  const body = p
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((part) => part === "**/" ? "(?:.*/)?" : part === "**" ? ".*" : part === "*" ? "[^/]*" : part === "?" ? "[^/]" : part.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
    .join("");
  return new RegExp(p.includes("/") ? `^${body}$` : `(?:^|/)${body}$`);
}

/** Whether the package declares this file free of side effects: the nearest
 *  package.json up to the package's root that has a `sideEffects` field. */
function declaredPure(abs: string): boolean {
  const found = nearest(abs, "sideEffects");
  if (!found) return false;
  const se = found.pkg.sideEffects;
  if (se === false) return true;
  if (Array.isArray(se)) {
    const rel = relative(found.dir, abs);
    return !se.some((g) => typeof g === "string" && sideEffectsGlob(g).test(rel));
  }
  return false;
}

/** Node's module type for a `.js` file: its nearest package.json's `type`. */
const isModuleType = (abs: string) => nearest(abs)?.pkg.type === "module";

/** Where a reached file lives in the tree, relative to the vendor dir. */
function treePath(abs: string): string {
  const rel = relative(kitDir, abs).split("/").map((s) => (s === "node_modules" ? "_m" : s)).join("/");
  if (/\.(tsx?|mts)$/.test(rel)) return `files/${rel.replace(/\.(tsx?|mts)$/, ".mjs")}`;
  if (rel.endsWith(".js") && isModuleType(abs)) return `files/${rel.slice(0, -3)}.mjs`;
  return `files/${rel}`;
}

export interface VendorBuild {
  outdir: string;
  /** Specifier → file, relative to the vendor dir. */
  imports: Record<string, string>;
  modules: Record<string, VendorModule>;
  candidates: string[];
  manifest: Record<string, unknown>;
  /** The resolution pass's metafile (inputs = every module of the tree). */
  metafile: Metafile;
  warnings: Message[];
}

const BUILD_OPTIONS = {
  absWorkingDir: kitDir,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  // The modules are frozen as production reaches them (react's
  // `process.env.NODE_ENV` branch); the app build defines the same.
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "silent",
} as const;

/** Build everything into `outdir` (default `kit/vendor/`). `minify` is the
 *  stylesheets'; the modules are frozen as shipped and minified per app. */
export async function buildVendor({ outdir = vendorDir, minify = true }: { outdir?: string; minify?: boolean } = {}): Promise<VendorBuild> {
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });
  const all = entries();
  const js = all.filter((e) => e.kind === "js");
  const css = all.filter((e) => e.kind === "css");

  // The resolution pass: what every JS entry reaches, and how each import resolved.
  const scan = await build({
    ...BUILD_OPTIONS,
    entryPoints: js.map((e) => ({ in: e.in, out: e.out })),
    outdir: join(outdir, ".scan"),
    write: false,
    metafile: true,
  });
  const metafile = scan.metafile;
  const modules: Record<string, VendorModule> = {};
  const abs = (input: string) => join(kitDir, input);
  for (const [input, info] of Object.entries(metafile.inputs)) {
    if (input.startsWith("(disabled):")) continue;
    const from = abs(input);
    if (!from.startsWith(kitDir + "/")) throw new Error(`vendor: ${input} is outside the kit`);
    const file = treePath(from);
    const target = join(outdir, file);
    mkdirSync(dirname(target), { recursive: true });
    if (/\.(tsx?|mts)$/.test(input)) {
      // The kit's own sources: TypeScript out, every specifier kept as written.
      const out = await transform(readFileSync(from, "utf8"), {
        loader: input.endsWith("x") ? "tsx" : "ts", jsx: "automatic", format: "esm", target: "es2022", sourcefile: input,
      });
      writeFileSync(target, out.code);
    } else {
      copyFileSync(from, target);
    }
    const links: Record<string, string | null> = {};
    for (const imp of info.imports) {
      // A TypeScript import elided as type-only is recorded external, unnamed.
      if (imp.external && imp.original === undefined) continue;
      if (imp.external) throw new Error(`vendor: ${input} imports ${imp.original ?? imp.path} as external`);
      const spec = imp.original ?? imp.path;
      const to = imp.path.startsWith("(disabled):") ? null : treePath(abs(imp.path));
      if (spec in links && links[spec] !== to) throw new Error(`vendor: ${input} resolves ${spec} two ways`);
      links[spec] = to;
    }
    modules[file] = { links, ...(declaredPure(from) ? { pure: true as const } : {}) };
  }

  const imports: Record<string, string> = {};
  const entryOf = new Map<string, string>();
  for (const [out, info] of Object.entries(metafile.outputs)) if (info.entryPoint) entryOf.set(out.replace(/^.*\.scan\//, "").replace(/\.js$/, ""), info.entryPoint);
  for (const e of js) {
    const input = entryOf.get(e.out);
    if (!input) throw new Error(`vendor: no entry point recorded for ${e.id}`);
    imports[e.id] = `./${treePath(abs(input))}`;
  }

  // The stylesheets, bundled one file each.
  const styles = await build({
    ...BUILD_OPTIONS,
    entryPoints: css.map((e) => ({ in: e.in, out: e.out })),
    outdir,
    minify,
    legalComments: "none",
    // leaflet.css draws its controls and markers from images beside it.
    loader: { ".png": "dataurl", ".svg": "dataurl", ".gif": "dataurl" },
    write: true,
    metafile: true,
  });
  for (const e of css) {
    const file = `${e.out}.css`;
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
    modules: Object.keys(modules).length,
    candidates: candidates.length,
  };
  writeFileSync(join(outdir, "modules.json"), JSON.stringify(modules) + "\n");
  writeFileSync(join(outdir, "import-map.json"), JSON.stringify({ imports }, null, 2) + "\n");
  writeFileSync(join(outdir, "candidates.json"), JSON.stringify(candidates, null, 2) + "\n");
  writeFileSync(join(outdir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { outdir, imports, modules, candidates, manifest, metafile, warnings: [...scan.warnings, ...styles.warnings] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const t0 = Date.now();
  const r = await buildVendor();
  const bytes = Object.values(r.metafile.inputs).reduce((n, i) => n + i.bytes, 0);
  const pure = Object.values(r.modules).filter((m) => m.pure).length;
  console.log(`vendor: ${Object.keys(r.imports).length} specifiers, ${Object.keys(r.modules).length} modules (${pure} side-effect free), ${(bytes / 1e6).toFixed(1)} MB, ${r.candidates.length} candidates, ${Date.now() - t0} ms → ${relative(process.cwd(), r.outdir)}`);
  for (const w of r.warnings) console.warn(`warning: ${w.text}${w.location ? ` (${w.location.file}:${w.location.line})` : ""}`);
}
