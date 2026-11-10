# Managed packages: an edit is a patch, and strut keeps it applied

> **Status (2026-11-09): proposed. Nothing is built.** From the owner's
> ask: a host that installs a package from the index should take upstream's
> additions and fixes by itself, with a built-in coder agent keeping its
> apps clean and up to date, so apps on strut are managed and nobody
> maintains them by hand. Written after a read of strut `main` @c6d009d3.
> It builds the half of `plans/marketplace.md` step 4 that is still open
> (the person's update, the merge) and revises two of its rows: "An
> update, and a person" (*ruled*: an update asks) and §4's "Rebase is the
> builder's". Companions: `app-releases.md` (a held app takes a draft),
> `proposals.md` and `member-rights.md` (an admin accepts),
> `builder-job.md` (the agent), `concept-history.md` (why an edit was
> made). Every row in "Decided" is mine and proposed. Three of them need
> the owner's ruling before anything is built; they are the open
> questions at the end.

## Problem

A package installed from the index is a copy, and a copy goes stale. The
goal is that it does not: upstream ships a feature or closes a hole, and
every strut that installed the package has it, edits and all, without a
person merging anything.

Four things are in the way today.

- **A person's install cannot update.** Only the fleet's door applies a
  release over an installed one; a person's door refuses
  (`package_update_not_built`, `src/packages/install.ts:563`).
- **Nothing watches upstream** for a package a person installed. A
  subscription follows a whole catalog for an operator
  (`src/packages/subscriptions.ts`); an index install pins a key and a
  URL and never reads them again.
- **An edited item is left behind for good.** The fleet's door publishes
  the new release beside a fork, inactive, and reports it `diverged`
  (`planItem`, `install.ts:772`). The three-way merge marketplace §4
  describes was never built, so a fork misses every later fix.
- **A kit update does not reach a built app.** An app's document inlines
  the kit's libraries when it is built, and `isStale`
  (`src/apps/apps.ts:443`) compares the source tree and imported apps,
  never the kit. A React fix in a new strut release reaches an app only
  when someone republishes it.

| Strut has | Strut lacks |
| --- | --- |
| `upstream` on every installed version, carried forward by an edit; the fold's `modified` (`src/packages/installed.ts`) | The edit as a thing of its own: what this strut changed, over which release |
| §4's table through the fleet's door: fast-forward, diverge, retire, the trial load, the take-back (`install.ts`) | The same table through a person's door, and a row for a fork other than "left behind" |
| A signed catalog read by key with a `seq` rule (`fetchCatalog`, `src/packages/pk.ts:89`), a poll timer (`STRUT_DISTRO_POLL_MINUTES`) | A reader of the catalogs of what a person installed |
| Proposals an admin accepts (`package/install`, `StepDef.approver`) | An update a person can accept, and an accept that stands for later releases |
| The `builder` job: an editor, `app/build`, `app/look`, the claim tools | A way for it to hand in a merge without publishing over a person's item |
| `dist/build.json` naming the kit an app was built on (`src/apps/build.ts:619`) | Anything that rebuilds when the kit moves |

## The idea

**A fork is the newest release plus a local patch, and strut keeps that
true.** The patch is what this strut changed. On every release, code
puts the release in and replays the patch on top. Most replays need no
model. When one does not apply, or what it makes does not build, a
`builder` job writes a new patch that does, and an admin accepts it.

```
a release arrives
  per item
    untouched ────────────► fast-forward                        (code, built)
    fork ──► replay patch ─► applies, gates pass ─► land        (code)
                 └ conflict or a gate fails ─► builder job ─► patch ─► card ─► land
  then the publish checks run; a claim they newly refute puts the old versions back
```

Three properties follow from keeping the patch on top of the release
rather than merging the release into the fork.

- **Upstream's fix is whole.** The release lands as the publisher built
  it, verified by digest. A reviewer reads only the local delta.
- **"Clean" has a number.** The patch's size. When upstream takes the
  change, the patch is empty, the item's content is the release's, and
  the item fast-forwards again (§2, "The empty patch").
- **An accept names exact code.** A release digest and a patch digest.
  New code never lands on an accept given for other code, which is the
  rule the ruling protects.

## Decided

| Question | Decision |
| --- | --- |
| What an edit to an installed item is | **A patch over its release**, derived from two versions strut already keeps. Never a second source of truth: the active version stays the truth (§1) |
| The file | **A git patch over the package's layout**, with three header lines; stored by the sha256 of its bytes only when it is proposed or exported (§1) |
| Which way the merge goes | **The patch onto the release**, not the release into the fork (above) |
| Who merges | **Code first.** A three-way merge and the gates strut already has. A model only for what code could not do (§2, §5) |
| The agent | **The `builder` job**, with one Concept page and three steps. No new workflow, no new agent (§5) |
| What the agent produces | **A patch, never a publish.** Strut applies it, behind an admin's accept (§3, §5) |
| A person's update | **Built here**: `POST /packages/:publisher/:name/update` and the `package/update` step, admin only. It follows the pinned key and URL, never the index (§3) |
| Updates with no ask | ***Needs a ruling.*** An admin may mark a package **kept up to date**. Then a release that asks for nothing new, and whose patches replay, is applied by the watcher (§4). It revises "an update asks like an install" |
| A patch a model wrote | ***Needs a ruling.*** Always a card in v1, or a draft on a held app; only code-only updates land unattended (§5) |
| The default | ***Needs a ruling.*** On, for an install by name from a followed index, said on the install's card (§4) |
| A held app | **Takes a draft**, as any publish to it does (`app-releases.md` §1.1). The hold is the brake; this plan adds none |
| A bad update | **Takes itself back** when a publish check newly refutes a claim; a person rolls back with one click otherwise (§3) |
| Dependencies | **The kit is an app's whole dependency surface.** A document built on another kit is rebuilt in place, with no new version (§6) |
| The fleet's door | **Unchanged in v1.** A subscription keeps today's table: a fork is left `diverged` ("Later") |

## 1. The patch

**What it is.** For a fork, three versions matter:

- **base**: the item as the release the fork was made from has it. It
  is a version in the item's own list, written by a package door
  (`source: install | distro`) with the same `upstream.digest` the fork
  carries.
- **ours**: the active version.
- **theirs**: the item as the new release has it.

The **local patch** is base → ours. Strut keeps every version of a
workflow and a step, and every app version's tree (`src/apps/objects.ts`),
so base is always there, whether or not the package cache still holds
the old release.

**Never stored as the truth.** Nothing reads a patch to decide what
runs. `GET /packages/:publisher/:name/patch` computes it; so does the
card; so does the agent's workspace.

**The file.** When a patch has to be named (a proposal's input, an
export), it is one text file: what `git diff --binary` writes between
two directories laid out as the package is (`workflows/sync.yaml`,
`steps/create-issue.ts`, `apps/issues/src/Header.tsx`), forks only,
after three header lines that `git apply` skips:

```
package: acme/linear
onto: sha256:<the digest of the release it applies to>
over: apps/issues=<tree hash> workflows/sync=<content hash>
```

`over` is each fork's active hash when the patch was made. Applying it
to an item that has moved since is refused (`patch_stale:`), so an edit
made after the patch is never dropped.

It is written once to `<dataDir>/packages/patches/sha256-<hex>.patch`,
named by the sha256 of its bytes, the way the cache names a package. A
patch the replay made in code is not stored: the versions it produced
are.

**Why a file at all.** The same bytes are what the card shows, what
strut applies, and what a person can send the publisher, who applies it
in their own strut with `git apply`. Sending one upstream is a later
step ("Later").

**git.** The merge, the diff and the apply are `git merge-file`,
`git diff --no-index --binary` and `git apply`, run through `findGit`
(`src/history.ts:150`) as the history runs git. None needs a
repository; each runs in a scratch directory with
`GIT_CEILING_DIRECTORIES` set, so a data folder inside a checkout is
never read as one. Checked with git 2.54 on 2026-11-09: the header
lines are skipped, a binary file and a new file carry, and the patched
tree equals the merged one. A strut with no git replays nothing: its
forks stay `diverged`, and `GET /packages` says why.

## 2. Replay

`src/packages/patch.ts`. For each fork of the package, with no model:

**A workflow or a step** is one file: `git merge-file` over ours, base
and theirs.

**An app** is merged per path, over every path in the three trees:

| The path | Result |
| --- | --- |
| Changed by one side only | That side's |
| Changed by both, to the same bytes | Those |
| Changed by both, text | `git merge-file`; markers left → the item does not replay |
| Changed by both, binary | Theirs, and the result says so |
| Deleted by one side, changed by the other | The item does not replay |
| `db/*.sql` | Both sides' files: migrations are additive (marketplace §4) |

**The gates**, each strut's own, none a model:

- a workflow: `assertValidWorkflowYaml` and `validateWorkflowYaml`
  (`src/validate.ts`);
- a step: `lintStepSource`, then the trial load an install already runs
  (`trialLoad`, `install.ts:801`);
- an app: `buildApp` against this strut's kit.

An item whose merge leaves markers, or whose result fails its gate,
**does not replay**. Nothing of it is written.

**Landing.** A replayed item is published by content as a local
version:

- `source: "update"`, a new `VersionSource`. The fold counts only
  `install` and `distro` as the package's own, so the item still reads
  `modified`.
- `upstream`: the new release's. Its `secrets` are the release's list
  and any name a person had added to the fork's fence.
- `actor`: who accepted, or who turned updates on (§4).
- `description`: `acme/linear 1.4.0 → 1.5.0, local changes carried`.
- Made active. An app a person holds at a release gets a draft instead,
  as every publish to it does (`apps.ts:584`).

The release's own version is published beside it, inactive, as today:
it is the next update's base.

**The empty patch.** When the merge result is the release's bytes,
publishing by content finds the release's own version and makes it
active. The item is untouched again and fast-forwards from then on. No
code handles this case.

**Concepts are not replayed.** A page edited here stays as it is and is
reported, as today (`keepEdited`).

## 3. The update door

`updatePackage(deps, pkg, { digest?, patch?, actor })`, beside
`installPackage`: an install of a package that is here, at another
digest, through the person's door.

1. **Resolve from the pin.** The catalog at `upstream.source.url`, read
   as a card against `upstream.key` (`fetchCatalog`). The release is
   `digest`, else the one the package follows (§4). The index is not
   read: an update follows the key the install pinned (marketplace §4).
   A package installed from `file:` takes a `ref`.
2. **Plan every item** with marketplace §4's table as the fleet's door
   runs it, and one row changed: a fork is **replayed** (§2). With `patch`, the forks
   it names are not merged: the patch is applied to the release's files
   with `git apply`, strictly, after its `onto` and `over` are checked,
   and the result goes through the same gates.
3. **All or nothing, before the first write.** A fork that neither
   replays nor is covered by the patch refuses the update:
   `package_update_conflict:` (409), naming each item and why (the
   conflicted paths, the gate's errors). A required package at a new
   digest is updated first, under the same rule.
4. **Write**, in an install's order: steps, the registry check,
   workflows, apps, then what the release drops. One history commit
   (`install acme/linear@<digest>`), as an install's.
5. **Check, and take back.** The publish checks run for what moved
   (`verifyPublish`). A claim that read `supported` before the update
   and reads `refuted` after it re-points every item the update moved
   to the version that was active (`takeBack`'s re-point,
   `install.ts:896`). The release's versions stay, inactive. The result
   says `rolledBack` and the claim.
6. **Remember the way back.** The update's record keeps each moved
   item's previous version (`updates.json`, §4), so
   `POST /packages/:publisher/:name/rollback` re-points them. One level:
   the last update.

**The doors.**

- `POST /packages/:publisher/:name/update { digest?, patch? }`: full
  scope, and on a strut with members an admin (`member-rights.md`).
  `POST /packages/install` of another digest keeps refusing; its message
  names this route.
- `package/update { package, digest?, patch? }`: a step that runs only
  as a proposal an admin accepted, exactly as `package/install` does
  (`approver: "admin"`, the accepted record checked behind the door,
  `createStrut.ts:3717`). It takes no URL, key or index: an agent can
  only move a package along its pin.
- Its `describe` writes the card: `Update acme/linear 1.4.0 → 1.5.0`;
  what upstream changed, item by item; what the release newly needs or
  can do (§4's list); and for each fork, "your change carries over" or
  the patch's size with a link to read it.

## 4. Watching, and the standing accept

**The watcher.** On the subscriptions' timer, for every package a
person's door installed from a `pk:` ref: one catalog read per key and
URL (`If-None-Match`), and `releaseFor(card, pkg, channel)`: the
`stable` channel when the catalog has one, else the newest release not
yanked. What it saw is kept per package beside the cache, with the time
it FIRST saw each release (a catalog carries no dates).

`GET /packages` gains, per package:

```ts
update?: { version: string; digest: string; seenAt: string; eligible: boolean; why?: string[] };
yanked?: string;      // the installed release was withdrawn: the publisher's reason
auto: boolean;
replays?: boolean;    // do its forks replay onto `update`? absent with no fork
```

Nothing is applied by watching. The Packages tab shows "1.5.0
available" and an Update button, which is §3's route.

**Kept up to date.** `<dataDir>/packages/updates.json`, plain JSON like
`indexes.json`:

```json
{ "acme/linear": { "auto": true, "by": "<actor>", "at": "…", "channel": "stable",
                   "last": { "from": "<digest>", "to": "<digest>", "at": "…", "previous": { "acme/linear/sync": "v3" } } } }
```

Written by `PUT /packages/:publisher/:name/auto { auto }` (an admin)
and by an install that says `auto` (`POST /packages/install`,
`package/install`, whose card then carries the line "and later releases
that ask for nothing new"). An install that named a digest is never
auto: the person pinned it.

**A release is applied with no ask when all of this holds:**

- it comes from the pinned key (it always does: §3);
- it needs nothing new: no secret, binary or runtime the installed
  release did not declare, and no required package that is not here;
- it can do nothing new: no `spends`, `acts` or `code` line
  (`derivePackageDetail`, `src/packages/detail.ts`) the installed
  release lacked, and no app gains a grant;
- no contract moves under something outside the package: a step or
  workflow that a local workflow or app names keeps its input schema,
  its output schema and its claims (marketplace §4's `silent`);
- every fork replays (§2);
- this strut first saw it `STRUT_PACKAGE_SOAK_HOURS` ago (24). A
  release pulled within a day never lands. The wait is skipped when the
  installed release is yanked.

Otherwise nothing is applied, `update.why` lists what failed, and the
package waits for a person: the Update button, or the maintainer's card
when only the replay failed (§5).

The watcher never moves a package backward. When the newest release is
yanked and nothing newer replaces it, the row says so and a person
decides.

**What this accept is.** The admin who ticks the box accepts later
releases from one key, within what the first release declared. It is a
subscription for one package, with the limits a fleet's operator does
not need. §8 says what it does not protect against.

## 5. The maintainer

**When.** A release whose forks do not replay. With `auto` on, the
watcher starts it once per release, as the admin in `by`. Without, a
person starts it from the package's row ("Have the builder merge it"),
or asks Jamie, which starts the same job.

**What.** A `builder` job: id `update/<publisher>/<name>/<digest's
first 12>`, title `Update acme/linear to 1.5.0`. No new workflow. Its
convention is a Concept page, `src/concepts/Package Update.md`, a child
of `Workflow Builder`, so the orchestrator lists it as a kind the
builder does. The builder cannot publish over a person's item
(`meta/*` writes only names stamped `ai`), and it does not need to: it
hands in a patch.

**Its hands.** Three steps, added to the `builder` seed's
`params.tools`, with `package/update` in `params.approve`:

- **`package/changes { package, digest?, path? }`** (a read). Per item:
  untouched or a fork. For a fork: its local versions since base (label,
  when, who, which door, description), and how the replay went (clean,
  the conflicted paths, or the gate's errors). With `path`, it lays the
  work out in the job's directory, in the package's layout:
  `theirs/`, `merged/` (the replay's result, markers in),
  `LOCAL.patch` (base → ours) and `UPSTREAM.patch` (base → theirs).
- **`package/patch { package, digest, path }`**. Reads `<path>/merged`,
  runs the gates, and stores theirs → merged as a patch file (§1).
  Returns its digest and size, or the gates' errors. It also lists every
  file the patch changes that the local edits never touched, and the
  card repeats that list: a patch that reaches into upstream's own
  change is the thing a reviewer must see.
- **`package/update`** (§3), gated: the call is a proposal.

It already has what else it needs: the editor on `merged/`,
`app/build` and `app/look` on `merged/apps/<name>`,
`meta/validate-workflow`, and, for WHY an edit was made, the versions'
descriptions and `history/read` (granted here): the commits that
touched the item carry the runs that wrote it, and a run leads to the
request behind it.

**The page's posture**, not a recipe:

- Start from upstream as it is. Carry over what the edit was FOR, not
  its lines.
- Keep the patch small. Drop what upstream now does itself.
- Do not change what upstream changed. If the edit cannot live beside
  it, say so and ask.
- Build it, look at it, then hand in the patch. Reply with what was
  kept, what was dropped and why.

**Who pays.** The job runs as `by` and is billed to them, capped by the
builder's run cap. Where the Mothership is required and `by` has no
delegation, the job fails saying so, as an ownerless automation does.

**Where the card shows.** On the package's row in the Packages tab, on
the job's timeline, and in the proposal feed. An admin accepts; anyone
else sees "An admin must approve this".

## 6. The kit

An app has no `node_modules`. Every library it uses is the kit's,
compiled into its document at build. So a vulnerable dependency is
fixed in one place, a strut release, and what is left is rebuilding.

- `dist/build.json` records the kit's version today. It also records
  the sha256 of the kit's `vendor/manifest.json` (the exact versions).
  A document with another digest, or none, is **behind**.
- A version that is behind is rebuilt in place: the same sources, this
  kit. `dist/` is outside the tree hash, so there is no new version, no
  draft and no ask. Active versions at boot, in the background; any
  other version when it is next read (`ensure`, `apps.ts`).
- A rebuild that fails keeps the old document, which still serves, and
  marks the app (`GET /apps`: `kitBehind`, with the build's errors).
  Fixing it is a source change. For an installed app that is a fork with
  a patch, through §5, and the patch drops when upstream ships its own
  fix. For an app made here it is an ordinary builder job with the
  errors as its brief.

A package ships no `node_modules` either: its steps import `strut` and
their own helper files, so a step has no dependency tree of its own to
patch.

## 7. What a person sees

The Publish dialog's Packages tab, under what is installed. One line
per package:

| State | Line |
| --- | --- |
| Current, untouched | `1.5.0 · up to date` |
| Current, with forks | `1.5.0 · up to date · 2 local changes (+41 −7)` |
| A release waiting on the soak | `1.5.0 in 18 h` |
| A release that needs a person | `1.5.0 available`, why, **Update** |
| The maintainer working | `merging 1.5.0…`, the job |
| A patch waiting | `1.5.0 needs your OK`, the card |
| Took itself back | `1.5.0 rolled back`, the claim |
| The installed release withdrawn | `yanked`, the reason |

Beside it: the **Keep up to date** switch, **Roll back**, and **Local
changes**, which opens the patch per item, read-only, with **Export**
(the `.patch` file) and **Drop** (make the release's version active
again; the item is then untouched).

On an app's Versions flyout, a version an update wrote says
`from acme/linear 1.5.0 · local changes carried`.

## 8. What this trusts

Auto-update is continuous trust in one key. It is worth saying exactly
what the checks do.

- An installed step is TypeScript in the server process. "Asks for
  nothing new" reads what a release DECLARES and what its files show
  statically. It does not catch code that lies.
- What it does bound: a new key (never followed), a new secret (the
  fence refuses the read at run time, `src/packages/fence.ts`), a
  release pulled quickly (the soak), a withdrawn release (the yank), a
  release that breaks a recorded claim (the take-back).
- A model's patch is a card, with the files it touches outside the
  local edits listed. On a held app it is a draft.
- Every update is one commit in the history, and one click back.

A deployment that will not have unattended updates leaves the switch
off: it gets the notice, the Update button, the replay and the
maintainer, each behind an admin's accept.

## Tests

- **Replay** (`patch.test.ts`): a workflow and a step each merge clean,
  conflict, and fail a gate; an app per row of §2's table; an empty
  patch makes the release's version active and the fold says untouched;
  no git → nothing replays and the fold says why.
- **The file**: a patch round-trips (make, store, apply) to the same
  tree hash; `onto` another digest and a moved `over` are refused; a
  binary file under `public/` carries.
- **The door** (`install.test.ts`): untouched items fast-forward and
  forks replay in one update; one fork that does not replay refuses the
  whole update with nothing written; the same update with a patch
  lands; a held app gets a draft; a required package is updated first;
  the second run of the same update writes nothing.
- **Take-back**: a publish check that turns `refuted` re-points every
  moved item; rollback re-points the last update.
- **The watcher**: a release is seen, waits out the soak, and lands;
  each line of §4's list alone makes it not eligible, with `why`; a yank
  skips the soak; nothing moves backward; a catalog sealed by another
  key is never read as the package's.
- **The step**: `package/update` outside an accepted proposal is
  refused; a member's accept is `admin_required:`.
- **The kit**: a document built on another manifest digest is rebuilt
  in place with the same version and a new `ETag`; a failing rebuild
  keeps the old document and sets `kitBehind`.
- **Conformance**: `source: "update"` on files and a Ladybug file;
  `npm run test:graph`.
- **By hand**, two scratch struts, one publishing publicly: install an
  app package on the other, have the builder change its header, publish
  a release that changes another file (lands by itself), then one that
  changes the same lines (the job, the card, accept), then one that
  makes the edit unnecessary (the patch empties, the item is untouched).

## Work items (one PR each)

1. **Replay and the update door.** `src/packages/patch.ts` (merge, make,
   apply, the file), `updatePackage`, `VersionSource: "update"`, the
   route, the take-back, rollback's record. Code only, no model. This is
   marketplace step 4's merge and person's door.
2. **The watcher and the standing accept.** The catalog reads on the
   subscription timer, `updates.json`, the eligibility list (with step
   4's `silent` / `named` check), the soak, `GET /packages`' new fields,
   the `auto` line on the install card.
3. **The kit rebuild.** The manifest digest in `build.json`, the
   rebuild at boot and in `ensure`, `kitBehind`.
4. **The maintainer.** `package/changes`, `package/patch`,
   `package/update` and its `describe`, `Package Update.md`, the seeds'
   grants, the watcher's launch.
5. **The Packages tab.** §7.

Items 1 and 3 stand alone and need no ruling. Item 2 needs open
questions 1 and 3; item 4 needs 2.

## Later

- **The fleet's door replays too.** One switch in `planItem`. It changes
  what a subscription does to a swarm's edit, so it waits for the
  person's door to prove the replay.
- **A patch sent upstream.** The export, addressed to the publisher's
  strut: marketplace's "patch as a value"
  (`p2p-distribution-research.md`, Option D).
- **Concept pages replayed**, with base read from the history instead
  of the cache.
- **Other reasons to call the maintainer**: an app's usage warnings
  (`src/apps/monitor.ts`, which already writes a fix for the builder),
  its reported errors, a step the lint flags.
- **A revocation the watcher reads**, for a compromised key
  (`index-listing.md`, "Later").

## Open questions

1. **May an accept stand for later releases?** "An update asks like an
   install" is ruled. §4 lets an admin mark a package kept up to date,
   after which a release that asks for nothing new is applied with no
   card. My lean: yes, with §4's list as the limit.
2. **May a patch a model wrote land with no person?** My lean: no in
   v1. Code-only updates land; a model's patch is a card, or a draft on
   a held app. A per-package switch can come once the cards have been
   boring for a while.
3. **Is "kept up to date" on by default?** My lean: on for an install
   by name from a followed index, said on the install card; off for an
   install that pins a digest, a `file:` ref, or a `pk:` ref pasted with
   a URL.
