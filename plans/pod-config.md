# Pod config — a job fixes its pod, then the pool

> **Status (2026-10-14): proposed, unbuilt.** Written after a review of
> staklink's `/repair` and `/agent` (`staklink@2791da6`), the lab's `pod/*`
> steps and `Pod` Concept (`stakgraph@2cba91ef`), and hive's pool config +
> diagnose API (`hive@5948ee29f`: #5493, #5507, `docs/pool-config-agent-api.md`)
> and its pod-repair cron. Rulings already made in conversation: repair
> happens POD-LOCAL first and is PROMOTED to the pool once it is a fix; a
> secret the person pastes goes through strut's own secret page (any strut
> caller can use it, not only hive). Companions this does not reopen:
> `jobs.md` (holds, §6), `elicitation.md` (the secret page and its rule),
> `job-index.md`, `code-change.md` §3.2 (actor secrets).

## 1. Goal

A job's `work` agent claims a pod, runs the app in it, and makes it run the
way the person's request needs: with mocks, with a new feature, with an env
var that points one integration at a real provider, with an extra container
(rustfs for an app that uploads to S3). When the pod was broken, the fix
reaches every future pod of the workspace. And the next job starts out
knowing what this one learned.

## 2. What is there today

- **staklink `/repair`** is `/agent` with a fixed prompt, a fixed goal (the
  pm2 `frontend` app runs) and an XML parser that returns whole config files
  (`src/agent/repair.ts`, `src/proxy/server.ts:995`). Hive's cron
  (`src/services/pod-repair-cron.ts`) reaches it through a Stakwork workflow
  and saves the returned `containerFiles`; its memory is earlier runs' file
  dumps, passed back as `history`. Built for first setup; it has no notion of
  "run this part against Stripe".
- **staklink `/agent`** is what `pod/agent` already calls, with the job as
  goose's session. A prompt can ask it for anything `/repair` does.
- **Hive's pool config API** (#5493): `GET`/`PUT
  /api/workspaces/{slug}/stakgraph` with an org key — `services`, env vars
  (masked on read, a masked value written back keeps the stored one),
  `containerFiles` (base64), CPU/memory — and a `rollout` to poll after a
  PUT (`rolling | ready | failed`, keyed by `changeId`). `pm2.config.js` is
  regenerated from `services`.
- **Hive's diagnose API** (#5507): `pool/status`, `pool/pods` (with
  `generation: new | old`), `pool/{podId}/processes`, `pool/{podId}/logs`,
  log values redacted.
- **The lab's `pod/*`**: claim, release, latest, agent, agent-start,
  agent-status, diff, branch-diff, push, run-tests. Nothing reads or writes
  the pool config, and nothing sets an env var.

What a pod changes inside itself dies with the pod. The pool config in hive
is the only thing that survives, and a PUT to it recreates every unused pod
of the workspace — everyone's.

## 3. The split

| In the pod — goose, through `pod/agent` | In strut — the job agent |
|---|---|
| Read logs, edit the pod's pm2 / compose files, `staklink reload`, start an extra container, try things fast | Ask the person for a secret (§4) and put it on the pod (`pod/env`) |
| Mock code and fixtures in the repository (shipped as a PR by `pod/push`) | Judge the result: `browser-explore`, `pod/run-tests` |
| Say what it changed and why | Promote a fix to the pool, verify it on a FRESH pod (§5) |
| | Write what was learned (§6) |

`/repair` is not an entrypoint for the job. What it knows — `staklink
reload`, the `INSTALL_COMMAND` / `BUILD_COMMAND` / `PRE_START_COMMAND` /
`POST_START_COMMAND` / `REBUILD_COMMAND` env vars, binding to `0.0.0.0`, a
dummy `frontend` when there is none, the Android conventions, never `pm2 stop
all` — moves into a `Pod Config` Concept (§7) the job agent puts into the
task it hands goose. `/repair` stays for hive's cron until §9.

A Dockerfile change cannot be judged inside the pod built from it: it goes
straight to §5.

## 4. Secrets — the person's key, never a model's

The example: an AI chat app cloned to a pod with no `ANTHROPIC_API_KEY`. The
agent asks for one, the person pastes it, the live app is tested against the
real provider.

1. **`job/request-secret { name, reason }`** (strut, `steps/lib/job/`,
   granted in `job.yaml`). It records an open request on the JOB's record —
   `{ elicitationId, name, reason, principal, createdAt }`, one per name,
   a newer ask for the same name replaces it — and returns `{ url,
   elicitationId, exists }`. `url` is relative, `?job=<id>&elicit=<eid>`,
   like the chat's `request_secret` (`elicitation.md`); `exists` says the
   person already has one under that name, so the agent can skip asking.
   The agent reports the link as an artifact (`{ id: "secret-<NAME>", kind:
   "url", title: "Add <NAME>" }`) with an `ask`, and ends its turn.
2. **The page** is the web UI's `ElicitationForm` in its secret mode, opened
   on `?job=&elicit=` (both already deep-link params, `web/src/embed.ts`).
   It posts **`POST /jobs/:id/elicitations/:eid/secret { value }`**: the name
   comes from the record, never the request; the value is written as an
   ACTOR secret of the principal recorded at ask time
   (`ActorSecretStore`, `actor-secrets.json`); the request is closed; `by` is
   stamped. 404 once closed. Behind `requireApiKey`, and as with the chat the
   id is crypto-random because with the key unset the link is the
   authorization to write one named secret.
3. **The next turn** — the person says "done", or hive's `ask` reply — the
   agent calls **`pod/env { control, sealed, app?, set: [{ name, secret }]
   | [{ name, value }] }`** (lab). A `secret` entry is resolved through
   `ctx.services.secrets`, which the runner binds to the run's principal,
   so it finds the person's key; a `value` entry is plain config
   (`MOCK_PAYMENTS=1`). Only names ride in the step's config, the
   `tokenSecret` rule of `git/*`, and cassette scrubbing covers the value.
   The step posts to staklink (§8) and returns the names it set.

Why the actor store and not the pod: the pod is released between jobs, and
a key pasted into one would be pasted again for the next. The person's key
stays theirs, across jobs and pods, and bills them.

**What this does not hide.** The strut agent never sees the value. Goose
does have a shell in the pod where the variable lives, and a `printenv` or
a log line puts it in goose's transcript and the gateway's logs. staklink's
log redaction narrows it; the Concept tells goose not to print it. A pod is a
sandbox the key is placed into, and the page should say so in one line.

**A secret is never promoted.** Writing a person's key into the workspace's
pool would run every pod, everyone's tasks, on their key and their bill.
`pod/config-set` refuses an env var whose name `pod/env` set from a
`secret`; a workspace-wide key is a person setting it in hive.

## 5. Promotion — pod-local fix → every pod

1. The fix works in the pod and the agent has judged it.
2. **`pod/config { control?, workspace }`** (lab) reads hive's stored config
   (`GET …/stakgraph`, `containerFiles` decoded) and, with a claimed pod,
   the pod's LIVE config (§8), and returns both with a per-file diff and the
   `services` change the live pm2 file implies. `pm2.config.js` is
   regenerated from `services`, so promotion is always expressed as a
   `services` edit, never the raw file.
3. The agent ends its turn with an `ask`: the diff, what it verified, "apply
   to every pod of the workspace?". A pool PUT is outward-facing; the person
   decides.
4. On yes, **`pod/config-set { workspace, services?, env?, containerFiles?,
   wait? }`** (lab): `PUT …/stakgraph` (env masked values round-trip as
   stored), then polls `rollout` for its `changeId` until `ready` or
   `failed` (default wait 20 min; on a timeout the error names the
   `changeId`, and `pod/config` reads the rollout).
5. **`pod/claim { workspace, fresh: true }`** claims a pod created after the
   push (hive: `?generation=new` on claim-pod, 409 when none is ready yet).
   The job holds two pods for this; the second is released at the end.
6. The agent runs the same check on the fresh pod. This is the step that
   catches state made by hand: the bucket goose created in rustfs exists
   only on the first pod, and the fix is not done until creating it is in
   config (`POST_START_COMMAND`, or an init service in compose).
7. Then §6, and `pod/release` the fresh pod.

## 6. Memory

The config in hive is WHAT the fix is. Why, and how to repeat it, goes in a
per-workspace Concept, **`Pod Setup — <workspace>`**, under `Pod Config`:
what broke and what fixed it; the integrations that need a person's secret
(names only) and the env var that switches each from mock to real; the extra
containers and what creates their state; what a fresh pod still lacks.
Written with `graph/create-node` / `graph/edit-node` (granted to the job for
this — today it has graph reads only) when a promotion verifies, and when a
pod-local setup worth repeating ends a job without one. Read before
`pod/claim`: the next AI-chat job asks for `ANTHROPIC_API_KEY` on its first
turn instead of discovering it on its third.

## 7. The Concepts

- **`Pod Config`** (new, under `Pod`): §3's in-pod knowledge from
  `repair.ts`, §4's secret flow, §5's promotion steps and their `ask`, §6's
  memory note, and "a secret is never promoted".
- **`Pod`**: one paragraph pointing to `Pod Config` when the app does not
  run, or must run differently for this request.

## 8. staklink

- **`PUT /env { app?, set: { NAME: value } }`** — an overlay file beside the
  pod config (`/workspaces/.pod-config/env.overlay.json`, 0600), merged into
  the named app's env (every app when omitted) at start and on `staklink
  reload`, then a restart of that app. An empty value removes a name.
- **`GET /pod-config`** — the live `pm2.config.js`, `docker-compose.yaml`,
  `Dockerfile` as they are on the pod, plus the overlay's NAMES, never its
  values. What `pod/config` diffs against hive.

Both behind the pod's existing auth, like `/agent`.

## 9. Order

1. strut: `job/request-secret`, `POST /jobs/:id/elicitations/:eid/secret`,
   the job-mode secret page; grant in `job.yaml`. Tests: the no-leak test of
   `elicitation.md` over the job record, run log, callback and responses.
2. staklink: §8.
3. hive: `?generation=new` on claim-pod.
4. lab: `pod/env`, `pod/config`, `pod/config-set`, `fresh` on `pod/claim`,
   `graph/create-node` + `graph/edit-node` in the lab's job grants, the
   `Pod Config` Concept, strut pin bump.
5. Live on swarm38: the AI-chat case (secret → pod → browser-explore) and a
   rustfs case through promotion and a fresh pod.
6. Retire hive's pod-repair cron → Stakwork → `/repair`; then `/repair`
   itself. Hive's cron could later launch a `job` instead — not this plan.

## 10. Proposed rulings — confirm before building

1. The secret request lives on the JOB record and the value is the
   principal's ACTOR secret (not the deployment store, as the chat's is).
2. The link ends the turn; the person's reply starts the next. No strut
   wake-up of a job (hive launches turns, `pod-agent-no-wake`).
3. `pod/env` writes a staklink overlay, not the pod's pm2 file, so a
   promotion diff never carries a value.
4. Promotion always asks first, even for config with no secret in it.
5. Verification of a promotion needs a fresh-generation pod, the job
   holding two pods for the while.
6. Memory is one Concept per workspace, written by the job agent through the
   general graph write steps, not a pod-specific step.
