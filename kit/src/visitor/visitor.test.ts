import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ACCOUNT_CAPABILITY, ACCOUNT_PLACEMENT_METHOD, NO_ACCOUNT, createBridgeAccount, NO_VISITOR, VISITOR_CAPABILITY, VISITOR_SIGN_IN_METHOD, VISITOR_SIGN_OUT_METHOD, createBridgeVisitor, visitorCapabilityOf } from "./index.js";

/** An `App` whose host offered `capability` and answers sign-in with `answer`. */
const app = (capability: unknown, answer: unknown = { actor: "p256:02ab" }) => {
  const asked: string[] = [];
  return {
    asked,
    getHostCapabilities: () => (capability === undefined ? {} : { experimental: { [VISITOR_CAPABILITY]: capability } }),
    request: async (r: { method: string }) => {
      asked.push(r.method);
      return r.method === VISITOR_SIGN_IN_METHOD ? answer : {};
    },
  };
};

describe("the visitor contract (plans/app-repos.md §5)", () => {
  it("reads the host's capability: the methods, and who is signed in", () => {
    assert.deepEqual(visitorCapabilityOf({ experimental: { [VISITOR_CAPABILITY]: { v: 1, methods: ["key", 7], actor: "p256:01" } } }), { v: 1, methods: ["key"], actor: "p256:01" });
    assert.equal(visitorCapabilityOf({ experimental: { [VISITOR_CAPABILITY]: { v: 2 } } }), undefined);
    assert.equal(visitorCapabilityOf(undefined), undefined);
  });

  it("signIn asks the host and follows its answer; signOut forgets; a closed sheet is undefined", async () => {
    const a = app({ v: 1, methods: ["key"] });
    const v = createBridgeVisitor(a);
    let changes = 0;
    v.subscribe(() => changes++);
    assert.equal(v.available(), true);
    assert.equal(v.actor(), undefined);
    assert.equal(await v.signIn(), "p256:02ab");
    assert.equal(v.actor(), "p256:02ab");
    await v.signOut();
    assert.equal(v.actor(), undefined);
    assert.deepEqual(a.asked, [VISITOR_SIGN_IN_METHOD, VISITOR_SIGN_OUT_METHOD]);
    assert.equal(changes, 2);
    assert.equal(await createBridgeVisitor(app({ v: 1, methods: ["key"] }, {})).signIn(), undefined, "closed");
    assert.equal(createBridgeVisitor(app({ v: 1, methods: [], actor: "secp:aa" })).actor(), "secp:aa", "signed in before the page started");
  });

  it("a silent sign-in asks with `{ silent: true }`; a plain one with no params; a silent `{}` is not signed in", async () => {
    const params: unknown[] = [];
    const recording = (answer: unknown) => ({
      getHostCapabilities: () => ({ experimental: { [VISITOR_CAPABILITY]: { v: 1, methods: ["sphinx"] } } }),
      request: async (r: { method: string; params?: unknown }) => {
        params.push(r.params);
        return answer;
      },
    });
    assert.equal(await createBridgeVisitor(recording({ actor: "secp:aa" })).signIn({ silent: true }), "secp:aa");
    assert.equal(await createBridgeVisitor(recording({ actor: "secp:aa" })).signIn(), "secp:aa");
    const quiet = createBridgeVisitor(recording({}));
    assert.equal(await quiet.signIn({ silent: true }), undefined);
    assert.equal(quiet.actor(), undefined);
    assert.deepEqual(params, [{ silent: true }, {}, { silent: true }]);
  });

  it("a host with no sign-in: unavailable, and asking says so", async () => {
    const v = createBridgeVisitor(app(undefined));
    assert.equal(v.available(), false);
    await assert.rejects(v.signIn(), /offers no sign-in/);
    await assert.rejects(NO_VISITOR.signIn(), /offers no sign-in/);
    assert.equal(NO_VISITOR.actor(), undefined);
  });
});

describe("the account widget contract", () => {
  it("is available only when the host offers it; setPlacement asks the host with the params as given", async () => {
    const asked: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const mk = (cap: unknown) => createBridgeAccount({
      getHostCapabilities: () => (cap === undefined ? {} : { experimental: { [ACCOUNT_CAPABILITY]: cap } }),
      request: async (r) => (asked.push(r), {}),
    });
    const on = mk({ v: 1 });
    assert.equal(on.available(), true);
    await on.setPlacement({ corner: "bottom-left", collapsed: true });
    assert.deepEqual(asked, [{ method: ACCOUNT_PLACEMENT_METHOD, params: { corner: "bottom-left", collapsed: true } }]);
    assert.equal(mk(undefined).available(), false);
    await assert.rejects(mk(undefined).setPlacement({ collapsed: true }), /no account widget/);
    assert.equal(NO_ACCOUNT.available(), false);
  });
});
