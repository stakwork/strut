/**
 * A stand-in for the Sphinx treasury daemon (specs/LIGHTNING.md), so strut
 * runs locally, and in end-to-end tests, with payments in and payouts out and
 * no mixer: point LIGHTNING_DAEMON_URL at it (docs/running.md, "Payments
 * locally").
 *
 * IN, with the receive token (or the pay token, which opens them too):
 * `POST /invoice { sats, description?, expiry? }` makes a readable BOLT11
 * (zero-signed, src/payments/bolt11.ts `encodeBolt11`) with a real preimage;
 * it SETTLES on its own `SETTLE_AFTER_MS` after it was made, as if someone
 * paid it (0: only by hand), or at once on `POST /settle/:payment_hash`.
 * `GET /invoice/:payment_hash`, `GET /payments?since=`, `GET /balance`.
 *
 * OUT, with the pay token alone (the receive token is 403): `POST /pay
 * { invoice, max_fee_msat }`, idempotent per payment hash (only a failed one
 * is paid again), and `POST /keysend { id, address, msat, max_fee_msat }` +
 * `GET /keysend/:id`, idempotent on `id`, as src/payments/payer.test.ts's
 * stand-ins answer. Each debits the balance by the amount and a fee of the
 * LSP's own floor (`lspFeeFloorMsat`); one the balance cannot cover fails
 * with "not enough balance". `POST /next-payout { state: "failed" | "pending" }`
 * makes the next pay or keysend fail, or stay pending until `POST /settle/:x`
 * (a payment hash, or a keysend's id).
 *
 * INVITES, with the pay token alone (plans/human-steps.md §5.8): `POST
 * /invite { sats }` debits `sats` and the mixer's price (`INVITE_PRICE_SATS`)
 * and answers `{ code, link, sats, status, createdAt }`, `link` a
 * `sphinx.chat://?action=i&d=…` the core reads; `ready` at once, or as
 * `/next-payout` says (`pending` is `sending` until `POST /settle/:code`,
 * `failed` gives the sats back). `GET /invites`, and `POST
 * /invite/:code/cancel`, which gives back what an unused one held (`409
 * not_cancellable` once used). `POST /use-invite/:code` marks one used, as
 * a new account taking it would.
 *
 * DMS, with the MESSAGE token alone (plans/support-chat.md §7, as
 * stakwork/sphinx#435 built them; the other two are 403, and it opens
 * nothing else): `GET /dms?after=<seq>&limit=` (1 to 1,000, 100 by default)
 * answers `{ dms }`, 1:1 records oldest first under a `seq` of its own — a
 * record that changes (a send's status, a deletion) comes again under a new
 * one. `GET /dm/:id/file` the file's bytes with its type and the sender's
 * name in `content-disposition` (the feed's `fileName` is made from the
 * type), `413 too_large` over 25 MiB, `410 deleted`, `404 not_found`. `POST
 * /dm { id, to, text, reply? }` sends to a contact (`400 not_a_contact`,
 * `400 too_long` past 32 KiB) and answers the send's item; the same `id`
 * never sends twice — a failed one is tried again with its first text;
 * `sent` at once, or as `/next-dm { state: "failed" | "pending" }` says
 * (`failed` with nothing sent, no id; `sending` until `POST /settle/<id>`).
 * Item 2's (plans/support-chat.md §7, as the daemon's side builds them,
 * stacked on #435): `POST /dm` takes `file: { data: <base64>, type, name }`
 * (`text` then optional; `413 too_large` over 25 MiB), and its item is
 * `kind: "file"` with `mediaType` and `fileName`, the file readable by its
 * id; `PUT /dm/photo { data, type }` answers `{ url }`, a memes `/public`
 * URL then sent as `img` on every message, and `DELETE /dm/photo` clears
 * it; `POST /dm/:id/delete` deletes one of the account's own messages,
 * which comes again `deleted: true` under a new seq (`404 not_found` for
 * any other). `GET /worker-photo` (open) says the `img` a worker now sees.
 * A WORKER is played through open routes: `POST /worker-dm { pubkey?, alias?,
 * text?, replyTo?, sats?, time?, file?: { name, type, base64 } | { name, type, size } }`
 * (a new pubkey is a new contact first: its key exchange, `kind: "contact"`),
 * `POST /worker-contact { pubkey?, alias? }`, `POST /worker-delete/:id`;
 * `POST /use-invite/:code { pubkey?, alias? }` makes the contact too.
 *
 * `GET /prices` answers mempool's `{ time, USD }` for STRUT_RATE_URL, so a
 * dollar is a fixed number of sats. `/prices`, `/settle`, `/next-payout`,
 * `/next-dm`, `/use-invite` and `/worker-*` are open: they are the test's,
 * not strut's.
 *
 *   PORT=3461 TOKEN=demo PAY_TOKEN=demo-pay MESSAGE_TOKEN=demo-message SETTLE_AFTER_MS=3000 USD_PER_BTC=100000 \
 *     npx tsx scripts/fake-sphinx-daemon.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { decodeBolt11, encodeBolt11 } from "../src/payments/bolt11.js";
import { lspFeeFloorMsat } from "../src/payments/fee.js";

export interface FakeSphinxDaemonOptions {
  /** 0: any free port. Default 3461. */
  port?: number;
  /** The receive token. Default `demo`. */
  token?: string;
  /** The pay token: must differ from the receive token. Default `demo-pay`. */
  payToken?: string;
  /** The message token (plans/support-chat.md §7): differs from both. Default `demo-message`. */
  messageToken?: string;
  /** An invoice settles this long after it was made; 0 only by hand. Default 3000. */
  settleAfterMs?: number;
  /** What `GET /prices` answers. Default 100,000: $1 is 1,000 sats. */
  usdPerBtc?: number;
  /** What the wallet held before anything here. Default 100,000 sats. */
  startSats?: number;
  /** A line per invoice and payout. Default none. */
  log?: (line: string) => void;
}

export interface FakeSphinxDaemon {
  url: string;
  close(): Promise<void>;
}

type State = "pending" | "settled" | "failed";
interface Inv { hash: string; preimage: string; msat: number; made: number; expires: number; settledAt?: number }
/** A pay (keyed by payment hash) or a keysend (keyed by its id). */
interface Out { key: string; hash: string; preimage?: string; msat: number; state: State; fee: number; error?: string }

/** One 1:1 record of `GET /dms`, as stakwork/sphinx#435's `wasm/daemon/src/dms.ts` writes it. */
interface DmRec {
  seq: number;
  /** null only on a send that failed before anything went out. */
  id: string | null;
  /** On a send made through POST /dm. */
  clientId?: string;
  /** ISO, as the daemon's log writes it. */
  time: string;
  fromMe: boolean;
  peer: { pubkey: string; address: string | null; alias: string | null };
  kind: "message" | "file" | "payment" | "contact";
  text: string | null;
  replyTo: string | null;
  sats: number;
  deleted: boolean;
  mediaType: string | null;
  /** Made from the type (a Sphinx file message carries no name): the
   *  sender's comes in `GET /dm/:id/file`'s content-disposition. */
  fileName: string | null;
  /** The account's own. */
  status?: "sending" | "sent" | "failed";
  error?: string;
}
/** The largest file `GET /dm/:id/file` gives (ruling 10). */
export const DM_FILE_MAX_BYTES = 25 * 1024 * 1024;
/** The daemon's limit on a message: its content and quoted id as JSON (sphinx-chat's `MAX_SEND_BYTES`). */
const DM_MAX_SEND_BYTES = 32 * 1024;
const DM_BLANK = { text: null, replyTo: null, sats: 0, deleted: false, mediaType: null, fileName: null };
/** A file message's name in the feed, made from its type (a Sphinx file message carries none). */
const nameOfType = (type: string) => `${type.startsWith("image/") ? "image" : "file"}.${type.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin"}`;

/** What the stand-in's mixer charges for an invite, on top of its sats. */
export const INVITE_PRICE_SATS = 10;
type InviteStatus = "sending" | "ready" | "failed" | "used" | "cancelled";
interface Invite { code: string; link: string; sats: number; status: InviteStatus; createdAt: number }

const hex64 = /^[0-9a-f]{64}$/;
const ADDRESS = /^0[23][0-9a-f]{64}_0[23][0-9a-f]{64}_\d+$/;
const sha256 = (h: string) => createHash("sha256").update(Buffer.from(h, "hex")).digest("hex");

export async function startFakeSphinxDaemon(opts: FakeSphinxDaemonOptions = {}): Promise<FakeSphinxDaemon> {
  const token = opts.token ?? "demo";
  const payToken = opts.payToken ?? "demo-pay";
  const messageToken = opts.messageToken ?? "demo-message";
  if (token === payToken) throw new Error("the pay token must differ from the receive token, as strut's boot requires");
  if (messageToken === token || messageToken === payToken) throw new Error("the message token must differ from the receive and pay tokens, as strut's boot requires");
  const settleAfterMs = opts.settleAfterMs ?? 3000;
  const usdPerBtc = opts.usdPerBtc ?? 100_000;
  const startMsat = (opts.startSats ?? 100_000) * 1000;
  const log = opts.log ?? (() => {});

  const invoices = new Map<string, Inv>();
  const pays = new Map<string, Out>();
  const keysends = new Map<string, Out>();
  const invites = new Map<string, Invite>();
  let nextPayout: "failed" | "pending" | undefined;
  // The DMs: each record by id, its seq bumped when it changes.
  const dms = new Map<string, DmRec>();
  const dmFiles = new Map<string, { bytes: Buffer; size: number; name: string }>();
  // A file sent through POST /dm, by the send's id: a failed one tried again sends it.
  const sendFiles = new Map<string, { bytes: Buffer; type: string; name: string }>();
  const contacts = new Map<string, string | null>();
  // Support's picture: its memes /public URL, sent as `img` on every message.
  let photo: { url: string; type: string; bytes: number } | null = null;
  let seq = 0;
  let nextDm: "failed" | "pending" | undefined;
  // Each item by its key: its Sphinx id, or `send:<clientId>` for a send
  // through POST /dm, as the daemon keeps a send's item apart from its log.
  const keyOf = (r: DmRec) => (r.clientId ? `send:${r.clientId}` : r.id!);
  const put = (r: Omit<DmRec, "seq">) => {
    const rec = { ...r, seq: ++seq } as DmRec;
    dms.set(keyOf(rec), rec);
    return rec;
  };
  const touch = (r: DmRec) => {
    dms.delete(keyOf(r));
    r.seq = ++seq;
    dms.set(keyOf(r), r);
  };
  const someKey = () => `02${randomBytes(32).toString("hex")}`;
  const peerOf = (pubkey: string) => ({ pubkey, address: `${pubkey}_${"03" + "1".repeat(64)}_1`, alias: contacts.get(pubkey) ?? null });
  /** A new contact's key exchange, once per pubkey (an invite used, or a first DM). */
  const contact = (pubkey: string, alias: string | null) => {
    if (contacts.has(pubkey)) {
      if (alias) contacts.set(pubkey, alias);
      return;
    }
    contacts.set(pubkey, alias);
    put({ ...DM_BLANK, id: randomUUID(), time: new Date().toISOString(), fromMe: false, peer: peerOf(pubkey), kind: "contact" });
  };

  /** Settled now? An invoice settles settleAfterMs after it was made (0: only by hand). */
  const settled = (i: Inv, now = Date.now()) => {
    if (i.settledAt === undefined && settleAfterMs > 0 && now >= i.made + settleAfterMs && now < i.expires) i.settledAt = i.made + settleAfterMs;
    return i.settledAt !== undefined;
  };
  /** In, less every payout that went (a pending one holds its amount, as the mixer does). */
  const balance = () => {
    const paidIn = [...invoices.values()].filter((i) => settled(i)).reduce((n, i) => n + i.msat, 0);
    const out = [...pays.values(), ...keysends.values()].filter((o) => o.state !== "failed").reduce((n, o) => n + o.msat + o.fee, 0);
    // An invite holds its sats and the price until it fails or is cancelled.
    const invited = [...invites.values()].filter((i) => i.status !== "failed" && i.status !== "cancelled").reduce((n, i) => n + (i.sats + INVITE_PRICE_SATS) * 1000, 0);
    return startMsat + paidIn - out - invited;
  };
  /** Sends `o` (new, or a failed pay tried again): fails, holds or settles it. */
  const send = (o: Out) => {
    const fee = lspFeeFloorMsat(o.msat);
    // Failed while it is weighed: the balance then leaves it out.
    o.state = "failed";
    o.fee = 0;
    delete o.error;
    const outcome = nextPayout;
    nextPayout = undefined;
    if (outcome === "failed") o.error = "no route found";
    else if (balance() < o.msat + fee) o.error = "not enough balance";
    else if (outcome === "pending") o.state = "pending";
    else {
      o.state = "settled";
      o.fee = fee;
    }
    log(`${o.state} ${o.msat / 1000} sats out ${o.key.slice(0, 12)}…${o.error ? ` (${o.error})` : ""}`);
  };
  const outAnswer = (o: Out) => ({
    payment_hash: o.hash,
    state: o.state,
    fee_msat: o.state === "settled" ? o.fee : 0,
    ...(o.state === "settled" && o.preimage ? { preimage: o.preimage } : {}),
    ...(o.state === "failed" ? { error: o.error } : {}),
  });
  const reply = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const bodyOf = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  };
  const tooLow = (msat: number, max: unknown) =>
    typeof max === "number" && max >= lspFeeFloorMsat(msat) ? undefined : { error: `max_fee_msat ${String(max)} is below the LSP's own fee limit for ${msat} msat, ${lspFeeFloorMsat(msat)}`, code: "max_fee_too_low" };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      // The test's routes, open.
      if (req.method === "GET" && path === "/prices") return reply(res, 200, { time: Math.floor(Date.now() / 1000), USD: usdPerBtc });
      const settleOne = /^\/settle\/([0-9a-f]{64})$/.exec(path);
      if (req.method === "POST" && settleOne) {
        const x = settleOne[1]!;
        const inv = invoices.get(x);
        if (inv) {
          inv.settledAt ??= Date.now();
          return reply(res, 200, { settled: x });
        }
        const dm = [...dms.values()].find((r) => r.clientId === x && r.status === "sending");
        if (dm) {
          dm.status = "sent";
          touch(dm);
          return reply(res, 200, { settled: x, status: dm.status });
        }
        const sent = invites.get(x);
        if (sent) {
          if (sent.status === "sending") sent.status = "ready";
          return reply(res, 200, { settled: x, status: sent.status });
        }
        const o = pays.get(x) ?? keysends.get(x);
        if (!o) return reply(res, 404, { error: "no such invoice, payment or keysend", code: "not_found" });
        if (o.state === "pending") {
          o.state = "settled";
          o.fee = lspFeeFloorMsat(o.msat);
        }
        return reply(res, 200, { settled: x, state: o.state });
      }
      const useOne = /^\/use-invite\/([0-9a-f]{64})$/.exec(path);
      if (req.method === "POST" && useOne) {
        const i = invites.get(useOne[1]!);
        if (!i || i.status !== "ready") return reply(res, 409, { error: "no ready invite with that code", code: "not_ready" });
        i.status = "used";
        // The new account's key exchange: it is a contact now.
        const b = await bodyOf(req);
        const pubkey = typeof b["pubkey"] === "string" ? b["pubkey"] : someKey();
        contact(pubkey, typeof b["alias"] === "string" ? b["alias"] : null);
        return reply(res, 200, { code: i.code, status: i.status, pubkey });
      }
      // A worker, played (plans/support-chat.md §7's records).
      if (req.method === "POST" && (path === "/worker-dm" || path === "/worker-contact")) {
        const b = await bodyOf(req);
        const pubkey = typeof b["pubkey"] === "string" ? b["pubkey"] : someKey();
        if (!/^0[23][0-9a-f]{64}$/.test(pubkey)) return reply(res, 400, { error: "pubkey is 66 hex characters", code: "bad_request" });
        contact(pubkey, typeof b["alias"] === "string" ? b["alias"] : null);
        if (path === "/worker-contact") return reply(res, 200, { pubkey });
        const id = randomUUID();
        const file = b["file"] as { name?: string; type?: string; base64?: string; size?: number } | undefined;
        const sats = typeof b["sats"] === "number" ? b["sats"] : undefined;
        const type = file?.type ?? "application/octet-stream";
        if (file) {
          const bytes = Buffer.from(file.base64 ?? "", "base64");
          dmFiles.set(id, { bytes, size: file.size ?? bytes.byteLength, name: file.name ?? "file" });
        }
        const r = put({
          ...DM_BLANK,
          id,
          time: typeof b["time"] === "string" ? b["time"] : new Date().toISOString(),
          fromMe: false,
          peer: peerOf(pubkey),
          kind: file ? "file" : sats ? "payment" : "message",
          ...(typeof b["text"] === "string" ? { text: b["text"] } : {}),
          ...(typeof b["replyTo"] === "string" ? { replyTo: b["replyTo"] } : {}),
          ...(sats ? { sats } : {}),
          ...(file ? { mediaType: type, fileName: nameOfType(type) } : {}),
        });
        log(`dm in ${r.kind} from ${pubkey.slice(0, 10)}…`);
        return reply(res, 200, { id, pubkey, seq: r.seq });
      }
      const deleteOne = /^\/worker-delete\/([^/]+)$/.exec(path);
      if (req.method === "POST" && deleteOne) {
        const r = dms.get(decodeURIComponent(deleteOne[1]!));
        if (!r || r.fromMe) return reply(res, 404, { error: "no worker's message with that id", code: "not_found" });
        r.deleted = true;
        r.text = null;
        touch(r);
        return reply(res, 200, { id: r.id, deleted: true });
      }
      if (req.method === "GET" && path === "/worker-photo") return reply(res, 200, { img: photo?.url ?? null, ...(photo ? { type: photo.type, bytes: photo.bytes } : {}) });
      if (req.method === "POST" && path === "/next-dm") {
        const st = (await bodyOf(req))["state"];
        if (st !== "failed" && st !== "pending") return reply(res, 400, { error: "state is failed or pending", code: "bad_request" });
        nextDm = st;
        return reply(res, 200, { next: st });
      }
      if (req.method === "POST" && path === "/next-payout") {
        const s = (await bodyOf(req))["state"];
        if (s !== "failed" && s !== "pending") return reply(res, 400, { error: "state is failed or pending", code: "bad_request" });
        nextPayout = s;
        return reply(res, 200, { next: s });
      }

      const auth = req.headers.authorization;
      const pay = auth === `Bearer ${payToken}`;
      const messaging =
        (req.method === "GET" && (path === "/dms" || /^\/dm\/[^/]+\/file$/.test(path))) ||
        (req.method === "POST" && (path === "/dm" || /^\/dm\/[^/]+\/delete$/.test(path))) ||
        ((req.method === "PUT" || req.method === "DELETE") && path === "/dm/photo");
      if (auth === `Bearer ${messageToken}`) {
        if (!messaging) return reply(res, 403, { error: "the message token opens the DM routes alone", code: "forbidden" });
        if (path === "/dm/photo") {
          if (req.method === "DELETE") {
            photo = null;
            return reply(res, 200, { url: null });
          }
          const b = await bodyOf(req);
          const bytes = typeof b["data"] === "string" ? Buffer.from(b["data"], "base64") : Buffer.alloc(0);
          if (!bytes.byteLength || typeof b["type"] !== "string" || !b["type"].startsWith("image/")) return reply(res, 400, { error: "data is an image as base64 and type its image/* type", code: "bad_request" });
          photo = { url: `https://memes.fake.invalid/public/${randomBytes(16).toString("hex")}`, type: b["type"], bytes: bytes.byteLength };
          log(`photo set: ${photo.url}`);
          return reply(res, 200, { url: photo.url });
        }
        const deleteOwn = /^\/dm\/([^/]+)\/delete$/.exec(path);
        if (deleteOwn) {
          const id = decodeURIComponent(deleteOwn[1]!);
          const r = [...dms.values()].find((x) => x.fromMe && x.id === id);
          if (!r) return reply(res, 404, { error: "no message of the account's own with that id", code: "not_found" });
          if (!r.deleted) {
            r.deleted = true;
            r.text = null;
            touch(r);
          }
          return reply(res, 200, r);
        }
        if (req.method === "GET" && path === "/dms") {
          const after = Number(url.searchParams.get("after") ?? 0);
          const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100), 1000);
          const page = [...dms.values()].filter((r) => r.seq > after).sort((a, b) => a.seq - b.seq).slice(0, limit);
          return reply(res, 200, { dms: page });
        }
        const fileOne = /^\/dm\/([^/]+)\/file$/.exec(path);
        if (fileOne) {
          const id = decodeURIComponent(fileOne[1]!);
          const r = dms.get(id) ?? [...dms.values()].find((x) => x.id === id);
          const f = dmFiles.get(id);
          if (!r || !f || r.kind !== "file") return reply(res, 404, { error: "no file with that id among the direct messages", code: "not_found" });
          if (r.deleted) return reply(res, 410, { error: "its sender deleted it", code: "deleted" });
          if (f.size > DM_FILE_MAX_BYTES) return reply(res, 413, { error: `the file is ${f.size} bytes, over 25 MB`, code: "too_large" });
          res.writeHead(200, {
            "content-type": r.mediaType ?? "application/octet-stream",
            "content-length": String(f.bytes.byteLength),
            "content-disposition": `attachment; filename="${f.name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
          });
          return res.end(f.bytes);
        }
        // POST /dm: answers the send as the feed shows it. The same id never
        // sends twice; a failed one is tried again, with the text it first had.
        const b = await bodyOf(req);
        const id = b["id"];
        if (typeof id !== "string" || !/^[\x21-\x7e]{1,128}$/.test(id)) return reply(res, 400, { error: "id must be 1 to 128 printable characters, no spaces", code: "bad_request" });
        const had = dms.get(`send:${id}`);
        if (had && had.status !== "failed") return reply(res, 200, had);
        const to = had ? had.peer.pubkey : b["to"];
        const text = had ? had.text : typeof b["text"] === "string" && b["text"] ? b["text"] : null;
        const replyTo = had ? had.replyTo : typeof b["reply"] === "string" && b["reply"] ? b["reply"] : null;
        // A file: kept by the send's id, as the first try had it.
        const f = b["file"] as { data?: unknown; type?: unknown; name?: unknown } | undefined;
        const file = had ? sendFiles.get(id) : f ? { bytes: typeof f.data === "string" ? Buffer.from(f.data, "base64") : Buffer.alloc(0), type: typeof f.type === "string" ? f.type : "", name: typeof f.name === "string" ? f.name : "file" } : undefined;
        if (typeof to !== "string" || !/^0[23][0-9a-f]{64}$/.test(to)) return reply(res, 400, { error: "to must be a contact's pubkey (66 hex characters)", code: "bad_request" });
        if (file && (!file.bytes.byteLength || !/^[\w.+-]+\/[\w.+-]+$/.test(file.type))) return reply(res, 400, { error: "file is { data: <base64>, type, name }", code: "bad_request" });
        if (file && file.bytes.byteLength > DM_FILE_MAX_BYTES) return reply(res, 413, { error: `the file is ${file.bytes.byteLength} bytes, over 25 MiB`, code: "too_large" });
        if (!file && (typeof text !== "string" || !text.trim())) return reply(res, 400, { error: "text is required without a file", code: "bad_request" });
        const size = Buffer.byteLength(JSON.stringify({ content: text ?? "", ...(replyTo ? { replyUuid: replyTo } : {}) }), "utf8");
        if (size > DM_MAX_SEND_BYTES) return reply(res, 400, { error: `text too long: ${size} bytes, at most ${DM_MAX_SEND_BYTES}`, code: "too_long" });
        if (!contacts.has(to)) return reply(res, 400, { error: `${to} is not one of the account's contacts`, code: "not_a_contact" });
        if (file) sendFiles.set(id, file);
        const outcome = nextDm;
        nextDm = undefined;
        // failed: nothing went out (no Sphinx id); pending: the LSP has not answered.
        const status = outcome === "failed" ? "failed" : outcome === "pending" ? "sending" : "sent";
        const item: Omit<DmRec, "seq"> = {
          ...DM_BLANK,
          id: status === "failed" ? null : (had?.id ?? randomUUID()),
          clientId: id,
          time: new Date().toISOString(),
          fromMe: true,
          peer: peerOf(to),
          kind: file ? "file" : "message",
          text,
          replyTo,
          ...(file ? { mediaType: file.type, fileName: nameOfType(file.type) } : {}),
          status,
          ...(status === "failed" ? { error: "the LSP did not take it" } : {}),
        };
        const sent = put(item);
        if (file && sent.id) dmFiles.set(sent.id, { bytes: file.bytes, size: file.bytes.byteLength, name: file.name });
        log(`dm out ${file ? `file ${file.type} ` : ""}${status} to ${to.slice(0, 10)}…${photo ? ` (img ${photo.url})` : ""}`);
        return reply(res, 200, sent);
      }
      if (messaging) return reply(res, auth === `Bearer ${token}` || pay ? 403 : 401, { error: "the DM routes take the message token", code: auth === `Bearer ${token}` || pay ? "forbidden" : "unauthorized" });
      if (!pay && auth !== `Bearer ${token}`) return reply(res, 401, { error: "unauthorized", code: "unauthorized" });
      const paying =
        (req.method === "POST" && (path === "/pay" || path === "/keysend" || path === "/invite" || path.startsWith("/invite/"))) ||
        (req.method === "GET" && (path.startsWith("/keysend/") || path === "/invites"));
      if (paying && !pay) return reply(res, 403, { error: "the receive token may not pay", code: "forbidden" });

      if (req.method === "POST" && path === "/invoice") {
        const b = await bodyOf(req);
        const sats = Number(b["sats"]);
        if (!Number.isSafeInteger(sats) || sats <= 0) return reply(res, 400, { error: "sats is a whole number above 0", code: "bad_request" });
        const expiry = typeof b["expiry"] === "number" ? b["expiry"] : 3600;
        const preimage = randomBytes(32).toString("hex");
        const hash = sha256(preimage);
        const made = Date.now();
        const inv: Inv = { hash, preimage, msat: sats * 1000, made, expires: made + expiry * 1000 };
        invoices.set(hash, inv);
        const description = typeof b["description"] === "string" ? b["description"] : undefined;
        const invoice = encodeBolt11({ msat: inv.msat, paymentHash: hash, ...(description ? { description } : {}), timestamp: Math.floor(made / 1000), expirySecs: expiry });
        log(`invoice ${sats} sats ${hash.slice(0, 12)}… ${description ?? ""}`);
        return reply(res, 200, { invoice, payment_hash: hash, sats, expires_at: Math.floor(inv.expires / 1000) });
      }
      const one = /^\/invoice\/([0-9a-f]{64})$/.exec(path);
      if (req.method === "GET" && one) {
        const i = invoices.get(one[1]!);
        if (!i) return reply(res, 404, { error: "no such invoice", code: "not_found" });
        if (settled(i)) return reply(res, 200, { payment_hash: i.hash, state: "settled", msat: i.msat, preimage: i.preimage, settled_at: Math.floor(i.settledAt! / 1000) });
        return reply(res, 200, { payment_hash: i.hash, state: Date.now() >= i.expires ? "expired" : "pending" });
      }
      if (req.method === "GET" && path === "/payments") {
        const since = Number(url.searchParams.get("since") ?? 0);
        const payments = [...invoices.values()]
          .filter((i) => settled(i) && i.settledAt! / 1000 >= since)
          .map((i) => ({ payment_hash: i.hash, msat: i.msat, settled_at: Math.floor(i.settledAt! / 1000) }));
        return reply(res, 200, { payments });
      }
      if (req.method === "GET" && path === "/balance") return reply(res, 200, { msat: balance() });

      if (req.method === "POST" && path === "/pay") {
        const b = await bodyOf(req);
        let inv;
        try {
          inv = decodeBolt11(String(b["invoice"]));
        } catch {
          return reply(res, 400, { error: "invoice is not a BOLT11 invoice", code: "bad_request" });
        }
        if (!inv.msat) return reply(res, 400, { error: "the invoice names no amount: the daemon pays only an invoice with one", code: "bad_request" });
        const had = pays.get(inv.paymentHash);
        if (had && had.state !== "failed") return reply(res, 200, outAnswer(had));
        if (invoices.has(inv.paymentHash)) return reply(res, 400, { error: "the invoice is the account's own", code: "own_invoice" });
        if (inv.expiresAt * 1000 <= Date.now()) return reply(res, 400, { error: `the invoice expired at ${inv.expiresAt}`, code: "expired" });
        const low = tooLow(inv.msat, b["max_fee_msat"]);
        if (low) return reply(res, 400, low);
        // Another wallet's invoice: no preimage to hand back, as a payer may meet.
        const o: Out = had ?? { key: inv.paymentHash, hash: inv.paymentHash, msat: inv.msat, state: "pending", fee: 0 };
        pays.set(o.key, o);
        send(o);
        return reply(res, 200, outAnswer(o));
      }
      if (req.method === "POST" && path === "/keysend") {
        const b = await bodyOf(req);
        const id = b["id"];
        if (typeof id !== "string" || !hex64.test(id)) return reply(res, 400, { error: "id is 64 lowercase hex characters", code: "bad_request" });
        const had = keysends.get(id);
        if (had) return reply(res, 200, { id, ...outAnswer(had) });
        const address = b["address"];
        const msat = b["msat"];
        if (typeof address !== "string" || !ADDRESS.test(address)) return reply(res, 400, { error: "address is not a Sphinx address, <pubkey>_<lsp_pubkey>_<scid>", code: "bad_request" });
        if (typeof msat !== "number" || !Number.isSafeInteger(msat) || msat <= 0) return reply(res, 400, { error: "msat is a whole number above 0", code: "bad_request" });
        const low = tooLow(msat, b["max_fee_msat"]);
        if (low) return reply(res, 400, low);
        // A keysend's preimage is the sender's: its hash is known when it goes.
        const preimage = randomBytes(32).toString("hex");
        const o: Out = { key: id, hash: sha256(preimage), preimage, msat, state: "pending", fee: 0 };
        keysends.set(id, o);
        send(o);
        return reply(res, 200, { id, ...outAnswer(o) });
      }
      const ks = /^\/keysend\/([0-9a-f]{64})$/.exec(path);
      if (req.method === "GET" && ks) {
        const o = keysends.get(ks[1]!);
        return o ? reply(res, 200, { id: o.key, ...outAnswer(o) }) : reply(res, 404, { error: `no keysend ${ks[1]}`, code: "not_found" });
      }
      if (req.method === "POST" && path === "/invite") {
        const sats = (await bodyOf(req))["sats"];
        if (typeof sats !== "number" || !Number.isSafeInteger(sats) || sats <= 0) return reply(res, 400, { error: "sats is a whole number above 0", code: "bad_request" });
        const code = randomBytes(32).toString("hex");
        // The core's `invite_qr`: the code's 32 bytes then the mixer's host, URL-safe base64 PADDED
        // (its `URL_SAFE` engine writes `=` and decodes only canonical padding).
        const d = Buffer.concat([Buffer.from(code, "hex"), Buffer.from("mixer.fake.invalid")]).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
        const room = balance() >= (sats + INVITE_PRICE_SATS) * 1000;
        const outcome = nextPayout;
        nextPayout = undefined;
        const status: InviteStatus = !room || outcome === "failed" ? "failed" : outcome === "pending" ? "sending" : "ready";
        const i: Invite = { code, link: `sphinx.chat://?action=i&d=${d}`, sats, status, createdAt: Math.floor(Date.now() / 1000) };
        invites.set(code, i);
        log(`invite ${sats} sats ${status} ${code.slice(0, 12)}…`);
        return reply(res, 200, i);
      }
      if (req.method === "GET" && path === "/invites") return reply(res, 200, { invites: [...invites.values()] });
      const cancelOne = /^\/invite\/([^/]+)\/cancel$/.exec(path);
      if (req.method === "POST" && cancelOne) {
        const i = invites.get(cancelOne[1]!);
        if (!i) return reply(res, 404, { error: `no invite ${cancelOne[1]}`, code: "not_found" });
        if (i.status === "used") return reply(res, 409, { error: "the invite was used", code: "not_cancellable" });
        if (i.status === "sending" || i.status === "ready") i.status = "cancelled";
        return reply(res, 200, { code: i.code, status: i.status });
      }
      return reply(res, 404, { error: `no route ${req.method} ${path}`, code: "not_found" });
    } catch (err) {
      return reply(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  await new Promise<void>((ok, fail) => server.once("error", fail).listen(opts.port ?? 3461, "127.0.0.1", ok));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = (k: string) => process.env[k] || undefined;
  const num = (k: string) => (env(k) === undefined ? undefined : Number(env(k)));
  const settleAfterMs = num("SETTLE_AFTER_MS");
  const daemon = await startFakeSphinxDaemon({
    ...(num("PORT") !== undefined ? { port: num("PORT")! } : {}),
    ...(env("TOKEN") ? { token: env("TOKEN")! } : {}),
    ...(env("PAY_TOKEN") ? { payToken: env("PAY_TOKEN")! } : {}),
    ...(env("MESSAGE_TOKEN") ? { messageToken: env("MESSAGE_TOKEN")! } : {}),
    ...(settleAfterMs !== undefined ? { settleAfterMs } : {}),
    ...(num("USD_PER_BTC") !== undefined ? { usdPerBtc: num("USD_PER_BTC")! } : {}),
    ...(num("START_SATS") !== undefined ? { startSats: num("START_SATS")! } : {}),
    log: (line) => console.log(line),
  });
  console.log(`fake sphinx daemon on ${daemon.url} (invoices settle after ${settleAfterMs ?? 3000} ms)`);
}
