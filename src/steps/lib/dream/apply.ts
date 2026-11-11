import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { claimGraph, writerOf } from "./_graph.js";

/** The most Concept writes one dream makes. */
const EDITS_MAX = 10;
const linesOf = (docs: string) => docs.split("\n");
const same = (a: string, b: string) => a.trim() === b.trim();
/** The most lines one edit writes: more is a rewrite, which a dream does not do. */
const LINES_MAX = 12;
/** A model's text as the lines it holds, blank ones dropped. */
const block = (v: unknown) => (typeof v === "string" ? v.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim()) : []);
/** Where a run of lines sits in a Concept's text, word for word; -1 when it is not there. */
const find = (lines: string[], run: string[]) => (run.length ? lines.findIndex((_, i) => run.every((r, j) => lines[i + j] !== undefined && same(lines[i + j]!, r))) : -1);
/** One line of a model's: trimmed, its line breaks spaces. */
const one = (v: unknown) => (typeof v === "string" ? v.trim().replace(/\s*\n\s*/g, " ") : "");

interface Change {
  claim: string;
  title: string;
  concept: { ref_id?: string; name: string };
  kind: "changed" | "added";
  removed: string[];
  added: string[];
  /** The Concept's name or one-line description, when that is what changed: as it was and as it is. */
  renamed?: { was: string; is: string };
  description?: { was: string; is: string };
  why?: string;
  /** The proposal that holds it, when changes wait for a person. */
  proposed?: string;
}

/**
 * Makes the Concept edits a dream's fixing step wrote (plans/dream.md), in code: a few lines added to, replaced on or removed from
 * a Concept of the tree, a Concept's name or description, or a new Concept under the root. The model wrote the text; this checks the edit is for a
 * claim that is due, on a Concept it may touch, and that the text it replaces or removes is really there, then writes it and notes
 * the fix on the claim. With `review` every edit is a proposal a person decides, and nothing is written.
 */
export default defineStep({
  type: "dream/apply",
  effect: "write",
  description:
    "Apply a dream's fixes: each edit { claim, action: add | replace | remove | rename | describe | add_concept | none, concept?, old_text?, new_text?, concept_name?, description?, first?, why? } for a claim dream/due returned. " +
    "`add` puts `new_text` (a line, or a few: at most 12) on `concept` (first when `first`); `replace` swaps `old_text`, lines that must be on the Concept as written, for `new_text`; `remove` takes `old_text` off; `rename` gives `concept` the name `concept_name`, one no other Concept of the tree has; `describe` sets its one-line `description`; `add_concept` makes a Concept `concept_name` under the root holding `new_text`, with `description` when given. " +
    "The root's own text is never edited, a Concept is never rewritten, and at most 10 edits are made. With `review` each edit is a proposal and nothing is written. " +
    "Returns { changes: [{ claim, title, concept: { ref_id, name }, kind, removed, added, renamed?: { was, is }, description?: { was, is }, why?, proposed? }], skipped: [{ claim, why }] }.",
  input: z.object({
    root: z.string().optional().default("Personal"),
    review: z.boolean().optional().default(false).describe("Every edit waits for a person's yes, as a proposal."),
    items: z.array(z.any()).optional().default([]).describe("The claims that are due, as dream/due returned them."),
    edits: z.array(z.any()).optional().default([]).describe("The edits, one per claim."),
    created_by: z.string().optional(),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const { g, namespace, readable } = await claimGraph(ctx);
    if (!readable) throw new Error(`dream/apply: this run may not read "${namespace}"`);
    const { treeConcepts, recordFix } = await import("../../../graph/concept-claims.js");
    const by = writerOf(ctx, cfg.created_by);
    const proposals = (ctx.services as { proposals?: { propose(p: unknown): Promise<{ id: string }> } } | undefined)?.proposals;
    if (cfg.review && !proposals) throw new Error("dream/apply: `review` needs strut's proposals (ctx.services.proposals)");
    const who = { workflow: ctx.workflow ?? "dream", runId: ctx.runId, path: ctx.path };
    const changes: Change[] = [];
    const skipped: Array<{ claim: string; why: string }> = [];
    let made = 0;
    for (const e of cfg.edits) {
      const it = cfg.items.find((x: any) => x.claim === e?.claim);
      const skip = (why: string) => skipped.push({ claim: String(e?.claim ?? ""), why });
      if (!it) {
        skip("not a claim that is due");
        continue;
      }
      if (e.action === "none" || !e.action) {
        skip(e.why ? String(e.why) : "left alone");
        continue;
      }
      const text = block(e.new_text);
      const old = block(e.old_text);
      const line = text.join("\n");
      const names = e.action === "rename" || e.action === "describe";
      if (!text.length && !names && e.action !== "remove") {
        skip("no line to write");
        continue;
      }
      if (text.length > LINES_MAX) {
        skip(`more than ${LINES_MAX} lines: a Concept is not rewritten`);
        continue;
      }
      if (made >= EDITS_MAX) {
        skip(`the dream's limit of ${EDITS_MAX} edits is reached`);
        continue;
      }
      // The tree as it stands now: an earlier edit of this run is seen.
      const concepts = await treeConcepts(g, namespace, cfg.root);
      const root = concepts[0];
      if (!root) {
        skip(`no tree "${cfg.root}"`);
        continue;
      }
      const note = { claim: it.claim as string, title: String(it.title || it.text), ...(e.why ? { why: String(e.why) } : {}) };
      if (e.action === "add_concept") {
        const name = typeof e.concept_name === "string" ? e.concept_name.trim() : "";
        if (!name || concepts.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
          skip(name ? `a Concept "${name}" is already in the tree: add the line to it` : "a new Concept needs a name");
          continue;
        }
        const description = one(e.description);
        const described = description ? { description: { was: "", is: description } } : {};
        if (cfg.review) {
          const p = await proposals!.propose({
            step: "graph/create-triplet", title: `Add concept: ${name}`, rationale: `${note.title}: ${text[0]}`, by: who,
            input: { source_ref_id: root.ref_id, edge_type: "PARENT_OF", target_type: "Concept", target_data: { name, docs: line, ...(description ? { description } : {}) } },
          });
          changes.push({ ...note, concept: { name }, kind: "added", removed: [], added: text, ...described, proposed: p.id });
        } else {
          const node = await g.nodes.write({ type: "Concept", data: { name, docs: line, ...(description ? { description } : {}) }, ...(by ? { created_by: by } : {}) }, "create", namespace ? { namespace } : {});
          await g.edges.write({ edge: "PARENT_OF", source_ref_id: root.ref_id, target_ref_id: node.ref_id, ...(namespace ? { namespace } : {}), ...(by ? { created_by: by } : {}) });
          await recordFix(g, { claim: it.claim, concept: node.ref_id, line, ...(ctx.runId ? { dream: ctx.runId } : {}), at: Date.now(), namespace, ...(by ? { created_by: by } : {}) });
          changes.push({ ...note, concept: { ref_id: node.ref_id, name }, kind: "added", removed: [], added: text, ...described });
        }
        made++;
        continue;
      }
      const concept = concepts.find((p) => p.ref_id === e.concept);
      if (!concept || concept.depth === 0) {
        skip(concept ? "the root's own text is left alone" : "not a Concept of this tree");
        continue;
      }
      const allowed = it.concept?.ref_id === concept.ref_id || (it.concepts ?? []).some((p: any) => p.ref_id === concept.ref_id);
      if (!allowed) {
        skip(`"${concept.name}" is not a Concept this claim may be written on`);
        continue;
      }
      if (names) {
        // What the assistant is shown before it opens a Concept: its name and its one line.
        const field = e.action === "rename" ? "name" : "description";
        const is = one(field === "name" ? e.concept_name : e.description);
        const was = String((field === "name" ? concept.name : concept.description) ?? "");
        if (!is || same(is, was)) {
          skip(is ? `the Concept's ${field} is already that` : `no ${field} to write`);
          continue;
        }
        if (field === "name" && concepts.some((p) => p.ref_id !== concept.ref_id && p.name.toLowerCase() === is.toLowerCase())) {
          skip(`a Concept "${is}" is already in the tree`);
          continue;
        }
        const change = { ...note, concept: { ref_id: concept.ref_id, name: field === "name" ? is : concept.name }, kind: "changed" as const, removed: [], added: [], ...(field === "name" ? { renamed: { was, is } } : { description: { was, is } }) };
        if (cfg.review) {
          const p = await proposals!.propose({
            step: "graph/edit-node", title: `${field === "name" ? "Rename" : "Describe"} concept: ${concept.name}`, rationale: `${note.title}: ${is}`, by: who,
            input: { ref_id: concept.ref_id, node_data: { [field]: is } },
          });
          changes.push({ ...change, proposed: p.id });
        } else {
          await g.nodes.update(concept.ref_id, { set: { [field]: is }, remove: [] });
          await recordFix(g, { claim: it.claim, concept: concept.ref_id, line: `${field}: ${is}`, ...(ctx.runId ? { dream: ctx.runId } : {}), at: Date.now(), namespace, ...(by ? { created_by: by } : {}) });
          changes.push(change);
        }
        made++;
        continue;
      }
      const lines = linesOf(concept.docs ?? "");
      if (text.length && text.every((t) => lines.some((l) => same(l, t)))) {
        skip("the Concept already says it");
        continue;
      }
      let removed: string[] = [];
      let next: string[];
      if (e.action === "replace") {
        const at = find(lines, old);
        if (at < 0) {
          skip("the line to replace is not on the Concept as written");
          continue;
        }
        removed = old.map((l) => l.trim());
        next = [...lines.slice(0, at), ...lines.slice(at + old.length)];
        next.splice(e.first ? 0 : at, 0, ...text);
      } else if (e.action === "remove") {
        const at = find(lines, old);
        if (at < 0) {
          skip("the line to remove is not on the Concept as written");
          continue;
        }
        removed = old.map((l) => l.trim());
        next = [...lines.slice(0, at), ...lines.slice(at + old.length)];
      } else if (e.action === "add") {
        next = e.first ? [...text, ...lines] : [...lines.filter((l, i) => i < lines.length - 1 || l.trim()), ...text];
      } else {
        skip(`"${String(e.action)}" is not an edit`);
        continue;
      }
      const docs = next.join("\n").replace(/^\n+/, "");
      if (cfg.review) {
        const p = await proposals!.propose({
          step: "graph/edit-node", title: `Edit concept: ${concept.name}`, rationale: `${note.title}: ${text[0] ?? `remove "${removed[0]}"`}`, by: who,
          input: { ref_id: concept.ref_id, node_data: { docs } },
        });
        changes.push({ ...note, concept: { ref_id: concept.ref_id, name: concept.name }, kind: "changed", removed, added: text, proposed: p.id });
      } else {
        await g.nodes.update(concept.ref_id, { set: { docs }, remove: [] });
        await recordFix(g, { claim: it.claim, concept: concept.ref_id, line: line || `removed: ${removed.join(" / ")}`, ...(ctx.runId ? { dream: ctx.runId } : {}), at: Date.now(), namespace, ...(by ? { created_by: by } : {}) });
        changes.push({ ...note, concept: { ref_id: concept.ref_id, name: concept.name }, kind: "changed", removed, added: text });
      }
      made++;
    }
    return { changes, skipped };
  },
});
