# Followed packages: a deployment follows a package's git branch

> **Status (2026-11-18): every work item is built: 1 (`git+`
> subscriptions, stakwork/strut#739), 2 (the secrets gate,
> stakwork/strut#740) and 3 (the `job` grant, stakwork/strut#741).** First written
> 2026-11-17 (stakwork/strut#732) around a new follower, `STRUT_REPOS`, that
> opened each package as a repo and pulled it on a poll. Revised 2026-11-18
> after a review against the code: strut already follows packages
> (subscriptions, through the distro's door), so this plan adds `git+` refs
> to them instead of building a third follower. Rows in "Decided" marked
> **owner** are the owner's words; every other row is *proposed*. Written
> against strut `main` @5b33e939. Companions: `marketplace.md` (§12.1:
> subscriptions and the distro's door), `app-repos.md` (§3: Open, Commit
> and Pull of a package repo; §4.3: serve mode following a branch). The
> first package is pods (stakwork/stadeum `plans/pods.md`). Its examples
> follow the owner's 2026-11-18 ruling: pods live in a new public repo,
> `stakwork/pods` (not created yet), and a box's strut holds only
> `PODS_URL` and a tenant `PODS_TOKEN` for a pods service that holds the
> cloud keys (stakwork/stadeum#53).

## Goal

A deployment adds whole features to strut by following a package in a git
repo: workflows, steps, Concept pages, apps. Strut installs the package
from a branch, moves it when the host says the branch moved, and the job
agent can use the steps the package names.

The first use is the Stadeum boxes Stakwork hosts for customers, with
pods as the package. Self-hosted boxes come later. The owner, on
2026-11-17: *"Stadeum should add functionality to strut as well (pods). But
not 'embedded'.. but via a package … a repo(s) that strut pulls from
automatically when it starts and just embeds all those workflows, tools,
everything."*

## Problem

Hive adds features to strut by EMBEDDING it: mcp's lab is a host process
around strut. It passes `createStrut` options (the job agent's `pod/*`
tools through `createStrut({ job: { tools } })`, `src/job-seed.ts`) and
seeds its own custom steps. A Stadeum box runs strut's own image with no
host process around it.

Strut already follows packages, twice:

- **Subscriptions** (`src/packages/subscriptions.ts`, marketplace §12.1).
  A box follows a publisher's signed catalog (`pk:`) on a channel such as
  `stable`, and applies each release through the distro's door with no
  ask. An item edited here stays active and the new version waits beside
  it (`diverged`). Set with `PUT /packages/subscriptions/:id`; read on a
  poll (`STRUT_DISTRO_POLL_MINUTES`), on a publisher's ping, or on
  `POST /packages/subscriptions/sync`.
- **Serve mode** (`src/packages/serve.ts`). It follows a `git+` branch
  through the same door, but only for the one package a served box shows.

Three things are missing:

- **A subscription to a git branch.** Subscriptions take only `pk:`
  catalogs, which need a publishing strut. Pods live in a public GitHub
  repo, `stakwork/pods`, released by moving a `stable` branch.
- **Keeping out a package that can't work.** A package installs without
  the secrets it requires: the install reports them and goes on
  (`src/packages/install.ts`). Pods without a pods service would put
  eleven failing tools on the job agent, and a `Code Change` page under
  `Job` that tells Jamie it can change code.
- **Tools for the job agent.** Only a host's delta appends to the `job`
  workflow's `params.tools`. A package's steps can be agent tools
  (package-first lookup, `src/package-lookup.ts`), but nothing grants them
  to the job agent.

## Decided

| # | Question | Answer | Status |
| --- | --- | --- | --- |
| 1 | How does a deployment add a feature like pods? | **A package in a git repo that strut follows.** Not an embed: no host process around strut. | **owner** |
| 2 | Which follower? | **A subscription, through the distro's door.** No new follower. The first version of this plan opened each package as a repo (the repo door) and pulled it. That door is for a box that develops a package, not one that runs it: an edit here stops the package's updates, the box can't push to the repo it follows, and a Commit takes along the Concept pages made under the package's pages (§5). | **owner** (2026-11-18) |
| 3 | How is a git branch followed? | **`git+` refs in subscriptions:** `{ ref, tokenSecret? }` beside `{ key, url, channel?, token? }`. The branch is the channel. | **owner** (2026-11-18: "git+ refs in subscriptions is the way") |
| 4 | A package that lacks a required secret? | **Disabled completely, tools and Concepts.** A subscription doesn't install it, and takes it out at the next sync when a secret goes (§2). | **owner** (2026-11-18: "disable the package completely (tools and concepts)"); how: §2, built |
| 5 | When does a hosted box's package move? | **When the host says, in the window where it updates strut's image.** Strut's poll is off and the host syncs the subscription (§4). | **owner** (2026-11-18: "the same schedule as updating images"); the route is proposed |
| 6 | Which boxes first? | **The Stadeum boxes Stakwork hosts for customers.** Self-hosted boxes later: what they add is in §2 and §4. | **owner** (2026-11-18) |
| 7 | A push webhook? | **No.** A `git+` subscription has no publisher to ping, and a peer's ping doesn't read it (§1.3): it would move a box outside its host's window. | proposed |
| 8 | How does a package give the job agent tools? | **A `job:` key in `strut.yaml`** naming steps of the package. The `job` seed grants what each installed package's manifest names. | proposed |
| 9 | Why `strut.yaml`, when `serve.yaml` is a top-level file? | **An older strut should refuse the package.** The manifest is strict, so an older strut fails to read a package with a `job:` key instead of installing it without its tools. Only a serving strut reads `serve.yaml`; every strut that installs this package needs the grant. | proposed |
| 10 | May a package grant strut's own steps, or another package's? | **No, only its own.** A grant widens what the job agent can do. Limiting it to the package's own steps keeps it to code the subscription (or the person's install) already named. | proposed |
| 11 | Can a package's steps import npm packages? | **Not now.** A step imports `strut` and its own helper files (`src/strut-resolve-hook.ts`); a package vendors what it needs. Pods' steps only call the pods service. | **owner** (2026-11-17: "Vendor for now") |
| 12 | Who opens pull requests on a package? | **Jamie, on a box that develops it,** through `package/commit` and the repo door as built (§5). Never a box that follows the package. | **owner** (Jamie makes PRs from strut); the scope is proposed |

## Design in one paragraph

**A hosted Stadeum box subscribes to a package's git branch, and its host
moves it.** At first boot, Stadeum's ops subscribes the box to
`git+https://github.com/stakwork/pods@stable#package` with the deployment
key. Each night it syncs the subscription in the window where it updates
strut's image; strut never moves it by itself. A sync fetches the branch.
When the commit moved and the package's digest with it, the package at that
commit goes in through the distro's door, an older one included, so moving
`stable` back is a rollback. Until every secret the package requires is
set, nothing of it is installed. The package's `strut.yaml` names its steps
for the job agent (`job: { tools: [...] }`), and the `job` seed grants
them.

## 1. `git+` subscriptions

### 1.1 The record

`PUT /packages/subscriptions/:id` takes either:

- `{ key, url, channel?, token? }`: a publisher's catalog, as today; or
- `{ ref, tokenSecret? }`: `ref` is a
  `git+https://host/org/repo[@<branch>][#<folder>]` ref, the form
  `git-source.ts` parses. It names a branch; without `@<branch>` the
  remote's default branch is followed. A tag or a commit has nothing to
  follow. A full commit sha is refused at the `PUT`
  (`subscription_invalid`). A tag can only be told from a branch after a
  fetch, so the first sync refuses it (`package_ref_not_found`) and
  installs nothing. `tokenSecret` is the
  NAME of the deployment secret the repo is read with (default
  `GITHUB_TOKEN`, as serve mode and `STRUT_PACKAGES` read it). A public repo
  needs none.

A `git+` subscription follows one package. Marketplace §12's `distro.yaml`,
a repo that lists many packages, waits until a box follows many.
(2026-11-20: a branch may hold a BUNDLE instead, which lists several
packages by the branch each is followed at, each followed as a part of the
one subscription: stadeum `plans/software.md` §3.3 and §5 item 5;
`docs/packages.md` and `specs/API.md` §16, "Bundles".)

### 1.2 A sync

For a `git+` subscription, the sync reads the ref as serve mode's
`fetchRef` does: `resolvePackage(ref, { cache, dataDir, tokenSecret, … ,
known })` fetches the branch and reads the package at its commit into the
cache. It skips that read when the commit is the one applied (`known`).
Then, in this order:

- **Waiting:** a secret the package requires is unset (§2). Checked first,
  on every sync: the package is not installed, or is taken out, even when
  nothing moved.
- **Current:** the digest is the one applied, and it went in then. A
  commit that changed nothing in the package's folder is recorded, and
  nothing is installed.
- **Applied:** otherwise, one install through the distro's door. It
  records `ref: subscription:<id>` as today, and the commit on each
  version's upstream.

A failure (the remote doesn't answer, the token is refused, the install is
refused because the package needs a newer strut) keeps what's installed.
It's kept as `error` on the subscription, as today. `applied` gains `ref`
and `commit`: the ref is kept on the applied state too, so a sync never
reuses a commit read from a different ref. A catalog's `seq` is absent for
a `git+` subscription.

A branch moved back installs the older commit's package. That's how a
channel rolls back.

### 1.3 Who reads it

- **The poll**, as today: every `STRUT_DISTRO_POLL_MINUTES`; `0` reads at
  boot only.
- **`POST /packages/subscriptions/:id/sync`**, new, full scope: one sync
  now, answered with its outcome (`applied`, `current`, `waiting` or
  `error`, and the commits from and to). A host calls it in its window.
- **Not a peer's ping.** `POST /packages/subscriptions/sync` reads the
  subscriptions to the key it names, or every `pk:` one when it names
  none. A `git+` subscription has no publisher to ping.

### 1.4 What a host reads

`GET /packages/subscriptions` lists a `git+` subscription with its ref,
the commit and digest applied, `checkedAt`, `error`, `waiting` (§2), and
each package it installed with the items `diverged` here.

## 2. A package that lacks a secret stays out

On every sync, before it installs and before it finds nothing new, a
subscription checks every secret the package's `requires.secrets` names,
as the install's `missing` list does (`missingFor` in `install.ts`: the
deployment's secrets capability, which falls back to strut's environment;
never the subscription's own store). While one is unset:

- nothing of the package is installed: no steps, workflows, apps or
  Concept pages, and no grant to the job agent;
- the subscription says `waiting: { secrets: [...] }`;
- a package it installed earlier is taken out through the distro's door,
  as when a channel drops one. What was edited here stays as the box's own
  (the distro's uninstall rule), and isn't granted.

The next sync after the secrets are set installs it, with no new commit or
release: "nothing moved" means the digest is the one applied AND what went
in then is what the gate lets in now (`applied.packages` lists what went
in, not what waits). This holds for every subscription, `pk:` included. A
person's install is unchanged: its ask lists what's missing, and the
person decides.

**A channel of several packages** (`pk:`) is gated per package, over the
set ordered requirements first: a package waits when it lacks a secret,
or when it requires a package of the channel that waits. The rest of the
channel goes in, and the sync says `waiting` with the install's result. A
release is gated on the `requires` its catalog carries, sealed with it, so
a waiting package's archive isn't fetched. A package required from outside
the channel (resolved from its source hint at install) isn't gated.

A take-out that fails (a run in flight in one of its workflows) is a
warning on the subscription, as a channel's drop is today. It is tried
again only when the release moves.

This makes `requires.secrets` mean what it says. Today a package lists
every secret its steps may read, needed or not, because the fence
(`src/packages/fence.ts`) lets a step read only what's listed. A package
that can do without one of them lists it under `requires.optional`: its
steps may read it, and neither the gate nor an install's `missing` asks
for it (built 2026-11-19, for pods' `GITHUB_TOKEN`, a person's own).

**For self-hosted boxes (later):** setting a secret that a waiting
subscription lacks starts its sync, and the host's Packages page shows a
waiting subscription and the secrets it needs.

## 3. Tools a package gives the job agent

### 3.1 The key

```yaml
# strut.yaml
package: stadeum/pods
version: 0.1.0
job:
  tools: [claim, release, bash, edit, overview, search, fetch, latest, push, link, workspace]  # the package's own steps, or globs over them
  approve: [workspace]  # among those, the ones whose call becomes a proposal
requires:
  secrets: [PODS_URL, PODS_TOKEN]
```

`readPackage` resolves each name against the package's steps (`claim` →
`stadeum/pods/claim`; `*` → every step of the package; a `_` helper is not
a step). A name is the step's name INSIDE the package: a full type, even
the package's own (`stadeum/pods/claim`), matches nothing. A name or glob
that matches none of its steps refuses the package, and so does an
`approve` name that isn't among the tools.

A package built here (`buildPackage`, the Publish dialog) gets a manifest
with no `job:`: a package that grants writes its `strut.yaml` by hand, in
its repo, as pods does. The repo door's Commit never rewrites `strut.yaml`,
so the key survives a Commit.

### 3.2 The `job` seed

The delta the seed applies is the host's (`createStrut({ job })`) plus, for
each installed package, what its manifest's `job:` names: the full types
into `tools`, the `approve` ones into `approve` as well, deduplicated and
sorted so the text (and therefore the version) doesn't depend on install
order. The manifest is read from the package cache by the installed digest
(`listInstalledPackages`, then `PackageCache.get`; nothing prunes the
cache).

There's no stamp on the versions. An edited step keeps its name, so it
stays granted. A step the package no longer names isn't in the new
manifest.

A package taken out is not always gone from the fold: an uninstall (a
person's, or a subscription's take-out) keeps a fork, and the package is
still listed with it (`listInstalledPackages`), at its digest. So a package
grants while something of it is still its own here: a workflow, step or app
whose active version it wrote. What an uninstall leaves is only forks and
the helpers they import, which grant nothing (§2's "isn't granted"). The
cost: a package whose every workflow, step and app is edited here grants
nothing until one of them is its own again (an update, or a Commit through
the repo door).

The seed runs at boot, as today, and again after every package write: in
createStrut's `oneAtATime`, which every install, update, uninstall,
subscription sync, serve deploy, boot install and repo Open, Pull, Commit,
Retire and Close already goes through (and a build, which grants nothing
new), so re-seeds are serialized with the writes. A content-hash publish makes
a re-seed with nothing new a no-op only while nobody edited `job`: a text
seen before is made active again, over a workspace-side edit. So a re-seed compares
what the packages grant with what it granted last, and publishes only when
that changed. A workspace-side edit of `job` lasts until what packages
grant changes, or the next boot.

The seed at boot runs before the boot's subscription sync (a few seconds
after the boot, or never with the poll off); the re-seed after that sync is
what grants a newly followed package.

A package's `approve` gates the agent's tool call through `params.approve`,
like a host's. `hostApprove` (createStrut; proposals' `hostGates`) stays the
host's alone: `requireApproval` is all that reads it, only
`strut/run-workflow` calls it, and a package can't grant strut's steps.

A Concept page under `Job` is already a job KIND, put in the prompt when a
launch names it (`context/concept`). So a package that brings a kind of
work brings its page, and doesn't need a `system` key.

### 3.3 What a person sees

The package's page (`src/packages/detail.ts`) and the install ask list the
steps the package gives the job agent, and which of them ask first. Built:
the detail and its summary carry `job: { tools, approve }` by names inside
the package; the store's Tools section badges each step (`job agent`, `asks
first`); a search hit in Packages says how many tools it gives;
`package/install`'s card says which, in its summary and a field.

## 4. A hosted Stadeum box

Not work in strut: what Stadeum's side (its pods plan) does with §1–§3.

- Strut runs with `STRUT_DISTRO_POLL_MINUTES=0`. It still reads its
  subscriptions once at boot, and Stadeum restarts strut in its window.
- At provisioning, Stakwork makes the box a tenant of its pods service and
  sets the package's two secrets, `PODS_URL` and the tenant's
  `PODS_TOKEN`: in strut's environment, which its secrets fall back to, or
  with `PUT /secrets/:name`. No cloud keys go in strut: the service holds
  them. A box without a pods service has neither, so the gate (§2) keeps
  pods out.
- At first boot, ops subscribes the box with the deployment key (strut's
  `STRUT_API_KEY`): `PUT /packages/subscriptions/pods { "ref":
  "git+https://github.com/stakwork/pods@stable#package" }`. The list rides
  Stadeum's release, so a release can add a package to every box.
- Each night, inside the drain it takes for strut's image and after that
  image moved, ops calls `POST /packages/subscriptions/:id/sync` and
  records the commits from and to, as it records an image's. A package
  that needs the newer strut goes in the same night.
- A rollback is `stable` moved back, applied at the next window or on
  Update now.

## 5. Developing a package from a box (later)

The box where Jamie develops pods doesn't subscribe to it. It opens the
repo on `main` (Packages → Repos, built: `app-repos.md` §3), and
`package/commit` pushes a branch and opens a PR against `main`. An admin
accepts each commit, and only the `builder` workflow grants
`package/commit`. Hosted boxes follow `stable`, which Stadeum moves to
`main`'s head. A box can't do both: the repo door refuses a package another
door installed.

Gaps found in the 2026-11-18 review, to fix before pods is developed this
way:

- **Commit takes the pages under the package's pages.** It writes every
  Concept page made under them into the commit (`writeEdits` in
  `src/packages/repos.ts`). Pods hang each workspace's page
  (`<workspace> pod`, what jobs learned about its repositories) under
  `Pod`, so a Commit would put them in a pull request on a public repo.
- **Pull merges.** A commit whose PR was closed, or squashed with other
  changes, stays installed; a branch moved back isn't followed.
- **The commit card lists only the items edited here**, not the ones added
  or deleted (`package/commit`'s `describe`).

## 6. What not to do

- **No new follower.** No `STRUT_REPOS`: a subscription follows.
- **No webhook, and no ping for a `git+` subscription** (Decided 7).
- **No npm dependencies** in package steps (Decided 11).
- **No routes from a package.** If pods need a proxy for their links (a
  MicroVM endpoint that takes its token only in a header), that's decided
  after the pods trial, in the pods plan.
- **No grants to `orchestrator` or `builder`.** Only `job`, until a package
  needs more.

## Work items

Each is its own PR against `main`. Items 1 and 2 both change
`subscriptions.ts`, so they land in order.

1. **`git+` subscriptions** (§1). **Built: stakwork/strut#739.** The record
   and its check, the `git+` sync over serve mode's resolve
   (`subscriptions.ts`), the per-id sync route, the peer's ping leaving
   `git+` subscriptions alone (`createStrut.ts`). Tests over a local bare
   repo (`file://`, as `serve.test.ts` and `repos.test.ts` do): a push goes
   in at the next sync and not before; a branch moved back installs the
   older commit; a commit outside the package's folder installs nothing; an
   edit here stays active with the release beside it; a remote that doesn't
   answer keeps what's installed; a peer's ping leaves it alone. Docs:
   `docs/packages.md`, `specs/API.md` §16, `docs/environment.md`
   (`STRUT_DISTRO_POLL_MINUTES` covers `git+`).
2. **The secrets gate** (§2). **Built: stakwork/strut#740.** Tests: a secret
   unset, so `waiting` names it and nothing of the package is here (no step,
   page or grant); the secret set, so the next sync installs it; the secret
   removed, so the next sync takes the package out with its edits kept; the
   same for a `pk:` subscription. Docs: `docs/packages.md`.
3. **The `job` grant** (§3). **Built: stakwork/strut#741.** The manifest
   key and its check (`format.ts`), the seed's merged delta
   (`packageJobGrants`, `withJobGrants` in `job-seed.ts`) and the re-seed
   (`seedJob` inside `oneAtATime`, `createStrut.ts`), the package page and
   the install ask. Tests (`src/packages/job-grant.test.ts`): a package
   whose step the job agent then lists; an uninstall that takes it away,
   and one that keeps a fork; a glob over the package's steps; a grant
   naming a step outside the package refused; an `approve` name outside
   `tools` refused; the same text whichever order two packages install in;
   a `git+` subscription that grants once its secret is set and takes the
   grant away with the package. Docs: `docs/packages.md`, `docs/jobs.md`,
   `specs/API.md` §16.

## Validation

A strut with `STRUT_DISTRO_POLL_MINUTES=0`, and a test package on a public
repo's `stable` branch that requires one secret, grants one step
(`tools: ["*"]`) and carries one Concept page under `Job`:

1. Subscribe with the secret unset: `waiting` names it, nothing is
   installed, a job turn has no tool from it, and the page isn't there.
2. Set the secret and sync: the package is in, a job turn lists the step,
   and the page is there.
3. Push to `stable`: nothing moves. Sync: the push is in, with the commits
   from and to.
4. Move `stable` back and sync: the older commit is in.
5. Edit the step here, push a release, and sync: the edit stays active and
   the release waits beside it (`diverged`).
6. Delete the secret and sync: the package is out, the edited step kept,
   and a job turn has no tool from it.
