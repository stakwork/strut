# Mothership cost control — per-step and per-workflow LLM spend

> **Status (2026-09-21): proposed.** Nothing built. Spans four repos: strut,
> hive, stakgraph `mcp` (the host that embeds strut at `/lab`) and stakgraph
> `gateway` (the "Agent Mothership": Bifrost + our macaroon plugin). The
> gateway needs **no changes** for v1.

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
| Who signs | **Delegated user authorization.** Hive's org key signs a long-lived UA binding the hive `user_id` to **strut's own ed25519 key**. Strut signs a fresh invocation per run and narrows per step. No strut → hive callback, ever |
| How strut gets it | **Hive pushes**, at moments it already calls strut with the user present (embed URL, chat dispatch, benchmark run) |
| Renewal | UA lives 60 days; a **hive reconciler cron renews it inside the last 15**. Renewal needs no user — the org key signs, and the key bound is strut's |
| Automations | **The workflow owner pays** |
| Grouping in the Mothership UI | No name prefix. Strut sends `x-bf-dim-root-agent: strut-agent` so its steps can be grouped under one node (UI work, later) |
| Users in strut | An **opaque `actor` string**. Strut stores and forwards it; it never interprets it. No accounts, no login |
| Strut core | Knows only a generic hook: `llmAuth(ctx) → {apiKey, baseUrl, headers}`. Macaroons live in one opt-in module, `src/mothership.ts` |
| Windowed quotas | Gateway-side, keyed by name and user — `agent_budgets` (per step, `1d`/`1w`) and the Bifrost customer budget (per user, daily). Independent of token lifetime |

## Design in one paragraph

Hive signs, once per user and deployment, a certificate that says "whoever
holds strut's key may act as user U, for agents `strut-agent` and
`strut-assistant`, until exp", and pushes it to strut with that user's virtual
key and the gateway URL. When a run starts, strut picks the **principal** (the
person who launched it, else the workflow's owner), signs an invocation for
that run with its own key, and before each `agent`/`llm` step appends one
keyless HMAC link that adds the step's name to the agent lineage. The model
client is built with the gateway as `baseUrl`, the virtual key as `apiKey`,
and `x-macaroon` + `x-bf-dim-session-id` as headers. The gateway verifies the
chain, bills the call to (user, step, workflow, run), and enforces whatever
caps the operator configured. Everything upstream of `resolveModel` is
unchanged; with no delegation on file, strut calls providers directly, as today.

## Why the delegation is sound

A UA is a certificate: the org signs `{user_id, user_pubkey, agents, exp}`.
The gateway trusts the **org signature** (the org key is in its trust
registry) and takes the user's public key from the UA itself
(`auth/go/verify.go:205-213`); it keeps no independent record of user keys. So
the same `user_id` can hold two valid UAs — one bound to hive's per-user key,
one bound to strut's — like one person with SSH certs for two machines. Spend
from both lands under the same user; `revoke_user_before:<user_id>` kills both.

It is not a new kind of trust: hive already generates and holds every user's
private key and signs on their behalf. What changes is which box signs. The
pushed UA is useless without strut's private key, which never leaves strut.

**Residual risk:** a compromised strut box can spend as any user whose UA it
holds, until exp or revocation. Bounded by the agent list (two names) and the
user's daily customer budget.

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
`steps/core/agent.ts` (~933), `steps/core/llm.ts` (~60), `createStrut.ts`
(~1685, the chat turn).

This step is useful alone: a static hook returning the gateway URL and a
virtual key routes all strut spend through the Mothership, untagged.

## 2. Actors and the principal

- **Request → actor.** Header `x-strut-actor`, honored only on a request
  authenticated with the deployment key. The host sets it: mcp's `labAuth`
  copies it from the embed JWT's `sub` (and strips any client-sent value);
  hive's server-side calls send it beside `x-api-token`.
- **Stamps.** `WorkflowMetadata.owner` — set by the first publish that
  carries an actor (so today's ownerless workflows are adopted by whoever
  edits them next), then changed only by an explicit transfer
  (`PUT /workflows/:name/owner`). Distinct from `publisher`, which is a
  *service* stamp.
  `actor` on `run.start` / `RunSummary` / `RunOptions`, carried like
  `automation`. `ChatMeta.actor`. `StepContext.actor`.
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

**Key.** An ed25519 keypair, generated on first use, private half in the
secret store. `GET /llm/delegation-key → { alg: "ed25519", key }`.

**Delegations.** `PUT /llm/delegations/:actor` with
`{ orgId, userAuthorization, apiKey, baseUrl }` — stored in the secret store,
hidden from the Secrets list. `GET /llm/delegations` lists `{ actor, exp }`
and nothing else — what hive's reconciler diffs against. `DELETE` removes one. A wiped volume means a new key and dead UAs;
hive's next push repairs it, because it reads the key before every mint.

**Per run** (cached by `runId`; re-signed on resume or near exp — the
gateway's `cost:run:<id>` is keyed by run id, so the cap survives a re-sign):

```ts
signInvocation({ agents: ["strut-agent"], run_id: runId,
                 max_cost_usd: runCap, max_steps: 0, iat, exp, nonce }, strutPrivkey)
```

Hive's defaults are $100 / 2000 / 8h, sized for one coding-agent session. A
strut run is a different kind of thing, so each number is chosen on strut's
own terms — the dollar figure happens to land in the same place.

- **`max_steps: 0` — no call-count cap.** The gateway's "steps" are **LLM
  calls**, and a run's call count scales with loop iterations and tool-loop
  turns; no number is right for every workflow. Strut already bounds loops
  where the author can see them (the `agent` step's own `maxSteps`, default
  40). The field is required by the wire type, so it is sent as `0`, which
  the gateway reads as "no cap" (`capwalk.go:92`).
- **`max_cost_usd` is the real run cap.** `runCap` resolves as: the
  workflow's `maxRunCostUsd` → `STRUT_RUN_MAX_COST_USD` → a built-in default
  of **$100**. The override lives on `WorkflowMetadata`, beside `category`
  and `automations`: it is operating policy, so changing it publishes no
  version and re-fires no checks. Only this module reads it — without the
  Mothership nothing enforces it, so the UI shows the field only when the
  module is enabled. **A resolved cap that is not
  a positive number is an error** — `0` would mean "uncapped" to the gateway
  (`capwalk.go:89`), and that must never happen by way of an empty env var.
- **`exp`: 8h**, for strut's own reason: the header is fixed when a step
  builds its model client, so the macaroon must outlive the longest single
  step. It does not bound the run — strut re-signs.

**Per step:**

```ts
attenuate(invocationSigBytes(inv), {
  agents: ["strut-agent", stepAgentName(ctx.path)],
  run_id, max_cost_usd: runCap, max_steps: 0, exp, nonce,   // restated — see below
})
```

- An attenuation **replaces** the effective caveats, it does not inherit
  (`verify.go:315-322`): every field must be restated, each ≤ its parent.
- So the link **must restate `max_steps: 0`**: the narrowing check rejects a
  child value greater than its parent (`verify.go:349`), and any positive
  number is greater than 0.
- And it must restate the **same `runCap`**, not a placeholder. The gateway
  dedupes chain layers by `run_id`, leaf first (`capLayers`,
  `capwalk.go:216-225`); with the step on the run's own `run_id`, the
  **link's** `max_cost_usd` is the one enforced and the invocation's is
  shadowed.
- `stepAgentName`: drop `#n` iteration suffixes, replace `/` with `.` →
  `digest.loop.summarize`. **Never `/`** — the gateway's
  `/_plugin/agents/<name>/spend` routes split the path on it (`server.go:353`).
- v1 keeps the step layer on the run's own `run_id`: one strut run is one
  gateway run, steps are told apart by agent name.

**Chat:** `agents: ["strut-assistant"]`, `run_id: <chatId>.<turn>`, no
attenuation, `session-id: <chatId>`. Same `max_steps: 0`; the cap per turn is
the env fallback (a chat has no workflow to override it).

**Returned to the hook:** `apiKey` = the virtual key, `baseUrl` = gateway
root, headers `x-macaroon`, `x-bf-dim-session-id: <top-level workflow>` and
`x-bf-dim-root-agent: strut-agent` (`strut-assistant` for chat).

**Why `root-agent` and not a `strut.` name prefix.** Strut adds many agent
names to a list that holds hive's dozen, and the Mothership UI will want to
fold them under one node. The grouping key already exists, signature-bound:
every step's lineage starts with `strut-agent`. The gateway just logs only
the leaf. Sending the root as a plain dim costs nothing, lands in the log
from day one, and leaves step names clean; when the gateway later stamps
`root-agent` from the verified claims, it overwrites with the same value and
the history is already groupable. A prefix baked into names cannot be undone
without splitting that history.

## 4. Hive

1. `agent-names.ts`: add `strut-agent`, `strut-assistant` (plus the catalog
   seed and `BIFROST_ENABLED_AGENTS`).
2. `mintStrutDelegation({ workspaceId, userId, strutPubkey, ttlSeconds })` in
   `macaroon-issuer.ts` — the UA half of `mintInvocationMacaroon`, with
   `user_pubkey` = strut's key, both agent names, exp ≈ 60 days, no invocation.
3. Push it from `strut/embed-url/route.ts`, `strutTools.ts` (chat dispatch)
   and the workflow-benchmark runner: read the delegation key, skip if the
   stored UA has more than half its life left, else mint and `PUT`. Same
   `BIFROST_ENABLED` gates as `getBifrostForLLM`; a failed push never blocks
   the embed.
4. Actor: `POST /mint-token` body gains `sub: <macaroonUserId>`; server-side
   calls send `x-strut-actor`. The actor string **must equal** the macaroon
   `user_id` (`{githubLogin}-{User.id}`) so strut's spend merges with the
   user's other spend.
5. **Reconciler** — `api/cron/strut-delegations`, daily, in the shape of the
   other cron routes. Hive records a row per (workspace, user) it has pushed;
   that is the desired state. Per workspace the cron reads strut's
   delegation key and `GET /llm/delegations`, then re-mints and `PUT`s any
   row that is **missing, within 15 days of exp, or bound to an old key** (a
   wiped strut volume heals here, with nobody visiting). No user is needed:
   the org key signs. For a user who has **left the workspace** it does the
   opposite — `DELETE`s the delegation and drops the row. So the 60-day exp
   is a backstop for hive being down, not a thing people ever meet.

## 5. mcp (the host)

Bump strut; enable the module in `createLabStrut`; `/mint-token` accepts
`sub`; `labAuth` sets `x-strut-actor` from the verified JWT.

## 6. Reading it back

| Question | Gateway call |
| --- | --- |
| This step, last 24h | `GET /_plugin/agents/<wf>.<step>/spend?window=24h` |
| This workflow, last 24h | `GET /_plugin/sessions/<wf>/summary` or `/spend/by-session?session_id=<wf>` |
| A workflow's steps, ranked | `GET /_plugin/spend/by-agent?session_id=<wf>&window=24h` |
| A workflow's users | `GET /_plugin/spend/by-user?session_id=<wf>` |
| One run | `GET /_plugin/runs/<runId>` (`/state` for live cost + caps) |

v1 reads these in the Mothership UI (hive's Gateway tab). Caps: a daily cap
per step is an `agent_budgets` entry; a per-run cap is the workflow's
`maxRunCostUsd` (§3); a per-user daily cap is the customer budget hive
already sets.

## Non-goals (v1)

- **Enforced per-workflow caps.** `session-id` is observed, not capped.
- **Per-step caps per run.** Would need the step layer on its own `run_id`.
- **Setting caps from strut.** `agent_budgets` is config-file only today
  (`/_plugin/agents/<name>/budget` is GET-only, `budgets.go:92`).
- **Spend badges in the strut UI.** Needs a read credential for `/_plugin/*`;
  the provisioning token is far too powerful to hand over.
- **Any user model in strut** beyond the opaque actor. **Non-LLM spend** (Exa).
- **Callbacks from strut to hive.**

## Step order

1. strut: the `llmAuth` seam (§1). Ship and test with a static hook.
2. strut: actor plumbing and the principal rule (§2).
3. strut: `src/mothership.ts` (§3).
4. hive: agent names, `mintStrutDelegation`, the push, the actor (§4).
5. mcp: bump, enable, `labAuth` (§5).
6. End-to-end check in shadow mode (below).
7. Later: two gitsee lab steps in mcp build the Anthropic client directly
   (`boot-and-exercise.ts`, `vision.ts`) and bypass all of this; a writable
   budget endpoint on the gateway; badges in the strut UI; the gateway
   stamping `root-agent` from verified claims and the Mothership UI folding
   strut's steps under one `strut-agent` node (→ workflows → steps).

## Validation

- **Unit:** a macaroon strut builds (UA fixture + invocation + one step link)
  passes `gatekey`'s `verify` with the step as the billed agent; a link that
  widens `max_cost_usd`, drops `strut-agent`, or carries a positive
  `max_steps` under a `0` parent fails. Cap resolution: workflow override →
  env → default, and a non-positive result throws. `stepAgentName` never
  emits `/`. Principal rule, one case per trigger. No delegation → the hook
  returns `undefined` and the provider is called directly.
- **End to end** (gateway ships with `enforce_macaroons: false`, so this is
  safe to run against a live swarm): open strut from hive, run a workflow with
  two agent steps, then fire it from an automation. Both runs appear under the
  user; each step has its own `/agents/<name>/spend`; the session summary
  equals their sum.
- **Enforcement:** with the flags on, a run past `max_cost_usd` gets a 402
  `run_cost_exceeded` and the step fails with that message, not a retry loop.

## Open questions

- **A lapsed delegation.** With the reconciler, a delegation only goes away
  when hive removes it — the owner left the workspace. Should that owner's
  workflows then fail with "transfer ownership" (proposed: their spend has
  nobody to land on), or fall back to the deployment's direct keys?
- **Until the UI groups them:** unchecked whether the Mothership canvas copes
  with a few dozen agent names that are not in its catalog. Look at it in
  the end-to-end pass, before any workflow-heavy swarm turns this on.
