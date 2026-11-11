/**
 * AN AGENT AS A BUYER (plans/paid-runs.md §10 "An agent over MCP", work item
 * 8): the tools `POST /public/mcp` serves beside a visitor page's
 * `step_run`, for an agent with no account on this strut server —
 *
 *   list_public   what anyone may run here: price, reserve, what recent runs
 *                 were charged, and the input to send (`GET /public`'s
 *                 `runnable`)
 *   run_workflow  a launch through the ONE launcher (`PublicDoors.launch`,
 *                 src/public-routes.ts): the address's budget, the drain, the
 *                 body, the caps, the price, the `key` — then waits a while
 *                 for the run, and hands back a handle when it is still going
 *   call_tool     a tool's call through `PublicDoors.call` (the calls'
 *                 budget, then src/public-tools.ts `call`)
 *   get_run       the launcher's view of a run, by its RUN TOKEN, waiting
 *                 while it is in flight
 *   get_credit    a credit token's balance and the runs and calls it paid
 *                 for, each run with its token; with the macaroon alone, its
 *                 claim (§4.4)
 *
 * A priced item with no credit answers a RESULT, never an error: `{
 * payment_required: { macaroon, invoice, usd, sats, rate, description,
 * expires, remaining_usd?, reason?, carries? } }`. The agent pays the
 * invoice with whatever wallet it has and calls again with `payment:
 * "<macaroon>:<preimage>"` — or the connection's own `Authorization: L402
 * …`, which every tool reads when the call names no `payment`. Nothing is
 * kept between requests: the door is stateless, so the credential an agent
 * holds works on any connection, and `payment: "<macaroon>"` with no
 * preimage claims an invoice a person paid from a phone.
 *
 * What keeps an agent from losing a run or paying twice:
 * - **A key on every priced launch.** The agent's `key`, else one the
 *   launcher makes from the workflow and the input as its `input:` block
 *   parsed it (keys sorted), scoped by the credit token: the same launch sent
 *   again while its run is in flight — after paying, after a lost answer —
 *   is that run, with nothing more set aside. A FREE launch gets a key only
 *   when the agent passes one: its scope is the caller's address, which a
 *   hosted agent's vendor shares between unrelated users.
 * - **A way back to a run whose answer was lost.** Once a run ended its key
 *   no longer dedupes (a key matches only a run in flight, ruled), so the
 *   way back is `get_credit`: the runs and calls the credential paid for,
 *   each run with its id, status, charge and RUN TOKEN. Every tool's
 *   description says to read it before calling again after a timeout or a
 *   dropped answer; and the first progress note of a launch carries its
 *   `run_id` and `token`.
 * - **No call outlives a client's patience.** Every tool answers within
 *   `AGENT_DEADLINE_MS` (45 s) — under the MCP SDK's 60 s default request
 *   timeout, which progress resets only when the client asks — with what it
 *   has: a run still going answers its handle, a call still going says it
 *   may yet be charged. Progress goes to a client that passed a
 *   `progressToken` (from the start of a launch, then every 5 s).
 * - **What was paid for is not cut.** No builder cap on these results: a
 *   call's output comes back whole (the door's own 5 MB cap), and a run's
 *   output over `RUN_OUTPUT_INLINE_MAX` is left out of the answer with its
 *   HTTP url (the run token on it), where it is read in full.
 */
import { z } from "zod";
import { tool, type ToolSet } from "ai";
import { createHash } from "node:crypto";
import type { PublicAnswer, PublicDoors, PublicLaunchOutcome } from "./public-routes.js";
import type { ListedRunnable } from "./public-runnable.js";

/** How long `run_workflow` and `get_run` wait for a run by default, in seconds. */
export const AGENT_RUN_WAIT_S = 25;
/** Every agent tool answers within this, whatever it waits on: under the
 *  MCP SDK's 60 s default request timeout, which progress does not reset
 *  unless the client asks (`resetTimeoutOnProgress`). */
export const AGENT_DEADLINE_MS = 45_000;
/** The most `wait` may ask, in seconds: the deadline's. */
export const AGENT_WAIT_MAX_S = AGENT_DEADLINE_MS / 1000;
/** Progress this often while a tool holds the call. The door sends a yield's
 *  progress when the NEXT one arrives (src/ai/mcp.ts: it cannot know which
 *  yield is the last), so a beat reaches the client one beat late. */
export const AGENT_PROGRESS_EVERY_MS = 5_000;
/** A run's output larger than this (as JSON) is left out of the tool's
 *  answer, with the run's url to read it from: a model's context is not the
 *  place for megabytes, and the run keeps it. */
export const RUN_OUTPUT_INLINE_MAX = 100_000;

export interface PublicAgentOptions {
  doors: PublicDoors;
  /** The caller's address (`visitorAddress`). */
  who: string;
  /** The connection's `Authorization`, when it sent an L402 credential. */
  authorization?: string | undefined;
  /** This server's base URL: every link the tools hand out is absolute. */
  publicUrl: string;
  /** Progress cadence and the deadline (tests). */
  progressEveryMs?: number;
  deadlineMs?: number;
}

/** What to do after a timeout or a dropped answer: every tool says it. */
const LOST =
  "After a timeout or a dropped answer, call get_credit (with the same payment) BEFORE calling again: it lists the runs and calls your credential paid for, each run with its run_id and token, so you read the one you already started instead of paying for another.";

/** The fields of a 402 an agent reads (§17.5's challenge). */
const CHALLENGE_FIELDS = ["macaroon", "invoice", "usd", "sats", "rate", "description", "expires", "remaining_usd", "reason", "carries"] as const;

/** A challenge as a tool's RESULT: what to pay, and how to call again. */
export function paymentRequiredResult(body: Record<string, unknown>, again: string): Record<string, unknown> {
  const pick: Record<string, unknown> = {};
  for (const k of CHALLENGE_FIELDS) if (body[k] !== undefined) pick[k] = body[k];
  return {
    payment_required: pick,
    next:
      `Pay the invoice (BOLT11, ${String(pick["sats"] ?? "?")} sats) with any Lightning wallet, then ${again} with payment: "<macaroon>:<preimage hex>" — the macaroon above and the payment's preimage. ` +
      `No preimage from your wallet (a person paid a QR code)? Send payment: "<macaroon>" alone and the server claims it once the invoice settles. ` +
      (pick["carries"] ? "The new credential inherits the credit left on the one you sent: use it from now on. " : "") +
      "The credential is credit on this server for a year: send it on later calls too, until a call asks for more.",
  };
}

/** A refusal as a tool's RESULT (`{ error }` is `isError` on the door). */
function refusal(a: PublicAnswer | PublicLaunchOutcome): Record<string, unknown> {
  const message = typeof a.body["error"] === "string" ? a.body["error"] : `refused (${a.status})`;
  const code = typeof a.body["code"] === "string" ? a.body["code"] : undefined;
  const retry = a.headers?.["retry-after"];
  return {
    error: code && !message.startsWith(`${code}:`) ? `${code}: ${message}` : message,
    status: a.status,
    ...(code ? { code } : {}),
    ...(retry ? { retry_after_s: Number(retry) } : {}),
    ...(a.body["credit"] !== undefined ? { credit: a.body["credit"] } : {}),
  };
}

/** JSON with every object's keys sorted: the same value, whatever order a
 *  caller wrote its fields in. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** The key a priced launch is sent under when the agent names none: the
 *  workflow and its input as the workflow's `input:` block parsed it, keys
 *  sorted — the same launch, fields in any order, is the same run while that
 *  run is in flight. The launcher applies it (`defaultKey`), only priced. */
export function defaultLaunchKey(workflow: string, parsedInput: unknown): string {
  return `auto:${createHash("sha256").update(canonicalJson([workflow, parsedInput ?? {}])).digest("hex").slice(0, 40)}`;
}

/** A url on this server for a `/public/…` path, with the run token. */
const tokened = (base: string, path: string, token: string) => `${base}${path}${path.includes("?") ? "&" : "?"}t=${encodeURIComponent(token)}`;

/** A run's view as the agent reads it: links absolute, each carrying the run
 *  token; an output too large to inline left out, its url instead. */
function agentRun(view: Record<string, unknown>, base: string, workflow: string, runId: string, token: string): Record<string, unknown> {
  const abs = (u: unknown) => (typeof u === "string" && u.startsWith("/public/") ? tokened(base, u, token) : u);
  const artifacts = Array.isArray(view["artifacts"])
    ? (view["artifacts"] as Array<Record<string, unknown>>).map((a) => ({ ...a, ...(a["url"] ? { url: abs(a["url"]) } : {}), ...(a["render"] ? { render: abs(a["render"]) } : {}) }))
    : undefined;
  const url = tokened(base, `/public/workflows/${encodeURIComponent(workflow)}/runs/${encodeURIComponent(runId)}`, token);
  const out: Record<string, unknown> = { ...view, ...(artifacts ? { artifacts } : {}), url };
  const chars = view["output"] === undefined ? 0 : (JSON.stringify(view["output"]) ?? "").length;
  if (chars > RUN_OUTPUT_INLINE_MAX) {
    delete out["output"];
    out["output_omitted"] = { chars, read_at: url, note: `The output is ${chars} characters as JSON, too large to put here: GET the url (it carries the run token) for the whole run, output included.` };
  }
  return out;
}

/** A run status that means it is still going. Anything else — success,
 *  error, cancelled, stale — has ended, charged or not. */
const IN_FLIGHT = new Set(["running", "paused", "pending", "cancelling", "pausing", "queued", "starting"]);
const stillGoing = (view: Record<string, unknown>) => {
  const status = view["status"];
  return typeof status !== "string" || IN_FLIGHT.has(status);
};

/** Settle `work`, or `undefined` once `ms` passed (the timer cleared either
 *  way, so nothing outlives the call). */
async function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((r) => {
    t = setTimeout(() => r(undefined), Math.max(0, ms));
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(t);
  }
}

/** Wait for `work` until `deadline`, yielding `beat(n)` every `everyMs`.
 *  Yields `{ value }` when it settled, `{ late: true }` when the deadline
 *  came first (the work goes on). */
async function* beatsUntil<T>(work: Promise<T>, everyMs: number, deadline: number, beat: (n: number) => unknown): AsyncGenerator<unknown, { value: T } | { late: true }> {
  const done = work.then((value) => ({ value }));
  for (let n = 1; ; n++) {
    const left = deadline - Date.now();
    if (left <= 0) return { late: true };
    const got = await within(done, Math.min(everyMs, left));
    if (got) return got;
    if (Date.now() < deadline) yield beat(n);
  }
}

/** The credential a call presents: its `payment` argument, else the
 *  connection's L402 header. With a macaroon and no preimage, the claim: a
 *  settled invoice's whole credential, else the result to answer. */
async function resolvePayment(
  o: PublicAgentOptions,
  payment: string | undefined,
): Promise<{ authorization?: string; claimed?: string } | { answer: Record<string, unknown> }> {
  const raw = payment?.trim().replace(/^(?:L402|LSAT)\s+/i, "");
  if (!raw) return o.authorization && /^\s*(?:L402|LSAT)\s/i.test(o.authorization) ? { authorization: o.authorization } : {};
  if (raw.includes(":") && raw.slice(raw.lastIndexOf(":") + 1)) return { authorization: `L402 ${raw}` };
  const macaroon = raw.replace(/:$/, "");
  const got = await o.doors.claim({ macaroon, who: o.who });
  if (got.status !== 200) return { answer: refusal(got) };
  const state = got.body["state"];
  if (state === "settled" && typeof got.body["credential"] === "string") return { authorization: `L402 ${got.body["credential"]}`, claimed: got.body["credential"] };
  if (state === "expired") return { answer: { error: "payment_expired: that invoice ended unpaid — call again with no payment for a new one", code: "payment_expired" } };
  return {
    answer: {
      payment_pending: { macaroon, ...(got.body["expires"] ? { expires: got.body["expires"] } : {}) },
      next: "The invoice has not settled yet: pay it, then call again with the same payment (or with <macaroon>:<preimage> once you have the preimage).",
    },
  };
}

const PAYING =
  "A PRICED item with no credit, or too little, answers a RESULT (not an error): { payment_required: { macaroon, invoice, usd, sats, rate, description, expires, remaining_usd?, reason?, carries? }, next } — pay the BOLT11 `invoice` with any Lightning wallet, then call again with `payment: \"<macaroon>:<preimage hex>\"` (or send it as this connection's `Authorization: L402 <macaroon>:<preimage>` header). With no preimage (a person paid the QR), `payment: \"<macaroon>\"` alone claims it once it settles. The credential is CREDIT on this server, in dollars, for a year, and works on any connection: send it on later calls; each run or call is charged base + markup × what it cost, never past its reserve, and what it does not use stays. Nothing here needs an account.";

/** The tools an agent with no account gets on `POST /public/mcp`. */
export function buildPublicAgentTools(o: PublicAgentOptions): ToolSet {
  const base = o.publicUrl.replace(/\/+$/, "");
  const every = o.progressEveryMs ?? AGENT_PROGRESS_EVERY_MS;
  const deadlineMs = o.deadlineMs ?? AGENT_DEADLINE_MS;
  const waitOf = (wait: number | undefined) => 1000 * Math.max(0, Math.min(AGENT_WAIT_MAX_S, wait ?? AGENT_RUN_WAIT_S));

  /** Read the run until it ends, `waitMs` passes or the call's deadline
   *  comes, yielding progress that carries its handle. */
  async function* follow(workflow: string, runId: string, token: string, until: number, extra: Record<string, unknown>): AsyncGenerator<unknown> {
    const handle = { workflow, run_id: runId, token };
    let n = 0;
    for (;;) {
      const left = Math.max(0, (until - Date.now()) / 1000);
      const read = await o.doors.run({ name: workflow, runId, token, wait: Math.min(left, every / 1000) });
      if (read.status !== 200) {
        yield { ...refusal(read), ...handle };
        return;
      }
      const view = agentRun(read.body, base, workflow, runId, token);
      const going = stillGoing(read.body);
      if (!going || Date.now() >= until) {
        yield {
          ...handle,
          ...extra,
          run: view,
          ...(going
            ? { next: `Still running: call get_run with { workflow: "${workflow}", run_id: "${runId}", token } (wait up to ${AGENT_WAIT_MAX_S} s a call) until its status is not running.` }
            : read.body["charge_pending"]
              ? { next: "The run ended; its charge is not recorded yet (the server tries again). Its result above stands; get_run later shows what it was charged." }
              : {}),
        };
        return;
      }
      yield { status: "running", ...handle, progress: ++n };
    }
  }

  const tools: ToolSet = {
    list_public: tool({
      description:
        "What anyone may RUN on this strut server, free or paid in sats over Lightning, with no account: each item { kind: workflow | step, name, description?, base (dollars a run), markup (times what the run cost), capUsd (the most one run may spend), reserve (the credit a run needs to start: base + markup × capUsd), results (what its launcher reads: output, or the whole run), input (a workflow's input: block — field → { type, required?, default?, description? } — or a step's input JSON Schema), recent: { days, runs, average } (what recent runs were charged, in dollars) }. " +
        "A workflow runs with run_workflow, a step with call_tool. Free items (base 0, markup 0) need no payment. " +
        PAYING,
      inputSchema: z.object({
        query: z.string().optional().describe("Words that must each appear in the name or description; omit for everything."),
      }),
      execute: async ({ query }) => {
        const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const all = await o.doors.runnable();
        const runnable = all
          .filter((r: ListedRunnable) => words.every((w) => r.name.toLowerCase().includes(w) || (r.description ?? "").toLowerCase().includes(w)))
          .map((r) => ({ ...r, call_with: r.kind === "workflow" ? "run_workflow" : "call_tool" }));
        return {
          server: base,
          runnable,
          ...(all.length === 0 ? { note: "Nothing is open to anyone to run on this server." } : {}),
        };
      },
    }),

    run_workflow: tool({
      description:
        `Start a run of a workflow anyone may run here (list_public), as its publisher published it, with your \`input\` (checked against its input: block). Waits up to \`wait\` seconds (${AGENT_RUN_WAIT_S} by default, ${AGENT_WAIT_MAX_S} at most) for the run to end and answers { workflow, run_id, token, key?, existing?, credit?, run: { status, output?, error?, artifacts?, totals?, charged?, charge_pending?, url } } — \`charged\` (dollars) once it ended and was charged; \`url\` reads the run over HTTP. Still running then: the same with \`next\`, and get_run { workflow, run_id, token } reads it again (the \`token\` is the run's receipt: it opens that run and nothing else). The first progress note (to a client that passed a progressToken) carries run_id and token as soon as the run exists. ` +
        "A PRICED launch is sent under a key — yours, else one made from the workflow and the input — so the same launch sent again while that run is still in flight returns it (`existing: true`) with nothing more set aside; once it ended, the same call starts (and pays for) a new run. A FREE launch gets a key only when you pass one. " +
        LOST +
        " " +
        PAYING,
      inputSchema: z.object({
        workflow: z.string().describe("The workflow's name, as list_public names it."),
        input: z.record(z.string(), z.unknown()).optional().describe("The run's input: the fields of its input: block."),
        key: z.string().min(1).max(200).optional().describe("1 to 200 characters: a retry under the same key while the run is in flight is that run."),
        payment: z.string().optional().describe('An L402 credential, "<macaroon>:<preimage hex>" — or the macaroon alone to claim an invoice paid without a preimage.'),
        wait: z.number().min(0).max(AGENT_WAIT_MAX_S).optional().describe(`Seconds to wait for the run to end before answering its handle (default ${AGENT_RUN_WAIT_S}).`),
      }),
      execute: async function* ({ workflow, input, key, payment, wait }) {
        const started = Date.now();
        const deadline = started + deadlineMs;
        const pay = await resolvePayment(o, payment);
        if ("answer" in pay) {
          yield pay.answer;
          return;
        }
        const claimed = pay.claimed ? { credential: pay.claimed } : {};
        const launching = o.doors.launch({
          name: workflow,
          who: o.who,
          ...(pay.authorization ? { authorization: pay.authorization } : {}),
          readBody: async () => ({ body: { input: input ?? {}, ...(key ? { key } : {}) } }),
          defaultKey: (parsed) => defaultLaunchKey(workflow, parsed),
        });
        const got = yield* beatsUntil(launching, every, deadline, (n) => ({ status: "starting", workflow, progress: n }));
        if ("late" in got) {
          yield {
            status: "starting",
            workflow,
            ...claimed,
            next: `The launch has not answered within ${Math.round(deadlineMs / 1000)} s (the server's wallet may be slow). It may still start${pay.authorization ? " and be charged: call get_credit with the same payment before calling again — a run it started is listed there with its run_id and token" : ""}.`,
          };
          return;
        }
        const out = got.value;
        const sentKey = key ?? out.key;
        const keyed = sentKey ? { key: sentKey } : {};
        if (out.status === 402) {
          yield { ...paymentRequiredResult(out.body, `call run_workflow again with the same workflow and input${key ? ` and key ("${key}")` : ""}`), ...keyed, ...claimed };
          return;
        }
        if (out.status !== 202) {
          yield { ...refusal(out), ...keyed, ...claimed };
          return;
        }
        const runId = String(out.body["runId"]);
        const token = String(out.body["token"]);
        // The handle at once: a client that loses the answer still has it.
        yield { status: "running", workflow, run_id: runId, token, url: tokened(base, `/public/workflows/${encodeURIComponent(workflow)}/runs/${encodeURIComponent(runId)}`, token) };
        yield* follow(workflow, runId, token, Math.min(deadline, Date.now() + waitOf(wait)), {
          ...keyed,
          ...(out.body["existing"] ? { existing: true } : {}),
          ...(out.body["credit"] ? { credit: out.body["credit"] } : {}),
          ...claimed,
        });
      },
    }),

    call_tool: tool({
      description:
        `Call a STEP anyone may call here (list_public, kind step) once, with your \`config\` (checked against its input schema): { output, credit? } — \`credit\` on a priced call: { charged_usd, remaining_usd, remaining_sats, expires }. The output comes back whole. A call still going after ${Math.round(AGENT_DEADLINE_MS / 1000)} s answers \`{ status: "still_running" }\`: it goes on, and its result is not kept. ` +
        "A priced call is charged once it ran, even when it failed, ran out of time or returned too much (its cost, no markup, no base) — and even when your client gave up waiting. There is no key: every call is a new call. " +
        LOST +
        " " +
        PAYING,
      inputSchema: z.object({
        type: z.string().describe("The step type, as list_public names it."),
        config: z.record(z.string(), z.unknown()).optional().describe("The step's config: the fields of its input schema."),
        payment: z.string().optional().describe('An L402 credential, "<macaroon>:<preimage hex>" — or the macaroon alone to claim an invoice paid without a preimage.'),
      }),
      execute: async function* ({ type, config, payment }) {
        const deadline = Date.now() + deadlineMs;
        const pay = await resolvePayment(o, payment);
        if ("answer" in pay) {
          yield pay.answer;
          return;
        }
        const claimed = pay.claimed ? { credential: pay.claimed } : {};
        const work = o.doors.call({
          type,
          who: o.who,
          ...(pay.authorization ? { authorization: pay.authorization } : {}),
          readBody: async () => ({ body: { config: config ?? {} } }),
        });
        const got = yield* beatsUntil(work, every, deadline, (n) => ({ status: "running", type, progress: n }));
        if ("late" in got) {
          yield {
            status: "still_running",
            type,
            ...claimed,
            next: `The call has not answered within ${Math.round(deadlineMs / 1000)} s and goes on; its output is not kept. ${pay.authorization ? "It may be charged: call get_credit with the same payment to see it (status and charge) before calling again." : "It is free: call again later if you need its output."}`,
          };
          return;
        }
        const answer = got.value;
        if (answer.status === 200) yield { ...answer.body, ...claimed };
        else if (answer.status === 402) yield { ...paymentRequiredResult(answer.body, "call call_tool again with the same type and config"), ...claimed };
        else yield { ...refusal(answer), ...claimed };
      },
    }),

    get_run: tool({
      description:
        `A run you started with run_workflow, by its RUN TOKEN: { workflow, run_id, token, run: { status, output?, error?, artifacts?, totals?, charged?, charge_pending?, url } }. Waits up to \`wait\` seconds (${AGENT_RUN_WAIT_S} by default, ${AGENT_WAIT_MAX_S} at most) while it is in flight; still running then, \`next\` says to ask again. An artifact's \`url\` and the run's \`url\` carry the token and open with no other credential. ` +
        "What you read is what the item's `results` lets its launcher read: its output and declared files, or the whole run. " +
        LOST,
      inputSchema: z.object({
        workflow: z.string(),
        run_id: z.string(),
        token: z.string().describe("The run's token, from run_workflow's answer or get_credit's runs."),
        wait: z.number().min(0).max(AGENT_WAIT_MAX_S).optional(),
      }),
      execute: async function* ({ workflow, run_id, token, wait }) {
        yield* follow(workflow, run_id, token, Date.now() + Math.min(deadlineMs, waitOf(wait)), {});
      },
    }),

    get_credit: tool({
      description:
        "A credit token's balance here, and what it paid for: { paid_usd, spent_usd, held_usd (set aside for runs in flight), remaining_usd, remaining_sats (at the rate it was bought at), expires, expired, replaced, runs: [{ kind: workflow | step, name, runId, at, status, held_usd?, charged_usd?, charge_pending?, token?, url? }] (newest first: each RUN with its run token and url — get_run reads it — each tool CALL with its status and charge), entries (the newest 50 ledger entries) }. " +
        "Read it after a timeout or a dropped answer, before calling again: a run you already started and paid for is there. " +
        'The token is `payment: "<macaroon>:<preimage>"`, else this connection\'s Authorization: L402 header. With the macaroon alone (no preimage — a person paid the invoice from a phone), it is a CLAIM: { state: pending | expired | settled, credential?, credit? } — once settled, `credential` is the whole "<macaroon>:<preimage>" to send as payment from then on.',
      inputSchema: z.object({
        payment: z.string().optional().describe('"<macaroon>:<preimage hex>", or the macaroon alone to claim it.'),
      }),
      execute: async ({ payment }) => {
        const view = async (authorization: string | undefined) => {
          const a = await o.doors.credit({ authorization });
          if (a.status !== 200) return { ok: false as const, answer: refusal(a) };
          const runs = Array.isArray(a.body["runs"])
            ? (a.body["runs"] as Array<Record<string, unknown>>).map((r) => (typeof r["url"] === "string" && typeof r["token"] === "string" ? { ...r, url: tokened(base, r["url"], r["token"]) } : r))
            : [];
          return { ok: true as const, body: { ...a.body, runs } };
        };
        const raw = payment?.trim().replace(/^(?:L402|LSAT)\s+/i, "");
        if (raw && !(raw.includes(":") && raw.slice(raw.lastIndexOf(":") + 1))) {
          const claimed = await o.doors.claim({ macaroon: raw.replace(/:$/, ""), who: o.who });
          if (claimed.status !== 200) return refusal(claimed);
          if (claimed.body["state"] !== "settled" || typeof claimed.body["credential"] !== "string") return { ...claimed.body };
          const v = await view(`L402 ${claimed.body["credential"]}`);
          return { state: "settled", credential: claimed.body["credential"], ...(v.ok ? { credit: v.body } : {}) };
        }
        const v = await view(raw ? `L402 ${raw}` : o.authorization);
        return v.ok ? v.body : v.answer;
      },
    }),
  };
  return tools;
}

/** `InitializeResult.instructions` for `POST /public/mcp`: what it is, for
 *  an agent, and the page's tool beside it. */
export function publicMcpInstructions(publicUrl: string): string {
  return (
    `This is a strut server's PUBLIC door at ${publicUrl.replace(/\/+$/, "")} — what its owner opened to anyone, with no account. ` +
    "list_public says what you may run, its price and its input; run_workflow starts a workflow (and waits for it a while), call_tool calls a step once, get_run reads a run you started by its token, get_credit reads the credit you bought and the runs and calls it paid for. " +
    LOST +
    " " +
    PAYING +
    " step_run is a public app page's own tool, for the page's host to relay; an agent uses the five above."
  );
}

// ── GET /llms.txt (llmstxt.org) ───────────────────────────────────────────

/** Dollars as an agent reads them: cents, more places under a cent. */
const usd = (n: number) => (n > 0 && n < 0.01 ? `$${n.toFixed(4).replace(/0+$/, "")}` : `$${n.toFixed(2)}`);

/** What one item costs, in a line: free, a fixed price, metered, or both;
 *  the credit a run needs to start; what recent runs were charged. */
export function priceWords(r: Pick<ListedRunnable, "base" | "markup" | "capUsd" | "reserve" | "recent" | "kind">): string {
  const unit = r.kind === "step" ? "a call" : "a run";
  const price =
    !r.base && !r.markup
      ? "free"
      : !r.markup
        ? `${usd(r.base)} ${unit}`
        : `${r.base ? `${usd(r.base)} + ` : ""}${r.markup}× what ${unit} costs${r.capUsd !== null ? `, at most ${usd(r.capUsd)} of cost` : ""}`;
  const reserve = r.reserve > 0 ? `; needs ${usd(r.reserve)} of credit to start` : "";
  const recent = r.recent.runs ? `; ${r.recent.runs} in the last ${r.recent.days} days, ${usd(r.recent.average)} charged on average` : "";
  return `${price}${reserve}${recent}`;
}

/** An `input:` block (or a step's JSON Schema) as one line of fields. */
function inputWords(r: Pick<ListedRunnable, "kind" | "input">): string {
  const input = r.input as Record<string, unknown> | null | undefined;
  if (!input || typeof input !== "object") return "";
  if (r.kind === "workflow") {
    const fields = Object.entries(input as Record<string, { type?: string; required?: boolean; default?: unknown }>).map(
      ([k, f]) => `\`${k}\` (${f?.type ?? "string"}${f?.required === false || f?.default !== undefined ? ", optional" : ""})`,
    );
    return fields.length ? `; input: ${fields.join(", ")}` : "; no input";
  }
  const props = (input["properties"] ?? {}) as Record<string, { type?: unknown }>;
  const required = new Set(Array.isArray(input["required"]) ? (input["required"] as string[]) : []);
  const fields = Object.entries(props).map(([k, f]) => `\`${k}\` (${typeof f?.type === "string" ? f.type : "any"}${required.has(k) ? "" : ", optional"})`);
  return fields.length ? `; config: ${fields.join(", ")}` : "; no config";
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** The run section of an `llms.txt`: each runnable item, its price and its
 *  input, with how to run it. Shared with the index's page when the index
 *  strut sells too. */
export function runnableSection(runnable: ListedRunnable[], base: string): string[] {
  const out: string[] = [];
  const flows = runnable.filter((r) => r.kind === "workflow");
  const steps = runnable.filter((r) => r.kind === "step");
  const enc = (s: string) => s.split("/").map(encodeURIComponent).join("/");
  out.push("## Run", "");
  if (!flows.length) out.push("No workflow is open to anyone to run here.");
  for (const r of flows) {
    out.push(`- [${r.name}](${base}/public/workflows/${encodeURIComponent(r.name)}/run): ${r.description ? `${oneLine(r.description)} — ` : ""}${priceWords(r)}${inputWords(r)}`);
  }
  out.push("", "## Tools", "");
  if (!steps.length) out.push("No step is open to anyone to call here.");
  for (const r of steps) {
    out.push(`- [${r.name}](${base}/public/steps/${enc(r.name)}/run): ${r.description ? `${oneLine(r.description)} — ` : ""}${priceWords(r)}${inputWords(r)}`);
  }
  return out;
}

/** `GET /llms.txt` on a strut whose public view has something (llmstxt.org):
 *  what anyone may run here and its price, how an agent runs it (MCP or
 *  plain HTTP), how a priced one is paid, and what else is public to read. */
export function publicLlmsTxt(
  listing: {
    runnable: ListedRunnable[];
    workflows: Array<{ name: string; description?: string }>;
    apps: Array<{ name: string; title?: string; description?: string }>;
    concepts: Array<{ name: string; description?: string }>;
  },
  opts: { publicUrl: string; mcp?: boolean },
): string {
  const base = opts.publicUrl.replace(/\/+$/, "");
  const host = (() => {
    try {
      return new URL(base).host;
    } catch {
      return base;
    }
  })();
  const out: string[] = [
    `# strut server at ${host}`,
    "",
    "> A strut server — the workflow engine — whose owner opened some of what it holds to anyone, with no account: workflows and tools anyone may RUN, free or paid in sats over Lightning (L402), and what anyone may READ. Every price is in dollars; a buyer is quoted sats at the rate of the moment.",
    "",
    ...(opts.mcp !== false
      ? [`For an agent: this server is an MCP server — \`claude mcp add --transport http ${host} ${base}/public/mcp\` gives you list_public, run_workflow, call_tool, get_run and get_credit, with no credential. The same doors are plain HTTP, below.`, ""]
      : ["For an agent: every door below is plain HTTP, with no credential.", ""]),
    ...runnableSection(listing.runnable, base),
    "",
    "## Paying",
    "",
    `- A priced launch or call with no credit answers \`402 Payment Required\` with \`WWW-Authenticate: L402 macaroon="…", invoice="…"\` and the same in its JSON body (usd, sats, rate, expires). Pay the BOLT11 invoice with any Lightning wallet and send the request again with \`Authorization: L402 <macaroon>:<preimage hex>\`. The credential is credit here, in dollars, for a year; each run is charged base + markup × what it cost, never past the credit it set aside, and the rest stays.`,
    `- [Your credit](${base}/public/credit): GET with the credential — paid, spent, set aside, remaining, and the runs and calls it paid for (each run with its run token): read it after a lost answer before paying again`,
    `- [Claim](${base}/public/credit/claim): POST \`{ macaroon }\` — for a wallet that gives no preimage; answers the credential once the invoice settles`,
    `- A launch: POST \`{ input, key? }\` → \`202 { runId, token }\`; read it at ${base}/public/workflows/{name}/runs/{runId}?t={token}&wait=55 (the token opens that run and nothing else). The same \`key\` while the run is in flight returns it.`,
    `- A call: POST \`{ config }\` → \`200 { output, credit? }\`.`,
    "",
    "## Read",
    "",
    `- [Everything public](${base}/public): the JSON listing — workflows, steps, Concept roots, apps, and what anyone may run`,
  ];
  for (const w of listing.workflows) out.push(`- [${w.name}](${base}/public/workflows/${encodeURIComponent(w.name)}/flow): ${w.description ? oneLine(w.description) : "a workflow"} (its definition)`);
  for (const a of listing.apps) out.push(`- [${a.title ?? a.name}](${base}/?app=${encodeURIComponent(a.name)}&solo=1&public=1): ${a.description ? oneLine(a.description) : "an app"} (a page, for a person)`);
  for (const c of listing.concepts) out.push(`- [${c.name}](${base}/public/concepts/${encodeURIComponent(c.name)}): ${c.description ? oneLine(c.description) : "a Concept page"}`);
  out.push("", "## Optional", "", `- [strut](https://github.com/stakwork/strut): the workflow engine this server runs`);
  return out.join("\n") + "\n";
}
