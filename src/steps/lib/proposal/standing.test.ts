/**
 * `proposal/standing`: whether the person a run is for is an admin of this
 * strut server, as the check a proposal only an admin accepts makes
 * (`adminStanding`). The orchestrator reads it every turn and says so before
 * the person's message only when they are one.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { StepContext } from "../../../core.js";
import standing from "./standing.js";

const ctx = (over: Partial<StepContext>): StepContext => ({ runId: "r1", ...over }) as StepContext;
const run = (c: StepContext) => standing.run({}, c);

describe("proposal/standing", () => {
  it("a page's turn says: the app door's `admin`, and a page without it is not one", async () => {
    assert.deepEqual(await run(ctx({ app: { name: "strut/jamie", version: "v4", firstParty: true, admin: true } })), { admin: true });
    assert.deepEqual(await run(ctx({ app: { name: "strut/jamie", version: "v4", firstParty: true } })), { admin: false });
  });
  it("any other run asks strut's records (a peer's launch, the turn a job or a wake came from); nothing when they do not say", async () => {
    const asked: string[] = [];
    const services = (answer: boolean | undefined) => ({ proposals: { personIsAdmin: async (runId: string) => (asked.push(runId), answer) } });
    assert.deepEqual(await run(ctx({ services: services(true) })), { admin: true });
    assert.deepEqual(await run(ctx({ services: services(false) })), { admin: false });
    assert.deepEqual(await run(ctx({ services: services(undefined) })), {}, "a host's launch with the key says nothing");
    assert.deepEqual(asked, ["r1", "r1", "r1"]);
    assert.deepEqual(await run(ctx({})), {}, "no proposals capability: nothing, never a failed turn");
  });
});
