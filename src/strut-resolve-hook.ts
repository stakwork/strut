/**
 * Module customization hook (node:module `register`) for custom steps, which
 * are user files under the workspace (`<workspace>/steps/custom/<name>.ts`).
 * Two jobs.
 *
 * Resolve the bare specifier `"strut"` to the *running* strut's own entry
 * module. Custom steps `import { defineStep } from "strut"`, and Node
 * resolves a bare specifier by walking up from the importing file, so that
 * only works when the workspace happens to sit inside a directory tree that
 * can see a `strut` package (the dev checkout via package self-reference, mcp
 * via its vendored copy). A desktop install keeps the workspace in
 * Application Support, nowhere near the bundle, and a server can point
 * STRUT_WORKSPACE anywhere. This removes the dependence on placement and
 * guarantees the step gets the same module instance the server runs, not a
 * second copy. `"vein"` is the pre-rename package name (#1664) and resolves
 * the same way: step versions published before the rename live in the graph
 * verbatim — their content hash is their identity — and still `import "vein"`.
 *
 * Version what a step imports by a relative path. Node keeps the module it
 * loaded for a URL for the life of the process, so a republished helper
 * (`./_shared.js`) would never reach the steps that import it. The registry
 * imports every step file under `hashedUrl` — its URL with a hash of its
 * source and of every file it reaches by relative imports — and this hook
 * gives each such import of a hashed module the same kind of URL. A changed
 * helper is then a new URL, and so is every step that reaches it, while an
 * unchanged file keeps its module — a helper's one module shared by every
 * step and pinned version that imports it, as before. An import of strut's
 * own modules or of an installed package is never versioned.
 *
 * Registered once by `registerStrutResolver()` (strut-resolver.ts). Runs on
 * Node's hooks thread, and the registry calls `hashedUrl` on the main
 * thread; keep it dependency-free. Everything else falls through to the
 * next resolver (tsx in dev, Node's default in prod) as before.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";

let entry = "";

const SELF_SPECIFIERS = new Set(["strut", "vein"]);

/** The query parameter `hashedUrl` sets. */
const HASH = "hash";

/** strut's own modules (src/ in dev, build/ in prod): one instance each. */
const OWN = dirname(fileURLToPath(import.meta.url)) + sep;

/** A relative specifier in an import, an `export … from` or an `import()`. */
const RELATIVE_IMPORT = /\b(?:from|import)\s*\(?\s*(["'])(\.\.?\/[^"'\n]+)\1/g;

export function initialize(data: { entry: string }): void {
  entry = data.entry;
}

type ResolveContext = { parentURL?: string; conditions: string[]; importAttributes: Record<string, string> };
type ResolveResult = { url: string; format?: string | null; shortCircuit?: boolean };
type NextResolve = (specifier: string, context: ResolveContext) => Promise<ResolveResult>;

export async function resolve(specifier: string, context: ResolveContext, next: NextResolve): Promise<ResolveResult> {
  if (entry && SELF_SPECIFIERS.has(specifier)) return { url: entry, shortCircuit: true };
  const resolved = await next(specifier, context);
  const parent = context.parentURL;
  if (!/^\.\.?\//.test(specifier) || !parent?.startsWith("file:") || !resolved.url.startsWith("file:")) return resolved;
  if (!new URL(parent).searchParams.has(HASH) || !versioned(fileURLToPath(resolved.url))) return resolved;
  return { ...resolved, url: await hashedUrl(new URL(resolved.url)) };
}

/**
 * `url` (a module's file URL) with `?hash=`: a hash of the module's source
 * and of the source of every file it reaches by relative imports,
 * transitively — strut's own modules and packages left out — so the URL
 * changes exactly when something the module runs changes.
 */
export async function hashedUrl(url: URL): Promise<string> {
  const reached = new Map<string, string>();
  await reach(fileURLToPath(url), reached);
  const hash = createHash("sha256");
  for (const [file, digest] of [...reached].sort(([a], [b]) => (a < b ? -1 : 1))) hash.update(`${file}\0${digest}\n`);
  url.searchParams.set(HASH, hash.digest("hex").slice(0, 16));
  return url.href;
}

/** Record `file`'s source hash, then each file it imports by a relative path:
 *  the first that reads of a `.js` naming a `.ts` file (tsx), the path as
 *  written, or no extension. False when `file` does not read — not recorded,
 *  so one published later changes the hash. */
async function reach(file: string, reached: Map<string, string>): Promise<boolean> {
  if (reached.has(file)) return true;
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch {
    return false;
  }
  reached.set(file, createHash("sha256").update(source).digest("hex"));
  for (const [, , specifier] of source.matchAll(RELATIVE_IMPORT)) {
    const base = resolvePath(dirname(file), specifier!.replace(/[?#].*/, ""));
    for (const candidate of [base.replace(/\.js$/, ".ts"), base, `${base}.ts`]) {
      if (!versioned(candidate) || (await reach(candidate, reached))) break;
    }
  }
  return true;
}

function versioned(file: string): boolean {
  return !file.startsWith(OWN) && !file.split(sep).includes("node_modules");
}
