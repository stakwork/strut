/** `@strut/kit/node` — the kit from the SERVER's side (plans/apps.md §2):
 *  where the vendor layer is, the import map `appResolver` consults, the
 *  precomputed candidates and the base stylesheet the Tailwind compile takes,
 *  and that compile itself over the kit's own `tailwindcss`. Nothing here
 *  touches a browser. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The kit's package root (one level above `src/` and `dist/` alike). */
export const kitDir = dirname(dirname(fileURLToPath(import.meta.url)));
export const vendorDir = join(kitDir, "vendor");
export const baseStylesheetPath = join(kitDir, "src/styles/base.css");

const require = createRequire(join(kitDir, "package.json"));

export interface KitManifest {
  name: string;
  version: string;
  packages: Record<string, string>;
  aliases: Record<string, string>;
  entries: string[];
  candidates: number;
}

export function readManifest(dir = vendorDir): KitManifest {
  return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
}

/** The import map: bare specifier → the vendor file, as an ABSOLUTE path. */
export function readImportMap(dir = vendorDir): Record<string, string> {
  const { imports } = JSON.parse(readFileSync(join(dir, "import-map.json"), "utf8")) as { imports: Record<string, string> };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(imports)) out[k] = resolve(dir, v);
  return out;
}

/** The Tailwind candidates of the kit's own components (§2.2). */
export function readCandidates(dir = vendorDir): string[] {
  return JSON.parse(readFileSync(join(dir, "candidates.json"), "utf8"));
}

export function readBaseStylesheet(): string {
  return readFileSync(baseStylesheetPath, "utf8");
}

/** Tailwind's `compile()` options that resolve `@import "tailwindcss"` (and
 *  its own `./theme.css` imports) from the kit's `tailwindcss` dependency,
 *  and refuse `@plugin` / `@config` — an app's CSS is `@theme`, `@layer`,
 *  `@utility`. */
export function tailwindOptions(base = dirname(baseStylesheetPath)) {
  const twDir = dirname(require.resolve("tailwindcss/package.json"));
  return {
    base,
    async loadStylesheet(id: string, from: string) {
      const path =
        id === "tailwindcss" ? join(twDir, "index.css")
        : id.startsWith("tailwindcss/") ? join(twDir, id.slice("tailwindcss/".length))
        : id.startsWith(".") ? join(from, id)
        : null;
      if (!path) throw new Error(`stylesheet import not resolvable in an app: ${id}`);
      return { path, base: dirname(path), content: readFileSync(path, "utf8") };
    },
    async loadModule(id: string): Promise<never> {
      throw new Error(`an app's stylesheet loads no module (@plugin / @config): ${id}`);
    },
  };
}

export interface CompileStylesOptions {
  /** The app's own CSS, appended after the base stylesheet. */
  css?: string[];
  /** The candidates scanned from the app's sources; the kit's are added. */
  candidates: Iterable<string>;
  /** The base stylesheet to compile (the kit's by default). */
  base?: string;
  /** The kit candidates to add (read from `vendor/` by default). */
  kitCandidates?: string[];
}

/** One compile of the base stylesheet + the app's CSS over the candidates
 *  (§2.2): what the app build puts in the document's `<style>`. */
export async function compileStyles(opts: CompileStylesOptions): Promise<string> {
  const { compile } = await import("tailwindcss");
  const css = [opts.base ?? readBaseStylesheet(), ...(opts.css ?? [])].join("\n");
  const compiler = await compile(css, tailwindOptions());
  const all = new Set<string>(opts.kitCandidates ?? readCandidates());
  for (const c of opts.candidates) all.add(c);
  return compiler.build([...all].sort());
}

/** Tailwind class candidates in a source text — every whitespace- or
 *  quote-separated token — validated by Tailwind itself (`candidatesToCss`),
 *  so the list holds classes and nothing else. */
export async function scanCandidates(sources: Iterable<string>, base = readBaseStylesheet()): Promise<string[]> {
  const { __unstable__loadDesignSystem } = await import("tailwindcss");
  const tokens = new Set<string>();
  for (const text of sources) for (const t of text.split(/[\s"'`]+/)) if (t && t.length < 200) tokens.add(t);
  const design = await __unstable__loadDesignSystem(base, tailwindOptions());
  const list = [...tokens].sort();
  const css = design.candidatesToCss(list);
  return list.filter((_, i) => css[i] !== null);
}

/** Every `.ts` / `.tsx` / `.css` source under a directory (tests and `.d.ts` left out). */
export function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(tsx?|css)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.endsWith(".d.ts")) out.push(p);
  }
  return out.sort();
}
