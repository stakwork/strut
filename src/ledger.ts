/**
 * The ledger — the contract as a tool result (`plans/claims.md` §5).
 *
 * This is the forcing function: the model reads what its work is claimed to
 * do, and what the evidence says, in the RESULT of the call it just made —
 * not in an instruction it can rationalize past. Three places carry it:
 *
 *   - `run_workflow` / `run_step` results list the claims with every check
 *     `lastVerify: { pending: true }` — the contract at once, a verdict coming;
 *   - the `[verify-notification]` message (and a `[run-notification]` whose
 *     verify pass already settled) carries the computed statuses;
 *   - `verify_run` returns it directly.
 *
 * Workflow claims and each step's claims are listed separately: step
 * evidence does NOT roll up into the workflow (roll-up needs sub-claims).
 */
import { flowClosure } from "./closure.js";
import type { Flow } from "./core.js";
import { isExternalCheck, subjectName, type ClaimsReader, type SubjectRef } from "./graph/claims.js";
import type { SubflowResolver } from "./runner.js";
import type { LastVerify, VerifyResult } from "./verify.js";

export interface LedgerCheck {
  id: string;
  name: string;
  /** An external check: answered by a person or an outside system. */
  external?: true;
  lastVerify?: LastVerify;
}

export interface LedgerClaim {
  id: string;
  text: string;
  status: "supported" | "refuted" | "unknown" | "stale";
  /** The verdict rests on a model's or a person's word — nothing observed. */
  assertedOnly: boolean;
  /** Active checks with no evidence about the active version. */
  unverified: number;
  latest?: { content?: string; observed_at?: number; mode?: string; check?: string; checkVersion?: string };
  checks: LedgerCheck[];
}

/** One list per subject: a workflow by name, a step by type (`step:<type>`
 *  only if a workflow shares the name). */
export type Ledger = Record<string, LedgerClaim[]>;

export const VERIFY_NOTIFICATION_PREFIX = "[verify-notification]";

const sameSubject = (a: SubjectRef, b: SubjectRef) => a.kind === b.kind && subjectName(a) === subjectName(b);

/** Several outcomes for one check in one run (a foreach yields one per
 *  iteration) read as the most informative one. */
function mergeLastVerify(all: LastVerify[]): LastVerify | undefined {
  return all.find((v) => "ran" in v) ?? all.find((v) => "planned" in v) ?? all.find((v) => "pending" in v) ?? all[0];
}

/**
 * The ledger for `subjects`. `lastVerify` comes from a verify result when
 * there is one; `pending` marks every runnable check instead (a run was just
 * launched and its pass has not settled). Subjects with no claims are left
 * out, so an empty ledger means "nothing here carries a contract".
 */
export async function buildLedger(
  reader: Pick<ClaimsReader, "statusFor">,
  subjects: readonly SubjectRef[],
  opts: { result?: Pick<VerifyResult, "checks">; pending?: boolean } = {},
): Promise<Ledger> {
  const ledger: Ledger = {};
  const names = new Set<string>();
  for (const subject of subjects) {
    const rows = await reader.statusFor(subject);
    if (rows.length === 0) continue;
    let key = subjectName(subject);
    if (names.has(key)) key = `${subject.kind}:${key}`;
    names.add(key);
    ledger[key] = rows.map((r) => ({
      id: r.claim.id,
      text: r.claim.claim_text,
      status: r.status.status,
      assertedOnly: r.status.assertedOnly,
      unverified: r.status.unverified,
      ...(r.status.latest
        ? {
            latest: {
              ...(r.status.latest.content !== undefined ? { content: r.status.latest.content } : {}),
              ...(r.status.latest.observed_at !== undefined ? { observed_at: r.status.latest.observed_at } : {}),
              ...(r.status.latest.evidence_mode ? { mode: r.status.latest.evidence_mode } : {}),
              ...(r.status.latest.check_id ? { check: r.status.latest.check_id } : {}),
              ...(r.status.latest.source?.context?.checkVersion ? { checkVersion: r.status.latest.source.context.checkVersion } : {}),
            },
          }
        : {}),
      checks: r.checks.map((k) => {
        const outcomes = (opts.result?.checks ?? []).filter((c) => c.checkId === k.id && c.claimId === r.claim.id && sameSubject(c.subject, subject)).map((c) => c.lastVerify);
        const slot = r.status.slots.find((s) => s.check_id === k.id);
        const lastVerify: LastVerify | undefined =
          mergeLastVerify(outcomes) ??
          (slot ? { planned: slot.evidence_id } : undefined) ??
          // Only a check that fires on a RUN has a verdict coming from this one.
          (opts.pending && (k.run_when ?? "run") === "run" ? { pending: true } : undefined);
        return { id: k.id, name: k.name, ...(isExternalCheck(k) ? { external: true as const } : {}), ...(lastVerify ? { lastVerify } : {}) };
      }),
    }));
  }
  return ledger;
}

/**
 * The subjects a flow can execute, BEFORE it has run: the workflow, its
 * nested children, and every step type in reach — what a launch result
 * lists as pending. (After a run, the verify result names what it observed.)
 */
export async function subjectsOfFlow(flow: Pick<Flow, "name" | "steps">, workspace: SubflowResolver | undefined, workflowName?: string): Promise<SubjectRef[]> {
  const closure = await flowClosure(flow, workspace);
  return [
    ...(workflowName ? [{ kind: "workflow" as const, name: workflowName }] : []),
    ...closure.workflows.map((w) => ({ kind: "workflow" as const, name: w.workflow })),
    ...[...closure.types].map((type) => ({ kind: "step" as const, type })),
  ].filter((s, i, all) => all.findIndex((o) => sameSubject(o, s)) === i);
}

export function ledgerIsEmpty(ledger: Ledger): boolean {
  return Object.keys(ledger).length === 0;
}

/** One line per subject — what a person reads before the JSON. */
function summarize(ledger: Ledger): string {
  return Object.entries(ledger)
    .map(([subject, claims]) => {
      const n = (s: string) => claims.filter((c) => c.status === s).length;
      const parts = [
        n("refuted") ? `${n("refuted")} REFUTED` : "",
        n("supported") ? `${n("supported")} supported` : "",
        n("unknown") ? `${n("unknown")} unknown` : "",
        n("stale") ? `${n("stale")} stale` : "",
      ].filter(Boolean);
      const waiting = claims.filter((c) => c.checks.some((k) => k.lastVerify && "planned" in k.lastVerify)).length;
      const asserted = claims.filter((c) => c.assertedOnly).length;
      return `${subject}: ${parts.join(", ")}${asserted ? ` (${asserted} asserted-only)` : ""}${waiting ? ` (${waiting} waiting on an external check)` : ""}`;
    })
    .join("; ");
}

/** The `[verify-notification]` message text. */
export function formatVerifyNotification(info: { workflow: string; runId: string; ledger: Ledger; costUsd?: number }): string {
  const cost = info.costUsd && info.costUsd > 0 ? ` Checks cost $${info.costUsd.toFixed(4)}.` : "";
  return [
    `${VERIFY_NOTIFICATION_PREFIX} Run ${info.runId} of "${info.workflow}" was verified against its claims — ${summarize(info.ledger)}.${cost}`,
    `claims: ${JSON.stringify(info.ledger)}`,
    `A refuted or unknown claim means the work is not done: fix it (or the check) and run again. A claim whose check is \`planned\` is waiting on someone — answer it with add_evidence only if you OBSERVED the answer with a tool, otherwise tell the user what to look at and where.`,
  ].join("\n");
}

/** The ledger lines appended to a `[run-notification]` whose pass already settled. */
export function formatLedgerLines(ledger: Ledger): string {
  return [`Verified against its claims — ${summarize(ledger)}.`, `claims: ${JSON.stringify(ledger)}`].join("\n");
}
