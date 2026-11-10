/**
 * An install as it goes (plans/marketplace.md §3): what a person's page
 * shows while a package is written — "Concepts 312 / 752" — whichever door
 * started it: `POST /packages/install` (with or without `wait: false`), a
 * proposal's apply (`package/install`), the boot list (`STRUT_PACKAGES`),
 * a subscription. One record per install, kept in memory like a feed: a
 * restart forgets them, and an install a restart cut off is not running
 * any more. Read by `GET /packages/installs[/:id]`.
 */
import { randomBytes } from "node:crypto";
import type { InstallResult } from "./install.js";

/** What an install is doing, in the order it does it. `queued`: waiting on
 *  another install or uninstall (one write at a time). */
export type InstallPhase = "queued" | "resolving" | "checking" | "types" | "steps" | "workflows" | "apps" | "concepts" | "concept-tree" | "retiring" | "claims";

/** One step of an install, as `installPackages` reports it. */
export interface InstallProgress {
  phase: Exclude<InstallPhase, "queued">;
  /** The package of the set the phase is about. */
  package?: string;
  /** How far, of what: steps, workflows, apps, Concept pages, `PARENT_OF` edges. */
  done?: number;
  total?: number;
}

export interface InstallState {
  /** `inst_<16 hex>`. */
  id: string;
  /** What was asked: the ref, or a subscription's refs joined. */
  ref: string;
  /** A person's install, or the distro's (a subscription). */
  door: "install" | "distro";
  actor?: string;
  status: "queued" | "running" | "done" | "failed";
  phase: InstallPhase;
  package?: string;
  done?: number;
  total?: number;
  /** Epoch ms: asked, last told, ended. */
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  /** What `POST /packages/install` answers, once done. */
  result?: InstallResult;
  /** The refusal or failure, as the route would answer it (`package_conflict: …`). */
  error?: string;
}

export interface InstallTracker {
  /** Run `install` under a record: its id now, its result when it ends
   *  (rejected as the install is). `install` is handed the reporter. */
  start(what: { ref: string; door?: "install" | "distro"; actor?: string }, install: (progress: (p: InstallProgress) => void) => Promise<InstallResult>): { id: string; done: Promise<InstallResult> };
  get(id: string): InstallState | undefined;
  /** Newest first: the running ones and the recently ended. */
  list(): InstallState[];
}

/** Ended installs kept, and for how long. */
export const INSTALLS_KEPT = 20;
export const INSTALL_KEPT_MS = 60 * 60_000;

export function createInstallTracker(opts: { now?: () => number } = {}): InstallTracker {
  const now = opts.now ?? Date.now;
  const states = new Map<string, InstallState>();
  const prune = () => {
    const ended = [...states.values()].filter((s) => s.finishedAt !== undefined).sort((a, b) => b.finishedAt! - a.finishedAt!);
    ended.forEach((s, i) => {
      if (i >= INSTALLS_KEPT || now() - s.finishedAt! > INSTALL_KEPT_MS) states.delete(s.id);
    });
  };
  const copy = (s: InstallState): InstallState => ({ ...s });
  return {
    start(what, install) {
      prune();
      const id = `inst_${randomBytes(8).toString("hex")}`;
      const at = now();
      const state: InstallState = { id, ref: what.ref, door: what.door ?? "install", ...(what.actor ? { actor: what.actor } : {}), status: "queued", phase: "queued", startedAt: at, updatedAt: at };
      states.set(id, state);
      const progress = (p: InstallProgress) => {
        if (state.finishedAt !== undefined) return;
        state.status = "running";
        state.phase = p.phase;
        // A phase's own package and counts, never the last one's.
        for (const k of ["package", "done", "total"] as const) delete state[k];
        if (p.package !== undefined) state.package = p.package;
        if (p.done !== undefined) state.done = p.done;
        if (p.total !== undefined) state.total = p.total;
        state.updatedAt = now();
      };
      const done = install(progress).then(
        (result) => {
          Object.assign(state, { status: "done", result, finishedAt: now(), updatedAt: now() });
          return result;
        },
        (err: unknown) => {
          Object.assign(state, { status: "failed", error: err instanceof Error ? err.message : String(err), finishedAt: now(), updatedAt: now() });
          throw err;
        },
      );
      return { id, done };
    },
    get: (id) => {
      const s = states.get(id);
      return s && copy(s);
    },
    list: () => {
      prune();
      return [...states.values()].sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : -1)).map(copy);
    },
  };
}
