/**
 * Module customization hook (node:module `register`): resolve the bare
 * specifier `"strut"` to the *running* strut's own entry module.
 *
 * Why: custom steps are user files under the workspace
 * (`<workspace>/steps/custom/<name>.ts`) that `import { defineStep } from
 * "strut"`. Node resolves a bare specifier by walking up from the importing
 * file, so that only works when the workspace happens to sit inside a
 * directory tree that can see a `strut` package (the dev checkout via package
 * self-reference, mcp via its vendored copy). A desktop install keeps the
 * workspace in Application Support, nowhere near the bundle, and a server can
 * point STRUT_WORKSPACE anywhere. This hook removes the dependence on
 * placement and guarantees the step gets the same module instance the server
 * runs, not a second copy.
 *
 * Registered once by `registerStrutResolver()` (strut-resolver.ts). Runs on
 * Node's hooks thread; keep it dependency-free. Everything that isn't exactly
 * `"strut"` falls through to the next resolver (tsx in dev, Node's default in
 * prod), so subpaths and every other package behave as before.
 *
 * `"vein"` is the pre-rename package name (#1664) and resolves the same way:
 * step versions published before the rename live in the graph verbatim —
 * their content hash is their identity — and still `import "vein"`.
 */
let entry = "";

const SELF_SPECIFIERS = new Set(["strut", "vein"]);

export function initialize(data: { entry: string }): void {
  entry = data.entry;
}

type ResolveContext = { parentURL?: string; conditions: string[]; importAttributes: Record<string, string> };
type ResolveResult = { url: string; format?: string | null; shortCircuit?: boolean };
type NextResolve = (specifier: string, context: ResolveContext) => Promise<ResolveResult>;

/**
 * A WORKSPACE step (under `steps/custom/`, an archived version under
 * `steps/_history/`, the graph store's materialized `steps/_graph*`) that
 * imports the shell, the disk or the wire directly is going around
 * `ctx.services` — the scrubbed child env, the cassette, the secrets
 * masking (src/step-lint.ts has the same list and runs at publish; this
 * runs at import, so it sees what is on disk whoever put it there). Warn-only
 * today, once per file and module; a later strut refuses the import here.
 * Strut's own lib steps and a host's node_modules are not under those
 * directories and pass untouched.
 */
const RISKY_MODULES = new Set([
  "child_process", "fs", "fs/promises", "net", "http", "https", "http2", "dns", "tls", "dgram", "worker_threads", "vm", "cluster",
]);
const STEP_DIR = /\/steps\/(custom|_history|_graph(-versions)?)\//;
const warned = new Set<string>();

function warnRiskyImport(specifier: string, parentURL: string | undefined): void {
  if (!parentURL || !STEP_DIR.test(parentURL)) return;
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  if (!RISKY_MODULES.has(bare)) return;
  const file = decodeURIComponent(parentURL.replace(/^file:\/\//, "")).split("?")[0]!; // without the loader's ?v= cache-bust
  const key = `${file}|${bare}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(
    `[steps] ${file} imports ${specifier}: a custom step reaches the shell, files and the network through ctx.services (shell, artifacts, http) — a later strut refuses this import`,
  );
}

export async function resolve(specifier: string, context: ResolveContext, next: NextResolve): Promise<ResolveResult> {
  if (entry && SELF_SPECIFIERS.has(specifier)) return { url: entry, shortCircuit: true };
  warnRiskyImport(specifier, context.parentURL);
  return next(specifier, context);
}
