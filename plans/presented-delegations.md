# Presented delegations — the macaroon as a run's credential

> **Status (2026-09-24): design only, nothing built.** The second half of
> the delegation model in `plans/mothership-cost-control.md`. That plan's
> delegation is **standing**: pushed once per user by a host that holds
> strut's deployment key, and looked up by actor before every call. This
> one is **presented**: carried on the request that launches a run,
> verified by strut against an org's public key, and used for that run
> alone. `plans/org-gateway.md` §6 deferred it as "the design for a strut
> outside the org"; this is that design, and it also carries dispatch-
> through's tree cap inside an org. Current behaviour was re-read on
> `strut@d941aea`, `hive@5c5dce093` and `stakgraph@44927f26` (mcp + gateway);
> citations are `file:line` on those. The owner's goal, verbatim:
>
> > One thing I like about Mothership is you don't have to pre-register
> > your agent name identities beforehand. They are just created the first
> > time they're used. Is there a way to do that in Strut where an actor
> > could be created on the fly if somebody from a different place called
> > that Strut? Meaning you could run agents in other people's workspaces,
> > but still pay for them yourself, by passing along your own bifrost info
>
> and the setting it was asked in: "a more decentralized future version of
> mothership where multiple orgs could connect to each other".

## Problem

An actor on a strut exists only as a pushed record. `PUT
/llm/delegations/:actor` stores `{ macaroon, apiKey, baseUrl }` under
`D_<hex(actor)>` in `mothership.json` (`src/mothership.ts:364`), behind the
deployment key; `llmAuth` looks the principal up there before every call
(`:302`) and, under `STRUT_MOTHERSHIP_REQUIRED=1`, refuses a principal it
has no record for. Two things follow. Every strut that may ever run for a
person has to be pushed to first — `plans/org-gateway.md` §3 solves that
inside an org by fanning one record out to every strut, and only inside an
org. And nobody outside the org can run anything: a strut's credentials are
the deployment key, which is admin (`src/auth.ts:41`), and on a swarm mcp's
JWT minted from that key, or hive's `x-strut-actor` beside it
(`mcp/src/lab/mount.ts:77-83`). Nothing says "this person may launch a run
here, and someone else will pay for it".

The gateway already has, for agents, the property wanted for actors: an
agent is a string in a caveat, billed the first time it appears — "the
macaroon issuer treats `agentName` as a free-form string", "an agent is
just a string" (`gateway/plans/agent-catalog.md:12,19`). Strut's own step
names work that way today (`stepAgentName`, `src/mothership.ts`). And the
macaroon already carries everything a run needs to be both authorized and
billed: who (`user_authorization.user_id`), who vouches (the org's
signature; `org_id` on the macaroon — `gateway/auth/ts/src/types.ts:122,185`),
which agent (`strut-agent`), a cap and an expiry. The gateway's identity
plan says this is the point: "a macaroon presented to swarm B by an agent
acting on swarm A's behalf is verifiable from the signatures alone, no
callback to Hive, no shared database"
(`gateway/plans/cryptographic-identity.md:46-48`). Strut never *reads* one;
it only appends to one it was handed.

## Decided

| Question | Decision |
| --- | --- |
| The credential | An **attenuated** macaroon on the request, with the caller's virtual key and gateway URL. Strut verifies the chain with gatekey's `verify(macaroon, policy, now)` — the call `src/mothership.test.ts:159` already makes — against a trust registry of org public keys (§2, §3) |
| Standing vs presented | Mirror rules. A **standing** delegation carries no attenuations and is pushed by a host holding the deployment key (`checkDelegationMacaroon`, `src/mothership.ts:140`). A **presented** one carries at least one — a run link with a cap and a short expiry — and may be presented by anyone a trusted org has signed for. A presented macaroon is never stored (§2) |
| The actor | Read off the verified chain: `user_id`, bare when the org is the deployment's home org, `<user_id>@<org_id>` otherwise. It exists on first sight; there is nothing to register (§3) |
| Where the grant lives | The launch closure, beside `callback` (`src/createStrut.ts:1826`); `llmAuth` finds it by run id before the standing store; strut appends its run and step links **below the caller's link** (§4) |
| Who pays | The caller. The call goes to the caller's gateway with the caller's key; the host's gateway never sees it. The host contributes compute and nothing else (§5) |
| Trust | `trust.json` under `dataDir`: org id → gatekey `Policy` (`gateway/auth/ts/src/types.ts:70`), `home?`, `workflows?`. Hive pushes the deployment's own org; an operator adds foreign ones. The entry **is** the policy — which orgs, and which workflows for each (§3) |
| Scope | **Guest**: launch a run, control and read its own runs, push its own actor secrets. Nothing else — no publish, no chat, no reads of anyone else's runs (§6) |
| Secrets | Deployment secrets are the host's and stay on the host; the trust entry's `workflows` list is where a host decides what a foreign org may launch. A guest's own secrets arrive through the same credential (§6) |
| Inside the org | Unchanged for people: the UI, automations and chats bill the standing record. `strut/run-workflow` presents a grant, so a dispatched tree is capped by the parent and shows as one lineage (§7) |
| Gateway | **Nothing changes.** Every layer of a chain is already enforced (`gateway/internal/auth/capwalk.go:22`); a foreign `workspace` dim is the right answer to "where did my agent run" (§5) |

## Design in one paragraph

A request that launches a run may carry `x-strut-macaroon`, `x-strut-vk`
and `x-strut-gateway`. Strut decodes the macaroon, looks its `org_id` up in
`trust.json`, verifies the chain against that org's policy, checks that it
is attenuated to a cap and an expiry and names `strut-agent`, and takes
`user_id` as the actor. The run launches as that actor, and the three values
ride in the launch closure the way a callback URL does — never on
`run.start`, which records the actor, the org and the delegation id. When a
step of that run needs a model, `llmAuth` finds the grant by run id,
attenuates one link from the caller's last link (this run's id, the smaller
of the workflow's cap and the caller's, eight hours or the caller's expiry)
and one more per step, and sends the call to the caller's gateway with the
caller's key. That gateway verifies its own org's signature, enforces every
layer including the caller's cap, bills the caller's key, and can kill it.
The host's gateway, delegation file and secrets are not involved. Inside an
org the standing record keeps serving people; `strut/run-workflow` presents
a grant so a tree of runs is one chain under one cap.

## 1. What the gateway already does

Three properties this plan leans on, none of them new:

- **Names exist on first use.** The lineage is `agents: [...]` in caveats;
  the gateway bills the last name and keeps no registry of names
  (`gateway/plans/agent-catalog.md:10-19`). Strut's `<workflow>.<step>`
  names are minted per call and were never registered anywhere.
- **Verification needs only a public key.** `Verify(macaroon, policy, now)`
  takes "the trust-registry entry for the macaroon's org"
  (`gateway/auth/go/verify.go:17-22`); the TS twin (`gateway/auth/ts/src/verify.ts:64`)
  returns `Claims { org_id, user_id, agent_name, effective_caveats, … }`
  (`types.ts:224-231`). Strut already depends on gatekey and calls it in
  its tests.
- **Every layer is enforced.** The cap walk checks `cost:run:<r>` against
  the layer's `MaxCostUSD` "for every chain layer"
  (`gateway/internal/auth/capwalk.go:22`), so a chain `[delegation, caller's
  run, this run, step]` is bounded by the caller's run cap as well as its
  own. A realm-less macaroon is accepted at any gateway
  (`gateway/internal/auth/enforcement.go:160`, case 3); one carrying
  `realm_budgets` needs the gateway's own realm among its keys.

And the one thing it does not do: settle money between orgs. A gateway pays
its providers with its own keys and bills a virtual key **it** issued. So
"pay for it yourself" means the call must reach **your** gateway (§5).

## 2. The request

Three headers, on the routes §6 lists:

| Header | Carries | Needed for |
| --- | --- | --- |
| `x-strut-macaroon` | the attenuated chain, base64url as everywhere | every guest request — it is the identity |
| `x-strut-vk` | the caller's virtual key at the caller's gateway (Bifrost's own header for it is `x-bf-vk`, `bifrost/core schemas/bifrost.go:244`) | launches only |
| `x-strut-gateway` | the caller's gateway root, `https://host:8181` (`hive/src/services/bifrost/resolve.ts:39`) | launches only |

Headers rather than body fields: reads and the actor-secret PUT carry no
body of their own, and a header is never persisted by a handler that
stores its body. Not `authorization`: that header is the deployment key's
(`src/auth.ts:41-58`), and a request may legitimately carry both — hive
dispatching to its own strut with the swarm key *and* a presented grant
(§7).

**What strut checks** — `checkPresentedMacaroon`, the twin of
`checkDelegationMacaroon` (`src/mothership.ts:140`):

1. It decodes; `v: 1`; a `user_authorization` and an `invocation`; the
   invocation's `agents` include `strut-agent`.
2. Its `org_id` is in `trust.json` — else 401 `untrusted_org`, naming the
   id and nothing else.
3. `verify(macaroon, policy, now)` passes — signatures, expiries, narrowing
   (`gateway/auth/ts/src/verify.ts:64`). A failure is 401 with gatekey's
   reason.
4. **At least one attenuation.** The last one is *the caller's link*: its
   `max_cost_usd` is the most this run may be given, its `exp` the latest
   the grant may be used, its `run_id` the caller's run. An unattenuated
   macaroon is refused with "present an attenuated grant — a standing
   delegation is pushed, never presented", the mirror of `:140`.
5. `effective_caveats.max_steps` is 0, as the standing rule requires.
6. On a **launch**, the last link's `nonce` has not launched a run here
   before — an in-memory set swept by `exp`, like `runLinks` (`:243`). One
   grant, one run. Reads and secret pushes present the same macaroon
   freely.

The VK and the gateway are checked for shape only: a non-empty string, and
an http(s) URL as the PUT route checks `baseUrl` (`:364`).

## 3. The actor and the trust registry

**Actor.** `claims.user_id` — for hive-issued macaroons `{login}-{id}`, the
string the standing record is keyed by (`hive/src/services/bifrost/macaroon-issuer.ts:245`)
— so a person presenting a grant on their own org's strut is the actor the
UI already knows. When `org_id` is not the deployment's home org the actor
is `<user_id>@<org_id>`: two hives can both mint `alice-42`. `@` keeps the
id URL-safe as a path segment, keeps the UI's first-`-`-segment display
(`web/src/actor.ts`) showing `alice`, and hex-encodes like any actor in the
secret stores. `run.start` records `actor`, `principal` (= actor: a
presented grant always names who pays) and `presented: { org, delegationId }`
— the standing invocation's `run_id`, what the gateway keys the ceiling by
— and nothing else of the grant.

**Trust registry.** `trust.json` beside `mothership.json`, plain JSON —
public keys are public; the file's integrity is guarded the way
`secrets.json`'s is, by who can write `dataDir`:

```json
{
  "gh_acme":  { "policy": { "type": "single", "key": { "alg": "ecdsa-secp256k1-sha256", "key": "02…" } }, "home": true },
  "gh_other": { "policy": { "type": "single", "key": { "alg": "ecdsa-secp256k1-sha256", "key": "03…" } },
                "workflows": ["repo-agent", "review-pr"] }
}
```

`policy` is gatekey's `Policy` verbatim (`gateway/auth/ts/src/types.ts:70`:
a single key or a multisig), so an org that moves to a multisig root
(cryptographic-identity phase 3) needs no strut change. `home: true` marks
the deployment's own org: bare actors, every workflow. `workflows` absent
means every workflow; present, only those names — the whole guest policy
in one field, no new workflow metadata. Routes, behind `requireApiKey`:
`PUT /llm/trust/:orgId { policy, home?, workflows? }`, `DELETE
/llm/trust/:orgId`, `GET /llm/trust` (ids, `home`, `workflows`; keys are
public, so the GET may return them). `STRUT_TRUSTED_ORGS`, a JSON object
of the same shape, loads at boot for standalone deployments. Hive pushes
the home entry from `SourceControlOrg.macaroonOrgPubkey`
(`hive/prisma/schema.prisma:201`) as one more item in the fan-out of
`plans/org-gateway.md` §3; a foreign org is added by an operator who has
that org's id and key. Pairwise trust, no registrar — the gateway's own
shape (`gateway/internal/trust/types.go:65-67`).

**Where the check runs.** `resolveActor` is the seam
(`src/createStrut.ts:231`). Strut's default becomes "the deployment key's
`x-strut-actor`, else a presented macaroon", and the presented answer
carries `scope: "guest"` and `org`. On a swarm, mcp's `labAuth` fronts
every `/lab` route and admits only the swarm key or a JWT minted from it
(`mcp/src/lab/mount.ts:77-83,124`); it gains one branch: a request carrying
`x-strut-macaroon` on a guest route (§6) passes through, and strut's check
decides. mcp calls the same exported `checkPresentedMacaroon` to fail fast
with the same message; strut's check is the one that counts.

## 4. The grant in the launch

`launchDetached(flow, body, { actor, principal, callback, grant })`
(`src/createStrut.ts:1809-1826`): `grant = { macaroon, apiKey, baseUrl, org,
delegationId }` joins `callback` in the closure. The run routes (`:1996`,
`:2015`) and `POST /steps/:type/run` (`:1727`) build it from the headers
when the actor was presented. Nothing of the grant is written to the log;
`run.start` gets the `presented` stamp of §3 beside `callback: { origin }`
(`:1854`).

**`llmAuth` order.** The Mothership gains `grants: Map<runId, Grant>`,
registered by the launch and dropped by `onRunEnd` or expiry. For a step
call it checks `grants.get(ctx.runId)` first, then `delegations.get(principal)`
as today (`src/mothership.ts:302`), then refuses under
`STRUT_MOTHERSHIP_REQUIRED` as today. A presented grant satisfies "someone
to bill". Chat turns have no run id and no grant: guests do not chat (§6).

**Links.** Today `runLink` attenuates from the invocation
(`gk.invocationSigBytes(m.invocation)`, `:289`). For a grant it attenuates
from the caller's last link — `gk.attenuationSigBytes(last)`, the call the
step link already makes (`:332`) — with caveats `[strut-agent]`, `run_id` =
this run, `max_cost_usd` = min(the workflow's cap, the caller's link's), and
`exp` = min(now + 8 h, the caller's link's); `capOrThrow` measures against
the caller's link instead of the invocation ceiling. The step link is
unchanged. The chain the gateway sees is `[delegation, caller's run, this
run, step]`, each narrower than the last — what `verify` requires and what
the cap walk enforces per layer. `x-bf-dim-session-id` is this workflow,
`x-bf-dim-workspace` this strut's (`plans/org-gateway.md` §4), `root-agent`
as today.

**Restart.** A grant lives in memory. A run resumed after a restart has
none and fails at its next model call with "the presented grant for this
run did not survive a restart — launch it again": the callback's crash
posture (`specs/CALLBACKS.md`), never a silent fall-through to a standing
record that may exist for the same actor.

## 5. Who pays, and what the gateway sees

The call lands at `x-strut-gateway` with `x-strut-vk`. That gateway holds
the caller's org in its own trust registry, verifies the whole chain, walks
the caps — the caller's link included — and bills the caller's virtual key
under the caller's user id, with `agent-name` the executing step and
`workspace` the executing strut's. Kill and revocation at the caller's
gateway end the run at its next call: a 401 or 402 is a step error, and
`explainExhausted` (`src/mothership.ts:398`) names the delegation. The
host's gateway is never called; the host's Redis counts nothing; the host's
provider keys are untouched. Network: a gateway root is a public
`host:8181` (`hive/src/services/bifrost/resolve.ts:39-54`, the address hive
itself uses), reachable from another swarm.

The other arrangement — the host's gateway trusting the caller's org key,
the way phase 11 describes a sub-agent on swarm w2
(`gateway/plans/phases/phase-11-symmetric-recursive-authorization.md:69-72`)
— authorizes the work and caps it, but the host's providers are paid by the
host. That is right within one org, where every gateway is the org's, and
it is what the fan-out already gives. Between orgs it needs settlement,
which is a transparency-log problem, not this plan's. So a presented grant
always names the **caller's** gateway.

## 6. Guest scope

A presented actor may:

- **Launch**: `POST /workflows/:name/run`, `/:version/run`, `POST
  /steps/:type/run` — the workflow (or step) must be in the trust entry's
  `workflows` when one is set.
- **Control and read its own runs**: cancel / pause / resume
  (`src/createStrut.ts:1143`), the summary, events, `stream` (`:806`),
  transcripts and artifacts of a run whose `run.start.actor` is this actor.
  Anyone else's run is a 404, not a 403 — a guest learns nothing about what
  else runs here.
- **Push its own actor secrets**: `PUT` / `DELETE /actors/:actor/secrets/:name`
  (`:1560`) when `:actor` is itself. The run binds `secrets` to its principal
  (`SecretsCapability.forPrincipal`, `src/capabilities.ts:95`), so a guest's
  `GH_TOKEN` reaches its own `git/checkout` and nothing else's. A foreign
  hive cannot push secrets with the swarm key; this is how a guest's
  credential arrives.

Everything else — publishing, steps, deployment secrets, chats,
automations, other actors' runs, the peer routes of `plans/federation.md`
— is 401 for a guest. `resolveScope`, the hook `federation.md` §3 proposes
for the read-only peer scope, is where `"guest"` joins `"full"` and
`"peer"`: one function, three answers, the gated routes reading it.

**Deployment secrets.** A workflow reads the host's deployment secrets,
and a guest launching it gets their effect. That is the host's decision,
and the trust entry's `workflows` list is where it is made: a foreign org
is given the workflows written for guests, nothing by default. Within the
home org every workflow is callable, as it is for any member today.

## 7. Inside the org, and hive

Nothing changes for people: the browser holds no macaroon per request, so
the UI, automations and the builder's chat bill the standing record the
fan-out put on every strut. Presented grants are for **machines**:

- **`strut/run-workflow`** (`plans/federation.md` §2.2) presents. From the
  parent's own run link it attenuates one more — the child's cap (the child
  workflow's `maxRunCostUsd`, else the parent's), eight hours — and sends it
  with the parent's VK and gateway as the three headers, plus
  `x-strut-actor` for the record. The child needs no delegation for that
  person; the tree is one chain under the parent's cap; the gateway shows
  `org run → child run → step`. That is the "deferred per-run grant" of
  `plans/org-gateway.md` §6, delivered by this plan rather than as a
  feature of its own. The standing fan-out stays for the UI on that child.
- **Hive** may present on a dispatch instead of relying on the fan-out: it
  mints a short invocation per dispatch — `mintInvocationMacaroon`
  (`hive/src/services/bifrost/macaroon-issuer.ts`) with a one-run cap and
  hours, not days — and sends it as the grant. Optional: the fan-out is the
  base; a presented grant is what a hive dispatching into an org it does
  not run would use. `resolveStrutTarget` stays the one policy.
- **The org strut as a guest elsewhere.** A Stakwork-level central
  dispatching into a customer org (`plans/federation.md` §1) is a foreign
  org to that strut: the customer adds Stakwork's org key with a
  `workflows` list, and the central's operator actor pays at Stakwork's
  gateway. No swarm key, no delegation file on the customer's side, no
  peer token — the peer token of `federation.md` §3 remains for **reading**
  another strut's history, where nothing is billed.

## 8. What changes, per repo

- **strut.** `src/mothership.ts`: `checkPresentedMacaroon`, the trust
  store and `/llm/trust` routes, `grants` and the `llmAuth` order,
  `runLink` from a parent link, the nonce set. `src/auth.ts` /
  `src/createStrut.ts`: the presented branch of the default `resolveActor`,
  `scope`, the three headers into the launch closure, the `presented` stamp
  on `run.start`, the "own run" and "own actor" checks on the guest routes.
  `src/steps/lib/strut/run-workflow.ts` presents (with `federation.md`
  step 6). Tests in §11.
- **mcp.** `labAuth` admits `x-strut-macaroon` on the guest routes;
  `createLabStrut` gives strut's `resolveActor` the presented branch after
  its own.
- **hive.** The home trust entry in the fan-out; optionally, present on
  dispatch.
- **gateway.** Nothing.

## 9. Costs and risks

- **A bearer key travels.** The caller's VK reaches another org's strut.
  With macaroon enforcement on at the caller's gateway, the key alone buys
  nothing, and the key with the grant buys at most the link's cap until its
  expiry; a caller attenuates per dispatch with a fresh nonce. With
  enforcement **off** (shadow mode: `enforce_macaroons` in
  `sphinx-swarm/src/images/bifrost.rs`) the VK is a plain bearer credential
  — so a caller presents grants only to hosts it trusts until its gateway
  enforces. The caller's call, stated in the step's description.
- **Replay.** One nonce, one launch (§2, check 6). Reads are idempotent.
- **Actor collisions.** Qualified ids for foreign orgs (§3); the home org
  keeps bare ids, so nothing about existing records changes.
- **The host runs unpaid compute.** Bounded by which orgs and which
  workflows the host trusts. Settlement, if ever, is the transparency
  log's, not strut's.
- **Restart drops grants.** The callback's posture, and the error says so.
- **Two ways to authorize a call.** Ordered by run id and tested together;
  `STRUT_MOTHERSHIP_REQUIRED` refuses exactly what it refused before, and
  nothing more.

## 10. Step order

1. **Trust store + presented check + actor.** `trust.json`, its routes,
   `checkPresentedMacaroon`, the `resolveActor` branch with `scope:
   "guest"`, the guest-route checks. Useful alone: a foreign org's member
   launches a guest-listed workflow with no LLM step and reads the result.
2. **The grant.** Headers into the launch closure; `grants` and the
   `llmAuth` order; `runLink` from the caller's link; the nonce set; the
   `presented` stamp. Useful alone: the same guest runs an `agent` step,
   billed at their own gateway.
3. **mcp: `labAuth` admits presented requests.** Small; the precondition
   for a swarm.
4. **`strut/run-workflow` presents** (with `federation.md` step 6). Tree
   caps and one lineage for dispatch-through.
5. **hive: the home trust entry** in the fan-out; present-on-dispatch when
   wanted.

1 and 2 are strut only and offline. 3 gates swarms; 4 waits on federation
step 6; 5 is one line in the fan-out.

## 11. Validation

- **The check** (`src/mothership.test.ts`, the fixtures it already mints):
  a chain attenuated once verifies against a `single` policy and yields the
  actor; an untrusted `org_id` is refused naming the id; a standing
  (unattenuated) macaroon is refused with the mirror message; a bad
  signature, an expired link, a wrong agent and a non-zero `max_steps` are
  refused with gatekey's reason; a second launch on the same nonce is
  refused and a read on it is not; home vs foreign actor formatting.
- **The grant**: `llmAuth` for a run with a grant returns the caller's
  `baseUrl` and `apiKey`, never the standing record's, even when both exist
  for the actor; the chain verifies with gatekey as `[delegation, caller's
  run, run, step]`, caps narrowing at each layer, the run cap the smaller
  of the workflow's and the caller's; the caller's link expiry bounds the
  run link; the grant is gone after `onRunEnd`; a run resumed after the map
  is cleared fails with the restart message.
- **No leak** (the elicitation plan's sentinel pattern): a sentinel
  macaroon and VK appear nowhere in `run.start`, the summary, the events,
  the stream, the callback body, the transcripts or the logs.
- **Guest scope** (`src/createStrut.test.ts`): a presented actor launches a
  listed workflow, reads and cancels its own run, pushes and deletes its
  own secret; is 401 on publish, secrets, chat, another actor's secrets and
  the peer routes; is 404 on another actor's run; is 401 on an unlisted
  workflow when the entry lists some; with no `trust.json` the suite is
  byte-identical to today's.
- **Gateway smoke** (`npm run test:gateway`): a second org key registered
  in the compose gateway's trust registry; a grant attenuated from that
  org's delegation launches a run whose calls bill under that org's user id
  with the executing strut's `workspace` dim; a child link capped above its
  parent's is refused by `verify`; a child that spends past the parent's
  cap gets 402 from the cap walk.
- **`strut/run-workflow`**: the child's `run.start` carries the parent's
  actor and a `presented` stamp; cancel of the parent reaches the child
  (federation's cooperative assertions); the child's chain carries the
  parent's run id.

## 12. What this changes in other plans

- **`plans/org-gateway.md` §6:** its closing paragraph, "the deferred
  per-run grant", is a pointer here, as is the Decided row *Per-run
  forwarded grant*. Everything else there stands: presented grants sit
  beside the fan-out, not instead of it.
- **`plans/mothership-cost-control.md`:** one Decided row, *Presented
  delegations*, and one non-goal that points here. The standing model, the
  routes, the links and the tests are as documented; §3's `runLink` gains a
  parent.
- **`plans/federation.md`:** nothing to edit now. §2.2's dispatch step is
  the same step, presenting (§7); §3's peer token narrows in practice to
  the read-through it was for; `resolveScope` gains a third answer. Noted
  here so that plan's next revision picks them up.
- **`plans/code-change.md`:** nothing. Actor secrets stay per target; a
  guest pushes its own.

## Open questions

- **Guest chats.** A foreign org's member opening the builder on a host's
  strut is a different product question (whose workflows, whose graph).
  Not v1.
- **Presenting on reads across orgs.** The peer view (`federation.md`
  §2.1) uses a pushed read token; a presented macaroon could instead
  authorize reading one's own runs on any strut that trusts the org, which
  is most of what a central needs. Later.
- **Home-org UI sessions.** Could the embed hand the browser a presented
  macaroon instead of hive pushing a standing record? Only without the VK,
  and the browser would then need a per-request signing step. Not worth it
  while the fan-out is one record per user.
- **`x-strut-actor` beside a presented macaroon.** Ignored for identity —
  the chain says who. Whether to record it as the parent's label for the
  drill-down is decided when `strut/run-workflow` lands.
