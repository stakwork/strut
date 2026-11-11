/**
 * PUBLIC TOOLS (plans/paid-runs.md work item 6; §3's table, §6 "A tool",
 * decision 15): one registry step anyone may call, free or for credit, with
 * `POST /public/steps/:type/run { config }` → `200 { output, credit? }`.
 * The route is src/public-routes.ts's; this is everything after the body,
 * one function an MCP door (item 8's `call_tool`) calls the same way:
 * `call({ type, config, presented, address })` answers the status and the
 * JSON to send — the output and the token's credit, a refusal, or a 402
 * with its challenge.
 *
 * A call, in order, each step answering before the next costs anything:
 * - the drain (503), the item (404: not in `runnable` as a step), and item
 *   2's save checks asked AGAIN (`stepRunnableProblem`: the registry changes
 *   after a save — a step since sealed, or gone, is 404);
 * - the config: an object parsed by the step's own input schema (400 naming
 *   the field), naming no secret (`secretNamesIn`, 400);
 * - a priced item's credit token (§4.3 steps 1 to 3): 401 a bad one, 403 one
 *   its holder narrowed away from this step or below its reserve;
 * - the caps: the address's share of calls in flight, the server's limit,
 *   and the item's `dailyCapUsd` when it sets one, by a run's rule (§7,
 *   src/public-runs.ts `dailyRoom`): today's cost plus each call in flight
 *   at its cap; a call fits while what is left holds its whole cap
 *   (`perRunCapUsd`: its `capUsd`, else a tenth of the daily cap), never a
 *   sliver, and the day's last call goes alone — 429;
 * - the price: no token, or one short of the reserve, is a 402 (§4, carry-
 *   over as a launch's); a token's first use asks the wallet (503 when it
 *   cannot); the reserve is set aside under the call's id (`ledger.hold`);
 * - the call: `runSingleStep` — never `runStep`, which keeps a run with
 *   claims — against the ALLOWLIST bag (`publicToolServices`), with no actor,
 *   the host's public principal, the item's cap, and a time limit
 *   (`PUBLIC_TOOL_CALL_TIMEOUT_MS`, then force-cancelled: 504). The config
 *   is the run's INPUT and the step's config is `{ k: "{{ input.k }}" }` per
 *   key: a sole expression's value is taken as it is, so a stranger's
 *   `{{` inside a value is text, never evaluated. Inside `asPublicCall`, so
 *   a lib step's failure answered as text (`stepFailed`) throws. Nothing
 *   reaches the run store: the ledger entry is the call's record;
 * - the charge, by the rule (`chargeFor`): base + markup × what the call
 *   reported it cost (`withUsage`; none, its base); a throw, a time-out, or
 *   a result over 5 MB, its cost and no base; never more than the reserve
 *   (the ledger's rule for every charge) or what the token holds. A free
 *   call is a charge of nothing, which `daily` counts with its cost. A
 *   charge the ledger refuses is tried again, then again every
 *   `CHARGE_RETRY_MS` for an hour.
 *
 * **A crash between the hold and the charge** leaves the hold open with no
 * record of what ran: the call never answered, so its buyer is charged
 * nothing. `reconcile` (boot, beside item 5's) frees every open `step:` hold
 * whose call is neither in flight nor waiting on a charge in this process —
 * a charge of nothing.
 *
 * **Free calls** need no token. Beyond the per-address budget (the route's)
 * they are held by the address's share of the calls in flight, the server's
 * limit, and the item's daily cap when it sets one; no daily cap is
 * required of a free step at the save, since a runnable step cannot be one
 * that spends (`agent`, `llm`, `acp/prompt`, `graph/walk`).
 */
import type { StepRegistry } from "./core.js";
import type { LedgerStore, Micros, Price, ChargeInput } from "./payments/ledger.js";
import { FREE, LedgerError, microsToUsd, priceOf, usdToMicros } from "./payments/ledger.js";
import type { PublicRunnable, PublicSurfaceService } from "./public-surface.js";
import { isPriced, perRunCapUsd, runnableReserve, runnableSubject, stepRunnableProblem } from "./public-runnable.js";
import { tokenRefusal, type Presented, type VerifiedToken } from "./l402.js";
import type { Challenge, Credit, CreditRefusal } from "./public-credit.js";
import { runSingleStep } from "./run-step.js";
import { RunController } from "./run-control.js";
import { countUsage, generateRunId } from "./store.js";
import { dailyRoom, secondsToUtcMidnight } from "./public-runs.js";
import { STEP_RUN_RESULT_MAX_CHARS } from "./apps/tools.js";
import { secretNamesIn } from "./reach.js";
import { asPublicCall } from "./public-call.js";
import { httpCapability, type FetchLike, type HttpCapability } from "./capabilities.js";
import { assertRawQuery, carryScope } from "./graph/scope.js";
import type { GraphBackend } from "./graph/backend.js";
import type { Params, Row } from "./graph/engine.js";

/** Public tool calls in flight on this server at once, by default. */
export const PUBLIC_TOOL_CALLS_MAX_IN_FLIGHT = 20;
/** Of those, one visitor address's share. */
export const PUBLIC_TOOL_CALLS_PER_ADDRESS = 5;
/** How long a call may run before it is force-cancelled (504). */
export const PUBLIC_TOOL_CALL_TIMEOUT_MS = 60_000;
/** One HTTP request a public call makes, at most. */
export const PUBLIC_TOOL_HTTP_TIMEOUT_MS = 30_000;
/** The most a call's result may be, as JSON: the app door's cap. */
export const PUBLIC_TOOL_RESULT_MAX_CHARS = STEP_RUN_RESULT_MAX_CHARS;
/** A charge the ledger refused is tried again this often, for an hour. */
export const CHARGE_RETRY_MS = 30_000;
const CHARGE_RETRY_FOR_MS = 60 * 60 * 1000;
/** The most of a failed call's error its caller reads. */
const ERROR_MAX_CHARS = 2000;

/** What a priced call's caller reads of its token afterwards. */
export interface ToolCredit {
  /** What this call was charged, in dollars. */
  charged_usd: number;
  remaining_usd: number;
  remaining_sats: number;
  expires: string;
}

/** A call's answer: the status and the JSON to send, with its headers. */
export type ToolAnswer =
  | { status: 200; body: { output: unknown; credit?: ToolCredit }; headers?: undefined }
  | { status: 402; body: Challenge["body"]; headers: Record<string, string> }
  | {
      status: 400 | 401 | 403 | 404 | 429 | 500 | 503 | 504;
      body: { error: string; code?: string; credit?: ToolCredit };
      headers?: Record<string, string>;
    };

export interface ToolCall {
  /** The step type the caller names. */
  type: string;
  /** The step's config: an object; absent is `{}`. */
  config?: unknown;
  /** The credit token as presented (`Authorization: L402 <macaroon>:<preimage>`). */
  presented?: Presented;
  /** Who is asking: the address's share of calls in flight, its invoices. */
  address: string;
}

export interface PublicToolsOptions {
  ledger: () => Promise<LedgerStore>;
  surface: Pick<PublicSurfaceService, "runnable">;
  /** The live registry (it changes at every rebuild). */
  registry: () => StepRegistry;
  /** The services bag a call runs against: `publicToolServices`. */
  services: () => unknown;
  /** Credit (src/public-credit.ts). Absent: nothing priced is called here. */
  credit?: Credit;
  /** Why nothing new starts now (the drain, src/drain.ts), else undefined. */
  draining?: () => string | undefined;
  /** The one principal a host bills every public run and call to (§6). */
  principal?: string;
  sealedPatterns?: readonly string[];
  maxInFlight?: number;
  perAddress?: number;
  timeoutMs?: number;
  /** A refused charge's next try (tests). */
  chargeRetryMs?: number;
  now?: () => number;
}

export interface PublicTools {
  call(c: ToolCall): Promise<ToolAnswer>;
  /** Why nothing new starts now (the drain), else undefined: a door asks it
   *  before reading a body; `call` asks it again. */
  draining(): string | undefined;
  /** Tool calls in flight in this process: what the drain waits on. */
  inFlight(): number;
  /** Boot: free every open `step:` hold whose call is neither in flight here
   *  nor waiting on a charge — a crash cut it off between its hold and its
   *  charge. Never throws. */
  reconcile(): Promise<Array<{ subject: string; callId: string; action: "freed" | "failed" }>>;
  /** Stop retrying refused charges (`strut.close()`). */
  close(): void;
}

const usd = (micros: Micros) => `$${microsToUsd(micros).toFixed(2)}`;

/** A refusal as an answer. A 401 names the scheme. */
function refused(r: Pick<CreditRefusal, "status" | "code" | "error" | "retryAfter">): ToolAnswer {
  const headers: Record<string, string> = {};
  if (r.retryAfter !== undefined) headers["retry-after"] = String(r.retryAfter);
  if (r.status === 401) headers["www-authenticate"] = `L402 error="${r.code}"`;
  return { status: r.status, body: { error: r.error, code: r.code }, headers };
}

/**
 * The step's config for a public call: each top-level key of the caller's
 * config read from the run's input as a sole expression,
 * `{ k: '{{ input["k"] }}' }`. The runner returns a sole expression's value
 * as it is (expr.ts `resolveTemplate`), evaluating nothing inside it, so a
 * stranger's text holding `{{` is passed to the step as text.
 */
export function inputTemplates(config: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(config)) out[k] = `{{ input[${JSON.stringify(k)}] }}`;
  return out;
}

export function createPublicTools(o: PublicToolsOptions): PublicTools {
  const now = o.now ?? Date.now;
  const max = o.maxInFlight ?? PUBLIC_TOOL_CALLS_MAX_IN_FLIGHT;
  const perAddress = o.perAddress ?? PUBLIC_TOOL_CALLS_PER_ADDRESS;
  const timeoutMs = o.timeoutMs ?? PUBLIC_TOOL_CALL_TIMEOUT_MS;
  const retryMs = o.chargeRetryMs ?? CHARGE_RETRY_MS;
  /** callId → its subject, who asked, and what the daily cap counts it at. */
  const flights = new Map<string, { subject: string; address: string; cap?: Micros }>();
  /** callId → a charge the ledger refused, tried again on a timer. */
  const pendingCharges = new Map<string, { input: ChargeInput; until: number; timer: ReturnType<typeof setTimeout> }>();

  // Admission is one step at a time: the daily cap's check and counting the
  // call are one step, so twenty calls in one second stay inside the cap.
  let serial: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = serial.then(fn, fn);
    serial = p.catch(() => undefined);
    return p;
  };

  type Admitted = { ok: true; callId: string; capUsd?: number } | { ok: false; answer: ToolAnswer };
  const admit = (item: PublicRunnable, address: string): Promise<Admitted> =>
    oneAtATime(async (): Promise<Admitted> => {
      const subject = runnableSubject(item);
      let mine = 0;
      for (const f of flights.values()) if (f.address === address) mine++;
      if (mine >= perAddress) {
        return { ok: false, answer: { status: 429, body: { error: `too many public tool calls in flight from this address (${perAddress}) — try again when one answers` }, headers: { "retry-after": "5" } } };
      }
      if (flights.size >= max) {
        return { ok: false, answer: { status: 429, body: { error: `too many public tool calls in flight on this server (${max}) — try again shortly` }, headers: { "retry-after": "5" } } };
      }
      // The call's cap, as a run's (§7): its `capUsd`, else a share of the
      // daily cap (`perRunCapUsd`), so a free step with a daily cap and no
      // per-call cap admits several calls at once, never one.
      const caps: Micros[] = [];
      const own = perRunCapUsd(item);
      if (own !== undefined) caps.push(usdToMicros(own));
      if (item.dailyCapUsd !== undefined) {
        const daily = usdToMicros(item.dailyCapUsd);
        let today: Micros;
        try {
          today = (await (await o.ledger()).today(subject, { now: now() })).cost;
        } catch (err) {
          console.error(`[public-tools] reading today's spend of ${subject} failed:`, err);
          return { ok: false, answer: { status: 503, body: { error: "the ledger cannot be read just now — try again shortly" }, headers: { "retry-after": "30" } } };
        }
        // A call in flight counts at its cap; the rule for whether one more
        // fits is a run's (`dailyRoom`): a whole cap, never a sliver, and the
        // last of the day to one call alone.
        let held = 0;
        let inFlight = 0;
        for (const f of flights.values()) {
          if (f.subject !== subject) continue;
          held += f.cap ?? daily;
          inFlight++;
        }
        const room = dailyRoom({ daily, today, held, inFlight, full: caps.length ? Math.min(...caps) : daily });
        if (!room.ok) {
          return {
            ok: false,
            answer: {
              status: 429,
              body: {
                error: room.spent
                  ? `step "${item.name}" has spent its daily cap (${usd(daily)}) — try again tomorrow (UTC)`
                  : `step "${item.name}" has its daily cap (${usd(daily)}) set aside for calls in flight — try again when one ends`,
              },
              headers: { "retry-after": String(room.spent ? secondsToUtcMidnight(now()) : 5) },
            },
          };
        }
        caps.push(room.cap);
      }
      const cap = caps.length ? Math.max(1, Math.min(...caps)) : undefined;
      const callId = generateRunId();
      flights.set(callId, { subject, address, ...(cap !== undefined ? { cap } : {}) });
      return { ok: true, callId, ...(cap !== undefined ? { capUsd: microsToUsd(cap) } : {}) };
    });

  /** Charge a call: tried twice now; refused again, on a timer for an hour,
   *  its hold kept out of the boot reconcile meanwhile. What was charged,
   *  or undefined when it is still waiting. */
  const charge = async (input: ChargeInput): Promise<Micros | undefined> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return (await (await o.ledger()).charge(input)).charged;
      } catch (err) {
        if (attempt === 1) {
          console.error(`[public-tools] charging ${input.subject} call ${input.runId} failed — trying again every ${retryMs / 1000} s:`, err);
          later(input, now() + CHARGE_RETRY_FOR_MS);
        }
      }
    }
    return undefined;
  };
  const later = (input: ChargeInput, until: number) => {
    const timer = setTimeout(async () => {
      try {
        await (await o.ledger()).charge(input);
        pendingCharges.delete(input.runId);
      } catch (err) {
        if (now() >= until) {
          pendingCharges.delete(input.runId);
          console.error(`[public-tools] gave up charging ${input.subject} call ${input.runId} (the next boot frees its hold):`, err);
        } else later(input, until);
      }
    }, retryMs);
    timer.unref?.();
    pendingCharges.set(input.runId, { input, until, timer });
  };

  /** What the token holds after this call, as the caller reads it. */
  const creditOf = async (token: VerifiedToken, charged: Micros): Promise<ToolCredit | undefined> => {
    const view = await o.credit?.view(token.tokenId, { entries: false }).catch(() => undefined);
    return view ? { charged_usd: microsToUsd(charged), remaining_usd: view.remaining_usd, remaining_sats: view.remaining_sats, expires: view.expires } : undefined;
  };

  const call: PublicTools["call"] = async (c) => {
    const draining = o.draining?.();
    if (draining) return { status: 503, body: { error: draining }, headers: { "retry-after": "60" } };
    const type = c.type;
    const notOpen: ToolAnswer = { status: 404, body: { error: `step "${type}" is not open to anyone to call on this strut server` } };
    const item = await o.surface.runnable("step", type);
    if (!item) return notOpen;
    // Item 2's save checks, again: sealed, spends or a shell, a container,
    // a config that names a secret, gone.
    const registry = o.registry();
    const problem = stepRunnableProblem(type, registry, o.sealedPatterns);
    if (problem) {
      console.warn(`[public-tools] ${type} is in the public view and refused: ${problem}`);
      return notOpen;
    }
    const def = registry[type]!;

    // The config: an object of data, as the step's own schema reads it,
    // naming no secret.
    const config = c.config ?? {};
    if (!config || typeof config !== "object" || Array.isArray(config)) return { status: 400, body: { error: "config is a JSON object: the step's config" } };
    const parsed = def.input.safeParse(config);
    if (!parsed.success) return { status: 400, body: { error: `config: ${parsed.error.issues.map((i) => `${["config", ...i.path].join(".")}: ${i.message}`).join("; ")}` } };
    if (secretNamesIn(config).length) return { status: 400, body: { error: "config names a secret: a public call never chooses which secret a step reads" } };

    // A priced item's credit token (§4.3 steps 1 to 3), before the caps:
    // what it may be used for is known without the wallet.
    const priced = isPriced(item);
    const reserve = priced ? runnableReserve(item) : 0;
    const price: Price = priced ? priceOf(item) : FREE;
    const credit = o.credit;
    let presented: VerifiedToken | undefined;
    let expired = false;
    if (priced) {
      if (!credit) return { status: 503, body: { error: `step "${type}" is priced, and this strut server sells no credit` }, headers: { "retry-after": "60" } };
      if (c.presented) {
        const v = await credit.verify(c.presented);
        if (!v.ok) return refused(v);
        presented = v.token;
        const why = tokenRefusal(presented, { now: now(), item, reserve });
        if (why === "not_this_item") return { status: 403, body: { error: `token_not_for_this: the token's holder limited it to other items than step "${type}"`, code: "token_not_for_this" } };
        if (why === "over_max_charge") {
          return { status: 403, body: { error: `token_over_max_charge: a call of "${type}" needs $${microsToUsd(reserve)} set aside, above what the token's holder allowed one call`, code: "token_over_max_charge" } };
        }
        expired = why === "expired";
      }
    }

    const admitted = await admit(item, c.address);
    if (!admitted.ok) return admitted.answer;
    const { callId } = admitted;
    const subject = runnableSubject(item);
    try {
      // The price (§4, §5): no token, or one that cannot cover the reserve,
      // is a 402 — for the shortfall when the presented token's credit
      // carries to the new one (§4.5), the whole reserve otherwise.
      if (priced) {
        const pay = async (amount: Micros, x: { carry?: string; remaining?: Micros; reason?: string } = {}): Promise<ToolAnswer> => {
          const ch = await credit!.challenge({ usd: amount, description: `${type}: credit for one call`, address: c.address, ...x });
          if (!ch.ok) return refused(ch);
          return { status: 402, body: ch.body, headers: { "www-authenticate": ch.header } };
        };
        if (!presented) return await pay(reserve);
        if (expired) return await pay(reserve, { reason: "expired" });
        const used = await credit!.use(presented);
        if (!used.ok) return refused(used);
        let held;
        try {
          held = await (await o.ledger()).hold({ token: presented.tokenId, reserve, subject, runId: callId, at: now() });
        } catch (err) {
          console.error(`[public-tools] setting aside the reserve of ${type} call ${callId} failed:`, err);
          return { status: 503, body: { error: "this server cannot set credit aside just now — try again shortly" }, headers: { "retry-after": "30" } };
        }
        if (!held.ok) {
          // Only a token no holder narrowed is carried from (§4.5).
          if (held.reason === "short") {
            const carries = !presented.narrowed;
            return await pay(carries ? reserve - held.free : reserve, { remaining: held.free, reason: "short", ...(carries ? { carry: presented.tokenId } : {}) });
          }
          if (held.reason === "expired" || held.reason === "closed") return await pay(reserve, { reason: "expired" });
          if (held.reason === "carried") return await pay(reserve, { reason: "replaced" });
          return refused({ status: 401, code: "invalid_token", error: "invalid_token: this server's ledger does not know the token" });
        }
      }

      // The call, against the allowlist, under a time limit; never kept as
      // a run. The caller's config is the run's input, read by the step's
      // config as sole expressions: nothing in it is evaluated.
      const controller = new RunController(callId, `step:${type}`);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.force();
      }, timeoutMs);
      timer.unref?.();
      let result;
      try {
        result = await asPublicCall(() =>
          runSingleStep(type, registry, o.services(), {
            runId: callId,
            input: config,
            config: inputTemplates(config as Record<string, unknown>),
            origin: "public",
            controller,
            ...(o.principal ? { principal: o.principal } : {}),
            ...(admitted.capUsd !== undefined ? { maxCostUsd: admitted.capUsd } : {}),
          }),
        );
      } finally {
        clearTimeout(timer);
      }
      const spent = countUsage(result.events).cost;
      const cost = Number.isFinite(spent) && spent > 0 ? usdToMicros(spent) : 0;
      let failure: { status: 500 | 504; code: string; error: string } | undefined;
      if (timedOut) {
        failure = { status: 504, code: "timeout", error: `timeout: the call of ${type} ran past ${Math.round(timeoutMs / 1000)} s and was stopped` };
      } else if (result.status !== "success") {
        const message = (result.error?.message ?? `the call ended ${result.status}`).slice(0, ERROR_MAX_CHARS);
        failure = { status: 500, code: "step_failed", error: `step_failed: ${message}` };
      } else {
        const size = JSON.stringify(result.output ?? null).length;
        if (size > PUBLIC_TOOL_RESULT_MAX_CHARS) {
          failure = {
            status: 500,
            code: "result_too_big",
            error: `result_too_big: the result of ${type} is ${(size / 1024 / 1024).toFixed(1)} MB, over the ${PUBLIC_TOOL_RESULT_MAX_CHARS / 1024 / 1024} MB cap — ask for less`,
          };
        }
      }

      // The charge (§5, §6): by the rule, never past the reserve.
      const charged =
        (await charge({
          runId: callId,
          subject,
          cost,
          outcome: failure ? "error" : "success",
          price,
          ...(presented ? { token: presented.tokenId } : {}),
          at: now(),
        })) ?? 0;
      const view = presented ? await creditOf(presented, charged) : undefined;
      if (failure) return { status: failure.status, body: { error: failure.error, code: failure.code, ...(view ? { credit: view } : {}) } };
      return { status: 200, body: { output: result.output ?? null, ...(view ? { credit: view } : {}) } };
    } finally {
      flights.delete(callId);
    }
  };

  const reconcile: PublicTools["reconcile"] = async () => {
    const out: Array<{ subject: string; callId: string; action: "freed" | "failed" }> = [];
    let holds;
    try {
      holds = await (await o.ledger()).openHolds();
    } catch (err) {
      console.error(`[public-tools] reading the open holds failed:`, err);
      return out;
    }
    for (const h of holds) {
      if (!h.subject.startsWith("step:") || flights.has(h.runId) || pendingCharges.has(h.runId)) continue;
      try {
        await (await o.ledger()).charge({ token: h.token, runId: h.runId, subject: h.subject, cost: 0, outcome: "error", price: FREE, at: now() });
        out.push({ subject: h.subject, callId: h.runId, action: "freed" });
      } catch (err) {
        if (err instanceof LedgerError && err.code === "no_hold") continue;
        console.error(`[public-tools] freeing the hold of ${h.subject} call ${h.runId} failed:`, err);
        out.push({ subject: h.subject, callId: h.runId, action: "failed" });
      }
    }
    return out;
  };

  const close = () => {
    for (const p of pendingCharges.values()) clearTimeout(p.timer);
    pendingCharges.clear();
  };

  return { call, draining: () => o.draining?.(), inFlight: () => flights.size, reconcile, close };
}

// ── The bag ───────────────────────────────────────────────────────────────

/** A refusal for anything a public tool may not touch. */
const refuse = (what: string) => () => Promise.reject(new Error(`${what} is not available to a public tool: it reads (plans/paid-runs.md decision 15)`));

/** The schema resolver's reads, its writes refused. */
function readOnlySchemas(schemas: object): object {
  return new Proxy(schemas, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof prop === "string" && /^(?:create|delete|extend|register|ensure)/.test(prop)) return refuse(`the graph's schema writes (${prop})`);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** A graph writer whose every method refuses, naming what it is. */
function closedWriter(what: string): object {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then" || typeof prop === "symbol") return undefined;
        return refuse(`${what} (${String(prop)})`);
      },
    },
  );
}

/** No graph on this server: every read of it fails, saying so — never the
 *  `graph/*` steps' fallback of opening one from the environment. Its
 *  writers read as absent, as the runner's `bindGraph` asks. */
const NO_GRAPH: object = new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === "then" || prop === "nodes" || prop === "edges" || typeof prop === "symbol") return undefined;
      throw new Error("this strut server has no graph for a public tool to read");
    },
  },
);

/** One read-only statement's rows, on the engine's own read-only path: a
 *  READ transaction on Neo4j, a `READ ONLY` connection on a Ladybug file —
 *  the engine refuses a write whatever the keyword pre-check missed. */
async function readOnlyRows(g: GraphBackend, cypher: string, params: Params = {}): Promise<Row[]> {
  const { findWriteKeyword, ReadOnlyViolation } = await import("./graph/query.js");
  const kw = findWriteKeyword(cypher);
  if (kw) throw new ReadOnlyViolation(kw);
  if (g.kind === "ladybug") {
    const ro = await g.lbug.readOnly();
    try {
      return (await ro.run(cypher, params)).rows;
    } finally {
      await ro.close();
    }
  }
  const { txRows } = await import("./graph/bolt.js");
  return g.bolt.read((tx) => txRows(tx, cypher, params));
}

/**
 * The graph as a public tool reads it: `g` — the backend, or the view of it
 * a host's `graphReaders` hold to the `jobs` list — with its reader, its
 * dialect and its schema reads, a raw `query` that only READS (and only
 * when `g`'s list may read every namespace, as any view's), and every way
 * to write refused: the writers, a transaction, the schema's writes. The
 * engine's handles (`bolt`, `lbug`) are not on it.
 */
export function readOnlyGraph(g: GraphBackend): object {
  const rows = (cypher: string, params?: Params) => readOnlyRows(g, cypher, params);
  const view = {
    kind: g.kind,
    namespace: g.namespace,
    cfg: g.cfg,
    dialect: g.dialect,
    reader: g.reader,
    schemas: readOnlySchemas(g.schemas),
    nodes: closedWriter("the graph's node writes"),
    edges: closedWriter("the graph's edge writes"),
    async query(cypher: string, params?: Params): Promise<Row[]> {
      await assertRawQuery(g);
      return rows(cypher, params);
    },
    tx: refuse("a graph transaction"),
  };
  return carryScope(g, view, rows);
}

/** Resolve a hostname to its addresses (tests pass their own). */
export type HostLookup = (hostname: string) => Promise<string[]>;

/** The headers a redirect to another origin never carries, as fetch drops
 *  them: the caller's credentials were meant for the host it named. */
const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set(["authorization", "cookie", "proxy-authorization"]);

/** `headers` without the credential ones, names compared in any case;
 *  an object or a `Headers`, given back as a plain object. */
export function withoutCredentials(headers: HeadersInit | Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const entries: Array<[string, string]> =
    headers instanceof Headers ? [...headers.entries()] : Array.isArray(headers) ? (headers as Array<[string, string]>) : Object.entries(headers as Record<string, string>);
  return Object.fromEntries(entries.filter(([k]) => !CREDENTIAL_HEADERS.has(k.toLowerCase())));
}

/**
 * An http capability for a public call (SSRF): every URL, and every
 * redirect's, checked before it is fetched — `http(s)` only, never a
 * loopback, private, link-local (the cloud's metadata at 169.254.169.254),
 * multicast or reserved address, nor a name that resolves to one (aieo's
 * `validateFetchUrl`, loaded on the first request); redirects followed by
 * hand, at most 5, and — as fetch does — a hop to another origin carries
 * no `Authorization`, `Cookie` or `Proxy-Authorization`; each request at
 * most `PUBLIC_TOOL_HTTP_TIMEOUT_MS`. A tool that fronts a service on this
 * server's network is a workflow.
 *
 * Known limit: the address is checked by resolving the name, and the fetch
 * resolves it again, so a host that answers the two lookups differently
 * (DNS rebinding) can pass the check. Pinning the checked address closes it.
 */
export function guardedHttp(o: { fetch?: typeof globalThis.fetch; lookup?: HostLookup; timeoutMs?: number } = {}): HttpCapability {
  const fetchImpl = o.fetch ?? globalThis.fetch;
  const limit = o.timeoutMs ?? PUBLIC_TOOL_HTTP_TIMEOUT_MS;
  const guarded: FetchLike = async (raw, init = {}) => {
    const { validateFetchUrl } = await import("./aieo/fetch.js");
    const check = (u: string) => validateFetchUrl(u, o.lookup ? { lookup: o.lookup } : {});
    let url = await check(raw);
    let req = { ...init };
    for (let hop = 0; ; hop++) {
      const res = await fetchImpl(url.toString(), { ...req, redirect: "manual" } as RequestInit);
      if (![301, 302, 303, 307, 308].includes(res.status)) return res as unknown as Awaited<ReturnType<FetchLike>>;
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (!location) throw new Error(`redirect (${res.status}) without a Location header`);
      if (hop >= 5) throw new Error("too many redirects (more than 5)");
      const next = await check(new URL(location, url).toString());
      // As fetch does: credentials go no further than the origin they were
      // sent to.
      if (next.origin !== url.origin) {
        const headers = withoutCredentials(req.headers);
        req = { ...req, ...(headers ? { headers } : {}) };
      }
      url = next;
      // As fetch does: a 303, or a 301/302 after a POST, goes on as a GET.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && (req.method ?? "GET").toUpperCase() === "POST")) {
        const { body: _b, ...rest } = req;
        req = { ...rest, method: "GET" };
      }
    }
  };
  const inner = httpCapability(guarded);
  return (url, opts = {}) => inner(url, { ...opts, timeout: Math.min(opts.timeout ?? limit, limit) });
}

/**
 * The services bag a public tool's call runs against (§6, decision 15): an
 * ALLOWLIST, the visitor's (plans/public-surface.md §5) — `http` (guarded
 * for a stranger's call, `guardedHttp`), `secrets` (a step reads the keys
 * its own code names; a step whose config names one is never callable),
 * the runs held to the public view — with one difference: the graph's
 * READER is the whole graph's (`readOnlyGraph`), not the Public view's
 * filter. What the tool returns is what its publisher sells; it reads the
 * graph so the graph need not be public. No writers, no shell, no jobs, no
 * sessions, no peers, no MCP, no artifacts, no browser, no wallet: a step
 * reaching for one fails naming what is missing. Nothing on it hears a run
 * end (`onRunEnd`, `onRunEvent`): the call is not projected, verified or
 * sent to a sink.
 */
export function publicToolServices(
  bag: Record<string, unknown>,
  o: { graph?: GraphBackend | null; http?: HttpCapability; runs?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    ...(o.http ? { http: o.http } : {}),
    ...(bag["secrets"] ? { secrets: bag["secrets"] } : {}),
    graph: o.graph ? readOnlyGraph(o.graph) : NO_GRAPH,
    ...(o.runs ? { runs: o.runs } : {}),
  };
}
