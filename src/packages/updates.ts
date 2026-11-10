/**
 * The way back from an update (plans/managed-packages.md §3):
 * `<dataDir>/packages/updates.json`, plain JSON like `indexes.json`, keeps
 * for each package its LAST update — the release it came from, the release
 * it went to, and each item the update moved with the version that was
 * active before. A rollback points those items at their earlier versions
 * again. No store deletes a version, so the earlier ones are all there.
 *
 * One level, and re-pointing only: what the release added stays, and what
 * it dropped is not brought back (the result says neither moved).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorkspaceStore } from "../workspace.js";
import type { InstallResult } from "./install.js";

export const UPDATES_FILE = "updates.json";

type Kind = "workflow" | "step" | "app";

export interface LastUpdate {
  from?: { version?: string; digest?: string };
  to: { version: string; digest: string };
  at: string;
  by?: string;
  /** Each item the update moved: the version that was active (`from`) and
   *  the one the update published for it (`to`). */
  moved: Array<{ kind: Kind; name: string; from: string; to: string }>;
}

export interface PackageUpdates {
  last?: LastUpdate;
}

export interface RollbackResult {
  package: string;
  /** The release the items are back on, and the one they left. */
  to?: { version?: string; digest?: string };
  from: { version: string; digest: string };
  restored: Array<{ kind: Kind; name: string; version: string }>;
  /** Items left where they are, and why. */
  left: Array<{ kind: Kind; name: string; reason: string }>;
}

export interface Updates {
  get(pkg: string): Promise<PackageUpdates | undefined>;
  /** Record what an update (or an install that updated required packages) moved. */
  record(result: InstallResult, by?: string): Promise<void>;
  forget(pkg: string): Promise<void>;
  /** Point every item the last update moved at the version before it.
   *  Throws `package_no_update:` when there is none on file. */
  rollback(pkg: string): Promise<RollbackResult>;
}

/** Each updated package of a result, as its last update. */
export function lastUpdates(result: InstallResult, by: string | undefined, at: string): Map<string, LastUpdate> {
  const out = new Map<string, LastUpdate>();
  for (const p of result.packages) {
    if (p.status !== "updated") continue;
    const moved = p.items.flatMap((i) =>
      (i.kind === "workflow" || i.kind === "step" || i.kind === "app") && i.previous && i.version && i.previous !== i.version
        ? [{ kind: i.kind, name: i.name, from: i.previous, to: i.version }]
        : [],
    );
    out.set(p.package, { ...(p.from ? { from: p.from } : {}), to: { version: p.version, digest: p.digest }, at, ...(by ? { by } : {}), moved });
  }
  return out;
}

export function createUpdates(deps: { file: string; workspace: WorkspaceStore; rebuild(): Promise<unknown>; now?: () => Date }): Updates {
  const read = async (): Promise<Record<string, PackageUpdates>> => {
    try {
      return JSON.parse(await readFile(deps.file, "utf8")) as Record<string, PackageUpdates>;
    } catch (err: any) {
      if (err?.code === "ENOENT") return {};
      throw err;
    }
  };
  const write = async (all: Record<string, PackageUpdates>) => {
    await mkdir(dirname(deps.file), { recursive: true });
    const tmp = `${deps.file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, "utf8");
    await rename(tmp, deps.file);
  };
  const activeOf = async (kind: Kind, name: string): Promise<string | undefined> =>
    kind === "workflow"
      ? (await deps.workspace.getWorkflowMetadata(name))?.active
      : kind === "step"
        ? (await deps.workspace.getStepMetadata(name))?.active
        : (await deps.workspace.getApp(name))?.active;

  return {
    get: async (pkg) => (await read())[pkg],

    async record(result, by) {
      const updates = lastUpdates(result, by, (deps.now?.() ?? new Date()).toISOString());
      if (!updates.size) return;
      const all = await read();
      for (const [pkg, last] of updates) all[pkg] = { ...all[pkg], last };
      await write(all);
    },

    async forget(pkg) {
      const all = await read();
      if (!(pkg in all)) return;
      delete all[pkg];
      await write(all);
    },

    async rollback(pkg) {
      const all = await read();
      const last = all[pkg]?.last;
      if (!last) throw new Error(`package_no_update: ${pkg} has no update on file to roll back`);
      const out: RollbackResult = { package: pkg, ...(last.from ? { to: last.from } : {}), from: last.to, restored: [], left: [] };
      for (const m of last.moved) {
        const active = await activeOf(m.kind, m.name);
        if (active === m.from) continue; // already there: a draft nobody made live, or taken back by hand
        if (active !== m.to) {
          out.left.push({ kind: m.kind, name: m.name, reason: active ? `changed since the update (${active} is active)` : "no longer here" });
          continue;
        }
        if (m.kind === "workflow") await deps.workspace.setActiveVersion(m.name, m.from);
        else if (m.kind === "step") await deps.workspace.setActiveStepVersion(m.name, m.from);
        else await deps.workspace.setActiveAppVersion(m.name, m.from);
        out.restored.push({ kind: m.kind, name: m.name, version: m.from });
      }
      await deps.rebuild();
      const { last: _gone, ...rest } = all[pkg]!;
      if (Object.keys(rest).length) all[pkg] = rest;
      else delete all[pkg];
      await write(all);
      return out;
    },
  };
}
