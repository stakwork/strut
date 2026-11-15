/**
 * A public app's page and its visitor, as a test drives them through the
 * doors a deployment serves (plans/app-repos.md §5; plans/human-steps.md §5):
 * the page's identity from its public document, a visitor's sign-in — a
 * browser key, or a Sphinx account whose session keeps its address for a
 * payout — and the page's `step_run` call on `POST /public/mcp` (or a
 * member's page on `POST /mcp`). Shared by src/visitors.test.ts and
 * src/tasks/worker-door.test.ts and worker-loop.test.ts.
 */
import { createHash, webcrypto } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { STEP_RUN_TOOL } from "../apps/tools.js";

/** A server's routes, as `strut.app.request` answers a path. */
export type Fetch = (path: string, init?: RequestInit) => Response | Promise<Response>;

const subtle = webcrypto.subtle;
const json = { "content-type": "application/json" };
const hex = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("hex");
const utf8 = (s: string) => new TextEncoder().encode(s);
const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());

/** A browser's sign-in key (`key`: ECDSA P-256). */
export const p256Key = () => subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]) as Promise<CryptoKeyPair>;
export const p256Sign = async (key: CryptoKeyPair, message: string) => ({
  key: hex(await subtle.exportKey("raw", key.publicKey)),
  sig: hex(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, utf8(message))),
});

/** A Lightning signed message the way sphinx-rs's `sign_bytes` makes one
 *  (the kit's `sign_in_signatures` vectors are its real output, and
 *  src/visitors.test.ts checks the verifier against them): for keys a test
 *  makes. `[31 + recid] ‖ r ‖ s` over sha256d("Lightning Signed Message:" ‖ message). */
export const lnSign = (priv: Uint8Array, message: string) => {
  const s = secp256k1.sign(sha256(sha256(new Uint8Array([...utf8("Lightning Signed Message:"), ...utf8(message)]))), priv);
  return new Uint8Array([31 + s.recovery!, ...s.toCompactRawBytes()]);
};

/** A JPEG's first bytes and some more: what the camera hands a page. */
export const jpeg = (n: number, fill = 0) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n - 4, fill)]);

async function signIn(req: Fetch, body: (challenge: string) => Promise<Record<string, unknown>>) {
  const { challenge } = (await (await req("/visitors/challenge")).json()) as { challenge: string };
  const res = await req("/visitors/session", { method: "POST", headers: json, body: JSON.stringify(await body(challenge)) });
  if (res.status !== 200) throw new Error(`sign-in refused: ${res.status} ${await res.text()}`);
  return (await res.json()) as { actor: string; token: string };
}

/** A visitor signs in with a new browser key: its actor and token. */
export const keySignIn = (req: Fetch) => p256Key().then((key) => signIn(req, async (c) => ({ challenge: c, method: "key", ...(await p256Sign(key, c)) })));

/** A Sphinx account signs in as Peel does (`sphinx`): its key signs the
 *  challenge as a Lightning message and it sends its Sphinx address, which
 *  the session keeps (src/visitors.ts `keptSphinxAddress`) for `task/withdraw`
 *  to keysend to. The address is the account's own pubkey behind any LSP.
 *  The public view must offer `sphinx`, with the default root `visitorKey`. */
export async function sphinxSignIn(req: Fetch, priv: Uint8Array = secp256k1.utils.randomPrivateKey()) {
  const key = hex(secp256k1.getPublicKey(priv, true));
  const address = `${key}_03${"ab".repeat(32)}_1099511627776`;
  const session = await signIn(req, async (c) => ({ challenge: c, method: "sphinx", key, sig: hex(lnSign(priv, c)), address }));
  return { ...session, address };
}

/** The page's identity: the `strut-app-token` its public document carries. */
export async function publicAppToken(req: Fetch, name: string): Promise<string> {
  const html = await (await req(`/public/apps/${name}/document`)).text();
  const token = html.match(/<meta name="strut-app-token" content="([^"]+)">/)?.[1];
  if (!token) throw new Error(`no strut-app-token in /public/apps/${name}/document: ${html.slice(0, 300)}`);
  return token.replace(/&amp;/g, "&");
}

/** A page's call on a door (`/public/mcp`, `/mcp`), as its host sends it:
 *  the step's output, or its refusal's text. */
export async function stepCall(req: Fetch, path: string, type: string, config: Record<string, unknown>, headers: Record<string, string>, app: string) {
  const res = await req(path, {
    method: "POST",
    headers: { ...json, accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: STEP_RUN_TOOL, arguments: { type, config, app } } }),
  });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`${path} ${type}: ${res.status} ${text.slice(0, 500)}`);
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const body = line ? JSON.parse(line.slice(6)) : JSON.parse(text);
  const out = JSON.parse(body.result.content[0].text) as Record<string, any>;
  return body.result.isError ? { error: out["error"] as string } : { result: out };
}

/** Sets each variable (undefined unsets it); answers the restore. */
export function setEnv(vars: Record<string, string | undefined>): () => void {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const put = (v: Record<string, string | undefined>) => {
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) delete process.env[k];
      else process.env[k] = x;
    }
  };
  put(vars);
  return () => put(saved);
}
