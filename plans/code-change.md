# Code change — hive's `propose_code_change` as a strut workflow

> **Status (2026-09-23): phase 1, strut half built** (branch
> `code-change-foundations`): `ctx.onRunEnd`, actor secrets, `git/checkout`
> + `git/diff`, `services.dataDir` — §3, tested offline against a local
> origin and smoke-tested over https. Next: the lab workflow (§4), then
> hive (§5). Phase 2 (§6) lands the PR.

Three repos take part. This document is the whole plan, kept here because
the engine pieces are the foundations everything else stands on; the mcp
and hive halves are described so the contract between them is in one place.

## 1. Problem

Hive's canvas agent has a `propose_code_change` tool for small changes
(`hive/src/lib/ai/codeChangeTools.ts`). It calls the workspace swarm's
`POST /repo/agent` with `ephemeral: true`, then POLLS `/progress` every 5 s
for up to ~10 minutes INSIDE the chat turn — a Vercel function with an 800 s
budget. A change that takes longer kills the turn; the user sees nothing.
The result is a `ProposalOutput` stored on the conversation transcript
(`SharedConversation.messages[].toolCalls[].output`); the user reviews the
diff in a card and clicks Approve, which dispatches a SECOND `/repo/agent`
run with `create_pr` whose prompt asks a model to "apply this diff verbatim"
and open the PR (already async, via a webhook + `Task.codeChangeClaim`).

Two things are wrong with the shape, beyond the timeout:

- The agent that makes the change is mcp's `get_context` loop — a fork of
  strut's `agent` step with its own confinement, its own tools, and no
  visibility in strut. The whole point of strut is to run agentic workflows,
  coding agents included.
- Hive is going to move many stakwork-era pieces onto strut. It needs a
  generic way to launch a run, hear the result without polling, and track the
  run — not a bespoke integration per workflow.

Strut already has the missing transport: `POST /workflows/:name/run
{ callback }` posts one `run.end` when the run settles
(`specs/CALLBACKS.md`). This plan is about everything around it.

## 2. Decided

| Question | Decision |
| --- | --- |
| Which agent makes the change | **Strut's core `agent` step**, native tools (`repo_overview`, `fulltext_search`, `bash`, the cwd-sandboxed editor, web, `file_summary` — the swarm image has git, ripgrep, gitleaks and the stakgraph CLI on PATH). Not mcp's `get_context` in process. Every tool call is a run event, the transcript is on `step.end`, cancel is cooperative between tool calls, spend is billed as the workflow's step |
| Why mcp needed a deny-list and strut does not | mcp's clone bakes the user's token into the shared checkout's remote URL; worktrees share that config, so its bash confinement pattern-blocks `push`/`commit`/`remote`/`gh`. A strut checkout **never writes a credential into the repository**: the token reaches git per command through the scrubbed child env and an inline credential helper. Pushing over HTTPS always needs a credential, so with a clean remote and a scrubbed env the agent's bash structurally cannot push or use gh |
| Git primitives | **Engine-shipped lib steps under `git/`**: `git/checkout` and `git/diff` now; `git/apply`, `git/push`, `github/create-pr` for landing. Generic — any coding workflow composes them; the lab seeds YAML only |
| Per-run cleanup for steps | **`ctx.onRunEnd(fn)`** — a run-scoped disposer any step can register, run by the runner's `finally` beside the services bag's `onRunEnd`. `git/checkout` removes its worktree with it on success, error and cancel |
| Credentials | **Actor secrets**: a per-actor store in strut, pushed by hive before a dispatch (the Mothership delegation pattern), resolved for the run's principal by the ordinary `secrets.get(NAME)` boundary. A run persists its `input` on `run.start`, so a token never rides in `input` |
| Which strut hive calls | **The org's default workspace swarm** — the same one the org strut view embeds (`resolveOrgSwarmWorkspaceForUser`). Strut has no tenancy, so one strut is one trust domain, which the org-wide embed already assumes. The choice lives in ONE hive function so it can change |
| Where the workflow lives | **mcp's lab**, `mcp/src/lab/code/`, seeded like every other experiment (category `code`, publisher `code-seed`). Phase 1 seeds one YAML and no custom steps |
| Hive tracking row | **A new `StrutRun` table.** `AgentRun` is the swarm `/repo/agent` inline-or-webhook arbitration row with a chat-text result; `StakworkRun` is shaped around a stakwork project id and its status mapping. `StrutRun` is one row per launch: token hash, workflow + strut run id for reconciliation, a `kind` that picks the completion handler, the run's `output` verbatim |
| Callback endpoint | **One.** Strut's body is fixed (`run.end`, `workflow`, `runId`, `status`, `output`, `error`, `durationMs`); only `output` varies and it is whatever the workflow's last step packs. The row's `kind` routes to a handler that validates `output` with its own zod schema. Routing comes from the row, never the payload |
| Delivering the diff to the card | **Patch the pending card's tool output in place** (the pattern `patchStoredCodeChangeResult` already uses for approval results) + a Pusher nudge + a client reconciler. Approval reads the diff from the `StrutRun` row, not the transcript |
| Phases | **Phase 1 = preview** (the timeout pain). **Phase 2 = land**, deterministic: `git apply` of the approved bytes, no model between approval and the PR |

## 3. Strut foundations (phase 1)

### 3.1 `ctx.onRunEnd(fn)`

`StepContext.onRunEnd?(fn: (info: RunEndInfo) => unknown): void`. The
runner keeps one disposer list per run (`Exec.disposers`), shared by
subflow frames and by steps executed as an agent's tool calls (same run).
`runWorkflow`'s `finally` runs them newest-first, each guarded, BEFORE the
services bag's `onRunEnd` — so a step's own resource is gone before the
consumer's per-run teardown looks. Absent outside the runner (unit tests),
like `registry` and `control`.

Not covered: a hard kill. A worktree left by a crash is the same residue as
any other in-process `finally` skipped (RUN_CONTROL_SPEC §5); a boot-time
sweep of `worktrees/<runId>` for runs no longer in flight is a follow-up.

### 3.2 Actor secrets

**Store.** `src/actor-secrets.ts`: `ActorSecretStore { get(actor, name),
set(actor, name, value), delete(actor, name), list(actor) }` over any
`SecretStore` — one entry per (actor, name), encoded as
`A_<hex(actor)>_<NAME>` (actors carry `-`, which secret names refuse; the
same trick `mothership.ts` uses). The standard server keeps it in a THIRD
encrypted `FileSecretStore` file, `actor-secrets.json`, beside
`secrets.json` and `mothership.json`; memory when runs are in memory;
injectable via `createStrut({ actorSecretStore })`.

**Resolution is invisible to steps.** `SecretsCapability` gains an optional
`forPrincipal(principal)`. The runner, once per run, binds the bag's
`secrets` to the run's principal when both exist, so inside that run
`ctx.services.secrets.get("GITHUB_TOKEN")` resolves the principal's value
first, then the deployment's, then env. Every consumer inherits it with no
change: the `secretsEnv` of `agent` and `exec`, every lib step's
`cfg.token ?? secrets.get(NAME)`, cassette scrubbing. An automation runs as
the workflow's owner, so it reads the owner's secrets; the builder's runs
read the chat actor's; a step granted through `agentTools` reads the run's.

**Routes** (behind `requireApiKey`; 501 when the consumer injected its own
`secrets`, like `/secrets`): `PUT /actors/:actor/secrets/:name { value }`,
`DELETE /actors/:actor/secrets/:name`, `GET /actors/:actor/secrets` (names +
timestamps, never values). Never listed by `GET /secrets`, the Secrets
dialog, or the builder's `list_secrets` — an actor's secrets are not the
deployment's.

**Hive pushes before dispatch**, a twin of `ensureStrutDelegation`: the
user's source-control token for the org as that actor's `GITHUB_TOKEN`.
Push-before-dispatch handles rotation; the delegations cron can expire and
reconcile these later.

### 3.3 `git/checkout` and `git/diff`

Lib steps in `src/steps/lib/git/`, shelling out through
`ctx.services.shell` (recordable, scrubbed env). Local blobs live under
`ctx.services.dataDir` (new on the standard bag: the deployment's data
dir; a bare in-code bag falls back to the OS temp dir).

`git/checkout` — a fresh, isolated working copy of a repo at a ref:
- **Cache**: a bare, credential-free repository per remote under
  `<dataDir>/repos/<host>/<owner>/<repo>.git` (`remote.origin.url` holds the
  plain URL). Cloned on first use, fetched (`+refs/heads/*:refs/heads/*`,
  pruned) after; one in-process mutex per cache so concurrent runs of the
  same repo serialize their fetches.
- **Credential**: the secret NAMED by `tokenSecret` (default
  `GITHUB_TOKEN`; actor-scoped once the run has a principal). There is
  deliberately no `token` config: a step's config is recorded on
  `step.start`, so a value there would be in the log — a NAME is what a
  workflow may carry. The value goes ONLY into the child env
  (`STRUT_GIT_TOKEN`) and is read by an inline `credential.helper` passed
  with `-c`; the helper list is reset first (`-c credential.helper=`) so no
  keychain ever stores it; `GIT_TERMINAL_PROMPT=0` so nothing hangs. Never
  in args, never in output, never in the URL.
- **Worktree**: `git worktree add --detach <dataDir>/worktrees/<runId>/<repo>
  <sha>` from the cache; `ref` defaults to the remote's HEAD
  (`ls-remote --symref`), or a branch, tag or sha. Removed by
  `ctx.onRunEnd` (`worktree remove --force` + `worktree prune`).
- **Output**: `{ path, sha, ref, branch, repo, host, url }`.
- Found while building: `generateRunId` was a bare `Date.now()`, so two
  runs launched in the same millisecond shared an id — a run directory, an
  events log, and now a worktree dir. It is monotonic per process now.

`git/diff` — what a working copy changed, as one unified diff:
- `git add -A` (so new files count; the worktree is throwaway), then
  `diff --cached --name-only` and `diff --cached --no-color`.
- Caps (`maxFiles` 200, `maxBytes` 2 MB, matching mcp): over either throws.
- Secret scan: `gitleaks protect --staged` when the binary is on PATH — a
  finding throws (the run ends `error`, the message names the rule and
  file, never the match); `scanned: false` when gitleaks is absent.
- **Output**: `{ diff, files, filesChanged, sha256, scanned }`.

### 3.4 Later, not phase 1

- A per-run sandbox. Today the agent's `bash` runs on the host with a
  scrubbed env; it can read the filesystem, as mcp's repo agent can (its
  blocklist only covers its own checkout path). Parity now; containment is
  an engine foundation of its own (ENV_SPEC territory).
- mcp's code-graph tools for the agent — seeded as lab steps and granted
  with `agentTools`, the way jarvis steps already are.
- `git/diff --binary` (a diff with binary changes cannot be re-applied).
- The orphan-worktree sweep (§3.1).

## 4. The workflow (mcp lab, phase 1)

`mcp/src/lab/code/workflows/code-change-propose.yaml`, seeded by
`code/seed.ts` under category `code`. No custom steps.

```yaml
name: code-change-propose
# Input:  { repo: "https://github.com/owner/repo", prompt }
# Output: the `result` pack below — what hive's callback receives as `output`.
steps:
  - id: checkout
    type: git/checkout
    config: { repo: "{{ input.repo }}" }

  - id: change
    type: agent
    config:
      cwd: "{{ checkout.path }}"
      prompt: "{{ input.prompt }}"
      system: "{{ params.system }}"
      model: "{{ params.model }}"
      maxSteps: "{{ params.maxSteps }}"

  - id: diff
    type: git/diff
    config: { path: "{{ checkout.path }}" }

  - id: result
    type: pack
    config:
      diff: "{{ diff.diff }}"
      diffSha256: "{{ diff.sha256 }}"
      filesChanged: "{{ diff.filesChanged }}"
      files: "{{ diff.files }}"
      baseBranch: "{{ checkout.branch }}"
      baseSha: "{{ checkout.sha }}"
      cost: "{{ change.cost }}"

params:
  model: claude-sonnet-5
  maxSteps: 60
  system: |-
    You are making one focused change in this repository ...
```

`params.system` is the experiment surface. "Nothing to propose" is a
SUCCESS run with `filesChanged: 0`; a secret in the diff or a cap overrun
is an `error` run with a plain message; a stopped run is `cancelled`.

## 5. Hive (phase 1)

**`StrutRun`** (table `strut_runs`), `StrutRunStatus { PENDING, SUCCESS,
ERROR, CANCELLED, LOST }`:

```
id, tokenHash, workspaceId, userId, kind, workflow, strutRunId?,
status, output Json?, error?, durationMs?, conversationId?, proposalId?,
createdAt, settledAt?, updatedAt
@@unique([workflow, strutRunId])  @@index([status, createdAt])
```

**`src/services/strut-runs.ts`**: `dispatchStrutRun`, `completeStrutRun`,
`reconcileStrutRuns`; one handler per `kind` beside it. Dispatch: create the
row, `ensureStrutDelegation` + push the actor's `GITHUB_TOKEN`, `POST
{lab}/workflows/<name>/run { input, callback: { url } }` with `x-api-token`
+ `x-strut-actor`, refuse a 202 without `callback: true`, store
`strutRunId`. The target swarm comes from one function (the org default).

**`POST /api/strut-runs/webhook?id=&token=`** (`access: "webhook"`): rate
limit, constant-time token compare against the row, idempotent claim
PENDING → terminal, store `status`/`output`/`error`/`durationMs`, then the
kind's handler. 5xx on a handler failure so strut retries; every handler is
idempotent. **`GET /api/cron/strut-runs-reconcile`**: rows PENDING past a
threshold → `GET {lab}/workflows/:name/runs/:runId` → the same completion,
or `LOST`.

**`propose_code_change`**: validate as today (membership, org, repo), then
dispatch `kind: "code_change_propose"` and return a PENDING
`ProposalOutput` carrying `proposalId` + `strutRunId` (the card shows
"Generating diff…" with a link to the run in the org strut view). The
handler runs hive's own hygiene on `output.diff` (parse, caps, secrets — as
now), patches the stored tool output in place, nudges Pusher; the client
reconciler flips the card. Approval reads the diff from the row by
`proposalId` and checks `originatorUserId` there. The Stop button
(`/api/ask/abort`) also cancels the conversation's pending strut runs
through `POST {lab}/workflows/:name/runs/:runId/cancel`.

**Security finding to close with this** (unverified end to end): the
conversation PUT route appears to let any org member append messages to a
shared room, and approval takes the newest transcript row matching the
`proposalId`. Reading the approved diff from the server-written row closes it.

## 6. Phase 2 — landing

Strut: `git/apply` (applies a unified diff with `--index`, verifies the
sha256 of the bytes it applied), `git/push` (commits as the token's
identity and pushes `HEAD` to a new branch — token per command, as
checkout), `github/create-pr` (Octokit beside `github/fetch-pr`; token via
`secrets`, so the PR is authored by the user).

Lab: `code-change-land` = `git/checkout → git/apply → git/push →
github/create-pr → pack { url, number, branch, headSha }`. A moved base
fails `git apply` honestly instead of being "fixed" by a model.

Hive: approval dispatches `kind: "code_change_land"`; its handler feeds the
existing `persistLandedPr` / `markClaimRunFailed` path. Hive keeps its
identity check (the token's login must be the approver) and its rate limits.

## 7. Order of work

1. **Strut** (this branch): `ctx.onRunEnd`; actor secrets; `git/checkout`,
   `git/diff`; `services.dataDir`; tests offline against a local bare repo;
   AGENTS.md.
2. **mcp**: bump the pinned strut; `lab/code/` seeder + YAML; run it from
   the strut UI on a swarm with a request-bin callback.
3. **Hive**: `StrutRun`, the webhook + cron, `dispatchStrutRun`, the
   actor-secret push, the tool rewrite, the card, abort. Behind the existing
   `code_change` org gate.
4. **Phase 2** as §6.
