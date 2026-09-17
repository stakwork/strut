/**
 * The truth layer's node contract and its read side (`plans/claims.md`).
 *
 * Three jarvis node types — a `Claim` is the statement, a `Check` is an
 * instrument that can test it, `Evidence` is what one test observed — and
 * the edges between them:
 *
 *   Claim    —ABOUT→        StrutStep | StrutWorkflow       (stable identity)
 *   Check    —TESTS→        Claim
 *   Claim    —EVIDENCED_BY {strength ±1}→ Evidence
 *   Evidence —PRODUCED_BY→  Check                            (absent: no check produced it)
 *   Evidence —ABOUT→        StrutStepVersion | StrutWorkflowVersion
 *   Evidence —HAS_SOURCE {context, …}→ StrutRun
 *
 * None of the three is a Strut type: their schemas live in the database
 * (jarvis migrations 119/120/124/125, or the bundled ontology fixture) and
 * writes go through the ordinary `NodeWriter` / `EdgeWriter`, which resolve
 * them with `SchemaResolver`. This module owns what is strut's: the ids,
 * the shapes a check reads and returns, the status rule, and the reads.
 *
 * Status is COMPUTED ON READ, per (claim, subject) — `claimStatus` is one
 * pure function and no verdict is ever stored on a node. Every read here
 * skips muted edges: a muted slot is neither evidence nor an open slot.
 *
 * Type-only imports: this module never loads neo4j-driver, so `createStrut`
 * can import it on a filesystem workspace.
 */
import { createHash, randomUUID } from "node:crypto";
import type { CassetteMode } from "../cassette.js";
import type { GraphBackend } from "./backend.js";

// ── Vocabulary ──────────────────────────────────────────────────────────────

export const CLAIM_TYPE = "Claim";
export const CHECK_TYPE = "Check";
export const EVIDENCE_TYPE = "Evidence";

export const CLAIM_EDGES = {
  ABOUT: "ABOUT",
  TESTS: "TESTS",
  EVIDENCED_BY: "EVIDENCED_BY",
  PRODUCED_BY: "PRODUCED_BY",
  HAS_SOURCE: "HAS_SOURCE",
  SUPERSEDES: "SUPERSEDES",
} as const;

/** When a check fires: on an execution of the subject, or when a new
 *  version of it is published (Hive's `evaluates` split). */
export type RunWhen = "run" | "publish";
/** How often a `run` check fires (plans/claims.md §4.1). */
export type CheckPolicy = "always" | "on_change" | "sample" | "manual";
export type EvidenceMode = "observed" | "asserted";
export type EvidenceStatus = "planned" | "collected";

export const DEFAULT_FRESHNESS_DAYS = 7;

// ── Ids ─────────────────────────────────────────────────────────────────────

const EPISTEMIC_ID = /^[a-z0-9]+$/;

let lastIdMs = 0;
let lastIdSeq = 0;

/**
 * Identity for a `Claim` / `Check` — never derived from the text. Lowercase
 * alphanumerics ONLY: `node_key` is `claim-<id>` after jarvis's sanitizer
 * lowercases and drops every non-alphanumeric, so `aB-1` and `ab1` would
 * collide on one node.
 *
 * Time-sortable (ULID-style): 9 base36 chars of epoch ms, 3 of a per-process
 * sequence within that ms, 20 random — so ordering by id is ordering by
 * creation, and a contract lists in the order it was written even when its
 * claims share one `belief_valid_from` second.
 */
export function newEpistemicId(): string {
  const ms = Math.max(Date.now(), lastIdMs); // never backwards, even if the clock is
  lastIdSeq = ms === lastIdMs ? lastIdSeq + 1 : 0;
  lastIdMs = ms;
  const random = randomUUID().replace(/-/g, "").slice(0, 20);
  return `${ms.toString(36).padStart(9, "0")}${lastIdSeq.toString(36).padStart(3, "0")}${random}`;
}

export function isEpistemicId(id: unknown): id is string {
  return typeof id === "string" && EPISTEMIC_ID.test(id);
}

/**
 * `Evidence.id` for what ONE check observed at ONE path of ONE run. With
 * the node writer's `create` mode (a no-op on an existing node) this is
 * what makes a second verify pass over the same run write nothing. Planned
 * slots use the same scheme.
 */
export function evidenceId(checkId: string, runId: string, path: string): string {
  return createHash("sha256").update(`${checkId}|${runId}|${path}`, "utf8").digest("hex").slice(0, 32);
}

// ── Subjects ────────────────────────────────────────────────────────────────

/** What a claim is about: the STABLE identity, never a version. */
export type SubjectRef = { kind: "workflow"; name: string } | { kind: "step"; type: string };

/** The exact version an observation was made on (`Evidence —ABOUT→`). */
export interface VersionRef {
  kind: SubjectRef["kind"];
  /** Workflow name or step type. */
  name: string;
  content_hash: string;
}

export function subjectName(subject: SubjectRef): string {
  return subject.kind === "workflow" ? subject.name : subject.type;
}

function isVersionOf(version: VersionRef | undefined, subject: SubjectRef): boolean {
  return !!version && version.kind === subject.kind && version.name === subjectName(subject);
}

const SUBJECT_NODE = {
  workflow: { label: "StrutWorkflow", version: "StrutWorkflowVersion", key: "name" },
  step: { label: "StrutStep", version: "StrutStepVersion", key: "step_type" },
} as const;

// ── The check contract ──────────────────────────────────────────────────────

/**
 * What a `run` check reads: the subject IS the check step's run input, so a
 * check's config templates say `{{ input.output.quote }}` — no new template
 * root. `input` is the step's RESOLVED CONFIG (what the runner records on
 * `step.start`), or params + run input for a workflow. A step that errored
 * has `error` and no `output`, so "fails loudly on a private video" is
 * checkable.
 */
export interface RunCheckSubject {
  input: unknown;
  output?: unknown;
  error?: { message: string; stack?: string };
  runId: string;
  /** Event path of the observed step (`wf/compute_times`, with the
   *  iteration for a loop body); the workflow's own path for a workflow. */
  path: string;
  artifactsDir?: string;
  cassette?: CassetteMode;
}

/** What a `publish` check reads: the new version's source. */
export type PublishCheckSubject = { source: string } | { yaml: string };

/**
 * What a check step returns. A check never throws on a failed assertion —
 * it returns `supports: false`. (A bare `exec` with no JSON on stdout maps
 * from its exit code instead; a check that cannot run yields NO evidence.)
 */
export interface CheckResult {
  supports: boolean;
  /** What was observed — one bounded string. */
  content: string;
  locator?: { path?: string; start_time?: number; end_time?: number; url?: string };
}

/** `HAS_SOURCE.context` is ONE `?string` in jarvis's schema; strut writes
 *  this object into it as JSON. */
export interface SourceContext {
  /** The observed step's event path. */
  path?: string;
  cassette?: CassetteMode;
  /** The code that actually ran under the check (a custom step's version;
   *  for `subflow`, the child's name and resolved version). */
  checkVersion?: string;
  /** Names the model on a judged (`asserted`) result. */
  model?: string;
  /** Who filled a slot or vouched: `person`, `ai`, a chat/session id. */
  by?: string;
  [key: string]: unknown;
}

// ── Rows ────────────────────────────────────────────────────────────────────
// Attribute names as stored (datetimes are epoch SECONDS, like every
// jarvis `datetime`).

export interface ClaimRow {
  ref_id: string;
  id: string;
  /** The sentence, bounded (jarvis's required title). */
  name: string;
  claim_text: string;
  /** Who asserts it — strut's `publisher` stamp (`ai`, a person, a seeder). */
  speaker_name?: string;
  belief_valid_from?: number;
  /** Set = retired or superseded. ACTIVE = unset. */
  belief_valid_to?: number;
}

export interface CheckRow {
  ref_id: string;
  id: string;
  name: string;
  /** Required on an external check: what to look at, and why code cannot. */
  description?: string;
  /** A registry step type. ABSENT = an external check. */
  step_type?: string;
  /** JSON config for that step. */
  step_config?: string;
  run_when?: RunWhen | string;
  policy?: CheckPolicy | string;
  freshness_days?: number;
  sample_rate?: number;
  publisher?: string;
  created_at: number;
  /** Set = retired or superseded. ACTIVE = unset. */
  retired_at?: number;
}

export function isExternalCheck(check: Pick<CheckRow, "step_type">): boolean {
  return !check.step_type;
}

/** One `Evidence` node with what its edges say about it. */
export interface EvidenceRow {
  ref_id: string;
  id: string;
  name: string;
  description?: string;
  content?: string;
  evidence_mode?: EvidenceMode | string;
  evidence_status?: EvidenceStatus | string;
  observed_at?: number;
  /** Epoch MILLISECONDS (jarvis's node stamp) — the ordering fallback for
   *  evidence an outside system wrote without `observed_at`. */
  date_added_to_graph?: number;
  /** The claim whose `EVIDENCED_BY` edge reached this node. */
  claim_id: string;
  /** `EVIDENCED_BY.strength`: > 0 supports, < 0 refutes; absent on a slot. */
  strength?: number;
  /** `PRODUCED_BY` target; absent when no check produced it. */
  check_id?: string;
  /** `ABOUT` target, when it is a strut version node. */
  about?: VersionRef;
  /** `HAS_SOURCE` target + edge properties. */
  source?: {
    ref_id: string;
    node_type?: string;
    run_id?: string;
    context?: SourceContext;
    start_time?: number;
    end_time?: number;
    post_url?: string;
  };
}

// ── Status ──────────────────────────────────────────────────────────────────

export type ClaimStatusValue = "supported" | "refuted" | "stale" | "unknown";

export interface ClaimStatus {
  status: ClaimStatusValue;
  /** The verdict rests on no `observed` evidence — only a model's or a
   *  person's word. False while `unknown`. */
  assertedOnly: boolean;
  /** Active checks with no counted evidence ABOUT the active version. */
  unverified: number;
  /** A planned slot is waiting on someone for this (claim, subject). */
  openSlot: boolean;
  slots: Array<{ evidence_id: string; check_id?: string }>;
  /** The newest evidence carrying the verdict (any counted evidence when
   *  `stale`); absent while `unknown`. */
  latest?: EvidenceRow;
}

export interface ClaimStatusInput {
  claim: Pick<ClaimRow, "id">;
  /** Checks that TEST this claim; retired ones are ignored. */
  checks: ReadonlyArray<Pick<CheckRow, "id" | "retired_at">>;
  subject: SubjectRef;
  evidence: readonly EvidenceRow[];
  /** Content hash of the subject's active version, or null when it has none. */
  activeVersion: string | null;
}

const NO_CHECK = "";

function orderKey(e: EvidenceRow): number {
  if (typeof e.observed_at === "number") return e.observed_at * 1000;
  return typeof e.date_added_to_graph === "number" ? e.date_added_to_graph : 0;
}

/** Newest first; id as the deterministic tie-break. */
function newestFirst(a: EvidenceRow, b: EvidenceRow): number {
  return orderKey(b) - orderKey(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The status rule (plans/claims.md, "Status is computed on read").
 *
 * Streams: one per ACTIVE check, plus one for evidence no check produced.
 * Counted evidence is `collected`, carries a non-zero strength, hangs off
 * THIS claim node (a superseded claim's evidence stays on the old node),
 * is ABOUT a version of THIS subject, and was not produced by a retired
 * check — a changed instrument has measured nothing yet. A `planned` slot
 * is a question, never evidence.
 *
 * A stream's latest MEASUREMENT is its newest counted evidence together
 * with everything else that stream observed in the same source run: a
 * `foreach` body yields one Evidence per iteration, and the last iteration
 * passing must not paper over an earlier one failing.
 *
 *   any latest is ABOUT the active version and refutes    → refuted
 *   else any latest is ABOUT the active version, supports → supported
 *   else any latest exists (all about older versions)     → stale
 *   else                                                  → unknown
 *
 * A refutation on the current version always wins, so a second check can
 * never paper over a failing one.
 */
export function claimStatus(input: ClaimStatusInput): ClaimStatus {
  const { claim, subject, activeVersion } = input;
  const active = new Set(input.checks.filter((k) => k.retired_at === undefined || k.retired_at === null).map((k) => k.id));
  const mine = input.evidence.filter(
    (e) => e.claim_id === claim.id && isVersionOf(e.about, subject) && (e.check_id === undefined || active.has(e.check_id)),
  );

  const slots = mine
    .filter((e) => e.evidence_status === "planned")
    .sort(newestFirst)
    .map((e) => ({ evidence_id: e.id, ...(e.check_id ? { check_id: e.check_id } : {}) }));
  const counted = mine.filter((e) => e.evidence_status === "collected" && typeof e.strength === "number" && e.strength !== 0);

  const streams = new Map<string, EvidenceRow[]>();
  for (const e of counted) {
    const k = e.check_id ?? NO_CHECK;
    streams.set(k, [...(streams.get(k) ?? []), e]);
  }
  const latest: EvidenceRow[] = [];
  for (const stream of streams.values()) {
    stream.sort(newestFirst);
    const run = stream[0]!.source?.run_id;
    latest.push(...(run ? stream.filter((e) => e.source?.run_id === run) : [stream[0]!]));
  }

  const onActive = (e: EvidenceRow) => activeVersion !== null && e.about?.content_hash === activeVersion;
  const current = latest.filter(onActive);
  const refuting = current.filter((e) => e.strength! < 0);
  const supporting = current.filter((e) => e.strength! > 0);
  const status: ClaimStatusValue = refuting.length ? "refuted" : supporting.length ? "supported" : latest.length ? "stale" : "unknown";
  const deciding = (status === "refuted" ? refuting : status === "supported" ? supporting : latest).sort(newestFirst);

  const verifiedChecks = new Set(counted.filter(onActive).map((e) => e.check_id));
  return {
    status,
    assertedOnly: deciding.length > 0 && !deciding.some((e) => e.evidence_mode === "observed"),
    unverified: [...active].filter((id) => !verifiedChecks.has(id)).length,
    openSlot: slots.length > 0,
    slots,
    ...(deciding[0] ? { latest: deciding[0] } : {}),
  };
}

// ── Reads ───────────────────────────────────────────────────────────────────

const LIVE = (r: string) => `(${r}.is_muted IS NULL OR ${r}.is_muted = false)`;
const NOT_DELETED = (n: string) => `(${n}.is_deleted IS NULL OR ${n}.is_deleted = false)`;

const CLAIM_FIELDS = ["ref_id", "id", "name", "claim_text", "speaker_name", "belief_valid_from", "belief_valid_to"] as const;
const CHECK_FIELDS = [
  "ref_id", "id", "name", "description", "step_type", "step_config", "run_when", "policy", "freshness_days",
  "sample_rate", "publisher", "created_at", "retired_at",
] as const;
const EVIDENCE_FIELDS = [
  "ref_id", "id", "name", "description", "content", "evidence_mode", "evidence_status", "observed_at", "date_added_to_graph",
] as const;

/** `n {.a, .b}` — never `properties(n)`: nodes carry `Data_Bank` and a
 *  384-float embedding. */
const project = (v: string, fields: readonly string[]) => `${v} {${fields.map((f) => `.${f}`).join(", ")}}`;

function compact<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (v !== null && v !== undefined) out[k] = v;
  return out as T;
}

function parseContext(raw: unknown): SourceContext | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as SourceContext;
  } catch {
    // An outside system's free-text context.
  }
  return { path: raw };
}

export interface SubjectLedgerRow {
  claim: ClaimRow;
  checks: CheckRow[];
  status: ClaimStatus;
}

/**
 * Reads over the claim graph, scoped to the backend's namespace. Exists
 * only on a graph-backed workspace — see `claimsReaderFor`.
 */
export class ClaimsReader {
  constructor(private readonly graph: Pick<GraphBackend, "bolt">) {}

  private get ns(): string {
    return this.graph.bolt.namespace;
  }

  /** Content hash of the subject's active version; null when the subject
   *  does not exist or has none. */
  async activeVersion(subject: SubjectRef): Promise<string | null> {
    const n = SUBJECT_NODE[subject.kind];
    const rows = await this.graph.bolt.run(
      `MATCH (s:\`${n.label}\` {namespace: $ns, \`${n.key}\`: $name}) WHERE ${NOT_DELETED("s")}
       RETURN s.active_version AS v LIMIT 1`,
      { ns: this.ns, name: subjectName(subject) },
    );
    const v = rows[0]?.["v"];
    return typeof v === "string" && v ? v : null;
  }

  /** `ref_id` of a subject's STABLE node, or null when the workspace has no
   *  such step / workflow (built-in steps have no node). */
  async subjectRefId(subject: SubjectRef): Promise<string | null> {
    const n = SUBJECT_NODE[subject.kind];
    const rows = await this.graph.bolt.run(
      `MATCH (s:\`${n.label}\` {namespace: $ns, \`${n.key}\`: $name}) WHERE ${NOT_DELETED("s")} RETURN s.ref_id AS r LIMIT 1`,
      { ns: this.ns, name: subjectName(subject) },
    );
    return typeof rows[0]?.["r"] === "string" ? (rows[0]!["r"] as string) : null;
  }

  /** One claim by id (active or not), or null. */
  async getClaim(id: string): Promise<ClaimRow | null> {
    const rows = await this.graph.bolt.run(
      `MATCH (c:\`${CLAIM_TYPE}\` {namespace: $ns, id: $id}) WHERE ${NOT_DELETED("c")} RETURN ${project("c", CLAIM_FIELDS)} AS claim LIMIT 1`,
      { ns: this.ns, id },
    );
    return rows.length ? compact<ClaimRow>(rows[0]!["claim"] as Record<string, unknown>) : null;
  }

  /** One check by id (active or not), or null. */
  async getCheck(id: string): Promise<CheckRow | null> {
    const rows = await this.graph.bolt.run(
      `MATCH (k:\`${CHECK_TYPE}\` {namespace: $ns, id: $id}) WHERE ${NOT_DELETED("k")} RETURN ${project("k", CHECK_FIELDS)} AS chk LIMIT 1`,
      { ns: this.ns, id },
    );
    return rows.length ? compact<CheckRow>(rows[0]!["chk"] as Record<string, unknown>) : null;
  }

  /** The subjects a claim is attached to (live `ABOUT` edges), with the
   *  edge's ref_id — what `detach` mutes. */
  async subjectsOf(claimId: string): Promise<Array<{ subject: SubjectRef; ref_id: string; edge_ref_id: string }>> {
    const rows = await this.graph.bolt.run(
      `MATCH (c:\`${CLAIM_TYPE}\` {namespace: $ns, id: $id})-[a:\`${CLAIM_EDGES.ABOUT}\`]->(s)
       WHERE ${LIVE("a")} AND ${NOT_DELETED("s")} AND (s:StrutStep OR s:StrutWorkflow)
       RETURN s:StrutStep AS is_step, s.step_type AS step_type, s.name AS name, s.ref_id AS ref_id, a.ref_id AS edge_ref_id
       ORDER BY is_step, name, step_type`,
      { ns: this.ns, id: claimId },
    );
    return rows.map((r) => ({
      subject: r["is_step"] === true ? { kind: "step" as const, type: String(r["step_type"]) } : { kind: "workflow" as const, name: String(r["name"]) },
      ref_id: String(r["ref_id"]),
      edge_ref_id: String(r["edge_ref_id"]),
    }));
  }

  /** The ACTIVE claims a check `TESTS` — exactly one, by the writer's
   *  invariant; more only transiently. */
  async claimsTestedBy(checkId: string): Promise<ClaimRow[]> {
    const rows = await this.graph.bolt.run(
      `MATCH (k:\`${CHECK_TYPE}\` {namespace: $ns, id: $id})-[t:\`${CLAIM_EDGES.TESTS}\`]->(c:\`${CLAIM_TYPE}\`)
       WHERE ${LIVE("t")} AND ${NOT_DELETED("c")} AND c.belief_valid_to IS NULL
       RETURN ${project("c", CLAIM_FIELDS)} AS claim ORDER BY c.belief_valid_from, c.id`,
      { ns: this.ns, id: checkId },
    );
    return rows.map((r) => compact<ClaimRow>(r["claim"] as Record<string, unknown>));
  }

  /** Claims `ABOUT` a subject — active ones unless `includeRetired`. */
  async claimsFor(subject: SubjectRef, opts: { includeRetired?: boolean } = {}): Promise<ClaimRow[]> {
    const n = SUBJECT_NODE[subject.kind];
    const rows = await this.graph.bolt.run(
      `MATCH (c:\`${CLAIM_TYPE}\` {namespace: $ns})-[a:\`${CLAIM_EDGES.ABOUT}\`]->(s:\`${n.label}\` {namespace: $ns, \`${n.key}\`: $name})
       WHERE ${LIVE("a")} AND ${NOT_DELETED("c")} AND ${NOT_DELETED("s")}
         AND ($retired OR c.belief_valid_to IS NULL)
       RETURN ${project("c", CLAIM_FIELDS)} AS claim
       ORDER BY c.belief_valid_from, c.id`,
      { ns: this.ns, name: subjectName(subject), retired: opts.includeRetired === true },
    );
    return rows.map((r) => compact<ClaimRow>(r["claim"] as Record<string, unknown>));
  }

  /** Checks that `TEST` a claim — active ones unless `includeRetired`. */
  async checksFor(claimId: string, opts: { includeRetired?: boolean } = {}): Promise<CheckRow[]> {
    const rows = await this.graph.bolt.run(
      `MATCH (k:\`${CHECK_TYPE}\`)-[t:\`${CLAIM_EDGES.TESTS}\`]->(c:\`${CLAIM_TYPE}\` {namespace: $ns, id: $id})
       WHERE ${LIVE("t")} AND ${NOT_DELETED("k")} AND ($retired OR k.retired_at IS NULL)
       RETURN ${project("k", CHECK_FIELDS)} AS chk
       ORDER BY k.created_at, k.id`,
      { ns: this.ns, id: claimId, retired: opts.includeRetired === true },
    );
    return rows.map((r) => compact<CheckRow>(r["chk"] as Record<string, unknown>));
  }

  /**
   * Every `Evidence` a claim's live `EVIDENCED_BY` edges reach — planned
   * slots included — with its check, the version it is about, and its
   * source. Pass `subject` to keep only evidence about that subject's
   * versions. Newest first.
   */
  async evidenceFor(claimId: string, subject?: SubjectRef): Promise<EvidenceRow[]> {
    const rows = await this.graph.bolt.run(
      `MATCH (c:\`${CLAIM_TYPE}\` {namespace: $ns, id: $id})-[eb:\`${CLAIM_EDGES.EVIDENCED_BY}\`]->(e:\`${EVIDENCE_TYPE}\`)
       WHERE ${LIVE("eb")} AND ${NOT_DELETED("e")}
       OPTIONAL MATCH (e)-[pb:\`${CLAIM_EDGES.PRODUCED_BY}\`]->(k:\`${CHECK_TYPE}\`) WHERE ${LIVE("pb")}
       OPTIONAL MATCH (e)-[ab:\`${CLAIM_EDGES.ABOUT}\`]->(v) WHERE ${LIVE("ab")} AND (v:StrutStepVersion OR v:StrutWorkflowVersion)
       OPTIONAL MATCH (e)-[hs:\`${CLAIM_EDGES.HAS_SOURCE}\`]->(src) WHERE ${LIVE("hs")}
       RETURN ${project("e", EVIDENCE_FIELDS)} AS ev, eb.strength AS strength, k.id AS check_id,
              v:StrutStepVersion AS v_is_step, v.name AS v_name, v.step_type AS v_step_type, v.content_hash AS v_hash,
              src.ref_id AS src_ref, labels(src) AS src_labels, src.run_id AS src_run_id,
              hs.context AS hs_context, hs.start_time AS hs_start, hs.end_time AS hs_end, hs.post_url AS hs_url`,
      { ns: this.ns, id: claimId },
    );
    const byId = new Map<string, EvidenceRow>();
    for (const r of rows) {
      const e = compact<Omit<EvidenceRow, "claim_id">>(r["ev"] as Record<string, unknown>);
      const row: EvidenceRow = byId.get(e.id) ?? { ...e, claim_id: claimId };
      if (row.strength === undefined && typeof r["strength"] === "number") row.strength = r["strength"] as number;
      if (row.check_id === undefined && typeof r["check_id"] === "string") row.check_id = r["check_id"] as string;
      if (!row.about && typeof r["v_hash"] === "string") {
        const isStep = r["v_is_step"] === true;
        row.about = { kind: isStep ? "step" : "workflow", name: String(isStep ? r["v_step_type"] : r["v_name"]), content_hash: r["v_hash"] as string };
      }
      if (!row.source && typeof r["src_ref"] === "string") {
        const labels = (r["src_labels"] as string[] | null) ?? [];
        row.source = compact({
          ref_id: r["src_ref"],
          node_type: labels.find((l) => !/^(Node|Data_Bank|Domain_.*)$/.test(l)),
          run_id: r["src_run_id"],
          context: parseContext(r["hs_context"]),
          start_time: r["hs_start"],
          end_time: r["hs_end"],
          post_url: r["hs_url"],
        });
      }
      byId.set(e.id, row);
    }
    const out = [...byId.values()].sort(newestFirst);
    return subject ? out.filter((e) => isVersionOf(e.about, subject)) : out;
  }

  /** Every active claim on a subject with its active checks and computed
   *  status — the rows the ledger is built from. */
  async statusFor(subject: SubjectRef): Promise<SubjectLedgerRow[]> {
    const [claims, activeVersion] = await Promise.all([this.claimsFor(subject), this.activeVersion(subject)]);
    return Promise.all(
      claims.map(async (claim) => {
        const [checks, evidence] = await Promise.all([this.checksFor(claim.id), this.evidenceFor(claim.id, subject)]);
        return { claim, checks, status: claimStatus({ claim, checks, subject, evidence, activeVersion }) };
      }),
    );
  }
}

/**
 * The gate (plans/claims.md, Design): claims hang off the subjects' graph
 * nodes (`StrutStep` / `StrutWorkflow`), so the layer exists only when the
 * WORKSPACE keeps them in a graph. On a filesystem or in-memory workspace
 * this is null — no claim tool is offered and the verify pass is a no-op.
 */
export function claimsReaderFor(workspace: { graph?: GraphBackend }): ClaimsReader | null {
  return workspace.graph ? new ClaimsReader(workspace.graph) : null;
}
