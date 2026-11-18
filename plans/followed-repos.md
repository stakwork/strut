# Followed repos: a deployment adds features to strut as a package

> **Status (2026-11-17): proposed. Nothing is built.** From one design
> conversation with the owner. Rows in "Decided" marked **owner** are the
> owner's words; every other row is *proposed*. Written against strut
> `main` @e6b5539c. Companions: `app-repos.md` (§3: Open, Commit and Pull
> of a package repo; §4.3: serve mode following a branch), `marketplace.md`
> (§3: install; §12: the distro's door), `pods.md` (its strut items, §10,
> become a package under this plan; the pods package gets a plan of its
> own, in its repo).

## Goal

A deployment adds whole features to strut by pointing it at a git repo in
package shape: workflows, steps, Concept pages, apps. Strut opens the repo
at boot, keeps pulling it, and the job agent can use the steps the package
names. Jamie changes the package by pull requests made from strut.

The first package is Stadeum's pods. The owner, on 2026-11-17: *"Stadeum
should add functionality to strut as well (pods). But not 'embedded'.. but
via a package … a repo(s) that strut pulls from automatically when it
starts and just embeds all those workflows, tools, everything. And Jamie
can make PRs directly on that repo from strut."*

## Problem

Hive adds features to strut by EMBEDDING it: mcp's lab is a host process
around strut. The host passes `createStrut` options (the job agent's
`pod/*` tools through `createStrut({ job: { tools } })`, `src/job-seed.ts`)
and seeds its own custom steps (`mcp/src/lab/pods/steps/`). Stadeum should
run strut's own image with no host process around it: in the owner's
words, "not embedded".

A package can carry everything the lab seeds. But two things the lab does
through host code have no package equivalent:

- **Following its source.** `STRUT_PACKAGES` installs a `git+` repo at
  first boot and never updates it (`src/packages/boot.ts`). `STRUT_SERVE`
  follows a branch, but only for serve mode: one app at `/`, the public
  view written from `serve.yaml` (`src/packages/serve.ts`). Repos
  (`src/packages/repos.ts`) have Open, Commit and Pull, but only a person
  opens a repo and only a person pulls.
- **Tools for the job agent.** Only a host's delta appends to the `job`
  workflow's `params.tools`. A package's steps can be agent tools
  (package-first lookup, `src/package-lookup.ts`), but nothing grants them
  to the job agent.

## Decided

| # | Question | Answer | Status |
| --- | --- | --- | --- |
| 1 | How does a deployment add a feature like pods? | **A package in a git repo that strut follows.** Not an embed: no host process around strut. | **owner** |
| 2 | Which door does a followed repo come in through? | **The repo door.** At boot strut opens the repo (Open, `repos.ts`), and a poll Pulls it. The distro's door would install and update too, but a package it wrote can't be opened as a repo on the same strut (`install.ts`: "uninstall it first, then open its repo"). Only the repo door lets the strut that runs a package also edit it and open a PR. | proposed |
| 3 | Where is the list? | **`STRUT_REPOS`**, a JSON list of `{ ref, tokenSecret? }`, and `createStrut({ repos })`. Not a flag on `STRUT_PACKAGES` entries: that list goes through the person's door, which has different rules. | proposed |
| 4 | Does the poll commit a person's edits? | **No.** While the package has edits here (the repo view's `added`, `forked` or `deleted`), or a merge waits on a conflict, the poll skips it and the repo view says why. A person's Pull still works as today: it commits the edits locally first, then merges. | proposed |
| 5 | Who opens the pull request? | **Jamie, through `package/commit`**, which runs only as a proposal an admin accepted (`app-repos.md` Decided 7). Commit pushes a new branch and opens the PR. When the PR merges, every strut that follows the branch pulls it within one poll. | **owner** (Jamie makes PRs from strut); the accept is app-repos' rule |
| 6 | A push webhook? | **Not now.** The poll, every `STRUT_REPOS_POLL_MINUTES` (default 5), is the only trigger. A webhook from GitHub can't carry strut's key, and serve mode's open `POST /serve/sync` is an exception made for a served box. | proposed |
| 7 | How does a package give the job agent tools? | **A `job:` key in `strut.yaml`** that names steps of the package. The install stamps each named step, and the `job` seed grants every active step that carries the stamp. | proposed |
| 8 | Why `strut.yaml`, when `serve.yaml` is a top-level file? | **An older strut should refuse the package.** The manifest is strict, so an older strut fails to read a package with a `job:` key instead of installing it without its tools. Only a serving strut reads `serve.yaml`; every strut that installs this package needs the grant. | proposed |
| 9 | May a package grant strut's own steps, or another package's? | **No, only its own.** A grant widens what the job agent can do. Limiting it to the package's own steps keeps it to code the install ask (or the operator's list) already named. | proposed |
| 10 | Can a package's steps import npm packages? | **Not now.** A step imports `strut` and its own helper files (`src/strut-resolve-hook.ts`); a package vendors what it needs. Pods sign their AWS calls with `node:crypto`. | **owner** (2026-11-17: "Vendor for now") |

## Design in one paragraph

**A followed repo is an opened repo that strut pulls by itself.**
`STRUT_REPOS=[{"ref":"git+https://github.com/stakwork/stadeum@main#packages/pods"}]`
opens that package at boot as Packages → Repos opens one: a working copy
under `<dataDir>/packages/work/`, the package installed at the branch's
commit through the repo door. Every five minutes strut pulls it, unless
someone here has edits that aren't committed yet. When Jamie changes the
package, the edits are ordinary workspace edits under the package's prefix.
`package/commit`, once a person accepts it, pushes them as a branch and a
PR, and the merge reaches every strut that follows the branch. The
package's `strut.yaml` can name its own steps for the job agent
(`job: { tools: ["*"] }`); the install stamps those steps, and the `job`
seed grants them beside the host's delta.

## 1. What exists

| Piece | Where | What it gives this plan |
| --- | --- | --- |
| The `git+` source | `src/packages/git-source.ts` | A branch, tag or commit, `#folder`, a private repo read with a named secret |
| Repos | `src/packages/repos.ts`, `/packages/repos` (`specs/API.md` §16) | Open (a kept working copy plus the repo door), Pull (local edits committed first, then git merges; a conflict stops and installs nothing), Commit (a new branch and a PR, or the followed branch when asked), Close |
| The repo door | `src/packages/install.ts` | The commit is the truth: every item becomes what the commit holds, and an item the commit dropped is retired |
| `package/commit` | `src/steps/lib/package/commit.ts` | Commit as a proposal a person accepts |
| Serve mode's follower | `src/packages/serve.ts` | The shape to copy: one sync at a time, a timer, state on file, a failed fetch kept as an error while what's installed stays |
| The job seed's delta | `src/job-seed.ts` (`templateWithDelta`) | `tools` (step types or globs) and `approve` appended to the template's params, then a content-hash publish |
| The fence | `src/packages/fence.ts` | A package's steps read only the secrets its `requires.secrets` names, so the AWS keys reach the pods steps and nothing else |

## 2. Following a repo

### 2.1 `STRUT_REPOS`

A JSON list. Each entry is `{ ref, tokenSecret? }`:

- `ref` is a `git+https://host/org/repo[@<branch>][#<folder>]` ref, the
  form `git-source.ts` parses. It names a branch (default: the remote's
  default branch). Open already refuses a tag or a commit
  (`package_repo_branch`): there's nothing to follow.
- `tokenSecret` is the name of the deployment secret the repo is read with
  (default `GITHUB_TOKEN`). A public repo needs none.

A bad value fails the boot, as `STRUT_PACKAGES` does. Unset or `[]`: none.
`createStrut({ repos })` adds to the list.

### 2.2 Boot

Last, in the background, after the seeds and beside the `STRUT_PACKAGES`
installs, so a remote that doesn't answer never holds or fails the boot:

- For each listed ref whose package isn't opened here: `repos.open` with the
  ref's URL, branch, folder and secret. A package installed here through
  another door is refused, as Open refuses it today; that's a warning naming
  the package and saying to uninstall it first. Nothing is removed by
  itself.
- A ref already opened here is pulled, as on the poll.

### 2.3 The poll

Every `STRUT_REPOS_POLL_MINUTES` (default 5; `0`: at boot only), for each
listed repo, one at a time per package:

- **Skip** when the package has edits here or a merge is waiting (Decided
  4). The repo view says `following: "waiting"` and why. The next poll after
  a Commit, a Pull or a discarded edit picks it up again.
- **Pull** otherwise: a fetch, then the merge of the remote branch into the
  working copy. When the commit moved and the package's digest with it, the
  merged tree is applied through the repo door. A moved commit with the same
  digest (a change outside the package's folder) installs nothing, as serve
  mode does.
- **A failure** (the remote doesn't answer, the token is refused, the install
  is refused) keeps what's installed. It's kept on the repo as `error` and
  `errorAt` and logged once per new error, and the next poll tries again.

There's no actor on the poll, so the token is the named deployment secret.

### 2.4 Edits and pull requests

Nothing new. The package is opened, so its prefix takes new names
(`WorkspaceStore.setOpenPackages`). Jamie or the builder edits its items
like any others, and `package/commit` proposes the commit. Once an admin
accepts, Commit pushes a branch `strut/<name>-<sha8>` and opens a PR
against the followed branch. Until the PR merges, the working copy is ahead
of the remote. Each poll merges the remote into it, and the merge that
brings the PR back in leaves the tree as it is.

A strut that has the package installed through another door, and wants to
change it, opens a PR the plain way: `git/checkout` into a job directory,
an edit, `git/push`, `github/create-pr`.

### 2.5 Status

`GET /packages/repos` and each repo's view gain:

- `followed: true` for a listed repo;
- `following`: `"ok"`, `"waiting"` (with the reason) or `"error"`;
- `pulledAt`: the last poll that reached the remote;
- `error` and `errorAt`.

The Repos tab shows them. `specs/API.md` §16 documents them.

### 2.6 When the list changes

A repo taken off the list stays opened and installed, and isn't polled any
more: a person closes it in the Repos tab. A repo added to the list is
opened at the next boot. Changing a listed ref's branch or folder is the
same as taking the old one off and adding the new one. Open refuses while
the old one is open (`package_repo_open`), and the warning says to close
it.

## 3. Tools a package gives the job agent

### 3.1 The key

```yaml
# strut.yaml
package: stakwork/pods
version: 0.1.0
job:
  tools: ["*"]          # the package's own steps, by name inside the package, or globs over them
  approve: [workspace]  # among those, the ones whose call becomes a proposal
requires:
  secrets: [AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY]
```

`readPackage` resolves each name against the package's steps (`claim` →
`stakwork/pods/claim`; `*` → every step of the package). A name or glob
that matches none of its steps refuses the package, and so does an
`approve` name that isn't among the tools.

### 3.2 At install

Through any door, each step the grant names gets `job: "tool"` (or
`"approve"`) on its version's `upstream`. A fork carries its upstream
forward, so an edited step stays granted. A step the package no longer
names loses the stamp on the next install, and a retired step isn't active,
so it isn't granted. `upstream` is JSON in the graph, so this adds no
schema attribute.

### 3.3 The `job` seed

The delta the seed applies is the host's (`createStrut({ job })`) plus every
active step whose upstream says `job`: its type into `tools`, and, for
`"approve"`, into `approve` as well, deduplicated and sorted so the text
(and therefore the version) doesn't depend on install order.

The seed runs at boot, as today, and again after every install, update,
uninstall or pull that changes the set of granted steps. A content-hash
publish makes a run with nothing new a no-op. Re-seeding after an install
applies "a seed always matches git" sooner than the next boot: a
workspace-side edit of `job` lasts until the next re-seed, where today it
lasts until the next boot.

A Concept page under `Job` is already a job KIND, put in the prompt when a
launch names it (`context/concept`). So a package that brings a kind of
work brings its page, and doesn't need a `system` key.

### 3.4 What a person sees

The package's page (`src/packages/detail.ts`) and the install ask list the
steps the package gives the job agent, and which of them ask first. An
operator's `STRUT_REPOS` entry is the accept, as `STRUT_PACKAGES` is.

## 4. What not to do

- **No new door.** A followed repo is an opened repo. The distro's update
  rules (fast-forward, a fork beside, retire) stay the distro's.
- **No webhook** (Decided 6).
- **No npm dependencies** in package steps (Decided 10).
- **No routes from a package.** If pods need a proxy for their links (a
  MicroVM endpoint that takes its token only in a header), that's decided
  after the pods trial, in the pods plan.
- **No grants to `orchestrator` or `builder`.** Only `job`, until a package
  needs more.

## Work items

Each is its own PR against `main`.

1. **`STRUT_REPOS`.** Parse and check (`src/packages/boot.ts` beside
   `STRUT_PACKAGES`), open at boot, the poll with the skip rule, the status
   fields, the Repos tab. Tests over a local bare repo (`file://`, as
   `repos.test.ts` does): a push shows up after a poll; an edit here holds
   the poll; a conflict stops it; a remote that doesn't answer keeps what's
   installed. Docs: `docs/packages.md`, `docs/environment.md`
   (`STRUT_REPOS`, `STRUT_REPOS_POLL_MINUTES`), `specs/API.md` §16.
2. **The `job` grant.** The manifest key and its check (`format.ts`), the
   stamp at install (`install.ts`), the seed's merged delta and the
   re-seed (`job-seed.ts`, createStrut), the package page and install ask.
   Tests: a package whose step the job agent then lists; an uninstall
   that takes it away; a glob over the package's steps; a grant naming a
   step outside the package refused. Docs: `docs/packages.md`,
   `docs/jobs.md`.

## Validation

A strut with
`STRUT_REPOS=[{"ref":"git+https://github.com/<org>/<test-package>@main"}]`,
where the package has one step granted with `tools: ["*"]`:

1. At boot the package is opened and installed, and a job turn lists the
   step among its tools.
2. A commit pushed to `main` is installed within one poll.
3. Jamie edits the step; the poll waits. An admin accepts
   `package/commit`; the PR opens; after the merge the next poll goes on,
   with nothing to merge.
4. The same package on a second strut picks up the merge too.
