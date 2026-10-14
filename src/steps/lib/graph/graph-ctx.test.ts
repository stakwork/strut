import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { graphCtx, type GraphBackend } from "./_shared.js";

describe("graphCtx: the backend the server wired comes first", () => {
  it("returns ctx.services.graph without opening anything", async () => {
    const wired = { kind: "ladybug", cfg: { kind: "ladybug", path: "/x/graph.lbug", namespace: "default" } } as unknown as GraphBackend;
    // A secrets capability that would fail the env route: the wired backend
    // must win before any of it is read.
    const secrets = { get: async () => { throw new Error("env route taken"); } };
    const b = await graphCtx({ services: { graph: wired, secrets } } as never);
    assert.equal(b, wired);
  });
});
