/**
 * An NWC wallet (NIP-47) as the server's wallet (plans/paid-runs.md §9,
 * decision 7: second after the Sphinx daemon) — a seller with Alby Hub,
 * LNbits or any NWC wallet. `NwcProvider` holds a RECEIVE connection URL: it
 * calls `make_invoice`, `lookup_invoice`, `list_transactions` and
 * `get_balance`, never a pay method. A connection that may pay is the
 * payer's (payer.ts), through the same `NwcClient`.
 *
 * One call: open a socket to the connection's relay (the first that
 * answers), read the wallet's info event (kind 13194: what it allows and
 * whether it speaks NIP-44; cached ten minutes), subscribe to the answer,
 * publish the request (kind 23194, signed with the connection's secret,
 * encrypted to the wallet), wait for the wallet's answer (kind 23195 naming
 * the request), check its id and signature, decrypt, close.
 *
 * The method names, units (msat) and error codes are NWC's, as the app
 * wallet contract has them (`kit/src/wallet/protocol.ts`, which engine code
 * cannot import; nwc.test.ts holds the names here equal to it).
 *
 * `@noble/curves` (BIP-340 signatures) is imported on first use, the lib
 * step convention; the ciphers are node:crypto's.
 */

import { createCipheriv, createDecipheriv, createECDH, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { LightningError, checkPaymentHash, type Invoice, type InvoiceLookup, type LightningProvider, type ReceivedPayment } from "./lightning.js";
import { parseNwcUrl, type NwcConnection } from "./nwc-url.js";

/** NIP-47's event kinds. */
export const NWC_INFO_KIND = 13194;
export const NWC_REQUEST_KIND = 23194;
export const NWC_RESPONSE_KIND = 23195;

/** The methods this provider calls: receive only. */
export const NWC_RECEIVE_METHODS = ["make_invoice", "lookup_invoice", "list_transactions", "get_balance"] as const;
export type NwcReceiveMethod = (typeof NWC_RECEIVE_METHODS)[number];

/** NWC's error codes → what a strut caller does with them. */
export const NWC_ERROR_MAP: Record<string, LightningError["code"]> = {
  UNAUTHORIZED: "wallet_unauthorized",
  RESTRICTED: "wallet_unauthorized",
  NOT_FOUND: "invoice_unknown",
  RATE_LIMITED: "wallet_unavailable",
  INTERNAL: "wallet_unavailable",
  NOT_IMPLEMENTED: "wallet_refused",
  BAD_REQUEST: "wallet_refused",
  QUOTA_EXCEEDED: "wallet_refused",
  INSUFFICIENT_BALANCE: "wallet_refused",
  PAYMENT_FAILED: "wallet_refused",
  OTHER: "wallet_refused",
};

/** How long one call may take, the relay's connection included. */
export const NWC_TIMEOUT_MS = 15_000;
/** How long the wallet's info event is believed. */
export const NWC_INFO_TTL_MS = 10 * 60_000;

/** NWC's transaction object, the fields read here (kit's `Transaction`). */
interface NwcTransaction {
  type?: string;
  state?: string;
  invoice?: string;
  payment_hash?: string;
  preimage?: string;
  amount?: number;
  created_at?: number;
  expires_at?: number;
  settled_at?: number;
}

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

type Encryption = "nip44_v2" | "nip04";

/** What a socket needs to be: the global `WebSocket`'s surface. */
export interface NwcSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "error" | "close", listener: (ev: { data?: unknown }) => void): void;
}
export type NwcSocketFactory = (url: string) => NwcSocket;

export interface NwcProviderOptions {
  url: string;
  timeoutMs?: number;
  /** How a relay socket is opened: the global `WebSocket` by default. */
  socket?: NwcSocketFactory;
}

// ── crypto: NIP-01 events, NIP-04 and NIP-44 v2 ───────────────────────────

let noble: Promise<typeof import("@noble/curves/secp256k1")> | null = null;
const schnorr = async () => (await (noble ??= import("@noble/curves/secp256k1"))).schnorr;

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** A secret key's x-only public key, hex. */
export async function publicKeyOf(secret: string): Promise<string> {
  return hex((await schnorr()).getPublicKey(Buffer.from(secret, "hex")));
}

/** NIP-01: the event's id is the sha256 of its serialization. */
export function eventId(e: Omit<NostrEvent, "id" | "sig">): string {
  return createHash("sha256").update(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])).digest("hex");
}

export async function signEvent(e: Omit<NostrEvent, "id" | "sig" | "pubkey">, secret: string): Promise<NostrEvent> {
  const pubkey = await publicKeyOf(secret);
  const id = eventId({ ...e, pubkey });
  const sig = hex((await schnorr()).sign(Buffer.from(id, "hex"), Buffer.from(secret, "hex")));
  return { ...e, pubkey, id, sig };
}

/** An event whose id is its content's and whose signature is its pubkey's. */
export async function verifyEvent(e: NostrEvent): Promise<boolean> {
  try {
    if (eventId(e) !== e.id) return false;
    return (await schnorr()).verify(Buffer.from(e.sig, "hex"), Buffer.from(e.id, "hex"), Buffer.from(e.pubkey, "hex"));
  } catch {
    return false;
  }
}

/** The x coordinate of secret × pubkey (x-only, even y): what both NIP-04
 *  and NIP-44 key from. */
function sharedX(secret: string, pubkey: string): Buffer {
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(Buffer.from(secret, "hex"));
  return ecdh.computeSecret(Buffer.from(`02${pubkey}`, "hex"));
}

/** NIP-04: AES-256-CBC under the shared x, `<base64>?iv=<base64>`. */
export function nip04Encrypt(secret: string, pubkey: string, text: string, iv: Buffer = randomBytes(16)): string {
  const c = createCipheriv("aes-256-cbc", sharedX(secret, pubkey), iv);
  return `${Buffer.concat([c.update(text, "utf8"), c.final()]).toString("base64")}?iv=${iv.toString("base64")}`;
}

export function nip04Decrypt(secret: string, pubkey: string, payload: string): string {
  const m = /^([A-Za-z0-9+/=]+)\?iv=([A-Za-z0-9+/=]+)$/.exec(payload);
  if (!m) throw new Error("not a NIP-04 payload");
  const d = createDecipheriv("aes-256-cbc", sharedX(secret, pubkey), Buffer.from(m[2]!, "base64"));
  return Buffer.concat([d.update(Buffer.from(m[1]!, "base64")), d.final()]).toString("utf8");
}

/** NIP-44 v2's conversation key: HKDF-extract(sha256, shared x, "nip44-v2"). */
export function nip44ConversationKey(secret: string, pubkey: string): Buffer {
  return createHmac("sha256", "nip44-v2").update(sharedX(secret, pubkey)).digest();
}

/** HKDF-expand(sha256) to 76 bytes: ChaCha20 key, ChaCha20 nonce, HMAC key. */
function nip44Keys(conversationKey: Buffer, nonce: Buffer): { key: Buffer; iv: Buffer; hmac: Buffer } {
  const blocks: Buffer[] = [];
  let t: Buffer = Buffer.alloc(0);
  for (let i = 1; blocks.length * 32 < 76; i++) {
    t = createHmac("sha256", conversationKey).update(Buffer.concat([t, nonce, Buffer.from([i])])).digest();
    blocks.push(t);
  }
  const okm = Buffer.concat(blocks);
  // node's chacha20 takes a 16-byte IV: a 32-bit little-endian counter (0), then the nonce.
  return { key: okm.subarray(0, 32), iv: Buffer.concat([Buffer.alloc(4), okm.subarray(32, 44)]), hmac: okm.subarray(44, 76) };
}

function nip44PaddedLength(len: number): number {
  if (len <= 32) return 32;
  const nextPower = 1 << (Math.floor(Math.log2(len - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((len - 1) / chunk) + 1);
}

export function nip44Encrypt(conversationKey: Buffer, text: string, nonce: Buffer = randomBytes(32)): string {
  const plain = Buffer.from(text, "utf8");
  if (plain.length < 1 || plain.length > 65535) throw new Error("NIP-44 carries 1 to 65535 bytes");
  const padded = Buffer.alloc(2 + nip44PaddedLength(plain.length));
  padded.writeUInt16BE(plain.length, 0);
  plain.copy(padded, 2);
  const k = nip44Keys(conversationKey, nonce);
  const c = createCipheriv("chacha20", k.key, k.iv);
  const ct = Buffer.concat([c.update(padded), c.final()]);
  const mac = createHmac("sha256", k.hmac).update(Buffer.concat([nonce, ct])).digest();
  return Buffer.concat([Buffer.from([2]), nonce, ct, mac]).toString("base64");
}

export function nip44Decrypt(conversationKey: Buffer, payload: string): string {
  const raw = Buffer.from(payload, "base64");
  if (raw.length < 99 || raw[0] !== 2) throw new Error("not a NIP-44 v2 payload");
  const nonce = raw.subarray(1, 33);
  const ct = raw.subarray(33, raw.length - 32);
  const mac = raw.subarray(raw.length - 32);
  const k = nip44Keys(conversationKey, nonce);
  const want = createHmac("sha256", k.hmac).update(Buffer.concat([nonce, ct])).digest();
  if (!timingSafeEqual(want, mac)) throw new Error("NIP-44 payload's MAC does not match");
  const d = createDecipheriv("chacha20", k.key, k.iv);
  const padded = Buffer.concat([d.update(ct), d.final()]);
  const len = padded.readUInt16BE(0);
  if (len < 1 || 2 + nip44PaddedLength(len) !== padded.length) throw new Error("NIP-44 payload's padding is wrong");
  return padded.subarray(2, 2 + len).toString("utf8");
}

// ── a relay socket ───────────────────────────────────────────────────────

/** One relay connection: what came in is queued, and `next` waits for the
 *  first message a predicate accepts. */
class Relay {
  readonly #socket: NwcSocket;
  readonly #queue: unknown[][] = [];
  #waiters: Array<{ pick: (m: unknown[]) => boolean; resolve: (m: unknown[]) => void; reject: (e: Error) => void }> = [];
  #closed: Error | null = null;

  private constructor(socket: NwcSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (ev) => {
      let msg: unknown;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString("utf8"));
      } catch {
        return;
      }
      if (!Array.isArray(msg)) return;
      const w = this.#waiters.find((x) => x.pick(msg as unknown[]));
      if (w) {
        this.#waiters = this.#waiters.filter((x) => x !== w);
        w.resolve(msg);
      } else this.#queue.push(msg);
    });
    socket.addEventListener("close", () => this.#fail(new Error("the relay closed the connection")));
    socket.addEventListener("error", () => this.#fail(new Error("the relay connection failed")));
  }

  #fail(err: Error) {
    this.#closed ??= err;
    for (const w of this.#waiters) w.reject(err);
    this.#waiters = [];
  }

  static open(factory: NwcSocketFactory, url: string, deadline: number): Promise<Relay> {
    return new Promise((resolve, reject) => {
      let socket: NwcSocket;
      try {
        socket = factory(url);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const timer = setTimeout(() => {
        reject(new Error("no connection in time"));
        try {
          socket.close();
        } catch {}
      }, Math.max(0, deadline - Date.now()));
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new Relay(socket));
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("the connection failed"));
      });
    });
  }

  send(msg: unknown[]): void {
    if (this.#closed) throw this.#closed;
    this.#socket.send(JSON.stringify(msg));
  }

  next(pick: (m: unknown[]) => boolean, deadline: number): Promise<unknown[]> {
    const i = this.#queue.findIndex(pick);
    if (i >= 0) return Promise.resolve(this.#queue.splice(i, 1)[0]!);
    if (this.#closed) return Promise.reject(this.#closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((x) => x !== w);
        reject(new Error("no answer in time"));
      }, Math.max(0, deadline - Date.now()));
      const w = {
        pick,
        resolve: (m: unknown[]) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.#waiters.push(w);
    });
  }

  close(): void {
    this.#fail(new Error("closed"));
    try {
      this.#socket.close();
    } catch {}
  }
}

const isEvent = (v: unknown): v is NostrEvent =>
  !!v && typeof v === "object" && typeof (v as NostrEvent).id === "string" && typeof (v as NostrEvent).pubkey === "string" && typeof (v as NostrEvent).sig === "string" && typeof (v as NostrEvent).content === "string" && Array.isArray((v as NostrEvent).tags);

const subId = () => randomBytes(8).toString("hex");

// ── a connection ─────────────────────────────────────────────────────────

interface WalletInfoEvent {
  methods: Set<string>;
  encryption: Encryption;
  at: number;
}

export interface NwcRequestOptions {
  /** How long this call may take; the client's own by default. */
  timeoutMs?: number;
  /** Called once the request is on the relay (it said OK, or no relay
   *  answer came before the wallet's): from then on the wallet may act on
   *  it, so a call that ends without an answer did not necessarily do
   *  nothing. The payer reads a pay with no answer as pending. */
  onPublished?: () => void;
}

/**
 * One NWC connection URL and its calls: any NIP-47 method, signed with the
 * connection's key and encrypted as the wallet says. What a caller may do is
 * what the CONNECTION allows: `NwcProvider` holds a receive connection and
 * calls the receive methods; the payer (payer.ts) holds the pay connection.
 */
export class NwcClient {
  readonly #conn: NwcConnection;
  readonly #timeoutMs: number;
  readonly #socket: NwcSocketFactory;
  #info: WalletInfoEvent | null = null;

  constructor(opts: NwcProviderOptions) {
    this.#conn = parseNwcUrl(opts.url);
    this.#timeoutMs = opts.timeoutMs ?? NWC_TIMEOUT_MS;
    this.#socket = opts.socket ?? ((url) => new (globalThis as unknown as { WebSocket: new (url: string) => NwcSocket }).WebSocket(url));
  }

  /** The relays' hosts, for a message (a relay URL may carry a query). */
  get where(): string {
    return this.#conn.relays.map((r) => new URL(r).host).join(", ");
  }

  async #connect(deadline: number): Promise<Relay> {
    const failures: string[] = [];
    for (const url of this.#conn.relays) {
      try {
        return await Relay.open(this.#socket, url, deadline);
      } catch (err) {
        failures.push(`${new URL(url).host}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new LightningError("wallet_unavailable", `no NWC relay answered (${failures.join("; ")})`);
  }

  /** The wallet's info event: what it allows, and NIP-44 when it says so
   *  (no info event, or no `encryption` tag, is NIP-04: NIP-47's rule). */
  async #readInfo(relay: Relay, deadline: number): Promise<WalletInfoEvent> {
    if (this.#info && Date.now() - this.#info.at < NWC_INFO_TTL_MS) return this.#info;
    const sub = subId();
    relay.send(["REQ", sub, { kinds: [NWC_INFO_KIND], authors: [this.#conn.walletPubkey], limit: 1 }]);
    let found: NostrEvent | null = null;
    // The info event or the end of stored events, whichever comes; a relay
    // that answers neither in a third of the call's time has none.
    const until = Math.min(deadline, Date.now() + this.#timeoutMs / 3);
    for (;;) {
      let msg: unknown[];
      try {
        msg = await relay.next((m) => (m[0] === "EVENT" || m[0] === "EOSE" || m[0] === "CLOSED") && m[1] === sub, until);
      } catch {
        break;
      }
      if (msg[0] !== "EVENT") break;
      const e = msg[2];
      if (isEvent(e) && e.kind === NWC_INFO_KIND && e.pubkey === this.#conn.walletPubkey && (await verifyEvent(e))) {
        found = e;
        break;
      }
    }
    try {
      relay.send(["CLOSE", sub]);
    } catch {}
    const encTag = found?.tags.find((t) => t[0] === "encryption")?.[1] ?? "";
    const info: WalletInfoEvent = {
      methods: new Set((found?.content ?? "").split(/\s+/).filter(Boolean)),
      encryption: encTag.split(/\s+/).includes("nip44_v2") ? "nip44_v2" : "nip04",
      at: Date.now(),
    };
    // Only a found event is kept: a relay that had none this time may next.
    if (found) this.#info = info;
    return info;
  }

  async request(method: string, params: Record<string, unknown>, opts: NwcRequestOptions = {}): Promise<Record<string, unknown>> {
    const deadline = Date.now() + (opts.timeoutMs ?? this.#timeoutMs);
    const relay = await this.#connect(deadline);
    let published = false;
    const publish = () => {
      if (published) return;
      published = true;
      opts.onPublished?.();
    };
    try {
      const info = await this.#readInfo(relay, deadline);
      if (info.methods.size > 0 && !info.methods.has(method)) {
        throw new LightningError("wallet_unauthorized", `the NWC connection does not allow ${method} (it allows ${[...info.methods].sort().join(", ")})`);
      }
      const { secret, walletPubkey } = this.#conn;
      const plain = JSON.stringify({ method, params });
      const content = info.encryption === "nip44_v2" ? nip44Encrypt(nip44ConversationKey(secret, walletPubkey), plain) : nip04Encrypt(secret, walletPubkey, plain);
      const tags = [["p", walletPubkey], ...(info.encryption === "nip44_v2" ? [["encryption", "nip44_v2"]] : [])];
      const request = await signEvent({ kind: NWC_REQUEST_KIND, created_at: Math.floor(Date.now() / 1000), tags, content }, secret);
      const sub = subId();
      relay.send(["REQ", sub, { kinds: [NWC_RESPONSE_KIND], authors: [walletPubkey], "#e": [request.id] }]);
      relay.send(["EVENT", request]);
      for (;;) {
        let msg: unknown[];
        try {
          msg = await relay.next(
            (m) => (m[0] === "EVENT" && m[1] === sub) || (m[0] === "OK" && m[1] === request.id) || (m[0] === "CLOSED" && m[1] === sub),
            deadline,
          );
        } catch (err) {
          throw new LightningError("wallet_unavailable", `the NWC wallet did not answer ${method} through ${this.where}: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (msg[0] === "OK") {
          if (msg[2] === false) throw new LightningError("wallet_unavailable", `the NWC relay refused ${method}'s request: ${String(msg[3] ?? "")}`.trim());
          publish();
          continue;
        }
        if (msg[0] === "CLOSED") throw new LightningError("wallet_unavailable", `the NWC relay closed ${method}'s subscription: ${String(msg[2] ?? "")}`.trim());
        const e = msg[2];
        if (!isEvent(e) || e.kind !== NWC_RESPONSE_KIND || e.pubkey !== walletPubkey) continue;
        if (!e.tags.some((t) => t[0] === "e" && t[1] === request.id)) continue;
        if (!(await verifyEvent(e))) continue;
        publish();
        let body: { result_type?: unknown; error?: { code?: unknown; message?: unknown } | null; result?: unknown };
        try {
          const text = info.encryption === "nip44_v2" ? nip44Decrypt(nip44ConversationKey(secret, walletPubkey), e.content) : nip04Decrypt(secret, walletPubkey, e.content);
          body = JSON.parse(text);
        } catch (err) {
          throw new LightningError("wallet_bad_answer", `the NWC wallet's answer to ${method} could not be read: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (body.error) {
          const code = typeof body.error.code === "string" ? body.error.code : "OTHER";
          const message = typeof body.error.message === "string" ? body.error.message : code;
          throw new LightningError(NWC_ERROR_MAP[code] ?? "wallet_refused", `the NWC wallet refused ${method}: ${code}: ${message}`, code);
        }
        if (!body.result || typeof body.result !== "object") throw new LightningError("wallet_bad_answer", `the NWC wallet answered ${method} with no result`);
        return body.result as Record<string, unknown>;
      }
    } finally {
      relay.close();
    }
  }
}

// ── the provider ─────────────────────────────────────────────────────────

export class NwcProvider implements LightningProvider {
  readonly #client: NwcClient;

  constructor(opts: NwcProviderOptions) {
    this.#client = new NwcClient(opts);
  }

  /** Receive methods only: this connection is never asked to pay. */
  #request(method: NwcReceiveMethod, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.#client.request(method, params);
  }

  async makeInvoice(o: { msat: number; description?: string; expirySecs?: number }): Promise<Invoice> {
    const r = (await this.#request("make_invoice", {
      amount: o.msat,
      ...(o.description !== undefined ? { description: o.description } : {}),
      ...(o.expirySecs !== undefined ? { expiry: o.expirySecs } : {}),
    })) as NwcTransaction;
    if (typeof r.invoice !== "string" || !r.invoice) throw new LightningError("wallet_bad_answer", "the NWC wallet's make_invoice answered no invoice");
    if (typeof r.payment_hash !== "string" || !/^[0-9a-fA-F]{64}$/.test(r.payment_hash)) throw new LightningError("wallet_bad_answer", "the NWC wallet's make_invoice answered no payment_hash");
    const created = typeof r.created_at === "number" ? r.created_at : Math.floor(Date.now() / 1000);
    // BOLT11's default expiry is an hour.
    const expires = typeof r.expires_at === "number" ? r.expires_at : created + (o.expirySecs ?? 3600);
    return { invoice: r.invoice, payment_hash: r.payment_hash.toLowerCase(), expires: new Date(expires * 1000).toISOString() };
  }

  async lookup(payment_hash: string): Promise<InvoiceLookup> {
    const hash = checkPaymentHash(payment_hash);
    const r = (await this.#request("lookup_invoice", { payment_hash: hash })) as NwcTransaction;
    if (typeof r.payment_hash === "string" && r.payment_hash.toLowerCase() !== hash) throw new LightningError("wallet_bad_answer", "the NWC wallet answered for another invoice");
    // NWC-09 says `state`; a wallet from before it says settled by `settled_at`.
    const settled = r.state === "settled" || (r.state === undefined && typeof r.settled_at === "number");
    if (!settled) {
      const expired = r.state === "expired" || r.state === "failed" || (typeof r.expires_at === "number" && r.expires_at * 1000 <= Date.now());
      return { state: expired ? "expired" : "pending" };
    }
    if (typeof r.amount !== "number" || !Number.isSafeInteger(r.amount) || r.amount < 0) throw new LightningError("wallet_bad_answer", "the NWC wallet's settled invoice has no amount");
    let preimage: string | undefined;
    if (typeof r.preimage === "string" && r.preimage) {
      preimage = r.preimage.toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(preimage) || createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex") !== hash) {
        throw new LightningError("wallet_bad_answer", "the NWC wallet's preimage does not hash to the invoice's payment hash");
      }
    }
    return {
      state: "settled",
      msat: r.amount,
      ...(typeof r.settled_at === "number" ? { settled_at: new Date(r.settled_at * 1000).toISOString() } : {}),
      ...(preimage ? { preimage } : {}),
    };
  }

  async received(o: { since?: string; limit?: number }): Promise<ReceivedPayment[]> {
    const since = o.since ? Math.floor(Date.parse(o.since) / 1000) : undefined;
    const r = await this.#request("list_transactions", {
      type: "incoming",
      unpaid: false,
      ...(since !== undefined ? { from: since } : {}),
      ...(o.limit !== undefined ? { limit: o.limit } : {}),
    });
    if (!Array.isArray(r["transactions"])) throw new LightningError("wallet_bad_answer", "the NWC wallet's list_transactions answered no transactions");
    const out: ReceivedPayment[] = [];
    for (const t of r["transactions"] as NwcTransaction[]) {
      if (!t || typeof t !== "object" || t.type === "outgoing") continue;
      const settled = t.state === "settled" || (t.state === undefined && typeof t.settled_at === "number");
      if (!settled || typeof t.payment_hash !== "string" || typeof t.amount !== "number") continue;
      const at = typeof t.settled_at === "number" ? t.settled_at : t.created_at;
      if (typeof at !== "number" || (since !== undefined && at < since)) continue;
      out.push({ payment_hash: t.payment_hash.toLowerCase(), msat: t.amount, at: new Date(at * 1000).toISOString() });
    }
    out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    return o.limit !== undefined ? out.slice(0, o.limit) : out;
  }

  async balance(): Promise<{ msat: number }> {
    const r = await this.#request("get_balance", {});
    const b = r["balance"];
    if (typeof b !== "number" || !Number.isSafeInteger(b) || b < 0) throw new LightningError("wallet_bad_answer", "the NWC wallet's get_balance answered no balance");
    return { msat: b };
  }
}
