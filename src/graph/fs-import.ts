/**
 * The one-shot import of a FILESYSTEM workspace into a graph-backed one
 * (plans/ladybug-backend.md §6 item 4, §7.1): a desktop that ran on the
 * file workspace boots on `STRUT_WORKSPACE_BACKEND=ladybug` and finds its
 * workflows and steps in the file. A boot step, not a script — the repo's
 * rule — run by `ladybugWorkspaceFromEnv` before the server is built.
 *
 * What moves: every workflow version, under its own label (`v1`, `v2`, …,
 * through `publishWorkflow(name, label, yaml)`), with its description and
 * provenance, then the workflow's active version, category, publisher,
 * owner, run cap and automations; every custom step version in label order
 * (`publishStep` hands out the next label, so the labels come out the
 * same), then the step's active version. The store is content-addressed,
 * so running this twice is a no-op; a label that already exists in the
 * graph with OTHER content is a conflict and the import fails — the graph
 * was written to by something else, and merging is not this step's call.
 *
 * What does not: run records (the run store's, under `workflows/<name>/
 * runs/`, untouched), version timestamps (`createdAt` is the import's
 * moment — the graph records when it learned a version), and a NON-active
 * version today's validation refuses (an `input:` or `claims:` block the
 * lint grew stricter about since it was published): skipped and named in
 * the report, its YAML kept in the moved-aside files. An active version
 * that fails fails the import.
 *
 * Only once the whole import has gone through is the file workspace moved
 * aside — `<dataDir>/fs-workspace.imported-<timestamp>/` — and the ledger
 * stamped with that folder's name (`Migration`, the same table the Neo4j
 * boot steps stamp). A failure leaves every file where it was, so the
 * caller (server.ts) boots on the filesystem workspace and the import runs
 * again at the next boot.
 */
import { basename, join } from "node:path";
import { FileWorkspaceStore, type FileWorkspaceSnapshot } from "../workspace.js";
import { contentHash } from "../version.js";
import type { GraphWorkspaceStore } from "./workspace-store.js";

export const FS_IMPORT_MIGRATION_PREFIX = "fs-workspace-import:";

export interface FileImportReport {
  /** `nothing`: no file workspace under `dataDir`. `imported`: everything
   *  is in the graph and the files were moved aside. `failed`: nothing was
   *  moved; `error` says why. */
  status: "nothing" | "imported" | "failed";
  workflows: number;
  workflowVersions: number;
  steps: number;
  stepVersions: number;
  /** Non-active workflow versions the graph store refused (`name vN: why`). */
  skipped: string[];
  /** Where the files went (`imported`). */
  movedTo?: string;
  error?: string;
}

/** The folder the files move to: unique per import, so a workspace that
 *  came back to the filesystem for a while and is imported again keeps
 *  both sets. */
export function importAsideDir(dataDir: string, now: Date = new Date()): string {
  return join(dataDir, `fs-workspace.imported-${now.toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
}

export async function importFileWorkspace(dataDir: string, target: GraphWorkspaceStore, opts: { now?: Date } = {}): Promise<FileImportReport> {
  const report: FileImportReport = { status: "nothing", workflows: 0, workflowVersions: 0, steps: 0, stepVersions: 0, skipped: [] };
  const source = new FileWorkspaceStore(dataDir);
  let snap: FileWorkspaceSnapshot | null;
  try {
    snap = await source.snapshot();
  } catch (err) {
    return { ...report, status: "failed", error: `reading the filesystem workspace: ${message(err)}` };
  }
  if (!snap) return report;

  try {
    for (const wf of snap.workflows) {
      const existing = await target.getWorkflowMetadata(wf.name);
      for (const v of wf.versions) {
        const have = existing?.versions[v.label];
        if (have && have.hash !== contentHash(v.yaml)) {
          throw new Error(`fs_import_conflict: workflow "${wf.name}" ${v.label} already exists in the graph with different content`);
        }
      }
      for (const v of wf.versions) {
        try {
          await target.publishWorkflow(wf.name, v.label, v.yaml, v.info.description, wf.meta.category, wf.meta.publisher, {
            ...(v.info.source ? { source: v.info.source } : {}),
            ...(v.info.actor ? { actor: v.info.actor } : {}),
          });
          report.workflowVersions++;
        } catch (err) {
          if (v.label === wf.meta.active) throw new Error(`workflow "${wf.name}" ${v.label} (active): ${message(err)}`);
          report.skipped.push(`${wf.name} ${v.label}: ${message(err)}`);
        }
      }
      await target.setActiveVersion(wf.name, wf.meta.active);
      if (wf.meta.owner) await target.setWorkflowOwner(wf.name, wf.meta.owner);
      if (wf.meta.maxRunCostUsd != null) await target.setWorkflowRunCap(wf.name, wf.meta.maxRunCostUsd);
      if (wf.meta.automations?.length) await target.setWorkflowAutomations(wf.name, wf.meta.automations);
      report.workflows++;
    }
    for (const step of snap.steps) {
      for (const v of step.versions) {
        const r = await target.publishStep(step.name, v.code, v.info.description, step.publisher);
        if (r.version !== v.label) {
          throw new Error(`fs_import_conflict: step "${step.name}" ${v.label} landed as ${r.version} — the graph already holds other versions of it`);
        }
        report.stepVersions++;
      }
      await target.setActiveStepVersion(step.name, step.active);
      report.steps++;
    }
  } catch (err) {
    return { ...report, status: "failed", error: message(err) };
  }

  const movedTo = importAsideDir(dataDir, opts.now);
  await target.graph.schemaSource.stampMigration(`${FS_IMPORT_MIGRATION_PREFIX}${basename(movedTo)}`);
  await source.moveAside(movedTo);
  return { ...report, status: "imported", movedTo };
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
