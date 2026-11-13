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
 *     model judging each piece of work that opened the page (src/work.ts)
 *     against the sentence, its one tool a read of that work's files. A
 *     tender never writes a check's config: what it reads (conversations)
 *     is untrusted text, and a check is something strut runs;
 *   - `addEvidence`: what a person SAID about a run's work, as their word
 *     against (or for) a claim — only about a run that opened the page;
 *   - `cycles`: what the dream did, afterwards — its recent runs that read
 *     something, each with its lessons (what a person said, the claim, the
 *     change). Read off the run store, so it quotes the conversations the
 *     dream read: its step (`knowledge/cycles`) answers strut's own page
 *     shown to an admin and no one else.
 *
 * Changing a Concept is not here: a tender changes it with the ordinary
 * graph steps, and where its tree is reviewed they are under its workflow's
 * `approve:`, so a person decides each change first.
 */
import { toSubjectRef, type ClaimActor, type ClaimListing, type ClaimsAuthoring } from "./claims-authoring.js";
import type { GraphBackend } from "./graph/backend.js";
import type { RunStatus, RunSummary } from "./core.js";
import type { RunStore } from "./store.js";
import { conceptsOpenedIn, type Verifier } from "./verify.js";

/** The workflow every claim written here is checked by. */
export const CONCEPT_CHECK_WORKFLOW = "concept-check";

/** The most of a page's docs a tender is shown (`context/concept`'s cap). */
export const KNOWLEDGE_DOCS_MAX = 6000;

/** The most claims one run may add: each is a paid check on every later
 *  version of its page. A runaway tender stops here. */
export const KNOWLEDGE_CLAIMS_PER_RUN = 10;

/** The workflow that tends the tree (src/workflows/system/dream/): its runs
 *  are the cycles `cycles` lists. */
export const DREAM_WORKFLOW = "dream";

/** The most of the dream's runs one `cycles` read looks through, newest
 *  first: a quiet dream (nothing new to read) is skipped, not counted. */
export const DREAM_CYCLES_SCAN = 200;

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

/** One lesson as the dream answers it: what a person said, the claim it
 *  wrote on a page, and the change it made to the tree. */
export interface DreamLesson {
  session: string;
  turn: number;
  said: string;
  concept: string;
  claim: string;
  claim_id?: string;
  recorded?: boolean;
  /** The change, in a line (`proposed` before review became a switch). */
  change?: string;
}

/** One dream that read something: when, which tree, whether a person
 *  reviewed its changes, and what it learned. What it CHANGED is the
 *  history's (`history/read log { run }`). */
export interface DreamCycle {
  run: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  /** The root of the tree it tended. */
  tree: string;
  source?: string;
  /** Its changes waited for a person (proposals), not made at once. */
  review: boolean;
  /** The turns it read; 0 when it failed before reading them. */
  turns: number;
  /** It stopped at its limit: the rest wait for the next dream. */
  more?: true;
  lessons: DreamLesson[];
  stuck: string[];
  error?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A run of the dream as a cycle, or null: parked, or quiet
 *  (it ended with nothing new to read). */
export function cycleOf(s: RunSummary): DreamCycle | null {
  if (s.status === "waiting") return null;
  const input = isRecord(s.input) ? s.input : {};
  const out = isRecord(s.output) ? s.output : {};
  const turns = typeof out["turns"] === "number" ? out["turns"] : 0;
  if (s.status === "success" && turns === 0) return null;
  const tree = text(out["root"]) ?? text(input["root"]) ?? "";
  const source = text(input["source"]);
  const lessons = (Array.isArray(out["lessons"]) ? out["lessons"] : []).filter(isRecord).map((l): DreamLesson => {
    const change = text(l["change"]) ?? text(l["proposed"]);
    return {
      session: String(l["session"] ?? ""),
      turn: typeof l["turn"] === "number" ? l["turn"] : 0,
      said: String(l["said"] ?? ""),
      concept: String(l["concept"] ?? ""),
      claim: String(l["claim"] ?? ""),
      ...(text(l["claim_id"]) ? { claim_id: String(l["claim_id"]) } : {}),
      ...(typeof l["recorded"] === "boolean" ? { recorded: l["recorded"] } : {}),
      ...(change ? { change } : {}),
    };
  });
  return {
    run: s.runId,
    status: s.status,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    tree,
    ...(source ? { source } : {}),
    review: (out["review"] ?? input["review"]) === true,
    turns,
    ...(out["more"] === true ? { more: true as const } : {}),
    lessons,
    stuck: (Array.isArray(out["stuck"]) ? out["stuck"] : []).filter((x): x is string => typeof x === "string"),
    ...(s.error?.message ? { error: s.error.message } : {}),
  };
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
  /** The dream's recent cycles, newest first: its runs that read something
   *  (`cycleOf`), at most `limit`, only one tree's when `tree` is given. */
  cycles(opts?: { limit?: number; tree?: string }): Promise<DreamCycle[]>;
  /** The door as a run on a Concept branch has it (src/branches.ts): pages
   *  are the branch's (`namespace`); claims are shared and read as they
   *  are, and none is added or evidenced from a branch yet (item d). */
  onBranch?(namespace: string): KnowledgeCapability;
}

export interface KnowledgeDeps {
  graph: Pick<GraphBackend, "query" | "namespace" | "dialect">;
  claims: ClaimsAuthoring;
  verifier: Pick<Verifier, "addEvidence">;
  store: Pick<RunStore, "getRunEvents" | "listRuns" | "getRunSummary">;
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

/** The standard check: the ROOT run of a work that opened the page, handed
 *  to the judge, which reads the whole work off its bag (src/work.ts). */
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
    onBranch(namespace) {
      const branch = namespace.replace(/^branch-/, "");
      const none = async () => ({ error: `this run is on Concept branch "${branch}": claims and evidence are not written from a branch yet — they are shared, and follow a page onto a branch in a later change` });
      const door: KnowledgeCapability = {
        ...createKnowledge({ ...deps, graph: { ...graph, query: graph.query.bind(graph), namespace } }),
        addClaim: none,
        addEvidence: none,
        onBranch: (ns) => {
          if (ns !== namespace) throw new Error(`this run is on Concept branch "${branch}", and stays on it`);
          return door;
        },
      };
      return door;
    },

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

    async cycles(opts = {}) {
      const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
      const out: DreamCycle[] = [];
      for (const id of (await deps.store.listRuns(DREAM_WORKFLOW)).slice(0, DREAM_CYCLES_SCAN)) {
        const summary = await deps.store.getRunSummary(DREAM_WORKFLOW, id).catch(() => null);
        const cycle = summary ? cycleOf(summary) : null;
        if (!cycle || (opts.tree && cycle.tree !== opts.tree)) continue;
        out.push(cycle);
        if (out.length >= limit) break;
      }
      return out;
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
