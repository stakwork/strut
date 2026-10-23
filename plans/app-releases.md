# App releases: hold what people use while the builder keeps building

> **Status (2026-10-23): ruled.** From one design conversation with the
> owner. The rows in "Decided" marked **ruled** are his; the rows marked
> *proposed* are mine, and he accepted them as written ("sounds good, go
> ahead"), along with my leans on the five open questions, which are now
> rulings (end of this file). Written against strut `main` @6976983.
> **Work item 1 BUILT** (2026-10-23, stakwork/strut#300): holds,
> releases and locks as §1 and §2 describe; one choice beyond them — moving
> `active` by hand (`setActiveAppVersion`, the store's raw pointer) lets go
> of the release, so `active` always names the live release's version
> while one is live. **Ruled after it, the same day: pinning holds**
> (§1.4), built in its own PR. Item 2 (runs under a lock) is next.
> Companion to `apps.md` (the app object, §1.3's versions and history,
> §5's backend, §7's hosts) and `closure.ts`'s readers (`claims.md` §4,
> the sealed check). Hive's half is described only as the contract it
> reads: its version picker (branch `feature/strut-app-versions`) already
> calls `PUT /apps/:name/active` as "Make vN live".

## Problem

Every `app/publish` makes the new version the app's active one, so the
page everyone opens is always the builder's latest try. Hive now shows
apps as TABS (`pinned`, strut#291) that people use, and builds them
through Jamie's chat, one version per turn. A person iterating in the
chat changes the tab under everyone else on every turn, broken turns
included.

Holding the PAGE at a version is not enough. A version's page is already
frozen: one document, the kit and every imported app compiled in, both
recorded in `dist/build.json` (`apps.md` §2). What the page CALLS is not.
`run/launch` starts a granted workflow's active version, a subflow
without `version:` runs its child's active version, and a bare step type
runs the custom step's active version. The builder changes those
workflows as fast as it changes the page, and a page held at v7 that
calls a workflow reshaped for v9 breaks just the same.

Pinning by hand does not scale either. `grants.workflows:
[openhealth-run@v14]` would pin the top workflow only; its subflows and
custom steps would still float, so a real hold means pinning the whole
tree, and the trees that change fastest are the largest.

| Strut has | Strut lacks |
| --- | --- |
| App versions by tree hash, an active pointer, rollback (`PUT /apps/:name/active`), the history and cache of `objects.ts` | A way to publish a version without making it the one people open |
| `subflow { version }`, `type@vN` step pins and their loader (`resolveStep`, `registry.ts`), `getWorkflowVersion` on both stores | Pins applied to a whole run without writing them into its YAML |
| `flowClosure` (`closure.ts`): every subflow, step type and agent grant a workflow can reach | A record of the versions in that closure at a given moment |
| `run.start.workflowHash` / `stepHashes`, `step.start.subflow` / `stepVersion`, resume finding a version by hash | A run that executes the versions a person approved rather than the active ones |
| `ctx.app` on every step an app's call runs, `origin: "app"` on its runs | Any of the above keyed by the app |

## Decided

| Question | Decision |
| --- | --- |
| What the builder needs | **Build without changing what people use until a person says it is ready** (ruled) |
| The modes | **Follow latest, the default, or held at a version** (ruled). Following latest is today's behavior, so nothing changes for an app nobody holds |
| What a hold covers | **The page AND the workflows and steps it calls** (ruled: with large workflows that change fast there is no other way). Computed from the closure, never written by hand (*proposed*) |
| How many | **Many releases, one live** (ruled). A release is a page version plus a LOCK; every promote adds one, a rollback re-points to an earlier one |
| Where the mode lives | *Proposed:* on the app record, beside `active`, NOT on the tab flag. `pinned` says which apps a host shows as tabs; the hold says which page everyone gets — a tab, a deliverable by name, an app importing it, strut's UI, an MCP Apps host. Hive may draw the two together |
| Pinning and holding | **Pinning holds** (ruled, after #300): a tab is what people use, so pinning an app that follows latest also holds it at the version it shows (§1.4). Unpinning leaves what is live alone, and an app can still be held without a tab |
| When the lock is taken | *Proposed:* **when a person makes a version live**, not at publish. App versions are named by their sources, and the workflows change far more often than the page: a lock at publish would mint an identical page as a new version for every workflow change. Drafts run against the current workflows, so the lock taken at promote is what the person just reviewed |
| What `active` means | *Proposed:* **still "the live page"**. Following latest, the newest publish; held, the live release's version. Every reader of `active` keeps working without knowing releases exist |
| Who promotes | *Proposed:* **a person only**, through `PUT /apps/:name/active` (hive's "Make vN live", strut's version select). No builder step in v1 (Ruled questions 1) |
| Which runs are locked | *Proposed:* **the runs the live release's page launches**, and their whole tree (subflows, steps, agent tool calls). A draft page, the builder's own test runs, a person's Run button and automations run the current versions |

## 1. The record

`AppMetadata` (`workspace.ts`) gains two fields, the record's, never a
version's:

```ts
interface AppMetadata {
  active: string;            // the live page: the newest publish, or the live release's version
  versions: Record<string, AppVersionInfo>;
  // …publisher, owner, pinned as today
  /** Every release, oldest first. Never edited, never removed but with the app. */
  releases?: AppRelease[];
  /** The live release's id. Absent = following latest. */
  live?: string;
}

interface AppRelease {
  id: string;                // r1, r2, … per app
  version: string;           // the page: an app version label
  lock: AppLock;
  createdAt: string;
  by?: string;               // the actor who promoted it
}

interface AppLock {
  /** Every workflow the version grants and every subflow they reach. */
  workflows: Record<string, { version: string; hash: string }>;
  /** Every workspace (custom) step type the closure reaches. Core and lib
   *  steps are strut's own and carry no versions. */
  steps: Record<string, { version: string; hash: string }>;
  /** What the closure could not see, one sentence each (§2.2). */
  floating?: string[];
}
```

Many releases may name the same version: promoting the live version again
takes a new lock (the page unchanged, the workflows moved on). That is how
a person takes a workflow fix without a page change.

On the graph `StrutApp` gains `live` and `releases` (a JSON string, as
`automations` is on `StrutWorkflow`), on both registries
(`strut-schemas.ts`, `LADYBUG_STRUT_TYPES`), with a conformance case and
the fs import carrying them — the AGENTS.md convention for a new
workspace field.

### 1.1 Publishing while held

`publishApp` moves `active` only while the app follows latest. Held, a
new tree is recorded as the next `vN` and a known tree as the version it
already is, and `active` stays where the live release put it. A version
newer than the live release's is a **draft**; nothing marks it, the order
does.

One rule for every door: `app/publish`, a person's `POST /apps`, the fs
import. Strut's own seeds are the exception the other way: an app strut
seeds (`strut/views`, `source: "seed"`) always matches git, so it cannot
be held (`PUT … /active` refuses it).

`app/publish`'s result says which it was, so the builder reads it where
it reads everything else, in a tool result:

```jsonc
{ "ok": true, "name": "openhealth-benchmark", "version": "v9", "changed": true,
  "live": false, "liveVersion": "v7", "release": "r3",
  "note": "held at v7 (release r3): v9 is a draft. Hand it over as { kind: \"app\", app: \"openhealth-benchmark\", version: \"v9\" }; a person makes it live." }
```

`App.md` changes one rule: hand an app over WITH the version you
published, always. Today it says by name, which resolves to `active`; held,
that is the live page, not the draft the person asked about. Following
latest the two are the same, so the rule costs nothing there.

### 1.2 The person's door

`PUT /apps/:name/active` (behind the key, as today) takes one of:

| Body | Effect |
| --- | --- |
| `{ version: "v9" }` | **Promote.** Take a lock from the current versions (§2), append release `rN`, make it live, `active = v9`. On the live version itself, a new release with a fresh lock |
| `{ release: "r3" }` | **Roll back** (or forward): make an existing release live, `active` = its version. Adds nothing |
| `{ version: "latest" }` | **Follow latest.** Clear `live`; `active` = the newest version |

A promote refuses a version that no longer builds (as `setActive` does
today) and names a locked workflow or step that no longer exists. Any
explicit pick holds the app: today's rollback lasts until the next
publish, which then silently makes the new version live again; held, a
rollback stays rolled back.

`GET /apps/:name/versions` adds `live` (the release id, or `"latest"`),
`releases` (with their locks) and, for the live release, `behind`: the
locked workflows and steps whose active version has moved on since, so a
host can say "openhealth-run v14 → v17" before a person promotes.

### 1.3 Keeping what a release names

A version a release names is never evicted from the cache
(`keptVersions` in `objects.ts` keeps it beside the active one and the
newest five). Releases are few, one per promote. A restored version is
REBUILT on the current kit, and a bare import of another app resolves to
that app's current version, so a rebuild is not the same page; keeping
the directory is what makes a rollback serve the bytes that were live.

### 1.4 Pinning holds

`PUT /apps/:name/pin { pinned: true }` (and `app/pin`, the builder's,
only when the person asks) on an app that follows latest also PROMOTES the
version it shows: a release with a lock, by the same actor, before the
flag is set — a version that no longer builds pins nothing. On a held app
it only sets the flag. Unpinning only clears the flag: taking the tab away
does not change what people open through a link. An app strut seeds is
pinned without a hold. The responses carry `live` (the release id, or
`latest`) and the release pinning made.

## 2. The lock

### 2.1 Taking one

At promote, for the version's manifest:

1. Each `grants.workflows` name at its active version (label and hash).
2. `flowClosure` over each, recording the version every subflow resolves
   to — its YAML's `version:` when it pins one, else the child's active —
   recursively. One workflow reached twice is one entry: both readings
   were taken at the same moment.
3. Every custom step type in the closure (`closure.types` and the
   `agentTools` grants, globs expanded against the registry as
   `closureIncludes` does) at its active version. A step the YAML pins
   (`type@vN`) keeps its own pin.

Built-in steps have no versions here; they change with a strut upgrade.

### 2.2 What it cannot see

`floating` names, in words, what the closure leaves out, so the person
promoting knows what still moves:

- a subflow whose name or version is a template (`workflow: "{{ input.pipeline }}"`);
- an agent grant read from the input (`agentTools: "{{ input.tools }}"`);
- a step that launches other runs: `meta/run-workflow`, `run/launch`,
  `job/start`, `job/continue`, `strut/run-workflow` — what they start runs
  the current versions (Ruled questions 3).

Beyond the closure, and out of scope: strut's own steps, a model alias
(`model: sonnet` moves when aieo bumps it), the Concept pages a workflow
reads while it runs (`context/concept`), the graph's data and secrets.

## 3. Running under a lock

### 3.1 Which runs

The runs capability's `launch` (`createStrut.ts`, what `run/launch` is
thin over) looks the lock up when the call comes from an app: held, and
`ctx.app.version` is the live release's version → that release's lock.
Anything else — following latest, a draft page, an older version opened
in a picker (Ruled questions 2), a launch with no `ctx.app` — runs as
today. `run/workflow` (the launch form's input block) reads the same
version the launch will run.

The launch starts the LOCKED version of the workflow
(`getWorkflowVersion`), and hands the run the lock as `RunOptions.pins`:

```ts
pins?: {
  release: { app: string; id: string };
  workflows: Record<string, string>;   // name → version label
  steps: Record<string, string>;       // type → version label
}
```

### 3.2 In the runner

- **Subflows.** `executeSubflow` runs `version ?? pins.workflows[name]`;
  `describeSubflow` reports the same, so `step.start.subflow` stays true.
- **Steps.** At run start the runner loads each pinned step's version
  once (`resolveStep(registry, "type@vN")`, cached per registry) and the
  run's frames get an OVERLAY registry: the shared one with those types
  replaced. Dispatch and the agent's `buildRegistryTools`
  (`agent.ts`, which reads `registry[type]`) both read `ctx.registry`, so
  neither changes; the overlay keeps the pin loader for a `type@vN` the
  YAML writes itself.
- **The record.** `run.start` carries `pins` and `release`, and its
  `stepHashes` are the LOCKED hashes (`stepHashesFor` reads the lock), so
  verify attributes evidence to the version that ran with no change.
  `workflowHash` is already the launched version's.
- **Resume** reads `pins` back off `run.start`, as it reads the
  principal: a run finishes under the lock it began with, whatever is
  live by then.

Runs a locked run starts through a step (§2.2's list) are not locked:
`pins` is the run's, not inherited.

### 3.3 Reads

`run/list` from the live release's page lists, by default, only runs whose
`workflowHash` is the locked version's (`matchesRunFilter`; the summary
carries the hash). The builder's test runs and an automation's runs on
newer versions may have output the held page cannot draw. `allVersions:
true` opts out, for a view written to tolerate them. `run/get`,
`run/events` and `run/files` by run id are unfiltered: the page asked for
that run.

### 3.4 Breaking a release

A launch under a lock whose workflow or step version no longer exists
fails with `app_release_broken: <name>@<vN> no longer exists`, and a
rollback to such a release is refused naming it. `DELETE /workflows/:name`
refuses (409, naming the app and release) while a LIVE release locks it,
as it refuses while a run is in flight (Ruled questions 5).

## 4. Hosts

Contract only; each host's own repo is adoption.

- **Hive.** The tab frames `active` and needs nothing: it is the live
  page. The chat's app panel frames the version the deliverable names
  (§1.1), labels a draft as one, and turns "Make vN live" into a promote,
  with `behind` and `floating` shown before the click. A releases list
  rolls back; "Follow latest" releases the hold. Its pin already calls
  `PUT /apps/:name/pin`, so pinning holds there with no change; the bar
  should say so before the click.
- **Strut's UI** (`AppHost.tsx`). The version select becomes: Following
  latest, the versions (drafts marked), the releases; picking one is
  §1.2's door.
- **Any MCP Apps host** opens the live page by name and gets its lock;
  nothing for it to know.

## 5. Work items

One PR each, merged in order, never stacked.

1. **Holds and releases.** `AppMetadata.live` / `releases` on both stores
   and both registries, conformance cases, the fs import; the lock taken
   at promote with `floating`; publish leaving `active` alone while held;
   `PUT /apps/:name/active`'s three forms and the seed refusal;
   `GET /apps/:name/versions`' new fields with `behind`; the eviction
   rule; `app/publish`'s result and `App.md`'s rule; strut's version
   select; `specs/API.md`. Alone this holds the page and records the lock;
   item 2 makes runs keep to it.
2. **Runs under a lock.** `RunOptions.pins`, the overlay registry, subflow
   resolution, `run.start`'s `pins` / `release` / locked `stepHashes`,
   resume, the runs capability's lookup for `launch` and `workflow`,
   `run/list`'s hash filter and `allVersions`, the broken-release error,
   the delete refusal.

## 6. Validation

- **`npm test`:**
  - Held, a publish records a draft and leaves `active`; following, it
    moves it. The result says `live: false` with the live version.
  - Promote appends a release with a lock; promoting the live version
    again appends another; `{ release }` re-points and adds nothing;
    `latest` follows again. A seeded app cannot be held.
  - The lock of a workflow with a nested subflow, a custom step and an
    `agentTools` glob names every version; a templated subflow and a
    `run/launch` step are in `floating`.
  - A version a release names survives eviction.
  - The runtime: hold an app at v1, republish its workflow's subflow and
    custom step, then launch from v1's page: the run executes the old
    subflow and step (`step.start.subflow`, `run.start.pins`,
    `stepHashes`); the same launch from the draft page runs the new ones.
  - Resume of a locked run after a new promote keeps the old pins.
  - `run/list` from the live page hides a newer version's run;
    `allVersions` shows it.
  - Conformance on files and a Ladybug file; `npm run test:graph`.
- **By hand**, a scratch strut (`STRUT_WORKSPACE_BACKEND=ladybug`, a key):
  have the builder make an app over a workflow with a subflow and a custom
  step; make v1 live; ask for a change to the page AND the subflow's
  output; check v2 is a draft, v1 still renders and its launches run the
  old subflow, promote v2, roll back to r1 and get the old page and the
  old subflow together.

## Ruled questions

Open until 2026-10-23, then ruled as my leans.

1. **The builder does not promote.** "Make it live" said in the chat would
   need a step; a person's button is the only door in v1. Later, if
   wanted, a step behind the builder's `approve:` would make it a proposal
   card a person accepts (`proposals.md`).
2. **A preview of an older release runs today's workflows.** A version
   opened in a picker is not the live release's, so its runs are not
   locked. Running it under its release would need the page's identity to
   name a release, not just a version.
3. **Runs a locked run launches are not locked.** `meta/run-workflow`,
   `job/start` and `run/launch` inside a locked workflow start other
   workflows at their current versions; the lock names them in
   `floating`, so the person sees it before promoting.
4. **An app's automations run under the live release** (`apps.md` work
   item 7), so the runs the page reads come from the versions it was
   vetted against. Built with item 7.
5. **Deleting what a live release locks is refused** (§3.4). Following
   latest first is one click.
