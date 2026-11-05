# Pods on a pod box: a pod manager without Hive

> **Status (2026-11-05): proposed. Nothing is built.** The direction was
> agreed in one design conversation with the owner: rows marked **agreed**
> in "Decided" are the owner's; everything marked *proposed* is mine and
> open. Read against strut `main` @75a9860, staklink `main` @f17f572,
> stakgraph `main` @b8f16c5b (the lab's `pod/*` steps,
> `mcp/src/lab/pods/`), hive `master` @c692b96bf and stadeum `main`
> @269481d. Companions: `org-home-swarm.md` §0 (a Stadeum box stands alone
> and Hive goes away), `pod-config.md` (the fix-then-promote loop this
> keeps), `jobs.md` §6 (holds), `code-change.md` (strut's own path to a
> pull request, with no pod).

## Problem

A job that must run the app needs a pod: to build it, to test it against a
real database, or to let a person click through it. Today a pod comes from
Hive. The lab's `pod/*` steps claim one through Hive's API
(`POST /api/pool-manager/claim-pod/:workspace`), and Hive asks its pool
manager (`POOL_MANAGER_BASE_URL`, a Kubernetes service Stakwork runs). The
claim is held on the job, and every other step drives staklink inside the
pod. The pool builds each pod from the files Hive keeps per workspace:
`Dockerfile`, `docker-compose.yml`, `pm2.config.js`.

A Stadeum box has no Hive, no lab and no Kubernetes. Stadeum's rule 9 says
no runtime call to Hive or sphinx-swarm. So it has no pods, and no `pod/*`
steps either, since the lab seeds those.

What strut does without a pod: a job directory, `git/checkout` worktrees
from the bare cache, an agent with bash, and `git/diff`, `git/apply`,
`git/push` and `github/create-pr` (`code-change.md`). That covers a change
judged by its diff and its unit tests. It does not cover a change that
needs the app running with its services.

## Decided

| Question | Decision |
|---|---|
| Where pods run | **agreed.** On a VM of their own, the **pod box**, beside the Stadeum box. Never on the Stadeum box itself: a build or a dev server must not slow down strut, Neo4j or the gateway, or get them killed for running out of memory. And a pod limited enough to be safe there builds slowly. |
| What a pod is | **agreed.** Containers made on demand from the workspace's devcontainer files as Hive keeps them today (`Dockerfile`, `docker-compose.yml`, `pm2.config.js`), with staklink inside. No Kubernetes. |
| One container with a worktree per task, instead | **agreed: no.** That is strut's job directory, kept for changes that do not need the app running. It cannot give jobs that run at the same time their own Postgres, their own ports, or any isolation from each other. |
| Where the code lives | *proposed.* In strut's repo: `images/pods` (the manager), `deploy/pods` (the pod box's compose file), and the `pod/*` steps as lib steps. This follows the browser: `images/browser` and `browser/*`. |

## 1. A pod on the pod box

A pod is one compose project, `docker compose -p pod-<id>`. The manager
does what the Kubernetes platform does when it makes a pod today:

1. **The image.** Build the workspace's `Dockerfile` (`FROM
   ghcr.io/stakwork/staklink-js` by default, hive's `dockerfileContent`)
   once per content hash. BuildKit's cache serves the next build.
2. **The pod's directory.** `<data>/pods/<id>/workspaces` on the host,
   mounted as `/workspaces`. The workspace's repositories are cloned into
   `/workspaces/<repo>`. The config files go in
   `/workspaces/.pod-config/.user-dockerfile/`, staklink's `POD_CONFIG_DIR`.
   `/workspaces/setup-status` exists while setup runs, and staklink waits
   on it (`waitForSetupComplete`).
3. **Compose up**, with the file rewritten as §2 says. The `app` service
   runs `npx -y staklink@<pinned> start` (staklink's README) and
   code-server, with `CODE_SERVER_PASSWORD` set to a password the manager
   makes for this pod. Neither is in the staklink images
   (`docker/Dockerfile` installs pm2, goose, Playwright and gitleaks).
   Today something outside the image adds both: the pool's platform, whose
   code none of these repos holds. Here the manager does, from the shared
   caches (§3).
4. **staklink** starts the pm2 apps as it does today: rebuild, install,
   pre-start, start, post-start.

The ports inside a pod: staklink's control server on 15552, goose's web UI
on 15551, code-server on 8444 (`CODE_SERVER_PORT`), and the frontend: the
`PORT` of the first pm2 app that has one or is named `frontend`, else 3000
(as staklink finds it, `src/proxy/server.ts`).

## 2. The compose rewrite: a pod's containers share one localhost

In Kubernetes, a pod's containers share one network namespace, so the app
reaches its Postgres at `localhost:5432`. Compose gives each container its
own network. Workspace files work around that by publishing ports to the
host and pointing `localhost` at the host gateway. Hive's own
`.devcontainer/docker-compose.yml` does exactly this:
`container_name: hive-postgres-dev`, `ports: "5432:5432"`, and `extra_hosts:
"localhost:172.17.0.1"`. Two copies of that file on one Docker host
collide.

The manager runs every service but `app` inside `app`'s network namespace,
with `network_mode: "service:app"`, and drops what would collide.
**Checked** (2026-11-05, Docker 29.6): two compose projects side by side,
each with its own Postgres on `localhost:5432`, each saw only its own data.
Inside one pod two services still cannot share a port, as in Kubernetes.

Per service:

- **Every service but `app`:** `network_mode: "service:app"`; `ports`,
  `networks`, `extra_hosts` and `hostname` dropped.
- **Every service:** `container_name` dropped (a named volume already
  belongs to its project); a memory and CPU limit, set generously, since
  the box is the real limit and builds need room.
- **`app`:** the image from §1, the pod's directory as `/workspaces`, and
  staklink's command.
- **Refused**, so the pod is not made and the reason is given:
  `privileged`, `cap_add`, `devices`, `security_opt`, `pid`/`ipc`/
  `network_mode`/`userns_mode` set to `host`, the Docker socket, and any
  bind mount whose source is outside the pod's directory (a relative path
  that resolves inside it, such as an `init.sql`, is allowed).

No pod gets the Docker socket. staklink's `PUT /pod-config` runs `docker
compose up -d` itself today, through the socket the
`docker-outside-of-docker` feature mounts. On the pod box that is the
manager's job (§4).

## 3. Speed

- **Warm pods.** A workspace's config names `warm`, default 1: pods made
  before anyone claims them, so a claim is instant, as with Hive's pool. A
  claimed pod is replaced. `max`, for the whole box, caps the number of
  pods; past it a claim answers 503, as Hive's does.
- **One image per `Dockerfile`**, rebuilt only when its hash changes.
- **Shared package caches.** Volumes for npm, yarn, pnpm's store, cargo,
  go, uv and Playwright's browsers, mounted at each tool's cache path in
  every pod. Installs then mostly copy instead of downloading. npm's cache
  and pnpm's store can safely be written by two installs at once. yarn v1's
  cache needs its `--mutex` flag for that, so it stays per pod until that
  is settled.
- **Generations.** A config write starts a new generation. Warm pods of the
  old one are replaced; claimed ones keep running. This is Hive's
  `generation: new | old`, which `pod/claim { fresh: true }` asks for.
- **Later, not v1:** a warm pod's `/workspaces` after its install becomes a
  template that the next pod copies (a reflink copy where the filesystem
  has one). A new pod then fetches and installs only what changed.

## 4. The API

These are the calls the `pod/*` steps make to Hive, at the same paths and
in the same shapes, so one set of steps works against either while both
exist (§7):

| Call | Path | Answer |
|---|---|---|
| Claim | `POST /api/pool-manager/claim-pod/:workspace?job=&run=&generation=new` | `{ podId, password, frontend, ide, control, generation }`. 503: no pod to give (at `max`). 409: no pod of the new generation ready yet. |
| Drop | `POST /api/pool-manager/drop-pod/:workspace?podId=&job=` | 404: already gone. 409 `reassigned`: another claimant holds it now. |
| Read the config | `GET /api/workspaces/:workspace/stakgraph` | `{ data: { services, environmentVariables, containerFiles, rollout } }`. Env values masked as Hive masks them; the files base64. |
| Write the config | `PUT /api/workspaces/:workspace/stakgraph` | `services` and env replace the stored ones whole, as Hive's do; `pm2.config.js` is generated from `services` (hive's `generatePM2Apps`). Answers `{ changeId, rollout }`. |

Two calls are new:

- **`PUT /workspaces/:workspace { repositories, githubToken }`**: makes or
  changes a workspace: its repositories (`url`, `branch`) and the token
  that warm pods are cloned with (§6). In Hive this is pool creation
  (`src/app/api/pool-manager/create-pool/route.ts`).
- **`POST /pods/:podId/apply`**: writes the workspace's stored files into
  a claimed pod and brings its compose project up. `pod/config-apply` calls
  it before staklink reloads the apps, because the pod cannot run compose
  itself (§2).

Every call takes `x-api-token: <key>`, as Hive's do. The manager's state
is one JSON file per workspace and one per pod in its data directory, with
the tokens encrypted. There is no database.

## 5. Reaching a pod: the pod box's Caddy

- **Names per slot, not per pod.** The manager runs at most `max` pods, so
  slot N has three fixed names: `p<N>.<pods host>` (the frontend),
  `p<N>-ide.<pods host>` and `p<N>-control.<pods host>`. A slot is reused,
  so each name's certificate is issued once and Let's Encrypt's weekly
  limits never come into play. Caddy's on-demand TLS asks the manager which
  names exist. The DNS is one wildcard record, `*.<pods host>`, and no DNS
  API (a wildcard certificate would need one).
- **`control` and `ide`** sit behind the pod's password, as today:
  staklink takes it as a bearer token, and its `/ide-auth` signs
  short-lived IDE links with it.
- **`frontend`** is open, as Hive's pods are today (open question 3).
- **`browser-explore`** on the Stadeum box opens the frontend's public URL.

## 6. Credentials

| Credential | Held by | Reaches |
|---|---|---|
| The manager's key | the pod box's env; strut as the deployment secret `PODS_KEY` | the manager's API |
| A pod's password | the manager makes it; `pod/claim` seals it, as today | staklink and code-server in that pod |
| The token warm pods are cloned with | the manager, encrypted, per workspace | `git clone` and `fetch` in the manager, never the pod's env. Hive's pool keeps one person's token the same way today (`github_pat`, `create-pool/route.ts`) |
| The person's GitHub token | strut's actor secret `GITHUB_TOKEN` | passed per call by `pod/latest` and `pod/push`, as today (`gitCredentials`) |
| Model calls | the run's grant, `<vk>.<macaroon>`, passed per `/agent` call, as today | the org's gateway: Stadeum's stack publishes Bifrost at `bifrost.<HOST>` (`stack/stadeum.yml`; the Caddy that replaces Traefik must keep the route) |

A pod reaches the internet (installs, the gateway). It reaches the
manager's API only through Caddy, like anyone else, and holds no key for
it.

## 7. What strut gains

- **`images/pods`**: the manager, a small Node service with the Docker CLI
  and compose, and the host's Docker socket. It is the only thing on the
  pod box that has the socket.
- **`deploy/pods`**: the pod box's compose file (the manager, Caddy, the
  cache volumes) and an `env.example`, run from its folder like
  `deploy/index` and `deploy/voice`.
- **`src/steps/lib/pod/`**: the lab's thirteen `pod/*` steps moved into
  strut with the same names, inputs and outputs, so the lab's `Pod` and
  `Pod Config` pages read true. They read `PODS_URL` and `PODS_KEY`, else
  `HIVE_URL` and `HIVE_API_KEY`, so they run on a Stadeum box and on a
  swarm alike. Two changes beyond that:
  - `pod/config-apply` calls the manager's `apply` before staklink's
    reload.
  - `pod/claim` treats a 503 that says a pod is being made (`starting:
    true`) as "try again shortly", and takes no idle job's pod for it.

  A custom step never shadows a lib step (`buildRegistry`, registry.ts:
  the collision is skipped with a warning). So once the lab's strut pin
  includes these, its seeded copies are skipped and the lab deletes them in
  the same change.
- **`specs/PODS.md`**: the manager's API, for anyone who runs a pod box.

On a Stadeum box, strut needs the two secrets and `pod/*` in the job's
tools (`STRUT_HOST_CONFIG`: `job.tools`), plus the pages (open question 1).
Stadeum's own stack is unchanged: the pod box is a deployment of its own.

## 8. Order

1. **The manager, one pod:** build, clone, rewrite, compose up, staklink
   start; claim and drop; `warm` and `max`. Tested on a fixture workspace
   with Postgres, two pods at once.
2. **Caddy's slots and `deploy/pods`.**
3. **The `pod/*` steps into strut:** config read and write against the
   manager, `apply`, `starting`.
4. **The shared caches.**
5. **A live run**: a Stadeum box and a pod box. A job claims a pod for a
   workspace with Postgres, runs its tests, and opens a pull request; then
   two jobs at once.
6. **Later:** templates (§3); an exec seam, so strut's own `agent` runs
   its bash and editor in the pod and goose becomes optional; stopping an
   idle pod box.

## Open questions

1. **The `Pod` and `Pod Config` pages** (and `Code Change`, their parent in
   the lab): strut seeds them when `PODS_URL` is set, or a package carries
   them. *Mine: strut, only with a pod box.* A page about a tool the box
   does not have would mislead the job agent.
2. **Who sets up a workspace on the pod box**, that is, its repositories
   and the token its warm pods are cloned with: a person in stadeum-ui, or
   a strut step run as a proposal the person accepts, with their
   `GITHUB_TOKEN`.
3. **A pod's frontend**: open as today, or behind sign-in.
4. **A workspace's devcontainer files**: today they are Hive's stored pool
   config. They move to the pod box with the rest of Hive's export
   (`org-home-swarm.md` §5).
5. **One pod box per org**, or one Stakwork runs for several orgs. Pods
   hold the org's code, which argues for per org.
6. **A claim when no pod is warm and the box has room**: answer 503 at once
   (start one, try again), or hold the request until the pod is up.
