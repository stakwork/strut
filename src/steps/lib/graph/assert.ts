import { z } from "zod";
import { defineStep, type StepContext, withAccessedNodes } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { graphCtx, errText, describeNodes, type GraphBackend } from "./_shared.js";
import type { GraphTx } from "../../../graph/engine.js";
import { VOLATILITIES } from "../../../graph/fact-score.js";

const EXAMPLE = `- id: moved
  type: graph/assert
  config:
    source_ref_id: "{{ kate.ref_id }}"
    edge_type: LIVES_IN
    target_ref_id: "{{ lisbon.ref_id }}"
    text: Kate lives in Lisbon
    valid_at: "2026-09"
    source: "{{ message.ref_id }}"`;

const Fact = z.object({
  source_ref_id: z.string().optional().describe("The node the fact is about (its subject), from graph/resolve."),
  source_type: z.string().optional().describe("Instead of source_ref_id, for a subject graph/resolve did not find: its type, with source_data. Created in the same transaction."),
  source_data: z.record(z.string(), z.any()).optional().describe("The new subject's fields, e.g. its name."),
  edge_type: z.string().describe("The temporal relationship type (uppercased)."),
  target_ref_id: z.string().optional().describe("The node it relates the subject to, from graph/resolve."),
  target_type: z.string().optional().describe("Instead of target_ref_id, for a target graph/resolve did not find: its type, with target_data."),
  target_data: z.record(z.string(), z.any()).optional().describe("The new target's fields."),
  text: z.string().describe("The fact as one plain sentence, naming both ends."),
  valid_at: z.string().optional().describe("When it became true, only if the words say."),
  invalid_at: z.string().optional().describe("When it stopped being true, only if the words say."),
  observed_at: z.string().optional().describe("When the evidence is from, when not now: the time of the message, email, calendar event or document it was read from (ISO). Left out for what is said in this conversation."),
  ended: z.boolean().optional().describe("It is over (\"used to …\", \"I left\"), even with no date: kept as past, no end date invented. It was true; it is not now."),
  refuted: z.boolean().optional().describe("The speaker says it is false (\"that's wrong\", \"I'm not vegan\"): it was never true. The fact held now ends, and its record keeps the speaker's word against it, so it is not stated again. Not for something that is merely over: that is `ended`."),
  source: z.string().optional().describe("Only for more than this run says: the ref_id of a message or node it was read from. The run it is asserted in is kept as a source on its own."),
  said_by: z.string().optional().describe("The ref_id of whoever said it, when not the user: e.g. the Person whose message this was."),
  create_schema_if_missing: z.boolean().optional().describe("Create the edge type as temporal between the two ends' types when the ontology has no such edge. An existing plain edge type is never made temporal."),
  cardinality: z.enum(["one", "many"]).optional().describe("With create_schema_if_missing, for a new edge type: `one` when a subject holds one current value (where someone lives), `many` (default) when several hold at once."),
  aliases: z.array(z.string()).optional().describe("With create_schema_if_missing, for a new edge type: other words for it, which a search reads as naming it (WORKS_AT: job, employer)."),
  volatility: z.enum(VOLATILITIES).optional().describe("How fast this kind of fact changes: `static` never (a birthday), `stable` over years (where someone lives), `evolving` within a year or so (a diet), `volatile` within weeks (what someone is working on). Kept on the edge type the first time it is given; reads lower trust in a fact as it goes unconfirmed for longer than that."),
  expects: z
    .object({
      step: z.string().describe("The check: a step type that looks for the evidence (e.g. activity at an organisation)."),
      every_days: z.number().positive().describe("How often to run it."),
      window_days: z.number().positive().optional().describe("How far back it looks."),
      config: z.record(z.string(), z.any()).optional().describe("Extra config for the step."),
    })
    .optional()
    .describe("The evidence this kind of fact should keep producing while it holds, and the check that looks for it (memory/verify runs it). Kept on the edge type the first time it is given. Rarely needed: only with a check step that exists."),
});
type FactT = z.infer<typeof Fact>;

const sideOf = (f: FactT, side: "source" | "target"): string | null => {
  const ref = f[`${side}_ref_id`];
  const type = f[`${side}_type`];
  const data = f[`${side}_data`];
  if (ref && (type || data)) return `${side}: pass ${side}_ref_id OR ${side}_type + ${side}_data, not both`;
  if (!ref && !(type && data)) return `${side}: pass ${side}_ref_id, or ${side}_type and ${side}_data for a new node`;
  return null;
};

/** One fact's edge schema: made temporal when asked and missing, and a
 *  `volatility` or `expects` the type does not have yet kept on it. Before
 *  the transaction: a rel table is DDL. A plain edge type stays plain. */
async function ensureTemporal(b: GraphBackend, f: FactT, edge: string, types: [string, string]): Promise<void> {
  const { edgeRule } = await import("../../../graph/ladybug/ontology.js");
  const { boundsOf } = await import("../../../graph/scope.js");
  const { edgeRuleOf } = await import("../../../graph/schema-resolver.js");
  // Schema rows are the file's: read unscoped, as a reader's list refuses a raw query.
  const query = boundsOf(b)?.query ?? b.query.bind(b);
  const held = await edgeRule((c, p) => query(c, p), edge);
  if (held && held["temporal"] !== true) throw new Error(`${edge} is a plain edge type; a fact needs a temporal one: pick another edge type`);
  const rule = held ? edgeRuleOf(held) : undefined;
  const fill = { ...(f.volatility && !rule?.volatility ? { volatility: f.volatility } : {}), ...(f.expects && !rule?.expects ? { expects: f.expects } : {}) };
  const exists = await b.schemas.edgeSchema(edge, ...types);
  if (exists && !Object.keys(fill).length) return;
  if (!exists && !f.create_schema_if_missing) return;
  const wanted = rule ? (Object.keys(fill).length ? { ...rule, ...fill } : undefined) : { temporal: true, cardinality: f.cardinality ?? "many", ...fill };
  await b.schemas.createEdgeSchema(types[0], edge, types[1], wanted, { aliases: exists ? [] : f.aliases ?? [] });
}

export default defineStep({
  type: "graph/assert",
  description:
    "State a FACT that can change over time between two nodes as a temporal edge: true from `valid_at`, until `invalid_at` (writes live to the graph; a LadybugDB graph only). " +
    "Find both ends with graph/resolve first; an end it did not find can be created here with `<side>_type` + `<side>_data`. " +
    "The edge type must be one the ontology marks temporal (graph/create-triplet refuses those); `create_schema_if_missing` makes a new one, with `cardinality`. " +
    "Asserting what the graph already holds RE-CONFIRMS it: `source` and `said_by` are added once, a missing date is filled, nothing else changes (the same sources again change nothing). " +
    "On a one-value edge type (cardinality one) a different target ENDS the current edge and creates the new one — unless `valid_at` is before the current one began: " +
    "then the new one is HISTORY, ended when the current one began, and the current one stays. `ended` (or an `invalid_at` already past) records something no longer true; " +
    "asserting the current fact with `ended` ends it. When the user says a fact is wrong (\"that's wrong\", \"I'm not vegan\"), assert it with `refuted`, said by whoever said so: it ends, and is kept as false, not as something they backed. " +
    "Dates are ISO ('2026-09-14'), a year-month ('2026-09') or a year ('2026'), only when the words say. " +
    "First-person words mean the speaker: what someone else said is theirs, with `said_by` naming them. " +
    "Pass several in `facts` to save them all or nothing: one failure writes none of them, nodes included.\n\n" +
    EXAMPLE,
  input: Fact.partial({ edge_type: true, text: true }).extend({
    facts: z.array(Fact).min(1).optional().describe("Several facts, written in one transaction: all of them or none. Instead of the single fact's fields."),
    namespace: z.string().optional().describe("The namespace of new nodes and edges (default: an edge goes in its subject's)."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    const { facts: many, namespace: ns, ...single } = cfg;
    if (many && (single.edge_type || single.text)) return "graph/assert invalid input — pass `facts`, or one fact's fields, not both";
    const facts: FactT[] = many ?? [single as FactT];
    for (const [i, f] of facts.entries()) {
      const at = facts.length > 1 ? `facts[${i}]: ` : "";
      if (!f.edge_type || !f.text) return `graph/assert invalid input — ${at}edge_type and text are required`;
      const bad = sideOf(f, "source") ?? sideOf(f, "target");
      if (bad) return `graph/assert invalid input — ${at}${bad}`;
    }
    try {
      const b = await graphCtx(ctx as StepContext<StrutCapabilities>);
      // Lazy, like graphCtx: the graph modules load neo4j-driver (`_shared.ts`).
      const { assertEdge, embedPendingEdgeRows } = await import("../../../graph/temporal.js");
      const namespace = await b.reader.resolveNamespace(ns);
      const by = ctx?.actor ? { created_by: ctx.actor } : {};
      const edgeOf = (f: FactT) => f.edge_type.toUpperCase().replace(/ /g, "_");
      const typeOf = async (f: FactT, side: "source" | "target") => {
        const ref = f[`${side}_ref_id`];
        if (!ref) return (await b.schemas.schema(f[`${side}_type`]!))?.type ?? f[`${side}_type`]!;
        return (await b.reader.getNode(ref))?.node_type ?? "";
      };
      // On Neo4j assertEdge refuses before reading anything: let it, before a node is made.
      if (b.kind !== "ladybug") await assertEdge(b, b.schemas, { edge: edgeOf(facts[0]!), source_ref_id: "", target_ref_id: "", text: "" });
      for (const f of facts) if (f.create_schema_if_missing || f.volatility || f.expects) await ensureTemporal(b, f, edgeOf(f), [await typeOf(f, "source"), await typeOf(f, "target")]);

      // One transaction: the new nodes (each distinct one once) and every
      // fact. A lone fact between known nodes runs as its own, embedded first.
      const created = new Map<string, { ref_id: string; node_type: string }>();
      const lone = !many && !!single.source_ref_id && !!single.target_ref_id;
      const inTx = <T>(fn: (tx: GraphTx | undefined) => Promise<T>) => (lone ? fn(undefined) : b.tx((tx) => fn(tx)));
      const results = await inTx(async (tx) => {
        const nodeFor = async (f: FactT, side: "source" | "target") => {
          const ref = f[`${side}_ref_id`];
          if (ref) return ref;
          const type = f[`${side}_type`]!;
          const data = f[`${side}_data`]!;
          const key = `${type}\u0000${JSON.stringify(data, Object.keys(data).sort())}`;
          const had = created.get(key);
          if (had) return had.ref_id;
          const w = await b.nodes.write({ type, data, ...by }, "create", { namespace, ...(tx ? { tx } : {}) });
          created.set(key, { ref_id: w.ref_id, node_type: w.node_type });
          return w.ref_id;
        };
        const out = [];
        for (const f of facts) {
          const source_ref_id = await nodeFor(f, "source");
          const target_ref_id = await nodeFor(f, "target");
          const edge = edgeOf(f);
          const r = await assertEdge(b, b.schemas, {
            edge,
            source_ref_id,
            target_ref_id,
            text: f.text,
            ...(f.valid_at ? { valid_at: f.valid_at } : {}),
            ...(f.invalid_at ? { invalid_at: f.invalid_at } : {}),
            ...(f.observed_at ? { observed_at: f.observed_at } : {}),
            ...(f.ended ? { ended: true } : {}),
            ...(f.refuted ? { refuted: true } : {}),
            ...(f.source ? { source: f.source } : {}),
            ...(f.said_by ? { said_by: f.said_by } : {}),
            // Where it was said is the run's to know, never the model's to pass.
            ...(ctx?.runId ? { run: ctx.runId } : {}),
            ...(ns ? { namespace } : {}),
            ...by,
          }, tx ? { tx } : { ...(b.embedder ? { embedder: b.embedder } : {}) });
          out.push({ r, edge, source_ref_id, target_ref_id });
        }
        return out;
      });
      // Embedded once committed: the rows were written keyword-only.
      if (!lone && results.some((x) => x.r.unembedded)) void embedPendingEdgeRows(b);

      const outOf = ({ r, edge, source_ref_id, target_ref_id }: (typeof results)[number]) => ({
        status: r.action === "unchanged" ? "Warning" : "Success",
        edge_ref_id: r.ref_id,
        edge_type: edge,
        source_ref_id,
        target_ref_id,
        action: r.action,
        ...(r.superseded.length ? { superseded: r.superseded } : {}),
        ...(r.ended ? { ended: true } : {}),
        ...(r.filled ? { filled: r.filled } : {}),
      });
      const nodes = [...created.values()];
      const touched = await describeNodes(b, results.flatMap((x) => [x.source_ref_id, x.target_ref_id]));
      if (!many) return withAccessedNodes({ ...outOf(results[0]!), ...(nodes.length ? { created_nodes: nodes } : {}) }, touched);
      return withAccessedNodes({ status: "Success", facts: results.map(outOf), ...(nodes.length ? { created_nodes: nodes } : {}) }, touched);
    } catch (e) {
      return errText("graph/assert", e);
    }
  },
});
