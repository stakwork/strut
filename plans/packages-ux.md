# Packages in the UI: the npm shape, without typing the prefix

> **Status (2026-10-27): ruled.** From one design conversation with the
> owner over stakwork/strut#362 (a per-workflow Publish tab, not merged).
> The rows in "Decided" marked **ruled** are his; the rows marked
> *proposed* are mine, accepted as written. Written against strut `main`
> @998beb8. This plan is the UI and the builder's naming ONLY. The bytes,
> the build, the install, the protocol and the distro are
> `plans/marketplace.md`, which this changes in nothing: §1's naming rule
> stands, §8's "publishing is a person's act" stands, the §16 routes in
> `specs/API.md` stand. Two pointer lines there name this file.
> **Work items 1 and 4 BUILT** (2026-10-27, stakwork/strut#362, reworked
> from its per-workflow Publish tab): the publisher name on the record
> and `PUT /publisher`, the publish route's prefix check, and the Packages
> dialog as the package page. One choice beyond §2: the name is set in the
> Packages dialog's head, beside the key, not in Settings — it is the one
> place a person meets the publisher. **Items 2 and 3 BUILT** (2026-10-27,
> the PR after it): the sidebar grouped by the name's package segment with
> the newest release's version on the header, a selected package as its
> page in the canvas area and the builder's working package, `POST /chat
> { package }` and the `[package]` line, `create_workflow` / `create_step`
> naming under it in code. Choices beyond the text: a package's deeper
> folders show in the row's name (`media/clip`), not as subgroups — one
> level is enough until a package has hundreds; a draft package is made
> under "Here" in the Packages dialog and lives in the browser until a
> workflow lands in it; the free-text `category` stays only on a bare
> workflow (its chip is hidden on a packaged one) and `set_workflow_category`
> stays for it. Item 5, the move, is next.

## Problem

`plans/marketplace.md` §1 ruled that an item's NAME carries its package:
`stakwork/tools/summarize` is the workflow `summarize` in the package
`stakwork/tools` of the publisher `stakwork`. That is what makes install
cheap — no package store, no reference rewriting, "installed packages" a
fold over version records (`src/packages/installed.ts`) — and it is not
revisited here.

What #362 did with it was show the stored name raw. To publish, a
workflow had to have been NAMED with two slashes at creation, by a person
who typed the publisher segment by hand (nothing checked it against
anything), before packaging was on anyone's mind. Nobody makes a workflow
by hand here: the builder makes them, with bare names. And publishing sat
on one workflow's flyout, though the unit a release holds is the package
— a workflow left out of the set is retired on every subscriber.

| Strut has | Strut lacks |
| --- | --- |
| Names that carry the package (§1); `packagePrefixOf`, `refuseUnderInstalledPackage` (`src/workspace.ts:526`) | A publisher the SERVER knows, so a person never types that segment |
| The publisher key, its catalog, releases and channels (`src/packages/publisher.ts`); `POST /packages/publish`, `GET /packages/catalog`, `PUT /packages/channels/:channel` (`src/createStrut.ts:2879`) | A place in the UI that is the PACKAGE, not one workflow |
| The sidebar grouped by a free-text `category` (`web/src/app.tsx:352`); `create_workflow`'s `category` arg (`src/ai/tools.ts:520`) | Grouping by the name's package segment; the builder told which package a turn works in |
| The installed fold with `version`, `door`, `items` (`src/packages/installed.ts:49`) | A package shown in the sidebar like any other group |

## Decided

| Question | Decision |
| --- | --- |
| The model | **npm** (ruled): a package has a name and holds as many workflows as it needs — one, or hundreds — and may have categories inside it. `@stakwork` is the publisher, `tools` the package, the workflows its exports, a folder inside it a category |
| The publisher | **A server-wide setting** (ruled): one name, set once, the first segment of every package this strut builds. A person never types it |
| The stored name | *Proposed:* **unchanged**, `publisher/package/path` as §1 rules. The slashes are the file path inside the package; nothing shows them whole. Changing this would mean rewriting references at build and at install, forever |
| What the sidebar shows | **An installed package looks like a category** (ruled): the package name as a group, hover for the publisher; each workflow by its last segment. A package you are making looks the same |
| What a category is | **An unpublished package** (ruled: "a scratchpad for not-yet-published package ideas"). One concept, one kind of group. Inside a package, a category is a folder: `media/clip` under `tools` |
| The marker | **Minimal** (ruled): a group header is the name, and the latest release's version beside it when there is one. No "unpublished", no status words. A version is the reminder |
| Where publishing lives | **Not on a workflow's flyout** (ruled). *Proposed:* the PACKAGE PAGE, opened from the group's header — #362's Packages dialog keyed by one package, with the publish form moved onto it |
| Where new workflows go | *Proposed:* the **working package** — the group selected in the sidebar when the person asks. The UI sends it with the chat message; the server composes the name. Nothing selected, a bare name, as today |
| Moving a bare workflow in | *Proposed:* **not in v1.** A rename touches every store that keys on the name (§5). Until it lands, ask the builder again with the package selected |
| The free-text `category` | *Proposed:* stops being written. A bare workflow that has one still renders as a group, with no package page and no publish, until the move lands and converts it (§5) |

## 1. What a person sees

**The sidebar.** Workflows are grouped by their package — the second
segment of a three-or-more-segment name under this strut's publisher, or
`publisher/package` for an installed one. The header is the package name;
beside it the newest release's version when the package has been
published (yours: `GET /packages/catalog`; installed: `GET /packages`'s
`version`). Hover: the publisher, and "installed" with its source for a
package from elsewhere. Inside a group, deeper segments are subgroups
(`tools/media/clip` draws `media` under `tools`), and each workflow shows
its last segment. Bare workflows sit where they do now. One group kind,
drawn from the name — nothing stored for it.

**Making a category** is making a draft package: a name, typed once,
appearing as an empty group. Until its first workflow lands it exists only
in that browser (`localStorage`, beside the collapsed-groups state); after
that the prefix is the record. The first time a person makes one on a strut
with no publisher name, the UI asks for the publisher name, once —
`npm init` asking for a scope.

**Asking the builder** with a group selected puts the new workflow in it.
The person sees `summarize` appear under `tools`; the builder said
`summarize`; the store holds `stakwork/tools/summarize`. Selecting an
installed package and asking for a NEW workflow is refused by the store
(`refuseUnderInstalledPackage`): a package's prefix holds its own items,
and the UI says so. Editing one of its workflows is the fork §4 of the
marketplace plan describes, unchanged.

**The package page**, from the group header. For a package of yours: the
items it holds (workflows, the steps and apps their closures reach — read
by the same walk `buildPackage` does), version prefilled with the one after
the newest release (`nextVersion`, #362's helper), channel (`stable`), one
**Publish** button; below, releases newest first with the channel beside
the one it points at — move it (a rollback), take the package off it (an
uninstall on every subscriber). For an installed package: publisher,
version, source, door, the items, "edited here" on a fork. This is #362's
dialog, split per package, with the Publish tab's form moved in.

**The topbar's Packages button** keeps the dialog as the overview:
published here, following, installed — the fleet's view, read-only but
for the channel moves it already has.

Apps follow the same rule with nothing new: an app is a package item named
`publisher/package/name` (`apps/<name>/` in the directory), so the Apps
section groups the same way.

## 2. The publisher name

`PublisherInfo` gains `name` (`src/packages/publisher.ts:35`): the prefix
segment, `[a-z][a-z0-9-]*`, set by `PUT /publisher { name }` (the key is
minted alongside when there is none) and read by `GET /publisher`. The
Packages dialog's head shows it as one field beside the key. It is the
human prefix the index lists the key under (`plans/marketplace.md` §7, §13: prefix → key rows),
so it is a field that plan already needs; here it is also what the UI
prefixes every package with.

`POST /packages/publish` keeps taking `package: publisher/name`
(`BuildRequest`, `src/packages/build.ts:78`); the UI composes it from the
setting. One check added at the route: with a name set, a build whose
first segment is another publisher is refused
(`package_build_refused: … is not this strut's publisher`). With none set,
as today.

## 3. The working package

The sidebar's selected group rides on the chat message: `POST /chat {
message, package? }`, the package's one segment (`tools`). Per turn, never
in the frozen system prompt (the chat's history is append-only; the
builder's prompt heads its cached prefix). The turn's user message gets one
line before the typed text, the way attachments do (`[attachment]`,
`src/ai/attachments.ts:35`):

```
[package] tools — name new workflows and steps by their path in this package; a slash makes a folder
```

and `create_workflow` / `create_step` compose the stored name in CODE:
`<publisher>/<package>/<name the model gave>`. The model never sees the
publisher segment and never decides the package. `create_workflow`'s
`category` arg goes (its description told the model to invent sidebar
labels); the `category` of a bare workflow, when a turn has no package, is
left as it is.

The New-workflow dialog does the same: its category field becomes the
package select (the groups in the sidebar, or a new name), and the name is
the path inside it.

A turn with a package selected that the store refuses (an installed
package) answers the model with the store's `package_conflict:` as any
refused publish does; the model says so and stops.

## 4. What this does to stakwork/strut#362

Keep: `PackagesDialog.tsx` (as the overview, §1), `package-release.ts`
and its test, the Versions tab's "installed from / forked from" line, the
Vite proxy entries. Drop: `PublishPanel.tsx` and the flyout's Publish tab
— the per-workflow door is the wrong unit, and the read-only package name
on it is what this plan removes the need for. Rework on the branch rather
than merge-then-remove.

## 5. Not in v1: moving a workflow into a package

A workflow made outside any package (every builder-made workflow today) is
renamed into one only by a cross-store operation: the run store keys runs
by workflow name (`workflows/<name>/runs/`, `src/store.ts:453`), every
event path roots on it, and job records, automations, claims (`ABOUT`),
app grants and sessions name it. "Move to package" is that rename, with
the closure's step types and subflow names rewritten in the YAML and
`defineStep` literals once, on this strut — after which the name IS the
address and nothing is rewritten again. Its design is a plan of its own.
Until then: ask the builder again with the package selected, or copy and
delete, history left on the old name. The same operation, when it lands,
converts a legacy free-text category into a package.

## Work items

1. **Publisher name**: `name` on the record, `PUT /publisher`, the publish
   route's check, the field at the Packages dialog's head. Small. BUILT.
2. **Sidebar by package** (`web/`): group by the name's package segment
   with subgroups, the last segment shown, versions from the catalog and
   the installed fold, hover text; the draft group in `localStorage`; the
   legacy `category` group kept for bare workflows, marked. Medium, UI.
   BUILT (deeper folders in the row's name rather than subgroups; the
   legacy group marked by its hover text only).
3. **Working package**: the selected group → `POST /chat { package }` →
   the `[package]` line and the composed names in `create_workflow` /
   `create_step`; the New dialog's package select; the `category` arg
   removed from the tool. Small-medium. BUILT; `set_workflow_category`
   kept for a bare workflow's legacy category.
4. **Package page**: #362's dialog keyed by package, the publish form on
   it, opened from the group header; the Packages dialog as overview.
   Medium, UI; no new routes. BUILT, opened from the dialog's package rows
   until item 2 gives the sidebar its groups.
5. **Move into a package** (§5): its own plan, later.

Items 1 and 4 are one PR; 2 and 3 the next.

## Open questions

1. Should `GET /workflows` fold `package` and `path` onto each entry, or
   does the UI split the name? *Lean:* the UI splits; one function in
   `package-release.ts` (`packageOf` already does half of it). The server
   adds nothing for a display rule.
2. The publisher name and the index row (§13): one field, or may a strut
   publish under a prefix the index lists for another key? *Lean:* one
   field; the index's pair check (§13) is what refuses a mismatch, later.
3. A bare workflow's free-text `category` during the transition: hide the
   setter in the UI now, or keep it until §5 lands? *Lean:* hide it now;
   what exists still renders.
