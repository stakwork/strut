/**
 * Mothership cost control — opt-in (plans/mothership-cost-control.md §3).
 *
 * Routes strut's LLM spend through the Agent Mothership gateway so every
 * call is billed to a PERSON, a WORKFLOW and a STEP, and capped per run and
 * per delegation. The host (Stadeum; Hive on the swarms) mints, once per
 * person and deployment, a long-lived delegation for the agent `strut-agent`
 * and pushes it here with that person's virtual key and the gateway URL.
 * Before each LLM call strut extends it with a link that names the run and
 * its cap and one that names the step, and hands `{ apiKey, baseUrl,
 * headers }` to core's `llmAuth` seam (llm.ts). The gateway verifies the
 * chain and bills the LAST agent name — the step.
 *
 * Two formats, picked by the delegation's `v`:
 * - **v2** (gatekey 1.x, Stadeum's mothership gateway): a chain of signed
 *   blocks plus a proof key. The delegation is two blocks, the org's grant
 *   to the person and the person's to `strut-agent`, and its proof is the
 *   private half of strut's key. `attenuate` signs each new block with it
 *   and hands on a fresh key, so a holder can append but never drop a
 *   block. Every block's limits apply at the gateway: nothing narrows.
 * - **v1** (gatekey 0.x, stakgraph's gateway on the swarms): keyless HMAC
 *   links that must narrow the parent's. src/mothership-v1.ts, to delete
 *   when the swarms retire.
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
import type { Caveats, Token } from "gatekey";
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

/** What the host pushes for one person, plus what strut copies out of the
 *  macaroon on `PUT` so listing is one decrypt per entry. */
export interface Delegation {
  /** The base64url macaroon, as the host minted it (strut appends its own links). */
  macaroon: string;
  /** Its format. Absent: stored before v2, so v1. */
  v?: 1 | 2;
  /** The run id of the person's grant to strut — the gateway's key for this
   *  person's cumulative strut spend and its kill switch. */
  delegationId: string;
  /** The person's virtual key and the gateway root. */
  apiKey: string;
  baseUrl: string;
  /** The earliest expiry in it. */
  exp: string;
}

export interface DelegationSummary {
  actor: string;
  exp: string;
  delegationId: string;
  /** The macaroon's format, so the host can re-mint an old one. */
  v: 1 | 2;
}

export interface DelegationStore {
  get(actor: string): Promise<Delegation | undefined>;
  put(actor: string, d: Delegation): Promise<void>;
  delete(actor: string): Promise<boolean>;
  /** What the host's reconciler diffs against — never the macaroon or key. */
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
        if (d) out.push({ actor, exp: d.exp, delegationId: d.delegationId, v: d.v ?? 1 });
      }
      return out;
    },
  };
}

// ── Opening a delegation ───────────────────────────────────────────────────

/** What a link strut appends says. */
export interface LinkCaveats {
  runId: string;
  /** The agent it is billed as; none for a run's own link (billed as `strut-agent`). */
  agent?: string;
  capUsd: number;
  iat: string;
  exp: string;
}

/** A chain strut can extend: the delegation, a run's link, a step's. */
export interface Link {
  /** A new link under this one; this one is unchanged. */
  extend(c: LinkCaveats): Link;
  /** The `x-macaroon` header value. */
  encode(): string;
}

/** A delegation, decoded and checked. */
export interface OpenDelegation {
  v: 1 | 2;
  delegationId: string;
  /** The earliest expiry in it. */
  exp: string;
  /** The most the person lets strut spend in all. */
  ceilingUsd: number;
  root: Link;
}

/** Decodes a delegation and checks its SHAPE, by its `v`. Signatures cannot
 *  be checked here (strut has no org pubkey; the gateway is the verifier):
 *  this catches the wrong kind of macaroon — one already extended, minted
 *  for another agent, or with no ceiling. */
export async function openDelegation(encoded: string): Promise<OpenDelegation> {
  let v: unknown;
  try {
    v = (JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { v?: unknown } | null)?.v;
  } catch (err) {
    throw new Error(`macaroon does not decode: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (v === 2) return openV2(encoded);
  if (v === 1) return (await import("./mothership-v1.js")).openV1(encoded);
  throw new Error(`macaroon v=${String(v)}; expected 1 or 2`);
}

async function openV2(encoded: string): Promise<OpenDelegation> {
  const gk = await import("gatekey");
  const t: Token = gk.decodeToken(encoded);
  if (!Array.isArray(t.blocks) || t.blocks.length !== 2) {
    throw new Error("a delegation must be two blocks, the org's grant and strut's — strut appends its own");
  }
  const [grant, own] = t.blocks.map((b) => (b?.caveats ?? {}) as Partial<Caveats>) as [Partial<Caveats>, Partial<Caveats>];
  if (!grant.user_id) throw new Error("block 0 must name the person (user_id)");
  if (own.agent !== STRUT_AGENT) throw new Error(`block 1 must hand the run to agent "${STRUT_AGENT}"`);
  if (typeof own.max_cost_usd !== "number" || !(own.max_cost_usd > 0)) {
    throw new Error("block 1's max_cost_usd (the delegation ceiling) must be a positive number");
  }
  if (typeof own.run_id !== "string" || !own.run_id) throw new Error("block 1 must carry a run_id (the delegation id)");
  for (const [i, c] of [grant, own].entries()) {
    if (typeof c.exp !== "string" || !Number.isFinite(Date.parse(c.exp))) throw new Error(`block ${i}'s exp is not a timestamp`);
  }
  // Without the private half of block 1's key strut could append nothing.
  const key = t.blocks[1]!.next_key;
  let proofOk = false;
  try {
    proofOk = gk.bytesToHex(gk.publicKeyBytes(key.alg, gk.hexToBytes(t.proof))) === key.key;
  } catch {
    /* not hex, or not a key */
  }
  if (!proofOk) throw new Error("the delegation's proof is not the private key of block 1's next_key");

  const nonce = () => randomBytes(16).toString("hex");
  const link = (t: Token): Link => ({
    extend: (c) =>
      link(gk.attenuate(t, { run_id: c.runId, ...(c.agent ? { agent: c.agent } : {}), max_cost_usd: c.capUsd, iat: c.iat, exp: c.exp, nonce: nonce() })),
    encode: () => gk.encodeToken(t),
  });
  return {
    v: 2,
    delegationId: own.run_id,
    exp: Date.parse(grant.exp!) <= Date.parse(own.exp!) ? grant.exp! : own.exp!,
    ceilingUsd: own.max_cost_usd,
    root: link(t),
  };
}

/** What `PUT /llm/delegations/:actor` checks before storing a delegation:
 *  its shape (`openDelegation`), and that it has not expired. */
export async function checkDelegationMacaroon(
  encoded: string,
  now: Date = new Date(),
): Promise<{ v: 1 | 2; delegationId: string; exp: string; ceilingUsd: number }> {
  const { v, delegationId, exp, ceilingUsd } = await openDelegation(encoded);
  if (Date.parse(exp) <= now.getTime()) throw new Error(`the delegation expired at ${exp}`);
  return { v, delegationId, exp, ceilingUsd };
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

/** A grant's cap when `STRUT_GRANT_MAX_COST_USD` sets none (the owner's call,
 *  2026-11-20: $10 was too low for many tasks; settable from the box's admin
 *  later). A person's delegation ceiling lowers it (`grant`). */
export const DEFAULT_GRANT_CAP_USD = 1000;

/** The longest a grant lives: a key for a machine outside strut is short-lived
 *  (a pod lives 8 hours on Lambda), and the host refuses a longer one. */
export const MAX_GRANT_HOURS = 24;

/** A grant's cost cap: `STRUT_GRANT_MAX_COST_USD`, else $1000. Anything that is
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
  link: Link;
  capUsd: number;
  exp: string;
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
  /** `now + 8h` (or `ttlMs`), or the parent's own exp string when that is
   *  sooner. v1's verifier compares exps as strings, so the parent's is
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
  /** The cap for a run. v1's gateway refuses a link above the delegation's
   *  ceiling, so there fail here, loudly. v2 has no such rule: the
   *  delegation's own block stops the spend at its ceiling. */
  const capOrThrow = (workflowCap: number | undefined, o: OpenDelegation, principal: string, runCap?: number) => {
    const cap = resolveRunCap(workflowCap, bootEnv(), opts.runCapDefault ?? DEFAULT_RUN_CAP_USD, runCap);
    if (o.v === 1 && cap > o.ceilingUsd) {
      throw new Error(`workflow cap $${cap} exceeds the delegation ceiling $${o.ceilingUsd} for ${principal} — lower the cap or re-authorize with a higher ceiling`);
    }
    return cap;
  };
  const sweep = (nowMs: number) => {
    for (const [k, v] of runLinks) if (v.expMs <= nowMs) runLinks.delete(k);
  };

  async function runLink(ctx: LlmAuthContext, o: OpenDelegation, principal: string, now: Date): Promise<RunLink> {
    const runId = ctx.runId!;
    const cached = runLinks.get(runId);
    if (cached && cached.delegationId === o.delegationId && cached.expMs - now.getTime() > RELINK_BEFORE_MS) return cached;
    if (!workspace) throw new Error("createMothership: call mount(strut) before running workflows");
    const meta = ctx.workflow ? await workspace.getWorkflowMetadata(ctx.workflow).catch(() => null) : null;
    // A public run carries a cap of its own (plans/paid-runs.md §7): the
    // link carries the smaller of it and the workflow's.
    const capUsd = capOrThrow(meta?.maxRunCostUsd, o, principal, ctx.maxCostUsd);
    const exp = expFor(now, o.exp);
    const link = o.root.extend({ runId, capUsd, iat: now.toISOString(), exp });
    sweep(now.getTime());
    const entry = { link, capUsd, exp, expMs: Date.parse(exp), delegationId: o.delegationId };
    runLinks.set(runId, entry);
    return entry;
  }

  const llmAuth: LlmAuth = async (ctx) => {
    const principal = ctx.principal;
    const now = clock();
    const d = await delegationFor(principal, "this LLM call", now);
    if (!d || !principal) return undefined;
    const o = await openDelegation(d.macaroon);
    const iat = now.toISOString();
    let chain: Link;
    let sessionId: string;
    if (ctx.kind === "chat") {
      // One link off the delegation: billed as the assistant, one gateway
      // run per turn, capped at the env/default (no workflow to override it).
      const capUsd = capOrThrow(undefined, o, principal);
      chain = o.root.extend({ runId: `${ctx.chatId}.${ctx.turn ?? 0}`, agent: STRUT_ASSISTANT, capUsd, iat, exp: expFor(now, o.exp) });
      sessionId = ctx.chatId ?? "chat";
    } else {
      if (!ctx.runId) throw new Error("mothership: a step call needs a runId");
      const run = await runLink(ctx, o, principal, now);
      // The step link restates the run's id and cap (one counter at the
      // gateway) and names the step — the last name is what gets billed.
      chain = run.link.extend({ runId: ctx.runId, agent: stepAgentName(ctx.stepPath ?? ""), capUsd: run.capUsd, iat, exp: run.exp });
      sessionId = ctx.workflow ?? "";
    }
    return {
      apiKey: d.apiKey,
      baseUrl: d.baseUrl,
      headers: {
        "x-macaroon": chain.encode(),
        "x-bf-dim-session-id": sessionId,
        // Every strut lineage starts at strut-agent; sent as a plain dim so the
        // Mothership UI can fold strut's steps under one node from day one.
        "x-bf-dim-root-agent": STRUT_AGENT,
      },
      explainError: (err) =>
        explainExhausted(err, d, principal, o.ceilingUsd) ?? explainRefused(err) ?? explainUnrouted(err, ctx.provider),
      // A provider this gateway does not hold (a Numes nobody set up on it)
      // is called directly — unless every call must be billed here.
      direct: !required(),
    };
  };

  // ── Grants: model calls for a machine outside strut ──────────────────────
  // (stakwork/pods PLAN.md §3.2.) A link of the grant's own off the person's
  // delegation — its own run id, so the gateway caps its spend apart from any
  // run's, and its own expiry — then the host makes a virtual key under the
  // person's gateway customer and joins the two. On v2 the link binds whoever
  // holds the key: a chain cannot be shortened. On v1 it does not (dropping
  // it leaves the person's whole delegation), so the host is sent the cap and
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
    const o = await openDelegation(d.macaroon);
    // Never above the person's ceiling (v1's gateway would refuse the link;
    // on v2 the ceiling binds anyway): a person whose spending limit is under
    // the cap still gets a grant.
    const capUsd = Math.min(resolveGrantCap(), o.ceilingUsd);
    const exp = expFor(now, o.exp, hours * 3600_000);
    const macaroon = o.root.extend({ runId: `grant-${nonce()}`, agent: name, capUsd, iat: now.toISOString(), exp }).encode();
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

    // What the host's reconciler diffs against: actors, expiries, delegation ids, formats.
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
      const { v, delegationId, exp } = checked;
      await delegations.put(actor, { macaroon, v, apiKey, baseUrl: baseUrl.replace(/\/+$/, ""), delegationId, exp });
      return c.json({ actor, exp, delegationId, v });
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
