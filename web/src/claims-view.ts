// The words for a job's ledger (plans/job-claims.md §6) — pure, so the Claims
// section in the job timeline and the panel say the same thing, and a test
// pins it: what each check did on the latest pass, the one line a Verify
// leaves behind, and where a verdict's locator leads.
import { artifactKind, isArtifactPath } from "./artifact-view";
import type { JobRunView, JobVerifyResult, LastVerify, LedgerClaim } from "./api";

export type OutcomeTone = "ok" | "warn" | "bad" | "muted";

/** One check's outcome on the latest pass, as a short label. */
export function lastVerifyLabel(v: LastVerify): { text: string; tone: OutcomeTone; title?: string } {
  if ("ran" in v) return { text: "ran", tone: "ok", title: "Ran on the latest pass and wrote its evidence." };
  if ("pending" in v) return { text: "pending", tone: "muted", title: "A pass is on its way." };
  if ("planned" in v) return { text: "waiting on a person", tone: "warn", title: "An external check: someone answers it with Supports or Refutes." };
  const reason = v.reason ? `: ${v.reason}` : "";
  switch (v.skipped) {
    case "superseded":
      return { text: "superseded", tone: "muted", title: "That pass was for a turn that is no longer the newest — nothing about a job is backfilled." };
    case "cannot-launch":
      return { text: "couldn't run", tone: "bad", title: `The check itself failed, so nothing was written${reason}` };
    case "budget":
      return { text: "over budget", tone: "warn", title: `Skipped: the verify budget is spent${reason}` };
    case "denied":
      return { text: "denied", tone: "bad", title: `Refused${reason}` };
    case "policy":
      return { text: "not due", tone: "muted", title: `Its policy did not fire on this pass${reason}` };
    case "unknown-version":
      return { text: "no version", tone: "muted", title: `The turn has no recorded version${reason}` };
  }
}

/** Each check's `lastVerify` by check id, from a ledger. */
export function checkOutcomes(claims: readonly LedgerClaim[] | undefined): Record<string, LastVerify> {
  const out: Record<string, LastVerify> = {};
  for (const c of claims ?? []) for (const k of c.checks) if (k.lastVerify) out[k.id] = k.lastVerify;
  return out;
}

/** The outcome to show beside a check: a `planned` one only while its slot
 *  is still open — once someone answered it, it is no longer waiting. */
export function shownOutcome(v: LastVerify | undefined, slotOpen: boolean): LastVerify | undefined {
  return v && "planned" in v && !slotOpen ? undefined : v;
}

/** The one line a Verify leaves: which turn, and what the checks did. */
export function verifySummary(r: Pick<JobVerifyResult, "runId" | "skipped" | "checks" | "costUsd">): string {
  if (r.skipped === "unknown-run" || !r.runId) return "Nothing to verify: the job has no turn yet.";
  if (r.skipped) return `Not verified (${r.skipped}).`;
  const turn = `turn ${r.runId}`;
  if (r.checks.length === 0) return `Verified ${turn}: no claim has a check to run.`;
  const counts = new Map<string, number>();
  for (const c of r.checks) {
    const text = lastVerifyLabel(c.lastVerify).text;
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  const parts = [...counts].map(([text, n]) => `${n} ${text}`);
  const cost = r.costUsd > 0 ? ` · $${r.costUsd.toFixed(4)}` : "";
  return `Verified ${turn}: ${parts.join(", ")}${cost}.`;
}

/** Where a verdict's locator leads. A served file (a job's screenshot) opens
 *  in place — a job's `file` alone is under its files route; an http(s) url
 *  (an endpoint) is a link; anything else is nothing. */
export type LocatorTarget = { kind: "file"; path: string; image: boolean } | { kind: "url"; url: string };

export function locatorTarget(locator: { url?: string; file?: string } | undefined, job?: string): LocatorTarget | null {
  const url = locator?.url;
  const file = (path: string): LocatorTarget => ({ kind: "file", path, image: artifactKind(path) === "image" });
  if (url && isArtifactPath(url)) return file(url);
  if (url && /^https?:\/\//i.test(url)) return { kind: "url", url };
  const rel = locator?.file;
  if (job && rel && !rel.startsWith("/") && !rel.split("/").includes("..")) {
    return file(`/jobs/${encodeURIComponent(job)}/files/${rel.split("/").map(encodeURIComponent).join("/")}`);
  }
  return null;
}

/** The job's newest turn: its newest top-level run (`runs` is newest first;
 *  a run with a parent is one a turn launched, not a turn). */
export function newestTurn(runs: readonly Pick<JobRunView, "runId" | "parentRunId">[]): string | undefined {
  return runs.find((r) => !r.parentRunId)?.runId;
}

/** Changes whenever the ledger would read differently — what makes the
 *  panel re-read after a turn, a verify, or someone else's answer. */
export function ledgerSignature(claims: readonly LedgerClaim[] | undefined): string {
  return (claims ?? []).map((c) => `${c.id}:${c.status}:${c.latest?.about ?? ""}:${c.latest?.observed_at ?? ""}:${c.checks.length}`).join("|");
}
