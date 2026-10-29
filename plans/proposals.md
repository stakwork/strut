# Proposals: a tool call a person approves before it runs

> **Status (2026-10-19): BUILT** (v1, §11 items 1–6, on branch `claude/proposal-tools-architecture-e87119`; the two graph deletes included). The design text below is as proposed and ruled.
>
> **Design status (2026-10-19): proposed, scope ruled.** Written after a read of
> the three repos as they are today — hive `master` @146e2465 and the open
> stakwork/hive#5551 (`mcp-org-propose-tools`), stakgraph `main` @8ede556e
> (`mcp/src/lab`), strut `main` @8a03e85 — in answer to one question: where
> do Jamie's `propose_*` tools go once Jamie's chats are turns of strut's
> `orchestrator` workflow, and how does a person's accept or reject APPLY
> without a model in the loop. The owner ruled on 2026-10-19 that the
> mechanism is strut's and that **v1 covers the graph and Concept writes
> only** — the seven `graph*` kinds and the two `concept*` kinds Jamie has,
> all of them strut's `graph/*` steps (two deletes to add); initiatives,
> milestones and prompts come later (§9). The other rows in "Decided" are
> mine and open. Companion to `jobs.md` (the job, deliverables,
> holds), `live-artifacts.md` (`jobCallback`, `job.update`), `automations.md`
> (the one approval strut has today) and `specs/CALLBACKS.md` (the run
> callback a proposal rides on). Hive's and the lab's halves are described
> as the contract they read, not as work items here.

## Problem

Jamie — hive's canvas chat agent — can propose fourteen kinds of change
(`src/lib/proposals/types.ts`): an initiative, a milestone, a prompt, a
Concept, and seven graph writes (create node, edit node, triplet, batch,
delete edge, move node, delete node). A proposal is **a tool call and
nothing else**: the `propose_*` tool's `execute` is pure (it validates,
reads the swarm for a preview, and returns a `ProposalOutput { kind,
proposalId, payload, rationale?, meta? }`), the row is appended to the
conversation's `messages` JSON, `ProposalCard` renders it by `kind`, and
**Approve** / **Reject** go to `/api/ask/quick` → `runProposalIntent` →
`handleApproval`, which applies it IN CODE — no model call — by a `switch`
on `kind`: Prisma rows for initiatives and milestones, hive's own MCP for
prompts, jarvis's `/v2/nodes` and `/v2/edges` for Concepts and graph
writes, under the clicking user's membership. Reject checks the proposal
exists and does nothing. Jamie learns the decision on its next turn, by
replay: the click row ("Approved: X") and the result row are in the
transcript. No DB table; the chat is the record.

stakwork/hive#5551 exposes nine of these (Concepts + graph writes) over
hive's **org-scope MCP** so that an external agent — strut's orchestrator,
launched with `POST …/run { mcp: [hive] }` — can post the same card into
a named conversation; the approval path is untouched. It is the smallest
change that puts a card in front of a person from a strut run. It is also
the wrong layer, for reasons that have nothing to do with the PR's code:

| The MCP shape | What it costs |
| --- | --- |
| The proposal exists only in hive's conversation JSON | strut has no record of it: a resumed turn proposes again (no journal); `job/get`, the Jobs sidebar, the run flyout and the `run.end` callback cannot show it; a Peel orchestrator, a desktop strut, or any host but hive gets nothing |
| One tool per kind, in hive, three times (the tool, the card, the `switch`) plus an MCP twin | every new proposable thing is a hive PR with four edits. This is the per-kind Tasks/Plans shape `job-artifact-events.md` was written to stop |
| Hive applies the graph writes through jarvis | strut already has the same writes as steps — `graph/create-node`, `edit-node`, `create-triplet`, `create-batch-triplet`, `move-node`, `edit-edge` — and the lab has their jarvis twins. Two graph-write layers, one ontology |
| The run needs a user-bound org JWT with `write` (4 h), the Jamie `conversationId`, and the MCP URL on the launch | none is wired (`dispatchStrutRun` sends no `mcp`); the JWT is too short-lived for anything strut would do with the proposal later |
| An MCP tool's result is text | it cannot carry strut's markers (`withStop`, `withMedia`), cannot be journaled, cannot be gated by `sealed`, and the model may paraphrase what it proposed |
| The decision's only outward channel is the transcript | every event hive sends a job today (`[artifact-event]`, `[claim-event]`, `[captcha-answer]`) is a model turn. A decision is not a message for the agent; it is an instruction for code |

What is in strut already, and what is missing:

| Has | Lacks |
| --- | --- |
| "Tools are steps": a registry step's `input` schema is the tool schema, its `run` the executor (`buildRegistryTools`, agent.ts) | a way to CALL a step later — the call recorded now, run when a person says so |
| `withStop`: a tool output that ends the turn, for a device that has not answered (core.ts) | a turn that goes on after proposing — a chat answers "I've proposed X" and keeps talking |
| The automation steps' approval: `approval(ctx, cap, intent)` runs the HOST's approve step inline; pending = `withStop`, denied = `{ changed: false }`; `approvedOnce` journals the act (`steps/lib/automation/_shared.ts`) | a record a person can decide on after the turn, outside the run; an apply that does not need the model to call the tool again |
| `launchOnce` + `journalKey`: a tool call's handle journaled at `<agent path>#<call>`, so a resumed turn gets what it started (`job/_shared.ts`) | the same for a proposal |
| `releaseWith`: a registry step run under a minimal context, outside any run, from a stored input (`jobs.ts`) | the same runner for an approved call |
| `run.end { artifacts, transcripts }` and `job.update` (`jobCallback`) | a field that says what the run proposed; an event when one is decided |
| `code-change-propose` → `code-change-land` (the lab: a diff proposed, the exact diff applied after a sha check); the janitor's `plan` → `apply` split; Plan Mode's `ask` | one mechanism under them |

## Decided

The first two rows are the owner's (2026-10-19). The rest are what I would
decide, and why; each is open.

| Question | Decision |
| --- | --- |
| Where the mechanism lives | **strut core** (ruled). A proposal is a deferred step call — a record, a gate on the agent's tools, a decide door, an apply runner, a field on `run.end`. None of it knows what is proposed. There are no proposal TYPES: a proposal is whichever step the workflow gated |
| What v1 proposes | **The graph and Concept writes** (ruled): `graph/create-node`, `edit-node`, `create-triplet`, `create-batch-triplet`, `move-node`, and two new steps, `graph/delete-edge` and `graph/delete-node` — Jamie's seven `graph*` kinds; its two `concept*` kinds are the same steps with `node_type: Concept`. Initiatives, milestones and prompts (hive's own rows) are not in v1 |
| What is proposable | **Any registry step the WORKFLOW names.** The agent step gets `approve:` beside `agentTools`: a tool named there does not run when called; the call becomes a proposal. The step definition does not change — `graph/create-node` runs at once in a janitor automation and proposes in a chat. The policy is the workflow's (`params`), as `params.tools` is, so a host's delta sets it |
| Whether the model chooses to propose | **No.** It calls the tool; the gate decides. Its result says the call is pending the person's approval, so it tells them what it proposed (the tool description says so). A `rationale` field is added to a gated tool's schema and kept on the record, never handed to the step — the one thing the model adds, as hive's tools take `rationale` |
| Who applies | **strut, in code, at the decision**: the step run with the recorded input (plus the person's edits, re-validated by the step's own schema), under a minimal context (`releaseWith`'s), the decider as `ctx.actor`, the run's principal for billing and secrets. Reject runs nothing. Never a model turn |
| Where the proposal lives | **A file record under `dataDir`**, `proposals/<id>.json`, like `jobs/<id>.json` — plus the journal entry at `<agent path>#<call>`. No graph node until something must point at one (`jobs.md`'s rule for artifacts) |
| How the host hears | **`run.end { proposals: [...] }`**, computed by strut like `transcripts` and `artifacts`; `job.update { kind: "proposal" }` on a job run as they are created and decided; `GET /proposals/:id` is the record. Never the model's `artifacts` list alone |
| Whether the turn ends | **No.** The gate returns a result and the turn goes on. Ending the turn is `withStop`'s job and stays the automation steps' and Peel's device requests' (§8 says how they meet) |
| How the agent learns the decision | **Prepended to its next turn, in code**: the agent step, opening a session, puts one `[proposal-result]` line per proposal of this session decided since the session's last turn before the prompt. No extra turn; the decision rides on the next message. A host may still forward a decision as a turn when the work must go on at once |
| Graph and Concept writes | **strut's `graph/*`** (a Concept is a node of type `Concept`; strut owns the root pages). The lab's `jarvis/*` twins are grantable the same way where a swarm's graph is jarvis's; which family the orchestrator seed grants is the lab's call |
| Hive-owned effects (initiatives, milestones, prompts), later | **Lab steps that call hive's API** with the deployment's org key, the `pod/*` precedent — `hive/create-initiative`, …, gated like any other. Not hive's MCP: a decision may come days after the launch, and the apply runs under no run. Nothing in strut changes for them: that is the test of the design |
| stakwork/hive#5551 | **Not merged as the path forward.** Its nine tools become nine entries in the orchestrator's `approve:` list; hive's side becomes a card that renders a strut proposal and a route that forwards the click |

## Design in one paragraph

An agent step whose config names a tool in `approve:` gets that tool
with the same name and schema (plus `rationale`), but a call to it writes
a **proposal** — the step type, the parsed input, the rationale, who
proposed it (run, path, job, session, actor, principal) — to
`<dataDir>/proposals/<id>.json`, journals the call at `<agent
path>#<call>` so a resumed turn finds it, tells the job's host
(`job.update`), and returns `{ proposal: <id>, status: "pending", step,
url }` to the model, which goes on and tells the person. When the run
ends, `run.end` carries `proposals: [{ id, step, title, status, url }]`
beside `artifacts`. A person decides at `POST /proposals/:id/decide {
action: accept | reject, input?, reason? }` — hive's button, strut's own
UI, Peel's card — and on accept strut runs the step then and there with
the recorded input (edits merged, re-parsed by the step's schema), records
the output or the error on the proposal, answers with the record, and
tells the host; on reject it records the reason. The next turn of the
proposing session begins with the decisions it has not yet been told.
Nothing about what was proposed is strut's to know: the step is the
contract, the host's card renders its input, and the host's apply logic
is the step itself.

## 1. The gate

`agent` step config, beside `agentTools`:

```yaml
agentTools: "{{ params.tools }}"
approve: "{{ params.approve }}"      # step types among agentTools; globs as agentTools takes them
```

`expandAgentTools` resolves both lists against the registry. A type in
`approve` that is not granted is a warning (nothing to gate). A type in
both is built by `buildRegistryTools` as today and then WRAPPED
(`src/proposals.ts`, `gateTool`): its description gains one sentence
("Nothing happens when you call this: it is proposed to the person, who
accepts or rejects it; say in your reply what you proposed and why"), its
schema gains `rationale: string` (optional, one or two sentences for the
person), and its `execute` becomes:

1. `def.input.parse(input)` — the step's own validation, so a malformed
   proposal is refused to the model as `Error: invalid input …`, exactly
   as a direct call would be, before any record exists.
2. `journalKey(ctx, …)` — a prior entry at `<agent path>#<call>` (a
   resumed turn making the same call) returns the proposal already on
   file.
3. Write the record (§2); journal `{ proposal: id }`; `jobs.notify(job, {
   kind: "proposal", id, url, title, state: "pending" })` when the run
   has a job.
4. Return `{ proposal: id, status: "pending", step, title, url }`.

MCP tools (`<server>_<tool>`) are not gated in v1: applying one later
needs the server's credential, which the launch's `ctx.mcp` holds for the
run's length and the caller may have minted for four hours (§9).

The gate is where the policy lives and nowhere else: not on the step def
(`graph/create-node` must stay runnable by a janitor), not in the prompt
(a model talks past prompts), not in the model's choice (hive's
`propose_*` are separate tools the model picks; here the model picks the
act and the workflow picks the gate). Peel's AgentKit calls the same
thing `ApprovalGate`, and the runner's rules there are a host concern,
as `params.approve` is here.

## 2. The record

`<dataDir>/proposals/<id>.json`, owner-only, the id crypto-random
(`elicitation.ts`'s rule: an id is an authorization where the key is off).

```ts
interface Proposal {
  id: string;
  step: string;                      // the registry step type, bare (the active version applies)
  input: unknown;                    // as parsed by the step's schema at proposal time
  rationale?: string;                // the model's, for the person
  title: string;                     // "<step description, first sentence>" unless the step's `describe` gives one (§7)
  status: "pending" | "accepted" | "rejected" | "applied" | "failed" | "expired";
  createdAt: string;
  expiresAt?: string;                // none by default; the gate takes `approveTtl` (§8)
  after?: string;                    // another proposal this one waits on (hive's parentProposalId)
  by: { workflow: string; runId: string; path: string; job?: string; session?: string; actor?: string; principal?: string };
  decision?: { action: "accept" | "reject"; by?: string; at: string; input?: unknown; reason?: string };
  result?: { output?: unknown; error?: string; at: string };
  reportedAt?: string;               // when the proposing session was told (§5)
}
```

A proposal is immutable but for `status`, `decision`, `result`,
`reportedAt`. An index is a `readdir`, as `GET /jobs` is: `listProposals({
job?, session?, runId?, status? })`, newest first. `expired` is computed
on read from `expiresAt` and written on the next touch.

On a graph workspace nothing is projected in v1. When something must
point at a proposal — "which proposals did this thread make", a Concept
page's history — it is one `StrutProposal` node with `IN_RUN`, the
projector's job, and a schema entry (`strut-schemas.ts`, the Ladybug
registry). Not before.

## 3. The doors

All behind the key; mutations behind `requireApiKey`; the actor from
`x-strut-actor` (`resolveActor`), recorded as `decision.by`.

| Method | Path | |
| --- | --- | --- |
| GET | `/proposals?job=&session=&runId=&status=` | the records, newest first |
| GET | `/proposals/:id` | one record |
| GET | `/workflows/:name/runs/:runId/proposals` | what one run proposed — the `run.end` field's twin, like `…/artifacts` |
| POST | `/proposals/:id/decide` | `{ action: "accept" \| "reject", input?: object, reason?: string, detach?: boolean }` → the record after the decision (and the apply, unless `detach`) |

`decide` on a decided proposal answers `409` with the record (hive's
`findPriorApproval`: idempotent, so a double click or a replayed POST
does nothing twice). `410` once expired. `409` with the parent's record
when `after` names a proposal that is pending or rejected (hive's
initiative → feature grouping). `accept` with `input` merges the person's
edits onto the recorded input (`{ ...input, ...edits }`, one level) and
re-parses with the step's schema; a bad merge is `400` and the proposal
stays pending. A `failed` apply keeps the decision; a second `accept`
retries (the person fixes the cause — a pod gone, a node renamed — and
clicks again).

Two steps for an agent that is asked "what is waiting on me": `proposal/list`
(`{ job?, session?, status? }` → the briefs) and `proposal/get`. Granted
to the orchestrator; it never decides (no step decides: a person does).

## 4. The apply

`applyProposal(rec, { registry, services, actor })`:

```ts
const def = registry[rec.step];                     // the ACTIVE version; a pin is not kept — a proposal names a type
const input = def.input.parse({ ...rec.input, ...(edits ?? {}) });
const ctx: StepContext = {
  runId: `proposal:${rec.id}`, path: `proposals/${rec.id}`, scope: {}, input,
  emit: async () => {}, services, registry,
  job: rec.by.job, actor, principal: rec.by.principal,
  mcp: await store.getRunMcp(rec.by.workflow, rec.by.runId),   // best effort; may be stale (§9)
};
```

`releaseWith`'s shape (jobs.ts), with three additions: the decider is
`ctx.actor` (what the step stamps as `created_by`, what a lab step sends
as `x-strut-actor`), the proposing run's principal binds `secrets`
(`forPrincipal`: the proposer's `GITHUB_TOKEN`, as the run itself would
have had) and pays (the Mothership link is minted for `proposal:<id>` as
for a run, `<workflow>.<step>` lineage from `by`), and `job` is the job's
so a step that takes a hold or writes a job file lands where the turn
would have. No run, no events, no journal: the record is the log. The
step's `withUsage` is taken onto `result` (so a paid apply shows its
cost); `withAccessedNodes` onto `result.nodes`.

The apply runs inside the `decide` request by default — a graph write
takes a moment, and hive's button today waits for `handleApproval` the
same way. `detach: true` answers `202` with the record at `accepted` and
posts the outcome by `job.update` (a job) and nothing else (no job: the
host reads the record). A decide that outlives the request is the host's
choice, as a detached verify is.

A sealed step is never in a registry grant, so never proposed. `exec` and
`bash`-shaped steps may be: the card shows the command, and whether that
is a card a host wants is the host's `approve` list.

## 5. What the agent learns

The decision is for code, and code applied it. The agent is told on its
next turn, without a turn of its own: the `agent` step, opening a session
(`session:` set), reads `listProposals({ session, status: not pending })`
with no `reportedAt`, puts one line each before this turn's prompt —

```
[proposal-result] p_3f9a accepted · graph/create-node "Add Concept: Rate limits" · applied
[proposal-result] p_41c0 rejected · graph/edit-node "Rename …" · "not that page"
```

— and stamps `reportedAt` once the turn commits (the turn line is the
commit; an uncommitted turn tells them again). The chat notifier's
pattern (`[run-notification]` on the next message) applied to sessions,
in code; `[captcha-answer]`'s form. A host that needs the agent to GO ON
after a decision (the proposal was the first step of three) forwards it
as a turn itself (`job/continue` with the line) — the `[artifact-event]`
path hive has, now optional rather than the only one.

An agent with no session (a one-shot) is told nothing; the record is
what the host reads.

## 6. What the host sees

**On `run.end`** (`specs/CALLBACKS.md` §6, new): `proposals: [{ id,
step, title, status, url, rationale? }]` — every proposal this run made,
resolved by strut from the records, never from the model's output. Absent
when the run made none. `GET …/runs/:runId/proposals` is the same list.

**Live** (`live-artifacts.md`'s event): `job.update { kind: "proposal",
id, url: "/proposals/<id>", title, state: pending | accepted | rejected |
applied | failed | expired, detail: { step, result? } }` — when a job run
proposes, and at each decision and apply. `kind` is in the deliverable
vocabulary, so a host that renders artifacts by kind renders a
`proposal` card from the URL the way it renders a `walkthrough` from
its manifest.

**The card** is the host's, rendered from `GET /proposals/:id`: `step`
picks the renderer — hive maps `graph/create-node` to the body it draws
for `graphNodeCreate` today (the payloads are the same fields:
`node_type`, `node_data`), `graph/edit-node` to its diff view, a step it
has no body for to a generic one (the step's description, the input as
fields — `GET /steps/:type/schema` gives the `FieldDesc`s, the same the
step editor draws). `rationale` under it. Approve and Reject POST
`decide` through the host's own route (hive: a route under
`/api/orgs/:login/strut/proposals/:id` that checks the conversation is
the clicker's, as the Fix button's does, and forwards with
`x-strut-actor`), and the host appends whatever row its transcript
wants.

**Strut's own UI** gets the same card: the run overview (`RunOverview`)
lists the run's proposals with Accept and Reject, the Jobs sidebar's
timeline shows a job's. The dev loop needs no host: a workflow with
`approve: [graph/create-node]`, a run, a click in the flyout, the node in
the graph.

## 6b. V1: Jamie's graph and Concept kinds as steps

What the orchestrator's `approve` list names in v1, and what each was in
hive (`src/lib/proposals/types.ts`):

| Jamie kind | Step | Input today |
| --- | --- | --- |
| `graphNodeCreate` | `graph/create-node` | `{ node_type, node_data, namespace? }` |
| `graphNodeEdit` | `graph/edit-node` | `{ ref_id, node_data?, properties_to_be_deleted?, namespace? }` |
| `graphTripletCreate` | `graph/create-triplet` | `{ source (ref_id \| type+data), target, edge_type, edge_data?, weight? }` |
| `graphBatchTripletCreate` | `graph/create-batch-triplet` | `{ triplets[] }` (hive caps at 25) |
| `graphNodeMove` | `graph/move-node` | `{ ref_id, edge_type, direction, from_ref_id?, to_ref_id }` |
| `graphEdgeDelete` | `graph/delete-edge` — **new** | `{ edge_ref_id }` or `{ source_ref_id, edge_type, target_ref_id }`, the pair `graph/edit-edge` takes |
| `graphNodeDelete` | `graph/delete-node` — **new** | `{ ref_id, namespace? }` |
| `conceptCreate` | `graph/create-node` with `node_type: Concept` (+ a `PARENT_OF` triplet for `parent`) | hive's `{ name, documentation, description?, parent?, kind? }` is `node_data` |
| `conceptUpdate` | `graph/edit-node` on the Concept | `documentation` in `node_data` |

Hive's payloads carry `workspaceId` / `workspaceSlug` to pick the swarm;
on strut the run IS on that swarm's strut, so they go. Hive's `meta`
(the `oldStr` / `newStr` preview for an edit, the edge list for a
delete) is what §7's `describe` would compute; v1's card shows the
input, and hive's card may read the node itself for the diff as its
tools do now.

The two new steps follow `move-node`'s shape over `src/graph`'s
writers, which each gain one method: the edge writer a `delete` (the one
delete model, `deletion.ts`: an in-scope edge is hard-deleted, never
muted — what `move()` already does to the old edge), the node writer a
`deleteNode` for any type (`deleted_at`, then its edges hard-deleted —
`nodeEngine.softDelete` without the `Domain_strut` guard the writer's
`softDelete` keeps for strut's own rows). Each step reports the node it
named with `withAccessedNodes`. A delete is the write with the least room for a
mistake, which is why hive's `graphNodeDelete` card lists the edges it
takes with it (`meta.edges`): the step's `describe` (§7) is where that
list belongs, and until then the host's card reads the neighbours.

## 7. One optional hook on a step

A card wants a title ("Add Concept: Rate limits") and, for an edit, a
preview (the old and new text; hive's `meta.oldStr/newStr`, which its
tools compute by reading the swarm at proposal time). The generic card
has the input; a good one has words. One optional method on a step def:

```ts
describe?(input, ctx): Promise<{ title?: string; summary?: string; preview?: { before?: string; after?: string } }>
```

called by the gate at proposal time, its result kept on the record
(`title`, `preview`). `graph/edit-node` reads the node and returns the
diff; `graph/create-node` returns `"Add <node_type>: <name>"`; a step
without one gets its description's first sentence. Not in v1 unless the
first card needs it; the generic card is enough to decide a node create.

*Built 2026-10-29 (the first card that needed it: `package/install`,
plans/marketplace.md §8):* `StepDef.describe(cfg, ctx) → { title?,
summary? }`, called by the gate in `proposeCall` once, best effort (a
throw leaves the description's first sentence), its `title` and `summary`
on the record and the brief (`run.end { proposals }`, `GET
…/runs/:runId/proposals`). No `preview` yet: the edit diff waits for the
graph steps to want it.

## 8. How it meets the rest of strut

| | |
| --- | --- |
| The automation steps' approval (`automation/*`, Peel's `approve` device request) | Unchanged in v1. The two are different asks: Peel's card is answered inside the turn (two broker round trips) and the step must act in the same turn, so it waits on the host step and `withStop`s when nobody answers. A proposal is for a decision that comes later, or never. They can meet: a gate option `approveWait: 60s` would long-poll the record before returning pending, and `automation/create` would then be `approve:`-gated instead of calling `approval()` itself. Later, once a second host wants it |
| `withStop` | A proposal does not stop the turn. A step that is BOTH gated and stopping is not a case: the gate returns before the step runs |
| Durable resume | The journal entry at `<agent path>#<call>` returns the proposal; a replayed session step (`step.replayed`) never reaches the gate. "Re-run from here" on the agent step makes a NEW turn and may propose again — a second record, as it would make a second job (`launchOnce`'s rule) |
| Sealed | A sealed step is not grantable, so not proposable. A proposal is not a publish: the closure rules do not apply |
| Claims | None. An applied proposal is not a run; nothing verifies it. A claim about the job it belongs to is the job's |
| The job | A proposal made under a job carries `by.job`; the apply gets `ctx.job`; `DELETE /jobs/:id` leaves proposals alone (they are not holds — nothing to release, and a person may still decide); the sweep too. `job/get` lists the job's pending proposals beside its holds |
| Peers | A proposal is made and decided on one strut; a `strut/run-workflow` peer run's proposals are the peer's, in the peer's `run.end`, forwarded in this step's output like its `nodes` |
| Expiry | None by default. The gate takes `approveTtl` (a duration) for a workflow whose proposals go stale — a reply to a message, a price |
| The graph | Nothing in v1 (§2) |
| Billing | A paid apply bills the proposing run's principal under `proposal:<id>` (§4); `run.end`'s `cost` does not include it (the run ended first); the record's `result.cost` does |
| The lab's propose/land pair (`code-change-propose` → `code-change-land`) | Stays: a PR is a proposal whose record is GitHub's. A later form is `git/apply` + `git/push` gated — the diff on the card — once the lab wants one mechanism |

## 9. The hosts — hive, the lab, Peel

Described as the contract they read. None is a work item here.

**The lab (stakgraph `mcp/src/lab`)** adds, like `JOB_SEED`, an
`ORCHESTRATOR_SEED`: `tools` (what Jamie does today that strut has as
steps — `graph/*` reads and writes, `job/*`, `memory/*`,
`meta/list-workflows`, `meta/run-workflow` for the explore and
brainstorm workflows), `approve` (the seven graph writes of §6b), and a
prompt section (the workspace, peers, the Concept pages). In v1 that is
all. Later, the `hive/*` steps for hive-owned rows —
`hive/create-initiative`, `hive/create-milestone`, `hive/create-prompt`,
`hive/update-prompt` — calling hive's API with `HIVE_URL` + `HIVE_API_KEY`
(`pods/steps/_shared.ts` `hiveApi`) and `x-strut-actor` for the decider,
on hive routes that take the org key (the pool-manager routes already
do); gated, so they are proposals, with nothing new in strut. Where a
swarm's graph is jarvis's, the lab may grant its `jarvis/*` twins
instead of `graph/*`; they lack the two deletes, which would be two more
lab steps over `/v2/nodes/:ref/single` and the edge route hive's
`handleApproval` calls.

**Hive** launches Jamie's turns as `orchestrator` runs: `POST
{lab}/workflows/orchestrator/run { input: { prompt, session:
<conversationId>, context: { line } }, callback, mcp?: [hive org MCP,
read tools: read_conversation, hive data] }`, kind `orchestrator_turn`
beside `job_turn`; the handler appends the text and artifacts as the job
handler does and one row per `proposals[]` entry (`source: { kind:
"proposal", url }`); `ProposalCard` renders from `GET {lab}/proposals/:id`
by `step`; Approve/Reject → hive's route → `decide` with the clicker as
`x-strut-actor`; the result row from the answer. `handleApproval`'s
graph and Concept branches go — strut's steps apply them — and its
initiative, milestone and prompt branches stay until the lab's `hive/*`
steps exist. The job wake (`invokeCanvasAgentOnJobTurn`)
is unchanged for jobs; a decision needs no wake. `read_conversation`'s
proposal status reads strut's record. Later, with no conversation JSON
holding proposals, hive's org MCP has no `propose_*` to offer:
stakwork/hive#5551 closes.

**Peel** has the `approve` device request for the automation steps and
needs nothing from this now; a proposal's card in the DM is the same
`AgentApprovalCard` drawn from `GET /proposals/:id` when Peel wants
gated writes (a Calendar event the agent drafts for later).

**What a host still cannot do** is approve a tool whose apply needs its
own live credential: an MCP tool of the launch. Three ways, none taken:
the decide request carries fresh `mcp` entries for the apply; hive keeps
applying its own kinds in `handleApproval` and only records the decision
on strut (`decide { action, applied: true }` — the record is strut's, the
effect the host's); or hive-owned rows become graph nodes. The lab steps
with the org key make the question moot for hive.

## 10. Left out

- **Hive-owned kinds** (initiative, milestone, prompt create and update):
  lab `hive/*` steps, after v1 (§9). Jamie keeps its own tools for them
  until then.
- **A pinned step version on the record.** A proposal names a bare type;
  the active version at decision time applies, as a hold's release step
  does. A workflow that pins (`type@v2`) proposes the pin's type without
  the pin.
- **Templated inputs between grouped proposals** (`{{ proposals.<parent>.result.id }}`
  in a child's input — hive's feature-under-initiative). `after` orders
  them in v1; the child names its parent's id only after the parent is
  applied, so the agent proposes the child on a later turn, told by §5.
- **A step's `describe` hook** (§7) until a card needs it.
- **MCP tools behind the gate** (§9).
- **`approveWait`** — a decision awaited inside the turn (§8).
- **A `StrutProposal` node.**
- **Strut's UI deciding for a job it does not show** — the Jobs sidebar
  lists a job's proposals; the run overview a run's; nothing lists every
  pending proposal on the server. `GET /proposals?status=pending` does.

## 11. Work items

One PR, in this order, each with its test; `plans/proposals.md` is its
header. Hive's and the lab's halves follow a pin bump.

1. `src/proposals.ts`: the record (write, read, list, expire), `gateTool`,
   `applyProposal`, the briefs; `proposals.test.ts` with a fake registry
   step — propose, journal replay, decide once, edits re-validated, a bad
   edit 400, reject runs nothing, `after`, expiry, a failed apply retried.
2. The agent step: `approve:` config (globs, the warning for an ungated
   grant), the wrap after `buildRegistryTools`, `rationale` on the
   schema, the `[proposal-result]` lines at session open and
   `reportedAt` at commit (`agent-session.test.ts`).
3. createStrut: the four routes, `run.end { proposals }` +
   `…/runs/:runId/proposals`, `job.update` emits, `ctx.services.proposals`
   (the record's reads for the steps), `proposal/list` + `proposal/get`;
   `createStrut.test.ts`'s key sweep covers the routes by itself.
4. `orchestrator.yaml` + `job.yaml`: `approve: "{{ params.approve }}"`,
   `params.approve: []`; `createStrut({ orchestrator: { approve } })`
   through `templateWithDelta`; `STRUT_HOST_CONFIG`'s `approve`.
4b. `graph/delete-edge` and `graph/delete-node` (§6b), over the edge and
   node writers, with `withAccessedNodes`; a case each in
   `graph-steps.test.ts` on the Ladybug file.
5. Web: a proposal card with Accept/Reject in `RunOverview` and
   `JobTimeline` (the generic body: step, fields from the schema,
   rationale); `kind: "proposal"` in `artifact-view.ts`.
6. Docs: `specs/API.md` (a Proposals section), `specs/CALLBACKS.md` §6,
   `AGENTS.md` (the layout row, a key-concepts paragraph), `plans/jobs.md`'s
   header pointing here.

## 12. Validation

- `npm test`: the suites above.
- By hand, no host: `STRUT_WORKSPACE_BACKEND=ladybug npm run dev`, a
  workflow with `agentTools: [graph/create-node]`, `approve:
  [graph/create-node]`, a prompt "add a Concept called Rate limits under
  Job"; the run ends with the proposal in the overview; Accept; the node
  is in the graph (`graph_get`); the run's `GET …/proposals` shows
  `applied` with `result.output.ref_id`; a second run on the same session
  starts with the `[proposal-result]` line (the transcript shows it).
- Resume: kill the server mid-turn after the proposal; auto-resume; the
  journal returns the same id, `GET /proposals` has one record.
- With hive, after the pin bump: a Jamie message that proposes a node
  shows the card from strut's record; Approve writes through strut, the
  conversation gets the result row, the swarm has the node, and hive's
  `handleApproval` graph branch is dead code.
