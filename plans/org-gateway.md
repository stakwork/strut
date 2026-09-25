# One gateway per org — the Mothership topology for federated struts

> **Status (2026-09-24): decided in discussion, nothing built.** Supersedes
> `plans/federation.md` §5 ("no gateway chaining"), which evaluated
> *chaining* swarm gateways into an org gateway and never evaluated
> *consolidating* them; its four objections stand, and every one of them
> argues for consolidation. Current behaviour was re-read on
> `strut@d941aea`, `hive@5c5dce093` (the merge of
> [stakwork/hive#5346](https://github.com/stakwork/hive/pull/5346)),
> `stakgraph@44927f26` (mcp + gateway) and `sphinx-swarm@3120e372`;
> citations are `file:line` on those. Companions: `mothership-cost-control.md`
> (the delegation record, actors, the principal rule), `federation.md`
> (peers, read-through, dispatch-through, the library — unchanged by this),
> `repo-agent.md` (the first workflow that needs a delegation on a
> workspace strut). The owner's goal, verbatim:
>
> > The default "org" strut instance runs "system level" workflows that
> > need to call steps from OTHER strut instances in specific workspaces.
> > Those agents need to use the bifrost/mothership from the org, not their
> > own. This way you can see in one place all the agent usage across
> > struts, and the macaroon delegation works simply: you don't need to
> > register VKs on multiple bifrosts... there is only one bifrost per org.

## Problem

Every swarm runs its own gateway. sphinx-swarm adds a `bifrost` node to
every stack (`sphinx-swarm/src/config.rs:406-415`) and the super pushes
the provider keys into every swarm's `bifrost` and `repo2graph`
containers (`src/bin/super/service/child_swarm/get_llm_keys.rs`,
`LLM_KEY_NODES`). Hive treats each as its own world: the gateway root is
derived from the swarm URL (`hive/src/services/bifrost/resolve.ts`,
`deriveBifrostBaseUrl`, host + `:8181`); admin credentials are
bootstrapped and cached per `Swarm` row; the org's signing key is
registered in each swarm's trust registry with `realm_id` = the workspace
slug (`trust-reconciler.ts:293-314`); the agent catalog is seeded per
swarm; a Bifrost *customer* per user and a *virtual key* per (workspace,
user) are created in that swarm's Bifrost and cached on `WorkspaceMember`
(`prisma/schema.prisma:387-389`); and the strut delegation — the macaroon,
that VK and that gateway root — is pushed to that swarm's strut
(`strut-delegation.ts:301-356`) and recorded on the same row (`:401-402`).

Every swarm's mcp also carries `STRUT_MOTHERSHIP_REQUIRED=1`
(`sphinx-swarm/src/images/repo2graph.rs:177`): a strut with no delegation
on file for a run's principal refuses the LLM call. The push that puts a
delegation there is per target, gated per workspace **slug**
(`isBifrostEnabledForWorkspace`, `strut-delegation.ts:387`; prod has
`BIFROST_ENABLED=hive`), and silent (`ensureStrutDelegation` never throws
and the dispatcher discards its result). Three consequences:

- **A strut per workspace broke.** Jamie's `dispatch_strut` named a
  workspace whose swarm had the flag and no delegation; the fix was to
  send every Jamie chat to the org default swarm
  ([stakwork/hive#5345](https://github.com/stakwork/hive/pull/5345),
  `strut-target.ts` `POLICY.chat = "org-default"`). `repo-agent.md` §7.3
  needs the opposite: the workspace's own strut, because the code graph
  lives there.
- **Usage is split over N logs.** The gateway plan deferred the
  cross-swarm view to a "central aggregator" that imports each swarm's
  log slice after the fact (`gateway/plans/phases/phase-11-symmetric-recursive-authorization.md`,
  "Cross-swarm analytics aggregator"). It does not exist. Hive's org-level
  Gateway view iframes ONE swarm's dashboard, the org default's
  (`hive/src/app/api/orgs/[githubLogin]/gateway/ticket/route.ts:43`), so
  it shows a fraction of the org's spend.
- **N of everything per user.** A VK, a customer, a delegation push and a
  trust registration per swarm the user can reach, reconciled by a daily
  cron per workspace (`hive/src/app/api/cron/strut-delegations/route.ts`).

## Decided

| Question | Decision |
| --- | --- |
| Topology | **One gateway per org**: the org default swarm's Bifrost, named by an org-level pointer. Every strut in the org bills through it, always — **single-mode**, no "own gateway for local runs, org gateway when dispatched" (§2) |
| Strut | **Unchanged for routing.** A delegation record already names its gateway; `llmAuth` sends the call wherever `baseUrl` says. One additive field, `dims`, for attribution (§4) |
| Delegation | **One record per user per org, fanned out** to every strut in the org: same macaroon, same VK, same `baseUrl`, a different `dims.workspace` per target. The per-workspace gate goes; an org gate replaces it (§3) |
| VK | **One per (user, org)** on the org gateway; the customer stays per user, so the daily customer budget becomes org-wide per user by construction (§3) |
| Attribution | `x-bf-dim-workspace: <slug>`, sent by strut from the record's `dims`; the gateway's dashboard gains `workspace` as a dimension (§4) |
| Chaining | Still **no**. With one gateway there is nothing to chain (§8) |
| Per-run forwarded grant | **Deferred.** Not needed inside an org once every strut shares the gateway and the fan-out; kept as the design for a strut *outside* the org, or when a parent's cap must bound a child's run (§6) |
| Dispatch-through | `federation.md` §2.2 as written: forward the actor, tail, cancel cooperatively. Billing lands on the org gateway because the child's own delegation record points there (§6) |
| Secrets | `federation.md` §6 unchanged: a run reads the deployment and actor secrets of the strut it executes on; nothing crosses (§6) |

## 1. Why strut is untouched

- **The record names its gateway.** A delegation is `{ macaroon,
  delegationId, apiKey, baseUrl, exp }` per actor (`src/mothership.ts:55-66`).
  `llmAuth` returns `apiKey: d.apiKey, baseUrl: d.baseUrl` and three
  headers: the attenuated `x-macaroon`, `x-bf-dim-session-id: <workflow>`,
  `x-bf-dim-root-agent: strut-agent` (`:340-351`). `PUT /llm/delegations/:actor`
  checks that `baseUrl` is an http(s) URL and nothing else about it
  (`:372`); `resolveModel` hands the grant's `baseUrl` to aieo, which
  appends the provider path (`src/llm.ts:109-116`). Which Bifrost a strut
  talks to is therefore entirely what hive pushes.
- **The macaroon is not per swarm.** Hive mints an org-signed user
  authorization plus a user-signed standing invocation for `strut-agent`,
  in the phase-11 wire shape: no `realm`, no budget block
  (`hive/src/services/bifrost/macaroon-issuer.ts:48-52,62-71`), `user_id`
  the global `{login}-{id}`. Every swarm gateway holds the org's pubkey,
  and the plugin's realm check accepts a realm-less macaroon on a gateway
  that has a `realm_id` — case 3 in `gateway/internal/auth/enforcement.go:124-140`.
  One macaroon per user per org verifies at whichever gateway of the org
  it is presented to. (Strut's `mothership.test.ts` already verifies the
  chains it builds with gatekey's own verifier; nothing in them changes.)
- **What IS per swarm today** is the VK — a governance object inside one
  Bifrost — the gateway root, the record on each strut, and actor secrets.
  The first three collapse to the org; actor secrets stay per target
  (`plans/code-change.md` §3.2) and are not touched by this plan.

## 2. The topology

**The org gateway** is the org default swarm's Bifrost, at the same
`host:8181` it has today. Nothing on it is bound to the host: the macaroon
is org-signed and realm-less, the VK and customer are re-creatable, and
the strut records are re-pushable. A dedicated gateway deployment later is
a change of pointer, not of design.

**One pointer per org.** `SourceControlOrg.defaultWorkspaceId`
(`hive/prisma/schema.prisma:203`) must be set for an org on this path, and
the org gateway is resolved from it without reference to the requesting
user. Finding: today both the strut embed and the Gateway view resolve
"the org's swarm" through `resolveOrgSwarmWorkspaceForUser`, which filters
by the user's membership and falls back to an unordered `findFirst`
(`hive/src/lib/helpers/org-workspace.ts:55-86`), so two members of one org
can resolve two different "org default" swarms. For a view that was a
convenience; for a gateway that must be one per org it is a bug.

**What moves from per swarm to per org.** Bootstrap of admin credentials;
the trust registration (one org pubkey, once); the agent catalog seed
(once); the customer per user; the VK (§3); the delegations (§3). The org
gateway's `realm_id` can stay what the trust reconciler set — the default
workspace's slug — or be set to the org login; macaroons carry no realm,
so either passes. The other swarms' gateways go idle; the cutover removes
nothing.

**Single-mode.** Every strut in the org, the org strut included, always
uses the org gateway. A dual mode — a swarm's own gateway for runs started
locally, the org's for runs the org strut dispatches — would need two
records per user per strut and a rule for which applies, and buys nothing
once the org log is the one view.

**Caps become org-wide by construction.** The gateway counts a
delegation's ceiling and a run's cap in its own Redis (`cost:run:<id>`,
`gateway/internal/auth/accumulator.go:19`). One gateway per org means one
counter per delegation across every workspace, which is what phase 11's
`realm_budgets` were designed to approximate across many gateways. They
are not needed here.

## 3. Delegations — one record per user per org, fanned out

- **One VK per (user, org)** on the org gateway, the customer per user as
  today (`reconciler.ts:290-310`; the daily customer budget is now the
  user's org-wide daily budget). Its home in hive is a per-(user, org) row
  — the `SourceControlToken` shape, `@@unique([userId, sourceControlOrgId])`
  (`prisma/schema.prisma:274-291`) — holding the VK id and value and the
  delegation id and expiry, replacing the four `WorkspaceMember` columns
  (`:387-389`, `:401-402`). This is the one real refactor on the hive
  side: `reconcileBifrostVK(workspaceId, userId)` is keyed and locked per
  member today.
- **One macaroon per (user, org)** — what `mintStrutDelegation` already
  mints, the workspace being only the key it looks the org up by.
- **The fan-out.** For every member of any workspace in the org, hive
  `PUT`s the same `{ macaroon, apiKey, baseUrl }` to the strut of every
  ACTIVE swarm in the org, with `dims: { workspace: <that swarm's slug> }`
  (§4). Three triggers, none new in kind: the **pre-dispatch check** stays
  as the fast path (`ensureStrutDelegation` on the resolved target: list,
  compare, push when missing or past half-life — this is what covers a new
  member's first dispatch before any cron ran); the **daily cron**
  (`strut-delegations`) re-keyed to orgs, renewing inside the last 15 days
  of the 60-day life and removing the delegations of members who left the
  org from every strut; and a **membership change** may push eagerly.
- **The gate.** `BIFROST_ENABLED` changes from a workspace-slug allow-list
  to an org allow-list (or `all`); `BIFROST_ENABLED_AGENTS` is unchanged.
  The per-workspace gate is what broke hive#5345, and once VK, macaroon and
  gateway are per org there is nothing per workspace left to gate. A
  skipped or failed pre-dispatch push should fail the tool call with the
  reason rather than dispatching into a certain refusal (`repo-agent.md`
  §7.3 asked for this; it still applies to the fast path).
- **What a record on a strut does and does not grant.** A delegation for
  U on workspace B's strut, where U is no member of B, grants U nothing on
  B: reaching B's lab needs B's swarm key or a hive-minted JWT, and hive
  access-checks both (`strut-target.ts`, `resolveWorkspaceSwarm`). It
  means only that if something on B runs as U — an org workflow the org
  strut dispatched there — U pays for it. That is the intended semantics
  of the principal rule.

## 4. Attribution — the `workspace` dim

With one log for the org, something must say which swarm a call came
from. Today nothing does: every row in a swarm's log was implicitly that
swarm's, and phase 11 dropped the `realm-id` column for that reason
(`gateway/internal/pluginctx/dims.go`, `signatureBoundDims` comment). The
plugin dashboard groups by a closed list — `agent-name`, `run-id`,
`session-id`, `user-id` (`gateway/internal/adminapi/observability.go:841-855`;
the UI's `Dimension` type, `ui/src/api/manual.ts:41`) — and filters by
those plus `org-id` (`:899-918`).

The mechanism exists. Any `x-bf-dim-<name>` header passes through to the
row's `metadata` map (`dims.go`, `ExtractDims`); only `run-id`, `user-id`,
`agent-name` and `org-id` are canonicalized from the verified claims, and
everything else "passes through whatever the caller stamped". Strut's own
`root-agent` dim already rides this way.

- **strut.** `Delegation.dims?: Record<string, string>`, accepted on
  `PUT /llm/delegations/:actor`: string values; lower-case keys of
  `[a-z0-9-]`; not `path` or `method` (Bifrost's reserved names) and not
  the four signature-bound names (the gateway would overwrite them). Stored
  with the record, merged into the `headers` `llmAuth` returns as
  `x-bf-dim-<key>`, strut's own `session-id` and `root-agent` winning on a
  collision. `GET /llm/delegations` additionally lists `baseUrl` — a URL,
  not a credential — so hive's cron can see a record that points at a
  gateway that moved; never the key. About ten lines and a test.
- **hive.** `dims: { workspace: <slug> }` on each push, per target (§3).
  The slug is the same string the trust reconciler publishes as that
  swarm's `realm_id`, so it needs no new identity.
- **gateway.** `workspace` joins `parseDimensionParam`'s switch,
  `metadataFilterFromQuery`'s pairs, the UI's `Dimension` union and the
  picker. The dashboard then reads workspace → user → workflow
  (`session-id`) → step (`agent-name`). The `realm-id` constant was kept
  in the gateway for exactly this kind of manual stamping and is the
  alternative if a new name is unwelcome; the dashboard change is the same
  size either way.
- **Not the VK.** Bifrost's native log table carries `virtual_key_id` and
  `virtual_key_name`, and a VK per (workspace, user) would identify the
  workspace — but the plugin's observability client reads `customer_id`
  and the metadata map only (`gateway/internal/adminapi/logstore_client.go:131-152`),
  and §3 makes the VK per org anyway. The dim is independent of how VKs
  are scoped.
- **Asserted, not signed.** A misconfigured or hostile strut could stamp
  another workspace's slug. Inside one org that misattributes within the
  org; the VK and the user on the row stay the gateway-side truth. Making
  it signature-bound would mean a caveat field, a wire-format bump, and a
  realm per swarm again — the multi-gateway machinery this plan removes.

## 5. Actors on a child strut

The model, in one place, because the per-target push has made it look
more complicated than it is:

- An **actor** is a string the host hook reads off the request
  (`createStrut({ resolveActor })`). On a swarm that is mcp's `labAuth`:
  the JWT's `sub`, or `x-strut-actor` beside the swarm's `x-api-token`.
  Standalone, `x-strut-actor` is honored only with a matching
  `STRUT_API_KEY` (`src/auth.ts:70-74`). Strut has no accounts and never
  interprets the string; hive makes it the same string everywhere,
  `{login}-{id}` from the global `User`.
- A run stamps **`actor`** (who launched it) and **`principal`** (who
  pays: the actor, else the workflow's owner — so an automation bills its
  owner), on `run.start` and the summary, and hands both to every step.
- The Mothership on **that** strut looks the principal up in **its own**
  `mothership.json` (`src/mothership.ts`, `llmAuth`). No delegation, and
  `STRUT_MOTHERSHIP_REQUIRED=1` makes the step fail.

That is all. The confusion came from the last point: a child strut knew
only the users hive happened to push to it. With one gateway and the
fan-out (§3), every strut in the org holds every member's record and the
record is the same everywhere, so "how do actors work on a child" has a
one-line answer: the same string, found in the child's own file, billed
through the org gateway under the child's `workspace` dim.

## 6. Dispatch-through under one gateway

`federation.md` §2.2 stands as written. `strut/run-workflow` POSTs to the
peer with the swarm key and `x-strut-actor: ctx.principal`; mcp honors the
header on the `x-api-token` path; the child stamps `actor = principal =`
that person; its Mothership finds the fanned-out record and calls the org
gateway; the header carries the child's `workspace`. Running a single
step on a peer, `POST /steps/:type/run`, has the same shape — `run-step.ts`
stamps the actor into billing the same way. Secrets resolve on the child:
its deployment secrets (the org API key of hive#5346 is the precedent for a
system-level workflow's credential) and any actor secret hive pushed
there. Nothing crosses.

**Caps.** The child run carries its own cap — its workflow's
`maxRunCostUsd`, else `STRUT_RUN_MAX_COST_USD` — not the parent's. A parent
that fans out to forty workspaces is forty caps. The gateway enforces
every run layer it finds in a chain (`gateway/internal/auth/capwalk.go:22`,
"for every chain layer"), so a chain that carried the parent's run link
would bound the tree; today's chains do not, because the child attenuates
from its own standing record.

**The deferred per-run grant.** The org strut could attenuate its own run
link once more and send `{ macaroon, apiKey, baseUrl }` with the dispatch
— phase 11's "cross-swarm sub-agents are HMAC-chained", no issuer round
trip. The child would hold it in the launch closure like `callback`, its
`llmAuth` consulting the per-run grant before its standing file, and
`run.start` recording nothing of it. That gives lineage (org run → child
run → step in one chain) and the tree cap, and needs no per-user state on
the child at all. What it costs: a new grant path in `src/mothership.ts`
(`PUT /llm/delegations` refuses attenuated macaroons by design), a
credential in a request body between two struts, and a second way a call
can be authorized. Inside an org, once §3 exists, it buys only the two
niceties. It is the design for a strut **outside** the org — a
Stakwork-level central dispatching into a customer org, where a standing
fan-out is not appropriate — and for the day a tree cap is a requirement.

## 7. What changes, per repo

| Repo | Change | Size |
| --- | --- | --- |
| **hive** | An org-gateway resolver off `defaultWorkspaceId` that ignores the requesting user (§2); `resolveBifrost` and everything on it — bootstrap, trust, catalog, customer, VK — pointed at the org gateway for every workspace in the org | medium |
| **hive** | VK and delegation state per (user, org) (§3); the fan-out in `ensureStrutDelegation` and the cron; `dims` on the push; the org gate | the one real refactor |
| **hive** | `POLICY.chat` back to `workspace`; `POLICY.repo_agent = "workspace"` (`repo-agent.md` §7.3) | one line each |
| **strut** | `dims` on the delegation record, sent as headers; `baseUrl` in the delegation list (§4) | ~10 lines + tests |
| **gateway** | `workspace` as a dashboard dimension and filter (§4) | small |
| **sphinx-swarm** | Nothing for the cutover. Later: stop adding `bifrost` to non-default stacks, and stop pushing provider keys to gateways nothing calls | cleanup |

## 8. Costs and risks

- **A single point of failure for the org's LLM traffic.** The org default
  swarm already is one for chat, code change and the embed; now every
  workspace's agent runs stop when it is down, where today only that
  swarm's did. The mitigation is a dedicated gateway deployment, which §2
  makes a pointer change. Decide on evidence, not in advance.
- **Prompts transit another host.** Every workspace's requests and
  completions pass through the org swarm's gateway. Within one org that
  is the trust domain the org strut embed already assumes; across orgs
  this plan does not apply.
- **Throughput.** One Bifrost per org instead of one per swarm. Nothing
  measured says it is a problem; measure on the largest org before the
  cutover rather than assume.
- **Moving the org gateway.** Macaroons stay valid (org-signed,
  realm-less). Customers and VKs must be created on the new gateway and
  every record re-pushed with the new `baseUrl` and key — the cron does
  that once it lists `baseUrl` (§4). Redis counters do not move: a moved
  gateway forgets spent ceilings and run caps. Acceptable for a rare
  operation; not something to do casually.
- **The dim is asserted** (§4).
- **Why not chain instead.** `federation.md` §5's four points, kept here
  for the record: the plugin reads `x-macaroon` inbound only and sends
  nothing outbound; a link cannot say "via swarm L" without a wire-format
  bump; a realm per gateway makes a chained macaroon `realm_not_permitted`;
  and two Redis stores count the same call twice. Chaining's only payoff
  was a cap that spans swarms, which one gateway gives by construction.

## 9. Step order

0. **strut: `dims` in, `baseUrl` out** on the delegation record (§4).
   Independent and tiny; lands first so hive can push against it.
1. **hive: the org gateway** (§2) — the resolver, and `resolveBifrost`'s
   family pointed at it. New customers and VKs land on the org gateway;
   the old per-swarm ones stay where they are, idle and harmless.
2. **hive: per-(user, org) state and the fan-out** (§3) — the table, the
   reconciler re-keyed, the push with `dims`, the cron re-keyed to orgs,
   the org gate. Push-before-dispatch stays as the fast path.
3. **hive: `chat` and `repo_agent` to `workspace`.** `repo-agent.md`
   milestone 1 is unblocked; hive#5345 is reverted by policy, not by code.
4. **gateway: the `workspace` dimension** (§4). The org Gateway view,
   already the org default's dashboard, is complete without a hive UI
   change.
5. **Later, on evidence:** sphinx-swarm drops idle gateways; a dedicated
   org gateway if the single point of failure bites; the forwarded per-run
   grant (§6) when a strut outside the org needs to dispatch in.

0 and 1 are independent; 2 depends on both; 3 on 2; 4 on 0.

## 10. Validation

- **strut** (`mothership.test.ts`): `dims` stored and sent as
  `x-bf-dim-<k>` beside the existing three headers; `path`, `method` and
  the four signature-bound names refused with a 400 naming the key; a
  collision with `session-id` keeps strut's value; `GET /llm/delegations`
  lists `baseUrl` and never `apiKey`; every existing chain assertion
  unchanged.
- **hive:** the org resolver returns the same swarm for two members of
  one org and errors when `defaultWorkspaceId` is unset; one org, two
  active swarms, one member → two `PUT`s with identical `macaroon`,
  `apiKey`, `baseUrl` and different `dims.workspace`; a member leaving the
  org → a `DELETE` on every strut; the org form of `BIFROST_ENABLED`;
  `strut-target.test.ts` for the two flipped rows; a pre-dispatch check
  that finds no delegation fails the tool call with the reason.
- **gateway:** `?dimension=workspace` groups; an unknown dimension is
  still a 400; a row without the dim is skipped as today.
- **End to end** (`docker-compose.gateway.yml`, `npm run test:gateway`):
  a second strut service on the fs backend against the same gateway; two
  delegations for one actor, one per strut, differing only in
  `dims.workspace`; an `agent`+`llm` run on each; the gateway log holds
  both under one `user-id` and one VK, split by `workspace`, and the
  dashboard's histogram by `workspace` shows two series. The smoke gains
  this case; the existing ones are unchanged.

## 11. What this changes in other plans

- **`federation.md`:** §5 becomes a pointer here; the Decided table's
  *Cost* and *Actor* rows, §2.2's billing bullet, §3's actor paragraph,
  §6's list of what a central may hold, §9's spend row, §10 and the step
  order are edited to match. Read-through, the library, the roll-up,
  peers and scopes, the selector, the learning loop and the central strut
  are untouched. `RunSummary.costUsd` stays — strut-side per-run spend for
  the roll-up — but the org-wide LLM truth is now one gateway log, so no
  aggregator is needed.
- **`mothership-cost-control.md`:** the delegation record gains optional
  `dims`; the routes are otherwise as documented.
- **`repo-agent.md` §7.3:** the "loud push" item is superseded by the
  fan-out; the pre-dispatch check keeps its "fail with the reason" rule.
- **`code-change.md`:** nothing. Actor **secrets** stay per target;
  `resolveStrutTarget` stays the one policy; the handle is unchanged.

## Open questions

- **The principal of a system-level org workflow.** An automation runs as
  the workflow's owner, so the owner must be in the fan-out — a person, or
  a hive-owned service user the org signs a user authorization for. The
  macaroon issuer derives `user_id` from a real `User`; a service actor is
  a hive decision, and until it is made the owner is an org admin.
- **The home table** for per-(user, org) VK and delegation state: a new
  table on the `SourceControlToken` pattern, or columns on an existing
  per-(user, org) row if one is preferred.
- **`realm_id` on the org gateway:** leave the default workspace's slug or
  set the org login. Cosmetic; macaroons carry neither.
- **Scale:** the largest org's call rate against one Bifrost, measured
  before the cutover.
