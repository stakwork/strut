/**
 * Writes over the claim graph (`plans/claims.md` §2) — the invariants, with
 * no opinion about WHO may write (publisher scoping and the grader deny-list
 * live one layer up, in `claims-authoring.ts`):
 *
 *   - a claim has at least one check, always: `addClaim` requires one, and
 *     retiring a claim's LAST active check is refused;
 *   - claims and checks are IMMUTABLE once written. An edit creates a
 *     successor that `SUPERSEDES` the node and closes the old one
 *     (`belief_valid_to` / `retired_at`). A superseded claim's evidence
 *     stays on the old node and the successor starts `unknown`; a retired
 *     check's evidence stays in the graph and never counts again;
 *   - a successor claim carries its `ABOUT` attachments AND its active
 *     checks across — each check gains a `TESTS` edge to the successor (an
 *     instrument is not a statement, so it is never cloned). A successor
 *     check takes over the `TESTS` edge(s) to the active claim;
 *   - nothing is ever deleted: retiring sets a timestamp, detaching mutes
 *     the `ABOUT` edge (jarvis's soft delete).
 *
 * Nodes go through the ordinary `NodeWriter` / `EdgeWriter`, which resolve
 * Claim / Check from the `:Schema` meta-graph. Node and edge writes are
 * separate transactions, ordered so that a crash between them leaves only
 * an unreachable node (no `ABOUT` / `TESTS` edge), never a half-visible one.
 *
 * Type-only imports: never loads neo4j-driver by itself.
 */
import type { GraphBackend } from "./backend.js";
import type { EdgeInput } from "./edge-writer.js";
import {
  CHECK_TYPE,
  CLAIM_EDGES,
  CLAIM_TYPE,
  ClaimsReader,
  newEpistemicId,
  subjectName,
  type CheckPolicy,
  type CheckRow,
  type ClaimRow,
  type RunWhen,
  type SubjectRef,
} from "./claims.js";

export type ClaimsErrorCode = "NOT_FOUND" | "INVALID" | "REFUSED";

/** A write the claim graph's rules do not allow. `message` is written for
 *  the tool result the model (or a person) reads. */
export class ClaimsError extends Error {
  constructor(
    readonly code: ClaimsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ClaimsError";
  }
}

/** A check as stored — every default already applied by the caller. */
export interface CheckData {
  name: string;
  description?: string;
  /** Absent = an external check. */
  step_type?: string;
  /** JSON. */
  step_config?: string;
  run_when: RunWhen;
  policy: CheckPolicy;
  freshness_days?: number;
  sample_rate?: number;
  publisher?: string;
}

const NAME_MAX = 200;
const nowSeconds = () => Math.trunc(Date.now() / 1000);

/** jarvis's required title: the sentence, bounded. */
export function boundedName(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > NAME_MAX ? `${t.slice(0, NAME_MAX - 1)}…` : t;
}

function checkNode(id: string, data: CheckData, at: number) {
  const out: Record<string, unknown> = { id, created_at: at };
  for (const [k, v] of Object.entries(data)) if (v !== undefined && v !== null && v !== "") out[k] = v;
  return { type: CHECK_TYPE, data: out };
}

const describeSubject = (s: SubjectRef) => `${s.kind} "${subjectName(s)}"`;

export class ClaimsWriter {
  readonly reader: ClaimsReader;

  constructor(
    private readonly graph: Pick<GraphBackend, "bolt" | "nodes" | "edges">,
    reader?: ClaimsReader,
  ) {
    this.reader = reader ?? new ClaimsReader(graph);
  }

  private async subjectRefs(subjects: readonly SubjectRef[]): Promise<string[]> {
    if (subjects.length === 0) throw new ClaimsError("INVALID", "a claim needs at least one subject");
    const refs: string[] = [];
    for (const s of subjects) {
      const ref = await this.reader.subjectRefId(s);
      if (!ref) {
        throw new ClaimsError(
          "NOT_FOUND",
          `${describeSubject(s)} is not in the workspace — only published workflows and custom steps can carry claims (built-in steps cannot)`,
        );
      }
      if (!refs.includes(ref)) refs.push(ref);
    }
    return refs;
  }

  private async activeClaim(id: string): Promise<ClaimRow> {
    const claim = await this.reader.getClaim(id);
    if (!claim) throw new ClaimsError("NOT_FOUND", `claim "${id}" not found`);
    if (claim.belief_valid_to !== undefined) {
      throw new ClaimsError("REFUSED", `claim "${id}" is retired or superseded — list_claims shows the active ones`);
    }
    return claim;
  }

  private async activeCheck(id: string): Promise<CheckRow> {
    const check = await this.reader.getCheck(id);
    if (!check) throw new ClaimsError("NOT_FOUND", `check "${id}" not found`);
    if (check.retired_at !== undefined) throw new ClaimsError("REFUSED", `check "${id}" is retired or superseded`);
    return check;
  }

  /** One `Claim`, `ABOUT` every subject, with one `Check —TESTS→` it per spec. */
  async addClaim(input: { subjects: readonly SubjectRef[]; text: string; speaker?: string; checks: readonly CheckData[] }): Promise<{ id: string; checks: string[] }> {
    const text = input.text.trim();
    if (!text) throw new ClaimsError("INVALID", "claim text is empty");
    if (input.checks.length === 0) {
      throw new ClaimsError("INVALID", "a claim needs at least one check — if code cannot check it, give it an external check whose description says what to look at and why");
    }
    const subjectRefs = await this.subjectRefs(input.subjects);
    const at = nowSeconds();
    const id = newEpistemicId();
    const checkIds = input.checks.map(() => newEpistemicId());
    const written = await this.graph.nodes.writeMany(
      [
        { type: CLAIM_TYPE, data: { id, name: boundedName(text), claim_text: text, belief_valid_from: at, ...(input.speaker ? { speaker_name: input.speaker } : {}) } },
        ...input.checks.map((c, i) => checkNode(checkIds[i]!, c, at)),
      ],
      "create",
    );
    const claimRef = written[0]!.ref_id;
    const edges: EdgeInput[] = [
      ...written.slice(1).map((k) => ({ edge: CLAIM_EDGES.TESTS, source_ref_id: k.ref_id, target_ref_id: claimRef })),
      // ABOUT last: it is what makes the claim visible at all.
      ...subjectRefs.map((s) => ({ edge: CLAIM_EDGES.ABOUT, source_ref_id: claimRef, target_ref_id: s })),
    ];
    await this.graph.edges.writeMany(edges);
    return { id, checks: checkIds };
  }

  /** Reword a claim: a successor that `SUPERSEDES` it. Returns the
   *  SUCCESSOR's id (the same id, `unchanged`, when the text is identical). */
  async editClaim(id: string, text: string, speaker?: string): Promise<{ id: string; superseded?: string; unchanged?: true }> {
    const old = await this.activeClaim(id);
    const next = text.trim();
    if (!next) throw new ClaimsError("INVALID", "claim text is empty");
    if (next === old.claim_text) return { id, unchanged: true };
    const [subjects, checks] = await Promise.all([this.reader.subjectsOf(id), this.reader.checksFor(id)]);
    const at = nowSeconds();
    const successor = newEpistemicId();
    const node = await this.graph.nodes.write(
      { type: CLAIM_TYPE, data: { id: successor, name: boundedName(next), claim_text: next, belief_valid_from: at, ...(speaker ? { speaker_name: speaker } : {}) } },
      "create",
    );
    await this.graph.edges.writeMany([
      { edge: CLAIM_EDGES.SUPERSEDES, source_ref_id: node.ref_id, target_ref_id: old.ref_id },
      ...checks.map((k) => ({ edge: CLAIM_EDGES.TESTS, source_ref_id: k.ref_id, target_ref_id: node.ref_id })),
      ...subjects.map((s) => ({ edge: CLAIM_EDGES.ABOUT, source_ref_id: node.ref_id, target_ref_id: s.ref_id })),
    ]);
    // Closed last: until then the old claim is still the active one.
    await this.graph.nodes.update(old.ref_id, { set: { belief_valid_to: at } });
    return { id: successor, superseded: id };
  }

  /** Retire a claim. Never deleted: its evidence and history stay. */
  async retireClaim(id: string): Promise<{ id: string }> {
    const claim = await this.activeClaim(id);
    await this.graph.nodes.update(claim.ref_id, { set: { belief_valid_to: nowSeconds() } });
    return { id };
  }

  /** Share a claim with another subject — never by copying the node. An
   *  existing edge is a no-op; a detached (muted) one is restored. */
  async attachClaim(id: string, subject: SubjectRef): Promise<{ id: string; attached: boolean }> {
    const claim = await this.activeClaim(id);
    const [subjectRef] = await this.subjectRefs([subject]);
    const written = await this.graph.edges.write({ edge: CLAIM_EDGES.ABOUT, source_ref_id: claim.ref_id, target_ref_id: subjectRef! });
    if (written.created) return { id, attached: true };
    const rows = await this.graph.bolt.run(`MATCH ()-[r {ref_id: $r}]->() RETURN coalesce(r.is_muted, false) AS muted`, { r: written.ref_id });
    if (rows[0]?.["muted"] !== true) return { id, attached: false };
    await this.graph.edges.update({ ref_id: written.ref_id }, { set: { is_muted: false } });
    return { id, attached: true };
  }

  /** Detach a claim from ONE subject. Its last subject cannot be detached —
   *  a claim about nothing is a retired claim; say so with `retireClaim`. */
  async detachClaim(id: string, subject: SubjectRef): Promise<{ id: string; detached: boolean }> {
    await this.activeClaim(id);
    const attached = await this.reader.subjectsOf(id);
    const hit = attached.find((a) => a.subject.kind === subject.kind && subjectName(a.subject) === subjectName(subject));
    if (!hit) return { id, detached: false };
    if (attached.length === 1) {
      throw new ClaimsError("REFUSED", `${describeSubject(subject)} is this claim's only subject — retire the claim instead of detaching it`);
    }
    await this.graph.edges.mute(hit.edge_ref_id);
    return { id, detached: true };
  }

  /** Add an instrument to an active claim. */
  async addCheck(claimId: string, data: CheckData): Promise<{ id: string }> {
    const claim = await this.activeClaim(claimId);
    const id = newEpistemicId();
    const node = await this.graph.nodes.write(checkNode(id, data, nowSeconds()), "create");
    await this.graph.edges.write({ edge: CLAIM_EDGES.TESTS, source_ref_id: node.ref_id, target_ref_id: claim.ref_id });
    return { id };
  }

  /** Replace a check: a successor that `SUPERSEDES` it and takes over its
   *  `TESTS` edge; the old node is retired. `data` is the FULL new check. */
  async editCheck(id: string, data: CheckData): Promise<{ id: string; superseded: string }> {
    const old = await this.activeCheck(id);
    const claims = await this.reader.claimsTestedBy(id);
    if (claims.length === 0) throw new ClaimsError("REFUSED", `check "${id}" tests no active claim — add a check to the claim you mean instead`);
    const at = nowSeconds();
    const successor = newEpistemicId();
    const node = await this.graph.nodes.write(checkNode(successor, data, at), "create");
    await this.graph.edges.writeMany([
      { edge: CLAIM_EDGES.SUPERSEDES, source_ref_id: node.ref_id, target_ref_id: old.ref_id },
      ...claims.map((c) => ({ edge: CLAIM_EDGES.TESTS, source_ref_id: node.ref_id, target_ref_id: c.ref_id })),
    ]);
    await this.graph.nodes.update(old.ref_id, { set: { retired_at: at } });
    return { id: successor, superseded: id };
  }

  /** Retire a check. Refused when it is a claim's LAST active check: add
   *  the replacement first, or retire the claim. */
  async retireCheck(id: string): Promise<{ id: string }> {
    const check = await this.activeCheck(id);
    for (const claim of await this.reader.claimsTestedBy(id)) {
      const others = (await this.reader.checksFor(claim.id)).filter((k) => k.id !== id);
      if (others.length === 0) {
        throw new ClaimsError("REFUSED", `check "${id}" is the last active check on claim "${claim.id}" — add its replacement first (add_check), or retire the claim`);
      }
    }
    await this.graph.nodes.update(check.ref_id, { set: { retired_at: nowSeconds() } });
    return { id };
  }
}
