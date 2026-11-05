# Pods on a pod box: many sleeping pods, few running

> **Status (2026-11-05): proposed. Nothing is built.** The direction was
> agreed in one design conversation with the owner: rows marked **agreed**
> in "Decided" are the owner's; everything marked *proposed* is mine and
> open. The numbers in "Measured" are from Docker 29.6 (Docker Desktop) on
> 2026-11-05. Read against strut `main` @75a9860, staklink `main`
> @f17f572, stakgraph `main` @b8f16c5b (the lab's `pod/*` steps,
> `mcp/src/lab/pods/`), hive `master` @c692b96bf and stadeum `main`
> @269481d. Companions: `org-home-swarm.md` §0 (a Stadeum box stands alone
> and Hive goes away), `pod-config.md` (the fix-then-promote loop this
> keeps), `jobs.md` §6 (holds), `code-change.md` (strut's own path to a
> pull request, with no pod).

## Goal

Many long-running jobs at once, each with a pod of its own, with few
containers running. A job's agent picks up hours later with more changes,
and the job's pod is back within a second with everything it had on disk:
the repositories with their uncommitted changes, `node_modules`, build
output, the database, the agent's session. Only the processes start again.

## Problem

A job that must run the app needs a pod: to build it, to test it against a
real database, or to let a person click through it. Today a pod comes from
Hive. The lab's `pod/*` steps claim one through Hive's API
(`POST /api/pool-manager/claim-pod/:workspace`), Hive asks its pool manager
(`POOL_MANAGER_BASE_URL`, a Kubernetes service Stakwork runs), the claim is
held on the job, and every other step drives staklink inside the pod. The
pool builds each pod from the files Hive keeps per workspace:
`Dockerfile`, `docker-compose.yml`, `pm2.config.js`.

Two things are wrong with that for a Stadeum org:

- **A Stadeum box has no Hive, no lab and no Kubernetes.** Stadeum's rule
  9 says no runtime call to Hive or sphinx-swarm. So it has no pods, and no
  `pod/*` steps either, since the lab seeds those.
- **A pool makes a job choose** between keeping its pod, which blocks
  everyone else, and giving it up, which loses everything the pod held. The
  `Pod` page tells the agent "what lives only in the pod is not" safe:
  uncommitted changes, a running task, the agent's memory. The pool runs
  dry anyway: on peel-4, on 2026-11-02, two finished jobs held both pods
  and every claim failed for a night (`pod/claim`'s `IDLE_MINUTES` comment,
  the fix that takes an idle job's pod).

What strut does without a pod: a job directory, `git/checkout` worktrees
from the bare cache, an agent with bash, and `git/diff`, `git/apply`,
`git/push` and `github/create-pr` (`code-change.md`). That covers a change
judged by its diff and its unit tests. It does not cover a change that
needs the app running with its services.

## Decided

| Question | Decision |
|---|---|
| Where pods run | **agreed.** On a VM of their own, the **pod box**, beside the Stadeum box. Never on the Stadeum box itself: a build or a dev server must not slow down strut, Neo4j or the gateway, or get them killed for running out of memory. And a pod limited enough to be safe there builds slowly. |
| What a pod is | **agreed.** Containers made from the workspace's devcontainer files as Hive keeps them today (`Dockerfile`, `docker-compose.yml`, `pm2.config.js`), with staklink inside. No Kubernetes. |
| The goal | **agreed.** Efficiency: a pod's state lives on disk, injected into its containers, so a pod sleeps whenever it is idle and wakes within a second, and many jobs keep pods while few run. |
| One container with a worktree per task, instead | **agreed: no.** That is strut's job directory, kept for changes that do not need the app running. It cannot give jobs that run at the same time their own Postgres, their own ports, or any isolation from each other. |
| Where the code lives | *proposed.* In strut's repo: `images/pods` (the manager), `deploy/pods` (the pod box's compose file), and the `pod/*` steps as lib steps. This follows the browser: `images/browser` and `browser/*`. |

## Measured

| What | Result |
|---|---|
| Two pods side by side, each an app container and a Postgres in its network namespace (§4) | Each had its own Postgres on `localhost:5432` and saw only its own data. |
| Wake: a stopped pod (app + Postgres) started again, three times | Containers back in about 0.2 s; Postgres answering in 0.31–0.37 s; the row written before the stop still there. |
| A stopped pod's memory | None. The same pod running: about 19 MB. |
| A pod's Postgres container removed and made again over its layer (the data only on disk) | Answering in 0.67 s, data kept. |
| A pod from a template (§2): a 117 MB template of 20,000 small files and an initialized, seeded Postgres; the pod's `/workspaces` and database are overlay volumes over it | Volumes made in 0.05 s; Postgres answering in 0.2 s. Each pod saw the template's row and its own, never the other's; the template stayed untouched. |
| What a pod from a template costs on disk | Its changes only: 28 KB for the workspace, about 19 MB for the database (mostly Postgres' write-ahead log). |

## 1. A pod is a folder

Each pod has a folder on the pod box, `<data>/pods/<id>/`, which holds:

- the upper layer of its `/workspaces` (§2);
- the upper layer of each of its sidecars' volumes, such as a Postgres
  data directory;
- goose's data directory (`$XDG_DATA_HOME/goose`, by default
  `~/.local/share/goose`, `goose-session-manager.ts`), mounted into the app
  container, so the agent's sessions survive a container being recreated;
- the manager's record of the pod: its job, its workspace, its template,
  its name, its password (encrypted).

**Asleep, a pod's containers are stopped**, not removed. Everything
survives a sleep but the processes: every file, the database, uncommitted
changes, a tool the agent installed in the container. The containers are
made again from the folder only when the pod's config or image changes
(`pod/config-apply`); a change made in a container's own filesystem is
lost then, as it is today when a pod is recreated.

**A pod is deleted** when its job lets it go (`pod/release`, the job
deleted, or the idle sweep: `STRUT_WORKDIR_TTL_DAYS`). The folder goes
with it.

The pod box is not backed up. A pod holds work in progress; what is pushed
is in GitHub. A pod box that dies loses its pods' unpushed work, as a pool
does today.

## 2. Templates: a new pod in 50 ms

Per workspace and per config generation, the manager keeps a **template**:
a read-only folder, `<data>/templates/<workspace>/<generation>/`, with the
`/workspaces` a fresh pod should start from, and each sidecar volume.

- **Made by a builder pod.** The manager builds the image, clones the
  repositories at their base branches, starts the pod, lets staklink run
  every start command (rebuild, install, pre-start, the apps, post-start:
  the seeding), stops it cleanly, and copies what it sees (its layers over
  the previous template, or over nothing for the first) into the new
  template's folder. That is one full copy per generation, never per pod.
  Stopping it cleanly is what leaves the database consistent to copy.
- **A pod over a template** gets one overlay volume per folder, made with
  Docker's own `local` driver (`--opt type=overlay`, `lowerdir` = the
  template, `upperdir` and `workdir` in the pod's folder). dockerd mounts
  it, so the manager needs no privilege of its own. The manager's data
  folder is a host path mounted at the same path inside it, since dockerd
  mounts overlays by host path.
- **Remade** when the config changes (a new generation, Hive's
  `generation: new | old`, which `pod/claim { fresh: true }` asks for) and
  on a schedule, so a pod made weeks later does not start far behind its
  base branch. A pod starts at its template's commit; `pod/latest` fetches
  and resets, as today.
- **Kept** while any pod sits on it. A pod keeps its template for its whole
  life (its overlay's lower layer cannot change under it), so a job open
  for a month keeps an older template on disk.
- **Shared package caches** (npm, yarn, pnpm's store, cargo, go, uv,
  Playwright's browsers) are volumes in every pod, for the installs a
  builder runs and the ones after a `pod/latest`. npm's cache and pnpm's
  store can safely be written by two installs at once; yarn v1's needs its
  `--mutex` flag for that, so it stays per pod until that is settled.

## 3. Sleep and wake

- **Wake on request.** Every request to a pod goes through the manager:
  a `pod/*` step's call to staklink, a person opening the pod's frontend
  or IDE link, `browser-explore` on the frontend. A request to a sleeping
  pod starts it and is held until the pod answers. So the steps need no new
  call, and yesterday's link works.
- **Wake fast.** At every start staklink runs each app's
  `REBUILD_COMMAND` and `INSTALL_COMMAND`, then `PRE_START_COMMAND`, the
  pm2 apps, and `POST_START_COMMAND` (`startup()`, `src/proxy/startup.ts`).
  On a wake that is minutes of work redone, and a post-start command that
  seeds data would seed it again. staklink gains a **resume** start: it
  skips rebuild and install when nothing they read changed since this pod
  last ran them (a stamp in the pod's folder), skips post-start, and starts
  the apps. The app is then back as fast as its dev server starts:
  seconds.
- **Sleep when idle.** A pod sleeps after N minutes (default 10) with no
  request and no message from a client on an open socket, while staklink
  reports nothing running (a new `GET /busy`: a request in flight, goose
  running). An IDE tab left open does not keep a pod awake. A pod is never
  put to sleep with a request in flight: its result lives in staklink's
  memory.
- **A cap on running pods.** `maxRunning`, set from the box's memory. A
  wake at the cap puts the idle pod used longest ago to sleep. With none
  idle, the request waits, then answers 503 with `Retry-After`; `pod/claim`
  already treats a 503 as "try again shortly".
- **What a sleep loses:** the processes and their memory. A dev server
  restarts; a goose turn that was running is gone. Saving and restoring
  live processes (CRIU) is experimental in Docker and is left out. Hence
  the rule above: a busy pod never sleeps.

## 4. The compose rewrite: a pod's containers share one localhost

In Kubernetes, a pod's containers share one network namespace, so the app
reaches its Postgres at `localhost:5432`. Compose gives each container its
own network. Workspace files work around that by publishing ports to the
host and pointing `localhost` at the host gateway. Hive's own
`.devcontainer/docker-compose.yml` does exactly this:
`container_name: hive-postgres-dev`, `ports: "5432:5432"`, and `extra_hosts:
"localhost:172.17.0.1"`. Two copies of that file on one Docker host
collide.

A pod is one compose project, `docker compose -p pod-<id>`. The manager
runs every service but `app` inside `app`'s network namespace, with
`network_mode: "service:app"`, and drops what would collide. Inside one
pod two services still cannot share a port, as in Kubernetes.

Per service:

- **Every service but `app`:** `network_mode: "service:app"`; `ports`,
  `networks`, `extra_hosts` and `hostname` dropped.
- **Every service:** `container_name` dropped; each named volume replaced
  by the pod's own overlay volume over the template's copy (§2), declared
  external; a memory and CPU limit, set generously, since builds need room
  and the running cap is what protects the box.
- **`app`:** the image built from the workspace's `Dockerfile` (`FROM
  ghcr.io/stakwork/staklink-js` by default, hive's `dockerfileContent`),
  once per content hash; `/workspaces` is the pod's overlay volume; the
  config files are in `/workspaces/.pod-config/.user-dockerfile/`,
  staklink's `POD_CONFIG_DIR`. Its command runs `npx -y staklink@<pinned>
  start` (staklink's README) and code-server, with `CODE_SERVER_PASSWORD`
  set to a password the manager makes for the pod. Neither is in the
  staklink images (`docker/Dockerfile` installs pm2, goose, Playwright and
  gitleaks). Today something outside the image adds both: the pool's
  platform, whose code none of these repos holds.
- **Refused**, so the pod is not made and the reason is given:
  `privileged`, `cap_add`, `devices`, `security_opt`, `pid`/`ipc`/
  `network_mode`/`userns_mode` set to `host`, the Docker socket, and any
  bind mount whose source is outside the pod's folder (a relative path
  that resolves inside it, such as an `init.sql`, is allowed).

No pod gets the Docker socket. staklink's `PUT /pod-config` runs `docker
compose up -d` itself today, through the socket the
`docker-outside-of-docker` feature mounts. On the pod box that is the
manager's job (`apply`, §5).

The ports inside a pod: staklink's control server on 15552, goose's web UI
on 15551, code-server on 8444 (`CODE_SERVER_PORT`), and the frontend: the
`PORT` of the first pm2 app that has one or is named `frontend`, else 3000
(as staklink finds it, `src/proxy/server.ts`).

## 5. The API

The Hive calls the `pod/*` steps make, at the same paths and in the same
shapes, so one set of steps works against either while both exist (§8):

| Call | Path | On the pod box |
|---|---|---|
| Claim | `POST /api/pool-manager/claim-pod/:workspace?job=&run=&generation=new` | The job's own pod: made from the workspace's current template on the job's first claim, the same pod on every later one. With `generation=new`, a second pod from the current template, the one a promoted config fix is checked on (`pod-config.md` §4). Answers `{ podId, password, frontend, ide, control, generation }`. 409: the current generation has no template yet. |
| Drop | `POST /api/pool-manager/drop-pod/:workspace?podId=&job=` | Deletes the pod: its containers and its folder. 404: already gone. |
| Read the config | `GET /api/workspaces/:workspace/stakgraph` | `{ data: { services, environmentVariables, containerFiles, rollout } }`. Env values masked as Hive masks them; the files base64. |
| Write the config | `PUT /api/workspaces/:workspace/stakgraph` | `services` and env replace the stored ones whole, as Hive's do; `pm2.config.js` is generated from `services` (hive's `generatePM2Apps`). A new generation: its template is built, `rollout` says when it is `ready`. Answers `{ changeId, rollout }`. |

New calls:

- **`PUT /workspaces/:workspace { repositories, githubToken }`**: makes or
  changes a workspace: its repositories (`url`, `branch`) and the token
  that templates are cloned with (§7). In Hive this is pool creation
  (`src/app/api/pool-manager/create-pool/route.ts`).
- **`POST /pods/:podId/apply`**: writes the workspace's stored files into
  a pod and makes its compose project again. `pod/config-apply` calls it
  before staklink reloads the apps, because the pod cannot run compose
  itself (§4).
- **`POST /pods/:podId/sleep`** and **`POST /pods/:podId/wake`**: for a
  caller that knows better than the idle timer. A job turn that ends can
  put its pod to sleep at once; one that starts can wake it ahead of its
  first call.

Every call takes `x-api-token: <key>`, as Hive's do. The manager's state
is the folders of §1 and §2 plus one JSON file per workspace, the tokens
encrypted. There is no database.

## 6. Reaching a pod

- **Caddy → the manager → the pod.** Caddy terminates TLS; the manager is
  in the path of every request, since it wakes pods and counts idle time
  (§3), and proxies to the pod's port, sockets included (HMR,
  code-server).
- **Names per pod.** Pods outnumber running pods, and a link must survive
  a sleep, so each pod keeps its names for its life: `<podId>.<pods host>`
  (the frontend), `<podId>-ide.<pods host>` and
  `<podId>-control.<pods host>`. That needs one wildcard DNS record and a
  wildcard certificate: Caddy with the DNS provider's module (DNS-01) and
  an API token for the org's DNS in the pod box's env. A certificate per
  pod name would hit Let's Encrypt's per-domain weekly limits. A pod box
  Stakwork runs can use a wildcard domain of Stakwork's, as Hive's pods
  do.
- **`control` and `ide`** sit behind the pod's password, as today:
  staklink takes it as a bearer token, and its `/ide-auth` signs
  short-lived IDE links with it.
- **`frontend`** is open, as Hive's pods are today (open question 3).

## 7. Credentials

| Credential | Held by | Reaches |
|---|---|---|
| The manager's key | the pod box's env; strut as the deployment secret `PODS_KEY` | the manager's API |
| A pod's password | the manager makes it; `pod/claim` seals it, as today | staklink and code-server in that pod |
| The token templates are cloned with | the manager, encrypted, per workspace | `git clone` and `fetch` in the manager, never a pod's env. Hive's pool keeps one person's token the same way today (`github_pat`, `create-pool/route.ts`) |
| The person's GitHub token | strut's actor secret `GITHUB_TOKEN` | passed per call by `pod/latest` and `pod/push`, as today (`gitCredentials`) |
| Model calls | the run's grant, `<vk>.<macaroon>`, passed per `/agent` call, as today | the org's gateway: Stadeum's stack publishes Bifrost at `bifrost.<HOST>` (`stack/stadeum.yml`; the Caddy that replaces Traefik must keep the route) |
| The DNS token | the pod box's env | the wildcard certificate (§6) |

A pod reaches the internet (installs, the gateway). It reaches the
manager's API only through Caddy, like anyone else, and holds no key for
it.

## 8. What changes, per repo

**strut**

- **`images/pods`**: the manager, a small Node service with the Docker CLI
  and compose, and the host's Docker socket. It is the only thing on the
  pod box that has the socket.
- **`deploy/pods`**: the pod box's compose file (the manager, Caddy, the
  cache volumes) and an `env.example`, run from its folder like
  `deploy/index` and `deploy/voice`.
- **`src/steps/lib/pod/`**: the lab's thirteen `pod/*` steps moved into
  strut with the same names, inputs and outputs. They read `PODS_URL` and
  `PODS_KEY`, else `HIVE_URL` and `HIVE_API_KEY`, so they run on a Stadeum
  box and on a swarm alike. Beyond that:
  - `pod/config-apply` calls the manager's `apply` before staklink's
    reload.
  - `pod/claim` takes an idle job's pod (`takeIdlePod`) only from Hive. A
    pod box does not run out of pods the way a pool does, only of running
    room, and it waits for that (§3).

  A custom step never shadows a lib step (`buildRegistry`, registry.ts:
  the collision is skipped with a warning). So once the lab's strut pin
  includes these, its seeded copies are skipped and the lab deletes them in
  the same change.
- **The `Pod` page**, wherever it lives (open question 1), says what a pod
  box gives: the pod is the job's until the job lets it go; uncommitted
  work survives a sleep; processes do not, so a turn lets its pod's agent
  finish before it ends.
- **`specs/PODS.md`**: the manager's API, for anyone who runs a pod box.

**staklink**

- The resume start (§3): rebuild and install skipped when unchanged,
  post-start skipped, on a wake.
- `GET /busy` (§3).
- `PUT /pod-config` without a Docker socket: it writes the files and
  reloads the apps, and leaves compose to the manager.

**stadeum**

- Nothing in its stack: the pod box is a deployment of its own. Strut on
  the Stadeum box needs the two secrets and `pod/*` in the job's tools
  (`STRUT_HOST_CONFIG`: `job.tools`).

## 9. Order

1. **The manager, one pod:** a template from a builder pod; a pod over it;
   the compose rewrite; claim and drop. Tested on a fixture workspace with
   Postgres, two pods at once.
2. **Sleep and wake:** the manager as the proxy, wake on request, the idle
   timer, `maxRunning`; staklink's resume start and `GET /busy`.
3. **Caddy and `deploy/pods`:** per-pod names, the wildcard certificate.
4. **The `pod/*` steps into strut:** config read and write against the
   manager, `apply`.
5. **A live run**: a Stadeum box and a pod box. A job claims a pod for a
   workspace with Postgres, runs its tests, leaves it uncommitted; the pod
   sleeps; hours later a second turn finds it as it was and opens a pull
   request. Then twenty jobs with pods and a `maxRunning` of four.
6. **Later:** an exec seam, so strut's own `agent` runs its bash and
   editor in the pod and goose becomes optional; pods that move between
   pod boxes.

## Open questions

1. **The `Pod` and `Pod Config` pages** (and `Code Change`, their parent in
   the lab): strut seeds them when `PODS_URL` is set, or a package carries
   them. *Mine: strut, only with a pod box.* A page about a tool the box
   does not have would mislead the job agent.
2. **Who sets up a workspace on the pod box**, that is, its repositories
   and the token its templates are cloned with: a person in stadeum-ui, or
   a strut step run as a proposal the person accepts, with their
   `GITHUB_TOKEN`.
3. **A pod's frontend**: open as today, or behind sign-in.
4. **A workspace's devcontainer files**: today they are Hive's stored pool
   config. They move to the pod box with the rest of Hive's export
   (`org-home-swarm.md` §5).
5. **One pod box per org**, or one Stakwork runs for several orgs. Pods
   hold the org's code, which argues for per org.
6. **How long a pod may sleep.** Today the idle sweep deletes a job's pod
   after `STRUT_WORKDIR_TTL_DAYS` (7) unused. A sleeping pod costs only its
   layers, so a longer life may be worth the disk.
7. **Which pre-start commands a wake must run**: some only set up what
   the start needs (a migration), others do work the folder already holds.
   The resume start skips rebuild, install and post-start; pre-start is
   open.
