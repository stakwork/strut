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
 *
 * With `grantsUrl`, `grants` is `ctx.services.llm` (stakwork/pods PLAN.md
 * §3.2): model calls for a machine outside strut — a pod — through a key the
 * host makes for it, billed to the run's principal under a cap and an expiry
 * of its own: `createStrut({ services: { llm: ms.grants } })`.
 */

import type { Hono } from "hono";
import type { Attenuation, AttenuationCaveats, Macaroon } from "gatekey";
import { randomBytes } from "node:crypto";
import { principalRequired, requireApiKey } from "./auth.js";
import { FileSecretStore, type SecretStore } from "./secret-store.js";
import type { WorkspaceStore } from "./workspace.js";
import type { LlmAuth, LlmAuthContext, LlmAuthResult, LlmGrant, LlmGrants } from "./llm.js";
import { gatewayLacksProvider } from "./llm.js";
import { bootEnv } from "./env.js";
import { DEFAULT_RUN_CAP_USD, resolveRunCap } from "./run-cap.js";

/** The one agent name hive authorizes for strut; every lineage starts here. */
export const STRUT_AGENT = "strut-agent";
/** What a chat turn is billed as (the leaf under `strut-agent`). */
export const STRUT_ASSISTANT = "strut-assistant";
/** The delegation file, beside `secrets.json` under `dataDir`. */
export const DELEGATIONS_FILE = "mothership.json";

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

/** A run's cost cap (src/run-cap.ts): re-exported, the Mothership's to apply. */
export { resolveRunCap };

/** A grant's cap when `STRUT_GRANT_MAX_COST_USD` sets none. Still open in
 *  stakwork/pods PLAN.md §15 item 6. */
export const DEFAULT_GRANT_CAP_USD = 10;

/** The longest a grant lives: a key for a machine outside strut is short-lived
 *  (a pod lives 8 hours on Lambda), and the host refuses a longer one. */
export const MAX_GRANT_HOURS = 24;

/** A grant's cost cap: `STRUT_GRANT_MAX_COST_USD`, else $10. Anything that is
 *  not a positive number is an error, as for a run's (`resolveRunCap`). */
export function resolveGrantCap(env: Record<string, string | undefined> = bootEnv()): number {
  const raw = env["STRUT_GRANT_MAX_COST_USD"];
  const cap = raw != null && raw.trim() !== "" ? Number(raw) : DEFAULT_GRANT_CAP_USD;
  if (!Number.isFinite(cap) || cap <= 0) {
    throw new Error(`STRUT_GRANT_MAX_COST_USD must be a positive number of dollars, got ${JSON.stringify(raw)}`);
  }
  return cap;
}

/** The variables an OpenAI or Anthropic SDK reads, for `key` on the gateway's
 *  public route at `address` (stakwork/pods PLAN.md §3.2). */
export function grantEnv(address: string, key: string): Record<string, string> {
  const root = address.replace(/\/+$/, "");
  return {
    OPENAI_BASE_URL: `${root}/openai/v1`,
    OPENAI_API_KEY: key,
    ANTHROPIC_BASE_URL: `${root}/anthropic`,
    ANTHROPIC_API_KEY: key,
  };
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
  /** Where strut asks the host for a grant's key (`STRUT_MOTHERSHIP_GRANTS_URL`;
   *  stadeum-ui's `/api/mothership/keys`). Unset: no `grants`. */
  grantsUrl?: string;
  /** The fetch for `grantsUrl` (tests). */
  fetch?: typeof globalThis.fetch;
}

export interface Mothership {
  /** Hand to `createStrut({ llmAuth })`. */
  llmAuth: LlmAuth;
  /** `ctx.services.llm`, with `grantsUrl`: hand to `createStrut({ services })`. */
  grants?: LlmGrants;
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

  const required = principalRequired;
  const nonce = () => randomBytes(16).toString("hex");
  const caveats = (agents: string[], runId: string, capUsd: number, exp: string): AttenuationCaveats => ({
    agents,
    run_id: runId,
    max_cost_usd: capUsd,
    max_steps: 0, // no call-count cap — restated on every link (see the plan, §3)
    exp,
    nonce: nonce(),
  });
  /** `now + 8h` (or `ttlMs`), or the parent's own exp string when that is
   *  sooner. The verifier compares exps as strings, so the parent's is
   *  returned verbatim. */
  const expFor = (now: Date, parentExp: string, ttlMs = LINK_TTL_MS) => {
    const mine = now.getTime() + ttlMs;
    return mine <= Date.parse(parentExp) ? new Date(mine).toISOString() : parentExp;
  };
  /** The delegation `principal`'s spend goes under, or undefined: nobody to
   *  bill here, so the provider directly — unless every call must be billed. */
  const delegationFor = async (principal: string | undefined, what: string, now: Date): Promise<Delegation | undefined> => {
    if (!principal) {
      if (required()) throw new Error(`${what} has nobody to bill — launch the run as a known actor or set the workflow's owner (STRUT_MOTHERSHIP_REQUIRED=1)`);
      return undefined;
    }
    const d = await delegations.get(principal);
    if (!d) {
      if (required()) throw new Error(`no Mothership authorization on file for ${principal} — open strut from hive to authorize (STRUT_MOTHERSHIP_REQUIRED=1)`);
      return undefined;
    }
    if (Date.parse(d.exp) <= now.getTime()) {
      throw new Error(`Mothership authorization for ${principal} expired at ${d.exp} — re-authorize from hive`);
    }
    return d;
  };
  /** The cap for a run, checked against the delegation's ceiling — a link
   *  above it would be rejected by the gateway, so fail here, loudly. */
  const capOrThrow = (workflowCap: number | undefined, ceiling: number, principal: string, runCap?: number) => {
    const cap = resolveRunCap(workflowCap, bootEnv(), opts.runCapDefault ?? DEFAULT_RUN_CAP_USD, runCap);
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
    // A public run carries a cap of its own (plans/paid-runs.md §7): the
    // link carries the smaller of it and the workflow's.
    const capUsd = capOrThrow(meta?.maxRunCostUsd, m.invocation.max_cost_usd, principal, ctx.maxCostUsd);
    const exp = expFor(now, m.invocation.exp);
    const link = gk.attenuate(gk.invocationSigBytes(m.invocation), caveats([STRUT_AGENT], runId, capUsd, exp));
    sweep(now.getTime());
    const entry = { link, capUsd, expMs: Date.parse(exp), delegationId: d.delegationId };
    runLinks.set(runId, entry);
    return entry;
  }

  const llmAuth: LlmAuth = async (ctx) => {
    const principal = ctx.principal;
    const now = clock();
    const d = await delegationFor(principal, "this LLM call", now);
    if (!d || !principal) return undefined;
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
      explainError: (err) =>
        explainExhausted(err, d, principal, m.invocation.max_cost_usd) ?? explainRefused(err) ?? explainUnrouted(err, ctx.provider),
      // A provider this gateway does not hold (a Numes nobody set up on it)
      // is called directly — unless every call must be billed here.
      direct: !required(),
    };
  };

  // ── Grants: model calls for a machine outside strut ──────────────────────
  // (stakwork/pods PLAN.md §3.2.) A link of the grant's own off the person's
  // invocation — its own run id, so the gateway caps its spend apart from any
  // run's, and its own expiry — then the host makes a virtual key under the
  // person's gateway customer and joins the two. The link does not bind
  // whoever holds the key: gatekey carries each link's HMAC, so dropping the
  // link leaves the person's whole delegation. So the host is sent the cap and
  // the expiry too, and holds the key to them.

  const grantsUrl = opts.grantsUrl?.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? globalThis.fetch;
  /** One call to the host's grants endpoint, with the deployment key. */
  const askHost = async (method: "POST" | "DELETE", url: string, body?: unknown, actor?: string) => {
    const key = bootEnv()["STRUT_API_KEY"];
    const res = await doFetch(url, {
      method,
      headers: {
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(actor ? { "x-strut-actor": actor } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, text };
  };

  async function grant(principal: string | undefined, req: { name: string; hours: number }): Promise<LlmGrant | null> {
    const { name: asked, hours } = req ?? ({} as typeof req);
    if (typeof asked !== "string" || !asked.trim()) throw new Error("llm.grant: name (a string) is required");
    if (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0 || hours > MAX_GRANT_HOURS) {
      throw new Error(`llm.grant: hours must be a positive number, at most ${MAX_GRANT_HOURS}`);
    }
    // What the gateway bills it as, and the host's name for the key.
    const name = stepAgentName(asked).slice(0, 64);
    const now = clock();
    const d = await delegationFor(principal, "this grant", now);
    if (!d || !principal) return null;
    const gk = await import("gatekey");
    const m = gk.decodeMacaroon(d.macaroon);
    const capUsd = resolveGrantCap();
    if (capUsd > m.invocation.max_cost_usd) {
      throw new Error(`grant cap $${capUsd} exceeds the delegation ceiling $${m.invocation.max_cost_usd} for ${principal} — lower STRUT_GRANT_MAX_COST_USD or re-authorize with a higher ceiling`);
    }
    const exp = expFor(now, m.invocation.exp, hours * 3600_000);
    const link = gk.attenuate(gk.invocationSigBytes(m.invocation), caveats([STRUT_AGENT, name], `grant-${nonce()}`, capUsd, exp));
    const macaroon = gk.encodeMacaroon({ ...m, attenuations: [link] });
    const res = await askHost("POST", grantsUrl!, { name, macaroon, max_cost_usd: capUsd, expires_at: exp }, principal);
    if (!res.ok) throw new Error(`no grant for ${principal}: ${grantsUrl} answered ${res.status} ${res.text.slice(0, 300)}`);
    let body: { id?: unknown; key?: unknown; address?: unknown } | null = null;
    try {
      body = JSON.parse(res.text);
    } catch {
      /* checked below */
    }
    if (typeof body?.id !== "string" || !body.id || typeof body.key !== "string" || !body.key || typeof body.address !== "string" || !/^https?:\/\//.test(body.address)) {
      throw new Error(`no grant for ${principal}: ${grantsUrl} answered without an id, a key and an address`);
    }
    return { id: body.id, env: grantEnv(body.address, body.key), expiresAt: exp };
  }

  /** The host deletes the key. No actor: a job's sweep releases with none. */
  async function revoke(id: string): Promise<void> {
    if (typeof id !== "string" || !id) throw new Error("llm.revoke: id (a string) is required");
    const res = await askHost("DELETE", `${grantsUrl}/${encodeURIComponent(id)}`);
    if (!res.ok && res.status !== 404) throw new Error(`could not revoke grant ${id}: ${grantsUrl} answered ${res.status} ${res.text.slice(0, 300)}`);
  }

  const grantsFor = (principal: string | undefined): LlmGrants => ({
    grant: (req) => grant(principal, req),
    revoke,
    forPrincipal: grantsFor,
  });

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

  return { llmAuth, ...(grantsUrl ? { grants: grantsFor(undefined) } : {}), delegations, mount };
}

/**
 * The gateway's 402 for a spent CEILING names the delegation's run id, not
 * the strut run's (`cost:run:<delegationId>` is the layer that tripped). Say
 * so — "re-authorize", not "run over cap". Any other error is left alone.
 */
export function explainExhausted(err: unknown, d: Pick<Delegation, "delegationId">, actor: string, ceilingUsd?: number): string | undefined {
  if (!errorText(err).includes(d.delegationId)) return undefined;
  const ceiling = ceilingUsd != null ? ` ($${ceilingUsd})` : "";
  return `Mothership authorization for ${actor} is exhausted — its ceiling${ceiling} is spent; re-authorize from hive. (delegation ${d.delegationId}: ${String((err as { message?: unknown } | null)?.message ?? "")})`;
}

/**
 * The gateway refuses a model the person's virtual key does not allow —
 * bifrost's governance says "Model 'X' is not allowed", or "Provider 'P' is
 * not allowed" for a provider the key has none of. A host that narrows
 * every key to its list (stadeum's allowed models) means "not enabled
 * here": say so, and who can change it. Any other error is left alone.
 */
export function explainRefused(err: unknown): string | undefined {
  const m = /\b(?:Model|Provider) '([^']+)' is not allowed/.exec(errorText(err));
  return m ? `${m[1]} is not enabled for this workspace: ask an admin` : undefined;
}

/**
 * The gateway holds no provider by this name (`numes/…` on a Bifrost nobody
 * added `numes` to). Reached only where the call may not go around the
 * gateway (STRUT_MOTHERSHIP_REQUIRED): say what an admin must add.
 */
export function explainUnrouted(err: unknown, provider: string): string | undefined {
  return gatewayLacksProvider(err)
    ? `${provider} is not set up on this deployment's LLM gateway: ask an admin to add it as a custom provider`
    : undefined;
}

/** An AI SDK error's message and the provider's response body, as one string. */
function errorText(err: unknown): string {
  const e = err as { message?: unknown; responseBody?: unknown } | null;
  return [e?.message, e?.responseBody].filter((s): s is string => typeof s === "string").join(" ");
}
