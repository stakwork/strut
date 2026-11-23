# Package seams: a package adds to strut without changing it

> **Status (2026-11-23): items 1–3 BUILT on strut#851; item 4 (panels)
> waits on its open question.** Item 1, files on a node: `src/node-files.ts`,
> `node/files`, `node/write-files` (docs/graph.md). Item 2, `on:`:
> `src/packages/on.ts` and the reporter's send in `src/graph-writes.ts`
> (docs/packages.md). Item 3, a forge's steps by host: `provides.git`'s
> `repositories` and `pull_request`, `git/repositories`, `git/pull-request`
> (docs/packages.md, docs/steps.md). What the build decided where this plan was silent is
> marked *Built:* in each section. The owner asked,
> about the code and pods packages: *"how can we make this generic so
> other people could build similar packages that add functionality to
> strut without changing strut itself?"* This plan answers with four
> seams in strut. Each one is generic, and none is named after what a
> package does. Only the goal is the owner's; the rest is proposed. Read
> against strut `main` @b2359477, stakwork/strut-code `main` @41062db,
> stakwork/strut-github `main` @d1ebd53 and stakwork/pods `main`
> @8b537b4. Companions: stadeum `plans/software.md` §5, where these are
> items 24 to 26 beside item 14 (panels) and item 17 (a pull-request step
> chosen by host), and stakwork/pods `PLAN.md` §1, which moves `.pod/`
> out of the repositories and into strut.
>
> **2026-11-23, later: a fifth seam (§7), BUILT on strut#858.** The owner ruled that
> work a package starts for a person shows as a Jamie chat in that
> person's own view. It starts automatically, with no model turn to
> decide it and no extra click: *"THE JAMIE CHAT IS THE BEST UI FOR
> ALMOST EVERYTHING."* The first real Set Up on a Stadeum box started its
> job with `job/start`, outside any chat, so nobody could see it. Built:
> `conversation/start` (`src/steps/lib/conversation/start.ts`), the
> orchestrator's prepared turn (`$prepared`), `about` and `from` on a chat's
> record and `conversation/list { about }` (docs/jobs.md, "A package starts
> a chat").

## The rule

Strut never learns what a package is about. Packages meet in the graph:

- a package declares its node types and writes its own nodes;
- it reads another package's nodes by type name, under a contract that
  package writes on its page;
- each package owns what it writes;
- strut gives every package the same few seams, and none of them names
  a domain.

Strut already works this way in four places:

- **Job holds** (`src/jobs.ts:138`). A package's step records that its
  job holds something, with the step that lets it go and an address.
  Strut runs that step when the job goes, and Jamie shows the address. Of
  the hold's kind, the code says *"Passed through, never read."*
- **Git hosts** (strut#798). A package declares the hosts its token
  serves (`provides.git`), and every git call on the box finds the token
  by host.
- **Graph types.** stakwork/pods reads stadeum/code's `Workspace` and
  `Repository` nodes by type name and requires neither package.
- **Schedules** (strut#791). A package ships an automation on its own
  workflow.

**The test of a seam.** A package nobody planned for uses it, and
neither strut nor any other package changes. The example through this
plan: stadeum/code keeps workspaces (sets of repositories), and
stakwork/pods runs them. Someone writes `acme/devbox`, which runs
workspaces on another kind of machine. It reads `Workspace`, keeps its
own config on each workspace, sets one up when it is made, and shows its
state where workspaces are shown. With these four seams it needs nothing
from strut, code or pods. A legal package on `Matter` nodes, unlike it in
every way, uses the same four.

## What a package lacks today

| It needs | Today |
| --- | --- |
| Files that belong to a node and outlive every run | A node's fields (small values), a run's artifacts (gone with the run) and an app's SQLite (an app's only) |
| To act when another package's node is made, changed or removed | A schedule that looks, or the other package naming it (stadeum `plans/software.md`, open question 16) |
| To show its part of another package's node | A link to its own app (`kit/src/links.ts:17`) |
| To list what a forge's token reaches, or open a pull request there, without naming the forge | Each caller names the forge's step: `github/create-pr` |

## Decided

| # | Question | Answer | Status |
| --- | --- | --- | --- |
| 1 | Where packages meet | **In the graph, by type name.** A package writes its own nodes and its own files, and reads anyone's | proposed: what strut-code and pods do already |
| 2 | Files a package keeps | **On a node:** a folder for each package on any node, versioned at each write, gone with the node (§1) | built |
| 3 | How a package acts on another's write | **`on:` in `strut.yaml`:** a workflow run when a node of a type is created, updated or deleted, as the person whose run wrote it (§2) | built |
| 4 | How a package shows its part | **Panels** (§3; stadeum `plans/software.md` §5, item 14) | proposed there |
| 5 | A forge's steps | **Named on its `provides.git` entry.** Strut's `git/repositories` and `git/pull-request` pick them by host (§4) | built |
| 6 | Where work a package starts for a person shows | **A Jamie chat of that person's own,** started with no model turn: their message, strut's fixed reply, and the job already running. The chat is about a node, so an app finds it (§7) | **owner** (2026-11-23: a chat, automatic, no extra click); built |

## 1. Files on a node

A package's step keeps files on any node. Each package has its own folder
on the node. A write replaces the folder whole and makes its next
version.

```ts
ctx.services.nodeFiles.write(ref_id, { "compose.yml": text, "seed/users.json": bytes }, { note? }) → { version }
ctx.services.nodeFiles.read(ref_id, { package?, version? }) → { package, version, files: { [path]: Uint8Array } }
ctx.services.nodeFiles.list(ref_id) → [{ package, version, at, runId, bytes, paths }]
```

- **Whose folder.** A step writes only its own package's folder, named by
  its type: `stadeum/pods/bake` writes `stadeum/pods/`. Strut's own steps
  write `strut/`. Reading is open, as a node's fields are, so a secret
  never goes in a node's files.
- **Where.** `<dataDir>/nodes/<ref_id>/<package>/v<N>/…`, with a
  `_versions.json`, the way an app's versions are kept
  (`<dataDir>/apps/<name>/<vN>`). It is the same on every graph backend.
  On a Stadeum box it is in strut's volume, which the nightly backup
  holds.
- **Versions.** Each write is a version, with the run that made it and
  when. A read takes the latest unless it names one. The last 20 are kept
  (open question 1).
- **Kept with the node.** A soft delete keeps them, so a restore brings
  them back. A delete for good removes the node's folder. No package
  cleans up after another.
- **Limits.** Text or binary, at most 10 MB a version (open question 2).
  Anything bigger belongs in a store of the package's own, or in a
  repository.
- **As steps.** `node/files` reads and lists. `node/write-files` writes
  the calling workflow's package's folder, with `effect: "write"`, so a
  `job:` grant shows it. An app reads through `node/files` like any step.
- **The example.** stakwork/pods keeps a workspace's `.pod/` on its
  `Workspace` node. `claim` writes the latest version into a bare pod at
  `/workspaces/.pod`. Once the image is ready, `bake` saves the pod's
  `.pod/` as the next version. Unlike it: a legal package keeps a
  matter's engagement letter on its `Matter`.
- **Not the `files/` area** of `plans/workspace-files-and-includes.md`
  (not built). That one holds a workflow's prompts and is published like
  a workflow. These files belong to a node.

*Built (2026-11-23):* as above, with the proposed defaults for open
questions 1 and 2 (the last 20 versions, 10 MB a version). Where the plan
was silent:

- **A delete for good.** Strut deletes no node for good itself: a delete
  is soft. So a sweep, at boot and daily, removes the folder of every node
  the graph no longer holds at all, live or soft-deleted, whoever removed
  it (raw Cypher, another process, a Concept branch's drop).
- **A write needs a live node** where the server has a graph: a typo, or
  a soft-deleted node, takes no new version. With no graph (a file
  workspace) nothing is checked.
- **The box's own steps** write `strut/`, as strut's do. `node/write-files`
  writes the calling workflow's package's folder, and a package's step that
  calls it keeps its own package's.
- **A read** takes the caller's own folder unless it names a package.
  `node/files` answers a file's text, or `{ base64 }` when it is not UTF-8,
  and `node/write-files` takes the same.

## 2. Workflows on graph writes: `on:`

```yaml
# strut.yaml of stakwork/pods (the example)
on:
  - created: Workspace
    workflow: setup
  - deleted: Workspace
    workflow: drop-images
```

- **What fires it.** A write strut hears, as the live feeds hear it
  (`src/graph-writes.ts`): a run's writes through `services.graph`, a
  step's through `ctx.registry`, and a proposal's apply. A run's writes
  are sent a second after its last one (`graphReporter`). At that send,
  strut matches each write against every installed package's `on:`
  entries and launches each match detached.
- **An entry** names one op (`created`, `updated` or `deleted`), one
  type and one of the package's workflows. Install checks that the
  workflow is the package's own. Uninstall drops the entries with it.
- **Input:** `{ ref_id, type, op, by: <the writing run's id> }`. The
  workflow reads the node itself. After `deleted` the node may be gone.
- **As whom.** As the person of the run that wrote, which the reporter
  already carries (`actor`):
  - a page's call runs as its viewer;
  - a job's run as its person;
  - an unattended run as its workflow's owner (strut#794).

  So a workspace a person makes in the Code app is set up as that
  person, with their tokens and on their bill. With no person, nothing
  runs, as for a schedule.
- **Once per node and send.** A node created and then updated in one send
  fires `created` once. One created and deleted in the same send fires
  nothing.
- **No loops.** A run that `on:` started never fires its own package's
  entries. A chain across packages stops at three, and the run's log says
  so.
- **Only real writes.** A write on a Concept branch, or in a trial,
  fires nothing: both are tries, not changes to the box.
- **Not heard, so never fired:** raw Cypher and another process's
  writes, as for the feed.
- **What a person sees.** Each launch is an ordinary run of the package's
  workflow, which says it was started by `on: created Workspace` and by
  which run. A failure shows there, and nothing retries.
- **Events take the same key.** Stadeum's `plans/software.md` §5, item 4
  plans events a package's workflow runs on (`actor.removed`, `retire`).
  They become entries in the same list: `{ event: actor.removed,
  workflow: forget }`. That gives one way to say "run this when".
- **The example.** Pods' `setup` starts a job with strut's `job/start`,
  its kind the `Pod Setup` page, so Jamie sets the new workspace up and
  bakes it. Pods' `drop-images` deletes the workspace's images. Code names
  neither. Unlike it: a CRM package's `created: Customer` sends a welcome,
  and a legal package's `updated: Matter` checks its deadlines again.

*Built (2026-11-23):* as above. Where the plan was silent:

- **The mark.** A run `on:` started carries `onWrite: { package, op, type,
  ref_id, by, depth }` on its `run.start`, kept by a resume. That is what
  says it was started by `on: created Workspace` and by which run, and what
  holds its own writes to the guards.
- **The mark follows the work.** A job the run starts (`job/start`) is
  launched with the same mark, and a nested run takes its parent's. Without
  that, an `updated:` entry whose workflow starts a job that updates the
  node would start itself forever (a test shows it). A detached
  `run/launch` from such a run carries none yet.
- **The chain's stop** is a warning in the server's log naming the writing
  run, not a line in that run's log: a run's log has no free-form line.
- **Deleted, then restored, in one send** folds to `updated`: the node was
  there before and is there after.
- **A proposal's apply** fires as the person who accepted it, the apply's
  actor, with `by: proposal:<id>`.
- **`job`.** The input also carries the writing run's job, `{ ref_id,
  type, op, by, job? }`, so a workflow tells a job's write from a
  person's without reading the run (stakwork/pods#30 asked).
- **The install card** says each entry on its workflow ("when a Workspace
  is created, as the person whose run did it"): an install lets a package
  run as anyone whose run writes that type.
- **Open question 3** is left open: an `updated` entry fires on every
  update. `fields:` is not built.
- `event:` entries are not built, so the strict manifest refuses one.

## 3. Panels

These are stadeum `plans/software.md` §5, item 14: `panels:` in
`strut.yaml` names one of the package's apps as a section for a graph
type. A page that shows a node of that type draws each installed
package's section in place, opened on the node. Who draws it is open
there (open question 17): an app's page allows no frames
(`src/apps/build.ts:217`).

**The example.** Pods' panel on a `Workspace` shows:

- whether it is ready or being set up, and when it was baked;
- a Set up again button;
- the `.pod/` files.

The Code app draws a workspace and its panels and names no package.
Until panels exist, the Code app shows the workspace's page, the Concept
pods writes at a bake, which it finds by name.

Panels come last: the first three seams are enough for a person to make
a workspace and have Jamie set it up.

## 4. A forge's steps, by host

`provides.git` (strut#798) says which secret serves a host. Each entry
also names the forge's steps for that host:

```yaml
# strut.yaml of stadeum/github (the example)
provides:
  git:
    - host: github.com
      secret: GITHUB_TOKEN
      repositories: repositories   # what the token reaches
      pull_request: github/create-pr
```

Strut adds two steps that pick by host:

- **`git/repositories { host? }`** asks each provider's `repositories`
  step as the run's person. It answers `{ repositories: [{ url, name,
  private?, pushed?, description? }], hosts: [{ host, problem? }] }`. A
  host whose person has no token says so in `problem`.
- **`git/pull-request { url, head, base, title, body }`** calls the step
  for the url's host. This is item 17 of the software plan's §5.

The input and output of both are strut's, written on each step's
description. A provider's step takes that input and answers that output.
At install, strut checks that a named step exists, in the package or in
strut.

**The example.** Code's New workspace lists `git/repositories`, so the
GitHub, GitLab and Forgejo packages each fill it, and Code names none of
them. The `Code Change` page says `git_pull_request`, not
`github_create_pr`.

*Built (2026-11-23):* as above. Where the plan was silent:

- **A name** is the package's own step by `<name>` first, else strut's by
  its type, never another package's: the rule `job:` grants follow. The
  install records the full types.
- **One step per host and field.** Two holders that name different steps
  for one host's `repositories` or `pull_request` are refused at install,
  as two secrets for one host are. Strut's own github.com entry counts, so
  a package that serves github.com names `github/create-pr` or no
  `pull_request` at all.
- **`body` is optional** in `git/pull-request`, as in `github/create-pr`,
  which now also takes the repository as `url`.
- **The box's map** is on the bag as `gitHosts.hosts()`, made again after
  every package write with the secrets' map.
- **The provider runs with the run's own bag**, behind its own fence and in
  its own package, whoever calls the seam. A package's step that calls
  `git/repositories` with its fenced ctx would otherwise fence the
  provider's secrets by the caller's.
- **A repository** may say `picked: true` (the person granted it one by
  one), and other fields pass through.
- Both steps are strut's lib steps with an `effect`, so a package's `job:`
  may grant them to the job agent.

## 5. What strut never gets

No code in strut that knows what a package's nodes mean. "Pod" and
"workspace" appear in strut only as examples in comments, as "pod" does
in `src/jobs.ts` today.

## 6. Work items, one PR each, in this order

1. **Files on a node:**
   - `nodeFiles` in the bag;
   - the `node/files` and `node/write-files` steps;
   - removal on a delete for good;
   - tests on the file and graph workspaces;
   - `docs/graph.md`.
2. **`on:`:**
   - the manifest key;
   - matching at the reporter's send;
   - the detached launch as the writer, with the loop guard;
   - install and uninstall;
   - a fixture package in the tests;
   - `docs/packages.md`.
3. **A forge's steps by host:**
   - the two `provides.git` fields;
   - `git/repositories` and `git/pull-request`;
   - `docs/packages.md` and `docs/steps.md`.
4. **Panels,** once their open question is answered.
5. **A package starts a chat** (§7), built:
   - the orchestrator's prepared turn;
   - `conversation/start`;
   - `about` on a chat's record, and `conversation/list { about }`;
   - tests: a fixture package's workflow starts a chat, the chat lists
     the turn with its job, and the job's end wakes it;
   - `docs/jobs.md`.

All five run in `npm test`: none needs a model or a network.

## 7. A package starts a chat with Jamie

**Ruled (owner, 2026-11-23):** work a package starts for a person shows
as a Jamie chat in that person's own view. It starts automatically: no
model turn decides it, and the person clicks nothing more. The rest of
this section is proposed.

**What the person sees,** in a new chat of their own:

- their message: the work's title and, under it, what they wrote, such
  as "Set up stakwork" and their note;
- Jamie's reply: strut's fixed words, "On it.", with the job's card,
  already running under its title;
- later, the job's end or its question, through the wake, as for any
  job a chat started;
- whatever they type next, which goes to Jamie as usual.

**What exists** (read against strut `main` @f47ddc4f):

- A chat's turns are runs of `orchestrator` on its session
  (`src/conversations.ts`). The orchestrator is one model call (`turn`),
  then a plain `job/start` step for the job its reply's `start` names
  (`src/workflows/orchestrator.yaml`). The job's card is read from that
  step (`turnJobs`), whatever filled it.
- A job that ends naming a chat wakes it (`src/wake.ts`), when its
  launch asked for wakes, as pr-checks' launches do
  (`src/createStrut.ts:1685`).
- Jamie's link opens a chat by its `session`.

**What is added:**

1. **A turn with no model.** The orchestrator takes an optional
   `prepared: { title, brief, kind?, repos? }`. With it, `turn` is
   skipped, `job/start` starts that job, and the reply is strut's fixed
   "On it." The orchestrator stays sealed: only `conversation/start`
   passes `prepared`.
2. **`conversation/start { message, job: { title, brief, kind?, repos? },
   about? } → { session, job }`:**
   - It runs as the run's person: a page's call runs as its viewer, and
     an `on:` run as the writer. With no person it refuses, and it
     refuses inside a job's run, since that job's own chat is where its
     work shows.
   - It makes a new chat, `<person>/<12 hex>`, and launches the prepared
     turn detached, with wakes asked for, and `message` as the person's
     words.
   - It has `effect: "write"`, so it is granted like any step and a
     `job:` grant shows it. It isn't sealed: it can only start a new
     chat with one job. It can't continue a chat or speak as Jamie
     beyond strut's fixed words.
   - The chat says where it came from: the calling step's package
     (`from`), shown as "from stadeum/pods".
3. **A chat about a node.** `about: <ref_id>` is kept on the chat's
   record, and `conversation/list { about }` answers the viewer's chats
   about that node, newest first. Any app finds "the chat about this"
   the same way.

*Built (2026-11-23, strut#858):* as above. Where the plan was silent:

- **`$prepared` is a launch-level field,** like `job` or `wake`: strut's
  `conversation/start` is the one site that sets it (`RunOptions.prepared`),
  it is on the turn's `run.start` and kept by a resume, and the workflow
  reads it as `$prepared`. It is never in `input`, so a host's launch that
  puts `prepared` there is a model's turn as ever (a test shows it).
- **The orchestrator's gate.** A first step, `model` (`!$prepared`), skips
  every step through `turn`; the one `started` job/start step takes its
  fields from `$prepared` or from the reply's `start`; `result`'s text is
  "On it.", plus the usual "(The job did not start: …)" when it did not.
- **The record's field is `from`, not `startedBy`.** A list row's
  `startedBy` is already the person who took the first turn (an admin's
  Everyone searches it), so the package goes on `from`. The chat's title is
  the job's title, not the message's first 80 characters.
- **`→ { session, job }`.** The step waits for the prepared turn (it calls
  no model: a moment) so the job's id comes back. When the job did not
  start, the step fails, naming the chat. It journals `{ session, job }`,
  so a resumed run finds the chat instead of starting another.
- **The chain.** The prepared turn carries the calling run's `on:` mark on
  to its job, so the job's writes stay held to the package's chain: a
  package's `created:` entry whose chat's job creates that type again does
  not start chats forever. The person's later turns carry none: they are
  the person's.
- **A trial** is refused, as no person and a job's run are.
- **`about`** is kept on the record and every list row.
  `conversation/list { about }` lists the chats about the node archived or
  not: it is a lookup, not the inbox. Any page granted `conversation/list`
  may ask it with `about` (strut's own page may ask anything, as before).
  `GET /conversations?about=` is the same for a host (specs/API.md §9.1).
- **Open question 5** stays open: the reply is "On it.", and the job's card
  under it names the job.
- **Not built: Jamie's memory of the first turn.** The prepared turn calls
  no model, so it writes nothing to the agent session: Jamie's session
  starts at the chat's first model turn. The usual next turn is the wake,
  whose prompt names the job and carries its reply. A message the person
  types while the job runs reaches a Jamie that does not know the job or
  their note. A follow-up could put the prepared turn's exchange at the
  head of the session's first model turn's prompt (append-only safe: it is
  the session's first message).
- "from stadeum/pods" is on the record and its rows; no UI shows it yet.

**The example.** Code's Set Up writes the `Workspace` with the person's
note on it. pods' `on: created: Workspace` runs `setup`, which calls
`conversation/start` as the person who pressed it, with:

- `message`: "Set up stakwork" and the note;
- `job`: `{ title: "Set up stakwork", kind: "Pod Setup", brief }`;
- `about`: the workspace.

Right after Set Up, Code asks `conversation/list { about }` for a few
seconds and opens Jamie at that chat. From then on its card links to the
chat. Code names no package, and pods names only its own page.

Unlike it: a CRM package's `on: created: Customer` hands an onboarding
job to whoever added the customer, in a chat they can follow and answer.

## Open questions

1. **Versions kept.** Every write of a node's files, or the last 20?
2. **Size.** Is 10 MB a version enough for a workspace's seed data?
3. **`updated` that fires too often.** `stadeum/code` updates each
   `Repository` every 15 minutes (`checked`), so `updated: Repository`
   would fire each time. Should an entry name the fields it cares about
   (`fields: [head]`)? The reporter would then need the fields each
   update set.
4. **A node of another package's type.** Any step with graph writes can
   create a `Workspace` today, and stadeum/code guards only its own
   steps. Should a package's types be written only by that package?
5. **The fixed reply's words** (§7). Is "On it." enough, or should it
   name the job ("On it: Set up stakwork")? The job's card already shows
   the title.
