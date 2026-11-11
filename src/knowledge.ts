/**
 * The KNOWLEDGE door: what a workflow that tends the Concept tree works
 * through (the `dream` first, `src/workflows/system/dream/`). Keeping the
 * claims about Concepts is AI-driven, and it is never part of ordinary work:
 * the builder's tools, the meta surface and the job, builder and
 * orchestrator seeds hold none of this (`ClaimActor.concepts`,
 * claims-authoring.ts). The `knowledge/*` steps are thin over it, and the
 * ones that write are sealed, so the meta surface can neither run them nor
 * publish a workflow that reaches them.
 *
 *   - `page`: one Concept as a TENDER reads it — its docs, the pages under
 *     it, the claims on it with what the evidence says. Not an observation:
 *     no version is recorded, so tending a page is never checked against
 *     the claims about it (`graph/graph-get` is how work OPENS a page);
 *   - `claims`: every Concept carrying claims, with them — what a keeper
 *     scans for the rules that do not hold, without opening every page;
 *   - `opened`: which pages a run opened, read off its log — what tells
 *     "the page was never opened" from "it was opened and not followed";
 *   - `addClaim`: one sentence a Concept's readers must hold to, written
 *     directly, with the STANDARD check: the `concept-check` workflow, a
 *     model with no tools judging the run against the sentence. A tender
 *     never writes a check's config: what it reads (conversations) is
 *     untrusted text, and a check is something strut runs;
 *   - `addEvidence`: what a person SAID about a run's work, as their word
 *     against (or for) a claim — only about a run that opened the page.
 *
 * Changing a Concept is not here: a tender proposes it with the ordinary
 * graph steps under its workflow's `approve:`, and a person decides.
 */
import { toSubjectRef, type ClaimActor, type ClaimListing, type ClaimsAuthoring } from "./claims-authoring.js";
import type { GraphBackend } from "./graph/backend.js";
import type { RunStore } from "./store.js";
import { conceptsOpenedIn, type Verifier } from "./verify.js";

/** The workflow every claim written here is checked by. */
export const CONCEPT_CHECK_WORKFLOW = "concept-check";

/** The most of a page's docs a tender is shown (`context/concept`'s cap). */
export const KNOWLEDGE_DOCS_MAX = 6000;

/** The most claims one run may add: each is a paid check on every later
 *  version of its page. A runaway tender stops here. */
export const KNOWLEDGE_CLAIMS_PER_RUN = 10;

const CONCEPT = "Concept";
const PARENT_OF = "PARENT_OF";

/** The door's author: an AI, at a door that keeps the Concept tree. */
const TENDER: ClaimActor = { publisher: "ai", scoped: false, concepts: true };

export interface KnowledgeClaim {
  id: string;
  text: string;
  status: ClaimListing["status"];
  /** Who wrote it (`ai`, `person`, a name). */
  speaker?: string;
  /** The newest evidence carrying the verdict: what was observed or said. */
  latest?: { content?: string; mode?: string; by?: string };
}

export interface KnowledgePage {
  ref_id: string;
  name: string;
  description?: string;
  /** The page's text, cut at `KNOWLEDGE_DOCS_MAX`. */
  docs: string;
  docs_truncated?: true;
  /** The pages that list it, by name. None: a root. */
  parents: string[];
  /** The pages under it: what an agent that read this page is shown to
   *  choose from, before it opens one. */
  children: Array<{ name: string; description?: string; has_claims?: true }>;
  claims: KnowledgeClaim[];
}

/** A Concept that carries claims, with them (`claims`). */
export interface KnowledgeClaimed {
  concept: string;
  ref_id: string;
  claims: KnowledgeClaim[];
}

export interface KnowledgeCapability {
  /** One Concept, by its exact name; null when there is none. */
  page(name: string): Promise<KnowledgePage | null>;
  /** Every Concept of the tree's namespace that carries claims, by name. */
  claims(): Promise<KnowledgeClaimed[]>;
  /** The Concepts a run opened, by name; null when its log does not say. */
  opened(workflow: string, runId: string): Promise<string[] | null>;
  addClaim(input: { concept: string; text: string }, by?: { runId?: string }): Promise<{ ok: true; id: string; existing?: true } | { error: string }>;
  addEvidence(input: { claim: string; workflow: string; runId: string; supports: boolean; said: string; by?: string }): Promise<{ ok: true; evidence: string; concept: string } | { error: string }>;
}

export interface KnowledgeDeps {
  graph: Pick<GraphBackend, "query" | "namespace" | "dialect">;
  claims: ClaimsAuthoring;
  verifier: Pick<Verifier, "addEvidence">;
  store: Pick<RunStore, "getRunEvents">;
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** How many Concepts `claims` reads at once. */
const CLAIMS_AT_ONCE = 8;

/** A claim as a tender (and a keeper) reads it. */
function claimOf(c: ClaimListing): KnowledgeClaim {
  const l = c.latest;
  return {
    id: c.id,
    text: c.text,
    status: c.status,
    ...(c.speaker ? { speaker: c.speaker } : {}),
    ...(l ? { latest: { ...(l.content ? { content: l.content } : {}), ...(l.mode ? { mode: l.mode } : {}), ...(l.by ? { by: l.by } : {}) } } : {}),
  };
}

/** The standard check: the run that opened the page, handed to the judge. */
export function conceptCheckSpec(claim: string) {
  return {
    type: "subflow",
    name: "judge",
    config: {
      workflow: CONCEPT_CHECK_WORKFLOW,
      input: {
        claim,
        concept: "{{ input.concept }}",
        request: "{{ input.input }}",
        output: "{{ input.output }}",
        error: "{{ input.error }}",
        concepts: "{{ input.concepts }}",
      },
    },
  };
}

/** A page as a section of a prompt. */
export function renderKnowledgePage(p: KnowledgePage): string {
  return [
    `CONCEPT "${p.name}" (ref_id ${p.ref_id})${p.parents.length ? ` — under ${p.parents.map((n) => `"${n}"`).join(", ")}` : " — a root"}`,
    `description: ${p.description ?? "(none)"}`,
    "docs:",
    ...(p.docs || "(empty)").split("\n").map((l) => `  | ${l}`),
    ...(p.docs_truncated ? ["  | […cut]"] : []),
    p.children.length ? "pages under it:" : "pages under it: none",
    ...p.children.map((c) => `  - ${c.name}${c.description ? ` — ${c.description}` : ""}${c.has_claims ? " [has claims]" : ""}`),
    p.claims.length ? "claims on it:" : "claims on it: none",
    ...p.claims.map((c) => `  - ${c.id} [${c.status}] "${c.text}"${c.latest?.content ? ` — latest: ${c.latest.content}` : ""}`),
  ].join("\n");
}

export function createKnowledge(deps: KnowledgeDeps): KnowledgeCapability {
  const { graph, claims } = deps;
  const added = new Map<string, number>();

  return {
    async page(name) {
      const d = graph.dialect;
      const [node] = await graph.query(
        `MATCH ${d.node("p", CONCEPT, { namespace: "$ns", name: "$name" })} WHERE ${d.live("p")}
         RETURN p.ref_id AS ref_id, p.name AS name, p.description AS description, p.docs AS docs LIMIT 1`,
        { ns: graph.namespace, name },
      );
      if (!node || typeof node["ref_id"] !== "string") return null;
      const ref = node["ref_id"];
      const [children, parents, claimed, listed] = await Promise.all([
        graph.query(
          `MATCH ${d.node("p", CONCEPT, { ref_id: "$ref" })}-[r:\`${PARENT_OF}\`]->${d.node("c", CONCEPT)}
           WHERE ${d.edgeLive("r")} AND ${d.live("c")} RETURN c.name AS name, c.description AS description`,
          { ref },
        ),
        graph.query(
          `MATCH ${d.node("q", CONCEPT)}-[r:\`${PARENT_OF}\`]->${d.node("p", CONCEPT, { ref_id: "$ref" })}
           WHERE ${d.edgeLive("r")} AND ${d.live("q")} RETURN q.name AS name`,
          { ref },
        ),
        claims.reader.claimedSubjects("concept"),
        claims.listClaims({ kind: "concept", name }),
      ]);
      const has = new Set(claimed);
      const docs = text(node["docs"]) ?? "";
      const description = text(node["description"]);
      return {
        ref_id: ref,
        name: String(node["name"]),
        ...(description ? { description } : {}),
        docs: docs.length > KNOWLEDGE_DOCS_MAX ? docs.slice(0, KNOWLEDGE_DOCS_MAX) : docs,
        ...(docs.length > KNOWLEDGE_DOCS_MAX ? { docs_truncated: true as const } : {}),
        parents: parents.map((r) => String(r["name"])).sort(),
        children: children
          .map((r) => {
            const child = String(r["name"]);
            const line = text(r["description"]);
            return { name: child, ...(line ? { description: line } : {}), ...(has.has(child) ? { has_claims: true as const } : {}) };
          })
          .sort((a, b) => a.name.localeCompare(b.name)),
        claims: "ok" in listed ? listed.claims.map(claimOf) : [],
      };
    },

    async claims() {
      const names = await claims.reader.claimedSubjects("concept");
      const out: KnowledgeClaimed[] = [];
      for (let i = 0; i < names.length; i += CLAIMS_AT_ONCE) {
        const read = await Promise.all(
          names.slice(i, i + CLAIMS_AT_ONCE).map(async (concept) => {
            const subject = { kind: "concept" as const, name: concept };
            const [ref, listed] = await Promise.all([claims.reader.subjectRefId(toSubjectRef(subject)), claims.listClaims(subject)]);
            return ref && "ok" in listed && listed.claims.length ? { concept, ref_id: ref, claims: listed.claims.map(claimOf) } : null;
          }),
        );
        for (const r of read) if (r) out.push(r);
      }
      return out;
    },

    async opened(workflow, runId) {
      return conceptsOpenedIn(await deps.store.getRunEvents(workflow, runId).catch(() => []));
    },

    async addClaim(input, by = {}) {
      const sentence = input.text?.trim() ?? "";
      if (!sentence) return { error: "text is empty: a claim is ONE sentence that should hold from now on" };
      // The sentence is written into the check's config, which is a template.
      if (sentence.includes("{{")) return { error: "a claim's text may not contain {{ — write the rule in plain words" };
      const subject = { kind: "concept" as const, name: input.concept };
      const have = await claims.listClaims(subject);
      if (!("ok" in have)) return have;
      const same = have.claims.find((c) => c.text.trim() === sentence);
      if (same) return { ok: true, id: same.id, existing: true };
      const key = by.runId ?? "";
      if ((added.get(key) ?? 0) >= KNOWLEDGE_CLAIMS_PER_RUN) {
        return { error: `this run has already added ${KNOWLEDGE_CLAIMS_PER_RUN} claims, the most one run may: the rest wait for the next` };
      }
      const made = await claims.addClaim({ subjects: [subject], text: sentence, checks: [conceptCheckSpec(sentence)] }, TENDER);
      if (!("ok" in made)) return made;
      added.set(key, (added.get(key) ?? 0) + 1);
      return { ok: true, id: made.id };
    },

    async addEvidence(input) {
      const said = input.said?.trim() ?? "";
      if (!said) return { error: "said is empty: the evidence is the person's own words" };
      const about = (await claims.reader.subjectsOf(input.claim)).map((s) => s.subject).find((s): s is { kind: "concept"; name: string } => s.kind === "concept");
      if (!about) return { error: `claim "${input.claim}" is not about a Concept: this records what was said about a Concept's claims only` };
      const r = await deps.verifier.addEvidence({
        claim: input.claim,
        name: input.workflow,
        runId: input.runId,
        supports: input.supports,
        content: said,
        subject: about,
        by: input.by?.trim() || "person",
        mode: "asserted",
      });
      if (!("ok" in r)) {
        return { error: `${r.error}. What a person said is evidence only about a run that OPENED "${about.name}": when the run never opened the page, record nothing and let the claim stand` };
      }
      return { ok: true, evidence: r.evidence, concept: about.name };
    },
  };
}
