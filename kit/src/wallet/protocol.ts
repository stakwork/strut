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

// ── The native bridge (specs/WALLET.md §1.1) ───────────────────────────────
// A host whose wallet is native (Peel) shows strut's UI in a web view; the
// UI, as the main frame, relays the app frame's calls to it. These are the
// two directions of that relay.

/** The handler strut's UI posts to: `window.webkit.messageHandlers.strutWallet`,
 *  a `WKScriptMessageHandlerWithReply` (or the platform's like), one promise
 *  per message, answered only for the main frame at the origin it loaded. */
export const NATIVE_WALLET_HANDLER = "strutWallet";
/** The page global a native host calls to push a notification in:
 *  `window.strutWallet.notify(message)`. strut's UI installs it. */
export const NATIVE_WALLET_GLOBAL = "strutWallet";

/** The app a message is for, as strut's UI hosts it. */
export interface NativeWalletApp {
  name: string;
  version: string;
  /** The peer (org) the app lives on; absent for this strut's own app. */
  peer?: string;
  /** The manifest's title, for the sheets. */
  title: string;
  /** The version's `wallet:` request; null when it asks for none. */
  request: ConnectionRequest | null;
}

/** UI → native. `capability` asks what the native wallet offers this app
 *  (answered `{ result: WalletCapability }`); `call` is one method, its
 *  params already through `checkParams`. */
export type NativeWalletMessage =
  | { v: 1; op: "capability"; app: NativeWalletApp }
  | { v: 1; op: "call"; method: WalletMethod; params: unknown; app: NativeWalletApp }
  | HostWalletMessage;

/** Native → UI, the reply to a message: always resolved, a refusal in
 *  `error`. A rejected promise is a transport failure, never an answer. */
export type NativeWalletReply = { result: unknown } | { error: WalletErrorBody };

/** Native → UI, pushed: `window.strutWallet.notify(this)` (an object, or the
 *  same as a JSON string). */
export interface NativeWalletNotify {
  v: 1;
  app: { name: string; peer?: string };
  notification: WalletNotification;
}

/** One key per hosted app: `<peer>/<name>`, `/<name>` for this strut's own. */
export function nativeAppKey(app: { name: string; peer?: string }): string {
  return `${app.peer ?? ""}/${app.name}`;
}

/** A host's capability out of `hostCapabilities`, when it is one this
 *  contract version reads. */
export function walletCapabilityOf(hostCapabilities: unknown): WalletCapability | undefined {
  const c = (hostCapabilities as { experimental?: Record<string, unknown> } | undefined)?.experimental?.[WALLET_CAPABILITY];
  return isWalletCapability(c) ? c : undefined;
}

export function isWalletCapability(c: unknown): c is WalletCapability {
  if (typeof c !== "object" || c === null) return false;
  const w = c as Record<string, unknown>;
  return (
    w.version === WALLET_PROTOCOL_VERSION &&
    Array.isArray(w.methods) && w.methods.every(isWalletMethod) &&
    Array.isArray(w.notifications) && w.notifications.every((n) => oneOf(n, NOTIFICATION_TYPES)) &&
    typeof w.wallet === "string" && typeof w.connected === "boolean"
  );
}

// ── The HOST's own purchase (specs/WALLET.md §1.2) ─────────────────────────
// A VISITOR's page — a public app, of this strut server or of another one
// (plans/paid-runs.md §10) — may launch a priced workflow. Its HOST pays for
// the credit the launch needs, never the page: in a native host's web view
// (Peel), strut's UI asks the native wallet to pay the invoice with one tap
// on the native host's own sheet, before it falls back to showing the
// invoice as a QR code. Not an app's call: no app connection, no app
// budget, no `strut/wallet/*` method. The host checked the challenge
// before asking (the invoice and the macaroon name one payment hash, the
// invoice asks what the challenge says); the native host decodes the invoice
// again itself.

/** The ops a host page sends that are its own, not an app's. */
export const HOST_WALLET_OPS = ["buy_credit", "buy_credit_status", "buy_credit_cancel", "sign_in"] as const;
export type HostWalletOp = (typeof HOST_WALLET_OPS)[number];

/** UI → native, the host's own: what the native host takes
 *  (`host_capability`), a purchase (`buy_credit`), where a purchase it
 *  answered `pending` stands now (`buy_credit_status`), taking down the
 *  sheet of a purchase the page stopped waiting for (`buy_credit_cancel`),
 *  and signing a visitor in to a public app (`sign_in`). */
export type HostWalletMessage =
  | { v: 1; op: "host_capability" }
  | { v: 1; op: "buy_credit"; purchase: CreditPurchase }
  | { v: 1; op: "buy_credit_status"; payment_hash: string }
  | { v: 1; op: "buy_credit_cancel"; payment_hash: string }
  | SignInRequest;

/** What `host_capability` answers: `{ result: HostWalletCapability }`. A
 *  native host that does not know the op answers anything else, or nothing:
 *  then the host shows the QR code. */
export interface HostWalletCapability {
  version: number;
  /** The ops it takes, of the ones this contract knows. */
  ops: HostWalletOp[];
  /** Its name for a person ("Peel"): what the host's own sheet calls it. */
  wallet?: string;
}

/** A native host's capability as this version reads it: an op it does not
 *  know (a newer native host's) is left out, never a reason to read none;
 *  a name longer than 40 characters is left out. Undefined when the answer
 *  is not one — another version, no list of ops. */
export function hostWalletCapabilityOf(c: unknown): HostWalletCapability | undefined {
  if (typeof c !== "object" || c === null) return undefined;
  const w = c as Record<string, unknown>;
  if (w.version !== WALLET_PROTOCOL_VERSION || !Array.isArray(w.ops)) return undefined;
  const ops = HOST_WALLET_OPS.filter((o) => (w.ops as unknown[]).includes(o));
  const wallet = typeof w.wallet === "string" && w.wallet.trim() && w.wallet.length <= 40 ? w.wallet.trim() : undefined;
  return { version: WALLET_PROTOCOL_VERSION, ops, ...(wallet ? { wallet } : {}) };
}

/** Why the credit is being bought, beside the invoice: the server's own words
 *  (§17.5's challenge, plans/paid-runs.md §4). */
export interface CreditReason {
  /** The new macaroon inherits the presented token's credit: once paid it
   *  replaces that credential. */
  carries: boolean;
  /** Why the credit held was not enough: `short`, `expired`, `replaced`. */
  reason?: "short" | "expired" | "replaced";
  /** What the credit held still has, when it ran short. */
  remaining_usd?: number;
}

/** A purchase of CREDIT on a strut server, for a visitor's page: what the
 *  native sheet shows and what it pays. */
export interface CreditPurchase {
  /** BOLT11, lower case. */
  invoice: string;
  /** hex 64: the invoice's, which the host checked is the macaroon's. */
  payment_hash: string;
  /** msat: what the invoice asks, which the host decoded: `sats × 1000`. */
  amount: number;
  sats: number;
  /** The CREDIT the server says this payment buys, in dollars — its own
   *  figure, never the price: the price is `amount`, which a native host
   *  shows in sats and turns into dollars at a rate of its own. */
  usd: number;
  /** The rate the server quoted at. */
  rate?: { usd_per_btc: number; at: string; source: string };
  /** The server's words for what it sells (quoted as the server's). */
  description: string;
  /** Unix seconds: when the invoice ends, as the host decoded it. */
  expires_at: number;
  /** The strut server the credit is bought on, as its base URL: https, or
   *  http on this machine (loopback). */
  seller: string;
  /** The public app whose page asked, as the seller serves it. */
  app: { name: string; version: string; title: string };
  /** The workflow the launch is for. */
  workflow: string;
  /** What the credit is for beside this launch. */
  credit: CreditReason;
}

/** The longest description, title or name a purchase carries. */
export const CREDIT_TEXT_MAX = 1000;

const LOOPBACK_HOST_RE = /^(localhost|[a-z0-9-]+\.localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/;

/** Whether a URL names a strut server a host may buy credit on: https, or
 *  http on this machine; no credentials, query or fragment. */
export function isSellerUrl(v: unknown): v is string {
  if (typeof v !== "string") return false;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  if (u.username || u.password || u.search || u.hash) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && LOOPBACK_HOST_RE.test(u.hostname.toLowerCase());
}

/** What is wrong with a purchase; none when it is good. Shapes and the
 *  arithmetic between them: the native host still decodes the invoice and
 *  holds it to `amount`, `payment_hash` and `expires_at` before its sheet. */
export function creditPurchaseProblems(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ["a purchase must be an object"];
  const p = raw as Record<string, unknown>;
  const out: string[] = [];
  const shortText = (v: unknown, what: string, required = true) => {
    if (v === undefined && !required) return;
    if (typeof v !== "string" || (required && !v)) out.push(`${what} must be a string`);
    else if (v.length > CREDIT_TEXT_MAX) out.push(`${what} is longer than ${CREDIT_TEXT_MAX} characters`);
  };
  const inv = typeof p.invoice === "string" ? INVOICE_RE.exec(p.invoice) : null;
  if (!inv || p.invoice !== (p.invoice as string).toLowerCase()) out.push("invoice must be a BOLT11 invoice, lower case");
  else if (inv[2] === undefined) out.push("invoice must name its amount");
  if (!isHash(p.payment_hash)) out.push("payment_hash must be 64 hex");
  if (!isInt(p.sats, 1)) out.push("sats must be a whole number above 0");
  if (!isInt(p.amount, 1)) out.push("amount must be msat above 0");
  else if (isInt(p.sats, 1) && p.amount !== p.sats * 1000) out.push("amount must be sats × 1000");
  if (typeof p.usd !== "number" || !Number.isFinite(p.usd) || p.usd < 0) out.push("usd must be a number of dollars, 0 or more");
  if (p.rate !== undefined) {
    const r = p.rate as Record<string, unknown> | null;
    if (!r || typeof r !== "object" || typeof r.usd_per_btc !== "number" || !(r.usd_per_btc > 0) || typeof r.at !== "string" || typeof r.source !== "string") {
      out.push("rate must be { usd_per_btc, at, source }");
    }
  }
  shortText(p.description, "description");
  if (!isInt(p.expires_at, 1)) out.push("expires_at must be unix seconds");
  if (!isSellerUrl(p.seller)) out.push("seller must be a strut server's base URL: https, or http on loopback, with no credentials, query or fragment");
  const app = p.app as Record<string, unknown> | undefined;
  if (!app || typeof app !== "object") out.push("app is missing");
  else {
    shortText(app.name, "app.name");
    shortText(app.version, "app.version");
    shortText(app.title, "app.title");
  }
  shortText(p.workflow, "workflow");
  const c = p.credit as Record<string, unknown> | undefined;
  if (!c || typeof c !== "object") out.push("credit is missing");
  else {
    if (typeof c.carries !== "boolean") out.push("credit.carries must be true or false");
    if (c.reason !== undefined && !oneOf(c.reason, ["short", "expired", "replaced"])) out.push("credit.reason must be short, expired or replaced");
    if (c.remaining_usd !== undefined && (typeof c.remaining_usd !== "number" || !Number.isFinite(c.remaining_usd) || c.remaining_usd < 0)) {
      out.push("credit.remaining_usd must be a number of dollars, 0 or more");
    }
  }
  return out;
}

/** What the host does with the native host's answer to `buy_credit` (or
 *  `buy_credit_status`): the payment settled with a preimage that PROVES it
 *  (`paid`: the credential is `<macaroon>:<preimage>`); it was sent and has
 *  not settled, or says it settled without proof (`pending`: the person
 *  tapped, so the host shows the invoice NO MORE — a seller holding the
 *  first payment could settle a second — and waits on its claim and on
 *  `buy_credit_status`); or nothing was sent: a refusal, a decline, a
 *  payment that failed, an answer for another invoice (`fallback`: the
 *  invoice as a QR code — still claimed, so a payment that did go through
 *  buys the credit). */
export type CreditReplyOutcome =
  | { outcome: "paid"; preimage: string }
  | { outcome: "pending" }
  | { outcome: "fallback"; code: WalletErrorCode; message: string };

/** Read the native host's reply to `buy_credit` for the invoice whose
 *  payment hash is `paymentHash`. A reply is a `{ result: Payment }` (a pay
 *  method's answer, §3) or `{ error }` (§4.1). */
export async function readCreditReply(reply: unknown, paymentHash: string): Promise<CreditReplyOutcome> {
  const fallback = (code: WalletErrorCode, message: string): CreditReplyOutcome => ({ outcome: "fallback", code, message });
  if (typeof reply !== "object" || reply === null) return fallback("INTERNAL", "the wallet answered with neither a result nor an error");
  const r = reply as { result?: unknown; error?: unknown };
  if ("error" in r) {
    const e = r.error as { message?: unknown; data?: { code?: unknown } } | undefined;
    const code = isWalletErrorCode(e?.data?.code) ? e!.data!.code : "OTHER";
    return fallback(code, typeof e?.message === "string" && e.message ? e.message : code);
  }
  if (!("result" in r)) return fallback("INTERNAL", "the wallet answered with neither a result nor an error");
  const pay = r.result as Partial<Payment> | null;
  if (!pay || typeof pay !== "object" || pay.payment_hash !== paymentHash.toLowerCase()) {
    return fallback("INTERNAL", "the wallet's answer is not a payment of this invoice");
  }
  if (pay.state === "failed") return fallback("PAYMENT_FAILED", (typeof pay.failure_reason === "string" && pay.failure_reason) || "the payment failed");
  if (pay.state !== "settled" && pay.state !== "pending") return fallback("INTERNAL", "the wallet's answer is not a payment state");
  // A payment of this invoice that was sent: from here on, never the QR code.
  if (pay.state === "pending" || resultProblems("pay_invoice", pay).length) return { outcome: "pending" };
  let proven = false;
  try {
    proven = await verifyPreimage(pay.preimage!, paymentHash);
  } catch {
    // No WebCrypto here (an insecure page): unproven, the claim decides.
  }
  return proven ? { outcome: "paid", preimage: pay.preimage!.toLowerCase() } : { outcome: "pending" };
}

// ── Signing a visitor in (specs/WALLET.md §1.2 "sign_in") ──────────────────
// A public app's page asks its host to sign the visitor in
// (`useVisitor().signIn()`, plans/app-repos.md §5). In a native host's web
// view (Peel) whose wallet holds the person's Sphinx account, strut's UI
// fetches the SELLER's visitor challenge and asks the native host to sign
// it — method `sphinx`, checked by the seller's `ln-message` verifier. Not
// an app's call: the page never sees the request, the challenge or a key.
// The native host signs ONLY a strut visitor challenge whose `host` is the
// seller's (on the iPhone: the origin it loaded), never a message a page
// chose: there is no general `sign_message`.

/** What every strut visitor challenge starts with (src/auth.ts). */
export const VISITOR_CHALLENGE_PREFIX = "strut-visitor.";
/** The longest challenge a sign-in carries; strut's are about 200. */
export const VISITOR_CHALLENGE_MAX = 2048;

/** What a strut visitor challenge claims — read, not verified: its HMAC is
 *  the seller's to check. `exp` is unix MILLISECONDS. */
export interface VisitorChallengeClaims {
  /** The seller's host name, lower case, no port: what it was minted for. */
  host: string;
  /** Whose key signs: the person's root key, or the domain's child key
   *  (LUD-05, derived from `host`). */
  visitorKey: "root" | "domain";
  nonce: string;
  exp: number;
}

/** UI → native: sign the visitor in to `seller`'s public `app` by signing
 *  `challenge` (the seller's `GET /visitors/challenge`). */
export interface SignInRequest {
  v: 1;
  op: "sign_in";
  /** The strut server the visitor signs in to, as its base URL
   *  (`isSellerUrl`). */
  seller: string;
  /** The public app whose page asked, as the seller serves it. */
  app: { name: string; version: string; title: string };
  challenge: string;
}

/** Native → UI, `{ result: SignInAnswer }`: the key that signed and its
 *  Lightning signed message over the challenge's UTF-8 bytes — what
 *  sphinx-rs's `sign_bytes` answers — both hex. */
export interface SignInAnswer {
  /** The compressed secp256k1 key, 33 bytes: the root key's, or the
   *  domain's child key's. */
  key: string;
  /** 65 bytes, `[31 + recovery id] ‖ r ‖ s`, over
   *  sha256(sha256("Lightning Signed Message:" ‖ challenge)). */
  sig: string;
  /** The account's Sphinx address, `<pubkey>_<lsp_pubkey>_<scid>`, from
   *  `myContactInfo`: only when the answer is the ROOT key's. Its pubkey is
   *  the root sign-in key (`pubkey_from_seed(idx: 0)`, the key
   *  `get_my_contact_info` builds the address from). The seller keeps it to
   *  keysend a payout; `readSignInReply` drops one whose pubkey is not `key`. */
  address?: string;
}

const B64URL = /^[A-Za-z0-9_-]+$/;

function base64urlText(s: string): string | undefined {
  if (!B64URL.test(s)) return undefined;
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
    const bin = atob(b64);
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

/** What a challenge claims, or undefined for anything that is not a strut
 *  visitor challenge: `strut-visitor.<base64url JSON>.<base64url HMAC>`. */
export function visitorChallengeClaims(challenge: unknown): VisitorChallengeClaims | undefined {
  if (typeof challenge !== "string" || challenge.length > VISITOR_CHALLENGE_MAX || !challenge.startsWith(VISITOR_CHALLENGE_PREFIX)) return undefined;
  const parts = challenge.slice(VISITOR_CHALLENGE_PREFIX.length).split(".");
  if (parts.length !== 2 || !B64URL.test(parts[1]!)) return undefined;
  const text = base64urlText(parts[0]!);
  if (text === undefined) return undefined;
  let c: Record<string, unknown>;
  try {
    c = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!c || typeof c !== "object" || Array.isArray(c)) return undefined;
  const { host, visitorKey, nonce, exp } = c;
  if (typeof host !== "string" || !host || typeof nonce !== "string" || !nonce || !isInt(exp, 1)) return undefined;
  if (visitorKey !== "root" && visitorKey !== "domain") return undefined;
  return { host, visitorKey, nonce, exp };
}

/** A seller's host name as a challenge names it: the URL's host name, lower
 *  case, with no port and no IPv6 brackets. Undefined for no URL. */
export function sellerHost(seller: unknown): string | undefined {
  if (typeof seller !== "string") return undefined;
  try {
    return new URL(seller).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return undefined;
  }
}

/** What is wrong with a `sign_in` request; none when the host may show its
 *  sheet. Above all: the challenge is a strut visitor challenge minted for
 *  the SELLER's host (on the iPhone the native host checks it against the
 *  origin it loaded, not `seller`), and has not ended at `nowMs`. */
export function signInRequestProblems(raw: unknown, nowMs = Date.now()): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ["a sign-in request must be an object"];
  const r = raw as Record<string, unknown>;
  const out: string[] = [];
  if (r.v !== 1 || r.op !== "sign_in") out.push(`a sign-in request is { v: 1, op: "sign_in", … }`);
  if (!isSellerUrl(r.seller)) out.push("seller must be a strut server's base URL: https, or http on loopback, with no credentials, query or fragment");
  const app = r.app as Record<string, unknown> | undefined;
  if (!app || typeof app !== "object") out.push("app is missing");
  else {
    for (const k of ["name", "version", "title"] as const) {
      const v = app[k];
      if (typeof v !== "string" || !v) out.push(`app.${k} must be a string`);
      else if (v.length > CREDIT_TEXT_MAX) out.push(`app.${k} is longer than ${CREDIT_TEXT_MAX} characters`);
    }
  }
  const claims = visitorChallengeClaims(r.challenge);
  if (!claims) out.push("challenge must be a strut visitor challenge (strut-visitor.<claims>.<hmac>): nothing else is signed");
  else {
    const host = sellerHost(r.seller);
    if (host !== undefined && claims.host !== host) out.push(`the challenge is for ${claims.host}, not the seller ${host}: never signed`);
    if (claims.exp <= nowMs) out.push("the challenge has ended");
  }
  return out;
}

/** What the host does with the native host's answer to `sign_in`: `signed`,
 *  the key and signature to post (`POST <seller>/visitors/session { challenge,
 *  method: "sphinx", key, sig, address? }`), or `refused` with the code — the person
 *  declined (`USER_REJECTED`), the native host wants a fresh tap
 *  (`RESTRICTED`), refused the request (`BAD_REQUEST`) — or an answer that
 *  is neither (`INTERNAL`). */
export type SignInReplyOutcome =
  | { outcome: "signed"; key: string; sig: string; address?: string }
  | { outcome: "refused"; code: WalletErrorCode; message: string };

const KEY_HEX = /^0[23][0-9a-fA-F]{64}$/;
const SIG_HEX = /^[0-9a-fA-F]{130}$/;

export function readSignInReply(reply: unknown): SignInReplyOutcome {
  const refused = (code: WalletErrorCode, message: string): SignInReplyOutcome => ({ outcome: "refused", code, message });
  if (typeof reply !== "object" || reply === null) return refused("INTERNAL", "the wallet answered with neither a result nor an error");
  const r = reply as { result?: unknown; error?: unknown };
  if ("error" in r) {
    const e = r.error as { message?: unknown; data?: { code?: unknown } } | undefined;
    const code = isWalletErrorCode(e?.data?.code) ? e!.data!.code : "OTHER";
    return refused(code, typeof e?.message === "string" && e.message ? e.message : code);
  }
  const a = r.result as Partial<SignInAnswer> | null | undefined;
  if (!a || typeof a !== "object" || typeof a.key !== "string" || typeof a.sig !== "string" || !KEY_HEX.test(a.key) || !SIG_HEX.test(a.sig)) {
    return refused("INTERNAL", "the wallet's answer is not { key, sig }: a compressed key and a 65-byte signature, hex");
  }
  // The address rides along only when it is `key`'s own; else dropped.
  const address = typeof a.address === "string" ? a.address.trim().toLowerCase() : undefined;
  const keep = address !== undefined && parseSphinxAddress(address)?.pubkey === a.key.toLowerCase();
  return { outcome: "signed", key: a.key.toLowerCase(), sig: a.sig.toLowerCase(), ...(keep ? { address } : {}) };
}
