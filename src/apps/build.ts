/**
 * The app BUILD (plans/apps.md §2): one directory with an `app.yaml` → one
 * self-contained HTML document, `dist/index.html`, beside `dist/build.json`
 * (the kit it was built with, `builtAt`, the tree hash it built from, each
 * imported app's name and hash). esbuild bundles the entry against the KIT
 * — the frozen vendor layer, never `node_modules` — and Tailwind 4's pure-JS
 * `compile()` turns the classes every bundled source uses into one `<style>`.
 * The same inputs give the same bytes, and the document holds no
 * credential: the app's file token goes into `<meta name="strut-app-token">`
 * when the file route SERVES the document (§7.2), never here.
 *
 * `appResolver` (§2.1) decides every import, in order: a relative import
 * stays inside its directory; `@/…` is the app's `src/` first, then the
 * kit's (shadcn's own model — the components are the project's); a bare
 * specifier in the kit's import map is the vendor file; one that names an
 * INSTALLED APP (`strut/views`, `hive/ui@v3`) is that app's `src/` compiled
 * into THIS bundle (§3.4), a cycle refused naming the chain; anything else
 * is an error that names the set and the installed kits. `http(s):` is
 * refused. The source checks (§2.1) refuse `dangerouslySetInnerHTML`, `eval`
 * and `new Function`, and warn on a global `fetch`, `XMLHttpRequest` or
 * `WebSocket` naming the hook to use instead — over imported apps' sources
 * too. Lazy-imported by whoever builds (the publish, `app/build`), as a lib
 * step's SDK is, so the registry build never loads esbuild.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import type { Message, OnResolveResult } from "esbuild";
import { treeFiles, treeHash } from "../version.js";
import { kitOf, type Kit, type KitLocation } from "./kit.js";
import { readManifest, type AppManifest } from "./manifest.js";

export const DOCUMENT_FILE = "dist/index.html";
export const BUILD_FILE = "dist/build.json";
/** The `<meta name>` the kit's bootstrap reads the file token off (`TOKEN_META` in `@strut/kit/bootstrap`). */
export const TOKEN_META = "strut-app-token";
/** What the build writes; what the file route fills (`withToken`). */
export const TOKEN_PLACEHOLDER = `<meta name="${TOKEN_META}" content="">`;

/** The build's limits (§1.1). */
export const MAX_FILES = 2000;
export const MAX_BYTES = 20 * 1024 * 1024;
/** A document past this is built, with a warning (§2.5). */
export const LARGE_DOCUMENT_BYTES = 6 * 1024 * 1024;

export interface InstalledApp {
  name: string;
  version: string;
  /** The version's directory (`materializeAppVersion`). */
  dir: string;
  /** Its tree hash. */
  hash: string;
}

export interface BuildDeps {
  /** The kit, loaded or by location; the repo's `kit/` by default. */
  kit?: Kit | KitLocation;
  /** The app being built, when known (`app/publish`): an import of it from
   *  an imported kit is a cycle. */
  name?: string;
  /** An installed app by name — the active version, or a pinned `vN` —
   *  for the §3.4 resolver rule; null when there is none. Absent: no app is
   *  installed. */
  resolveApp?: (name: string, version?: string) => Promise<InstalledApp | null>;
  /** Every installed app's name, for the error that names the kits. */
  installedApps?: () => Promise<string[]>;
  /** Does a workflow exist? A grant naming one that does not fails the build. */
  workflowExists?: (name: string) => Promise<boolean>;
  now?: () => Date;
}

/** `dist/build.json`. */
export interface BuildInfo {
  kit: { name: string; version: string };
  builtAt: string;
  /** The tree hash of the directory as built. */
  hash: string;
  /** Each installed app compiled in, with the hash of the version it was
   *  and whether the import pinned it (`hive/ui@v3`) or took the active one. */
  imports: Array<{ name: string; version: string; hash: string; pinned?: true }>;
  /** The document's size. */
  bytes: number;
  warnings: string[];
}

export type BuildResult =
  | { ok: true; manifest: AppManifest; hash: string; bytes: number; warnings: string[]; imports: BuildInfo["imports"] }
  | { ok: false; errors: string[]; warnings: string[] };

// ── Source checks ───────────────────────────────────────────────────────────

const SOURCE_RE = /\.(tsx?|jsx?|mjs)$/;

/** Blank out comments, keeping every line where it is. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (_m, lead: string) => lead);
}

const REFUSED: Array<[RegExp, string]> = [
  [/\bdangerouslySetInnerHTML\b/, "sets dangerouslySetInnerHTML — render text; markdown goes through react-markdown, which is safe by default"],
  [/(?<![.\w$])eval\s*\(/, "calls eval — an app's code is what the build compiled, nothing else runs"],
  [/\bnew\s+Function\s*\(/, "calls new Function — an app's code is what the build compiled, nothing else runs"],
];
const WARNED: Array<[RegExp, string]> = [
  [/(?<![.\w$])fetch\s*\(/, "calls the global fetch — the page's CSP has connect-src 'none', so it fails at runtime; call a granted step with useStep, or launch a workflow with useLaunch"],
  [/\bXMLHttpRequest\b/, "uses XMLHttpRequest — the page can connect nowhere (connect-src 'none'); call a granted step with useStep, or launch a workflow with useLaunch"],
  [/\bnew\s+WebSocket\s*\(/, "opens a WebSocket — the page can connect nowhere (connect-src 'none'); read a run live with useRun({ live })"],
];

/** The source checks over one file's text: refusals and warnings, each
 *  naming the file and line. */
export function lintAppSource(text: string, file: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  stripComments(text)
    .split("\n")
    .forEach((line, i) => {
      for (const [re, msg] of REFUSED) if (re.test(line)) errors.push(`${file}:${i + 1}: ${msg}`);
      for (const [re, msg] of WARNED) if (re.test(line)) warnings.push(`${file}:${i + 1}: ${msg}`);
    });
  return { errors, warnings };
}

// ── zod's namespace ─────────────────────────────────────────────────────────

/** The zod entries whose `z` (and default) export is a NAMESPACE re-export. */
const ZOD_NAMESPACE = /^zod(?:\/v4(?:\/classic)?)?$/;
const IMPORT_BRACES = /\bimport\s*\{([^}]*)\}\s*from\s*(["'])([^"'\n]+)\2/g;
const IMPORT_DEFAULT = /\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{([^}]*)\})?\s*from\s*(["'])([^"'\n]+)\3/g;

/**
 * `import { z } from "zod"` (and `{ z as Q }`, and the default import) as
 * `import * as z from "zod"`. zod's `z` is `export * as`-style — a namespace
 * re-exported by name — and esbuild keeps every member of a namespace it
 * cannot follow, all of zod's locales included: 454 KB minified against
 * 75 KB for the same `z.string()` through `import * as z` (2026-10-21,
 * zod 4.6). Models write the named form by reflex, and so does the MCP Apps
 * SDK the bootstrap carries, so every app paid it. Member access means the
 * same either way; only the bundle changes.
 */
export function zodNamespaceImports(text: string): string {
  if (!text.includes("zod")) return text;
  const named = text.replace(IMPORT_BRACES, (whole, list: string, q: string, spec: string) => {
    if (!ZOD_NAMESPACE.test(spec)) return whole;
    const items = list.split(",").map((x) => x.trim()).filter(Boolean);
    const zi = items.findIndex((x) => /^z(?:\s+as\s+[A-Za-z_$][\w$]*)?$/.test(x));
    if (zi < 0) return whole;
    const local = /\s+as\s+([A-Za-z_$][\w$]*)$/.exec(items[zi]!)?.[1] ?? "z";
    const rest = items.filter((_, i) => i !== zi);
    return `import * as ${local} from ${q}${spec}${q}` + (rest.length ? `;import { ${rest.join(", ")} } from ${q}${spec}${q}` : "");
  });
  return named.replace(IMPORT_DEFAULT, (whole, local: string, list: string | undefined, q: string, spec: string) => {
    if (!ZOD_NAMESPACE.test(spec) || local === "type") return whole;
    return `import * as ${local} from ${q}${spec}${q}` + (list?.trim() ? `;import { ${list.trim()} } from ${q}${spec}${q}` : "");
  });
}

const LOADERS: Record<string, "js" | "jsx" | "ts" | "tsx"> = { ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "jsx", ".ts": "ts", ".mts": "ts", ".tsx": "tsx" };

// ── The document ────────────────────────────────────────────────────────────

/** The document's own CSP (§9), which a host may only tighten. */
export function cspFor(resourceDomains: readonly string[] = []): string {
  const extra = resourceDomains.length ? ` ${resourceDomains.join(" ")}` : "";
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    `img-src data: blob:${extra}`,
    `font-src data:${extra}`,
    `media-src data: blob:${extra}`,
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The served document: the placeholder meta filled with the app's file
 *  token, HTML-escaped. */
export function withToken(html: string, token: string): string {
  return html.replace(TOKEN_PLACEHOLDER, `<meta name="${TOKEN_META}" content="${escapeHtml(token)}">`);
}

/** The document read with the key instead of a token: no meta at all. */
export function withoutTokenMeta(html: string): string {
  return html.replace(TOKEN_PLACEHOLDER, "");
}

function document(title: string, csp: string, css: string, js: string): string {
  // A `</script` or `</style` inside the bundle would end its element early;
  // `<\/` reads the same inside a JS string, a regex or a CSS string.
  const script = js.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
  const style = css.replace(/<\/style/gi, "<\\/style");
  return (
    `<!doctype html>\n<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">${TOKEN_PLACEHOLDER}<title>${escapeHtml(title)}</title>` +
    `<style>${style}</style></head><body><div id="root"></div><script type="module">${script}</script></body></html>\n`
  );
}

// ── esbuild + tailwind, lazily ──────────────────────────────────────────────

type Esbuild = typeof import("esbuild");
type Tailwind = typeof import("tailwindcss");

let esbuildPromise: Promise<Esbuild> | undefined;

/** esbuild, or `esbuild-wasm` on a platform without a native binary. The
 *  import alone succeeds without the binary; the first call does not. */
export function loadEsbuild(): Promise<Esbuild> {
  return (esbuildPromise ??= (async () => {
    let native: Esbuild | undefined;
    try {
      native = await import("esbuild");
      await native.formatMessages([], { kind: "error" });
      return native;
    } catch (err) {
      const wasm = "esbuild-wasm";
      try {
        return (await import(wasm)) as Esbuild;
      } catch {
        esbuildPromise = undefined;
        throw new Error(`esbuild cannot run here (${err instanceof Error ? err.message.split("\n")[0] : String(err)}) and esbuild-wasm is not installed — install either`);
      }
    }
  })());
}

const require = createRequire(import.meta.url);

/** Tailwind's `compile()` options: `@import "tailwindcss"` (and its own
 *  `./theme.css`) from strut's `tailwindcss`, an app's relative imports from
 *  its own files, and no modules at all (`@plugin` / `@config`). */
function tailwindOptions(base: string) {
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
      return { path, base: dirname(path), content: await readFile(path, "utf8") };
    },
    async loadModule(id: string): Promise<never> {
      throw new Error(`an app's stylesheet loads no module (@plugin / @config): ${id}`);
    },
  };
}

/** Tailwind class candidates in source texts — every whitespace- or
 *  quote-separated token Tailwind itself accepts (`candidatesToCss`) under
 *  the stylesheet being compiled, so an app's own `@theme` tokens count. */
async function scanCandidates(tw: Tailwind, kit: Kit, css: string, sources: Iterable<string>): Promise<string[]> {
  const tokens = new Set<string>();
  for (const text of sources) for (const t of text.split(/[\s"'`]+/)) if (t && t.length < 200) tokens.add(t);
  const design = await tw.__unstable__loadDesignSystem(css, tailwindOptions(dirname(kit.baseCssPath)));
  const list = [...tokens].sort();
  const compiled = design.candidatesToCss(list);
  return list.filter((_, i) => compiled[i] !== null);
}

// ── The build ───────────────────────────────────────────────────────────────

/** What the build reads: the tree hash's files minus `db/` (migrations are
 *  the database's, not the document's). */
const buildExcluded = (rel: string, name: string) => name.startsWith(".") || name === "node_modules" || rel === "dist" || rel === "data.db" || rel === "db";

/** A directory the bundle draws from: the app itself, or an installed app
 *  compiled in (§3.4). */
interface Root {
  /** The app's name; the main app's when known. */
  name?: string;
  version?: string;
  dir: string;
  hash?: string;
  /** Imported with a `@vN` pin. */
  pinned?: true;
  /** Who first imported it (the chain a cycle is named by). */
  parent?: Root;
}

/** The namespace of a module the package disables in the browser. */
const EMPTY_NS = "strut-empty";

const RESOLVE_EXTS = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".css", ".json"];

async function exists(p: string): Promise<"file" | "dir" | null> {
  try {
    const s = await stat(p);
    return s.isFile() ? "file" : s.isDirectory() ? "dir" : null;
  } catch {
    return null;
  }
}

/** `base` as a file, `base.<ext>`, or `base/index.<ext>`. */
async function resolveFile(base: string): Promise<string | null> {
  const kind = await exists(base);
  if (kind === "file") return base;
  for (const ext of RESOLVE_EXTS) if ((await exists(base + ext)) === "file") return base + ext;
  if (kind === "dir") for (const ext of RESOLVE_EXTS) if ((await exists(join(base, `index${ext}`))) === "file") return join(base, `index${ext}`);
  return null;
}

const inside = (root: string, abs: string) => abs === root || abs.startsWith(root + sep);

/** The error a bare import outside the kit gets (§2.1). */
function notInKit(spec: string, kit: Kit, installed: string[]): string {
  const available = [...Object.keys(kit.manifest.packages), "@/components/ui/<name>", "@/lib/utils", "@strut/kit"].join(", ");
  return (
    `"${spec}" is not in the app kit (${kit.manifest.name} ${kit.manifest.version}). Available: ${available}. ` +
    `Installed kits (an app imports another app's src/ by name): ${installed.length ? installed.join(", ") : "none"}. ` +
    `For work the kit cannot do, write a workflow and call it with useLaunch.`
  );
}

/** Build the app at `dir`: `dist/index.html` + `dist/build.json`, or the errors (and nothing written). */
export async function buildApp(dir: string, deps: BuildDeps = {}): Promise<BuildResult> {
  const root = resolve(dir);
  const warnings: string[] = [];
  const read = await readManifest(root);
  if (!read.ok) return { ok: false, errors: read.errors, warnings };
  const manifest = read.manifest;

  // The files, within the limits.
  const files = await treeFiles(root, buildExcluded);
  if (files.length > MAX_FILES) return { ok: false, errors: [`${files.length} files — an app has at most ${MAX_FILES}`], warnings };
  let total = 0;
  for (const f of files) total += (await stat(join(root, f))).size;
  if (total > MAX_BYTES) return { ok: false, errors: [`${(total / 1e6).toFixed(1)} MB of files — an app has at most ${MAX_BYTES / 1024 / 1024} MB; a large dataset belongs in a run's output`], warnings };

  const errors: string[] = [];
  // Grants name workflows that exist (§1.3).
  if (deps.workflowExists) {
    for (const key of ["workflows", "automations"] as const) {
      for (const wf of manifest.grants[key]) if (!(await deps.workflowExists(wf))) errors.push(`grants.${key}: no workflow "${wf}" — publish it first, or drop the grant`);
    }
  }
  const entryAbs = await resolveFile(resolve(root, manifest.entry));
  if (!entryAbs || !inside(root, entryAbs)) errors.push(`entry: "${manifest.entry}" is not a file in the app (its default export is the root component)`);
  if (errors.length || !entryAbs) return { ok: false, errors, warnings };

  let kit: Kit;
  try {
    kit = kitOf(deps.kit);
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)], warnings };
  }
  const main: Root = { dir: root, ...(deps.name ? { name: deps.name } : {}) };
  /** Every root the bundle draws from, by directory; the main app first. */
  const roots: Root[] = [main];
  const rootOf = (file: string): Root | undefined => roots.filter((r) => inside(r.dir, file)).sort((a, b) => b.dir.length - a.dir.length)[0];
  const label = (r: Pick<Root, "name" | "version">) => (r.name ? `${r.name}${r.version ? `@${r.version}` : ""}` : "the app");
  const rel = (r: Root, abs: string) => `${r === main ? "" : `${label(r)}:`}${relative(r.dir, abs).split(sep).join("/")}`;
  /** Vendor CSS the code imported, in first-import order (appended raw). */
  const vendorCss: string[] = [];
  const installedCache = new Map<string, Promise<InstalledApp | null>>();
  const resolveInstalled = (name: string, version?: string) => {
    const key = `${name}@${version ?? ""}`;
    let p = installedCache.get(key);
    if (!p) {
      p = deps.resolveApp ? deps.resolveApp(name, version) : Promise.resolve(null);
      installedCache.set(key, p);
    }
    return p;
  };

  const err = (text: string): OnResolveResult => ({ errors: [{ text }] });
  /** A module of the kit's tree, with the side-effect flag its package
   *  declares — esbuild reads no package.json for a path a plugin hands it,
   *  and without the flag nothing an app leaves unused could be dropped (§2.5). */
  const vendorModule = (path: string): OnResolveResult => (kit.modules[path]?.pure ? { path, sideEffects: false } : { path });

  /** The §3.4 rule: `name[@vN][/sub]`, the longest installed name first. */
  async function resolveApp(spec: string, from: Root): Promise<OnResolveResult | null> {
    if (!deps.resolveApp) return null;
    const segs = spec.split("/");
    for (let n = segs.length; n >= 1; n--) {
      const head = segs.slice(0, n).join("/");
      const m = /^(.+?)(?:@(v\d+))?$/.exec(head)!;
      const name = m[1]!;
      const version = m[2];
      let app: InstalledApp | null;
      try {
        app = await resolveInstalled(name, version);
      } catch (e) {
        return err(`"${spec}": ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!app) continue;
      // A cycle: the app being built, or an ancestor on the import chain.
      const chain: Root[] = [];
      for (let r: Root | undefined = from; r; r = r.parent) chain.unshift(r);
      if (chain.some((r) => r.name === name)) {
        const names = [...chain.map(label), label({ name, version: app.version })];
        return err(`"${spec}": import cycle ${names.join(" → ")} — an app may not import the app that imports it`);
      }
      let appRoot = roots.find((r) => r.dir === app!.dir);
      if (!appRoot) {
        appRoot = { name, version: app.version, dir: resolve(app.dir), hash: app.hash, parent: from, ...(version ? { pinned: true as const } : {}) };
        roots.push(appRoot);
      }
      const sub = segs.slice(n).join("/");
      const file = await resolveFile(join(appRoot.dir, "src", sub || "index"));
      if (!file) return err(`"${spec}": the installed app ${label(appRoot)} has no src/${sub || "index.ts"}`);
      return { path: file };
    }
    return null;
  }

  const plugin = {
    name: "strut-app-resolver",
    setup(build: import("esbuild").PluginBuild) {
      build.onResolve({ filter: /.*/ }, async (args): Promise<OnResolveResult | undefined> => {
        if (args.kind === "entry-point") return undefined;
        const spec = args.path;
        if (/^https?:/i.test(spec)) return err(`"${spec}": URL imports are refused — every library is the kit's, compiled in`);
        // Inside the kit's module tree every import was resolved by the kit's
        // own build; nothing is resolved again, nothing leaves the tree.
        if (inside(kit.vendorDir, args.importer)) {
          const links = kit.modules[args.importer]?.links;
          const to = links?.[spec];
          if (to === null) return { path: spec, namespace: EMPTY_NS };
          if (to === undefined) return err(`"${spec}" from the kit's ${relative(kit.vendorDir, args.importer)}: not in the kit's module table — the vendor layer is self-contained`);
          return vendorModule(to);
        }
        const from = rootOf(args.importer) ?? (args.importer === "<stdin>" || !args.importer ? main : undefined);
        if (!from) return err(`"${spec}" imported from outside the app (${args.importer})`);
        if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/")) {
          const abs = spec.startsWith("/") ? resolve(from.dir, `.${spec}`) : resolve(args.resolveDir, spec);
          if (!inside(from.dir, abs)) return err(`"${spec}" from ${rel(from, args.importer)}: a relative import may not leave the app's directory`);
          const top = relative(from.dir, abs).split(sep)[0]!;
          if (top === "dist" || top === "node_modules" || top === "db" || top === "data.db" || top.startsWith(".")) {
            return err(`"${spec}" from ${rel(from, args.importer)}: ${top} is not part of the build`);
          }
          const file = await resolveFile(abs);
          if (!file) return err(`"${spec}" from ${rel(from, args.importer)}: no such file`);
          return { path: file };
        }
        if (spec.startsWith("@/")) {
          const own = await resolveFile(join(from.dir, "src", spec.slice(2)));
          if (own) return { path: own };
          const kitFile = kit.imports[spec];
          if (kitFile) return vendorModule(kitFile);
          return err(`"${spec}" is neither in ${label(from)}'s src/ nor in the kit (its @/ modules: @/components/ui/<name>, @/lib/utils, @/hooks/use-mobile)`);
        }
        const mapped = kit.imports[spec];
        if (mapped) return vendorModule(mapped);
        const app = await resolveApp(spec, from);
        if (app) return app;
        return err(notInKit(spec, kit, deps.installedApps ? await deps.installedApps() : []));
      });
      // zod's namespace, whoever imports it (the app, an imported app, the kit's tree).
      build.onLoad({ filter: /\.(m?[jt]sx?|cjs)$/ }, async (args) => {
        const text = await readFile(args.path, "utf8");
        const out = zodNamespaceImports(text);
        if (out === text) return undefined;
        return { contents: out, loader: LOADERS[extname(args.path)] ?? "js", resolveDir: dirname(args.path) };
      });
      // A module the package disables in the browser (its `browser` field).
      build.onLoad({ filter: /.*/, namespace: EMPTY_NS }, () => ({ contents: "module.exports = {};", loader: "js" }));
      // A stylesheet: an app's own goes through the Tailwind compile (every
      // .css in the directory does — below), the kit's is appended raw; the
      // import itself becomes an empty module.
      build.onLoad({ filter: /\.css$/ }, async (args) => {
        if (inside(kit.vendorDir, args.path) && !vendorCss.includes(args.path)) vendorCss.push(args.path);
        return { contents: "", loader: "js" };
      });
    },
  };

  const esbuild = await loadEsbuild();
  const entryRel = relative(root, entryAbs).split(sep).join("/");
  let js: string;
  /** Every module the bundle holds, by absolute path. */
  const bundled = new Set<string>();
  try {
    const result = await esbuild.build({
      stdin: {
        contents: `import { bootstrap } from "@strut/kit/bootstrap";\nimport App from ${JSON.stringify(`./${entryRel}`)};\nbootstrap(App);\n`,
        resolveDir: root,
        sourcefile: "<stdin>",
        loader: "tsx",
      },
      absWorkingDir: root,
      outfile: "bundle.js",
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: ["es2022"],
      jsx: "automatic",
      minify: true,
      charset: "utf8",
      legalComments: "none",
      sourcemap: false,
      // The browser bundles were built for production; so is the app's code.
      // (The key is spelled apart: strut's env scan, env.test.ts, is text.)
      define: { [["process", "env", "NODE_ENV"].join(".")]: '"production"' },
      loader: {
        ".png": "dataurl", ".jpg": "dataurl", ".jpeg": "dataurl", ".gif": "dataurl", ".webp": "dataurl", ".svg": "dataurl", ".ico": "dataurl",
        ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl", ".otf": "dataurl",
        ".mp3": "dataurl", ".wav": "dataurl", ".mp4": "dataurl", ".webm": "dataurl",
        ".md": "text", ".txt": "text", ".csv": "text", ".html": "text",
      },
      plugins: [plugin],
      metafile: true,
      logLevel: "silent",
    });
    js = result.outputFiles.find((f) => f.path.endsWith(".js"))?.text ?? "";
    for (const input of Object.keys(result.metafile.inputs)) if (!input.includes(":") && input !== "<stdin>") bundled.add(resolve(root, input));
    // A warning inside the kit's modules is not the app author's to act on
    // (esbuild says nothing about code under a node_modules; the tree is not one).
    for (const w of result.warnings) if (!w.location || !inside(kit.vendorDir, resolve(root, w.location.file))) warnings.push(formatMessage(w, root));
  } catch (e) {
    const messages = (e as { errors?: Message[] }).errors;
    if (!Array.isArray(messages) || !messages.length) return { ok: false, errors: [e instanceof Error ? e.message : String(e)], warnings };
    return { ok: false, errors: [...new Set(messages.map((m) => formatMessage(m, root)))], warnings };
  }

  // The source checks, over every root's sources (§2.1, §3.4). The Tailwind
  // scan reads the app's own sources and, of an imported app and of the kit,
  // only the modules the bundle kept: an app that draws one of strut/views'
  // components is not styled for the gallery (§2.5).
  const sources: string[] = [];
  const cssTexts: string[] = [];
  for (const file of [...bundled].sort()) {
    if (inside(kit.vendorDir, file) && SOURCE_RE.test(file) && !inside(join(kit.vendorDir, "files", "_m"), file)) sources.push(await readFile(file, "utf8"));
  }
  for (const r of roots) {
    const list = r === main ? files : await treeFiles(join(r.dir, "src"), (_rel, name) => name.startsWith(".") || name === "node_modules");
    for (const f of list.sort()) {
      const abs = r === main ? join(r.dir, f) : join(r.dir, "src", f);
      if (SOURCE_RE.test(f)) {
        const text = await readFile(abs, "utf8");
        if (r === main || bundled.has(abs)) sources.push(text);
        const lint = lintAppSource(text, rel(r, abs));
        errors.push(...lint.errors);
        warnings.push(...lint.warnings);
      } else if (f.endsWith(".css")) {
        cssTexts.push(await readFile(abs, "utf8"));
      }
    }
  }
  if (errors.length) return { ok: false, errors, warnings };

  // Styles (§2.2): the base stylesheet + the apps' CSS over every candidate.
  const tw: Tailwind = await import("tailwindcss");
  let css: string;
  try {
    const stylesheet = [kit.baseCss, ...cssTexts].join("\n");
    const compiler = await tw.compile(stylesheet, tailwindOptions(dirname(kit.baseCssPath)) as Parameters<typeof tw.compile>[1]);
    const candidates = await scanCandidates(tw, kit, stylesheet, sources);
    css = compiler.build(candidates);
    for (const f of vendorCss) css += `\n${await readFile(f, "utf8")}`;
    css = (await esbuild.transform(css, { loader: "css", minify: true, legalComments: "none" })).code;
  } catch (e) {
    return { ok: false, errors: [`styles: ${e instanceof Error ? e.message : String(e)}`], warnings };
  }

  const html = document(manifest.title, cspFor(manifest.csp?.resourceDomains ?? []), css, js);
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > LARGE_DOCUMENT_BYTES) warnings.push(`the document is ${(bytes / 1e6).toFixed(1)} MB (over ${LARGE_DOCUMENT_BYTES / 1024 / 1024} MB): three and mathjs tree-shake poorly; a large dataset belongs in a run's output`);

  const hash = await treeHash(root);
  const imports = roots
    .filter((r) => r !== main)
    .map((r) => ({ name: r.name!, version: r.version!, hash: r.hash!, ...(r.pinned ? { pinned: true as const } : {}) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const info: BuildInfo = {
    kit: { name: kit.manifest.name, version: kit.manifest.version },
    builtAt: (deps.now?.() ?? new Date()).toISOString(),
    hash,
    imports,
    bytes,
    warnings,
  };
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, DOCUMENT_FILE), html, "utf8");
  await writeFile(join(root, BUILD_FILE), JSON.stringify(info, null, 2) + "\n", "utf8");
  return { ok: true, manifest, hash, bytes, warnings, imports };
}

function formatMessage(m: Message, root: string): string {
  const loc = m.location;
  if (!loc || loc.file === "<stdin>") return m.text;
  const file = loc.file.startsWith("/") ? relative(root, loc.file) : loc.file;
  return `${file}:${loc.line}: ${m.text}`;
}

/** `dist/build.json`, or null when the directory was never built. */
export async function readBuildInfo(dir: string): Promise<BuildInfo | null> {
  try {
    return JSON.parse(await readFile(join(dir, BUILD_FILE), "utf8")) as BuildInfo;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    return null;
  }
}
