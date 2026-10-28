# Packages in the UI: bare names, a package is what you pick to publish

> **Status (2026-10-28): ruled, rewritten.** From the owner's second pass
> over stakwork/strut#362: "packages shouldn't be something you're required
> to think about … like node.js: you can code and make whatever project or
> directory names you want, and never think about going to npm." Rows in
> "Decided" marked **ruled** are his; rows marked *proposed* are mine. This
> REPLACES the 2026-10-27 version of this plan, which put the package in
> every local name (the sidebar grouped by package, the builder's working
> package, a rename to move a workflow in). That half was built as
> stakwork/strut#365 and closed unmerged on 2026-10-28.
> **Work items 1, 2 and 3 BUILT** (#362): the publisher name and the
> publish route's prefix check; the build from bare names with the items
> route; the package page. Choices beyond the text: a step or workflow a
> SERVICE published (a `publisher` stamp other than `ai`) is the host's,
> like a seed's, and never carried; a name under ANOTHER package of this
> publisher (`acme/util/x` while building `acme/tools`) stays that
> package's, built and required, rather than becoming `acme/tools/acme/util/x`;
> "Comes along" is a DRY build (`POST /packages/build { dryRun: true }`,
> nothing kept in the cache); the workflow list carries `activeSource` so
> the page hides strut's own seeds (`job`, `builder`, the browser
> workflows).
> **Work item 4 BUILT** (stakwork/strut#371, from main, independent of
> #362): src/package-lookup.ts and its call sites. Choices beyond §2: a
> name's package is its PREFIX whether or not it was installed (stateless,
> the same on every strut); an app's grant check compares names as
> written (manifest and page are in one package), and the `run/*` step
> resolves them; a check's step in a package's claims is written as the
> package's at install; a skipped step's event, a check's
> `config.workflow`, `job/start` and `strut/run-workflow` take names as
> written.
> **Work item 5 BUILT** (#362): §4 as ruled 2026-10-28 — the sidebar draws
> an installed package's group from what is installed and writes nothing.

## Problem

The 2026-10-27 plan kept `plans/marketplace.md` §1's rule on EVERY strut:
an item's name carries its package, so a workflow in `stakwork/tools` had
to be STORED as `stakwork/tools/summarize` where it was made. That made a
person meet packages before they meant to:

- a workflow had to be in a package before it could be published, so
  the builder had to be told a "working package" at every turn;
- a category had to BE a package, one to one, though one package may
  hold workflows from many categories;
- every workflow that already exists (all of them: the builder names
  them bare) could join a package only by a rename across every store
  that keys on its name — runs, jobs, automations, claims, app grants.

Node does not work this way. Your project's files have whatever names you
gave them; the package's name exists in `package.json` and, on the machine
that installs it, in `node_modules/<name>/`. Inside a package, its code
finds its own files first.

| Strut has | Strut lacks |
| --- | --- |
| Names that carry the package where a package is INSTALLED (§1 of the marketplace plan), the installed fold over `upstream` records (`src/packages/installed.ts`) | A package built from workflows named anything |
| The publisher key, its catalog, releases, channels; `POST /packages/publish`, `POST /packages/build` (`src/createStrut.ts:2817`) | A lookup that finds a package's own items by their bare names |
| The publisher name (#362), the Packages dialog and its release list | A page that picks a package's workflows from anywhere on the strut |
| The sidebar's free-text `category` (`web/src/app.tsx`) | Nothing: categories stay as they are |

## Decided

| Question | Decision |
| --- | --- |
| Local names | **Bare** (ruled): whatever the builder or a person names a workflow, step or app, as today. No package in it |
| Categories | **Free, as today** (ruled): the sidebar's grouping. A package may take workflows from many categories; a category says nothing about packages |
| Where packages live | **Their own area** (ruled): the Packages dialog. The sidebar of the strut that publishes shows nothing about packages |
| The publisher | **A server-wide setting** (ruled 2026-10-27, built): one name, set once, the first segment of every package this strut publishes |
| What a package is | *Proposed:* a name, a description, and the workflows, apps and Concepts a person PICKED, with everything they reach |
| Names where a package is installed | **Under the package's prefix** (ruled; marketplace §1, unchanged there): `summarize` installs as `acme/tools/summarize`, so two packages, and the strut's own workflows, never collide |
| References inside a package | *Proposed, accepted 2026-10-28:* **the package first.** A bare name in an installed item resolves to `<package>/<name>` when the package holds it, else to `<name>` (§2). Nothing is rewritten, so a prompt or a Concept page that names a workflow keeps working |
| The build | *Proposed:* stamps each item's OWN name with the prefix and nothing else (§3) |
| A step two packages use | *Proposed:* ships in both; each copy installs under its own prefix |
| The installing strut's sidebar | **Its own group, drawn from what is installed** (ruled 2026-10-28): nothing written, so nothing local mixes into it and an uninstall removes it; each workflow by its name inside the package, the version beside the group's name, the package and its source on hover (§4) |
| The builder | **Knows nothing about packages** (proposed, follows from the rulings): no working package, `create_workflow` keeps its `category` arg |
| Moving a workflow into a package | **Never needed**: nothing is renamed on the strut that publishes |

## 1. What a person sees

**Making things: unchanged.** The builder names workflows; categories
group them. Nobody chooses a package to make anything.

**Publishing**, from the topbar's **Packages**. The head is the publisher
name (asked for once, the first time) and the key. Below, one row per
package published here, its name and newest version; **New package** takes
a name, one segment (`tools`), and opens the package page.

**The package page.** Every workflow on this strut grouped by category,
each with a checkbox; installed ones are not offered (they are someone
else's). Apps and Concepts the same way. For a package already published,
the boxes start as its newest release left them. Under the list, **Comes
along**: the custom steps, subflows and apps the picked workflows reach,
from a dry build. Then version (the one after the newest), channel,
description, **Publish**; the releases below, with the channel moves #362
built.

**Installing: unchanged** (Packages → install or follow). What a package
brings shows up in the sidebar as §4 says.

## 2. The lookup: a package's own items first

An item's PACKAGE is its name's prefix (`packagePrefixOf`, three segments
or more), whether the package was installed here or the name typed so by
hand: the same rule on every strut, and no fold to read. One function:

```
resolveName(pkg, name) = pkg && exists(`${pkg}/${name}`) ? `${pkg}/${name}` : name
```

called with the package of the CALLER wherever strut finds a workflow or a
step by name:

- **the runner**: a `subflow` target and each step's `type`, with the
  package of the FRAME's workflow (the flow being executed, not the run's
  root: a local workflow that calls an installed one calls into its
  package) — `SubflowResolver` (`src/runner.ts:37`), `resolveStep`
  (`src/steps/registry.ts:57`);
- **the `agent` step**: `agentTools` and `approve` entries
  (`expandAgentTools`, `src/steps/core/agent.ts:420`);
- **a step that launches by name**: `run/launch`, `meta/run-workflow`,
  through `ctx.package`, set by the runner beside `ctx.workflow`;
- **an app**: its package from its name; the app door runs a page's step
  in it, `grantRefusal` (`src/apps/tools.ts:137`) compares the names as
  written (manifest and page are in one package), and the app build's
  resolver finds an import of a bare app name, and a granted workflow, in
  the package first;
- **the closure walk** (`flowClosure`, `src/closure.ts:72`), so the
  sealed check, reach, the build and step stats see what will run;
- **the install's check** (`namesIn`, `src/packages/install.ts:773`): a
  bare name is known when the set holds `<package>/<name>`.

On the strut that publishes, nothing is under an installed prefix, so
every lookup is what it is today. Full names still work everywhere: another
package's item (`bob/util/x`), a core or lib step, strut's `job`. A bare
name the package does not hold falls through to the strut (a lib step, the
host's own workflow), as it did on the publisher's strut. Inside an
installed package its own item wins over a local one of the same name;
outside it, the local one. The test that matters: the same YAML runs on the
strut that made it and, installed, on another.

## 3. The build from bare names

`buildPackage` (`src/packages/build.ts:129`) takes the picked names as they
are. What their closure reaches that is LOCAL (not core, lib, a seed's or
installed) is an item at the path of its local name: today that is refused
("outside the prefix and came from no package", `build.ts:203`). Installed
items stay `requires.packages` pins and seeds stay external, as now.

- **Own names stamped.** A workflow's `name:` and a step's `defineStep({
  type })` literal become `<package>/<path>`, which is what the archive
  format (marketplace §1) and the install's checks already expect.
  References stay as written; §2 resolves them.
- **Helpers by import.** A step's helpers are the files it reaches by
  relative imports (the walk `hashedUrl` already does,
  `src/strut-resolve-hook.ts`), not "every `_` file under the prefix". The
  folder layout is the same under the prefix, so the imports still resolve
  once installed.
- **A local name already under the package's own prefix** (one typed by
  hand the 2026-10-27 way) is taken as is.
- **The dry run** is `POST /packages/build`: it writes into the cache by
  digest, harmless, and returns the items — the page's "Comes along".
- **What the newest release held**, for the page's boxes: one read route,
  `GET /packages/:publisher/:name/items?digest=`, the items of a package
  in the cache by their names inside it. No store of its own.

Same picks on the same workspace, same digest, as now.

## 4. The strut that installs

The sidebar reads `GET /packages` with the workflow list and draws each
installed package as a group of its own (`sidebarGroups`,
`web/src/package-release.ts`): every workflow under its prefix, whatever its
category, and nothing else. Nothing is written, not even a category: a
category is a person's to move workflows in and out of, and the version on
the header would then be wrong. The header is the package's segment
(`tools`), or its whole name when another group would read the same, with
the installed version beside it, the one marker it carries; hover gives
the package, version and source. Each workflow shows its name inside the
package (`summarize`), its full name on hover. An uninstall removes the
group. That is all the sidebar knows of packages.

## 5. What this does to #362 and #365

- **#365 closed** (2026-10-28): the sidebar by package, the working package,
  the `[package]` line and the composed names are not needed.
- **#362 keeps** the publisher name and its route check, the Packages
  dialog's head and release list, `nextVersion`. **It changes**: the
  package page picks any workflow instead of those under a prefix
  (`localPackages`, which read packages off names, goes; a package is in
  the list because it is in the catalog), and the build from bare names
  (§3) lands with it, since without it the page cannot publish a bare
  workflow.
- **`plans/marketplace.md`**: §1 gains that references inside a package may
  be bare and resolve in the package first; §8's working-package bullet
  goes.

## Work items

1. **Publisher name.** BUILT (#362).
2. **Build from bare names** (§3): local items in the closure, own names
   stamped, helpers by import, the items read route. Medium, engine. #362.
3. **Package page** (§1): pick any workflows, apps and Concepts by
   category, the boxes from the newest release, "Comes along" from the dry
   build, publish. Medium, UI. #362.
4. **Package-first lookup** (§2): `resolveName`, `ctx.package`, the call
   sites, the install's check. Medium-large, engine. The next PR. Until it
   lands, a package built from bare names refuses to install (the install
   finds a bare reference nowhere): loudly, never wrongly.
5. **The installing strut's sidebar** (§4): the group drawn from what is
   installed, the name inside the package, the version and the hover.
   Small. BUILT (#362).

## Open questions

1. A package built from many categories installs as ONE group. Should the
   installing strut keep the publisher's categories instead? *Lean:* no;
   the publisher's categories are their scratchpad, and the person
   installing thinks of the package.
2. A glob inside a package (`agentTools: ["clip/*"]`): the package's
   matches only, or the package's and the strut's? *Lean:* both, the
   package's copy winning per name, so `graph/*` still finds the lib steps
   from inside a package that ships one `graph/` step of its own.
3. A custom step's code that launches a workflow by name resolves with the
   package of the frame running it. Is the step's OWN package ever the
   right one instead? *Lean:* the frame's, until a case says otherwise.
