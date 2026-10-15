# Onboarding — a workspace's first pod config, as a job

> **Status (2026-10-15): PROPOSED.** Written after reading mcp's
> `/services_agent` (`stakgraph@e07e3fb0`: `mcp/src/repo/services.ts`,
> `services_utils.ts`, `gitsee/agent/prompts/services.ts`), the lab's
> `gitsee/*`, `pods/*` and `job/*`, hive's onboarding and pool code
> (`hive@7bbf143d4`: `api/swarm/stakgraph/services`, `agent-stream`,
> `WorkspaceSetup.tsx`, `pool-status-widget`, `devContainerUtils.ts`,
> `strut-runs.ts`, `strut-jobs.ts`, `strut-target.ts`,
> `docs/pool-config-agent-api.md`) and staklink's pod-config and startup
> code (`staklink@a5527f4`).
>
> Rulings made in conversation:
> - Onboarding is a JOB. Hive starts it in a Jamie conversation; the job
>   agent runs `identify-services` as a child run, writes the result with
>   `pod/config-set` and checks it on a pod. Every improvement to Jamie,
>   strut and the job path helps onboarding too.
> - `identify-services` is a new workflow, not `explore`. Its setup
>   knowledge is Concepts under one root that the workflow MUST load, and
>   the Concepts' first text is production's rules.
> - Multi-repo from the start.
> - Its output is the pool config API's shape: `services` plus container
>   files. There is no `app` service in the compose file (the pool manager
>   no longer needs one), and the Dockerfile is optional, defaulting to
>   `ghcr.io/stakwork/staklink-js:latest`.
> - Whatever code can guarantee, code guarantees.
> - No 20-minute wait. The draft is applied inside a pod that is already
>   running, through a new staklink `PUT /pod-config` and a `pod/*` step
>   for it, and promoted with `wait: false`.
> - Once the switch lands, retire the old onboarding path and the lab's
>   `gitsee-*`.
> - Android, including a workspace with both Android and web repos, comes
>   later. The job's strut (the org default) needs no Mothership.
>
> My calls beyond those are listed in §14. Companion: `pod-config.md`, the
> repair path this builds on (fix in the pod, promote to the pool).

## 1. Goal

A new workspace gets a pod running its app, checked, as fast as the app's
own install and build allow, and the person watches it happen in a Jamie
conversation. A quick read of the repositories writes the first draft; a
job checks it on a pod and repairs it there. When anything fails, the
workspace still has a config its pods boot from.

## 2. Today

- **Onboarding.** `WorkspaceSetup.tsx` calls `GET
  /api/swarm/stakgraph/services`, which calls mcp `GET
  :3355/services_agent?owner&repo&username&pat` and gets a `request_id`.
  The browser's EventSource on `/api/swarm/stakgraph/agent-stream` polls
  mcp `/progress` for up to 10 minutes. On success it parses
  `pm2.config.js` into `services`, adds hive's fixed Dockerfile and
  `devcontainer.json`, saves, and sets `containerFilesSetUp`. The fallback
  when the call fails is mcp `/services` (no LLM).
- **The pool.** The dashboard's `pool-status-widget` creates it, from the
  browser, once `containerFilesSetUp` is true. With no services, hive's pm2
  default is a `default-service` running `npm start` with npm's install and
  build (`generatePM2Apps`), not a `frontend`.
- **mcp** (`repo/services.ts`, two steps since stakgraph#1227): pre-scan →
  the repo agent with `SETUP_PROFILER` and a schema → `selectSetupHints` →
  the repo agent with `EXPLORER` + `FINAL_ANSWER` → `FILENAME:` blocks.
  One repository.
- **What breaks.** Two steps hang on a browser: the result is saved inside
  an SSE response the onboarding page holds open, and the pool is created
  by a dashboard widget. The model writes pm2 JavaScript and compose YAML
  as free text. The `frontend` name, `localhost` hostnames and `0.0.0.0`
  are prompt rules, and so is an `app` block the pool manager no longer
  needs. The hints are code. Nothing checks that the app runs.
- **The repair path that exists** (`pod-config.md`, built): `pod/claim`,
  `pod/config` (hive's config beside the pod's files, with a diff),
  `pod/config-set` (write hive's pool config; `wait` until a new pod is
  RUNNING: hive's rollout is `ready` at the FIRST new, unused, running pod;
  20 minutes is only the timeout), `pod/claim { fresh: true }`, and the
  `Pod Config` page. A config change reaches a pod only when the pod is
  created. Staklink can read the files a pod runs from (`GET /pod-config`)
  but nothing can write them from outside: a change goes through
  `pod/agent` (goose edits, then `npx -y staklink reload`).

## 3. The flow

**Hive, at workspace setup** (§4):
1. Write the placeholder config: one `frontend` service, `npx -y
   hell0-w0rld` on port 3000 with no install; compose `services: {}`; the
   default Dockerfile. Create the pool server-side and set
   `containerFilesSetUp`, so the dashboard shows at once. The pods boot
   fast, because nothing of the repository is installed yet.
2. Once the pool is up, start the onboarding job in a Jamie conversation
   for the person, with a fixed prompt naming the workspace and its
   repositories.

**The job's turn** (the `Onboarding` page, §5):
1. `pod/claim { workspace }`: a placeholder pod. It is in use from now on,
   so the push in step 3 leaves it alone (it is updated on release).
   Report the pod and IDE links right away.
2. `meta/run-workflow identify-services { repos }`: the draft (§6), the
   only step heavy on the LLM.
3. `pod/config-set { services, containerFiles, wait: false }`: hive saves
   the config, generates pm2 from `services` and pushes. The step returns
   once the push is accepted, and unused pods are recreated in the
   background. No ask: this is a new workspace's first config, and the
   person asked to be onboarded.
4. `pod/config-apply { workspace, control, sealed }` (§11): hive's stored
   files, exactly what a new pod gets, pm2 included, go into the claimed
   pod. The compose services come up and the apps reload (install, build,
   start). It waits for the reload.
5. Check. Author the job's claims (the frontend answers at `{{
   input.urls.pod }}` through `http/verify`; a page renders through
   `browser/verify`), run `browser-explore` on the frontend, and verify
   with `meta/verify-job`.
6. If it works, report the `pod-config` deliverable (what was decided, the
   pages it rests on) and a screenshot. Done.
7. If it doesn't, follow the `Pod Config` loop: fix it in the pod
   (`pod/agent`), promote the fix with `pod/config-set`, and, since a fix
   made by hand is what a fresh pod catches, run `pod/claim { fresh: true
   }` only AFTER reporting the pod that works.

**The critical path** is claim (a pod already running) + the draft + the
push + the app's own install and build in one pod + the check. No pod is
created on it. The exception is a Dockerfile other than the default: a
base image changes only when the pod is recreated (§11). Web never needs
one; Android comes later.

**Why step 3 comes before step 4:** there is then one generator of the pod
files, hive's (pm2 from `services`, `resolveCwd`, the env merge). The pod
runs the same files a fresh pod will, so a draft that works needs no
fresh-pod check. The cost is that the draft reaches the pool before it is
checked; at onboarding the pool holds only placeholders, so there is
nobody's work to break. The alternative is §14.2.

## 4. Hive

- **Setup:** the placeholder config (§3), the pool created server-side
  (not from `pool-status-widget`), and `containerFilesSetUp` set at once.
  A workspace always has a config its pods boot from: a failed job leaves
  the placeholder.
- **Start the job:** `launchJobTurn` (`strut-jobs.ts`) into a new Jamie
  conversation for the person. The prompt is fixed, e.g. `Onboard
  @<slug>: get its app running in a pod. Repositories: <urls>`; it is not
  produced by Jamie's model. One onboarding job per workspace (record its
  id). The job's launch already pushes the person's `GITHUB_TOKEN` as an
  actor secret.
- **The pod-repair cron** (`pod-repair-cron.ts`) skips a workspace while
  its onboarding job has a live turn (`jobHasLiveTurn`). Otherwise the
  Stakwork repair and the job would be fixing the same pods at once.
- **Removed:** `WorkspaceSetup`'s services step, `/api/swarm/stakgraph/services`,
  `agent-stream`, `pollAgentProgress` + `fetchStakgraphServices`;
  `Swarm.agentRequestId` / `agentStatus` in a later migration.

## 5. The `Onboarding` page

A new Concept under `Job`, beside `Code Change`, `Plan Mode`, `Explore`
and `Verify`, in `mcp/src/lab/job/concepts/`. Its docs are §3's job turn:
the steps, the order and why; that the first `pod/config-set` does not
ask; the artifacts (pod, IDE, `pod-config`, screenshot); the claims to
author and verify; the fresh-pod check only after a fix made by hand; and
`Pod Config` for anything else. Which workflow drafts the config is
written on this page, so it is graph data like every other kind of work.

## 6. `identify-services`

`mcp/src/lab/pods/workflows/identify-services.yaml`, seeded by the pods
seed. Input: `repos` (json, one or more repository URLs). On a job it is a
child run, so it reads the person's `GITHUB_TOKEN`.

```yaml
steps:
  - id: dir
    type: job/dir
  - id: checkouts
    type: foreach
    config:
      items: "{{ input.repos }}"
      body: { id: checkout, type: git/checkout, config: { repo: "{{ $current }}" } }
  # NEW: production's buildRepoFacts, per repository
  - id: facts
    type: pod-setup/repo-facts
    config: { dir: "{{ dir.path }}", repos: "{{ checkouts.map(c => c.repo) }}" }
  - id: root
    type: graph/graph-get
    depends: []
    config: { node_type: Concept, name: "{{ params.root }}", children: PARENT_OF, required: true }
  - id: catalog
    type: graph/graph-get
    depends: []
    config: { node_type: Concept, name: "{{ params.localServices }}", children: PARENT_OF, required: true }
  - id: profile
    type: agent
    depends: [facts, root, catalog]
    config:
      cwd: "{{ dir.path }}"
      toolFilter: "{{ params.builtins }}"
      system: "{{ params.profiler }}"
      prompt: …                # root's docs, the children with their descriptions, the facts, the task
      schema: …                # per repo: platform enum "{{ root.children.filter(c => c.name != params.localServices).map(c => c.name) }}"
                               # local_services enum "{{ catalog.children.map(c => c.name) }}"
  - id: platformPages
    type: foreach
    config:
      items: "{{ profile.object.platforms }}"
      body: { id: page, type: graph/graph-get, config: { node_type: Concept, name: "{{ $current }}", required: true } }
  - id: servicePages
    type: foreach
    depends: profile
    config:
      items: "{{ profile.object.local_services }}"
      body: { id: page, type: graph/graph-get, config: { node_type: Concept, name: "{{ $current }}", required: true } }
  - id: generate
    type: agent
    depends: [platformPages, servicePages]
    config: …                  # root's docs + the picked pages' docs + the profile + the facts; schema = §9's raw shape
  # NEW: §10's guarantees, in code
  - id: setup
    type: pod-setup/finish
    config: { dir: "{{ dir.path }}", raw: "{{ generate.object }}" }
```

`params`: `model`; `maxSteps` (per agent); `builtins`, explore's read-only
file tools (`repo_overview`, `fulltext_search`, `str_replace_based_edit_tool`,
`file_summary`; no bash and no web, both of which production had: the file
tools cover what bash did there); `root` (`Pod Setup`); `localServices`
(`Pod Setup: Local Services`); `profiler` and `generator`, short system
prompts, since the rules live in the Concepts.

- **The loads are steps, so the agent cannot skip them.** The root and the
  catalog load before the profile; the picked pages load before the
  generation. The enums are built from the children, so the profile can
  only pick a page that exists. Adding a platform means adding a file.
- **`required: true` on `graph/graph-get`** is new (§12). Today a missing
  node comes back as a string (`node not found: …`, `graph-get.ts:70`),
  which is right for a tool; a workflow needs the run to fail with that
  message.
- **Templated enums work as is.** Step config is resolved deeply before
  the agent runs (`resolveConfig`, `expr.ts:627`), a sole `{{ }}` keeps the
  array, and `filter`, `map` and `!=` are in the template language.
- **No graph search tools.** A new workspace's graph has no code in it
  yet; the steps load the Concepts.
- **The job runs it, so it stays deterministic.** The job agent decides
  what to do with the draft, not how it is drafted.

## 7. The Concepts

```
Pod Config                         (exists: Job → Code Change → Pod → Pod Config)
└── Pod Setup                      the contract every pod's files follow
    ├── Pod Setup: Web
    ├── Pod Setup: Android         (later)
    └── Pod Setup: Local Services  when a backing service gets a container, a CLI or a mock
        ├── Pod Setup: Postgres
        ├── Pod Setup: MySQL
        ├── Pod Setup: Redis
        ├── Pod Setup: RabbitMQ
        ├── Pod Setup: Elasticsearch
        ├── Pod Setup: Supabase
        ├── Pod Setup: S3-compatible Storage
        └── Pod Setup: LiveKit
```

- **Seeding.** The files go in `mcp/src/lab/pods/concepts/` and the
  existing seeder handles them: `parent` in front matter, `PARENT_OF`
  edges, a deleted seeded page restored, an edited one kept until its file
  changes. They are seeded into every workspace.
- **Names are prefixed.** A Concept is keyed by its name, and the seeder
  skips a name someone else owns. Without the prefix, a workspace's own
  `Postgres` or `Web` Concept would block the page.
- **First text = production's rules** (ruling). The root comes from
  `FINAL_ANSWER`: repos mounted at `/workspaces/<repo>`, one `frontend`,
  `0.0.0.0`, dev not start, the local-only policy, the env defaults. Web
  comes from the nextjs + vite hints and the package-manager rule, each
  dependency page from its hint. Two changes on the way. The `app` block
  goes (ruling): the pod is the container the apps run in, and the compose
  file holds only what runs beside them. And what code guarantees (§10) is
  stated once, as a fact, not as a MUST.
- **One set of rules.** `Pod Config.md` keeps its process and points to
  `Pod Setup` for what the files must say; its copies of the contract
  (`frontend`, `0.0.0.0`, `hell0-w0rld`, the per-repo cwd) move there.
- **A workspace can add its own page** under `Pod Setup` or `Local
  Services`. Unstamped, the seeder never touches it, and it shows up in the
  enums with no code change.

## 8. Multi-repo

- `repos` is a list from the start; hive's prompt names the workspace's
  repositories (one, at today's onboarding).
- They are checked out as siblings, the pod's `/workspaces/<repo>` layout;
  git/checkout names each directory after the repo, the name hive's
  `resolveCwd` matches.
- The profile is per repository: `{ repo, platform, role: app | dependency
  | none, package_manager, services: [...] }`. One repo is usually the app
  and the others are local dependencies it builds first.
- The output stays one config per workspace: one `services` list with
  exactly one `frontend`, one compose file, one Dockerfile.

## 9. Output

The pool config API's shape, which is `pod/config-set`'s input:

```
{ services: ServiceConfig[],   // hive's: name, port, cwd, interpreter?, scripts { start, install?, build?, test?, preStart?, postStart?, rebuild?, reset? }, env?
  containerFiles: { "docker-compose.yml": string, "Dockerfile"?: string },
  profile, pages: string[], cost }
```

The model never writes `pm2.config.js`; hive generates it from `services`.
`Dockerfile` comes only from a platform page that calls for one. When it
is absent, `pod/config-set` leaves the stored default.

The generation agent's raw shape is narrower than the output, so the parts
that must hold cannot be written wrong (§10):

```
{ frontend: Service, services: Service[],   // Service: { repo (enum of the checkouts), subdir?, port: integer, scripts { start, install, … }, env }
  local_services: { <name>: <compose service object> },   // never `app`
  dockerfile?: string }
```

## 10. Guarantees in code

The principle: whatever code can guarantee, code guarantees, and the model
supplies only judgement.

**The schema makes it impossible.**
- `frontend` is its own required field, and code names it `frontend`.
  There is always exactly one.
- A service's place is `{ repo: <enum of the checkouts>, subdir? }`, and
  code writes `cwd: /workspaces/<repo>[/<subdir>]`.
- `port` is an integer, and `scripts.install` is required.
- Pages come from enums (§6).

**`pod-setup/finish` fixes what is deterministic.** It is a self-contained
lab step, unit-tested offline.
- `subdir` must exist in the checkout; one that does not fails the step,
  naming the path.
- The compose file is assembled, not written: `services:` is the model's
  `local_services`, and every named volume a service mounts is declared at
  the top level. A service named `app` is dropped: the pod is the app's
  container. With no local services, the file is `services: {}`.
- Env values that name a compose service as their host (`@postgres:5432`,
  `//redis:6379`) get `localhost`.
- Code serializes the file (`dumpYaml`, §12), so the compose text always
  parses.

**The path never leaves a workspace without a config.**
- The placeholder config is written at setup (§4). A job that fails, at
  any step, leaves a pod that boots.
- The job writes only through `pod/config-set` and `pod/config-apply`,
  which hive's pool config API and staklink validate.
- One onboarding job per workspace; hive's pod-repair cron stays out of
  its way (§4).

Not guaranteed by code: that the start command binds `0.0.0.0`, uses the
dev script, and matches the package manager. Those are checked on the pod,
in step 5.

## 11. Staklink `PUT /pod-config` and `pod/config-apply`

**Staklink: `PUT /pod-config { files: [{ name, content }] }`**, the write
twin of `GET /pod-config` (staklink#145). It sits behind the pod's
password like every route, and it is async like `/install`
(`request_id`, then `/progress`).
- **Names are hive's:** `pm2.config.js`, `docker-compose.yml`,
  `Dockerfile`. Each is written where staklink reads it: the pm2 file at
  the path `findPm2Config` loads (else `POD_CONFIG_DIR/pm2.config.js`), the
  compose file and the Dockerfile in `POD_CONFIG_DIR`. A `.yaml` compose
  file is replaced by the `.yml`. Writes are atomic (temp file, then
  rename). `devcontainer.json` is never written.
- **A changed compose file** gets `docker compose up -d --remove-orphans`
  with that file. `startup()` never runs compose (the pod platform does,
  when it creates the pod), so the route has to, under the project name
  the platform used (§14.1).
- **Then the `/reload-apps` sequence:** stop the config's apps, flush the
  logs, `startup()` (rebuild, install, pre-run, start, post-run). It never
  stops staklink's own processes: the proxy, and the pod's agent.
- **A changed Dockerfile** is written, and the result says
  `rebuildNeeded: true`: the base image changes only when the pod is
  recreated.
- **Result:** `{ written, composeUp, rebuildNeeded, processes }`, or an
  error that names the phase (compose up, install, start) with the log
  tail.

**Lab: `pod/config-apply { workspace, control, sealed }`.** It makes the
claimed pod run hive's stored config. It reads hive's files in code
(`readStored` in `_pool.ts`, unmasked; the file text never reaches the
model, the same reason `pod/config` shows a masked view), PUTs them, waits
for the reload, and returns `{ applied, rebuildNeeded, processes }`. Being
in `pod/*`, it is a job tool: it is also how a job resets its pod to the
pool config after experimenting in it.

## 12. Strut

- `graph/graph-get` gets `required: true`: throw on a missing node instead
  of returning the string.
- The barrel re-exports `dumpYaml` / `loadYaml` (js-yaml, already a
  dependency), as it does `z`, so a seeded step can serialize YAML. A
  seeded step resolves only `strut`.

Both are small, and nothing else in strut changes. The new workflow steps
go in `pod-setup/*`, not `pod/*`: the job agent is granted `pod/*` as a
glob, and those two are not its tools.

## 13. Retire, once onboarding has run as a job on swarm38

- **mcp:** `/services_agent` (`index.ts:239`, `repo/services.ts`,
  `repo/services_utils.ts`); `/services` (`get_services`; check it has no
  other caller first); `gitsee_services` (already dead: no route); and the
  services mode of `src/gitsee/agent`. Its other modes stay, since `/gitsee`
  and `/agent` use them.
- **lab:** the `gitsee` seed. All six workflows go in `RETIRED_WORKFLOWS`
  and its steps in `retireSteps`; `buildGitseeServices` and its teardown
  leave `createLabStrut`; `gitsee/services/`, the smokes and
  `plans/gitsee-structured-scorer-and-subagents.md` go too.
- **hive:** §4's removals.
- **Not here:** the pod-repair Stakwork cron. Replacing it with a job is
  its own decision (§14).

## 14. Open

1. **The compose project name** staklink's `compose up` must use, so it
   updates the services the pod platform started instead of starting a
   second set. Settle it in the staklink PR.
2. **Check before push** (§3, step 3 before 4). The alternative is a hive
   dry-run (`PUT …/stakgraph?dryRun=1`, which returns the generated files
   without saving). The job would then render, apply, check, and only then
   `pod/config-set`. It costs a hive route and buys a draft that never
   reaches the pool unchecked.
3. **Measure the critical path on swarm38.** Install and build should
   dominate; nothing else should take minutes.
4. **My calls, not yet ruled:**
   - `Pod Setup` as a child of `Pod Config`, the prefixed page names, and
     `Local Services` as a third branch.
   - No bash or web for `identify-services`' agents.
   - The `pod-setup/*` namespace, and `required` + `dumpYaml` in strut.
   - Step 3 before step 4, and no ask on the first `pod/config-set`.
   - Hive starts the job itself, with a fixed prompt, rather than Jamie's
     model; the placeholder is a `hell0-w0rld` `frontend`; the pod-repair
     cron skips a live onboarding job.
   - `pod/config-apply` also serves as the job's "reset my pod".
5. **Later:**
   - Android, including a workspace with both Android and web repos: a
     non-default Dockerfile takes the recreate path (`pod/config-set {
     wait: true }`, then a fresh claim).
   - A repository added later (today `pendingRepairTrigger` → Stakwork) as
     the same job.
   - The pod-repair cron as a job.
   - Claims on `identify-services` itself, and the gold-facts scorer from
     `gitsee-eval` pointed at it.

## 15. Order

1. strut: §12, one PR.
2. staklink: `PUT /pod-config`.
3. mcp: `pod/config-apply`; the Concepts (§7, the `Onboarding` page §5,
   the trim of `Pod Config.md`); `pod-setup/repo-facts` and
   `pod-setup/finish` (unit tests: compose assembly, volumes, hostnames,
   subdir); the workflow; the pin bump. Then on swarm38, start an onboarding
   job by hand for a workspace whose pool already exists (a plain web app,
   one with postgres, a supabase app, a multi-repo workspace), and measure
   §14.3.
4. hive: §4.
5. Retire (§13).
