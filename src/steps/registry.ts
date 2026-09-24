import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerStrutResolver } from "../strut-resolver.js";
import type { AnyStepDef, StepRegistry } from "../core.js";
import { parseStepRef } from "../step-ref.js";

/** Where a registered step type came from. */
export type StepSource = "core" | "lib" | "custom";

/** Map of step type name → its source tier. */
export type StepSources = Record<string, StepSource>;

/** Result of building the registry: the registry itself plus a parallel
 *  map recording where each step was loaded from. */
export interface RegistryBundle {
  registry: StepRegistry;
  sources: StepSources;
}

/** Where a PINNED step version's importable source lives, and the content
 *  hash of that version — `WorkspaceStore.materializeStepVersion`. */
export type StepVersionLoader = (name: string, version: string) => Promise<{ path: string; hash: string }>;

export interface ResolvedStep {
  def: AnyStepDef;
  /** Set when the reference pinned a version (`type@vN`): the label and the
   *  content hash of the version that will run. */
  version?: string;
  hash?: string;
}

/** The registry's pin support, hung on the registry record as a
 *  NON-ENUMERABLE property: `Object.keys(registry)` (the /steps listing,
 *  `agentTools` globs) never sees it, and a registry built without a loader
 *  (an in-code `createRegistry`, a test fake) simply cannot pin. */
const PINS: unique symbol = Symbol.for("strut.pins");
interface Pins {
  load: StepVersionLoader;
  cache: Map<string, Promise<ResolvedStep>>;
}
type PinnableRegistry = StepRegistry & { [PINS]?: Pins };

/**
 * Look a step reference up: a bare type is the registry entry (the active
 * version, as always); `type@vN` loads that version through the registry's
 * loader — once per registry, cached forever, since a published version is
 * immutable. Null when the bare type is unknown. A pin the registry cannot
 * honor (no loader, a core/lib type, a version that does not exist) THROWS
 * with the reason — silently running the active version instead would be
 * exactly the substitution a pin exists to prevent.
 */
export async function resolveStep(registry: StepRegistry, ref: string): Promise<ResolvedStep | null> {
  const { type, version } = parseStepRef(ref);
  if (!version) {
    const def = registry[ref];
    return def ? { def } : null;
  }
  const pins = (registry as PinnableRegistry)[PINS];
  if (!pins) throw new Error(`Cannot pin "${ref}": this registry has no step versions (only workspace custom steps are versioned)`);
  let pending = pins.cache.get(ref);
  if (!pending) {
    pending = (async () => {
      const { path, hash } = await pins.load(type, version);
      const def = await importStepDef(path);
      // Also answer a plain `registry["type@vN"]` from now on (still hidden
      // from `Object.keys`): the sync lookups — validate, the agent's tool
      // building — see a pin that has been resolved once.
      Object.defineProperty(registry, ref, { value: def, enumerable: false, configurable: true });
      return { def, version, hash };
    })();
    pins.cache.set(ref, pending);
    // A failed load is not cached: a version published a moment later loads.
    pending.catch(() => pins.cache.delete(ref));
  }
  return pending;
}

/** Give a registry a version loader (see `resolveStep`). */
export function withStepVersions(registry: StepRegistry, sources: StepSources, load: StepVersionLoader): StepRegistry {
  registerStrutResolver(); // an archived version `import "strut"`s like an active one
  const pins: Pins = {
    cache: new Map(),
    load: async (name, version) => {
      const tier = sources[name];
      if (tier && tier !== "custom") throw new Error(`Cannot pin "${name}@${version}": "${name}" is a ${tier} step, which has no versions`);
      return load(name, version);
    },
  };
  Object.defineProperty(registry, PINS, { value: pins, enumerable: false, configurable: true });
  return registry;
}

// ── Built-in core steps (always available) ─────────────────────────────────

import http from "./core/http.js";
import ifStep from "./core/if.js";
import loop from "./core/loop.js";
import foreach from "./core/foreach.js";
import subflow from "./core/subflow.js";
import log from "./core/log.js";
import llm from "./core/llm.js";
import agent from "./core/agent.js";
import wait from "./core/wait.js";
import pack from "./core/pack.js";
import exec from "./core/exec.js";

const CORE_STEPS: StepRegistry = {
  http,
  if: ifStep,
  loop,
  foreach,
  subflow,
  log,
  llm,
  agent,
  wait,
  pack,
  exec,
};

export const CORE_STEP_TYPES = Object.freeze(Object.keys(CORE_STEPS));

/** Directory containing built-in lib steps, resolved relative to this file. */
export const LIB_DIR = join(dirname(fileURLToPath(import.meta.url)), "lib");

/** Directory containing built-in core steps, resolved relative to this file. */
export const CORE_DIR = join(dirname(fileURLToPath(import.meta.url)), "core");

/**
 * Read a step's source code from disk. Resolves core, built-in lib, and
 * workspace custom steps (trying both `.ts` and `.js` so it works whether
 * strut runs from source via tsx or from a compiled build). Returns the
 * code plus which tier it came from, or `null` when no file is found.
 *
 * In-code steps injected via `createRegistry([...])` have no on-disk file —
 * those carry their source on the step def itself (`AnyStepDef.source`) and
 * are handled by the caller before falling back to this.
 */
export async function readStepSourceFromDisk(
  type: string,
  customDir: string,
): Promise<{ code: string; origin: StepSource } | null> {
  const parts = type.split("/");
  const leaf = parts.at(-1)!;
  const nested = parts.slice(0, -1);

  const candidates: Array<{ base: string; origin: StepSource }> = [];
  if (CORE_STEP_TYPES.includes(type)) {
    candidates.push({ base: join(CORE_DIR, type), origin: "core" });
  }
  candidates.push({ base: join(LIB_DIR, ...nested, leaf), origin: "lib" });
  candidates.push({
    base: join(customDir, ...nested, leaf),
    origin: "custom",
  });

  for (const { base, origin } of candidates) {
    for (const ext of [".ts", ".js"]) {
      try {
        return { code: await readFile(base + ext, "utf-8"), origin };
      } catch {
        // try next
      }
    }
  }
  return null;
}

// ── Auto-discovery ─────────────────────────────────────────────────────────

/**
 * Recursively find all .ts/.js files in a directory.
 */
async function findStepFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return files; // directory doesn't exist
  }

  const { stat } = await import("node:fs/promises");

  for (const name of entries) {
    const fullPath = join(dir, name);
    const st = await stat(fullPath);
    if (st.isDirectory()) {
      const nested = await findStepFiles(fullPath);
      files.push(...nested);
    } else if (
      st.isFile() &&
      (name.endsWith(".ts") || name.endsWith(".js")) &&
      !name.startsWith("_") &&
      !name.endsWith(".d.ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".spec.ts")
    ) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Derive a step type name from a file path relative to its base directory.
 *
 * - `lib/github/fetch-prs.ts` → `"github/fetch-prs"`
 * - `custom/my-scorer.ts` → `"my-scorer"`
 * - `custom/utils/parse-diff.ts` → `"utils/parse-diff"`
 */
function stepNameFromPath(filePath: string, baseDir: string): string {
  const rel = relative(baseDir, filePath);
  // Remove extension
  const withoutExt = rel.replace(/\.(ts|js)$/, "");
  // Normalize separators
  return withoutExt.split(/[/\\]/).join("/");
}

/**
 * Dynamically import a step definition file.
 */
async function loadStepFile(filePath: string): Promise<AnyStepDef | null> {
  try {
    // Cache-bust the ESM module cache with the file's mtime so that
    // re-publishing a step (overwriting `custom/<name>.ts`) and rebuilding
    // the registry actually re-imports the new source instead of serving the
    // stale cached module. Unchanged files keep a stable URL (no churn).
    let suffix = "";
    try {
      const { mtimeMs } = await stat(filePath);
      suffix = `?v=${mtimeMs}`;
    } catch {
      // stat failed — fall back to no cache-bust
    }
    const url = pathToFileURL(filePath).href + suffix;
    const mod = await import(url);
    const def = mod.default ?? mod;
    if (def && typeof def === "object" && "type" in def && "run" in def) {
      return def as AnyStepDef;
    }
    return null;
  } catch (err) {
    console.warn(`Warning: failed to load step from ${filePath}:`, err);
    return null;
  }
}

/** Import a step file, throwing on failure — for a PINNED version, whose
 *  load error is the step's error (the discovery loader above stays quiet:
 *  a broken active step simply doesn't exist). */
async function importStepDef(filePath: string): Promise<AnyStepDef> {
  const mod = await import(pathToFileURL(filePath).href);
  const def = mod.default ?? mod;
  if (def && typeof def === "object" && "type" in def && "run" in def) return def as AnyStepDef;
  throw new Error(`${filePath}: no valid default export — expected \`export default defineStep({ type, input, output, run })\``);
}

/**
 * Import a step file the way registry discovery does, but return the failure
 * as a MESSAGE instead of a console warning. `null` means the file imports
 * cleanly and default-exports a valid step def. This is the authoring loop's
 * §5.3.4 guard: `loadStepFile` fails silently (a broken step simply doesn't
 * exist), so publish paths call this to hand the error back to the author.
 */
export async function stepLoadError(filePath: string): Promise<string | null> {
  try {
    let suffix = "?strict";
    try {
      const { mtimeMs } = await stat(filePath);
      suffix = `?v=${mtimeMs}-strict`;
    } catch {
      // stat failed — fall back to a static cache-bust
    }
    const mod = await import(pathToFileURL(filePath).href + suffix);
    const def = mod.default ?? mod;
    if (def && typeof def === "object" && "type" in def && "run" in def) {
      return null;
    }
    return `no valid default export — expected \`export default defineStep({ type, input, output, run })\``;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Build the complete step registry by merging core steps (statically
 * imported) with lib steps (dynamically imported from `src/steps/lib/`)
 * and custom steps (dynamically imported from `customDir` — the directory
 * `WorkspaceStore.materializeCustomSteps()` returns; omit for core+lib only).
 *
 * Resolution order: core/ → lib/ → custom/. Higher tiers cannot shadow
 * lower ones — a name collision is skipped with a warning.
 *
 * Lib and custom step *files* are loaded with dynamic `import()` at
 * build time (cheap: just schema + metadata). Their heavy SDK deps must
 * be `await import()`-ed inside `run()` so they only load when a step
 * actually executes — see AGENTS.md "Lib step dependency convention".
 *
 * Returns both the registry and a parallel `sources` map so callers can
 * report which tier each step came from without guessing from the name.
 */
export async function buildRegistry(customDir?: string, opts?: { loadVersion?: StepVersionLoader }): Promise<RegistryBundle> {
  // Custom steps `import "strut"`; make that resolve to this strut wherever the workspace lives.
  registerStrutResolver();
  const registry: StepRegistry = { ...CORE_STEPS };
  const sources: StepSources = {};

  for (const name of Object.keys(CORE_STEPS)) {
    sources[name] = "core";
  }

  await loadStepsFrom(LIB_DIR, registry, sources, "lib");

  if (customDir) {
    await loadStepsFrom(customDir, registry, sources, "custom");
  }

  // `type@vN` references resolve through the workspace's version archive.
  if (opts?.loadVersion) withStepVersions(registry, sources, opts.loadVersion);

  return { registry, sources };
}

/**
 * Discover and dynamically import all step files in `baseDir`, adding them
 * to `registry` and recording the load tier in `sources`. Names that
 * collide with already-registered steps are skipped with a warning so a
 * lower-priority tier can never shadow a higher one.
 */
async function loadStepsFrom(
  baseDir: string,
  registry: StepRegistry,
  sources: StepSources,
  tier: "lib" | "custom",
): Promise<void> {
  const files = await findStepFiles(baseDir);
  for (const file of files) {
    const name = stepNameFromPath(file, baseDir);
    if (name in registry) {
      console.warn(`Warning: ${tier} step "${name}" conflicts with existing step, skipping`);
      continue;
    }
    const def = await loadStepFile(file);
    if (def) {
      registry[name] = def;
      sources[name] = tier;
    }
  }
}

/**
 * Get the core-only registry (no workspace steps). Useful for testing.
 */
export function coreRegistry(): StepRegistry {
  return { ...CORE_STEPS };
}

/**
 * Build a registry from in-code step definitions, layered on top of the
 * engine-shipped **core** and **lib** steps. For consumers using strut
 * as a library who prefer registering steps in code rather than via
 * filesystem discovery.
 *
 * The resulting registry contains:
 *   - **core/** — 8 built-in steps (http, log, if, loop, foreach,
 *     subflow, llm, wait)
 *   - **lib/** — engine-shipped domain integrations (e.g.
 *     `github/fetch-pr`). Their step *files* are imported here (cheap:
 *     just schema + metadata); their heavy SDK deps are `await import()`-ed
 *     inside `run()`, so they only load when a step actually executes.
 *     See AGENTS.md "Lib step dependency convention".
 *   - whatever you pass in `steps`
 *
 * Workspace **custom/** steps are loaded via `buildRegistry(customDir)`
 * instead — they're never included here.
 *
 * Each step is keyed by its `type` field. Duplicates among `steps`
 * throw. A user step whose `type` collides with a core or lib step
 * shadows it (with a warning), so callers can deliberately override
 * e.g. the built-in `http` step.
 *
 * ```ts
 * const registry = await createRegistry([myStep, anotherStep]);
 * await runWorkflow(flow, input, registry, { services });
 * ```
 */
export async function createRegistry(
  steps: AnyStepDef[],
): Promise<StepRegistry> {
  const registry: StepRegistry = { ...CORE_STEPS };

  // Load lib/ steps (dynamic imports).
  const sources: StepSources = {};
  for (const name of Object.keys(CORE_STEPS)) sources[name] = "core";
  await loadStepsFrom(LIB_DIR, registry, sources, "lib");

  // Layer user-supplied steps on top (shadowing allowed, with warnings).
  const seen = new Set<string>();
  for (const def of steps) {
    if (!def || typeof def !== "object" || !def.type || !def.run) {
      throw new Error(
        `createRegistry: invalid step definition (missing "type" or "run")`,
      );
    }
    if (seen.has(def.type)) {
      throw new Error(`createRegistry: duplicate step type "${def.type}"`);
    }
    seen.add(def.type);
    if (def.type in registry) {
      const tier = def.type in CORE_STEPS ? "core" : "lib";
      console.warn(
        `[strut] createRegistry: user step "${def.type}" shadows built-in ${tier} step`,
      );
    }
    registry[def.type] = def;
  }
  return registry;
}
