/**
 * Mothership cost control — opt-in (plans/mothership-cost-control.md §3).
 *
 * Routes strut's LLM spend through the Agent Mothership (the stakgraph
 * gateway) so every call is billed to a PERSON, a WORKFLOW and a STEP, and
 * capped per run and per delegation. Hive mints, once per user and
 * deployment, a long-lived macaroon — an org-signed user authorization plus a
 * user-signed *standing invocation* for the agent `strut-agent` — and pushes
 * it here with that user's virtual key and the gateway URL. Strut never
 * signs: before each LLM call it appends keyless HMAC links (gatekey's
 * `attenuate`) that name the run, its cap, and the step, and hands
 * `{ apiKey, baseUrl, headers }` to core's `llmAuth` seam (llm.ts). The
 * gateway verifies the chain and bills the LAST agent name — the step.
 *
 * Core never imports this module. A host builds it, passes `llmAuth` to
 * `createStrut`, and calls `mount(strut)` for the delegation routes:
 *
 * ```ts
 * const ms = createMothership({ dataDir });
 * const strut = await createStrut({ llmAuth: ms.llmAuth, resolveActor });
 * ms.mount(strut);
 * ```
 *
 * Delegations live in a SECOND encrypted `FileSecretStore` file
 * (`mothership.json` beside `secrets.json`) — never on the services bag, so
 * no step (LLM-authored ones included) can read another user's macaroon
 * through `ctx.services.secrets`, and never in the Secrets list.
 */

import type { Hono } from "hono";
import type { Attenuation, AttenuationCaveats, Macaroon } from "gatekey";
import { randomBytes } from "node:crypto";
import { requireApiKey } from "./auth.js";
import { FileSecretStore, type SecretStore } from "./secret-store.js";
import type { WorkspaceStore } from "./workspace.js";
import type { LlmAuth, LlmAuthContext, LlmAuthResult } from "./llm.js";

/** The one agent name hive authorizes for strut; every lineage starts here. */
export const STRUT_AGENT = "strut-agent";
/** What a chat turn is billed as (the leaf under `strut-agent`). */
export const STRUT_ASSISTANT = "strut-assistant";
/** The delegation file, beside `secrets.json` under `dataDir`. */
export const DELEGATIONS_FILE = "mothership.json";

const DEFAULT_RUN_CAP_USD = 100;
/** A link must outlive the longest single step (the header is fixed when the
 *  step builds its client); it does not bound the run — strut re-links. */
const LINK_TTL_MS = 8 * 3600_000;
const RELINK_BEFORE_MS = 3600_000;

// ── Delegations ────────────────────────────────────────────────────────────

/** What hive pushes for one user, plus what strut copies out of the macaroon
 *  on `PUT` so listing is one decrypt per entry. */
export interface Delegation {
  /** The base64url macaroon: UA + standing invocation, no attenuations. */
  macaroon: string;
  /** The standing invocation's `run_id` — the gateway's key for this user's
   *  cumulative strut spend and its kill switch. */
  delegationId: string;
  /** The user's virtual key and the gateway root. */
  apiKey: string;
  baseUrl: string;
  /** The earlier of the UA's and the invocation's expiry. */
  exp: string;
}

export interface DelegationSummary {
  actor: string;
  exp: string;
  delegationId: string;
}

export interface DelegationStore {
  get(actor: string): Promise<Delegation | undefined>;
  put(actor: string, d: Delegation): Promise<void>;
  delete(actor: string): Promise<boolean>;
  /** What hive's reconciler diffs against — never the macaroon or key. */
  list(): Promise<DelegationSummary[]>;
}

const NAME_PREFIX = "D_";
/** Actors carry `-` (hive's `{login}-{id}`), which secret names refuse. */
const nameFor = (actor: string) => `${NAME_PREFIX}${Buffer.from(actor, "utf8").toString("hex")}`;
const actorFor = (name: string) => Buffer.from(name.slice(NAME_PREFIX.length), "hex").toString("utf8");

/** A delegation store over any `SecretStore` — one JSON value per actor. */
export function delegationStore(secrets: SecretStore): DelegationStore {
  return {
    async get(actor) {
      const raw = await secrets.get(nameFor(actor));
      if (!raw) return undefined;
      try {
        return JSON.parse(raw) as Delegation;
      } catch {
        return undefined;
      }
    },
    async put(actor, d) {
      await secrets.set(nameFor(actor), JSON.stringify(d));
    },
    async delete(actor) {
      return secrets.delete(nameFor(actor));
    },
    async list() {
      const out: DelegationSummary[] = [];
      for (const { name } of await secrets.list()) {
        if (!name.startsWith(NAME_PREFIX)) continue;
        const actor = actorFor(name);
        const d = await this.get(actor);
        if (d) out.push({ actor, exp: d.exp, delegationId: d.delegationId });
      }
      return out;
    },
  };
}

/** What `PUT /llm/delegations/:actor` checks about a macaroon's SHAPE before
 *  storing it. Signatures cannot be checked here (strut has no org pubkey;
 *  the gateway is the verifier) — this catches the wrong kind of macaroon:
 *  one already attenuated, minted for another agent, carrying a call-count
 *  cap strut could never narrow under, or with no ceiling at all. */
export async function checkDelegationMacaroon(
  encoded: string,
): Promise<{ delegationId: string; exp: string; ceilingUsd: number }> {
  const { decodeMacaroon } = await import("gatekey");
  let m: Macaroon;
  try {
    m = decodeMacaroon(encoded);
  } catch (err) {
    throw new Error(`macaroon does not decode: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (m.v !== 1) throw new Error(`macaroon v=${String(m.v)}; expected 1`);
  const ua = m.user_authorization;
  const inv = m.invocation;
  if (!ua || typeof ua !== "object" || !inv || typeof inv !== "object") {
    throw new Error("macaroon must carry a user_authorization and an invocation");
  }
  if (!Array.isArray(m.attenuations) || m.attenuations.length > 0) {
    throw new Error("a delegation must carry no attenuations — strut appends its own");
  }
  if (!Array.isArray(inv.agents) || !inv.agents.includes(STRUT_AGENT)) {
    throw new Error(`the invocation must authorize agent "${STRUT_AGENT}"`);
  }
  if (inv.max_steps !== 0) {
    throw new Error(`the invocation's max_steps must be 0 (no call-count cap); got ${String(inv.max_steps)}`);
  }
  if (typeof inv.max_cost_usd !== "number" || !(inv.max_cost_usd > 0)) {
    throw new Error("the invocation's max_cost_usd (the delegation ceiling) must be a positive number");
  }
  if (typeof inv.run_id !== "string" || !inv.run_id) {
    throw new Error("the invocation must carry a run_id (the delegation id)");
  }
  for (const [what, exp] of [["user_authorization", ua.exp], ["invocation", inv.exp]] as const) {
    if (typeof exp !== "string" || !Number.isFinite(Date.parse(exp))) {
      throw new Error(`the ${what}'s exp is not a timestamp`);
    }
  }
  const exp = Date.parse(ua.exp) <= Date.parse(inv.exp) ? ua.exp : inv.exp;
  return { delegationId: inv.run_id, exp, ceilingUsd: inv.max_cost_usd };
}

// ── Naming and caps ────────────────────────────────────────────────────────

/**
 * The agent name a step is billed as: its event path with the workflow as
 * the first segment, each segment stripped of the loop `#n` suffix and the
 * `NNN-` tool-call prefix (a step an agent calls as a tool runs at
 * `<agent>/003-llm`, and without the strip every call would be its own
 * agent), joined with `.`. Never `/` — the gateway's `/agents/<name>/spend`
 * routes split on it — and nothing outside `[A-Za-z0-9_.-]` (workflow names
 * are not validated on publish). `digest/loop#3/summarize` → `digest.loop.summarize`.
 */
export function stepAgentName(stepPath: string): string {
  const name = stepPath
    .split("/")
    .filter(Boolean)
    .map((seg) => seg.replace(/#\d+$/, "").replace(/^\d{3,}-/, "").replace(/[^A-Za-z0-9_.-]/g, "_"))
    .filter(Boolean)
    .join(".");
  return name || "unknown";
}

/**
 * A run's cost cap: the workflow's `maxRunCostUsd`, else
 * `STRUT_RUN_MAX_COST_USD`, else the built-in default. Anything that is not
 * a positive number is an ERROR, never a fallback — `0` reads as "uncapped"
 * to the gateway, and that must never happen by way of a typo. An unset or
 * empty env var is simply absent.
 */
export function resolveRunCap(
  workflowCap: number | undefined,
  env: Record<string, string | undefined> = process.env,
  fallback = DEFAULT_RUN_CAP_USD,
): number {
  const raw = env["STRUT_RUN_MAX_COST_USD"];
  const cap = workflowCap ?? (raw != null && raw.trim() !== "" ? Number(raw) : fallback);
  if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0) {
    throw new Error(
      `run cost cap must be a positive number of dollars, got ${JSON.stringify(cap)} — check the workflow's maxRunCostUsd / STRUT_RUN_MAX_COST_USD`,
    );
  }
  return cap;
}

// ── The module ─────────────────────────────────────────────────────────────

export interface MothershipOptions {
  /** Strut's local data dir: `mothership.json` is written here, beside
   *  `secrets.json`, under the same `STRUT_SECRET_KEY`. */
  dataDir: string;
  /** Where delegations live; defaults to a second `FileSecretStore` at
   *  `dataDir/mothership.json`. Tests inject a `MemorySecretStore`. */
  store?: SecretStore;
  /** The run cap when neither the workflow nor the env sets one. $100. */
  runCapDefault?: number;
  /** Injectable clock (tests). */
  now?: () => Date;
}

export interface Mothership {
  /** Hand to `createStrut({ llmAuth })`. */
  llmAuth: LlmAuth;
  delegations: DelegationStore;
  /** Adds the delegation routes to the app and gives the hook the workspace
   *  it reads run caps from. Call once, after `createStrut`. */
  mount(strut: { app: Hono; workspace: WorkspaceStore }): void;
}

interface RunLink {
  link: Attenuation;
  capUsd: number;
  expMs: number;
  delegationId: string;
}

export function createMothership(opts: MothershipOptions): Mothership {
  const delegations = delegationStore(opts.store ?? new FileSecretStore(opts.dataDir, DELEGATIONS_FILE));
  const clock = opts.now ?? (() => new Date());
  let workspace: WorkspaceStore | undefined;
  /** One run link per strut run, re-used by every step of it (cached by run
   *  id, re-linked within an hour of its exp or when the delegation changed). */
  const runLinks = new Map<string, RunLink>();

  const required = () => process.env["STRUT_MOTHERSHIP_REQUIRED"] === "1";
  const nonce = () => randomBytes(16).toString("hex");
  const caveats = (agents: string[], runId: string, capUsd: number, exp: string): AttenuationCaveats => ({
    agents,
    run_id: runId,
    max_cost_usd: capUsd,
    max_steps: 0, // no call-count cap — restated on every link (see the plan, §3)
    exp,
    nonce: nonce(),
  });
  /** `now + 8h`, or the parent's own exp string when that is sooner. The
   *  verifier compares exps as strings, so the parent's is returned verbatim. */
  const expFor = (now: Date, parentExp: string) => {
    const mine = new Date(now.getTime() + LINK_TTL_MS).toISOString();
    return Date.parse(mine) <= Date.parse(parentExp) ? mine : parentExp;
  };
  /** The cap for a run, checked against the delegation's ceiling — a link
   *  above it would be rejected by the gateway, so fail here, loudly. */
  const capOrThrow = (workflowCap: number | undefined, ceiling: number, principal: string) => {
    const cap = resolveRunCap(workflowCap, process.env, opts.runCapDefault);
    if (cap > ceiling) {
      throw new Error(`workflow cap $${cap} exceeds the delegation ceiling $${ceiling} for ${principal} — lower the cap or re-authorize with a higher ceiling`);
    }
    return cap;
  };
  const sweep = (nowMs: number) => {
    for (const [k, v] of runLinks) if (v.expMs <= nowMs) runLinks.delete(k);
  };

  async function runLink(
    gk: typeof import("gatekey"),
    ctx: LlmAuthContext,
    m: Macaroon,
    d: Delegation,
    principal: string,
    now: Date,
  ): Promise<RunLink> {
    const runId = ctx.runId!;
    const cached = runLinks.get(runId);
    if (cached && cached.delegationId === d.delegationId && cached.expMs - now.getTime() > RELINK_BEFORE_MS) return cached;
    if (!workspace) throw new Error("createMothership: call mount(strut) before running workflows");
    const meta = ctx.workflow ? await workspace.getWorkflowMetadata(ctx.workflow).catch(() => null) : null;
    const capUsd = capOrThrow(meta?.maxRunCostUsd, m.invocation.max_cost_usd, principal);
    const exp = expFor(now, m.invocation.exp);
    const link = gk.attenuate(gk.invocationSigBytes(m.invocation), caveats([STRUT_AGENT], runId, capUsd, exp));
    sweep(now.getTime());
    const entry = { link, capUsd, expMs: Date.parse(exp), delegationId: d.delegationId };
    runLinks.set(runId, entry);
    return entry;
  }

  const llmAuth: LlmAuth = async (ctx) => {
    const principal = ctx.principal;
    if (!principal) {
      if (required()) throw new Error("this LLM call has nobody to bill — launch the run as a known actor or set the workflow's owner (STRUT_MOTHERSHIP_REQUIRED=1)");
      return undefined;
    }
    const d = await delegations.get(principal);
    if (!d) {
      if (required()) throw new Error(`no Mothership authorization on file for ${principal} — open strut from hive to authorize (STRUT_MOTHERSHIP_REQUIRED=1)`);
      return undefined;
    }
    const now = clock();
    if (Date.parse(d.exp) <= now.getTime()) {
      throw new Error(`Mothership authorization for ${principal} expired at ${d.exp} — re-authorize from hive`);
    }
    const gk = await import("gatekey");
    const m = gk.decodeMacaroon(d.macaroon);
    let links: Attenuation[];
    let sessionId: string;
    if (ctx.kind === "chat") {
      // One link off the invocation: billed as the assistant, one gateway
      // run per turn, capped at the env/default (no workflow to override it).
      const capUsd = capOrThrow(undefined, m.invocation.max_cost_usd, principal);
      links = [
        gk.attenuate(
          gk.invocationSigBytes(m.invocation),
          caveats([STRUT_AGENT, STRUT_ASSISTANT], `${ctx.chatId}.${ctx.turn ?? 0}`, capUsd, expFor(now, m.invocation.exp)),
        ),
      ];
      sessionId = ctx.chatId ?? "chat";
    } else {
      if (!ctx.runId) throw new Error("mothership: a step call needs a runId");
      const run = await runLink(gk, ctx, m, d, principal, now);
      // The step link restates the run's id and cap (the gateway dedupes
      // chain layers by run id: the enforced chain is [run, delegation]) and
      // adds the step to the lineage — the last name is what gets billed.
      const step = gk.attenuate(
        gk.attenuationSigBytes(run.link),
        caveats([STRUT_AGENT, stepAgentName(ctx.stepPath ?? "")], ctx.runId, run.capUsd, run.link.caveats.exp),
      );
      links = [run.link, step];
      sessionId = ctx.workflow ?? "";
    }
    const macaroon = gk.encodeMacaroon({ ...m, attenuations: links });
    return {
      apiKey: d.apiKey,
      baseUrl: d.baseUrl,
      headers: {
        "x-macaroon": macaroon,
        "x-bf-dim-session-id": sessionId,
        // Every strut lineage starts at strut-agent; sent as a plain dim so the
        // Mothership UI can fold strut's steps under one node from day one.
        "x-bf-dim-root-agent": STRUT_AGENT,
      },
      explainError: (err) => explainExhausted(err, d, principal, m.invocation.max_cost_usd),
    };
  };

  function mount(strut: { app: Hono; workspace: WorkspaceStore }): void {
    workspace = strut.workspace;
    const app = strut.app;

    // Lets the UI know the run-cap field means something here.
    app.get("/llm/mothership", (c) => c.json({ enabled: true }));

    // What hive's reconciler diffs against: actors, expiries, delegation ids.
    app.get("/llm/delegations", requireApiKey, async (c) => c.json(await delegations.list()));

    app.put("/llm/delegations/:actor", requireApiKey, async (c) => {
      const actor = c.req.param("actor")!;
      const body = await c.req
        .json<{ macaroon?: unknown; apiKey?: unknown; baseUrl?: unknown }>()
        .catch(() => ({}) as Record<string, unknown>);
      const { macaroon, apiKey, baseUrl } = body;
      if (typeof macaroon !== "string" || !macaroon) return c.json({ error: "macaroon (string) is required" }, 400);
      if (typeof apiKey !== "string" || !apiKey) return c.json({ error: "apiKey (string) is required" }, 400);
      if (typeof baseUrl !== "string" || !/^https?:\/\//.test(baseUrl)) return c.json({ error: "baseUrl (http(s) URL) is required" }, 400);
      let checked;
      try {
        checked = await checkDelegationMacaroon(macaroon);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
      await delegations.put(actor, { macaroon, apiKey, baseUrl: baseUrl.replace(/\/+$/, ""), delegationId: checked.delegationId, exp: checked.exp });
      return c.json({ actor, exp: checked.exp, delegationId: checked.delegationId });
    });

    app.delete("/llm/delegations/:actor", requireApiKey, async (c) => {
      const actor = c.req.param("actor")!;
      if (!(await delegations.delete(actor))) return c.json({ error: `no delegation for ${actor}` }, 404);
      return c.json({ ok: true, actor });
    });
  }

  return { llmAuth, delegations, mount };
}

/**
 * The gateway's 402 for a spent CEILING names the delegation's run id, not
 * the strut run's (`cost:run:<delegationId>` is the layer that tripped). Say
 * so — "re-authorize", not "run over cap". Any other error is left alone.
 */
export function explainExhausted(err: unknown, d: Pick<Delegation, "delegationId">, actor: string, ceilingUsd?: number): string | undefined {
  const e = err as { message?: unknown; responseBody?: unknown } | null;
  const text = [e?.message, e?.responseBody].filter((s): s is string => typeof s === "string").join(" ");
  if (!text.includes(d.delegationId)) return undefined;
  const ceiling = ceilingUsd != null ? ` ($${ceilingUsd})` : "";
  return `Mothership authorization for ${actor} is exhausted — its ceiling${ceiling} is spent; re-authorize from hive. (delegation ${d.delegationId}: ${String(e?.message ?? "")})`;
}
