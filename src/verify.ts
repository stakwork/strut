/**
 * The verify pass — how evidence is produced (`plans/claims.md` §4).
 *
 * A post-run consumer in the projector's mould: zero coupling to the hot
 * path, re-runnable, and idempotent by construction. It reads a finished
 * run's event log, rebuilds every SUBJECT the run observed (a step at a
 * path, one per loop iteration; a nested subflow as an execution of the
 * child workflow; the workflow itself), and for each active claim on that
 * subject runs each active check whose policy fires — writing one
 * `Evidence` per (check, run, path), or opening a planned slot for an
 * external check.
 *
 * What it will NOT do:
 *   - guess a version. Evidence is ABOUT the exact version observed
 *     (`run.start.stepHashes` / `workflowHash`, a subflow's recorded hash).
 *     No record → no evidence (`skipped: "unknown-version"`) — never "the
 *     active version", which would attribute old behaviour to new code;
 *   - read a broken check as a pass. A check that cannot run writes
 *     NOTHING and the claim stays `unknown` ("not evaluated, never fail");
 *   - verify its own runs. Checks run with `origin: "verify"`, and such runs
 *     are skipped by every trigger — a check workflow that has claims would
 *     otherwise verify its checks, whose checks verify theirs;
 *   - let a producer-visible check reach a grader: the deny-list is applied
 *     to the check CLOSURE again here, because a subflow child can be
 *     republished after the check was written;
 *   - overspend: a check presumed paid is skipped once a cap is hit, and any
 *     check that REPORTS cost is persisted under `check:<id>` and counted.
 */
import { createHash } from "node:crypto";
import { closureIncludes, flowClosure } from "./closure.js";
import type { RunEvent, StepRegistry } from "./core.js";
import { deniedInClosure, verifyDenyPatterns } from "./claims-authoring.js";
import type { GraphBackend } from "./graph/backend.js";
import {
  CLAIM_EDGES,
  ClaimsReader,
  DEFAULT_FRESHNESS_DAYS,
  EVIDENCE_TYPE,
  evidenceId,
  isExternalCheck,
  newEpistemicId,
  newestFirst,
  subjectName,
  type CheckResult,
  type CheckRow,
  type ClaimRow,
  type EvidenceMode,
  type EvidenceRow,
  type PublishCheckSubject,
  type RunCheckSubject,
  type SourceContext,
  type SubjectRef,
  type VersionRef,
} from "./graph/claims.js";
import { boundedName } from "./graph/claims-writer.js";
import type { EdgeInput } from "./graph/edge-writer.js";
import { buildLedger, type Ledger } from "./ledger.js";
import { projectRun } from "./graph/projector.js";
import { PREVIEW_MAX_CHARS } from "./graph/strut-schemas.js";
import { RUN_STEP_FLOW, persistRunUnder, runSingleStep, type RunStepResult } from "./run-step.js";
import { checkRunKey, stepTypeOfRunKey, type RunStore } from "./store.js";
import type { WorkspaceStore } from "./workspace.js";

// ── What a run observed ─────────────────────────────────────────────────────

/** One thing a run observed: a subject, the version that executed, and what
 *  a check will read. */
export interface ObservedSubject {
  subject: SubjectRef;
  /** Content hash of the executed version; absent = never recorded. */
  version?: string;
  /** Event path (`wf/clip`; `wf/each#2` for a foreach body's third iteration); the workflow's own path for a workflow. */
  path: string;
  /** When the behaviour happened (the `step.end` / `run.end` timestamp) —
   *  the Evidence's `observed_at`, so backfilling an old run never makes old
   *  evidence look new. */
  at: string;
  check: Omit<RunCheckSubject, "artifactsDir">;
}

const CONTAINER_STEPS = new Set(["subflow", "loop", "foreach"]);
const isToolEvent = (e: RunEvent) => typeof e.stepType === "string" && e.stepType.startsWith("tool:");

/**
 * Rebuild the subjects from a run's event log alone (run events carry full
 * values; previews are a projector concern). Pure.
 *
 *   - a step at path `p`: `step.start.input` (its RESOLVED CONFIG) + `step.end.output`;
 *   - a loop / foreach body: the same, once per iteration (the path carries it);
 *   - a `subflow` step: an execution of the CHILD workflow, at the nested path;
 *   - the workflow itself: `run.start` input + params, `run.end` output;
 *   - a step / run that errored: `{ input, error }`, no output — so "fails
 *     loudly on a private video" is checkable;
 *   - `step.replayed` (resume): nothing executed, no subject;
 *   - an agent's tool calls (`tool:*`): not subjects — their logged output is truncated.
 */
export function subjectsOfRun(key: string, events: readonly RunEvent[]): ObservedSubject[] {
  const out: ObservedSubject[] = [];
  const launch = events.find((e) => e.type === "run.start");
  if (!launch) return out;
  const runId = launch.runId;
  const cassette = launch.cassette;
  const base = { runId, ...(cassette ? { cassette } : {}) };
  let stepHashes: Record<string, string> = launch.stepHashes ?? {};
  // The hashes in force when each step STARTED (a resume reloads steps).
  const starts = new Map<string, { event: RunEvent; stepHashes: Record<string, string> }>();

  const stepSubject = (start: { event: RunEvent; stepHashes: Record<string, string> }, end: RunEvent): ObservedSubject | null => {
    const type = end.stepType;
    if (!type) return null;
    const result = end.type === "step.error" ? { error: end.error ?? { message: "unknown error" } } : { output: end.output };
    if (type === "subflow") {
      const child = start.event.subflow;
      if (!child) return null;
      return {
        subject: { kind: "workflow", name: child.workflow },
        ...(child.hash ? { version: child.hash } : {}),
        path: end.path,
        at: end.ts,
        check: { ...base, input: start.event.input, path: end.path, ...result },
      };
    }
    if (CONTAINER_STEPS.has(type)) return null;
    const version = start.stepHashes[type];
    return {
      subject: { kind: "step", type },
      ...(version ? { version } : {}),
      path: end.path,
      at: end.ts,
      check: { ...base, input: start.event.input, path: end.path, ...result },
    };
  };

  for (const e of events) {
    if (e.type === "run.resumed" && e.stepHashes) stepHashes = e.stepHashes;
    if (isToolEvent(e)) continue;
    if (e.type === "step.start") starts.set(e.path, { event: e, stepHashes });
    else if (e.type === "step.end" || e.type === "step.error") {
      const start = starts.get(e.path);
      if (!start) continue;
      // An error followed by a later success at the same path (a resumed run)
      // is superseded: keep one subject per path, the last outcome.
      const s = stepSubject(start, e);
      if (!s) continue;
      const prior = out.findIndex((o) => o.path === e.path && o.subject.kind === s.subject.kind && subjectName(o.subject) === subjectName(s.subject));
      if (prior >= 0) out.splice(prior, 1);
      out.push(s);
    }
  }

  // The workflow itself — not for a single-step / check bucket, whose "flow"
  // is the ad-hoc wrapper.
  if (!key.includes(":") && launch.path !== RUN_STEP_FLOW) {
    const end = [...events].reverse().find((e) => e.type === "run.end" || e.type === "run.error");
    if (end) {
      out.push({
        subject: { kind: "workflow", name: key },
        ...(launch.workflowHash ? { version: launch.workflowHash } : {}),
        path: launch.path,
        at: end.ts,
        check: {
          ...base,
          input: launch.input,
          ...(launch.params ? { params: launch.params } : {}),
          path: launch.path,
          ...(end.type === "run.error" ? { error: end.error ?? { message: "unknown error" } } : { output: end.output }),
        },
      });
    }
  }
  return out;
}

// ── The check contract ──────────────────────────────────────────────────────

export type MappedCheck =
  | { kind: "evidence"; supports: boolean; content: string; locator?: CheckResult["locator"] }
  | { kind: "cannot-run"; reason: string };

const tail = (s: string, n = PREVIEW_MAX_CHARS) => (s.length > n ? `…${s.slice(-(n - 1))}` : s);
const bound = (s: string, n = PREVIEW_MAX_CHARS) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function asCheckResult(v: unknown): CheckResult | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o["supports"] !== "boolean") return null;
  const content = typeof o["content"] === "string" ? o["content"] : o["content"] === undefined ? "" : JSON.stringify(o["content"]);
  const loc = o["locator"] && typeof o["locator"] === "object" ? (o["locator"] as CheckResult["locator"]) : undefined;
  return { supports: o["supports"], content, ...(loc ? { locator: loc } : {}) };
}

/**
 * What a finished check run says (plans/claims.md §4, "The check contract").
 * Pure.
 *
 *   - `{ supports, content, locator? }` — as the step's output, or under
 *     `object` (an `agent` with a schema), `json` (an `exec` with parseJson),
 *     or as JSON on an `exec`'s stdout;
 *   - a bare `exec` (or a workflow that ends in one): exit 0 → supports,
 *     non-zero → refutes, content = the output tail. 126 / 127 (not executable / command not found), a kill,
 *     or a timeout is the CHECK failing, not the subject;
 *   - anything else — the step threw, returned no verdict — cannot run:
 *     nothing is written, and the claim stays `unknown`.
 */
export function mapCheckResult(stepType: string, result: Pick<RunStepResult, "status" | "output" | "error">): MappedCheck {
  if (result.status !== "success") return { kind: "cannot-run", reason: bound(result.error?.message ?? `check run ${result.status}`, 300) };
  const out = result.output as Record<string, unknown> | null | undefined;
  const direct = asCheckResult(out) ?? asCheckResult(out?.["object"]) ?? asCheckResult(out?.["json"]);
  if (direct) return { kind: "evidence", ...direct, content: bound(direct.content) };
  // Shape, not type: a `subflow` check whose child ENDS in an exec hands back
  // that exec's result, and it reads the same way.
  const execShaped = !!out && typeof out === "object" && typeof out["stdout"] === "string" && "code" in out;
  if ((stepType === "exec" || execShaped) && out && typeof out === "object") {
    const stdout = typeof out["stdout"] === "string" ? (out["stdout"] as string) : "";
    const stderr = typeof out["stderr"] === "string" ? (out["stderr"] as string) : "";
    try {
      const parsed = asCheckResult(JSON.parse(stdout.trim()));
      if (parsed) return { kind: "evidence", ...parsed, content: bound(parsed.content) };
    } catch {
      // Not JSON: fall through to the exit code.
    }
    const code = out["code"];
    if (code === 0) return { kind: "evidence", supports: true, content: tail((stdout || stderr).trim()) || "exit 0" };
    if (code === 126 || code === 127) return { kind: "cannot-run", reason: bound(`exit ${code}: ${(stderr || stdout).trim()}`, 300) };
    if (typeof code === "number") return { kind: "evidence", supports: false, content: tail((stderr || stdout).trim()) || `exit ${code}` };
    return { kind: "cannot-run", reason: "the check process was killed" };
  }
  return { kind: "cannot-run", reason: "the check returned no { supports, content }" };
}

/** Cost a check run reported: `agent` / `llm`-style steps put `cost` in their
 *  OUTPUT (`RunEvent` has no cost field). Containers and tool calls are
 *  skipped — a subflow's output is its last step's, which would double count. */
export function reportedCost(events: readonly RunEvent[]): number {
  let total = 0;
  for (const e of events) {
    if (e.type !== "step.end" || isToolEvent(e) || CONTAINER_STEPS.has(e.stepType ?? "")) continue;
    const cost = (e.output as { cost?: unknown } | null | undefined)?.cost;
    if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) total += cost;
  }
  return total;
}

// ── Policy ──────────────────────────────────────────────────────────────────

/** Deterministic in (check, run, path), so re-verifying a run samples the
 *  same way — idempotence survives `sample`. */
export function sampleFires(checkId: string, runId: string, path: string, rate: number): boolean {
  const n = parseInt(createHash("sha256").update(`sample|${checkId}|${runId}|${path}`).digest("hex").slice(0, 8), 16);
  return n / 0xffffffff < rate;
}

export interface PolicyInput {
  check: Pick<CheckRow, "id" | "policy" | "freshness_days" | "sample_rate">;
  /** THIS check's collected evidence for (claim, subject), any version. */
  evidence: readonly EvidenceRow[];
  /** The version the run under verification executed. */
  version: string;
  /** What the check would run as now (`<type>@<hash>`). */
  checkVersion: string;
  runId: string;
  path: string;
  /** `verify_run` / `meta/verify-run`: fires `manual` checks too. */
  explicit: boolean;
  now: number;
}

/** Does a `run` check fire on this subject? (plans/claims.md §4.1). Each
 *  decision reads THAT check's evidence only. Pure. */
export function policyFires(p: PolicyInput): boolean {
  const policy = p.check.policy ?? "always";
  if (policy === "always") return true;
  if (policy === "manual") return p.explicit;
  if (policy === "sample") return sampleFires(p.check.id, p.runId, p.path, p.check.sample_rate ?? 0);
  // on_change — and any value we do not know reads as the careful one.
  const latest = [...p.evidence].sort(newestFirst)[0];
  if (!latest) return true;
  if (latest.about?.content_hash !== p.version) return true;
  if ((latest.source?.context?.checkVersion ?? p.checkVersion) !== p.checkVersion) return true;
  const days = p.check.freshness_days ?? DEFAULT_FRESHNESS_DAYS;
  return p.now / 1000 - (latest.observed_at ?? 0) > days * 86_400;
}

// ── Results ─────────────────────────────────────────────────────────────────

export type SkipReason = "policy" | "budget" | "cannot-launch" | "unknown-version" | "denied";
export type LastVerify = { pending: true } | { ran: true } | { skipped: SkipReason; reason?: string } | { planned: string };

export interface VerifiedCheck {
  subject: SubjectRef;
  path: string;
  claimId: string;
  checkId: string;
  lastVerify: LastVerify;
}

export interface VerifyResult {
  key: string;
  runId: string;
  /** The whole pass was a no-op, and why. */
  skipped?: "verify-origin" | "unknown-run" | "unfinished";
  /** Subjects the run observed that carry claims. */
  subjects: SubjectRef[];
  checks: VerifiedCheck[];
  /** Evidence nodes written / slots opened by THIS pass. */
  evidence: number;
  slots: number;
  /** What this pass's checks reported spending. */
  costUsd: number;
}

export interface AddEvidenceInput {
  claim: string;
  /** Run-store key: a workflow name, or `step:<type>`. */
  name: string;
  runId: string;
  supports: boolean;
  content: string;
  /** Needed only when the run executed several of the claim's subjects. */
  subject?: SubjectRef;
  /** Fill THIS planned slot (the panel passes it; otherwise an open slot
   *  for (claim, run) is found). */
  slot?: string;
  /** Who vouches: `ai`, `person`, a chat / session id. */
  by: string;
  /** `observed` only for an unstamped harness; everything a model or a
   *  person says is `asserted` (fixed point 3). */
  mode?: EvidenceMode;
}

export interface VerifierDeps {
  graph: GraphBackend;
  store: RunStore;
  workspace: WorkspaceStore;
  /** FRESH registry per pass: a step published this generation is visible to its checks. */
  getRegistry(): Promise<StepRegistry>;
  /** The services bag checks run with (a getter: createStrut builds it late). */
  services: () => unknown;
  env?: Record<string, string | undefined>;
  /** A DETACHED pass settled — always called, no-op passes included, so a
   *  listener waiting on that run can stop waiting. */
  onSettled?: (result: VerifyResult) => void;
}

const DEFAULT_BUDGET_USD = 1;
const DEFAULT_BUDGET_USD_PER_DAY = 5;
const AI_STAMP = "ai";
const PAID_STEP_TYPES = ["agent", "llm"];

const money = (raw: string | undefined, fallback: number) => {
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const sameSubject = (a: SubjectRef, b: SubjectRef) => a.kind === b.kind && subjectName(a) === subjectName(b);
const subjectKey = (s: SubjectRef) => `${s.kind}:${subjectName(s)}`;

export type Verifier = ReturnType<typeof createVerifier>;

export function createVerifier(deps: VerifierDeps) {
  const { graph, store, workspace } = deps;
  const reader = new ClaimsReader(graph);
  const env = () => deps.env ?? process.env;
  const inflight = new Map<string, { explicit: boolean; promise: Promise<VerifyResult> }>();

  /** What the check would execute as right now: `exec`, `clip/judge@<hash>`,
   *  `fuzzy-match@<hash>` — recorded on the Evidence, and what `on_change`
   *  compares to notice a republished instrument under a frozen Check node. */
  async function resolveCheckVersion(check: CheckRow, config: Record<string, unknown>, stepHashes: Record<string, string>): Promise<string> {
    const type = check.step_type!;
    if (type === "subflow" && typeof config["workflow"] === "string") {
      const v = typeof config["version"] === "string" ? (config["version"] as string) : undefined;
      const hash = await workspace.getWorkflowHash(config["workflow"] as string, v).catch(() => null);
      return `${config["workflow"]}@${hash ?? v ?? "unknown"}`;
    }
    return stepHashes[type] ? `${type}@${stepHashes[type]}` : type;
  }

  /** One pass's shared state. */
  function newPass(key: string, runId: string, explicit: boolean) {
    return {
      key,
      runId,
      explicit,
      result: { key, runId, subjects: [], checks: [], evidence: 0, slots: 0, costUsd: 0 } as VerifyResult,
      claims: new Map<string, ClaimRow[]>(),
      checks: new Map<string, CheckRow[]>(),
      evidence: new Map<string, EvidenceRow[]>(),
      spentToday: new Map<string, number>(),
      runRef: undefined as string | null | undefined,
      activeStepHashes: undefined as Record<string, string> | undefined,
      registry: undefined as StepRegistry | undefined,
    };
  }
  type Pass = ReturnType<typeof newPass>;

  const claimsOf = async (pass: Pass, s: SubjectRef) => {
    const k = subjectKey(s);
    if (!pass.claims.has(k)) pass.claims.set(k, await reader.claimsFor(s));
    return pass.claims.get(k)!;
  };
  const checksOf = async (pass: Pass, claimId: string) => {
    if (!pass.checks.has(claimId)) pass.checks.set(claimId, await reader.checksFor(claimId));
    return pass.checks.get(claimId)!;
  };
  const evidenceOf = async (pass: Pass, claimId: string, s: SubjectRef, fresh = false) => {
    const k = `${claimId}|${subjectKey(s)}`;
    if (fresh || !pass.evidence.has(k)) pass.evidence.set(k, await reader.evidenceFor(claimId, s));
    return pass.evidence.get(k)!;
  };

  /** A subject's verify spend so far today, from the store alone: today's
   *  runs in the buckets of the checks on its claims, tagged with it. */
  async function spentToday(pass: Pass, s: SubjectRef): Promise<number> {
    const k = subjectKey(s);
    if (pass.spentToday.has(k)) return pass.spentToday.get(k)!;
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    let total = 0;
    for (const claim of await claimsOf(pass, s)) {
      for (const check of await reader.checksFor(claim.id, { includeRetired: true })) {
        const bucket = checkRunKey(check.id);
        for (const id of await store.listRuns(bucket)) {
          if (Number(id) < midnight.getTime()) break; // newest first
          const events = await store.getRunEvents(bucket, id);
          if (events.find((e) => e.type === "run.start")?.verify?.subject === k) total += reportedCost(events);
        }
      }
    }
    pass.spentToday.set(k, total);
    return total;
  }

  /** The `StrutRun` evidence points at — projected on first need, so a run
   *  that produced no evidence never reaches the graph. */
  async function runRefOf(pass: Pass): Promise<string | null> {
    if (pass.runRef === undefined) pass.runRef = await projectRun(graph, store, pass.key, pass.runId);
    return pass.runRef;
  }

  async function writeEvidence(input: {
    id: string;
    claim: ClaimRow;
    check?: CheckRow;
    version: VersionRef;
    sourceRef: string;
    node: Record<string, unknown>;
    strength?: number;
    context: SourceContext;
    locator?: CheckResult["locator"];
  }): Promise<"written" | "unknown-version"> {
    const versionRef = await reader.versionRefId(input.version);
    if (!versionRef) return "unknown-version";
    const node = await graph.nodes.write({ type: EVIDENCE_TYPE, data: { id: input.id, name: boundedName(input.claim.claim_text), ...input.node } }, "create");
    const loc = input.locator ?? {};
    const context: SourceContext = { ...input.context, ...(typeof loc.path === "string" ? { file: loc.path } : {}) };
    const edges: EdgeInput[] = [
      { edge: CLAIM_EDGES.ABOUT, source_ref_id: node.ref_id, target_ref_id: versionRef },
      ...(input.check ? [{ edge: CLAIM_EDGES.PRODUCED_BY, source_ref_id: node.ref_id, target_ref_id: input.check.ref_id }] : []),
      {
        edge: CLAIM_EDGES.HAS_SOURCE,
        source_ref_id: node.ref_id,
        target_ref_id: input.sourceRef,
        properties: {
          context: JSON.stringify(context),
          ...(typeof loc.start_time === "number" ? { start_time: loc.start_time } : {}),
          ...(typeof loc.end_time === "number" ? { end_time: loc.end_time } : {}),
          ...(typeof loc.url === "string" ? { post_url: loc.url } : {}),
        },
      },
      // Last: this is the edge that makes the evidence count.
      { edge: CLAIM_EDGES.EVIDENCED_BY, source_ref_id: input.claim.ref_id, target_ref_id: node.ref_id, ...(input.strength !== undefined ? { properties: { strength: input.strength } } : {}) },
    ];
    await graph.edges.writeMany(edges);
    return "written";
  }

  /** Run one step check over a subject. Decides deny / budget, runs it in
   *  memory, keeps the run only if it reported cost. */
  async function runCheck(
    pass: Pass,
    check: CheckRow,
    subject: SubjectRef,
    input: RunCheckSubject | PublishCheckSubject,
  ): Promise<{ skipped: SkipReason; reason?: string } | { mapped: MappedCheck; mode: EvidenceMode; checkVersion: string; model?: string; checkRun?: string }> {
    let config: Record<string, unknown>;
    try {
      config = check.step_config ? (JSON.parse(check.step_config) as Record<string, unknown>) : {};
    } catch {
      return { skipped: "cannot-launch", reason: "step_config is not JSON" };
    }
    pass.registry ??= await deps.getRegistry();
    const type = check.step_type!;
    if (!pass.registry[type]) return { skipped: "cannot-launch", reason: `step type "${type}" is not in the registry` };

    const closure = await flowClosure({ steps: [{ id: "check", type, config }] }, workspace);
    if (check.publisher === AI_STAMP) {
      if (!closure.resolvable) return { skipped: "denied", reason: "the check's closure cannot be resolved" };
      const grader = deniedInClosure(closure, verifyDenyPatterns(env()), Object.keys(pass.registry));
      if (grader) return { skipped: "denied", reason: `reaches a harness-only step (${grader})` };
    }
    const paidInClosure = !closure.resolvable || PAID_STEP_TYPES.some((t) => closureIncludes(closure, t));
    if (paidInClosure) {
      const perRun = money(env()["STRUT_VERIFY_BUDGET_USD"], DEFAULT_BUDGET_USD);
      const perDay = money(env()["STRUT_VERIFY_BUDGET_USD_PER_DAY"], DEFAULT_BUDGET_USD_PER_DAY);
      if (pass.result.costUsd >= perRun) return { skipped: "budget", reason: `this run's verify budget ($${perRun}) is spent` };
      if ((await spentToday(pass, subject)) >= perDay) return { skipped: "budget", reason: `today's verify budget for this subject ($${perDay}) is spent` };
    }

    pass.activeStepHashes ??= await workspace.getActiveStepHashes().catch(() => ({}));
    const checkVersion = await resolveCheckVersion(check, config, pass.activeStepHashes);
    const run = await runSingleStep(type, pass.registry, deps.services(), {
      // A failed assertion is a result, not a crash: let `exec` return its exit code.
      config: type === "exec" && config["allowFailure"] === undefined ? { ...config, allowFailure: true } : config,
      input,
      workspace,
      origin: "verify",
      verify: { checkId: check.id, subject: subjectKey(subject), sourceRunId: pass.runId },
      ...(pass.activeStepHashes[type] ? { stepHashes: { [type]: pass.activeStepHashes[type]! } } : {}),
    });
    const cost = reportedCost(run.events);
    let checkRun: string | undefined;
    if (cost > 0) {
      // On record exactly like any agent step — and counted against the caps,
      // which is how a presumed-free check that turns out to cost money is caught.
      await persistRunUnder(store, checkRunKey(check.id), run);
      checkRun = run.runId;
      pass.result.costUsd += cost;
      pass.spentToday.set(subjectKey(subject), (pass.spentToday.get(subjectKey(subject)) ?? 0) + cost);
    }
    const model = typeof config["model"] === "string" && !config["model"].includes("{{") ? (config["model"] as string) : undefined;
    return {
      mapped: mapCheckResult(type, run),
      // A judgment is not an observation: anything with a model in its closure is asserted.
      mode: paidInClosure ? "asserted" : "observed",
      checkVersion,
      ...(model ? { model } : {}),
      ...(checkRun ? { checkRun } : {}),
    };
  }

  /** Open (or keep) the ONE planned slot an external check may have per subject. */
  async function openSlot(pass: Pass, o: ObservedSubject, claim: ClaimRow, check: CheckRow, id: string, mine: readonly EvidenceRow[]): Promise<LastVerify> {
    const runRef = await runRefOf(pass);
    if (!runRef) return { skipped: "cannot-launch", reason: "the run could not be projected" };
    const version: VersionRef = { kind: o.subject.kind, name: subjectName(o.subject), content_hash: o.version! };
    const preview = o.check.error ? `error: ${o.check.error.message}` : bound(typeof o.check.output === "string" ? o.check.output : (JSON.stringify(o.check.output) ?? ""), 300);
    const written = await writeEvidence({
      id,
      claim,
      check,
      version,
      sourceRef: runRef,
      node: {
        evidence_status: "planned",
        description: bound(`${check.description ?? check.name}\n\nLook at: run ${pass.runId} of ${pass.key}, ${o.path}. It produced: ${preview}`),
      },
      context: { path: o.path, ...(o.check.cassette ? { cassette: o.check.cassette } : {}) },
    });
    if (written !== "written") return { skipped: "unknown-version" };
    // A slot about an older run is a question whose answer would be born
    // stale: mute it (the node holds no observation) — one open slot per check.
    for (const old of mine.filter((e) => e.evidence_status === "planned" && e.id !== id)) {
      if (old.edge_ref_id) await graph.edges.mute(old.edge_ref_id);
    }
    pass.result.slots++;
    return { planned: id };
  }

  async function verifyOne(pass: Pass, o: ObservedSubject, claim: ClaimRow, check: CheckRow, artifactsDir: string | undefined): Promise<LastVerify> {
    if (!o.version) return { skipped: "unknown-version" };
    const id = evidenceId(check.id, pass.runId, o.path);
    const all = await evidenceOf(pass, claim.id, o.subject);
    const mine = all.filter((e) => e.check_id === check.id);
    const existing = mine.find((e) => e.id === id);
    if (existing) return existing.evidence_status === "planned" ? { planned: id } : { ran: true };

    const config = (() => {
      try {
        return check.step_config ? (JSON.parse(check.step_config) as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    })();
    pass.activeStepHashes ??= await workspace.getActiveStepHashes().catch(() => ({}));
    const fires = policyFires({
      check,
      evidence: mine.filter((e) => e.evidence_status === "collected"),
      version: o.version,
      checkVersion: isExternalCheck(check) ? "external" : await resolveCheckVersion(check, config, pass.activeStepHashes),
      runId: pass.runId,
      path: o.path,
      explicit: pass.explicit,
      now: Date.now(),
    });
    if (!fires) return { skipped: "policy" };
    if (isExternalCheck(check)) {
      const slot = await openSlot(pass, o, claim, check, id, mine);
      await evidenceOf(pass, claim.id, o.subject, true);
      return slot;
    }

    const ran = await runCheck(pass, check, o.subject, { ...o.check, ...(artifactsDir ? { artifactsDir } : {}) });
    if ("skipped" in ran) return ran;
    if (ran.mapped.kind === "cannot-run") return { skipped: "cannot-launch", reason: ran.mapped.reason };
    const runRef = await runRefOf(pass);
    if (!runRef) return { skipped: "cannot-launch", reason: "the run could not be projected" };
    const written = await writeEvidence({
      id,
      claim,
      check,
      version: { kind: o.subject.kind, name: subjectName(o.subject), content_hash: o.version },
      sourceRef: runRef,
      node: { content: ran.mapped.content, evidence_mode: ran.mode, evidence_status: "collected", observed_at: o.at },
      strength: ran.mapped.supports ? 1 : -1,
      context: {
        path: o.path,
        ...(o.check.cassette ? { cassette: o.check.cassette } : {}),
        checkVersion: ran.checkVersion,
        ...(ran.model ? { model: ran.model } : {}),
        ...(ran.checkRun ? { checkRun: ran.checkRun } : {}),
      },
      locator: ran.mapped.locator,
    });
    if (written !== "written") return { skipped: "unknown-version" };
    pass.result.evidence++;
    await evidenceOf(pass, claim.id, o.subject, true);
    return { ran: true };
  }

  async function runPass(key: string, runId: string, explicit: boolean): Promise<VerifyResult> {
    const pass = newPass(key, runId, explicit);
    const events = await store.getRunEvents(key, runId);
    const launch = events.find((e) => e.type === "run.start");
    if (!launch) return { ...pass.result, skipped: "unknown-run" };
    if (launch.origin === "verify" || key.startsWith("check:")) return { ...pass.result, skipped: "verify-origin" };
    if (!events.some((e) => e.type === "run.end" || e.type === "run.error" || e.type === "run.cancelled")) return { ...pass.result, skipped: "unfinished" };

    let artifactsDir: string | undefined;
    const artifacts = (deps.services() as { artifacts?: { dir(runId: string): Promise<string> } } | undefined)?.artifacts;
    for (const o of subjectsOfRun(key, events)) {
      const claims = await claimsOf(pass, o.subject);
      if (claims.length === 0) continue;
      if (!pass.result.subjects.some((s) => sameSubject(s, o.subject))) pass.result.subjects.push(o.subject);
      if (artifacts && artifactsDir === undefined) artifactsDir = await artifacts.dir(runId).catch(() => undefined);
      for (const claim of claims) {
        for (const check of await checksOf(pass, claim.id)) {
          if ((check.run_when ?? "run") !== "run") continue;
          let lastVerify: LastVerify;
          try {
            lastVerify = await verifyOne(pass, o, claim, check, artifactsDir);
          } catch (err) {
            // One broken check must not cost the others their evidence.
            lastVerify = { skipped: "cannot-launch", reason: bound(err instanceof Error ? err.message : String(err), 300) };
          }
          pass.result.checks.push({ subject: o.subject, path: o.path, claimId: claim.id, checkId: check.id, lastVerify });
        }
      }
    }
    return pass.result;
  }

  /**
   * Verify one finished run. Idempotent per (check, run, path): `Evidence.id`
   * is deterministic and written in `create` mode, so a second pass writes
   * nothing and only runs checks that have no Evidence for that (run, path)
   * yet — exactly what "re-verify after adding a check" needs. Two passes on
   * one run are single-flighted: the second awaits the first.
   */
  async function verifyRun(key: string, runId: string, opts: { explicit?: boolean } = {}): Promise<VerifyResult> {
    const explicit = opts.explicit === true;
    const running = inflight.get(runId);
    if (running) {
      const first = await running.promise;
      // `manual` checks fire only for an explicit caller — go again for them.
      if (!explicit || running.explicit) return first;
    }
    const promise = runPass(key, runId, explicit).finally(() => {
      if (inflight.get(runId)?.promise === promise) inflight.delete(runId);
    });
    inflight.set(runId, { explicit, promise });
    return promise;
  }

  /** The trigger: a DETACHED pass — `run_workflow` / `run_step` return
   *  exactly when they did before and never wait for it. */
  function schedule(key: string, runId: string): void {
    setImmediate(() => {
      verifyRun(key, runId)
        .catch((err): VerifyResult => {
          console.error(`[verify] pass over ${key}/${runId} failed:`, err);
          return { key, runId, skipped: "unknown-run", subjects: [], checks: [], evidence: 0, slots: 0, costUsd: 0 };
        })
        .then((r) => deps.onSettled?.(r));
    });
  }

  /**
   * `run_when: publish` checks, over the new version's source. There is no
   * run: the Evidence is ABOUT the new version and its source IS that
   * version node. (Lints: "no step reads process.env directly".)
   */
  async function verifyPublish(subject: SubjectRef): Promise<VerifyResult> {
    const hash = await reader.activeVersion(subject);
    const name = subjectName(subject);
    const pass = newPass(`publish:${name}`, `publish:${hash ?? "none"}`, true);
    const claims = await claimsOf(pass, subject);
    if (!hash || claims.length === 0) return pass.result;
    const version: VersionRef = { kind: subject.kind, name, content_hash: hash };
    const versionRef = await reader.versionRefId(version);
    let input: PublishCheckSubject | null = null;
    for (const claim of claims) {
      for (const check of await checksOf(pass, claim.id)) {
        if (check.run_when !== "publish" || isExternalCheck(check)) continue;
        if (!pass.result.subjects.length) pass.result.subjects.push(subject);
        const id = evidenceId(check.id, pass.runId, "publish");
        let lastVerify: LastVerify;
        try {
          if ((await evidenceOf(pass, claim.id, subject)).some((e) => e.id === id)) lastVerify = { ran: true };
          else if (!versionRef) lastVerify = { skipped: "unknown-version" };
          else {
            input ??= subject.kind === "step"
              ? { source: (await workspace.getStepSource(subject.type))?.code ?? "" }
              : { yaml: await workspace.getWorkflowSource(name, (await workspace.getWorkflowMetadata(name))?.active ?? "") };
            const ran = await runCheck(pass, check, subject, input);
            if ("skipped" in ran) lastVerify = ran;
            else if (ran.mapped.kind === "cannot-run") lastVerify = { skipped: "cannot-launch", reason: ran.mapped.reason };
            else {
              await writeEvidence({
                id,
                claim,
                check,
                version,
                sourceRef: versionRef,
                node: { content: ran.mapped.content, evidence_mode: ran.mode, evidence_status: "collected", observed_at: new Date().toISOString() },
                strength: ran.mapped.supports ? 1 : -1,
                context: { path: "publish", checkVersion: ran.checkVersion, ...(ran.model ? { model: ran.model } : {}), ...(ran.checkRun ? { checkRun: ran.checkRun } : {}) },
                locator: ran.mapped.locator,
              });
              pass.result.evidence++;
              lastVerify = { ran: true };
            }
          }
        } catch (err) {
          lastVerify = { skipped: "cannot-launch", reason: bound(err instanceof Error ? err.message : String(err), 300) };
        }
        pass.result.checks.push({ subject, path: "publish", claimId: claim.id, checkId: check.id, lastVerify });
      }
    }
    return pass.result;
  }

  /**
   * Someone's own observation (`add_evidence`): `asserted`, sourced to the
   * run, with NO `PRODUCED_BY` — no check produced it. When an open slot
   * exists for (claim, run) — or `slot` names one — it FILLS that slot
   * instead of writing a second node: the same node becomes `collected`,
   * its edge gets a strength, and `by` is recorded on the source.
   */
  async function addEvidence(input: AddEvidenceInput): Promise<{ ok: true; evidence: string; filled: boolean; subject: SubjectRef } | { error: string }> {
    const content = input.content?.trim();
    if (!content) return { error: "content is empty — say WHAT you observed, and with which tool" };
    const claim = await reader.getClaim(input.claim);
    if (!claim) return { error: `claim "${input.claim}" not found` };
    if (claim.belief_valid_to !== undefined) return { error: `claim "${input.claim}" is retired or superseded — list_claims shows the active ones` };
    const events = await store.getRunEvents(input.name, input.runId);
    if (events.length === 0) return { error: `run ${input.runId} of "${input.name}" not found` };
    if (events.find((e) => e.type === "run.start")?.origin === "verify") return { error: "that is a check run — cite the run it verified" };

    const about = (await reader.subjectsOf(claim.id)).map((s) => s.subject);
    const observed = subjectsOfRun(input.name, events).filter(
      (o) => o.version && about.some((s) => sameSubject(s, o.subject)) && (!input.subject || sameSubject(input.subject, o.subject)),
    );
    const distinct = [...new Map(observed.map((o) => [subjectKey(o.subject), o])).values()];
    if (distinct.length === 0) {
      return { error: `run ${input.runId} did not execute a subject of this claim with a recorded version (${about.map(subjectKey).join(", ") || "no subjects"}) — evidence must be about a version that actually ran` };
    }
    if (distinct.length > 1) return { error: `that run executed several of this claim's subjects (${distinct.map((o) => subjectKey(o.subject)).join(", ")}) — pass \`subject\`` };
    const o = distinct[0]!;
    const mode: EvidenceMode = input.mode ?? "asserted";
    const strength = input.supports ? 1 : -1;
    const now = new Date().toISOString();

    const evidence = await reader.evidenceFor(claim.id, o.subject);
    const slot = input.slot
      ? evidence.find((e) => e.id === input.slot)
      : evidence.find((e) => e.evidence_status === "planned" && e.source?.run_id === input.runId);
    if (input.slot && (!slot || slot.evidence_status !== "planned")) return { error: `"${input.slot}" is not an open slot on this claim` };
    if (slot) {
      await graph.nodes.update(slot.ref_id, { set: { content: bound(content), evidence_status: "collected", evidence_mode: mode, observed_at: now } });
      await graph.edges.update({ ref_id: slot.edge_ref_id! }, { set: { strength } });
      if (slot.source) {
        await graph.edges.update(
          { edge: CLAIM_EDGES.HAS_SOURCE, source_ref_id: slot.ref_id, target_ref_id: slot.source.ref_id },
          { set: { context: JSON.stringify({ ...(slot.source.context ?? {}), by: input.by }) } },
        );
      }
      return { ok: true, evidence: slot.id, filled: true, subject: o.subject };
    }

    const runRef = await projectRun(graph, store, input.name, input.runId);
    if (!runRef) return { error: `run ${input.runId} could not be projected into the graph` };
    const id = newEpistemicId();
    const written = await writeEvidence({
      id,
      claim,
      version: { kind: o.subject.kind, name: subjectName(o.subject), content_hash: o.version! },
      sourceRef: runRef,
      node: { content: bound(content), evidence_mode: mode, evidence_status: "collected", observed_at: now },
      strength,
      context: { path: o.path, by: input.by, ...(o.check.cassette ? { cassette: o.check.cassette } : {}) },
    });
    if (written !== "written") return { error: `the version that run executed (${o.version}) is not in the graph` };
    return { ok: true, evidence: id, filled: false, subject: o.subject };
  }

  /**
   * What keeping this subject's claims true has cost, all time — from the
   * run store alone: every persisted (paid) check run in the buckets of the
   * checks on its claims, retired ones included, tagged with this subject.
   * Cost is a constraint, not telemetry (EVOLVE_SPEC §7): the builder, a
   * person and the evolve loop all read the same number.
   */
  async function costOf(subject: SubjectRef): Promise<number> {
    const k = subjectKey(subject);
    let total = 0;
    for (const claim of await reader.claimsFor(subject, { includeRetired: true })) {
      for (const check of await reader.checksFor(claim.id, { includeRetired: true })) {
        const bucket = checkRunKey(check.id);
        for (const id of await store.listRuns(bucket)) {
          const events = await store.getRunEvents(bucket, id);
          if (events.find((e) => e.type === "run.start")?.verify?.subject === k) total += reportedCost(events);
        }
      }
    }
    return total;
  }

  /** The ledger a settled pass produced: computed statuses + per-check lastVerify. */
  const ledger = (result: VerifyResult): Promise<Ledger> => buildLedger(reader, result.subjects, { result });
  /** The contract of what a launch can execute, every runnable check `pending`. */
  const pendingLedger = (subjects: readonly SubjectRef[]): Promise<Ledger> => buildLedger(reader, subjects, { pending: true });

  return { reader, verifyRun, verifyPublish, addEvidence, schedule, ledger, pendingLedger, costOf };
}

/** `step:<type>` for a step subject's kept runs; the workflow name otherwise. */
export function runKeySubject(key: string): SubjectRef {
  const type = stepTypeOfRunKey(key);
  return type ? { kind: "step", type } : { kind: "workflow", name: key };
}
