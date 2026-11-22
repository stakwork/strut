import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rateOf } from "./visitor-signin.js";

describe("the rate a Peel app is handed", () => {
  it("keeps the finite figures above zero of GET /rate's perBtc, and its time", () => {
    assert.deepEqual(rateOf({ usdPerBtc: 1, at: "2026-01-01T00:00:00.000Z", source: "x", perBtc: { USD: 60_000, EUR: 55_000, GBP: 0, CAD: "x" } }), { perBtc: { USD: 60_000, EUR: 55_000 }, at: "2026-01-01T00:00:00.000Z" });
  });
  it("is null with no currency in it (a server from before, a failure)", () => {
    for (const body of [null, {}, { usdPerBtc: 1 }, { perBtc: {} }, { perBtc: { USD: -1 } }, "x"]) assert.equal(rateOf(body), null, JSON.stringify(body));
  });
});
