# identify-services — a workspace's first pod config, as a strut workflow

> **Status (2026-10-15): PROPOSED.** Written after reading mcp's
> `/services_agent` (`stakgraph@e07e3fb0`: `mcp/src/repo/services.ts`,
> `services_utils.ts`, `gitsee/agent/prompts/services.ts`), the lab's
> `gitsee/*` and `pods/*`, and hive's onboarding (`hive@7bbf143d4`:
> `api/swarm/stakgraph/services`, `agent-stream`, `WorkspaceSetup.tsx`,
> `services/strut-runs.ts`, `services/strut-target.ts`). Rulings made in
> conversation: a new workflow, not `explore`; the setup knowledge is
> Concepts under one root that the workflow MUST load; multi-repo from the
> start; the output is structured `services` + container files (the pool
> config API's shape); hive saves it on the run's callback; the Concepts'
> first text is production's rules; the old onboarding path and the lab's
> `gitsee-*` are retired once the switch lands; the Dockerfile is optional
> and defaults to `ghcr.io/stakwork/staklink-js:latest`; whatever code can
> guarantee, code guarantees; the pool manager no longer needs an `app`
> service in the compose file (the pod supplies the container), so the
> config has none — hive's own default compose, `services: {}`, already
> has none. My calls beyond those are listed in §12.
> Companion: `pod-config.md`, the repair half (a job fixes its pod, then
> the pool). This is the first-setup half that plan leaves to onboarding.

## 1. Goal

When a workspace is onboarded, one quick pass over its repositories writes
the pool config its first pod is built from: the services (pm2), the
compose file, and a Dockerfile when the platform needs one. It reads the
code; it never runs the app. Whether the app really runs is judged on a
pod, by the `Pod Config` path (`pod-config.md`). A pass that fails still
leaves a config a pod boots from.

## 2. Today

- **Hive.** Onboarding (`WorkspaceSetup.tsx`) calls `GET
  /api/swarm/stakgraph/services`, which calls mcp `GET
  :3355/services_agent?owner&repo&username&pat` and gets a `request_id`.
  The browser's EventSource on `/api/swarm/stakgraph/agent-stream` polls
  mcp `/progress` for up to 10 minutes; on success it parses
  `pm2.config.js` into `services`, adds hive's fixed Dockerfile and
  `devcontainer.json`, saves, and sets `containerFilesSetUp`. It runs once
  per swarm (skipped once `services` is non-empty). When the call fails,
  the fallback is mcp `/services`, which uses no LLM.
- **mcp** (`repo/services.ts`, two steps since stakgraph#1227, 2026-05-05):
  `buildRepoFacts` (languages, package files, env var names; no LLM) → the
  repo agent with `SETUP_PROFILER` and a schema → `selectSetupHints` → the
  repo agent with gitsee's `EXPLORER` + `FINAL_ANSWER` → `FILENAME:` blocks
  → `parse_files_contents`. One repository; `MY_REPO_NAME` substituted.
- **What breaks.** The result is saved inside the SSE response the
  onboarding page holds open. The model writes pm2 JavaScript and compose
  YAML as free text inside a text answer. The `frontend` name, `localhost`
  hostnames and `0.0.0.0` are prompt rules ("MUST", "IMPORTANT", "!!!"),
  and so is an `app` block in the compose file that the pool manager no
  longer needs: every config written today starts a container nothing
  uses. The hints are code.
- **The lab's `gitsee-*`** (stakgraph#1382) is a different design:
  `gitsee-setup-and-run` boots the app on the strut host with docker and
  Playwright. Nothing calls it.

## 3. The workflow

`mcp/src/lab/pods/workflows/identify-services.yaml`, seeded by the pods
seed beside its Concepts. Input: `repos` (json, one or more repository
URLs, the workspace's). Launched with the person as actor, so the
checkouts read their `GITHUB_TOKEN` (an actor secret hive's dispatch
pushes).

```yaml
steps:
  - id: dir
    type: job/dir
  - id: checkouts
    type: foreach
    config:
      items: "{{ input.repos }}"
      body: { id: checkout, type: git/checkout, config: { repo: "{{ $current }}" } }
  # NEW: production's buildRepoFacts, per repository (§9's namespace note)
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
    config: …                  # root's docs + the picked pages' docs + the profile + the facts; schema = §6's raw shape
  # NEW: §7's guarantees, in code
  - id: setup
    type: pod-setup/finish
    config: { dir: "{{ dir.path }}", raw: "{{ generate.object }}" }
```

`params`: `model`; `maxSteps` (per agent); `builtins`, explore's read-only
file tools (`repo_overview`, `fulltext_search`, `str_replace_based_edit_tool`,
`file_summary`; no bash, no web, which production had: the file tools
cover what bash did there); `root` (`Pod Setup`); `localServices` (`Pod
Setup: Local Services`); `profiler` and `generator`, short system prompts,
since the rules live in the Concepts.

- **The loads are steps, so the agent cannot skip them.** The root and the
  catalog load before the profile; the picked pages load before the
  generation. The profile picks pages from enums built from the children,
  so it can only name a page that exists. Adding iOS means adding a file.
- **`required: true` on `graph/graph-get`** is new (§9). Today a missing
  node comes back as a string (`node not found: …`, `graph-get.ts:70`),
  which is right for a tool; a workflow needs the run to fail with that
  message.
- **Templated enums work as is.** Step config is resolved deeply before
  the agent runs (`resolveConfig`, `expr.ts:627`), and a sole `{{ }}` keeps
  the array. `filter`, `map` and `!=` are in the template language.
- **No graph search tools.** At onboarding the workspace's graph has no
  code yet; the steps load the Concepts.

## 4. The Concepts

```
Pod Config                         (exists: Job → Code Change → Pod → Pod Config)
└── Pod Setup                      the contract every pod's files follow
    ├── Pod Setup: Web
    ├── Pod Setup: Android
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

- **Seeding.** The files go in `mcp/src/lab/pods/concepts/` (the
  `lab/pods/concepts/` set) and the existing seeder handles them: `parent`
  in front matter, `PARENT_OF` edges, a deleted seeded page restored, an
  edited one kept until its file changes. They are seeded into every
  workspace.
- **Names are prefixed.** A Concept is keyed by its name, and the seeder
  skips a name someone else owns. Without the prefix, a workspace's own
  `Postgres` or `Web` Concept would block the page.
- **First text = production's rules** (ruling). The root comes from
  `FINAL_ANSWER`: repos mounted at `/workspaces/<repo>`, one `frontend`,
  `0.0.0.0`, dev not start, the local-only policy, the env defaults. Web
  comes from the nextjs + vite hints and the package-manager rule, Android
  from the android hint, each dependency page from its hint. Two changes on
  the way: the `app` block goes (ruling; the root says the pod is the
  container the apps run in, and the compose file holds only what runs
  beside them), and what code now guarantees (§7) is stated once, as a
  fact ("cwd is written for you from the repo"), not as a MUST.
- **The Android page loses its `app` block too.** Production's hint is a
  fixed `app` + `redroid` structure, and the `app` half carried the ports
  (8000, 4724), the `adb-keys` volume and `depends_on: redroid`. What of
  that the pod still needs, and where it goes now, is settled on an
  Android pod before the page is written (§12).
- **One set of rules.** `Pod Config.md` keeps its process (fix in the pod,
  promote, check on a fresh pod) and points to `Pod Setup` for what the
  files must say. Its copies of the contract (`frontend`, `0.0.0.0`,
  `hell0-w0rld`, the per-repo cwd, the Android image, port and adb) move
  there. The job agent repairing a pod and this workflow then read the
  same rules.
- **A workspace can add its own page** under `Pod Setup` or `Local
  Services`. Unstamped, the seeder never touches it, and it shows up in the
  enums with no code change.

## 5. Multi-repo

- `repos` is a list from the start; hive sends the workspace's
  repositories (one, at today's onboarding).
- They are checked out as siblings in the run's directory, the pod's
  `/workspaces/<repo>` layout. git/checkout names each directory after the
  repo, the same name hive's `resolveCwd` matches.
- The profile is per repository: `{ repo, platform, role: app | dependency
  | none, package_manager, services: [...] }`. Usually one repo is the app
  and the others are local dependencies it builds first (the lab gitsee
  lesson).
- The output stays one config per workspace: one `services` list with
  exactly one `frontend`, one compose file, one Dockerfile. That is what
  hive stores per swarm.

## 6. Output

The pool config API's shape, the same one `pod/config-set` writes:

```
{ services: ServiceConfig[],   // hive's: name, port, cwd, interpreter?, scripts { start, install?, build?, test?, preStart?, postStart?, rebuild?, reset? }, env?
  containerFiles: { "docker-compose.yml": string, "Dockerfile"?: string },
  profile, pages: string[], cost }
```

The model never writes `pm2.config.js`: hive generates it from `services`
(`generatePM2Apps`), as it does for every other write. `Dockerfile` comes
only from a platform page that calls for one. When it is absent, hive
writes its default (`dockerfileContent()`,
`ghcr.io/stakwork/staklink-js:latest`), as it does today.

The generation agent's raw shape is narrower than the output, so the parts
that must hold cannot be written wrong (§7):

```
{ frontend: Service, services: Service[],   // Service: { repo (enum of the checkouts), subdir?, port: integer, scripts { start, install, … }, env }
  local_services: { <name>: <compose service object> },   // never `app`
  dockerfile?: string }
```

## 7. Guarantees in code

The principle: whatever code can guarantee, code guarantees, and the model
supplies only judgement. There are three layers.

**The schema makes it impossible.**
- `frontend` is its own required field, and code names it `frontend`. A
  workspace always has exactly one.
- A service's place is `{ repo: <enum of the checked-out repos>, subdir? }`,
  and code writes `cwd: /workspaces/<repo>[/<subdir>]`. There is no
  absolute path for the model to get wrong, and no `MY_REPO_NAME`.
- `port` is an integer, and `scripts.install` is required.
- Pages come from enums (§3).

**`pod-setup/finish` fixes what is deterministic.** It is a self-contained
lab step, unit-tested offline.
- `subdir` must exist in the checkout; one that does not fails the step,
  naming the path.
- The compose file is assembled, not written: `services:` is the model's
  `local_services`, and every named volume a service mounts is declared at
  the top level (the common "undefined volume" error). A service named
  `app` is dropped: the pod is the app's container, and an `app` service
  would start a container nothing uses. With no local services, the file
  is hive's own default, `services: {}`.
- Env values that name a compose service as their host (`@postgres:5432`,
  `//redis:6379`) get `localhost` (the rule production states as
  IMPORTANT).
- Code serializes the file, so the compose text always parses (YAML
  through the `dumpYaml` re-export, §9).

**Hive validates, and never leaves a workspace without a config.**
- The handler parses the output with zod; anything that doesn't parse is
  a failed run.
- A failed run (refused, crashed, timed out, invalid output) still saves a
  bootable minimum and marks setup done: a `frontend` of `npx -y
  hell0-w0rld` on port 3000, and the default compose file, `services: {}`.
  The pod comes up, and the `Pod Config` path repairs it there.
  The run's row records the failure.
- It is idempotent: one `PENDING` run of the kind per workspace; the
  handler is idempotent (the dispatch framework's rule); a lost callback is
  caught by the existing reconcile.

Not guaranteed, checked later (§12): that the start command binds
`0.0.0.0`, uses the dev script, and matches the package manager.

## 8. Hive

- The route `/api/swarm/stakgraph/services`: stored services → return
  them; a `PENDING` row → `PROCESSING`; otherwise `dispatchStrutRun({ kind:
  "identify_services", workflow: "identify-services", purpose: <new: the
  workspace's own swarm, like benchmark>, input: { repos }, actorSecrets:
  { GITHUB_TOKEN } })` → 202.
- The handler, `strut-runs/identify-services.ts`, writes `services` +
  `containerFiles` through the same code the pool config PUT runs
  (`syncPM2AndServices`: pm2 from services, `devcontainer.json`, the
  Dockerfile default, the per-service env table), then sets
  `containerFilesSetUp: true`. On failure it writes §7's minimum.
- `WorkspaceSetup.tsx` drops the EventSource. It learns the result from
  the workspace's `containerFilesSetUp` (a poll, or the handler's Pusher
  event).

## 9. Strut

- `graph/graph-get` gets `required: true`: throw on a missing node instead
  of returning the string.
- The barrel re-exports `dumpYaml` / `loadYaml` (js-yaml, already a
  dependency), as it does `z`, so a seeded step can serialize YAML. A
  seeded step resolves only `strut`.

Both are small, and nothing else in strut changes. The new lab steps go in
`pod-setup/*`, not `pod/*`: the job agent is granted `pod/*` as a glob, and
these are not its tools.

## 10. Retire, once the switch has run on swarm38

- **mcp:** `/services_agent` (`index.ts:239`, `repo/services.ts`,
  `repo/services_utils.ts`); `/services` (`get_services`, onboarding's
  fallback; check it has no other caller first); `gitsee_services` (already
  dead: no route); and the services mode of `src/gitsee/agent`
  (`prompts/services.ts`, the `"services"` `RepoContextMode`). Its other
  modes stay, since `/gitsee` and `/agent` use them.
- **lab:** the `gitsee` seed. All six workflows go in `RETIRED_WORKFLOWS`
  and its steps in `retireSteps`; `buildGitseeServices` and its teardown
  leave `createLabStrut`; `gitsee/services/`, the smokes and
  `plans/gitsee-structured-scorer-and-subagents.md` go too.
- **hive:** `agent-stream/route.ts`, `pollAgentProgress` +
  `fetchStakgraphServices`, the EventSource branch; `Swarm.agentRequestId`
  / `agentStatus` in a later migration.
- **Not here:** the pod-repair Stakwork cron (staklink `/repair`). Whether
  the `Pod Config` path replaces it is its own decision.

## 11. Order

1. strut: §9, one PR.
2. mcp: the Concepts (§4, including the trim of `Pod Config.md`),
   `pod-setup/repo-facts`, `pod-setup/finish` (unit tests: compose
   assembly, volumes, hostnames, subdir), the workflow, the pin bump. Run
   it by hand on swarm38 against a few repositories (a plain web app, one
   with postgres, a supabase app, an android app, a multi-repo workspace)
   and compare with what `/services_agent` gives for the same ones.
3. hive: the kind, the purpose, the handler, the route, `WorkspaceSetup`.
4. Retire (§10).

## 12. Open

1. **Android without the `app` block** (§4): what the pod needs of the
   ports, the `adb-keys` volume and the `redroid` dependency, now that the
   compose file has no `app` service to carry them. Settle it on an
   Android pod before the Android page is written.
2. **Base image for a workspace with an Android repo and a web repo.**
   There is one Dockerfile per workspace.
3. **Mothership on a fresh swarm.** This run is the swarm's first LLM call.
   Dispatch pushes the person's delegation first, but `strut-target.ts`
   records a swarm refusing chats because no delegation had been pushed
   for its slug. Check on a new workspace before step 3, or target the org
   default swarm (a one-line policy change).
4. **My calls, not yet ruled:** `Pod Setup` as a child of `Pod Config`; the
   prefixed page names; `Local Services` as a third branch; no bash or web
   for either agent; the fallback minimum and marking setup done on a
   failed run; the `pod-setup/*` namespace; the workspace's own swarm as
   the target; `required` and `dumpYaml` in strut.
5. **Later:** claims on the workflow for what §7 cannot fix (`0.0.0.0`,
   the dev script, the package manager), as mechanical checks over the
   output; the gold-facts scorer from `gitsee-eval`, pointed at this
   workflow.
