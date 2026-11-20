// ── The store's Run form, its pure parts (plans/paid-runs.md §10 "The store") ─
//
// A live item that anyone may run — a workflow or a step on a publisher's
// server, listed by the index — gets a Run form on its store page: the
// price, what recent runs were charged, and fields drawn from its input.
// The form launches on the PUBLISHER's server, from the visitor's browser,
// with no credential of anyone's (`POST <base>/public/workflows/:name/run`,
// or `/public/steps/:type/run` for a step). A priced one answers 402: the
// store shows the invoice (../components/PaymentSheet), claims it until it
// settles (./visitor-pay `createClaimKeeper`), and sends the same launch
// again with the credential — `callPaying`, the loop a visitor's app page
// uses, over these HTTP answers read into its shape (`httpCallResult`). The
// credential is kept per publisher in the store page's `sessionStorage`,
// never in a URL.
//
// Pure, so the root test run covers it (store-run.test.ts); ./store-purse
// and ../components/Store wire it.

import type { FieldDesc, InputFieldDef } from "./api";
import { bindingsFromInputBlock } from "./run-inputs";
import type { CallResult } from "./visitor-pay";
import { formatUsd } from "./visitor-pay";

/** One item a publisher's server lets anyone run, as its `GET /public`
 *  lists it (src/public-runnable.ts `ListedRunnable`). */
export interface LiveRunnableItem {
  kind: "workflow" | "step";
  name: string;
  description?: string;
  base: number;
  markup: number;
  capUsd: number | null;
  reserve: number;
  results: "output" | "run";
  /** A workflow's `input:` block; a step's input JSON Schema. */
  input?: unknown;
  recent?: { days: number; runs: number; average: number };
}

/** What a run or call costs, in words: free, a fixed price, metered, or
 *  both. */
export function priceWords(r: Pick<LiveRunnableItem, "kind" | "base" | "markup" | "capUsd">): string {
  const unit = r.kind === "step" ? "a call" : "a run";
  if (!r.base && !r.markup) return "Free";
  if (!r.markup) return `${formatUsd(r.base)} ${unit}`;
  const metered = `${r.markup}× what ${unit} costs${r.capUsd !== null ? `, up to ${formatUsd(r.capUsd)} of cost` : ""}`;
  return r.base ? `${formatUsd(r.base)} + ${metered}` : metered[0]!.toUpperCase() + metered.slice(1);
}

/** The short badge a list shows: `free`, `$0.50`, `metered`. */
export function priceBadge(r: Pick<LiveRunnableItem, "base" | "markup">): string {
  if (!r.base && !r.markup) return "free";
  if (!r.markup) return formatUsd(r.base);
  return "metered";
}

/** The credit a run needs to start, and what recent ones were charged. */
export function priceNotes(r: Pick<LiveRunnableItem, "kind" | "reserve" | "recent" | "base" | "markup">): string[] {
  const notes: string[] = [];
  if (r.reserve > 0) notes.push(`Needs ${formatUsd(r.reserve)} of credit to start; what ${r.kind === "step" ? "the call" : "the run"} does not use stays yours for later ones here.`);
  if (r.recent) {
    const word = r.kind === "step" ? "call" : "run";
    if (!r.recent.runs) notes.push(`No ${word}s in the last ${r.recent.days} days.`);
    else if (!r.base && !r.markup) notes.push(`${r.recent.runs} ${word}${r.recent.runs === 1 ? "" : "s"} in the last ${r.recent.days} days.`);
    else notes.push(`${r.recent.runs} ${word}${r.recent.runs === 1 ? "" : "s"} in the last ${r.recent.days} days, ${formatUsd(r.recent.average)} charged on average.`);
  }
  return notes;
}

/** The form's fields: a workflow's `input:` block as the Run popover draws
 *  it, or a step's input JSON Schema — strings, numbers, booleans, enums,
 *  and anything else as JSON. */
export function runFields(item: Pick<LiveRunnableItem, "kind" | "input">): FieldDesc[] {
  const input = item.input as Record<string, unknown> | null | undefined;
  if (!input || typeof input !== "object") return [];
  if (item.kind === "workflow") return bindingsFromInputBlock(input as Record<string, InputFieldDef>).map((b) => b.field);
  const props = (input["properties"] ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(input["required"]) ? (input["required"] as unknown[]).filter((x): x is string => typeof x === "string") : []);
  return Object.entries(props).map(([name, p]) => {
    const t = p?.["type"];
    const en = Array.isArray(p?.["enum"]) && (p["enum"] as unknown[]).every((v) => typeof v === "string") ? (p["enum"] as string[]) : undefined;
    const kind: FieldDesc["kind"] = en ? "enum" : t === "string" ? "string" : t === "number" || t === "integer" ? "number" : t === "boolean" ? "boolean" : "json";
    return {
      name,
      kind,
      required: required.has(name) && p?.["default"] === undefined,
      ...(p?.["default"] !== undefined ? { default: p["default"] } : {}),
      ...(en ? { enumValues: en } : {}),
      ...(typeof p?.["description"] === "string" ? { description: p["description"] } : {}),
    };
  });
}

/** The values a person entered, as the input to send: empty ones left out
 *  (a default fills them), a JSON field parsed. Or why not: a required field
 *  left empty, a JSON field that does not parse. */
export function inputOf(fields: FieldDesc[], values: Record<string, unknown>): { input: Record<string, unknown> } | { error: string } {
  const input: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.name];
    if (v === undefined || v === "" || v === null) {
      if (f.required && f.kind !== "boolean") return { error: `${f.label ?? f.name} is required` };
      continue;
    }
    if (f.kind === "json" && typeof v === "string") {
      try {
        input[f.name] = JSON.parse(v);
      } catch {
        return { error: `${f.label ?? f.name} is not JSON` };
      }
    } else if (f.kind === "number" && typeof v === "string") {
      const n = Number(v);
      if (!Number.isFinite(n)) return { error: `${f.label ?? f.name} is not a number` };
      input[f.name] = n;
    } else input[f.name] = v;
  }
  return { input };
}

/** The 402's fields a payer reads (§17.5's challenge). */
const CHALLENGE_FIELDS = ["macaroon", "invoice", "usd", "sats", "rate", "description", "expires", "remaining_usd", "reason", "carries"] as const;

/** A public door's HTTP answer in the shape `callPaying` reads: 2xx its
 *  body; a 402 its challenge as `{ payment_required }`; anything else an
 *  error naming its code and when to try again. */
export function httpCallResult(status: number, body: unknown, retryAfter?: string | null): CallResult {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (status >= 200 && status < 300) return { structuredContent: b, content: [{ type: "text", text: JSON.stringify(b) }] };
  if (status === 402) {
    const pick: Record<string, unknown> = {};
    for (const k of CHALLENGE_FIELDS) if (b[k] !== undefined) pick[k] = b[k];
    const out = { payment_required: pick };
    return { structuredContent: out, content: [{ type: "text", text: JSON.stringify(out) }] };
  }
  const message = typeof b["error"] === "string" ? b["error"] : `refused (${status})`;
  const code = typeof b["code"] === "string" ? b["code"] : undefined;
  const after = retryAfter ? Number(retryAfter) : NaN;
  const error = `${code && !message.startsWith(`${code}:`) ? `${code}: ` : ""}${message}${Number.isFinite(after) && after > 0 ? ` (try again in ${after} s)` : ""}`;
  // The code and status ride along, so the paying loop tells the door's
  // own refusal of the credential (401 invalid_token) from a step's failure
  // whose text merely mentions it (`refusesCredential`).
  return { isError: true, structuredContent: { error, status, ...(code ? { code } : {}) }, content: [{ type: "text", text: JSON.stringify({ error }) }] };
}

/** A result's error, or undefined. */
export function errorOf(r: CallResult): string | undefined {
  if (!r.isError) return undefined;
  const text = r.content?.find((c) => c.type === "text" && typeof c.text === "string")?.text ?? "";
  try {
    const e = (JSON.parse(text) as { error?: unknown }).error;
    if (typeof e === "string") return e;
  } catch {
    // Plain text.
  }
  return text || "refused";
}

/** A result's body, when it is not an error. */
export function bodyOf(r: CallResult): Record<string, unknown> | undefined {
  if (r.isError) return undefined;
  return r.structuredContent && typeof r.structuredContent === "object" ? (r.structuredContent as Record<string, unknown>) : undefined;
}

/** A run status that means it is still going. */
const IN_FLIGHT = new Set(["running", "paused", "pending", "cancelling", "pausing", "queued", "starting"]);

/** The launcher's view says the run has ENDED — success, error, cancelled,
 *  stale — by its own status, whether or not its charge is recorded yet
 *  (`charge_pending`). */
export function runEnded(view: Record<string, unknown>): boolean {
  const status = view["status"];
  return typeof status === "string" && !IN_FLIGHT.has(status);
}

/** A key per press of Run: sent again with every retry of that launch — after
 *  a payment, after a lost answer — so it is the same run while it is in
 *  flight, never a second one. */
export function newLaunchKey(random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  const bytes = random(new Uint8Array(12));
  return `store:${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** A run launched from this tab: what reads it back (the run token is a
 *  receipt for that run alone, never credit). */
export interface LaunchedRun {
  workflow: string;
  runId: string;
  token: string;
  at: string;
}

/** The runs this tab launched on a publisher's server, newest first, kept
 *  beside the purse so a reload shows them again. */
export function loadRuns(storage: Pick<Storage, "getItem"> | undefined, key: string): LaunchedRun[] {
  try {
    const raw = storage?.getItem(key);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v)
      ? v.filter((r): r is LaunchedRun => !!r && typeof r === "object" && typeof (r as LaunchedRun).workflow === "string" && typeof (r as LaunchedRun).runId === "string" && typeof (r as LaunchedRun).token === "string")
      : [];
  } catch {
    return [];
  }
}

/** The most runs a tab keeps per publisher. */
export const RUNS_KEPT = 20;

export function rememberRun(runs: LaunchedRun[], run: LaunchedRun): LaunchedRun[] {
  return [run, ...runs.filter((r) => !(r.workflow === run.workflow && r.runId === run.runId))].slice(0, RUNS_KEPT);
}

/** Where a run's file opens: the publisher's link, with the run token. */
export function runFileUrl(base: string, url: string, token: string): string {
  if (!url.startsWith("/public/")) return url;
  return `${base.replace(/\/+$/, "")}${url}${url.includes("?") ? "&" : "?"}t=${encodeURIComponent(token)}`;
}

/** The sessionStorage keys for a publisher's server: its purse and its runs. */
export const storePurseKey = (base: string) => `strut.store.purse:${base.replace(/\/+$/, "")}`;
export const storeRunsKey = (base: string) => `strut.store.runs:${base.replace(/\/+$/, "")}`;
