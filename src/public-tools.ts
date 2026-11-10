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
 * - the config: an object, no `{{ }}` (a stranger's config is data, never
 *   an expression the runner evaluates), parsed by the step's own input
 *   schema (400 naming the field);
 * - a priced item's credit token (§4.3 steps 1 to 3): 401 a bad one, 403 one
 *   its holder narrowed away from this step or below its reserve;
 * - the caps: the server's limit on tool calls in flight, and the item's
 *   `dailyCapUsd` when it sets one (today's cost plus each call in flight at
 *   its cap, as a run's, §7) — 429;
 * - the price: no token, or one short of the reserve, is a 402 (§4, carry-
 *   over as a launch's); a token's first use asks the wallet (503 when it
 *   cannot); the reserve is set aside under the call's id (`ledger.hold`);
 * - the call: `runSingleStep` — never `runStep`, which keeps a run with
 *   claims — against the ALLOWLIST bag (`publicToolServices`), with no actor,
 *   the host's public principal, the item's cap; nothing reaches the run
 *   store: the ledger entry is the call's record;
 * - the charge, by the rule (`chargeFor`): base + markup × what the call
 *   reported it cost (`withUsage`; none, its base); a throw, or a result over
 *   5 MB, its cost and no base; never more than the reserve (`withinReserve`)
 *   or what the token holds. A free call is a charge of nothing, which
 *   `daily` counts with its cost.
 *
 * **A crash between the hold and the charge** leaves the hold open with no
 * record of what ran: the call never answered, so its buyer is charged
 * nothing. `reconcile` (boot, beside item 5's) frees every open `step:` hold
 * whose call is not in flight in this process — a charge of nothing.
 *
 * **Free calls** need no token. Beyond the per-address budget (the route's,
 * shared with launches) they are held by the server's limit on tool calls in
 * flight, and by the item's daily cap when it sets one; no daily cap is
 * required of a free step at the save, since a runnable step cannot be one
 * that spends (`agent`, `llm`, `acp/prompt`).
 */
import type { StepRegistry } from "./core.js";
import type { LedgerStore, Micros, Price } from "./payments/ledger.js";
import { FREE, LedgerError, microsToUsd, priceOf, usdToMicros } from "./payments/ledger.js";
import type { PublicRunnable, PublicSurfaceService } from "./public-surface.js";
import { isPriced, runnableReserve, runnableSubject, stepRunnableProblem } from "./public-runnable.js";
import { tokenRefusal, type Presented, type VerifiedToken } from "./l402.js";
import type { Challenge, Credit, CreditRefusal } from "./public-credit.js";
import { runSingleStep } from "./run-step.js";
import { countUsage, generateRunId } from "./store.js";
import { secondsToUtcMidnight } from "./public-runs.js";
import { STEP_RUN_RESULT_MAX_CHARS } from "./apps/tools.js";
import type { GraphReader } from "./graph/search.js";

/** Public tool calls in flight on this server at once, by default. */
export const PUBLIC_TOOL_CALLS_MAX_IN_FLIGHT = 20;
/** The most a call's result may be, as JSON: the app door's cap. */
export const PUBLIC_TOOL_RESULT_MAX_CHARS = STEP_RUN_RESULT_MAX_CHARS;
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
      status: 400 | 401 | 403 | 404 | 429 | 500 | 503;
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
  /** Who is asking: the per-address allowance on invoices. */
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
  now?: () => number;
}

export interface PublicTools {
  call(c: ToolCall): Promise<ToolAnswer>;
  /** Why nothing new starts now (the drain), else undefined: a door asks it
   *  before reading a body; `call` asks it again. */
  draining(): string | undefined;
  /** Tool calls in flight in this process: what the drain waits on. */
  inFlight(): number;
  /** Boot: free every open `step:` hold whose call is not in flight here —
   *  a crash cut it off between its hold and its charge. Never throws. */
  reconcile(): Promise<Array<{ subject: string; callId: string; action: "freed" | "failed" }>>;
}

const usd = (micros: Micros) => `$${microsToUsd(micros).toFixed(2)}`;

/** A refusal as an answer. A 401 names the scheme. */
function refused(r: Pick<CreditRefusal, "status" | "code" | "error" | "retryAfter">): ToolAnswer {
  const headers: Record<string, string> = {};
  if (r.retryAfter !== undefined) headers["retry-after"] = String(r.retryAfter);
  if (r.status === 401) headers["www-authenticate"] = `L402 error="${r.code}"`;
  return { status: r.status, body: { error: r.error, code: r.code }, headers };
}

/** The first string in `v` that holds a template, by its path, else undefined. */
export function templateIn(v: unknown, path = "config"): string | undefined {
  if (typeof v === "string") return v.includes("{{") ? path : undefined;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const at = templateIn(v[i], `${path}[${i}]`);
      if (at) return at;
    }
    return undefined;
  }
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      const at = templateIn(x, `${path}.${k}`);
      if (at) return at;
    }
  }
  return undefined;
}

export function createPublicTools(o: PublicToolsOptions): PublicTools {
  const now = o.now ?? Date.now;
  const max = o.maxInFlight ?? PUBLIC_TOOL_CALLS_MAX_IN_FLIGHT;
  /** callId → its subject and what the daily cap counts it at. */
  const flights = new Map<string, { subject: string; cap?: Micros }>();

  // Admission is one step at a time: the daily cap's check and counting the
  // call are one step, so twenty calls in one second stay inside the cap.
  let serial: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = serial.then(fn, fn);
    serial = p.catch(() => undefined);
    return p;
  };

  type Admitted = { ok: true; callId: string; capUsd?: number } | { ok: false; answer: ToolAnswer };
  const admit = (item: PublicRunnable): Promise<Admitted> =>
    oneAtATime(async (): Promise<Admitted> => {
      const subject = runnableSubject(item);
      if (flights.size >= max) {
        return { ok: false, answer: { status: 429, body: { error: `too many public tool calls in flight on this server (${max}) — try again shortly` }, headers: { "retry-after": "5" } } };
      }
      const caps: Micros[] = [];
      if (item.capUsd !== undefined) caps.push(usdToMicros(item.capUsd));
      if (item.dailyCapUsd !== undefined) {
        const daily = usdToMicros(item.dailyCapUsd);
        let today: Micros;
        try {
          today = (await (await o.ledger()).today(subject, { now: now() })).cost;
        } catch (err) {
          console.error(`[public-tools] reading today's spend of ${subject} failed:`, err);
          return { ok: false, answer: { status: 503, body: { error: "the ledger cannot be read just now — try again shortly" }, headers: { "retry-after": "30" } } };
        }
        // A call in flight counts at its cap; one with none, at the whole cap.
        let held = 0;
        for (const f of flights.values()) if (f.subject === subject) held += f.cap ?? daily;
        if (today + held >= daily) {
          const spent = today >= daily;
          return {
            ok: false,
            answer: {
              status: 429,
              body: {
                error: spent
                  ? `step "${item.name}" has spent its daily cap (${usd(daily)}) — try again tomorrow (UTC)`
                  : `step "${item.name}" has its daily cap (${usd(daily)}) set aside for calls in flight — try again when one ends`,
              },
              headers: { "retry-after": String(spent ? secondsToUtcMidnight(now()) : 5) },
            },
          };
        }
        caps.push(daily - today - held);
      }
      const cap = caps.length ? Math.max(1, Math.min(...caps)) : undefined;
      const callId = generateRunId();
      flights.set(callId, { subject, ...(cap !== undefined ? { cap } : {}) });
      return { ok: true, callId, ...(cap !== undefined ? { capUsd: microsToUsd(cap) } : {}) };
    });

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
    // Item 2's save checks, again: sealed, spends or a shell, a container, gone.
    const registry = o.registry();
    const problem = stepRunnableProblem(type, registry, o.sealedPatterns);
    if (problem) {
      console.warn(`[public-tools] ${type} is in the public view and refused: ${problem}`);
      return notOpen;
    }
    const def = registry[type]!;

    // The config: an object of data, as the step's own schema reads it.
    const config = c.config ?? {};
    if (!config || typeof config !== "object" || Array.isArray(config)) return { status: 400, body: { error: "config is a JSON object: the step's config" } };
    const tmpl = templateIn(config);
    if (tmpl) return { status: 400, body: { error: `${tmpl}: a public call's config is data — "{{" is not allowed in it` } };
    const parsed = def.input.safeParse(config);
    if (!parsed.success) return { status: 400, body: { error: `config: ${parsed.error.issues.map((i) => `${["config", ...i.path].join(".")}: ${i.message}`).join("; ")}` } };

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

    const admitted = await admit(item);
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

      // The call, against the allowlist; never kept as a run.
      const result = await runSingleStep(type, registry, o.services(), {
        runId: callId,
        config: config as Record<string, unknown>,
        origin: "public",
        ...(o.principal ? { principal: o.principal } : {}),
        ...(admitted.capUsd !== undefined ? { maxCostUsd: admitted.capUsd } : {}),
      });
      const spent = countUsage(result.events).cost;
      const cost = Number.isFinite(spent) && spent > 0 ? usdToMicros(spent) : 0;
      let failure: { code: string; error: string } | undefined;
      if (result.status !== "success") {
        const message = (result.error?.message ?? `the call ended ${result.status}`).slice(0, ERROR_MAX_CHARS);
        failure = { code: "step_failed", error: `step_failed: ${message}` };
      } else {
        const size = JSON.stringify(result.output ?? null).length;
        if (size > PUBLIC_TOOL_RESULT_MAX_CHARS) {
          failure = {
            code: "result_too_big",
            error: `result_too_big: the result of ${type} is ${(size / 1024 / 1024).toFixed(1)} MB, over the ${PUBLIC_TOOL_RESULT_MAX_CHARS / 1024 / 1024} MB cap — ask for less`,
          };
        }
      }

      // The charge (§5, §6): by the rule, never past the reserve.
      let charged: Micros = 0;
      try {
        const done = await (await o.ledger()).charge({
          runId: callId,
          subject,
          cost,
          outcome: failure ? "error" : "success",
          price,
          ...(presented ? { token: presented.tokenId, withinReserve: true } : {}),
          at: now(),
        });
        charged = done.charged;
      } catch (err) {
        // The answer stands; the hold stays set aside until the boot frees it.
        console.error(`[public-tools] charging ${type} call ${callId} failed (the boot reconcile frees its hold):`, err);
      }
      const view = presented ? await creditOf(presented, charged) : undefined;
      if (failure) return { status: 500, body: { error: failure.error, code: failure.code, ...(view ? { credit: view } : {}) } };
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
      if (!h.subject.startsWith("step:") || flights.has(h.runId)) continue;
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

  return { call, draining: () => o.draining?.(), inFlight: () => flights.size, reconcile };
}

// ── The bag ───────────────────────────────────────────────────────────────

/** What a public tool reads of the graph: `kind`, `namespace`, `cfg`,
 *  `reader`, and the schema reads. */
interface GraphLike {
  kind: string;
  namespace: string;
  cfg: unknown;
  schemas: object;
}

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

/**
 * The services bag a public tool's call runs against (§6, decision 15): an
 * ALLOWLIST, the visitor's (plans/public-surface.md §5) — `http`, `secrets`
 * (a step reads the keys its publisher ticked), the runs held to the public
 * view — with one difference: the graph's READER is the whole graph's, not
 * the Public view's filter. What the tool returns is what its publisher
 * sells; it reads the graph so the graph need not be public. No writers,
 * no raw query, no shell, no jobs, no sessions, no peers, no MCP, no
 * artifacts, no browser, no wallet: a step reaching for one fails naming
 * what is missing. Nothing on it hears a run end (`onRunEnd`,
 * `onRunEvent`): the call is not projected, verified or sent to a sink.
 */
export function publicToolServices(
  bag: Record<string, unknown>,
  graph: (GraphLike & { reader: GraphReader }) | null,
  o: { reader?: GraphReader; runs?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    ...(bag["http"] ? { http: bag["http"] } : {}),
    ...(bag["secrets"] ? { secrets: bag["secrets"] } : {}),
    graph: graph
      ? {
          kind: graph.kind,
          namespace: graph.namespace,
          cfg: graph.cfg,
          schemas: readOnlySchemas(graph.schemas),
          reader: o.reader ?? graph.reader,
          nodes: closedWriter("the graph's node writes"),
          edges: closedWriter("the graph's edge writes"),
          query: refuse("a raw graph query"),
          tx: refuse("a graph transaction"),
        }
      : NO_GRAPH,
    ...(o.runs ? { runs: o.runs } : {}),
  };
}
