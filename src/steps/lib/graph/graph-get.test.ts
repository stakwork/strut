/**
 * graph/graph-get's `required`, offline: the step over a stand-in for the
 * wired backend (`ctx.services.graph`). The step's lookups against a real
 * graph are graph-steps.test.ts (live Neo4j).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { StepContext } from "../../../core.js";

describe("graph/graph-get `required`: a failure is an error, not the result", () => {
  // A stand-in for the wired backend: one Concept, keyed by name.
  const node = { ref_id: "n1", node_type: "Concept", properties: { name: "Pod Setup", description: "The contract" } };
  let failing = false;
  const graph = {
    reader: {
      getNode: async (id: string) => {
        if (failing) throw new Error("boom");
        return id === "n1" ? node : null;
      },
      getNodeByKey: async (_type: string, key: string) => (key === "concept-podsetup" ? node : null),
      connectionCounts: async () => [{ edge_type: "PARENT_OF", count: 2 }],
      neighbors: async () => ({ nodes: [] }),
    },
    schemas: { schema: async (t: string) => (t === "Concept" ? { type: "Concept", node_key: "concept-name" } : null) },
  };
  const ctx = { services: { graph } } as unknown as StepContext;
  const get = async (input: Record<string, unknown>) => {
    const { default: step } = await import("./graph-get.js");
    return step.run(step.input.parse(input), ctx);
  };

  it("leaves a found node's output as it is", async () => {
    const plain = await get({ node_type: "Concept", name: "Pod Setup" });
    assert.equal(plain.ref_id, "n1");
    assert.deepEqual(await get({ node_type: "Concept", name: "Pod Setup", required: true }), plain);
    assert.deepEqual((await get({ ref_id: "n1", required: true })).edges, { PARENT_OF: 2 });
  });

  it("throws each message a tool gets back as its answer", async () => {
    for (const [input, message] of [
      [{ ref_id: "nope" }, /^node not found: nope$/],
      [{ node_type: "Concept", name: "Missing" }, /^node not found: Concept "Missing"$/],
      [{ node_type: "Nope", name: "x" }, /unknown node type "Nope"/],
      [{ name: "Pod Setup" }, /pass ref_id, or node_type \+ name/],
    ] as const) {
      assert.match(await get(input), message, "off: the message is the result");
      await assert.rejects(get({ ...input, required: true }), { message });
    }
    failing = true;
    try {
      assert.match(await get({ ref_id: "n1" }), /graph\/graph-get failed: boom/);
      await assert.rejects(get({ ref_id: "n1", required: true }), { message: /^graph\/graph-get failed: boom$/ });
    } finally {
      failing = false;
    }
  });
});
