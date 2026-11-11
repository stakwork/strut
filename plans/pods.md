# Pods: strut's agent works in a pod, and remembers how

> **Status (2026-11-10): the design is settled. Nothing is built.**
> Rewritten on 2026-11-10 from the plan of 2026-11-05, which put pods in
> containers on one Docker host with goose working in each through
> staklink. In "Decided", **agreed** rows are the owner's, from the design
> conversations; **settled** rows had one obvious answer, mine, and stand
> unless the owner says otherwise. Read against strut `main` @59a5972,
> staklink `main` @f17f572, stakgraph `main` @48a9bdfa (the lab's `pod/*`
> steps in `mcp/src/lab/pods/`, its `Pod` and `Pod Config` pages), hive
> `master` @c692b96bf and stadeum `main` @269481d. Companions:
> `org-home-swarm.md` §0 (a Stadeum box stands alone and Hive goes away),
> `pod-config.md` (the fix-then-promote loop this keeps), `jobs.md` §6
> (holds), `code-change.md` (strut's own path to a pull request, with no
> pod), `EVOLVE_SPEC.md` §5 (the `meta/*` tools an agent publishes with).

## Goal

1. **Many long-running jobs at once, each with a pod of its own, few
   running.** A job's agent picks up hours or days later and the job's pod
   is back within a second with everything it had: the repositories with
   their uncommitted changes, `node_modules`, build output, the database,
   and, after a short sleep, its running processes too.
2. **A job starts from what earlier jobs learned.** The first job on a
   workspace works out how to bring its services up, wired to each other,
   and how to reach a page in the app, and keeps that as workflows and a
   Concept page. The next job runs them and is working within seconds,
   instead of finding it all out again.

## Problem

A job that must run the app needs a pod: to build it, to test it against a
real database, or to let a person click through it. Today a pod comes from
Hive. The lab's `pod/*` steps claim one through Hive's API
(`POST /api/pool-manager/claim-pod/:workspace`), Hive asks its pool manager
(`POOL_MANAGER_BASE_URL`, a Kubernetes service Stakwork runs), the claim is
held on the job, and every other step drives staklink inside the pod. The
pool builds each pod from the files Hive keeps per workspace:
`Dockerfile`, `docker-compose.yml`, `pm2.config.js`. goose, in the pod,
does the work.

Three things are wrong with that:

- **A Stadeum box has no Hive, no lab and no Kubernetes.** Stadeum's rule
  9 says no runtime call to Hive or sphinx-swarm. So it has no pods, and no
  `pod/*` steps either, since the lab seeds those.
- **A pool makes a job choose** between keeping its pod, which blocks
  everyone else, and giving it up, which loses everything the pod held. The
  pool runs dry anyway: on peel-4, on 2026-11-02, two finished jobs held
  both pods and every claim failed for a night. And a pool's pods are
  always on.
- **Nothing a job learns about running the app is kept.** goose works out
  how to start the services, run the tests and reach a page, and what it
  learned ends with its session. staklink hard-codes the procedures, the
  same for every workspace: `startup()`'s fixed order (rebuild, install,
  pre-start, the apps, post-start), and its `/build`, `/test`, `/install`,
  `/prerun`, `/latest` and `/rebuild` routes. The `Pod Config` loop keeps
  the config files, not how to run, test or click through what they
  describe.

What strut does without a pod: a job directory, `git/checkout` worktrees
from the bare cache, an agent with bash, and `git/diff`, `git/apply`,
`git/push` and `github/create-pr` (`code-change.md`). That covers a change
judged by its diff and its unit tests. It does not cover a change that
needs the app running with its services.

## The design in one paragraph

Strut is the brain, on the org's box; a pod is its hands. Strut's `agent`
runs its loop in strut, as every agent does, and its built-in tools run in
the job's pod through an exec service there: `pod_bash`, an editor, an
overview and a search, beside its local ones. What it learns is kept where
strut keeps everything else. How things are (which services, which ports,
what breaks and why) goes on a Concept page per workspace. How to do things
goes into workflows: `<workspace>/boot` brings the stack up from whatever
state the pod is in, and a story workflow walks the app to a page. Each
carries claims that the verify pass checks, so a procedure that stopped
working says so and the agent fixes it. A pod is a Firecracker VM with its
own Docker, so the workspace's compose file runs as written and the agent
starts and stops services itself. Claude Code, Codex and goose can work in
a pod too, launched by `acp/prompt` through the same exec service; strut's
agent stays the default, because it reads and writes the memory with no
strut credential in the pod.

## Decided

| Question | Decision |
|---|---|
| Where pods run | **agreed.** On a machine of their own, the **pod box**, beside the Stadeum box. Never on the Stadeum box itself: a build or a dev server must not slow down strut, Neo4j or the gateway, or get them killed for running out of memory. |
| Where the agent's loop runs | **agreed (2026-11-10).** In strut, on the org's box. Only its tools run in the pod. The memory, the job's sessions, wakes, proposals and claims are already there, and so are the credentials: a pod runs a repository's code with a shell, and holds no key to strut. A sleeping pod never puts an agent to sleep. |
| What runs in the pod for strut | **agreed (2026-11-10).** An exec service, not `docker exec`: killing a `docker exec` client leaves its process running, and its output is lost with the connection. The service runs each command in a process group of its own, keeps its output in the pod under the command's id for a reader to come back to, kills a command's group on request, reads and writes files, and carries a two-way stream for a program that talks over stdin and stdout (§2). |
| Where the exec service lives | **settled.** In staklink, as routes beside its others. staklink is already in every pod Hive's pool makes and in every image `FROM ghcr.io/stakwork/staklink-js`, behind the pod's password. So strut's agent works in today's Hive pods first and in a pod box's VMs later, with one implementation. staklink's fixed procedures retire as the workspaces' workflows replace them. |
| Memory | **agreed (2026-11-10).** How things are in a Concept page per workspace; how to do things in workflows; claims on the workflows say when one went stale (§3). The agent publishes both with the `meta/*` tools. |
| What a pod is | **agreed (2026-11-10).** A Firecracker VM per pod. Its root filesystem is built from the workspace's `Dockerfile`; Docker inside it runs the compose file's other services as written (§4). This replaces the 11-05 design: containers on one Docker host, a compose rewrite so pods would not collide, and no Docker socket for a pod. |
| The agent in a pod | **agreed (2026-11-10).** Strut's `agent`, by default. Claude Code, Codex, goose and the other ACP agents as an option, through `acp/prompt` (§6). This replaces "goose through staklink". |
| How strut's agent reaches the pod | **settled.** With `pod: true`, an `agent` step gets `pod_bash`, `pod_edit`, `pod_repo_overview` and `pod_fulltext_search` beside its local tools, acting on the JOB's pod (§1). A job with no pod is told to claim one. The model never copies a pod id or a password: on 2026-11-02 it dropped a character from `sealed` (run 1793579091586). |
| A workflow in the pod | **settled.** `exec` and `acp/prompt` take `host: pod`: the step runs in the job's pod (§1). So `<workspace>/boot`'s commands run where the agent's do. |
| One container with a worktree per task, instead | **agreed: no.** That is strut's job directory, kept for changes that do not need the app running. It cannot give jobs that run at the same time their own Postgres, their own ports, or any isolation from each other. |
| How long a pod lives | **agreed.** Until its job lets it go (`pod/release`, or the job deleted), or 7 days unused: the idle sweep, `STRUT_WORKDIR_TTL_DAYS`, as for a job's checkouts. |
| Sleep | **settled.** A snapshot of the VM, its memory included, so a short sleep keeps the processes. After 24 hours asleep the memory snapshot is dropped and the next wake boots the VM (§5). |
| The coding pages and workflows | **agreed.** Strut ships the `Code Change`, `Pod` and `Pod Config` pages and the lab's `code-change-pr`, `code-change-propose` and `code-change-land` workflows, and seeds them only when `PODS_URL` is set. The lab's copies retire (§10). |
| Who may open a pod | **agreed.** Whoever holds a link strut signed (§8). A bare URL shows nothing. |
| Certificates | **agreed.** One wildcard certificate through a DNS-01 challenge (§8). |
| Where the code lives | **settled.** strut: `images/pods` (the manager), `deploy/pods` (the pod box's compose file), the `pod/*` steps as lib steps, the agent's pod tools. staklink: the exec routes. This follows the browser: `images/browser` and `browser/*`. |
| How many pod boxes | **settled.** One per org: pods hold the org's code, and Stadeum's rule 8 says the data is the customer's. Several per org is later work. |
| Who sets up a workspace on the pod box | **settled.** Strut, through `pod/workspace`, a step that runs only as a proposal a person accepted. The accepting person's `GITHUB_TOKEN` becomes the token the workspace's templates are cloned with (§9). Not stadeum-ui: by Stadeum's rule 1 it must not know what a workspace is. |
| A workspace's devcontainer files | **settled.** An existing workspace's come over with Hive's export (`org-home-swarm.md` §5). A new one starts from Hive's defaults (`FROM ghcr.io/stakwork/staklink-js`, an empty compose file, a pm2 config generated from its services), and the job's agent makes it run, through the `Pod Config` loop (`pod-config.md`) for the files and `<workspace>/boot` for the procedure. |
| AWS Lambda MicroVMs, instead of a pod box | **settled: not now.** Launched in preview on 2026-06-22: a Firecracker VM per session, made from a Dockerfile into a snapshot, its state kept for up to 8 hours. 8 hours is shorter than a pod lives (7 days); whether Docker runs inside one is not known here; and it runs in an AWS account, which for Stadeum must be the customer's. The manager's API (§7) leaves room for one behind it later. |

## Measured

On 2026-11-05, Docker 29.6 (Docker Desktop), for the container design this
plan replaced. Kept because the numbers for Postgres hold inside a VM too.
Nothing about Firecracker is measured yet: §11 items 1 and 3 do that.

| What | Result |
|---|---|
| Wake: a stopped pod (app + Postgres) started again, three times | Containers back in about 0.2 s; Postgres answering in 0.31–0.37 s; the row written before the stop still there. |
| A pod's Postgres container removed and made again over its layer (the data only on disk) | Answering in 0.67 s, data kept. |
| A pod from a template: a 117 MB template of 20,000 small files and an initialized, seeded Postgres, under overlay volumes | Volumes made in 0.05 s; Postgres answering in 0.2 s. Each pod saw only its own changes; the template stayed untouched. |
| What a pod from a template costs on disk | Its changes only: 28 KB for the workspace, about 19 MB for the database (mostly Postgres' write-ahead log). |

## 1. The brain and the hands

**The job's pod.** A pod is a hold on the job (`jobs.md` §6): `pod/claim`
records it with `kind: "pod"`, and its release input already carries the
pod's `control` URL and its `sealed` password, which the lab's other
`pod/*` steps read (`podAccess`, `mcp/src/lab/pods/steps/_shared.ts`).
Strut core learns one thing more than it knows today: where a job's pod is
and how to open it. That is a capability, `ctx.services.pods.access(job)`
→ `{ control, password } | null`, provided by whoever claims pods: the
lab's services bag on a swarm, strut's own `pod/*` steps on a pod box
(§10). Strut core never reads a hold's input itself.

**The agent's pod tools.** `agent { pod: true }` adds four tools to the
built-ins, each acting on the job's pod:

| Tool | Does, in the pod |
|---|---|
| `pod_bash` | `bash`'s contract: one command, cwd `/workspaces` (or a path the model gives), `bashTimeoutMs`, a cancel kills its process group, output capped head and tail |
| `pod_edit` | the editor's view, create, str_replace and insert, sandboxed to `/workspaces` |
| `pod_repo_overview` | `repo_overview`, run there |
| `pod_fulltext_search` | `fulltext_search` (`rg`), run there |

They act on the job's own pod. The second, fresh pod the `Pod Config` loop
borrows to check a fix (`pod-config.md` §4) is still checked through
`pod/config-apply` and staklink, as today.

The local tools stay, on the job's directory: the agent keeps its notes and
its deliverables where strut serves them. `pod/fetch { path }` copies a file
from the pod into the job's directory, through the exec service's `/files`,
so a report it wrote there can be declared as a deliverable. The tool set is fixed for the step (it heads the
prompt cache); before a claim the pod tools answer "this job holds no pod:
claim one with `pod/claim`". `toolFilter` names them like any built-in.

**What a run leaves running.** A command's process group is killed when the
run ends, as locally: a dev server the agent backgrounds with `&` does not
outlive its run. Services run under pm2 or Docker, whose daemons are not in
any command's group, and the `Pod` page says so. That is how an app stays
up between turns for a person to click through.

**Steps in the pod.** `exec { host: pod }` and `acp/prompt { host: pod }`
run in the job's pod, through the same service: `secretsEnv` puts named
secrets into that command's environment and masks them out of its output,
as locally. A workflow run under the job (`meta/run-workflow` hands the
child the job) finds the same pod.

**The seam in code.** One interface, `Host`: run a command (start, read
output from an offset, kill), open a two-way stream, read, write and stat a
file. `localHost` is today's code moved behind it (`runShellProcess` and
`node:fs`, `src/steps/core/agent.ts`; the spawn in
`src/steps/lib/acp/_client.ts`), and `podHost` is a client of staklink's
exec routes. Nothing else changes for the local path.

**Latency.** One round trip per tool call: strut → Caddy → the manager →
the pod. Next to a model call it is nothing, while the pod box and the
Stadeum box sit in one region.

## 2. The exec service

New staklink routes, behind the pod's password like its others:

| Route | Does |
|---|---|
| `POST /exec { cmd, cwd?, env?, timeoutMs?, stdin? }` | Starts `bash -c cmd` with `setsid`, in a process group of its own, stdout and stderr to files under staklink's state directory. Answers `{ id }` at once. |
| `GET /exec/:id?offset=&wait=` | The output from `offset`, and `{ done, code, signal, timedOut }`. Held up to `wait` (55 s at most) while the command runs and has nothing new. A reader whose connection dropped asks again from its offset. |
| `POST /exec/:id/kill` | TERM to the group, KILL 2 s later. On a finished command, kills what it left running in its group: strut calls it for every command of a run when the run ends. |
| `GET /exec/stream` | A WebSocket for `acp/prompt` (§6): its first message starts the command as `POST /exec` would, then stdin in, stdout out. The command is killed when the socket closes. |
| `GET` / `PUT /files?path=`, `GET /files/stat?path=` | A file's bytes, read or written; its size and type. |

A command's output is kept up to 50 MB and for an hour after it ends.
`GET /busy` (§5) counts running commands. Several commands run at once.

## 3. Memory: what a job learns, and where it keeps it

**How things are: a Concept page per workspace.** Under `Pod`, named
`<workspace> pod` (`hive pod`): which services the workspace runs, on which
ports, how they find each other, which test user the seed makes, what broke
and why, and which workflows run it. The `job` workflow puts it in the
prompt when the launch names a workspace (`context/concept`), as it puts
the kind's page today. The page holds facts; the posture (when to boot,
when to save a workflow) stays in `Pod`.

**How to do things: workflows named under the workspace.**

- `<workspace>/boot` brings the stack up from whatever state the pod is in:
  installs when a lockfile changed since it last installed, migrates,
  starts what is not running (`docker compose up -d`, `pm2 start`, then
  `pm2 save`), and waits until each service answers. It is quick when
  everything is up, so a turn runs it first. One step's output (a port, a
  URL, a password it generated) is the next step's environment through
  `{{ }}`: that is how the services are wired to each other. It is what
  staklink's `startup()` did, written for this workspace instead of the
  same for all.
- A **story** walks the app to a page: `<workspace>/<story>`
  (`hive/open-task`), a `browser/verify` list against the pod's frontend
  (the job's `urls.pod`; on a pod box, through `pod/link`, §8), signed in
  as the test user the seed makes, never a person's account. It ends on its page: its walkthrough shows the way,
  `browser/keep` can hold the page for the job's next step, and a quick
  check of a change is the story run again.
- Others as the work needs them: `<workspace>/test` as this workspace runs
  its suite, a reset of the database to the seed.

**When a memory went stale: claims.** Each workflow carries a `claims:`
block. `boot` claims that each service answers (an `http/verify` per URL,
an `exec` for a database); a story claims that it reaches its page. The
verify pass checks them after every run. A refuted claim tells the agent
the procedure no longer matches the repository: it brings the stack up by
hand, publishes the workflow again, and adds to the workspace's page what
changed.

**The loop, in the `Pod` page.** Run `<workspace>/boot` before anything
else in a pod. When there is none, or it fails, bring the stack up by hand,
then publish what worked as `<workspace>/boot` with a claim per service,
and write on the workspace's page what surprised you. Reach a page by hand
the first time (`browser-explore`) and save the way as a story when a
person or a check will want it again. The agent publishes with the `meta/*`
tools, over names it stamped `ai` (`EVOLVE_SPEC.md` §5); a person takes one
over like any other. Every version is in the history repository
(`history.git`), so a bad one is rolled back.

**Templates are memory too.** A workspace's template is a pod after
`<workspace>/boot` ran on a fresh clone (§4), so a new pod starts with the
stack already installed and seeded.

## 4. A pod is a VM

- **Firecracker, one VM per pod.** Its root filesystem is the image built
  from the workspace's `Dockerfile`, exported into a disk image, with what
  every pod needs added: an init, Docker, staklink if the image lacks it,
  and code-server. A kernel of strut's, built for Docker inside (overlayfs,
  cgroups v2, netfilter).
- **The compose file as written, but for `app`.** The VM is the app: the
  `app` service's `environment` becomes the VM's environment, its build is
  the root filesystem, and its ports, volumes and command are dropped.
  Every other service (Postgres, Redis) runs under the VM's Docker as the
  file says; `ports: "5432:5432"` publishes on the VM's own localhost, so
  the app finds it at `localhost:5432` and two pods never collide. Nothing
  is refused: a privileged service is privileged inside a VM of its own,
  and the agent runs `docker compose` itself.
- **At boot**, the init starts Docker, runs `docker compose up -d` for
  every service but `app`, runs `pm2 resurrect`, and starts staklink with
  no procedures (`staklink start --serve-only`: its control server, the
  exec service, code-server) — never the seeding again.
- **Network.** Each VM has a tap device on a bridge and an address of its
  own; it reaches the internet through NAT; the manager reaches its ports
  at that address.
- **Disk.** A pod's disk is a copy-on-write clone of its template's
  (`cp --reflink`): made at once, costing only what the pod changes, and
  independent of the template once made. So the pod box's data filesystem
  must be XFS with reflinks or btrfs. Package caches are per pod: a VM
  cannot share a disk another VM writes, and the template's are warm.
- **Memory.** Each VM gets a fixed size, 4 GB unless the workspace sets
  another.
- **KVM.** Firecracker needs `/dev/kvm`: a bare-metal machine, or a cloud
  VM with nested virtualization. AWS offers that on C8i, M8i and R8i since
  2026-02-16, and on more Intel types since June; AWS still advises bare
  metal for work sensitive to performance. A pod box elsewhere (a dedicated
  server) has KVM as is.

**Templates.** Per workspace and per config generation, the manager keeps a
**template**: a disk, made by strut's `pod-template` workflow, which claims
a builder pod (`pod/claim { base: true }`: the image built, the
repositories cloned at their base branches, nothing started), runs
`<workspace>/boot` in it, and calls `pod/template`, which has the manager
shut the VM down cleanly and keep its disk as the template. Shutting it down cleanly leaves the database
consistent. A workspace with no `boot` yet gets a template of the fresh
clone; the first job's agent makes `boot`, and the template is made again.
`pod-template` runs when the config changes (a new generation, Hive's
`generation: new | old`), when a new version of `<workspace>/boot` is
published, and every night at 03:00 in the box's time zone (an automation),
so a new pod does not start far behind its base branch. A pod starts at its
template's commit; `pod/latest` fetches and resets, as today.

## 5. Sleep and wake

- **Wake on request.** Every request to a pod goes through the manager: a
  `pod/*` step's call to staklink, a pod tool's command, a person opening
  the pod's frontend or IDE link, a browser step on the frontend. A request
  to a sleeping pod wakes it and is held until the pod answers. So nothing
  calling a pod needs a new call, and yesterday's link works.
- **Sleep keeps the processes.** A pod sleeps as a Firecracker snapshot:
  its memory and state written to the pod's folder, the VM stopped. A wake
  restores it with every process where it was: the dev server, Postgres,
  the apps. Restore time is to be measured (§11 item 3).
- **A long sleep keeps the disk.** After 24 hours asleep, the manager
  restores the pod, shuts it down cleanly and deletes the memory file,
  which is as large as the VM's memory. The next wake boots it (§4: Docker,
  compose, pm2): seconds, and the agent's next `boot` puts right anything
  that did not come back.
- **When a pod sleeps.** After 10 minutes with no request and no message
  from a client on an open socket, while staklink reports nothing running
  (`GET /busy`: a request in flight, an exec command running, goose
  running). An IDE tab left open does not keep a pod awake.
- **A cap on running pods.** `maxRunning` defaults to the box's memory
  divided by the VM size, at least 1. A wake at the cap puts the idle pod
  used longest ago to sleep. With none idle, the request waits up to 60 s,
  then answers 503 with `Retry-After`; `pod/claim` already treats a 503 as
  "try again shortly".
- **Disk.** A claim that would make a new pod is refused while the box has
  less than 10% of its disk free. Sleeping pods are never deleted to make
  room: they hold work.
- **The manager restarting** leaves the pods as they are. Its state is the
  pods' folders and the workspace files (§7); it reads them again at start.
- **Not backed up.** A pod holds work in progress; what is pushed is in
  GitHub; what the agent learned is in strut. A pod box that dies loses its
  pods' unpushed work, as a pool does today.

Every number here is a setting of the manager's, with the default given.

## 6. Other agents in a pod

- `acp/prompt { agent, host: pod }` runs the ACP agent's command in the pod
  through the exec service's stream. Strut stays the ACP client, as today:
  it maps strut's session name to the agent's session
  (`<dataDir>/acp/sessions/`), enforces `mode` on every permission request,
  and records each tool call as a run event. The agent's own session files
  live on the pod's disk, so a thread survives a sleep.
- A stream that drops ends the turn in flight; the next turn's
  `session/load` continues the thread.
- The pod's image must carry the agent (Claude Code's ACP adapter, Codex,
  goose): the workspace's `Dockerfile` adds it, or `staklink-js` does. Its
  model calls go to the org's gateway with the run's grant, set in that
  command's environment, as goose's are today.
- **What such a turn does not do: learn.** An agent in the pod has no door
  to strut's Concepts and workflows, and gets none: that would be a strut
  credential in the pod, beside the repository's code. It reads what strut
  puts in its prompt (the workspace's page). So the `job` workflow runs
  strut's agent; a strut agent that hands a piece of coding to Claude Code
  (`acp/prompt` among its `agentTools`) keeps what is worth keeping itself.
  The `job` workflow's `input.agent` branch, which runs `acp/prompt` in
  place of `agent` for a whole turn, gets `host: pod` when the job has a
  pod, and learns nothing.

## 7. The manager's API

The calls of Hive's that the `pod/*` steps make, at the same paths and in
the same shapes, so one set of steps works against either while both exist
(§10):

| Call | Path | On the pod box |
|---|---|---|
| Claim | `POST /api/pool-manager/claim-pod/:workspace?job=&run=&generation=new&base=1` | The job's own pod: made from the workspace's current template on the job's first claim, the same pod on every later one. With `generation=new`, a second pod from the current template, the one a promoted config fix is checked on (`pod-config.md` §4). With `base=1` (new here), a builder pod: the image built and the repositories cloned, no template under it (§4). Answers `{ podId, password, frontend, ide, control, generation }`. |
| Drop | `POST /api/pool-manager/drop-pod/:workspace?podId=&job=` | Deletes the pod: its VM, its disk and its folder. 404: already gone. |
| Read the config | `GET /api/workspaces/:workspace/stakgraph` | `{ data: { services, environmentVariables, containerFiles, rollout } }`. Env values masked as Hive masks them; the files base64. |
| Write the config | `PUT /api/workspaces/:workspace/stakgraph` | `services` and env replace the stored ones whole, as Hive's do; `pm2.config.js` is generated from `services` (hive's `generatePM2Apps`). A new generation: strut's `pod-template` makes its template, and `rollout` says when it is `ready`. Answers `{ changeId, rollout }`. |

New calls:

- **`PUT /workspaces/:workspace { repositories, githubToken }`**: makes or
  changes a workspace: its repositories (`url`, `branch`) and the token
  its templates are cloned with (§9). `pod/workspace` calls it.
- **`POST /workspaces/:workspace/templates { podId }`**: shuts the pod down
  cleanly and keeps its disk as the template of the workspace's current
  generation. `pod/template` calls it.
- **`POST /pods/:podId/sleep`** and **`POST /pods/:podId/wake`**: for a
  caller that knows better than the idle timer. A job turn that ends can
  put its pod to sleep at once; one that starts can wake it ahead of its
  first call.
- **`GET /.pods/auth?t=&next=`**, on a pod's own names: takes a signed
  link and sets the cookie that opens the pod (§8).

Every call but the last takes `x-api-token: <key>`, as Hive's do. The
manager's state is the pods' folders and the templates, plus one JSON file
per workspace, the tokens and env values encrypted. There is no database.
The manager is the only thing on the pod box that starts VMs.

## 8. Reaching a pod

- **Caddy → the manager → the pod.** Caddy terminates TLS; the manager is
  in the path of every request, since it wakes pods, counts idle time (§5)
  and checks who may open a pod, and it proxies to the VM's address,
  sockets included (HMR, code-server, the exec stream).
- **Names per pod, as Hive's.** A link must survive a sleep, so a pod keeps
  its names for its life, in Hive's scheme (`buildPodUrl`,
  `src/lib/pods/queries.ts`): `<podId>.<pods host>` is the IDE and
  `<podId>-<port>.<pods host>` is a port: `-15552` the control server, the
  frontend's port the frontend.
- **One wildcard certificate**, `*.<pods host>`, through a DNS-01
  challenge, behind one wildcard DNS record. The pod box runs a Caddy
  built with the DNS modules of the main providers (Cloudflare, Route 53,
  Azure DNS, Google Cloud DNS, DigitalOcean), published from `deploy/pods`,
  and holds an API token for the org's DNS. A certificate per name would
  hit Let's Encrypt's weekly limit per domain within days.
- **Signed links.** The manager lets a request through to any of a pod's
  names except control only with that pod's cookie. Without one it
  redirects to strut's `GET /pods/open?pod=<podId>&next=<url>`, which is
  behind strut's own sign-in: any person who may use this strut may open
  its pods. Strut signs `{ pod, exp }` with `PODS_KEY`, valid 60 s, and
  redirects to `/.pods/auth` on the pod's name. The manager checks it and
  sets an HttpOnly, `Secure` cookie for the pods domain, naming the pod and
  lasting 12 hours (`STRUT_SESSION_HOURS`), so every port of that pod
  opens with it.
  - A browser step has no strut sign-in: `pod/link { port? }` mints the
    same link for the job's pod, and a story or `browser-explore` opens it.
  - The control server, the exec service with it, takes the pod's password
    as a bearer token, as today, and is not behind the cookie: only
    strut's steps and pod tools call it.
  - code-server keeps its own password behind the cookie, as today
    (staklink's `/ide-auth` signs IDE links with it).
- **The pod box knows strut's URL** (`STRUT_URL` in its env), for the
  redirect.

## 9. Credentials

| Credential | Held by | Reaches |
|---|---|---|
| The manager's key | the pod box's env; strut as the deployment secret `PODS_KEY` | the manager's API, and the signature on a pod link |
| A pod's password | the manager makes it; `pod/claim` seals it on the job's hold, as today | staklink, its exec service and code-server in that pod |
| The token templates are cloned with | the manager, encrypted, per workspace; set by `pod/workspace` from the accepting person's `GITHUB_TOKEN` | `git clone` and `fetch` when a template's builder pod is made, never a pod's environment afterwards. Hive's pool keeps one person's token the same way today (`github_pat`, `create-pool/route.ts`) |
| The person's GitHub token | strut's actor secret `GITHUB_TOKEN` | passed per call by `pod/latest` and `pod/push`, as today (`gitCredentials`); never in `pod_bash`'s environment unless a step's `secretsEnv` names it |
| Model calls of strut's agent | the run's grant, in strut | the org's gateway, from strut. Nothing in the pod |
| Model calls of an agent in the pod | the run's grant, `<vk>.<macaroon>`, in that command's environment, as goose's are today | the org's gateway: Stadeum's stack publishes Bifrost at `bifrost.<HOST>` (`stack/stadeum.yml`; the Caddy that replaces Traefik must keep the route) |
| A strut credential | nothing in a pod | — |
| The DNS token | the pod box's env | the wildcard certificate (§8) |
| A pod's cookie | the person's browser, or the agent's | that pod's names, for 12 hours |

A secret `secretsEnv` puts into a command's environment is readable by the
repository's code running in that pod for that command's life, as it is in
a job's directory today. A pod reaches the internet (installs, the
gateway). It reaches the manager's API only through Caddy, like anyone
else, and holds no key for it.

## 10. What changes, per repo

**strut**

- **The pod tools and `host: pod`** (§1): the `Host` seam with `localHost`
  and `podHost`; `agent { pod: true }`; `exec` and `acp/prompt`
  `{ host: pod }`; the `ctx.services.pods` interface (`access(job)`, which
  whoever claims pods provides) and the run-end kill of every exec command
  the run started; `pod/fetch` (§1), which works against any pod with the
  exec routes and collides with no step of the lab's.
- **`images/pods`**: the manager, a small TypeScript service on Hono that
  runs Firecracker: builds root filesystems and keeps templates, clones
  disks, starts, snapshots, restores and stops VMs, and proxies (§4, §5,
  §7). With the kernel it boots and the init it adds.
- **`deploy/pods`**: the pod box's compose file (the manager, Caddy with
  the DNS modules) and an `env.example`, run from its folder like
  `deploy/index` and `deploy/voice`.
- **`src/steps/lib/pod/`**: the `pod/*` steps as lib steps, reading
  `PODS_URL` and `PODS_KEY`, else `HIVE_URL` and `HIVE_API_KEY`, so they
  run on a Stadeum box and on a swarm alike. With them, createStrut sets
  `ctx.services.pods` itself whenever either is configured, and the lab's
  goes. From the lab, with the same names, inputs and outputs: `claim`, `release`, `latest`, `push`, `config`, `config-set`,
  `config-apply`. Not moved, since `pod_bash` and the workspaces' workflows
  do their work: `agent`, `agent-start`, `agent-status` (goose), `diff`,
  `branch-diff`, `run-tests`. New: `pod/workspace` (§7; it refuses unless
  it runs as an accepted proposal, `ctx.proposal`, as `package/install`
  does), `pod/link` (§8), `pod/template` (§4), and `base` on `pod/claim`
  (§7). `pod/claim`
  takes an idle job's pod (`takeIdlePod`) only from Hive: a pod box runs
  out of running room, not of pods, and waits for room (§5).

  A custom step never shadows a lib step (`buildRegistry`, registry.ts:
  the collision is skipped with a warning). So once the lab's strut pin
  includes these, its seeded copies are skipped and the lab deletes them in
  the same change, goose's three with them.
- **`GET /pods/open`** (§8), mounted only when `PODS_URL` is set.
- **The coding track**, seeded only when `PODS_URL` is set:
  - the pages `Code Change` (under `Job`), `Pod` (under `Code Change`) and
    `Pod Config` (under `Pod`), moved from the lab; `Pod` rewritten around
    the loop of §3 and what a pod gives (the pod is the job's until the job
    lets it go or 7 days pass unused; uncommitted work survives a sleep;
    services run under pm2 or Docker);
  - the workflows `code-change-pr`, `code-change-propose` and
    `code-change-land`, which use only strut's own steps, and
    `pod-template` (§4), with its nightly automation;
  - in the `job` seed: `pod: true` on its agent, `pod/*` in its tools,
    `pod/workspace` in its `approve:` list, the workspace's page in its
    prompt, and `host: pod` on its `acp/prompt` branch.
- **`specs/PODS.md`**: the manager's API and the exec routes, for anyone
  who runs a pod box.

**staklink**

- The exec routes (§2) and `GET /busy`, counting running commands.
- `start --serve-only` (§4): the control server and code-server, none of
  `startup()`'s procedures.
- `PUT /pod-config` in a VM: `docker compose up -d` for every service but
  `app`.
- Later: the fixed procedures (`/build`, `/test`, `/install`, `/prerun`,
  `/rebuild`) retire once no workspace's pod relies on them.

**stakgraph (the lab)**

- For §11 item 1: `ctx.services.pods.access(job)` in its services bag,
  over `podAccess` and `unseal`; `pod: true` in its `job` delta.
- Deletes its `pod/*` steps, the three pages and the three code-change
  workflows when it moves to the strut pin that ships them (item 6).

**stadeum**

- Nothing in its stack: the pod box is a deployment of its own. Strut on
  the Stadeum box needs `PODS_URL` and `PODS_KEY` as deployment secrets.

## 11. Order

The two bets are tested apart: the memory on today's Hive pods first, the
VMs after.

1. **Strut's agent in today's pods.** staklink's exec routes, released
   (Hive's pods take staklink from its release); strut's `Host` seam, the
   pod tools, `host: pod` and `pod/fetch`; the lab's `ctx.services.pods`. Tested
   against a staklink started locally: a cancel kills the group, a dropped
   read resumes from its offset, the run's end kills what a command left
   running. Then on swarm38, a job working in a pod Hive's pool made.
2. **The memory loop, measured.** The rewritten `Pod` page and the
   workspace's page in the job's prompt. On swarm38, workspace `hive`
   (Postgres and the Next.js app): job one has no `hive/boot`, works it
   out, publishes it with its claims, and saves one story (open a task);
   job two, on a fresh pod, runs them. Measured: time from claim to the
   first passing test, and to the story's page, job one against job two.
   Then break `boot` on purpose (change a port in the compose file) and
   see the claim refuted and the agent mend it.
3. **One VM.** Firecracker on a KVM host: a root filesystem from hive's
   `Dockerfile`, its compose file running inside as written, staklink
   serve-only, strut's agent working in it. Measured: a cold boot, a
   snapshot and a restore, a reflink clone, disk per pod, the memory file
   per sleeping pod.
4. **The manager:** templates through `pod-template`, claim and drop,
   sleep and wake, `maxRunning`; two pods of one workspace at once, each
   with its Postgres on `localhost:5432`.
5. **Caddy and `deploy/pods`:** per-pod names, the wildcard certificate,
   signed links and `GET /pods/open`.
6. **The coding track into strut:** the `pod/*` lib steps, the pages, the
   workflows, seeded with `PODS_URL`; the lab deletes its copies.
7. **A live run**: a Stadeum box and a pod box. A job claims a pod for a
   workspace with Postgres, runs its tests, leaves it uncommitted; the pod
   sleeps; hours later a second turn finds it as it was and opens a pull
   request; a day later a third turn finds it booted from disk. Then
   twenty jobs with pods and a `maxRunning` of four.
8. **Later:** a template with a memory snapshot, so a new pod starts with
   its apps already running (cloning a running VM has known pitfalls: the
   same random state, the same network identity); a workspace's memory
   (its page, `boot`, its stories) as a package, so another org with the
   same repositories starts from it; several pod boxes per org; pods that
   move between pod boxes.
