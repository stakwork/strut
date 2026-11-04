/** The WALLET CONTRACT (plans/app-payments.md, specs/WALLET.md): what an
 *  app's page and its host say to each other about a Lightning wallet.
 *
 *  It is NWC's (NIP-47) methods, params, results, units (msat) and error
 *  codes, sent as JSON-RPC over the MCP Apps bridge as
 *  `strut/wallet/<method>`. strut adds what Sphinx needs and no standard has:
 *  - route hints on keysend;
 *  - a `state` on every payment, since an async keysend waits at the LSP
 *    until the payee is online;
 *  - `payment_failed`;
 *  - `USER_REJECTED`;
 *  - `connect`, which asks the person for the connection the app's
 *    `app.yaml` requests.
 *
 *  One copy: the kit's hooks, every host's WalletHost and Peel's Swift check
 *  themselves against it and against `vectors.json`. It checks SHAPES; a host
 *  still decodes an invoice itself before it shows or pays one. Pure: no
 *  React, no DOM, no dependency. */

export const WALLET_PROTOCOL_VERSION = 1;

/** The key under `hostCapabilities.experimental` a host offers a wallet with. */
export const WALLET_CAPABILITY = "strut/wallet";
/** Every request is `strut/wallet/<method>`. */
export const WALLET_METHOD_PREFIX = "strut/wallet/";
/** The one notification the host pushes to the page. */
export const WALLET_NOTIFICATION_METHOD = "strut/wallet/notification";

/** Every host offers these. `connect` and `get_info` are always allowed;
 *  the rest only as the connection grants them. */
export const CORE_METHODS = [
  "connect", "get_info", "pay_invoice", "pay_keysend", "make_invoice", "lookup_payment", "lookup_invoice", "get_budget",
] as const;
/** A host offers each of these if its wallet can. */
export const OPTIONAL_METHODS = ["get_balance", "list_transactions", "pay_lightning_address"] as const;
export const WALLET_METHODS = [...CORE_METHODS, ...OPTIONAL_METHODS] as const;
export type WalletMethod = (typeof WALLET_METHODS)[number];

/** What a connection request may name: everything but `connect` and `get_info`. */
export const REQUESTABLE_METHODS = WALLET_METHODS.filter((m) => m !== "connect" && m !== "get_info") as Exclude<
  WalletMethod,
  "connect" | "get_info"
>[];
export type RequestableMethod = Exclude<WalletMethod, "connect" | "get_info">;

/** The methods that move money out: what a budget counts. */
export const PAY_METHODS = ["pay_invoice", "pay_keysend", "pay_lightning_address"] as const;
export type PayMethod = (typeof PAY_METHODS)[number];

export const NOTIFICATION_TYPES = ["payment_received", "payment_sent", "payment_failed"] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const RENEWAL_PERIODS = ["never", "daily", "weekly", "monthly", "yearly"] as const;
export type RenewalPeriod = (typeof RENEWAL_PERIODS)[number];

export const NETWORKS = ["bitcoin", "testnet", "signet", "regtest"] as const;
export type Network = (typeof NETWORKS)[number];

/** NWC's codes (core, plus NWC-09's `BAD_REQUEST`), and strut's
 *  `USER_REJECTED`: the person said no, which an NWC wallet service never
 *  sees. */
export const ERROR_CODES = [
  "USER_REJECTED", "BAD_REQUEST", "PAYMENT_FAILED", "INSUFFICIENT_BALANCE", "QUOTA_EXCEEDED", "RESTRICTED",
  "UNAUTHORIZED", "NOT_IMPLEMENTED", "RATE_LIMITED", "NOT_FOUND", "INTERNAL", "OTHER",
] as const;
export type WalletErrorCode = (typeof ERROR_CODES)[number];

/** JSON-RPC codes the wallet uses: `BAD_REQUEST` is Invalid params, every
 *  other wallet error the server-error code, both with the wallet code in
 *  `data.code`. */
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_WALLET_ERROR = -32000;

/** BOLT 1: custom records are 2^16 and up; 5482373484 is keysend's preimage,
 *  which the wallet sets. */
export const MIN_CUSTOM_TLV_TYPE = 65536;
export const KEYSEND_PREIMAGE_TLV_TYPE = 5482373484;
/** Sphinx's own record (sphinx `SPHINX_TLV_KEY`): the core's `data`, base64. */
export const SPHINX_TLV_TYPE = 13377331;
/** bLIP-10: a Podcasting 2.0 value payment's metadata, UTF-8 JSON. */
export const PODCAST_TLV_TYPE = 7629169;
/** NWC-06: metadata is at most 4096 characters as JSON. */
export const METADATA_MAX_CHARS = 4096;
/** At most this many in one `list_transactions` page. */
export const LIST_LIMIT_MAX = 100;

// ── Shapes ─────────────────────────────────────────────────────────────────

export type Metadata = Record<string, unknown>;

/** One hop of a route hint: BOLT11's `r` field. `short_channel_id` is a
 *  decimal u64 or `<block>x<tx>x<output>`. */
export interface RouteHop {
  pubkey: string;
  short_channel_id: string;
  fee_base_msat?: number;
  fee_proportional_millionths?: number;
  cltv_expiry_delta?: number;
}

/** A keysend custom record: `value` is hex. */
export interface TlvRecord {
  type: number;
  value: string;
}

export interface ConnectionRequest {
  request_methods: RequestableMethod[];
  optional_request_methods?: RequestableMethod[];
  notification_types?: NotificationType[];
  /** msat per period, fees included. */
  max_amount?: number;
  /** Needs `max_amount`. */
  renewal_period?: RenewalPeriod;
  /** Unix seconds; null for none. */
  expires_at?: number | null;
}

/** What the person granted: `connect`'s answer, and what `get_info` reports. */
export interface GrantedConnection {
  methods: RequestableMethod[];
  notification_types: NotificationType[];
  max_amount?: number;
  renewal_period?: RenewalPeriod;
  expires_at?: number | null;
}

export interface PayInvoiceParams {
  invoice: string;
  /** msat, only for an invoice that names no amount. */
  amount?: number;
  metadata?: Metadata;
}

export interface PayKeysendParams {
  /** A node pubkey, or a Sphinx address `<pubkey>_<lsp_pubkey>_<scid>`,
   *  which the check splits into the pubkey and a one-hop `route_hints`. */
  pubkey: string;
  amount: number;
  tlv_records?: TlvRecord[];
  route_hints?: RouteHop[][];
  /** hex; the wallet makes one when absent. */
  preimage?: string;
  metadata?: Metadata;
}

export interface MakeInvoiceParams {
  amount: number;
  description?: string;
  description_hash?: string;
  /** seconds */
  expiry?: number;
  metadata?: Metadata;
}

export type LookupPaymentParams = { transaction_id: string } | { payment_hash: string } | { invoice: string };
export type LookupInvoiceParams = { payment_hash: string } | { invoice: string };

export interface ListTransactionsParams {
  from?: number;
  until?: number;
  limit?: number;
  offset?: number;
  unpaid?: boolean;
  type?: "incoming" | "outgoing";
}

export type PayLightningAddressParams = ({ address: string } | { lnurl: string }) & {
  amount: number;
  comment?: string;
  payer_data?: Record<string, unknown>;
  metadata?: Metadata;
};

export type PaymentState = "pending" | "settled" | "failed";

/** What every pay method returns: once the wallet ACCEPTED the payment,
 *  never only when it settled. `preimage` only once `settled`. */
export interface Payment {
  transaction_id: string;
  state: PaymentState;
  payment_hash: string;
  amount: number;
  fees_paid?: number;
  preimage?: string;
  created_at: number;
  settled_at?: number;
  failure_reason?: string;
}

export type TransactionState = "pending" | "settled" | "accepted" | "expired" | "failed";

/** NWC's transaction object: `make_invoice`, `lookup_invoice`,
 *  `list_transactions` and a notification's payload carry it. */
export interface Transaction {
  type: "incoming" | "outgoing";
  state?: TransactionState;
  transaction_id?: string;
  invoice?: string;
  description?: string;
  description_hash?: string;
  preimage?: string;
  payment_hash: string;
  amount: number;
  fees_paid?: number;
  created_at: number;
  expires_at?: number;
  settled_at?: number;
  metadata?: Metadata;
}

export type LookupState = "pending" | "accepted" | "settled" | "failed" | "expired" | "canceled";

/** NWC-09's lookup envelope, with a `keysend` payment type added. */
export interface PaymentLookup {
  transaction_id: string;
  type: "incoming" | "outgoing";
  state: LookupState;
  payment_type: "bolt11" | "keysend";
  amount: number;
  fees_paid?: number;
  created_at: number;
  updated_at?: number;
  expires_at?: number;
  settled_at?: number;
  failure_reason?: string;
  metadata?: Metadata;
  details:
    | { payment_hash: string; invoice?: string; preimage?: string; description?: string; description_hash?: string }
    | { payment_hash: string; pubkey: string; preimage?: string; tlv_records?: TlvRecord[] };
}

export interface WalletInfo {
  alias?: string;
  /** Only when the connection grants it; absent by default. */
  pubkey?: string;
  network: Network;
  /** What THIS app may call: `connect`, `get_info` and the granted methods. */
  methods: WalletMethod[];
  notifications: NotificationType[];
}

/** NWC-13: `{}` when no budget is set. */
export type Budget =
  | { used_budget: number; total_budget: number; renews_at?: number; renewal_period: RenewalPeriod }
  | Record<string, never>;

export interface WalletNotification {
  notification_type: NotificationType;
  notification: Transaction & { transaction_id: string; failure_reason?: string };
}

/** What a host puts under `hostCapabilities.experimental["strut/wallet"]`. */
export interface WalletCapability {
  version: number;
  /** What the host's wallet can do (an app's own set is `get_info`'s). */
  methods: WalletMethod[];
  notifications: NotificationType[];
  /** Which provider: "sphinx", "nwc", "webln", or another host's own name. */
  wallet: string;
  /** Whether this app already holds a connection. */
  connected: boolean;
}

export interface MethodParams {
  connect: Record<string, never>;
  get_info: Record<string, never>;
  get_budget: Record<string, never>;
  get_balance: Record<string, never>;
  pay_invoice: PayInvoiceParams;
  pay_keysend: PayKeysendParams;
  make_invoice: MakeInvoiceParams;
  lookup_payment: LookupPaymentParams;
  lookup_invoice: LookupInvoiceParams;
  list_transactions: ListTransactionsParams;
  pay_lightning_address: PayLightningAddressParams;
}

export interface MethodResults {
  connect: { connection: GrantedConnection };
  get_info: WalletInfo;
  get_budget: Budget;
  get_balance: { balance: number };
  pay_invoice: Payment;
  pay_keysend: Payment;
  make_invoice: Transaction;
  lookup_payment: PaymentLookup;
  lookup_invoice: Transaction;
  list_transactions: { transactions: Transaction[]; total_count?: number };
  pay_lightning_address: Payment;
}

// ── Names ──────────────────────────────────────────────────────────────────

export function isWalletMethod(m: unknown): m is WalletMethod {
  return typeof m === "string" && (WALLET_METHODS as readonly string[]).includes(m);
}

/** `pay_keysend` → `strut/wallet/pay_keysend`. */
export function walletRequestMethod(method: WalletMethod): string {
  return WALLET_METHOD_PREFIX + method;
}

/** `strut/wallet/pay_keysend` → `pay_keysend`; undefined for anything else. */
export function walletMethodOf(requestMethod: string): WalletMethod | undefined {
  if (!requestMethod.startsWith(WALLET_METHOD_PREFIX)) return undefined;
  const m = requestMethod.slice(WALLET_METHOD_PREFIX.length);
  return isWalletMethod(m) ? m : undefined;
}

// ── Errors ─────────────────────────────────────────────────────────────────

export function isWalletErrorCode(c: unknown): c is WalletErrorCode {
  return typeof c === "string" && (ERROR_CODES as readonly string[]).includes(c);
}

/** The JSON-RPC `error` member a host answers with. */
export interface WalletErrorBody {
  code: number;
  message: string;
  data: { code: WalletErrorCode };
}

export function walletErrorBody(code: WalletErrorCode, message: string): WalletErrorBody {
  return { code: code === "BAD_REQUEST" ? JSONRPC_INVALID_PARAMS : JSONRPC_WALLET_ERROR, message, data: { code } };
}

/** What the kit throws for a wallet error; `code` is the wallet's. */
export class WalletError extends Error {
  constructor(readonly code: WalletErrorCode, message: string) {
    super(message);
    this.name = "WalletError";
  }
}

/** The wallet code out of a JSON-RPC error (or a thrown one): `data.code`
 *  when it is one, else `OTHER`. */
export function walletErrorCodeOf(error: unknown): WalletErrorCode {
  if (error instanceof WalletError) return error.code;
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code;
  return isWalletErrorCode(code) ? code : "OTHER";
}

// ── Units, preimages, Sphinx addresses ─────────────────────────────────────

export function satsToMsat(sats: number): number {
  return Math.round(sats * 1000);
}

/** Whole sats, rounded down: what WebLN shows. */
export function msatToSats(msat: number): number {
  return Math.floor(msat / 1000);
}

const HEX_RE = /^[0-9a-f]*$/;
const PUBKEY_RE = /^0[23][0-9a-f]{64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const SCID_RE = /^(\d+|\d+x\d+x\d+)$/;
const SPHINX_ADDRESS_RE = /^(0[23][0-9a-f]{64})_(0[23][0-9a-f]{64})_(\d+)$/;

/** Whether `sha256(preimage) == payment_hash` (both hex): proof an invoice
 *  was paid. Uses WebCrypto, which pages and Node 22 both have. */
export async function verifyPreimage(preimage: string, paymentHash: string): Promise<boolean> {
  const p = preimage.toLowerCase();
  if (!HASH_RE.test(p) || !HASH_RE.test(paymentHash.toLowerCase())) return false;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(p.slice(i * 2, i * 2 + 2), 16);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const b of digest) hex += b.toString(16).padStart(2, "0");
  return hex === paymentHash.toLowerCase();
}

/** A Sphinx address `<pubkey>_<lsp_pubkey>_<scid>` as a pubkey and a one-hop
 *  route hint (sphinx `parse_route_hint`: the hint is what follows the first
 *  `_`). Undefined when it is not one. */
export function parseSphinxAddress(address: string): { pubkey: string; route_hints: RouteHop[][] } | undefined {
  const m = SPHINX_ADDRESS_RE.exec(address.trim().toLowerCase());
  if (!m) return undefined;
  return { pubkey: m[1]!, route_hints: [[{ pubkey: m[2]!, short_channel_id: m[3]! }]] };
}

/** One hop back to Sphinx's route hint, `<lsp_pubkey>_<scid>` (the format the
 *  core pays async; a legacy `:` hint never is). Undefined when the scid is
 *  not a decimal u64. */
export function sphinxRouteHint(hop: RouteHop): string | undefined {
  return /^\d+$/.test(hop.short_channel_id) ? `${hop.pubkey}_${hop.short_channel_id}` : undefined;
}

// ── Checking params ────────────────────────────────────────────────────────

/** BOLT11 as bech32: an `ln` prefix and network, an optional amount, `1`, the
 *  data part. Shape only; a host decodes it. */
const INVOICE_RE = /^ln(bcrt|bc|tbs|tb|sb)(\d+[munp]?)?1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{20,}$/;
const LIGHTNING_ADDRESS_RE = /^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const LNURL_RE = /^(lnurl1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{10,}|lnurlp:\/\/\S+)$/;

export type ParamsCheck<M extends WalletMethod = WalletMethod> =
  | { ok: true; params: MethodParams[M] }
  | { ok: false; error: WalletErrorBody };

class Bad extends Error {}

function fail(message: string): never {
  throw new Bad(message);
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) fail(`${what} must be an object`);
  return v as Record<string, unknown>;
}

function amount(v: unknown, what = "amount"): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) fail(`${what} must be a whole number of msat above 0`);
  return v;
}

function count(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) fail(`${what} must be a whole number, 0 or more`);
  return v;
}

function hex(v: unknown, what: string, re: RegExp = HEX_RE): string {
  if (typeof v !== "string") fail(`${what} must be a hex string`);
  const h = v.toLowerCase();
  if (!re.test(h) || h.length % 2 !== 0) fail(`${what} is not valid hex of the right length`);
  return h;
}

function text(v: unknown, what: string, max: number): string {
  if (typeof v !== "string") fail(`${what} must be a string`);
  if (v.length > max) fail(`${what} is longer than ${max} characters`);
  return v;
}

function invoice(v: unknown): string {
  return parsedInvoice(v).invoice;
}

/** The invoice normalized, and whether its prefix names an amount. */
function parsedInvoice(v: unknown): { invoice: string; namesAmount: boolean } {
  if (typeof v !== "string") fail("invoice must be a BOLT11 string");
  const s = v.trim().toLowerCase().replace(/^lightning:/, "");
  const m = INVOICE_RE.exec(s);
  if (!m) fail("invoice is not a BOLT11 invoice");
  return { invoice: s, namesAmount: m[2] !== undefined };
}

function metadata(v: unknown): Metadata | undefined {
  if (v === undefined) return undefined;
  const m = obj(v, "metadata");
  if (JSON.stringify(m).length > METADATA_MAX_CHARS) fail(`metadata is longer than ${METADATA_MAX_CHARS} characters as JSON`);
  return m;
}

function exactlyOne(p: Record<string, unknown>, keys: readonly string[]): string {
  const present = keys.filter((k) => p[k] !== undefined);
  if (present.length !== 1) fail(`give exactly one of ${keys.join(", ")}`);
  return present[0]!;
}

function routeHints(v: unknown): RouteHop[][] {
  if (!Array.isArray(v) || v.length === 0) fail("route_hints must be a non-empty list of routes");
  return v.map((route, i) => {
    if (!Array.isArray(route) || route.length === 0) fail(`route_hints[${i}] must be a non-empty list of hops`);
    return route.map((h, j) => {
      const hop = obj(h, `route_hints[${i}][${j}]`);
      const out: RouteHop = {
        pubkey: hex(hop.pubkey, `route_hints[${i}][${j}].pubkey`, PUBKEY_RE),
        short_channel_id: (() => {
          const s = hop.short_channel_id;
          if (typeof s !== "string" || !SCID_RE.test(s)) fail(`route_hints[${i}][${j}].short_channel_id must be a decimal u64 or <block>x<tx>x<output>`);
          return s;
        })(),
      };
      for (const k of ["fee_base_msat", "fee_proportional_millionths", "cltv_expiry_delta"] as const) {
        if (hop[k] !== undefined) out[k] = count(hop[k], `route_hints[${i}][${j}].${k}`);
      }
      return out;
    });
  });
}

function tlvRecords(v: unknown): TlvRecord[] {
  if (!Array.isArray(v)) fail("tlv_records must be a list");
  const seen = new Set<number>();
  return v.map((r, i) => {
    const rec = obj(r, `tlv_records[${i}]`);
    const type = rec.type;
    if (typeof type !== "number" || !Number.isSafeInteger(type) || type < MIN_CUSTOM_TLV_TYPE) {
      fail(`tlv_records[${i}].type must be a whole number of ${MIN_CUSTOM_TLV_TYPE} or more`);
    }
    if (type === KEYSEND_PREIMAGE_TLV_TYPE) fail(`tlv_records[${i}]: ${KEYSEND_PREIMAGE_TLV_TYPE} is keysend's preimage, which the wallet sets`);
    if (seen.has(type)) fail(`tlv_records[${i}]: type ${type} is given twice`);
    seen.add(type);
    return { type, value: hex(rec.value, `tlv_records[${i}].value`) };
  });
}

function check(method: WalletMethod, raw: unknown): MethodParams[WalletMethod] {
  const p = obj(raw, "params");
  switch (method) {
    case "connect":
    case "get_info":
    case "get_budget":
    case "get_balance":
      return {};
    case "pay_invoice": {
      const inv = parsedInvoice(p.invoice);
      const out: PayInvoiceParams = { invoice: inv.invoice };
      if (p.amount !== undefined) {
        out.amount = amount(p.amount);
        if (inv.namesAmount) fail("the invoice names its own amount: amount is only for an invoice that names none");
      } else if (!inv.namesAmount) {
        fail("the invoice names no amount: give amount");
      }
      const m = metadata(p.metadata);
      if (m) out.metadata = m;
      return out;
    }
    case "pay_keysend": {
      if (typeof p.pubkey !== "string") fail("pubkey must be a node pubkey or a Sphinx address");
      const address = parseSphinxAddress(p.pubkey);
      if (address && p.route_hints !== undefined) fail("a Sphinx address carries its route hint: give route_hints or the address, not both");
      const out: PayKeysendParams = address
        ? { pubkey: address.pubkey, amount: amount(p.amount), route_hints: address.route_hints }
        : { pubkey: hex(p.pubkey, "pubkey", PUBKEY_RE), amount: amount(p.amount) };
      if (!address && p.route_hints !== undefined) out.route_hints = routeHints(p.route_hints);
      if (p.tlv_records !== undefined) out.tlv_records = tlvRecords(p.tlv_records);
      if (p.preimage !== undefined) out.preimage = hex(p.preimage, "preimage", HASH_RE);
      const m = metadata(p.metadata);
      if (m) out.metadata = m;
      return out;
    }
    case "make_invoice": {
      const out: MakeInvoiceParams = { amount: amount(p.amount) };
      if (p.description !== undefined) out.description = text(p.description, "description", 639);
      if (p.description_hash !== undefined) out.description_hash = hex(p.description_hash, "description_hash", HASH_RE);
      if (p.expiry !== undefined) {
        out.expiry = count(p.expiry, "expiry");
        if (out.expiry === 0) fail("expiry must be above 0 seconds");
      }
      const m = metadata(p.metadata);
      if (m) out.metadata = m;
      return out;
    }
    case "lookup_payment": {
      const k = exactlyOne(p, ["transaction_id", "payment_hash", "invoice"]);
      if (k === "transaction_id") return { transaction_id: text(p.transaction_id, "transaction_id", 256) || fail("transaction_id is empty") };
      if (k === "payment_hash") return { payment_hash: hex(p.payment_hash, "payment_hash", HASH_RE) };
      return { invoice: invoice(p.invoice) };
    }
    case "lookup_invoice": {
      const k = exactlyOne(p, ["payment_hash", "invoice"]);
      return k === "payment_hash" ? { payment_hash: hex(p.payment_hash, "payment_hash", HASH_RE) } : { invoice: invoice(p.invoice) };
    }
    case "list_transactions": {
      const out: ListTransactionsParams = {};
      if (p.from !== undefined) out.from = count(p.from, "from");
      if (p.until !== undefined) out.until = count(p.until, "until");
      if (out.from !== undefined && out.until !== undefined && out.from > out.until) fail("from is after until");
      if (p.limit !== undefined) {
        out.limit = count(p.limit, "limit");
        if (out.limit < 1 || out.limit > LIST_LIMIT_MAX) fail(`limit must be 1 to ${LIST_LIMIT_MAX}`);
      }
      if (p.offset !== undefined) out.offset = count(p.offset, "offset");
      if (p.unpaid !== undefined) {
        if (typeof p.unpaid !== "boolean") fail("unpaid must be true or false");
        out.unpaid = p.unpaid;
      }
      if (p.type !== undefined) {
        if (p.type !== "incoming" && p.type !== "outgoing") fail("type must be incoming or outgoing");
        out.type = p.type;
      }
      return out;
    }
    case "pay_lightning_address": {
      const k = exactlyOne(p, ["address", "lnurl"]);
      const target =
        k === "address"
          ? (() => {
              const a = text(p.address, "address", 320).trim().toLowerCase();
              if (!LIGHTNING_ADDRESS_RE.test(a)) fail("address is not a Lightning Address (name@domain)");
              return { address: a };
            })()
          : (() => {
              const l = text(p.lnurl, "lnurl", 2048).trim();
              const norm = l.toLowerCase().startsWith("lnurl1") ? l.toLowerCase() : l;
              if (!LNURL_RE.test(norm)) fail("lnurl is not an LNURL (lnurl1… or lnurlp://…)");
              return { lnurl: norm };
            })();
      const out: PayLightningAddressParams = { ...target, amount: amount(p.amount) };
      if (p.comment !== undefined) out.comment = text(p.comment, "comment", 2000);
      if (p.payer_data !== undefined) out.payer_data = obj(p.payer_data, "payer_data");
      const m = metadata(p.metadata);
      if (m) out.metadata = m;
      return out;
    }
  }
}

/** Check a request's params the way every side must: the params as the
 *  method takes them, normalized (hex and invoices lower case, a Sphinx
 *  address split, unknown keys dropped), or a `BAD_REQUEST`. */
export function checkParams<M extends WalletMethod>(method: M, params: unknown): ParamsCheck<M> {
  try {
    return { ok: true, params: check(method, params) as MethodParams[M] };
  } catch (err) {
    if (err instanceof Bad) return { ok: false, error: walletErrorBody("BAD_REQUEST", err.message) };
    throw err;
  }
}

/** Check a connection request (`app.yaml`'s `wallet:` block): the problems,
 *  one line each; none when it is good. */
export function connectionRequestProblems(raw: unknown): string[] {
  const problems: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ["wallet must be a mapping"];
  const r = raw as Record<string, unknown>;
  const methods = (key: string, required: boolean) => {
    const v = r[key];
    if (v === undefined) {
      if (required) problems.push(`${key} is required: the methods the app cannot work without`);
      return;
    }
    if (!Array.isArray(v)) return void problems.push(`${key} must be a list of methods`);
    for (const m of v) {
      if (!(REQUESTABLE_METHODS as readonly string[]).includes(m as string)) {
        problems.push(`${key}: "${String(m)}" is not a method an app may request (${REQUESTABLE_METHODS.join(", ")})`);
      }
    }
  };
  methods("request_methods", true);
  methods("optional_request_methods", false);
  const nt = r.notification_types;
  if (nt !== undefined) {
    if (!Array.isArray(nt)) problems.push("notification_types must be a list");
    else for (const n of nt) if (!(NOTIFICATION_TYPES as readonly string[]).includes(n as string)) problems.push(`notification_types: "${String(n)}" is not one of ${NOTIFICATION_TYPES.join(", ")}`);
  }
  if (r.max_amount !== undefined && (typeof r.max_amount !== "number" || !Number.isSafeInteger(r.max_amount) || r.max_amount <= 0)) {
    problems.push("max_amount must be a whole number of msat above 0");
  }
  if (r.renewal_period !== undefined) {
    if (!(RENEWAL_PERIODS as readonly string[]).includes(r.renewal_period as string)) problems.push(`renewal_period must be one of ${RENEWAL_PERIODS.join(", ")}`);
    else if (r.max_amount === undefined) problems.push("renewal_period needs max_amount");
  }
  if (r.expires_at !== undefined && r.expires_at !== null && (typeof r.expires_at !== "number" || !Number.isSafeInteger(r.expires_at) || r.expires_at <= 0)) {
    problems.push("expires_at must be unix seconds, or null");
  }
  const known = new Set(["request_methods", "optional_request_methods", "notification_types", "max_amount", "renewal_period", "expires_at"]);
  for (const k of Object.keys(r)) if (!known.has(k)) problems.push(`${k} is not a connection request field`);
  return problems;
}

// ── Checking results ───────────────────────────────────────────────────────

function isInt(v: unknown, min = 0): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= min;
}

function isHash(v: unknown): v is string {
  return typeof v === "string" && HASH_RE.test(v);
}

function oneOf(v: unknown, list: readonly string[]): boolean {
  return typeof v === "string" && list.includes(v);
}

function paymentProblems(p: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof p.transaction_id !== "string" || !p.transaction_id) out.push("transaction_id is missing");
  if (!oneOf(p.state, ["pending", "settled", "failed"])) out.push("state must be pending, settled or failed");
  if (!isHash(p.payment_hash)) out.push("payment_hash must be 64 hex");
  if (!isInt(p.amount)) out.push("amount must be msat");
  if (p.fees_paid !== undefined && !isInt(p.fees_paid)) out.push("fees_paid must be msat");
  if (!isInt(p.created_at)) out.push("created_at must be unix seconds");
  if (p.state === "settled") {
    if (!isHash(p.preimage)) out.push("a settled payment carries its preimage");
    if (!isInt(p.settled_at)) out.push("a settled payment carries settled_at");
  } else if (p.preimage !== undefined) {
    out.push("preimage only once settled");
  }
  if (p.state !== "failed" && p.failure_reason !== undefined) out.push("failure_reason only on a failed payment");
  return out;
}

function transactionProblems(t: Record<string, unknown>, where = ""): string[] {
  const out: string[] = [];
  const at = (s: string) => `${where}${s}`;
  if (!oneOf(t.type, ["incoming", "outgoing"])) out.push(at("type must be incoming or outgoing"));
  if (t.state !== undefined && !oneOf(t.state, ["pending", "settled", "accepted", "expired", "failed"])) out.push(at("state is not a transaction state"));
  if (!isHash(t.payment_hash)) out.push(at("payment_hash must be 64 hex"));
  if (!isInt(t.amount)) out.push(at("amount must be msat"));
  if (!isInt(t.created_at)) out.push(at("created_at must be unix seconds"));
  if (t.preimage !== undefined && t.state !== undefined && t.state !== "settled") out.push(at("preimage only once settled"));
  return out;
}

/** What is wrong with a host's ANSWER to a method; none when it is the shape
 *  the contract promises. For hosts' tests and the vectors. */
export function resultProblems(method: WalletMethod, raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ["the result must be an object"];
  const r = raw as Record<string, unknown>;
  switch (method) {
    case "pay_invoice":
    case "pay_keysend":
    case "pay_lightning_address":
      return paymentProblems(r);
    case "make_invoice": {
      const out = transactionProblems(r);
      if (r.type !== "incoming") out.push("an invoice made is incoming");
      if (typeof r.invoice !== "string") out.push("invoice is missing");
      return out;
    }
    case "lookup_invoice":
      return transactionProblems(r);
    case "list_transactions": {
      if (!Array.isArray(r.transactions)) return ["transactions must be a list"];
      return r.transactions.flatMap((t, i) => transactionProblems(t as Record<string, unknown>, `transactions[${i}]: `));
    }
    case "lookup_payment": {
      const out: string[] = [];
      if (typeof r.transaction_id !== "string" || !r.transaction_id) out.push("transaction_id is missing");
      if (!oneOf(r.type, ["incoming", "outgoing"])) out.push("type must be incoming or outgoing");
      if (!oneOf(r.state, ["pending", "accepted", "settled", "failed", "expired", "canceled"])) out.push("state is not a lookup state");
      if (!oneOf(r.payment_type, ["bolt11", "keysend"])) out.push("payment_type must be bolt11 or keysend");
      if (!isInt(r.amount)) out.push("amount must be msat");
      if (!isInt(r.created_at)) out.push("created_at must be unix seconds");
      const d = r.details as Record<string, unknown> | undefined;
      if (!d || typeof d !== "object") out.push("details is missing");
      else {
        if (!isHash(d.payment_hash)) out.push("details.payment_hash must be 64 hex");
        if (r.payment_type === "keysend" && (typeof d.pubkey !== "string" || !PUBKEY_RE.test(d.pubkey))) out.push("a keysend's details carry its pubkey");
        if (d.preimage !== undefined && r.state !== "settled") out.push("preimage only once settled");
      }
      return out;
    }
    case "get_info": {
      const out: string[] = [];
      if (!oneOf(r.network, NETWORKS)) out.push(`network must be one of ${NETWORKS.join(", ")}`);
      if (!Array.isArray(r.methods) || !r.methods.every(isWalletMethod)) out.push("methods must be wallet methods");
      if (!Array.isArray(r.notifications) || !r.notifications.every((n) => oneOf(n, NOTIFICATION_TYPES))) out.push("notifications must be notification types");
      return out;
    }
    case "get_budget": {
      if (Object.keys(r).length === 0) return [];
      const out: string[] = [];
      if (!isInt(r.used_budget)) out.push("used_budget must be msat");
      if (!isInt(r.total_budget)) out.push("total_budget must be msat");
      if (!oneOf(r.renewal_period, RENEWAL_PERIODS)) out.push("renewal_period is not a renewal period");
      return out;
    }
    case "get_balance":
      return isInt(r.balance) ? [] : ["balance must be msat"];
    case "connect": {
      const c = r.connection as Record<string, unknown> | undefined;
      if (!c || typeof c !== "object") return ["connection is missing"];
      const out: string[] = [];
      if (!Array.isArray(c.methods) || !c.methods.every((m) => oneOf(m, REQUESTABLE_METHODS))) out.push("connection.methods must be requestable methods");
      if (!Array.isArray(c.notification_types) || !c.notification_types.every((n) => oneOf(n, NOTIFICATION_TYPES))) out.push("connection.notification_types must be notification types");
      return out;
    }
  }
}

/** What is wrong with a notification; none when it is good. */
export function notificationProblems(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null) return ["a notification must be an object"];
  const n = raw as Record<string, unknown>;
  if (!oneOf(n.notification_type, NOTIFICATION_TYPES)) return [`notification_type must be one of ${NOTIFICATION_TYPES.join(", ")}`];
  const t = n.notification as Record<string, unknown> | undefined;
  if (!t || typeof t !== "object") return ["notification is missing"];
  const out = transactionProblems(t);
  if (typeof t.transaction_id !== "string" || !t.transaction_id) out.push("transaction_id is missing");
  const expected = n.notification_type === "payment_received" ? "incoming" : "outgoing";
  if (t.type !== expected) out.push(`${String(n.notification_type)} carries an ${expected} transaction`);
  if (n.notification_type === "payment_failed" && t.state !== "failed") out.push("payment_failed carries state failed");
  if (n.notification_type !== "payment_failed" && t.state !== undefined && t.state !== "settled") out.push(`${String(n.notification_type)} carries a settled transaction`);
  return out;
}
