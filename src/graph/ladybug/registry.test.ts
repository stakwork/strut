import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CLAIM_EDGES } from "../claims.js";
import { STRUT_EDGES, STRUT_SCHEMAS } from "../strut-schemas.js";
import { EDGE_COLUMNS, GENERIC_COLUMNS, LADYBUG_EDGES, LADYBUG_EDGE_TYPES, LADYBUG_SCHEMAS, LADYBUG_STRUT_TYPES, ladybugEdge, ladybugSchema, nodeColumns } from "./registry.js";

describe("ladybug registry (plans/ladybug-backend.md §3, ruling 6)", () => {
  it("holds exactly the ten types, and the Strut ones without Thing's vestiges or per-stem vectors", () => {
    assert.deepEqual(
      LADYBUG_SCHEMAS.map((s) => s.type),
      [...LADYBUG_STRUT_TYPES, "Claim", "Check", "Evidence", "Concept"],
    );
    for (const t of ["StrutAgentSession", "StrutToolCall", "StrutChat", "StrutTurn", "Person", "Thing", "Document"]) assert.equal(ladybugSchema(t), null, t);
    assert.equal(ladybugSchema("strutrun")?.type, "StrutRun", "case-insensitive");
    const wf = ladybugSchema("StrutWorkflow")!;
    assert.equal(wf.attributes["name"], "string");
    assert.equal(wf.attributes["description"], "?string", "Thing's name and description stay");
    for (const k of ["weight", "is_muted", "unique_source_id", "image_url"]) assert.ok(!(k in wf.attributes), k);
    assert.deepEqual(ladybugSchema("StrutStep")!.vector_index, []);
    assert.equal(ladybugSchema("StrutStep")!.exact_key, true, "the workspace types keep their exact keys");
    assert.deepEqual(STRUT_SCHEMAS.filter((s) => !LADYBUG_STRUT_TYPES.includes(s.type)).map((s) => s.type), ["StrutAgentSession", "StrutToolCall", "StrutChat", "StrutTurn"]);
  });

  it("declares the claim types with the fields claims.ts reads, and Concept without jarvis's string timestamps", () => {
    const claim = ladybugSchema("Claim")!;
    assert.equal(claim.node_key, "claim-id");
    assert.deepEqual(Object.keys(claim.attributes).sort(), ["belief_valid_from", "belief_valid_to", "claim_text", "id", "name", "speaker_name"]);
    assert.equal(claim.attributes["belief_valid_from"], "?datetime");
    const check = ladybugSchema("Check")!;
    assert.equal(check.attributes["created_at"], "datetime");
    assert.equal(check.attributes["freshness_days"], "?int");
    const evidence = ladybugSchema("Evidence")!;
    assert.deepEqual(evidence.index, ["name", "description", "content"]);
    const concept = ladybugSchema("Concept")!;
    assert.equal(concept.node_key, "concept-name");
    assert.equal(concept.attributes["name"], "string");
    for (const k of ["created_at", "last_updated", "documentation"]) assert.ok(!(k in concept.attributes), k);
    for (const s of LADYBUG_SCHEMAS) assert.equal(s.isStrut, s.type.startsWith("Strut"));
  });

  it("edges: the kept Strut rows, the six claim edges, the Concept tree — and nothing to a dropped type", () => {
    const kept = new Set(LADYBUG_SCHEMAS.map((s) => s.type));
    for (const e of LADYBUG_EDGES) {
      assert.ok(kept.has(e.source) && kept.has(e.target), `${e.source}-[${e.edge}]->${e.target}`);
    }
    for (const e of STRUT_EDGES) {
      const inFile = kept.has(e.source) && kept.has(e.target);
      assert.equal(ladybugEdge(e.edge, e.source, e.target) !== null, inFile, `${e.source}-[${e.edge}]->${e.target}`);
    }
    for (const edge of Object.values(CLAIM_EDGES)) assert.ok(LADYBUG_EDGE_TYPES.includes(edge), edge);
    assert.ok(ladybugEdge("CHILD_OF", "Concept", "Concept"));
    assert.ok(ladybugEdge("PARENT_OF", "Concept", "Concept"), "the tree the seeded pages and graph-get's `children` walk");
    for (const t of ["StrutRun", "StrutWorkflowVersion", "StrutStepVersion"]) assert.ok(ladybugEdge("HAS_SOURCE", "Evidence", t), `a publish check's evidence has the version as its source: ${t}`);
    assert.equal(ladybugEdge("CHILD_OF", "Concept", "StrutRun"), null);
    assert.equal(ladybugEdge("ACCESSED", "StrutToolCall", "Concept"), null);
    assert.equal(ladybugEdge("PUBLISHED_BY", "StrutStepVersion", "Person"), null);
    assert.equal(ladybugEdge("RELATED_TO", "Concept", "Concept"), null, "no jarvis allowlist");
    assert.deepEqual(LADYBUG_EDGE_TYPES, ["ABOUT", "ACTIVE_VERSION", "CHILD_OF", "DEPENDS_ON", "EVIDENCED_BY", "EXECUTED", "HAS_SOURCE", "IN_JOB", "PARENT_OF", "PRODUCED_BY", "PROMOTED_FROM", "SUPERSEDES", "TESTS", "USES_STEP", "VERSION_OF"]);
  });

  it("columns: one per attribute, no conflicts, no jarvis stamps but a seeded Concept's source", () => {
    const cols = nodeColumns();
    for (const s of LADYBUG_SCHEMAS) for (const k of Object.keys(s.attributes)) assert.ok(cols[k], `${s.type}.${k}`);
    assert.equal(cols["created_at"], "INT64");
    assert.equal(cols["id"], "STRING");
    assert.equal(cols["freshness_days"], "INT64");
    assert.equal(cols["sample_rate"], "DOUBLE");
    assert.equal(cols["max_run_cost_usd"], "DOUBLE");
    assert.equal(cols["unique_source_id"], "STRING", "a seeded Concept's stamp (concept-seed.ts)");
    for (const k of ["is_deleted", "is_muted", "relevancy_score", "weight", "_search_fields_used", "input_embeddings", "attrs", "domain"]) assert.ok(!(k in cols), k);
    for (const k of Object.keys(GENERIC_COLUMNS)) assert.ok(cols[k], k);
    assert.ok(Object.keys(cols).length > 60 && Object.keys(cols).length < 100, `${Object.keys(cols).length} columns`);
    assert.deepEqual(Object.keys(EDGE_COLUMNS), ["ref_id", "edge_key", "date_added_to_graph", "weight", "importance", "strength", "context", "start_time", "end_time", "post_url"]);
  });
});
