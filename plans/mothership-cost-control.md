# Mothership cost control — per-step and per-workflow LLM spend

> **Status (2026-09-22): proposed, revision 2, audited against all four
> codebases.** Nothing built. Spans four repos: strut, hive, stakgraph
> `mcp` (the host that embeds strut at `/lab`) and stakgraph `gateway`
> (the "Agent Mothership": Bifrost + our macaroon plugin). The gateway
> needs **no changes** for v1 — every gateway citation below was re-read
> on `stakgraph@8989934a`. Hive citations are `hive@5525f68b0`; the
> issuer (§4.2) was re-read on `hive@7cd0c2a40`.
>
> **What changed in revision 2.** Revision 1 gave strut its own ed25519
> key and had hive's org key sign a second UA per user binding that user
> to strut's key. This revision replaces it with a **standing
> invocation**: hive mints one long-lived macaroon per user, signed with
> the *user's* key exactly as every macaroon is today, and strut only
> attenuates. No strut key, no second UA, no new issuer code in hive,
> and nothing in strut changes when user keys move off hive. Rationale
> under "Why the delegation is sound".

## Problem

Strut's LLM calls go straight to the provider with a deployment-wide key. The
`agent` step reports its own cost in its output, the `llm` step reports
nothing, chat turns log tokens to the console. Nobody can answer "what did
this step cost over the last 24 hours", "what did this workflow cost", or
"which person is this spend for" — and nothing can cap any of it.

The Mothership already answers exactly those questions for hive's agents:
spend by agent name, user, session and run over a rolling window, windowed
caps per agent name, per-run caps, kill switches. Hive gets there by minting a
macaroon per call site and handing `{apiKey, baseUrl, headers}` downstream.
It hands strut nothing, and strut has no notion of a user at all.

Two things make strut different from hive's other agents:

- **Steps are dynamic.** Hive's agent names are a static list. We want spend
  per *step of a workflow*, and workflows are authored at runtime.
- **Runs are unattended.** A scheduled run fires with no person present, so
  there is no moment at which hive could mint a short-lived macaroon for it.

## Decided

| Question | Decision |
| --- | --- |
| Step attribution | **The step IS the agent name.** Strut narrows its macaroon per step, appending `<workflow>.<step>` to the `agents` lineage. The gateway bills the last entry, signature-bound — not a self-reported tag |
| Workflow attribution | `x-bf-dim-session-id: <workflow>`. Already filterable and groupable in the gateway; no gateway change |
| Who signs | **Session delegation.** Hive mints, once per user and deployment, a UA plus a **standing invocation** — org key and user key, exactly as every hive macaroon is signed today — living 60 days, `agents: ["strut-agent"]`, and pushes the macaroon to strut. Strut appends keyless HMAC links per run and per step. **Strut holds no signing key.** No strut → hive callback, ever |
| How strut gets it | **Hive pushes**, at moments it already calls strut with the user present (embed URL, chat dispatch, benchmark run) |
| Renewal | Both layers live 60 days; a **hive reconciler cron re-mints inside the last 15**. Phase 1: the user's custodial key signs, no user present. Phase 2 (user-held keys): the same mint needs one device signature every ~45 days — that is the point of phase 2, not a gap |
| Delegation ceiling | The standing invocation's `max_cost_usd` is a **cumulative cap on everything that user spends through strut**, enforced by the gateway on the delegation's own run id. Default **$10,000**, hive-side `STRUT_DELEGATION_MAX_COST_USD`. Alerting as it nears is later UX |
| Automations | **The workflow owner pays** |
| Grouping in the Mothership UI | One root. Strut sends `x-bf-dim-root-agent: strut-agent` on every call so its steps can be grouped under one node (UI work, later). Chat is billed as the leaf `strut-assistant` under that root |
| Users in strut | An **opaque `actor` string**. Strut stores and forwards it; it never interprets it. No accounts, no login. The host says who it is: `createStrut({ resolveActor(c) })` |
| Strut core | Knows two generic hooks: `llmAuth(ctx) → {apiKey, baseUrl, headers}` and `resolveActor(c) → string \| undefined`. Macaroons live in one opt-in module, `src/mothership.ts` |
| Where delegations live | A **second `FileSecretStore` instance** writing `mothership.json` beside `secrets.json` — same encryption, never on the services bag, never in the Secrets list. The value is the macaroon itself plus the user's virtual key |
| Windowed quotas | Gateway-side, keyed by name and user — `agent_budgets` (per step, `1d`/`1w`) and the Bifrost customer budget (per user, daily). Independent of token lifetime |

## Design in one paragraph

Hive signs, once per user and deployment, a macaroon that says "user U may
run agent `strut-agent`, up to $10,000, until exp" — an org-signed UA plus a
user-signed invocation whose `run_id` names the delegation — and pushes it
to strut with that user's virtual key and the gateway URL. When a run
starts, strut picks the **principal** (the person who launched it, else the
workflow's owner) and appends one keyless HMAC link for the run: its id,
its cap, eight hours. Before each `agent`/`llm` step it appends a second
link that adds the step's name to the agent lineage. The model client is
built with the gateway as `baseUrl`, the virtual key as `apiKey`, and
`x-macaroon` + `x-bf-dim-session-id` as headers. The gateway verifies the
chain, bills the call to (user, step, workflow, run), enforces the run's
cap and the delegation's ceiling, and whatever windowed caps the operator
configured. Everything upstream of `resolveModel` is unchanged; with no
delegation on file, strut calls providers directly, as today.

## Why the delegation is sound

The protocol has three layers and three nouns: the org authorizes a user,
the user signs an invocation, the invocation attenuates to sub-agents by
HMAC (`gateway/auth/README.md`). There is no "session" or "delegation"
object. `plans/cryptographic-identity.md` says a session or an overnight
workflow *is* an invocation with longer caveats, and lists "per-session —
one signature covers a session's worth of invocations, attenuated
thereafter via HMAC" (`:485`) and "Yubikey + session delegation — user
touches device once per login, software key signs invocations after"
(`:471`) as intended custody modes. The standing invocation is exactly
that, and strut is the software that acts after — except it needs no key,
because attenuation is keyless.

What this buys over a strut-held key (revision 1):

- **No fourth key.** The identity doc's rule is "no platform-held signing
  key, no system identity" (`:81`). A strut key bound to a user id by an
  org signature is precisely that, laundered through a UA that claims to
  be the user's.
- **Nothing in strut changes when key custody moves.** Phase 2 replaces
  hive's custodial user key with the user's device (`:515-522`); the
  standing invocation is then device-signed and strut attenuates the same
  bytes the same way. With a strut key, phase 2 would still need the org
  to re-bind each user to strut, and phase 3 (org multisig) would turn
  that into a signing ceremony per user per 60 days.
- **The user signs the sentence.** "strut may spend up to $10,000 on my
  behalf until this date" — one key touch, one ceiling, one expiry, one
  revocation handle.

**What the delegation's `run_id` does.** Every invocation carries a
`run_id` (required wire field). The accumulator charges every distinct run
id in the chain, leaf and ancestors (`accumulator.go:59`), and the cap walk
enforces every layer (`capwalk.go:22`). So with the delegation as the
parent run: `cost:run:<delegationId>` sums every strut call for that user
and the ceiling caps it; `kill:<delegationId>` halts every strut run for
that user at once (`revocation.go:31`); `meta:run:<strutRun>` carries a
`parent` link to the delegation so the operator UI can walk up
(`accumulator.go:35`). An empty `run_id` would skip all of that — both
walks drop the layer (`capwalk.go:220`, `accumulator.go:244`) and nothing
validates the field today — but that is an unvalidated gap, not a feature,
and a non-empty check is the obvious hardening. We use a UUID.

**Residual risk:** the stored macaroon is a bearer credential. Whoever
reads it can spend as that user through `strut-agent` until exp,
revocation, or the ceiling. Same file, same encryption, same blast radius
as revision 1 (which needed the UA *and* the key from the same file).
Bounded by the ceiling and the user's daily customer budget.

## 1. The seam in strut core (`src/llm.ts`)

aieo already accepts `apiKey`, `baseUrl` and `headers` (`resolve.ts`), and
`getModel` turns a gateway root into the per-provider path
(`gatewayUrlFor`, `provider.ts:617`). Strut just does not forward them.

```ts
export interface LlmAuthContext {
  kind: "step" | "chat";
  provider: Provider;
  runId?: string;   chatId?: string;
  workflow?: string; stepPath?: string;   // ctx.path, e.g. "digest/loop#3/summarize"
  actor?: string;
}
export type LlmAuth = (ctx: LlmAuthContext) =>
  Promise<{ apiKey?: string; baseUrl?: string; headers?: Record<string, string> } | undefined>;
```

`createStrut({ llmAuth })` puts it on the standard services bag;
`resolveModel` gains `auth?: LlmAuthContext`, calls the hook when both exist,
and forwards the result to aieo. `undefined` from the hook means "call the
provider directly". The three call sites pass their context:
`steps/core/agent.ts:933`, `steps/core/llm.ts:60`, `createStrut.ts:1685`
(the chat turn).

- **Provider before hook.** `ctx.provider` must be known when the hook
  runs, but today the provider is only resolved inside `aieo.resolveModel`.
  Call aieo's keyless `canonicalModelName(model, provider)` first, hand its
  provider to the hook, then `aieo.resolveModel` with the hook's result.
  The hook returns the gateway **root**; aieo's `getModel` appends the
  per-provider path (`gatewayUrlFor`), all five providers covered.
- **Web tools need no change.** `createWebTools` builds an anthropic
  client only to construct the native `web_search`/`web_fetch` tool
  *definitions*; the request itself rides the model client, which now
  carries the gateway URL and headers.

This step is useful alone: a static hook returning the gateway URL and a
virtual key routes all strut spend through the Mothership, untagged.

## 2. Actors and the principal

- **Request → actor: `createStrut({ resolveActor(c) })`.** The host
  decides, per request, who the actor is — strut never reads a header it
  did not ask for. Two reasons a plain `x-strut-actor` header rule cannot
  work: strut's run and chat routes are **not** behind `requireApiKey`
  (only steps/secrets/automations/claims are), and embed requests carry
  the mcp JWT, not the deployment key — so "honored only with the
  deployment key" would honor nothing from the UI, and with
  `STRUT_API_KEY` unset (dev) it would honor anything. The hook takes the
  Hono context and returns the actor or `undefined`.
  - Standalone `server.ts`: default hook reads `x-strut-actor` iff
    `apiKeyMatches(authorization)` **and** a key is configured.
  - mcp: see §5 — the actor comes from the verified JWT's `sub`, or from
    hive's `x-strut-actor` on an `x-api-token` call.
- **Stamps.** `WorkflowMetadata.owner` — set by the first publish that
  carries an actor (so today's ownerless workflows are adopted by whoever
  edits them next), then changed only by an explicit transfer
  (`PUT /workflows/:name/owner`). Distinct from `publisher`, which is a
  *service* stamp.
  `actor` on `run.start` / `RunSummary` / `RunOptions`, carried like
  `automation`. `ChatMeta.actor`. `StepContext.actor`.
- **Stamp the resolved principal too.** `run.start` records
  `principal` beside `actor` (they differ for an automation, or a run
  launched by someone who is not the owner). Resume and the verify pass
  read `principal` back from the log instead of re-deriving it — the
  owner may have changed since.
- **The actor string.** It is the macaroon `user_id`, built by hive's
  `buildBifrostName` (`reconciler.ts:676`): `{githubLogin}-{User.id}`,
  or the bare `User.id` when the user has no GitHub auth. Hive must use
  that one function everywhere it sets an actor (§4) — every hive caller
  today holds the raw `User.id`, which is not the same string. A GitHub
  rename changes it and would orphan `owner`; **deferred**, not a v1
  concern.
- **Principal rule** (who a run's spend is billed to):

| Trigger | Principal |
| --- | --- |
| HTTP / UI run | request actor, else workflow owner |
| Automation | workflow owner |
| Chat turn, and runs the builder launches | chat actor |
| Verify pass | the source run's principal |
| Subflow | same run, same principal |

No principal, or no delegation for it → direct provider keys, as today
(`STRUT_MOTHERSHIP_REQUIRED=1` makes it a step error instead).

## 3. `src/mothership.ts` (opt-in, lazy-imports `gatekey`)

`gatekey` is on npm (0.1.1; hive already depends on `^0.1.1`) and exports
what is needed: `decodeMacaroon`, `encodeMacaroon`, `invocationSigBytes`,
`attenuate`, `attenuationSigBytes`, and `verify` for tests. **Strut never
signs.** Source is `stakgraph/gateway/auth/ts`.

**Wiring.** `createMothership({ dataDir, store?, runCapDefault? }) →
{ llmAuth, mount(app) }`. The host passes `llmAuth` to `createStrut` and
calls `mount(strut.app)` to add the routes below (mutations behind
`requireApiKey`, which `auth.ts` exports). Core never imports the module.

**Store.** A `DelegationStore` interface owned by this module —
`get/put/delete(actor)`, `list() → {actor, exp, delegationId}[]` — with
one implementation over any `SecretStore`, defaulting to a **second
`FileSecretStore` instance** writing `dataDir/mothership.json`
(`FileSecretStore` gains an optional filename). Why a separate instance and
not a reserved prefix in the main store: the main store is on the services
bag, so any step — including an LLM-authored custom one — can
`ctx.services.secrets.get()` every user's macaroon and virtual key; a
prefix rule would have to be remembered by every present and future
`SecretStore` consumer. A separate file is hidden from the Secrets list by
construction. Same AES-256-GCM under `STRUT_SECRET_KEY`, no new crypto,
nothing new to back up. Names inside the file: `D_<hex(actor)>` (actors
carry `-`, which secret names refuse). The value is JSON `{ macaroon,
delegationId, apiKey, baseUrl, exp }` — `delegationId` is the standing
invocation's `run_id` and `exp` the earlier of the UA's and the
invocation's, both copied out on `PUT` so `list()` is one decrypt per
entry — dozens at most, daily. Nothing else lives in the file: a wiped
volume loses only the delegations, and hive's next push repairs it. Tests
inject a `MemorySecretStore`. Both mcp modes (fs and graph workspace) are
file-backed at `dataDir`, so the file survives restarts everywhere it
matters.

**Delegations.** `PUT /llm/delegations/:actor` with `{ macaroon, apiKey,
baseUrl }`. Strut decodes the macaroon and checks its shape — `v: 1`, an
`invocation`, an **empty** `attenuations` list, `agents` containing
`strut-agent`, `max_steps: 0`, a positive `max_cost_usd`, parseable `exp`s
— and rejects anything else with a 400. It cannot check signatures: it has
no org pubkey, and the gateway is the verifier. `GET /llm/delegations`
lists `{ actor, exp, delegationId }` and nothing else — what hive's
reconciler diffs against. `DELETE` removes one.

**Per run** (cached by `runId`; re-linked on resume or within an hour of
the link's exp — the gateway's `cost:run:<id>` is keyed by run id, so the
cap survives a re-link *while that key lives*: its TTL is the link's exp +
1h, floor 1h, ceiling 7d (`ttl.go:25`), so a run resumed more than ~9h
after its last call starts the cap from $0 again. Accepted for v1):

```ts
const run = attenuate(invocationSigBytes(m.invocation), {
  agents: ["strut-agent"], run_id: runId,
  max_cost_usd: runCap, max_steps: 0,
  exp: min(now + 8h, m.invocation.exp), nonce,
});
```

- An attenuation **replaces** the effective caveats, it does not inherit
  (`verify.go:315-322`): every field is restated, each ≤ its parent.
- **`max_steps: 0` — no call-count cap.** The gateway's "steps" are **LLM
  calls**, and a run's call count scales with loop iterations and tool-loop
  turns; no number is right for every workflow. Strut already bounds loops
  where the author can see them (the `agent` step's own `maxSteps`, default
  40). The narrowing check rejects a child value greater than its parent
  (`verify.go:351`), and any positive number is greater than the standing
  invocation's `0` — so every link restates `0`, which the gateway reads
  as "no cap" (`capwalk.go:41`).
- **`max_cost_usd` is the real run cap.** `runCap` resolves as: the
  workflow's `maxRunCostUsd` → `STRUT_RUN_MAX_COST_USD` → a built-in default
  of **$100**. The override lives on `WorkflowMetadata`, beside `category`
  and `automations`: it is operating policy, so changing it publishes no
  version and re-fires no checks. Only this module reads it — without the
  Mothership nothing enforces it, so the UI shows the field only when the
  module is enabled. **A resolved cap that is not a positive number is an
  error** — `0` would mean "uncapped" to the gateway, and that must never
  happen by way of an empty env var. **A cap above the delegation's
  ceiling is also an error** — the gateway would reject the link
  (`verify.go:347`, `ErrAttenuationWidened`), so strut checks first and
  fails the step with "workflow cap $X exceeds the delegation ceiling $Y".
  Never clamp silently.
- **`exp`: 8h**, for strut's own reason: the header is fixed when a step
  builds its model client, so the link must outlive the longest single
  step. It does not bound the run — strut re-links. It must be ≤ the
  standing invocation's exp (`verify.go:357`), so links get shorter in the
  delegation's last hours; the reconciler's 15-day renewal window means
  nobody meets that.
- `agents` must include every parent entry (`verify.go:342`); the
  standing invocation has only `strut-agent`.
- **Timestamps are `toISOString()`.** The verifier orders `exp` values as
  strings (`verify.go:247`, `:357`), which only works for same-format
  RFC 3339 UTC — never hand-format one.

**Per step:** a second link off the run link:

```ts
attenuate(attenuationSigBytes(run), {
  agents: ["strut-agent", stepAgentName(ctx.path)],
  run_id: runId, max_cost_usd: runCap, max_steps: 0,   // restated
  exp: run.caveats.exp, nonce,
});
```

- **Same `run_id` as the run link.** The gateway dedupes chain layers by
  `run_id`, leaf first (`capLayers`, `capwalk.go:205-225`), so the enforced
  chain is [run, delegation]: the run's cap and the ceiling. The step
  link's `max_cost_usd` is the one enforced for the run — restate the same
  `runCap`, not a placeholder.
- `stepAgentName`: per path segment drop the `#n` iteration suffix
  **and** the `NNN-` tool-call prefix, then join with `.` →
  `digest.loop.summarize`. The prefix matters: a step granted as an
  agent's tool runs at `<agent>/003-llm` with a per-call counter
  (`agent.ts:638`), and without stripping it every call would be its own
  agent name. **Never `/`** — the gateway's `/_plugin/agents/<name>/spend`
  routes split the path on it (`server.go:353`). Workflow names are not
  validated on publish (step names are, `workspace.ts:986`), so the
  function also maps anything outside `[A-Za-z0-9_.-]` to `_`.
- Step names need not be in the UA: attenuation may add names freely
  (`narrowAttenuation` checks child ⊇ parent, never against the UA).
- On the wire: UA + invocation + two links per call. Trivial.
- v1 keeps the step link on the run's own `run_id`: one strut run is one
  gateway run, steps are told apart by agent name.

**Chat:** one link off the invocation, `agents: ["strut-agent",
"strut-assistant"]`, `run_id: <chatId>.<turn>`, same `max_steps: 0`, cap =
the env fallback (a chat has no workflow to override it), `session-id:
<chatId>`. Billed as `strut-assistant` — the last entry — under the same
root as everything else.

**Ceiling exhaustion.** When `cost:run:<delegationId>` reaches the ceiling,
every call gets a 402 `run_cost_exceeded` whose message names the
*delegation's* run id, not the strut run's (`capwalk.go:126`). Strut
recognises its own delegation id in that message and fails the step with
"authorization for <actor> is exhausted — re-authorize from hive", not
"run over cap". The counter's TTL is 7d, refreshed on every write
(`ttl.go:25`, `accumulator.go:48`): a delegation idle for a week restarts
from $0. Accepted for v1 — the ceiling is a backstop, not an accounting
truth, and the daily customer budget is the tight bound.

**Returned to the hook:** `apiKey` = the virtual key, `baseUrl` = gateway
root, headers `x-macaroon`, `x-bf-dim-session-id: <top-level workflow>` and
`x-bf-dim-root-agent: strut-agent`.

**Why `root-agent` and not a `strut.` name prefix.** Strut adds many agent
names to a list that holds hive's dozen, and the Mothership UI will want to
fold them under one node. The grouping key already exists, signature-bound:
every strut lineage starts with `strut-agent`. The gateway just logs only
the leaf. Sending the root as a plain dim costs nothing, lands in the log
from day one, and leaves step names clean; when the gateway later stamps
`root-agent` from the verified claims, it overwrites with the same value and
the history is already groupable. A prefix baked into names cannot be undone
without splitting that history.

## 4. Hive

1. `services/bifrost/agent-names.ts:12`: add `strut-agent`,
   `strut-assistant` to `BIFROST_AGENT_NAMES`. `DEFAULT_AGENT_SPECS` in
   `agent-catalog.ts:79` is `Record<BifrostAgentName, …>`, so both need a
   spec or hive does not compile; the catalog re-seeds every swarm on its
   next `getBifrostForLLM` (hash on `Swarm.bifrostAgentsSeedHash`).
   `BIFROST_ENABLED_AGENTS` is a default-open env CSV — only a deployment
   that sets it explicitly needs the two names added. Side effect: the
   names also surface in the prompts-UI agent dropdowns
   (`lib/utils/hive-agent.ts` derives from the list); acceptable.
2. **No new issuer code.** `mintInvocationMacaroon`
   (`macaroon-issuer.ts:154`) already takes `runId`, `maxCostUsd`,
   `maxSteps` and `ttlSeconds` (`:161-164`) with no ceiling on the TTL,
   and mints UA + invocation with the same lifetime and
   `agents: [agentName]` on both. The standing invocation is one call:

   ```ts
   const minted = await mintInvocationMacaroon({
     workspaceId, userId,
     agentName: "strut-agent",
     maxCostUsd: STRUT_DELEGATION_MAX_COST_USD,  // 10_000; env-overridable
     maxSteps: 0,                                // 0 survives the destructuring default
     ttlSeconds: STRUT_DELEGATION_TTL_SECONDS,   // 60 days
   });
   // minted.token → the macaroon; minted.runId → delegationId; minted.expiresAt → exp
   ```

   Two new constants in `constants.ts`, the ceiling read from
   `STRUT_DELEGATION_MAX_COST_USD` when set. Org key path unchanged:
   workspace → `sourceControlOrgId` → `ensureMacaroonOrgKeys`. Phase 2
   changes the inside of this function (a device signs the invocation),
   not its callers.
3. Push it from `strut/embed-url/route.ts`, `strutTools.ts` (chat dispatch)
   and the workflow-benchmark route
   (`api/workspaces/[slug]/workflow-benchmarks/run/route.ts:416`):
   `GET /llm/delegations`, skip if the stored one has more than half its
   life left, else mint and `PUT { macaroon, apiKey, baseUrl }`. A failed
   push never blocks the embed. The push is **more than the macaroon**: it
   also needs the user's virtual key and the gateway URL, and the swarm
   must already trust the org and hold the catalog — today all of that
   only happens inside `getBifrostForLLM` (`orchestrator.ts:93`). So the
   push runs behind the same gates (`BIFROST_ENABLED`, workspace + user
   present, not the public viewer) and calls the same trust-register /
   catalog-seed / `reconcileBifrostVK` building blocks first. Two
   `reconcileBifrostVK` traps: it throws when the user has no
   `WorkspaceMember` row (owners only get one lazily via `/access`), and
   it ignores `leftAt`. Note `strutTools.ts` also runs with no live session
   (`api/cron/automations`, `canvas-strut-autoturn`) — the user is
   attributed, not present; the push still works in phase 1, the custodial
   key signs.
4. Actor: `POST /mint-token` body gains `sub: buildBifrostName(userId,
   login)`; server-side calls send `x-strut-actor` with the same value. The
   actor string **must equal** the macaroon `user_id` so strut's spend
   merges with the user's other spend (§2). A second `/mint-token` caller
   exists (`stakgraph-sessions/embed-url/route.ts:50`) — `sub` stays
   optional.
5. **Reconciler** — `api/cron/strut-delegations`, daily, in the shape of the
   other 22 cron routes (`GET`, `Bearer ${CRON_SECRET}`, a `*_ENABLED`
   kill-switch, `vercel.json` entry). Desired state lives on
   `WorkspaceMember`, which already holds the pushed-to-gateway VK fields
   (`bifrostVkValue`, `bifrostSyncedAt`, …): add `strutDelegationExp` and
   `strutDelegationId`. **Never the token** — hive keeps no copy of a
   bearer it may not be able to re-mint in phase 2. Per workspace the cron
   reads `GET /llm/delegations`, then re-mints and `PUT`s any row that is
   **missing or within 15 days of exp** (a wiped strut volume heals here,
   with nobody visiting). Leaving a workspace is a **soft delete** (`leftAt`
   set by `removeWorkspaceMember`, `services/workspace.ts:1354`; nothing
   revokes any Bifrost state today), so the cron `DELETE`s the delegation
   for every member with `leftAt` set and clears the two columns.
   `kill:<strutDelegationId>` is the operational stop for one user's strut
   activity (1h, renewable); a permanent targeted revoke needs the
   invocation nonce and is later work. So the 60-day exp is a backstop for
   hive being down, not a thing people ever meet.

## 5. mcp (the host)

Bump strut (a git dep pinned to a SHA, `package.json:83` — one merge
behind strut main today); `createLabStrut.ts:101` builds the module and
passes `llmAuth` + `resolveActor`, then `mount`s its routes.

- **`/mint-token`** (`src/index.ts:183`) reads only `expires_in` today and
  `signApiToken` (`repo/events.ts:57`) signs `{ scope: "api" }`. Add an
  optional `sub` to both. `isEmbedJwt` in `lab/mount.ts` returns a boolean
  and discards the payload — make it return the payload.
- **`labAuth` cannot set a header for strut.** The mount is
  `app.use("/lab", labAuth, bridge(labStrut))` where `bridge` is
  `@hono/node-server`'s `getRequestListener`, which builds the Hono
  `Request` from `incoming.rawHeaders` — writes to `req.headers` are
  invisible. So `labAuth` stashes the actor on `req`, and
  `resolveActor(c)` reads it back through `c.env.incoming` (the listener
  passes `{ incoming, outgoing }` as Hono's env). No header rewriting.
- **Per credential:** JWT → `sub`. `x-api-token` (hive server-to-server)
  → hive's own `x-strut-actor` header, trusted because the token proves
  it is hive. Basic auth → no actor. The dictation WebSocket path
  (`mount.ts:164`) bypasses Express and needs no actor.
- **Where the file lives.** `createLabStrut` passes `workspacePath`
  (`STRUT_LAB_WORKSPACE`, else `./lab-workspace`) as strut's `dataDir` in
  both workspace modes (`createLabStrut.ts:152`), so `mothership.json`
  sits beside `secrets.json` there. sphinx-swarm already binds that path
  to the named volume `<image>-lab-workspace` (`repo2graph.rs:170-182`),
  precisely so run data survives container recreation. Nothing new to
  mount.
- **`STRUT_SECRET_KEY` is not set anywhere** — not by sphinx-swarm, the
  mcp Dockerfile, or mcp itself — so `secrets.json` on that volume is
  encrypted with strut's fixed dev passphrase (`secret-store.ts:75`),
  obfuscated only. Not new (provider keys are in there today), but
  `mothership.json` adds every user's standing macaroon and virtual key.
  **Fix: at mcp boot, `process.env.STRUT_SECRET_KEY ??= process.env.API_TOKEN`**
  before `createLabStrut`. The passphrase is only scrypt input
  (`secret-store.ts:104`), so any string works, and `API_TOKEN` is already
  persisted per swarm. Anyone holding `API_TOKEN` is already full admin of
  the lab strut (they can register a step that reads any secret), so this
  raises the floor without adding a second secret to manage. Cost: rotating
  `API_TOKEN` makes both files unreadable — `mothership.json` self-heals
  (hive re-pushes), `secrets.json` needs its provider keys re-entered.
  Acceptable; the token effectively never rotates.

## 6. Reading it back

| Question | Gateway call |
| --- | --- |
| This step, last 24h | `GET /_plugin/agents/<wf>.<step>/spend?window=24h` |
| This workflow, last 24h | `GET /_plugin/sessions/<wf>/summary` or `/spend/by-session?session_id=<wf>` |
| A workflow's steps, ranked | `GET /_plugin/spend/by-agent?session_id=<wf>&window=24h` |
| A workflow's users | `GET /_plugin/spend/by-user?session_id=<wf>` |
| One run | `GET /_plugin/runs/<runId>` (`/state` for live cost + caps) |
| One user's strut authorization | `GET /_plugin/runs/<delegationId>` (`/state` for spent-of-ceiling) |

v1 reads these in the Mothership UI (hive's Gateway tab). Caps: a daily cap
per step is an `agent_budgets` entry; a per-run cap is the workflow's
`maxRunCostUsd` (§3); a per-user daily cap is the customer budget hive
already sets; a per-user lifetime-of-delegation cap is the ceiling.

## Non-goals (v1)

- **Enforced per-workflow caps.** `session-id` is observed, not capped.
- **Per-step caps per run.** Would need the step link on its own `run_id`.
- **Setting caps from strut.** `agent_budgets` is config-file only today
  (`/_plugin/agents/<name>/budget` is GET-only, `budgets.go:92`).
- **Spend badges in the strut UI.** Needs a read credential for `/_plugin/*`;
  the provisioning token is far too powerful to hand over.
- **Alerting as a delegation nears its ceiling.** The number is one read
  away (`/_plugin/runs/<delegationId>/state`); where to surface it is
  later UX.
- **Targeted revocation of one delegation.** Needs the invocation nonce
  stored hive-side; `kill:<delegationId>` and `revoke_user_before` cover v1.
- **Any user model in strut** beyond the opaque actor. **Non-LLM spend** (Exa).
- **Callbacks from strut to hive.**
- **Actor renames.** A GitHub login change alters `{login}-{id}` and
  orphans `owner`; a transfer endpoint exists for the manual fix. Deferred.
- **Cap continuity across a long pause.** `cost:run` expires ~9h after the
  last call (§3); a run resumed later restarts its cap. The delegation's
  counter likewise restarts after a week idle. Deferred.

## Step order

1. strut: the `llmAuth` seam (§1). Ship and test with a static hook.
2. strut: actor plumbing and the principal rule (§2).
3. strut: `src/mothership.ts` (§3).
4. hive: agent names, the push (calling `mintInvocationMacaroon`), the
   actor, the reconciler (§4).
5. mcp: bump, enable, `labAuth` (§5).
6. End-to-end check in shadow mode (below).
7. Later: mcp lab code that calls the AI SDK's default `anthropic()`
   singleton (env key + `ANTHROPIC_BASE_URL`, no per-call auth) bypasses
   all of this — `gitsee/steps/boot-and-exercise.ts:647,843`,
   `gitsee/services/vision.ts:35`, `gitsee/steps/verify-setup.ts:272`,
   `gitsee/steps/score-setup.ts:217`, `eval/steps/score.ts:76`,
   `eval/steps/reflect.ts:117`, plus `concepts/services.ts:84` and the
   `harvey` subprocess that inherits `ANTHROPIC_API_KEY`. Each moves to
   `resolveModel` with its step context. Also: a writable budget endpoint on
   the gateway; badges in the strut UI; ceiling alerts; the gateway
   stamping `root-agent` from verified claims and the Mothership UI folding
   strut's steps under one `strut-agent` node (→ workflows → steps).

## Validation

- **Unit:** a macaroon strut builds — a UA + standing-invocation fixture
  signed with fixture org and user keys, a run link, a step link — passes
  `gatekey`'s `verify` with the step as the billed agent and a three-layer
  chain that dedupes to two run ids; a link that widens `max_cost_usd`,
  drops `strut-agent`, carries a positive `max_steps` under a `0` parent,
  or outlives the invocation fails. `runCap` above the ceiling fails
  before any call, with both numbers in the message. A 402 naming the
  delegation id maps to the exhausted-authorization error; one naming the
  run id does not. Cap resolution: workflow override → env → default, and
  a non-positive result throws. `stepAgentName` never emits `/`, and
  `wf/agent/003-llm` → `wf.agent.llm`. Principal rule, one case per
  trigger; `principal` read back from `run.start` on resume. No delegation
  → the hook returns `undefined` and the provider is called directly. The
  delegation file is not visible through `ctx.services.secrets` or
  `GET /secrets`. `PUT` rejects a macaroon that already carries
  attenuations, lacks `strut-agent`, has a positive `max_steps`, or a zero
  ceiling. `resolveActor` returning `undefined` → no owner stamp, no actor
  on the run.
- **End to end** (gateway ships with `enforce_macaroons: false`, so this is
  safe to run against a live swarm): open strut from hive, run a workflow with
  two agent steps, then fire it from an automation. Both runs appear under the
  user; each step has its own `/agents/<name>/spend`; the session summary
  equals their sum; `/_plugin/runs/<delegationId>` equals the sum of both
  runs. **Shadow mode hides verification failures** — a bad chain is
  logged and let through, so also grep the plugin log for `FAIL` lines
  (`enforcement.go:301`) before calling the pass green.
- **Enforcement:** with the flags on, a run past `max_cost_usd` gets a 402
  `run_cost_exceeded` and the step fails with that message, not a retry
  loop. Then set `STRUT_DELEGATION_MAX_COST_USD` to a few dollars on a test
  workspace, re-push, run past it, and check the step fails with the
  exhausted-authorization message and names the actor.

## Open questions

- **A lapsed delegation.** With the reconciler, a delegation only goes away
  when hive removes it — the owner left the workspace. Should that owner's
  workflows then fail with "transfer ownership" (proposed: their spend has
  nobody to land on), or fall back to the deployment's direct keys?
- **Until the UI groups them:** unchecked whether the Mothership canvas copes
  with a few dozen agent names that are not in its catalog. Look at it in
  the end-to-end pass, before any workflow-heavy swarm turns this on.
