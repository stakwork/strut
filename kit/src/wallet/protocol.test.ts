import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ERROR_CODES, NOTIFICATION_TYPES, PAY_METHODS, REQUESTABLE_METHODS, WALLET_METHODS, WalletError,
  checkParams, connectionRequestProblems, isWalletErrorCode, isWalletMethod, msatToSats, notificationProblems,
  parseSphinxAddress, resultProblems, satsToMsat, sphinxRouteHint, verifyPreimage, walletErrorBody,
  walletErrorCodeOf, walletMethodOf, walletRequestMethod, type WalletMethod,
} from "./protocol.js";

type Vectors = {
  version: number;
  params: Array<{ name: string; method: WalletMethod; params: unknown; expect: { params?: unknown; error?: string } }>;
  results: Array<{ name: string; method: WalletMethod; result: unknown; valid: boolean }>;
  notifications: Array<{ name: string; notification: unknown; valid: boolean }>;
  connection_requests: Array<{ name: string; request: unknown; valid: boolean }>;
  preimages: Array<{ preimage: string; payment_hash: string; valid: boolean }>;
  scenarios: Array<{
    name: string;
    request?: unknown;
    connection: null | { methods: string[]; notification_types: string[]; max_amount?: number; renewal_period?: string; over_budget: string; used_budget: number };
    steps: Array<Record<string, unknown>>;
  }>;
};

const vectors = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf-8")) as Vectors;

describe("wallet vectors: params", () => {
  for (const v of vectors.params) {
    it(v.name, () => {
      const r = checkParams(v.method, v.params);
      if (v.expect.error) {
        assert.equal(r.ok, false, "expected a refusal");
        if (!r.ok) {
          assert.equal(r.error.data.code, v.expect.error);
          assert.equal(r.error.code, -32602);
          assert.ok(r.error.message.length > 0);
        }
      } else {
        assert.ok(r.ok, r.ok ? "" : r.error.message);
        if (r.ok) assert.deepEqual(r.params, v.expect.params);
      }
    });
  }
});

describe("wallet vectors: results", () => {
  for (const v of vectors.results) {
    it(v.name, () => {
      const problems = resultProblems(v.method, v.result);
      assert.equal(problems.length === 0, v.valid, problems.join("; ") || "expected problems");
    });
  }
});

describe("wallet vectors: notifications", () => {
  for (const v of vectors.notifications) {
    it(v.name, () => {
      const problems = notificationProblems(v.notification);
      assert.equal(problems.length === 0, v.valid, problems.join("; ") || "expected problems");
    });
  }
});

describe("wallet vectors: connection requests", () => {
  for (const v of vectors.connection_requests) {
    it(v.name, () => {
      const problems = connectionRequestProblems(v.request);
      assert.equal(problems.length === 0, v.valid, problems.join("; ") || "expected problems");
    });
  }
});

describe("wallet vectors: preimages", () => {
  for (const v of vectors.preimages) {
    it(`${v.preimage.slice(0, 8)}… → ${v.payment_hash.slice(0, 8)}… is ${v.valid ? "" : "not "}proof`, async () => {
      assert.equal(await verifyPreimage(v.preimage, v.payment_hash), v.valid);
    });
  }
});

// The scenarios are a host's behaviour, which a WalletHost replays against a
// scripted wallet. Here: that each is well formed, so every implementation
// reads the same thing from it.
describe("wallet vectors: scenarios are well formed", () => {
  for (const s of vectors.scenarios) {
    it(s.name, () => {
      if (s.connection === null) {
        assert.ok(s.request, "a scenario with no connection names the app's request");
        assert.deepEqual(connectionRequestProblems(s.request), []);
      } else {
        for (const m of s.connection.methods) assert.ok((REQUESTABLE_METHODS as readonly string[]).includes(m), m);
        for (const n of s.connection.notification_types) assert.ok((NOTIFICATION_TYPES as readonly string[]).includes(n), n);
        assert.ok(["ask", "refuse"].includes(s.connection.over_budget));
      }
      // The gate every host applies after the params check: no connection →
      // UNAUTHORIZED, a method it does not grant → RESTRICTED. Followed here so
      // a scenario cannot contradict it.
      let granted: string[] | null = s.connection?.methods ?? null;
      for (const [i, step] of s.steps.entries()) {
        const at = `step ${i}`;
        const expect = step.expect as { result?: unknown; error?: string; notification?: unknown };
        assert.ok(expect, `${at}: expect`);
        if (step.call) {
          const call = step.call as { method: string; params?: unknown };
          assert.ok(isWalletMethod(call.method), `${at}: ${call.method}`);
          if (expect.error !== "BAD_REQUEST") {
            if (call.method === "connect") {
              const c = (expect.result as { connection?: { methods: string[] } } | undefined)?.connection;
              if (c) granted = c.methods;
            } else if (call.method !== "get_info") {
              if (granted === null) assert.equal(expect.error, "UNAUTHORIZED", `${at}: no connection yet`);
              else if (!granted.includes(call.method)) assert.equal(expect.error, "RESTRICTED", `${at}: ${call.method} is not granted`);
            }
          }
          assert.ok([null, "connect", "payment"].includes(step.sheet as string | null), `${at}: sheet`);
          if (step.sheet) assert.ok(["approve", "decline"].includes(step.person as string), `${at}: person`);
          const check = checkParams(call.method, call.params);
          if (expect.error === "BAD_REQUEST") assert.equal(check.ok, false, `${at}: a BAD_REQUEST call fails checkParams`);
          else assert.ok(check.ok, `${at}: ${check.ok ? "" : check.error.message}`);
          if ((PAY_METHODS as readonly string[]).includes(call.method) && call.method === "pay_invoice" && expect.error !== "BAD_REQUEST") {
            assert.ok((step.decoded as { amount?: number } | undefined)?.amount, `${at}: a pay_invoice step says what the host decodes`);
          }
          const wallet = step.wallet as null | { result?: unknown; error?: string };
          if (wallet?.result !== undefined) assert.deepEqual(resultProblems(call.method, wallet.result), [], `${at}: the wallet's answer`);
          if (wallet?.error !== undefined) assert.ok(isWalletErrorCode(wallet.error), `${at}: ${wallet.error}`);
          if (expect.error !== undefined) assert.ok(isWalletErrorCode(expect.error), `${at}: ${expect.error}`);
          else assert.deepEqual(resultProblems(call.method, expect.result), [], `${at}: the expected answer`);
        } else {
          assert.ok(step.wallet_event, `${at}: a call or a wallet_event`);
          assert.deepEqual(notificationProblems(step.wallet_event), [], `${at}: the wallet's event`);
          if (expect.notification !== null) assert.deepEqual(notificationProblems(expect.notification), [], `${at}: the expected notification`);
        }
      }
    });
  }
});

describe("wallet contract", () => {
  it("names methods under strut/wallet/", () => {
    assert.equal(walletRequestMethod("pay_keysend"), "strut/wallet/pay_keysend");
    assert.equal(walletMethodOf("strut/wallet/pay_keysend"), "pay_keysend");
    assert.equal(walletMethodOf("strut/wallet/drain_everything"), undefined);
    assert.equal(walletMethodOf("ui/message"), undefined);
    for (const m of WALLET_METHODS) assert.equal(walletMethodOf(walletRequestMethod(m)), m);
  });

  it("lets a request name every method but connect and get_info", () => {
    assert.ok(!(REQUESTABLE_METHODS as readonly string[]).includes("connect"));
    assert.ok(!(REQUESTABLE_METHODS as readonly string[]).includes("get_info"));
    assert.equal(REQUESTABLE_METHODS.length, WALLET_METHODS.length - 2);
  });

  it("splits a Sphinx address and puts the hint back the way the core pays async", () => {
    const pk = "02" + "a".repeat(64), lsp = "03" + "b".repeat(64);
    const a = parseSphinxAddress(`${pk}_${lsp}_1099511627776`);
    assert.deepEqual(a, { pubkey: pk, route_hints: [[{ pubkey: lsp, short_channel_id: "1099511627776" }]] });
    assert.equal(sphinxRouteHint(a!.route_hints[0]![0]!), `${lsp}_1099511627776`);
    assert.equal(parseSphinxAddress(pk), undefined);
    assert.equal(parseSphinxAddress(`${pk}:1099511627776`), undefined);
    assert.equal(sphinxRouteHint({ pubkey: lsp, short_channel_id: "800000x12x1" }), undefined);
  });

  it("answers errors as JSON-RPC with the wallet code in data", () => {
    assert.deepEqual(walletErrorBody("USER_REJECTED", "no"), { code: -32000, message: "no", data: { code: "USER_REJECTED" } });
    assert.equal(walletErrorBody("BAD_REQUEST", "x").code, -32602);
    assert.equal(walletErrorCodeOf({ code: -32000, message: "x", data: { code: "QUOTA_EXCEEDED" } }), "QUOTA_EXCEEDED");
    assert.equal(walletErrorCodeOf(new WalletError("RESTRICTED", "not granted")), "RESTRICTED");
    assert.equal(walletErrorCodeOf(new Error("boom")), "OTHER");
    assert.equal(walletErrorCodeOf({ data: { code: "MADE_UP" } }), "OTHER");
    assert.ok(ERROR_CODES.includes("USER_REJECTED"));
  });

  it("converts units the way WebLN shows them", () => {
    assert.equal(satsToMsat(21), 21000);
    assert.equal(msatToSats(21999), 21);
    assert.equal(satsToMsat(0.5), 500);
  });

  it("refuses metadata over NWC's 4096 characters", () => {
    const r = checkParams("make_invoice", { amount: 1000, metadata: { comment: "x".repeat(5000) } });
    assert.equal(r.ok, false);
  });
});
