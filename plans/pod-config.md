# Pod config — a job fixes its pod, then the pool

> **Status (2026-10-14): BUILT, §8 items 1–3 — stakwork/staklink#145
> (`GET /pod-config`), stakwork/hive#5511 (`claim-pod?generation=new`),
> stakwork/stakgraph#1784 (`pod/config`, `pod/config-set`, fresh claims,
> the `Pod Config` page); item 4, the live run on swarm38, waits for them to
> deploy. Rulings confirmed the same day (§10); what the build decided
> beyond the text is §11.** Written after a review of
> staklink's `/repair` and `/agent` (`staklink@2791da6`), the lab's
> `pod/*` steps and `Pod` Concept
> (`stakgraph@2cba91ef`), and hive's pool config + diagnose API
> (`hive@5948ee29f`: #5493, #5507, `docs/pool-config-agent-api.md`), its
> pod-repair cron and its artifact events. Rulings already made in
> conversation: repair happens POD-LOCAL first and is PROMOTED to the pool
> once it is a fix; one generic `Pod Config` Concept, no per-workspace one
> (a later addition at most) — a job finds an earlier repair through the
> job index; secrets are V2 (§9): v1 is getting pods set up; and v1 takes
> the simple, flexible option wherever one will do — more waits for a case
> that needs it. Companions this does not reopen: `jobs.md` (holds, §6),
> `job-index.md`, `elicitation.md`.

## 1. Goal

A job's `work` agent claims a pod, runs the app in it, and makes it run the
way the person's request needs: with mocks, with a new feature, with an env
var flipped, with an extra container (rustfs for an app that uploads to S3).
When the pod was broken, the fix reaches every future pod of the workspace,
and a later job can find how it was done.

## 2. What is there today

- **staklink `/repair`** is `/agent` with a fixed prompt, a fixed goal (the
  pm2 `frontend` app runs) and an XML parser that returns whole config files
  (`src/agent/repair.ts`, `src/proxy/server.ts:995`). Hive's cron
  (`src/services/pod-repair-cron.ts`) reaches it through a Stakwork workflow
  and saves the returned `containerFiles`; its memory is earlier runs' file
  dumps, passed back as `history`. Built for first setup.
- **staklink `/agent`** is what `pod/agent` already calls, with the job as
  goose's session. A prompt can ask it for anything `/repair` does.
- **Hive's pool config API** (#5493): `GET`/`PUT
  /api/workspaces/{slug}/stakgraph` with an org key — `services`, env vars
  (masked on read, a masked value written back keeps the stored one),
  `containerFiles` (base64), CPU/memory — and a `rollout` to poll after a
  PUT (`rolling | ready | failed`, keyed by `changeId`). `services` and the
  env list, when sent, replace the stored ones whole. `pm2.config.js` is
  regenerated from `services` with the env values in it, and
  `containerFiles` come back unmasked, so the stored file shows what the
  masked lists hide. A pm2 field beyond a service's `scripts`, `port`,
  `cwd`, `env` and `interpreter` rides in its `advanced`.
- **Hive's diagnose API** (#5507): `pool/status`, `pool/pods` (with
  `generation: new | old`), `pool/{podId}/processes`, `pool/{podId}/logs`,
  log values redacted.
- **Hive's artifact events**: a GitHub event on a pull request a job
  reported — its merge — becomes a turn on that job
  (`src/services/strut-jobs/artifact-events.ts`).
- **The lab's `pod/*`**: claim, release, latest, agent, agent-start,
  agent-status, diff, branch-diff, push, run-tests. Nothing reads or writes
  the pool config.

What a pod changes inside itself dies with the pod. The pool config in hive
is the only thing that survives, and a PUT to it recreates every unused pod
of the workspace — everyone's.

## 3. The split

| In the pod — goose, through `pod/agent` | In strut — the job agent |
|---|---|
| Read logs, edit the pod's pm2 / compose files and env, `staklink reload`, start an extra container, try things fast | Judge the result: `browser-explore`, `pod/run-tests` |
| Mock code and fixtures in the repository (shipped as a PR by `pod/push`) | Promote a fix to the pool, verify it on a FRESH pod (§4) |
| Say what it changed and why | Report it so a later job finds it (§5) |

`/repair` is not an entrypoint for the job. What it knows — `staklink
reload`, the `INSTALL_COMMAND` / `BUILD_COMMAND` / `PRE_START_COMMAND` /
`POST_START_COMMAND` / `REBUILD_COMMAND` env vars, binding to `0.0.0.0`, a
dummy `frontend` when there is none, the Android conventions, never `pm2 stop
all` — moves into the `Pod Config` Concept (§6), which the job agent puts
into the task it hands goose. `/repair` stays for hive's cron until §8.

A Dockerfile change cannot be judged inside the pod built from it: it goes
straight to §4.

## 4. Promotion — pod-local fix → every pod

1. The fix works in the pod and the agent has judged it. A fix that needs
   repository changes — a start script, a seed, mock code, shipped by
   `pod/push` as a PR — waits for that PR to merge: until then a fresh pod
   lacks the code the config relies on. The merge reaches the job as a
   turn (hive's artifact events, §2), and promotion goes on from there.
2. **`pod/config { control?, sealed?, workspace }`** (lab) reads hive's
   stored config (`GET …/stakgraph`, `containerFiles` decoded) and, with a
   claimed pod, the files the pod runs from (§7), and returns both with a
   per-file diff. The plumbing stays flexible:
   - env values in both pm2 files are masked the way hive masks them
     (`ab******yz`), so an unchanged value diffs equal and no value reaches
     the run log or the model;
   - a compose file is `docker-compose.yml` whichever name it has on the
     pod (`.yml` or `.yaml`);
   - `devcontainer.json` is left out: nothing here edits it.

   No pm2 parser: the agent reads the pm2 diff and writes the change as
   `services` edits itself (ruling 3), and the fresh pod (step 6) checks the
   file hive regenerates from them.
3. The agent ends its turn with an `ask`: the diff, what it verified, "apply
   to every pod of the workspace?". A pool PUT is outward-facing; the person
   decides. The `Pod Config` Concept says so; no step checks. With a PR
   pending, the ask can go out with it ("once this merges, apply to every
   pod?"), and the merge's turn promotes on that yes.
4. On yes, **`pod/config-set { workspace, services?, env?, containerFiles?,
   wait? }`** (lab) takes only what changes, by name: `services` and `env`
   as maps — a name set to a value is written (a service as a whole),
   `null` removes it, a name left out stays as stored — and
   `containerFiles` as text (either compose name lands as
   `docker-compose.yml`). It reads the stored config right before its `PUT
   …/stakgraph` and writes the merged lists, so an edit someone made since
   the agent's read survives (masked env values round-trip as stored).
   Then it polls `rollout` until its `changeId` — or a later one, whose
   push carries hive's whole stored state, this change included — is
   `ready` or `failed` (default wait 20 min; on a timeout the error names
   the `changeId`, and `pod/config` reads the rollout).
5. **`pod/claim { workspace, fresh: true }`** claims a pod created after the
   push (hive: `?generation=new` on claim-pod, 409 when none is ready yet,
   which the step reports like an empty pool: try again shortly). The job
   holds two pods for this; the second is released at the end.
6. The agent runs the same check on the fresh pod. This is the step that
   catches state made by hand: the bucket goose created in rustfs exists
   only on the first pod, and the fix is not done until creating it is in
   config (`POST_START_COMMAND`, or an init service in compose). When the
   check fails, the agent fixes forward (another promotion) or reverts its
   edits, and says which.
7. §5, then `pod/release` the fresh pod.

## 5. Finding an earlier repair

No memory of its own: the job index already is one. A turn that promoted a
fix — or set a pod up in a way worth repeating, promoted or not — reports
it as a deliverable with a stable id:

```
{ id: "pod-config", kind: "diff", title: "Pod config — <workspace>",
  summary: "<what broke, what fixed it, what a fresh pod still lacks>",
  content: <the promoted diff> }
```

`job/list { q: "pod config <workspace>" }` matches deliverable titles and
summaries, so a later job finds it; `job/get` gives the diff and the thread,
whose transcript says how it got there. The `Pod Config` Concept tells the
agent to look before claiming a pod for a workspace whose app it has not run
yet, and to report the deliverable after. The fix itself is in hive's config
already; what the look-back adds is the why.

A per-workspace Concept can come later if the index is not enough — for
instance once a summary has to outlive the jobs that wrote it.

## 6. The Concepts

- **`Pod Config`** (new, under `Pod`, generic — nothing in it names a
  workspace, a framework it assumes, or a domain): §3's in-pod knowledge
  from `repair.ts`; look for an earlier `pod-config` deliverable first;
  promote what every job on the workspace needs (the app does not run, a
  service is missing) and keep what only this request needs pod-local,
  reported but not promoted; a fix that needs a PR waits for its merge;
  promotion as §4 with its `ask`; verify on a fresh pod; report §5's
  deliverable; no credential is promoted (§9).
- **`Pod`**: one paragraph pointing to `Pod Config` when the app does not
  run, or must run differently for this request.

## 7. staklink

- **`GET /pod-config`** — the files the pod runs from, as they are: the pm2
  config staklink loads, the compose file under whichever name it has, the
  `Dockerfile`, each with its path. What `pod/config` diffs against hive;
  the lab normalizes the names. Behind the pod's existing auth, like
  `/agent`.

## 8. Order

1. staklink: `GET /pod-config`.
2. hive: `?generation=new` on claim-pod.
3. lab: `pod/config`, `pod/config-set`, `fresh` on `pod/claim`, the
   `Pod Config` Concept, the `Pod` paragraph.
4. Live on swarm38: a workspace whose pod does not run (fix → promote →
   fresh pod), a rustfs case (extra container, its state in config) and a
   fix that needs a PR (promoted on its merge); then a second job on the
   same workspace finds the first one's `pod-config`.
5. Retire hive's pod-repair cron → Stakwork → `/repair`, then `/repair`
   itself, once something else does a new workspace's first setup — today
   only the cron does. Hive's cron launching a `job` is the likely one; not
   this plan.

## 9. V2 — secrets (needs more thought)

Until then no credential is promoted: when the app needs one, the agent
says which, and a person sets it in hive.

The case: an AI chat app cloned to a pod with no `ANTHROPIC_API_KEY`; the
agent asks for one and tests the live app against the real provider, without
the key ever passing through a model. The shape discussed, to be thought
through before building:

- **Ask:** a `job/request-secret { name, reason }` step records an open
  request on the job and returns a link to strut's own secret page
  (`?job=&elicit=`, the chat's `request_secret` page in job mode) — strut's
  page, so every strut caller can use it, not only hive. The link ends the
  turn; the person's reply starts the next.
- **Store:** `POST /jobs/:id/elicitations/:eid/secret { value }` writes it
  as the person's ACTOR secret, so it outlives the pod and the job.
- **Place:** a `pod/env { set: [{ name, secret }] }` step resolves it
  through `ctx.services.secrets` (bound to the run's principal) and posts it
  to a staklink overlay file (`PUT /env`), merged into the app's env at
  start and reload — never into the pm2 file, so a promotion diff never
  carries a value.

Open questions: goose has a shell in the pod where the variable lives, so a
`printenv` puts the value in goose's transcript and the gateway's logs —
what does the page promise, and what does staklink redact? Whose key is it
when the person answering is not the job's principal? A secret is never
promoted to the pool (it would run everyone's pods on one person's key and
bill) — is a workspace-wide key always a person setting it in hive?

## 10. Rulings — confirmed 2026-10-14

1. Promotion always asks first — a convention in the `Pod Config` Concept;
   no code enforces it.
2. Verifying a promotion needs a fresh-generation pod, the job holding two
   pods for the while.
3. Promotion goes through `services`, never a raw `pm2.config.js`.
4. The look-back is the job index over a `pod-config` deliverable; no new
   store, no per-workspace Concept in v1.
5. A fix that needs repository changes is promoted once its PR merges.
6. `devcontainer.json` is never edited; a compose file is one file under
   either name.
7. Secrets are V2 (§9).

## 11. Built — what the code decided beyond the text

Choices made while building, open to review:

1. **A tag on the masked pm2 values.** Two different values can mask
   alike (`http://localhost:3000` and `:4000` are both
   `ht*****************00`), so in the pm2 files `pod/config` shows hive's
   mask plus a six-hex keyed hash, `ht…00#3fa9c1`, the key random per read
   and never kept: equal values diff equal, a changed port shows. `services`
   and `env` keep hive's exact masks, since those are written back. A
   service's own config vars (PORT, the `*_COMMAND`s) stay readable, as in
   hive's `maskEnvVarsInPM2Config`; the compose file and the Dockerfile are
   not masked, since they are written back whole.
2. **`pod/config-set` sends `services` AND the env list whenever either
   changes.** Checked against hive's route and push code: an env-only PUT
   is accepted (a `changeId`, `infraChanged`) but never reaches a pod,
   because the PUT does not regenerate the stored `pm2.config.js` and the
   push lets that file's env values win over the stored list. With both
   lists hive regenerates the file in the write and the push agrees. Masked
   values come back as the stored ones, and a removed name stays removed.
   The env-only behaviour is a hive bug and is not fixed here.
3. **Refused before anything is written:** a masked value that is not the
   stored value's own mask (hive would store the stars), a tagged one,
   PORT or a `*_COMMAND` as an env var (they come from the service's `port`
   and `scripts`), `pm2.config.js`, `devcontainer.json`, both compose
   names, a removal of a name that is not stored.
4. **A failed push stops the step.** Hive has saved the change, and
   resending the same edits finds nothing to push (hive's infra diff), so
   the error says to tell the person, who can retry from hive.
5. **Every claim's response carries `generation`.** `pod/claim { fresh }`
   gives back a pod whose generation is not `new` (an older hive ignores
   the parameter) rather than check a change on it. `generation=new` also
   leaves out pods flagged for recreation, which is the rollout's own
   readiness rule (`podGeneration` in hive is now the one rule the rollout,
   `pool/pods` and the claim share), and answers 409 while no push has
   completed, with the push error when the last push failed.
6. **staklink's `/pod-config`** reads the pm2 config from wherever
   staklink found it, and the compose file as the first of
   `docker-compose.yml` and `.yaml` in the pod-config directory.
7. **The deliverable's `content` is the diffs as one text.** Hive shows a
   `diff` artifact whose content is a string as highlighted code.
