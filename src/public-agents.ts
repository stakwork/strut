/**
 * AN AGENT AS A BUYER (plans/paid-runs.md §10 "An agent over MCP", work item
 * 8): the tools `POST /public/mcp` serves beside a visitor's page's
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
 *   get_credit    a credit token's balance; with the macaroon alone, its
 *                 claim (§4.4)
 *
 * A priced item with no credit answers a RESULT, never an error: `{
 * payment_required: { macaroon, invoice, usd, sats, rate, description,
 * expires, remaining_usd?, reason?, carries? } }`. The agent pays the
 * invoice with whatever wallet it has and calls again with `payment:
 * "<macaroon>:<preimage>"` — or the connection's own `Authorization: L402
 * …` header, which every tool reads when the call names no `payment`.
 * Nothing is kept between requests: the door is stateless, so the credential
 * an agent holds works on any connection, and `payment: "<macaroon>"` with no
 * preimage claims an invoice a person paid from a phone.
 *
 * What keeps an agent from losing a run or paying twice:
 * - **A key on every launch.** `run_workflow` sends the agent's `key`, else
 *   one made from the workflow and the input, so a retry of the same launch
 *   — after paying, or after a lost answer — returns the run in flight and
 *   sets nothing more aside. A key matches only a run still in flight; a
 *   distinct `key` starts another.
 * - **No call held past a client's patience.** `run_workflow` waits `wait`
 *   seconds (25 by default, 55 at most) for the run, sending progress while
 *   it waits, then answers the run's handle — `run_id` and `token` — for
 *   `get_run`, which waits again. `call_tool` sends progress while the call
 *   runs (it answers within 60 s).
 * - **A failed or timed-out call is charged its cost**: `call_tool` has no
 *   key, so its description says not to send a charged call again blindly.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { tool, type ToolSet } from "ai";
import { capToolResults } from "./ai/tools.js";
import type { PublicAnswer, PublicDoors, PublicLaunchOutcome } from "./public-routes.js";
import type { ListedRunnable } from "./public-runnable.js";
import { PUBLIC_RUN_WAIT_MAX_S } from "./public-runs.js";

/** How long `run_workflow` waits for its run by default, in seconds. */
export const AGENT_RUN_WAIT_S = 25;
/** Progress this often while a tool holds the call, so a client whose
 *  request times out unless progress resets it (60 s, the MCP SDK's
 *  default) keeps waiting. */
export const AGENT_PROGRESS_EVERY_MS = 10_000;

export interface PublicAgentOptions {
  doors: PublicDoors;
  /** The caller's address (`visitorAddress`). */
  who: string;
  /** The connection's `Authorization`, when it sent an L402 credential. */
  authorization?: string | undefined;
  /** This server's base URL: every link the tools hand out is absolute. */
  publicUrl: string;
  /** Progress cadence (tests). */
  progressEveryMs?: number;
}

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

/** The key a launch is sent under when the agent names none: the workflow
 *  and its input, so the same launch sent again — after paying, after a
 *  lost answer — is the same run while that run is in flight. */
export function defaultLaunchKey(workflow: string, input: unknown): string {
  return `auto:${createHash("sha256").update(JSON.stringify([workflow, input ?? {}])).digest("hex").slice(0, 40)}`;
}

/** A run's links made absolute, each file carrying the run token (`?t=`):
 *  the agent fetches them with no other credential. */
function absoluteRun(view: Record<string, unknown>, base: string, token: string): Record<string, unknown> {
  const abs = (u: unknown) => (typeof u === "string" && u.startsWith("/public/") ? `${base}${u}?t=${encodeURIComponent(token)}` : u);
  const artifacts = Array.isArray(view["artifacts"])
    ? (view["artifacts"] as Array<Record<string, unknown>>).map((a) => ({ ...a, ...(a["url"] ? { url: abs(a["url"]) } : {}), ...(a["render"] ? { render: abs(a["render"]) } : {}) }))
    : undefined;
  return { ...view, ...(artifacts ? { artifacts } : {}) };
}

const IN_FLIGHT = new Set(["running", "paused", "pending", "cancelling", "pausing", "queued"]);
/** The view says the run is still going: no `charged` yet (written once it
 *  ended and was charged), or a status of a run in flight. */
const stillGoing = (view: Record<string, unknown>) => view["charged"] === undefined || IN_FLIGHT.has(String(view["status"] ?? ""));

/** Wait for `work`, yielding `beat(n)` every `everyMs` until it settles;
 *  the last yield is its value. The timer is cleared each round, so nothing
 *  outlives the call. */
async function* withBeats<T>(work: Promise<T>, everyMs: number, beat: (n: number) => unknown): AsyncGenerator<unknown> {
  const done = work.then((v) => ({ v }));
  for (let n = 1; ; n++) {
    let t: ReturnType<typeof setTimeout> | undefined;
    const tick = new Promise<"tick">((r) => {
      t = setTimeout(() => r("tick"), everyMs);
    });
    let got: { v: T } | "tick";
    try {
      got = await Promise.race([done, tick]);
    } finally {
      clearTimeout(t);
    }
    if (got !== "tick") {
      yield got.v;
      return;
    }
    yield beat(n);
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
  "A PRICED item with no credit, or too little, answers a RESULT (not an error): { payment_required: { macaroon, invoice, usd, sats, rate, description, expires, remaining_usd?, reason?, carries? }, next } — pay the BOLT11 `invoice` with any Lightning wallet, then call again with `payment: \"<macaroon>:<preimage hex>\"` (or send it as this connection's `Authorization: L402 <macaroon>:<preimage>` header). With no preimage (a person paid the QR), `payment: \"<macaroon>\"` alone claims it once it settles. The credential is CREDIT on this server, in dollars, for a year: send it on later calls; each run or call is charged base + markup × what it cost, never past its reserve, and what it does not use stays. Nothing here needs an account.";

/** The tools an agent with no account gets on `POST /public/mcp`. */
export function buildPublicAgentTools(o: PublicAgentOptions): ToolSet {
  const base = o.publicUrl.replace(/\/+$/, "");
  const every = o.progressEveryMs ?? AGENT_PROGRESS_EVERY_MS;

  /** Read the run until it ends or `waitS` passes, yielding progress. */
  async function* follow(workflow: string, runId: string, token: string, waitS: number, extra: Record<string, unknown>): AsyncGenerator<unknown> {
    const deadline = Date.now() + 1000 * Math.max(0, Math.min(PUBLIC_RUN_WAIT_MAX_S, waitS));
    let n = 0;
    for (;;) {
      const left = Math.max(0, (deadline - Date.now()) / 1000);
      const read = await o.doors.run({ name: workflow, runId, token, wait: Math.min(left, every / 1000) });
      if (read.status !== 200) {
        yield { ...refusal(read), workflow, run_id: runId };
        return;
      }
      const view = absoluteRun(read.body, base, token);
      const going = stillGoing(read.body);
      if (!going || Date.now() >= deadline) {
        yield {
          workflow,
          run_id: runId,
          token,
          ...extra,
          run: view,
          ...(going
            ? { next: `Still running: call get_run with { workflow: "${workflow}", run_id: "${runId}", token } (wait up to ${PUBLIC_RUN_WAIT_MAX_S} s a call) until its status is not running.` }
            : {}),
        };
        return;
      }
      yield { status: "running", workflow, run_id: runId, progress: ++n };
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
        "Start a run of a workflow anyone may run here (list_public), as its publisher published it, with your `input` (checked against its input: block). Waits up to `wait` seconds (25 by default, 55 at most) for the run to end and answers { workflow, run_id, token, key, existing?, credit?, run: { status, output?, error?, artifacts?, totals?, charged? } } — `charged` (dollars) once it ended and was charged. Still running then: the same with `next`, and get_run { workflow, run_id, token } reads it again (the `token` is the run's receipt: it opens that run and nothing else). " +
        "`key` makes a retry safe: the same key while that run is still in flight returns it (`existing: true`) and sets nothing more aside. With no key, one made from the workflow and the input is sent, so the SAME launch sent again — after paying, or after a lost answer — is the same run while it is in flight; pass a distinct `key` to start another run of the same input at once. " +
        PAYING,
      inputSchema: z.object({
        workflow: z.string().describe("The workflow's name, as list_public names it."),
        input: z.record(z.string(), z.unknown()).optional().describe("The run's input: the fields of its input: block."),
        key: z.string().min(1).max(200).optional().describe("1 to 200 characters that make a retry the same run while it is in flight."),
        payment: z.string().optional().describe('An L402 credential, "<macaroon>:<preimage hex>" — or the macaroon alone to claim an invoice paid without a preimage.'),
        wait: z.number().min(0).max(PUBLIC_RUN_WAIT_MAX_S).optional().describe(`Seconds to wait for the run to end before answering its handle (default ${AGENT_RUN_WAIT_S}).`),
      }),
      execute: async function* ({ workflow, input, key, payment, wait }) {
        const pay = await resolvePayment(o, payment);
        if ("answer" in pay) {
          yield pay.answer;
          return;
        }
        const sent = key ?? defaultLaunchKey(workflow, input);
        const out = await o.doors.launch({
          name: workflow,
          who: o.who,
          ...(pay.authorization ? { authorization: pay.authorization } : {}),
          readBody: async () => ({ body: { input: input ?? {}, key: sent } }),
        });
        const claimed = pay.claimed ? { credential: pay.claimed } : {};
        if (out.status === 402) {
          yield { ...paymentRequiredResult(out.body, `call run_workflow again with the same workflow, input and key ("${sent}")`), key: sent, ...claimed };
          return;
        }
        if (out.status !== 202) {
          yield { ...refusal(out), key: sent, ...claimed };
          return;
        }
        const runId = String(out.body["runId"]);
        const token = String(out.body["token"]);
        yield* follow(workflow, runId, token, wait ?? AGENT_RUN_WAIT_S, {
          key: sent,
          ...(out.body["existing"] ? { existing: true } : {}),
          ...(out.body["credit"] ? { credit: out.body["credit"] } : {}),
          ...claimed,
        });
      },
    }),

    call_tool: tool({
      description:
        "Call a STEP anyone may call here (list_public, kind step) once, with your `config` (checked against its input schema); it answers within 60 s: { output, credit? } — `credit` on a priced call: { charged_usd, remaining_usd, remaining_sats, expires }. " +
        "A priced call that failed, ran out of time or returned too much is still charged its cost (no markup, no base): look at the error before sending it again. There is no key: every call is a call. " +
        PAYING,
      inputSchema: z.object({
        type: z.string().describe("The step type, as list_public names it."),
        config: z.record(z.string(), z.unknown()).optional().describe("The step's config: the fields of its input schema."),
        payment: z.string().optional().describe('An L402 credential, "<macaroon>:<preimage hex>" — or the macaroon alone to claim an invoice paid without a preimage.'),
      }),
      execute: async function* ({ type, config, payment }) {
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
        for await (const y of withBeats(work, every, (n) => ({ status: "running", type, progress: n }))) {
          const a = y as PublicAnswer | { status: "running" };
          if (a.status === "running") {
            yield a;
            continue;
          }
          const answer = a as PublicAnswer;
          if (answer.status === 200) yield { ...answer.body, ...claimed };
          else if (answer.status === 402) yield { ...paymentRequiredResult(answer.body, `call call_tool again with the same type and config`), ...claimed };
          else yield { ...refusal(answer), ...claimed };
        }
      },
    }),

    get_run: tool({
      description:
        `A run you started with run_workflow, by its RUN TOKEN: { workflow, run_id, token, run: { status, output?, error?, artifacts?, totals?, charged? } }. Waits up to \`wait\` seconds (25 by default, ${PUBLIC_RUN_WAIT_MAX_S} at most) while it is in flight; still running then, \`next\` says to ask again. An artifact's \`url\` carries the token and opens with no other credential. ` +
        "What you read is what the item's `results` lets its launcher read: its output and declared files, or the whole run.",
      inputSchema: z.object({
        workflow: z.string(),
        run_id: z.string(),
        token: z.string().describe("The run's token, from run_workflow's answer."),
        wait: z.number().min(0).max(PUBLIC_RUN_WAIT_MAX_S).optional(),
      }),
      execute: async function* ({ workflow, run_id, token, wait }) {
        yield* follow(workflow, run_id, token, wait ?? AGENT_RUN_WAIT_S, {});
      },
    }),

    get_credit: tool({
      description:
        "A credit token's balance here: { paid_usd, spent_usd, held_usd (set aside for runs in flight), remaining_usd, remaining_sats (at the rate it was bought at), expires, expired, replaced, entries (the newest 50: payment, hold, charge, carry, expiry) }. " +
        'The token is `payment: "<macaroon>:<preimage>"`, else this connection\'s Authorization: L402 header. With the macaroon alone (no preimage — a person paid the invoice from a phone), it is a CLAIM: { state: pending | expired | settled, credential? } — once settled, `credential` is the whole "<macaroon>:<preimage>" to send as payment from then on.',
      inputSchema: z.object({
        payment: z.string().optional().describe('"<macaroon>:<preimage hex>", or the macaroon alone to claim it.'),
      }),
      execute: async ({ payment }) => {
        const raw = payment?.trim().replace(/^(?:L402|LSAT)\s+/i, "");
        if (raw && !(raw.includes(":") && raw.slice(raw.lastIndexOf(":") + 1))) {
          const claimed = await o.doors.claim({ macaroon: raw.replace(/:$/, ""), who: o.who });
          if (claimed.status !== 200) return refusal(claimed);
          if (claimed.body["state"] !== "settled" || typeof claimed.body["credential"] !== "string") return { ...claimed.body };
          const view = await o.doors.credit({ authorization: `L402 ${claimed.body["credential"]}` });
          return { state: "settled", credential: claimed.body["credential"], ...(view.status === 200 ? { credit: view.body } : {}) };
        }
        const authorization = raw ? `L402 ${raw}` : o.authorization;
        const view = await o.doors.credit({ authorization });
        return view.status === 200 ? view.body : refusal(view);
      },
    }),
  };
  return capToolResults(tools);
}

/** `InitializeResult.instructions` for `POST /public/mcp`: what it is, for
 *  an agent, and the page's tool beside it. */
export function publicMcpInstructions(publicUrl: string): string {
  return (
    `This is a strut server's PUBLIC door at ${publicUrl.replace(/\/+$/, "")} — what its owner opened to anyone, with no account. ` +
    "list_public says what you may run, its price and its input; run_workflow starts a workflow (and waits for it a while), call_tool calls a step once, get_run reads a run you started by its token, get_credit reads the credit you bought. " +
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
  opts: { publicUrl: string },
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
    `For an agent: this server is an MCP server — \`claude mcp add --transport http ${host} ${base}/public/mcp\` gives you list_public, run_workflow, call_tool, get_run and get_credit, with no credential. The same doors are plain HTTP, below.`,
    "",
    ...runnableSection(listing.runnable, base),
    "",
    "## Paying",
    "",
    `- A priced launch or call with no credit answers \`402 Payment Required\` with \`WWW-Authenticate: L402 macaroon="…", invoice="…"\` and the same in its JSON body (usd, sats, rate, expires). Pay the BOLT11 invoice with any Lightning wallet and send the request again with \`Authorization: L402 <macaroon>:<preimage hex>\`. The credential is credit here, in dollars, for a year; each run is charged base + markup × what it cost, never past the credit it set aside, and the rest stays.`,
    `- [Your credit](${base}/public/credit): GET with the credential — paid, spent, set aside, remaining`,
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
