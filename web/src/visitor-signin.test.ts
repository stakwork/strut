// A page's SILENT sign-in (./visitor-signin `signInSilently`): what Tasks
// asks as it loads in Peel. Only the native wallet, only its answer as it
// stands — no strut sheet, no browser key, no other method.
import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { SignInAnswerOf, SignInAsk } from "./native-pay";
import { signInSilently } from "./visitor-signin";

/** The seller's two routes, answered as strut answers them. */
function seller(o: { session?: { status: number; body: unknown } } = {}) {
  const asked: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    asked.push(String(url));
    if (String(url).endsWith("/visitors/challenge")) return new Response(JSON.stringify({ challenge: "strut-visitor.c.h" }), { status: 200 });
    const s = o.session ?? { status: 200, body: { actor: "secp:aa", token: "t", exp: 9e15 } };
    return new Response(JSON.stringify(s.body), { status: s.status });
  });
  return asked;
}

const wallet = (answer: SignInAnswerOf): SignInAsk & { signed: string[] } => {
  const signed: string[] = [];
  return { name: "Peel", signed, sign: async (c) => (signed.push(c), answer) };
};
const GRANTED: SignInAnswerOf = { outcome: "signed", key: "02ab", sig: "1f00" };
const UNTAPPED: SignInAnswerOf = { outcome: "refused", code: "RESTRICTED", message: "Peel asks you to sign in only right after you click or tap in the app.", declined: false };

afterEach(() => mock.restoreAll());

describe("signInSilently: a page signs in as it loads only when nobody has to say yes", () => {
  it("Peel holding a grant signs the seller's challenge: the session", async () => {
    const asked = seller();
    const peel = wallet(GRANTED);
    const s = await signInSilently(["sphinx"], peel);
    assert.equal(s?.actor, "secp:aa");
    assert.deepEqual(peel.signed, ["strut-visitor.c.h"]);
    assert.deepEqual(asked, ["/visitors/challenge", "/visitors/session"]);
  });

  it("Peel refusing an untapped ask, or the server refusing the signature: null, and nothing else tried", async () => {
    seller();
    assert.equal(await signInSilently(["sphinx", "key", "lnurl"], wallet(UNTAPPED)), null);
    mock.restoreAll();
    seller({ session: { status: 401, body: { error: "signature does not hold" } } });
    assert.equal(await signInSilently(["sphinx"], wallet(GRANTED)), null);
  });

  it("no native wallet, or a seller that does not offer sphinx: null, with no request at all", async () => {
    const asked = seller();
    assert.equal(await signInSilently(["sphinx", "key"], undefined), null);
    const peel = wallet(GRANTED);
    assert.equal(await signInSilently(["key", "lnurl"], peel), null);
    assert.deepEqual(asked, []);
    assert.deepEqual(peel.signed, []);
  });
});
