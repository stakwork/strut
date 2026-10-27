# Packages — sharing workflows, steps and Concepts between struts

> **Status (2026-10-26): the package BYTES layer, step 1 and step 2 are
> built** (`src/packages/`, see "Step order"): a package builds from a
> strut's own workflows, steps, apps and Concepts into its cache, installs
> from `file:`, lists and uninstalls. An app's migrations and declared
> graph types wait for `apps.md` work items 3 and 4. Revised 2026-10-18
> after a review against npm, Go modules, cargo, bundler, Homebrew taps and
> OCI: the first draft's generated manifest, its first-installer name rule,
> its vendored foreign items and its server-shaped index are gone (§10 says
> what replaced each). Revised again 2026-10-19: **the product is finding,
> downloading and using a package, paid or not** — paid EXECUTION and
> bring-your-own-billing are a later plan (§6), and a package may be only
> Concepts, or only steps (§1, §3). Rows marked *ruled* in "Decided" are
> the owner's; every other row is *proposed*. Extended 2026-10-19: §11
> says where an environment a package needs — a binary, a service, a
> specialized container such as a Kali box — goes: declared in
> `requires`, provided by the deployment, never a folder of the package.
> §12 (2026-10-19) is the other use of the format: a DISTRO, an operator's
> packages rolled out to its own fleet automatically, which is what the
> mcp lab's seeders become. **Extended 2026-10-20: a fourth kind, an APP**
> (`apps/<name>/`, `plans/apps.md`) — the first item that is a directory,
> and, *ruled by the owner*, **forkable and flexible**: the one kind whose
> normal path is the fork. What that changes is written in place: §1 (the
> kind, its hash, what stays out), §2 step 1 (grants in the closure), §3
> (the build as the install check, migrations, graph types), §4 (the
> per-file merge, the inverted nudge), §12 (the first distro app); the
> specifics are mine and proposed. Companion plans this builds
> on: `federation.md` (peers, `strut/run-workflow`, and §2.3's git
> library, which this subsumes; see §9), `claims.md` (the contract a
> package carries), `specs/ENV_SPEC.md` (the binaries a package needs),
> `apps.md` (what an app is, how it is built and what it may call).
> Code citations are on `strut@83a5b10`; §11's and §12's on `strut@19a895e`.
>
> **Revised 2026-10-24: Pkarr is the protocol between struts, and the
> public index is now.** After `plans/p2p-distribution-research.md` (six
> p2p architectures against the four needs — distribute, share, sell,
> charge), the owner ruled three things. Packages are PUBLISHED FROM A
> SWARM strut only; a desktop strut (Peel) installs and forks, never
> publishes (*revised the same day, below: any strut publishes*). The
> protocol is **Pkarr**: a publisher is an Ed25519 key whose
> signed record in the Mainline DHT points at a signed CATALOG by hash, and
> the catalog points at archives by hash — one shape at two levels, bytes
> on HTTP as they are. And the PUBLIC INDEX ships now, as one more key
> whose catalog lists publishers (reversing 2026-10-19). The `peer:`
> source folds into `pk:` (§5), §7 is rewritten, §13 is the protocol —
> keys, records, catalogs, the relay container, re-puts, recovery. One
> lean of mine is written in as the model, proposed: an update's normal
> outcome is COEXISTENCE — the new version lands beside a fork and the fork
> stays active — and each re-point is classified by a schema diff before
> the ask (§4). Selling is unchanged and still later (§6): the record and
> the catalog are public, the bytes behind the archive route are what a
> token gates. Same day, §13 gained **the shipped defaults**: a Stakwork
> relay as the default for struts with no swarm (Peel, a bare `docker run`),
> the index key, a relay list and a plain HTTPS URL for the index catalog,
> all built into strut and overridable, so a bare name resolves on first
> boot with nothing configured.
>
> **Revised again 2026-10-24: any strut publishes.** *Ruled by the owner:*
> a local strut — a plain checkout running `npm run dev`, no Docker; Peel
> — may publish, and its bytes live on a host it uploads to (GitHub
> Releases, or wherever), since nothing can reach into its network. This
> is the case Pkarr is for: the record is what lets a publisher with no
> address be found, and it keeps the pointer off both the byte host and
> Stakwork's index (§10 says why plain HTTP is not enough here). The
> shapes are mine, proposed: a publisher is three roles — the KEY that
> signs, a BYTE HOST that serves, the POINTER that says what is current —
> that need not be one machine (§13); the byte host is a setting of the
> publisher, with GitHub release assets as the first upload target; an
> installing strut re-puts the records of the publishers it installed
> from, so a package people use stays resolvable while its laptop sleeps;
> an install PINS the publisher key it resolved, so an index row that
> later names another key is an ask on the next update, never followed
> silently (§3, §4, §7); and no strut mints a publisher key while its
> secret store runs on the dev default.
>
> **Extended 2026-10-26, after the Graph Protocol group draft** (the
> 2026-10-24 thread, which takes this plan's Pkarr design as its "Option
> D"). All proposed:
> - The catalog's signature is defined: the catalog is a CARD, RFC 8785
>   JSON sealed with Ed25519 over its fingerprint, with a `seq` no reader
>   accepts going backward, and the index catalog is the same card (§13,
>   §7).
> - A release can be yanked (§13).
> - The manifest takes an SPDX `license` (§1).
> - The install ask says what can spend and what can act, read off the
>   closure (§8).
>
> Receipts back to a publisher are left to a plan of their own (open
> question 5).
>
> **Extended 2026-10-27: a fleet fed by its central strut** (§12.1,
> proposed). Hive's org strut holds the workflows the org's agents run, and
> every workspace strut in the org follows its releases. A child SUBSCRIBES
> to the central strut's publisher key and reads its private catalog with a
> token that opens nothing else; §4's update table applies with no ask. This
> brings step 4 and the card half of step 6 forward ("Step order").

## Problem

A useful workflow travels between struts in one way today: someone commits
it to a repo, and a host's boot seeder publishes it from its own source
tree (`mcp/src/lab/seed-opts.ts`; strut's own `src/job-seed.ts`). That
moves *templates owned by the host*. It doesn't move work between people.

The goal is a universe of automations people share, and sell. The owner
expects the common path to be:

- **buy a battle-tested tool (a step) or a whole workflow**, then
- **change it with the builder** — or keep the tools and write their own
  workflows.

So the unit has to be either a step or a workflow, a bought item has to
survive being edited, and an update from its publisher has to reach a
strut that has changed it.

What exists, and what's missing:

| Has | Lacks |
| --- | --- |
| Content-addressed versions: `contentHash` (`src/version.ts:9`), and seeding by content with `reactivateKnown: false` (`src/workspace.ts:288-298`) | An identity that holds across struts. The local key is 12 hex chars (48 bits), and `vN` labels are per strut (`src/step-ref.ts:9-10`) |
| Namespaced step names, and routes that take the slashes (`/steps/:type{.+}`, `src/createStrut.ts:2402`) | Namespaced WORKFLOW names: the file store lists `workflows/` with one flat `readdir` (`src/workspace.ts:466`) |
| `flowClosure`: what a workflow can execute, through subflows and `agentTools` (`src/closure.ts:60`) | A way to turn a closure into one shippable directory |
| A version's door (`VersionSource`, `src/workspace.ts:203`) and the service stamp (`publisher`) | Where a version CAME FROM, and whether it was edited since |
| A workflow's contract in its YAML (`claims:`, `readClaimsBlock`, `src/workspace.ts:75`) | A file form for a step's claims |
| Concept pages seeded by a stamp prefix (`seedConcepts`, `src/concept-seed.ts:151`) | Concepts that travel with the steps they document |
| Peers and `strut/run-workflow` (`src/peers.ts`, federation §2.2); the file token, the key attenuated to one scope's reads (`fileToken`, `src/auth.ts:162`) | Anything to pull from a peer, and a credential for one package's bytes |
| Secrets bound per run (`SecretsCapability.forPrincipal`) | A fence on what one STEP may read |

## Decided

| Question | Decision |
| --- | --- |
| The unit | ***Ruled:* one design serves both a workflow-centric package and a step-centric one.** A package is a DIRECTORY holding one namespace; any folder may be absent, so a package can be only steps, or only Concepts (§1) |
| An app | ***Ruled (2026-10-20):* forkable and flexible.** A kind like the others, `apps/<name>/` — the one item that is itself a directory (`apps.md` §1.1). Its item hash is the tree hash of its own directory, the same function as the package digest; `data.db` and `dist/` are never shipped; it is built at install against the installing strut's kit, and the build is the check. An update merges it per file, and the app is the wrapper that keeps the package's steps fast-forwarding underneath a fork (§1, §3, §4) |
| What is sold | ***Ruled (revised 2026-10-19):* packages.** A paid package is a gated download. Paid execution is a later plan (§6) |
| Ownership | **By prefix, bound to a KEY in a catalog.** Package `acme/linear` owns every name under `acme/linear/`, workflows included (`acme/linear/sync`). Which KEY may publish under `acme` is a row in the index catalog (`acme → <z32 key>`, §7); a direct `pk:` ref names the key itself. No NAME is bound at install (§1, §13); the KEY is pinned: an install records the key it resolved, its updates follow that key, and an index row that later names another key is asked about, never followed (§3, §4, §7, proposed) |
| Who publishes | ***Ruled (2026-10-24, revised the same day):* any strut.** The key lives where the publisher works, and signs there. The bytes live on a BYTE HOST anyone can reach: a swarm's own archive route, or — for a strut nothing can reach, a laptop checkout or Peel — a host it uploads to (GitHub Releases, or wherever). The pointer is the key's Pkarr record, so moving to another host changes no ref (§13) |
| The protocol | ***Ruled (2026-10-24):* Pkarr** over the Mainline DHT, for the POINTER alone: a key's one signed packet (≤1000 bytes) names its catalog's hash and URLs, never packages one by one. Bytes stay on HTTP by hash, on whatever host serves them. The client is a WASM library inside strut; one Pkarr RELAY container per swarm does the DHT and caches. What it buys over plain HTTP is a pointer held by neither the byte host nor the index operator — what a publisher with no address of its own needs (§10, §13). iroh and Hyperswarm are not adopted (§13, `plans/p2p-distribution-research.md` Option C) |
| Dependencies | **A package carries only its own prefix.** Another package it executes is a `requires.packages` pin — an exact digest with a source hint — and the install resolves those with the same function, under one ask. No ranges, no solver: exact pins union, and two that disagree refuse (§1, §3) |
| Identity | **The digest is a tree hash** over the directory, manifest included. The manifest holds nothing derivable from the files: no item list, no per-file hashes, no step types (§1) |
| Where it lives once installed | **Nowhere new.** Installed items are ordinary workflows, steps and Concepts. Each version records its `upstream`, and "installed packages" is a fold over those records. There's no package store (§3) |
| Conflicts | **Refuse.** A local creation under an installed prefix, or one name pinned at two digests, refuses the whole install; nothing is written (§3) |
| An update over a local edit | **Never activates over a fork — and coexistence is the normal outcome, not the exception row** (proposed 2026-10-24; the research's Option A). Untouched items fast-forward. A modified one gets the new version beside it, with the local edit left active; a merge is something the builder is ASKED for. Each re-point is classified first — schemas and claims unchanged under every dependent → `silent`, else `named` — so the ask says which is which (§4) |
| An update, and a person | ***Ruled:* an update asks like an install.** New code never lands on an accept that was given for other code (§4, §8) |
| Transport | **`file:`, `git+` and `pk:` in v1.** *Ruled (2026-10-24):* Pkarr is the protocol between struts, and the 2026-10-18 `peer:` source folds into it — a `pk:` ref resolves a publisher's signed record to a catalog to an archive, fetched by hash from any holder, so a peer's archive route is one URL among a catalog's. It revises federation §2.3's "no strut-to-strut copy" for packages (§9). OCI is not designed (§5, §13) |
| Trust | ***Ruled:* in-process, with one fence.** An installed step runs like a `POST /steps` step today, and `requires.secrets` is ENFORCED: a step with an `upstream` reads only the names its package declared (§3) |
| Price | **Not in the package.** The source gates the download: a private repo's ACL, or a token the seller mints for a strut's archive route (§6). The record and the catalog are public; the bytes are what is gated (§13). A release asset on a public repo is public, so a publisher on a laptop sells through a private repo or a strut that serves the archive |
| The catalog | **A card** (proposed 2026-10-26): RFC 8785 JSON sealed with Ed25519 over its SHA-256 fingerprint under a domain prefix, with a `seq` no reader accepts going backward; the index catalog is the same card. A catalog no record names — the index over HTTPS, a lapsed publisher's — is checked by its seal alone. A release may be `yanked`, never deleted (§13) |
| The index | **A key whose catalog lists publishers.** ***Ruled (2026-10-24, reversing 2026-10-19):* the public index ships now.** One more Pkarr key, operated by Stakwork, whose record points at a signed catalog of prefix → key rows with descriptions; it holds no content and no package list — the publishers' own catalogs do. `index.yaml` in a git repo stays as a deployment's private index (§7, §13) |
| Who installs | **A person.** Installing is publishing third-party code onto the server: a keyed `full`-scope route, or a builder tool that asks first. No `meta/*` twin (§8) |
| A fleet | ***Ruled:* an operator's packages roll out to its own struts automatically, by channel** (a branch of the distro repo); the merge is the accept. Every rule above holds for an item — a swarm's edit is never overwritten (§12) |
| A fleet's source | **The central strut's own catalog, read by key** (proposed 2026-10-27, §12.1). A child installs what a card sealed by the key it subscribed to names, so no connection carries authority. The catalog is private: it is never put in the DHT, and a child reads it with a token worth that catalog's bytes and nothing else. The git distro repo stays for an operator who wants a merge to be the accept |
| The lab's names | ***Ruled:* they move under package prefixes** (`pod/claim` → `hive/pod/claim`), with a `renames` map from the distro for what still says the old name (§12) |
| An environment a package needs | **Declared in `requires`, provided by the deployment, never shipped.** A binary is `requires.binaries`, a network service is a URL and token in `requires.secrets`, a specialized container is a `requires.runtimes` entry naming a RUNTIME — a place `ctx.services.shell` spawns — pinned to an image digest the deployment builds from. No folder, no Dockerfile, no pull by strut (§11) |

## Design in one paragraph

A **package** is a directory: a `strut.yaml` of a few hand-written lines
and the files beside it — `workflows/<name>.yaml`, `steps/<name>.ts`,
`concepts/<Name>.md` — every one an item named under the package's own
prefix. Its **digest** is a hash over the tree. Building one is
`flowClosure` written to disk, with anything the closure reaches outside
the prefix turned into a `requires.packages` pin. Installing one checks
the tree against its pin, installs the required packages first, refuses
any name the prefix rule does not allow, then publishes each item through
the content-hash publishers seeding already uses, stamped
`upstream: { package, version, digest, source }`. A fork is an ordinary
edit that carries its parent's `upstream` forward. An update is an install
of the same package from its recorded ref: it asks like the first one did,
fast-forwards what nobody changed, and lands the rest BESIDE the fork —
the fork stays active, and a three-way merge is something the builder is
asked for, after which the claims re-run. Between struts the ref is
`pk:`: a publisher is a KEY — on any strut, a swarm or a laptop — whose
signed record in the Mainline DHT points at its catalog by hash, the
catalog names every package it built with a digest and archive URLs on
whatever host serves them, and the public index is one more key whose
catalog names publishers. Where the directory comes from — a path, a git
ref, a `pk:` record — is a resolver's job, and the archive route is also
where a price is charged.

## 1. The package

```
strut.yaml                        # the manifest: a few lines, none generated
workflows/sync.yaml               # → the workflow acme/linear/sync, the YAML as published
steps/create-issue.ts             # → the step acme/linear/create-issue
steps/create-issue.claims.yaml    # optional: the step's claims
steps/_shared.ts                  # → acme/linear/_shared; helpers ride with their namespace
concepts/Linear.md                # front matter as seedConcepts reads it
apps/issues/app.yaml              # → the app acme/linear/issues: a DIRECTORY item (apps.md §1.1)
apps/issues/src/App.tsx           #   with its src/, public/ and db/ migrations — never its data.db
```

```yaml
# strut.yaml
package: acme/linear          # publisher/name — the prefix every item here is named under
version: 1.4.0                # the publisher's label; the digest is the truth
description: Linear issues, comments and sync, tested against the live API
license: Apache-2.0           # optional: an SPDX expression, shown at install, never enforced (below)
requires:
  secrets: [LINEAR_API_KEY]   # the names its steps may read — enforced after install (§3)
  binaries: []                # what its steps call by name on PATH — checked, reported (§11)
  runtimes: []                # containers its steps run commands in — named, never shipped (§11.2)
  packages: []                # other packages it executes, at exact digests (§1):
  # - { package: bob/util, digest: "sha256:…", source: "git+https://github.com/bob/util@v2.1.0" }
```

- **The prefix is the identity.** A package name is `publisher/name`, one
  slash — a convention, not an account, like a forge's `org/repo`. Every
  item is `<package>/<file path without its extension>`: `steps/create-issue.ts`
  is `acme/linear/create-issue`, and its `defineStep` must say so (the
  install checks). A workflow's file names it the same way, so workflow
  names gain slashes; the step routes already take them (`:type{.+}`),
  and the file store's flat listing of `workflows/` is the one place that
  doesn't (step 1). Core and lib types have one or two segments, today's
  custom namespaces (`pod/test`) have two, a package item has three or
  more — nothing collides.
- **One shape, any subset.** Every folder is optional: a package of one
  step, a package of Concepts alone (an ontology a deployment shares), a
  workflow over core and lib steps with no code at all, an app with the
  workflows it drives. Nothing in the
  format or the install says which kind it is, and `requires.packages`
  pins any kind. **A new kind is a new folder** — prompt files, hotword
  lists, cassettes later are one folder and one publisher each — and an
  unknown top-level folder is REFUSED, not ignored, so a package from a
  newer strut fails whole instead of installing half. What has no
  publisher in strut — a binary, a service, a container — is not a kind:
  it is a requirement (§11).
- **An app is the one kind that is a directory** (2026-10-20). `apps/<name>/`
  is the app's whole directory as `apps.md` §1.1 lays it out — `app.yaml`,
  `src/`, `public/`, `db/` — named `<package>/<name>` like a file item.
  Its item hash is the **tree hash of that directory**, the same function
  as the package digest below (`treeHash`, `src/version.ts`), which is
  also its version hash in the workspace (`apps.md` §1.3): one hash, so
  "untouched" means the same thing for an app as for a workflow.
  `data.db` and `dist/` are never in a package — the buyer's data, and the
  derived document the install builds (`apps.md` §2).
  The kit the app is built against is the INSTALLING strut's, never the
  package's: the build at install is the compatibility check (§3), and the
  manifest declares nothing about it. The alternative — a package that IS
  an app, `src/` at its root — was considered and dropped: two shapes for
  one thing, when a package of zero or several apps is the common case.
  **An app may be a KIT** — components the package's other apps, or anyone's,
  import by the app's name (`apps.md` §3.4): `hive/ui` is `apps/ui/` beside
  `apps/climb/`, and nothing in the format says so, because nothing needs
  to.
- **A Concept's record is its stamp.** A Concept has no version record;
  its node carries `unique_source_id = pkg/<package>/<file>@<hash>`
  (`seedConcepts`), and the installed directory stays under
  `<dataDir>/packages/<digest>/` (§5), so the node plus that file is what
  `upstream` is for a step: which package, which content, and whether it
  was edited since (its `description` / docs no longer equal the file's).
  A page's `parent` must resolve to a page in this package, in a required
  package, or already in the graph (`Job`, `Workflow Builder`); a missing
  one is refused at install, naming it.
- **The digest** is `sha256:<hex>` over `<path>\0<sha256 of the bytes>\n`
  for every file under the directory, sorted by path, `strut.yaml`
  included. Whoever pins computes it — an index entry, a
  `requires.packages` pin, a version's `upstream` — and it lives in the
  manifest nowhere, since the manifest is under it. Pinning the digest
  pins every byte, and a changed byte fails the install. The same thing
  git's tree hash and an OCI digest are.
- **Nothing in the manifest is derivable from the files.** The item list
  IS the directory; the core and lib types the items name are read off the
  files at install. So the manifest changes only when the author changes
  it, and there is no generated line to forget to regenerate.
- **Own prefix only.** A package never ships another publisher's item.
  What its closure reaches outside its prefix is a `requires.packages`
  pin — the package, the exact digest, a source hint — read off that
  item's `upstream` at build time. Vendoring belongs to the buyer's strut,
  which holds everything installed; the consumer vendors, the published
  unit never does (Go ignores a dependency's `vendor/`, npm and cargo
  refuse to publish one).
- **No ranges, no solver.** Every pin is exact, so resolving a set of
  packages is a union, and one name at two digests is a refusal a person
  reads. `version:` is display.
- **Claims ride with the item.** A workflow's are its `claims:` block,
  already part of its YAML and its hash. A step's live in the sibling
  `<name>.claims.yaml`, in the same shape (`claimsArgSchema`), about that
  step. They are the package's promise, and §4 re-runs them on the buyer's
  strut after every change.
- **A license is one line** (2026-10-26, proposed). `license:` is an SPDX
  expression: `Apache-2.0`, `MIT OR Apache-2.0`, or `LicenseRef-<id>` for
  terms of the publisher's own, stated where it chooses (its homepage in
  the index, §7). It is optional. The install ask shows it, or says there
  is none (§8), and the catalog repeats it on each release so a search
  shows it before a fetch (§13). Nothing enforces it.
- **Not in a package:** runs, evidence, secret values, automations,
  owners, run caps, params overrides, prices, signatures, an app's
  `data.db` and `dist/`, a kit version.

## 2. Building one — `buildPackage`

`buildPackage(workspace, { package, version, description?, workflows?,
steps?, apps?, concepts? })` writes the directory:

1. **Closure.** For each named workflow, `flowClosure` (`src/closure.ts:60`),
   `agentTools` globs expanded against the registry. **For each named app,
   its `grants`** — every workflow in `grants.workflows` and
   `grants.automations`, every custom step in `grants.steps` (globs
   expanded the same way) — walked on from there by `flowClosure`: an
   app's grants are what it can execute, as a workflow's subflows and
   `agentTools` are (`apps.md` §5). Every reached
   workflow and custom step under the prefix is an item. One outside the
   prefix: with an `upstream`, its package and digest become a
   `requires.packages` pin (a second pin of the same package at another
   digest refuses the build); without one, the build is refused naming it
   — package it under your prefix, or install it from its package, or
   (2026-10-26, proposed) build its package first and name that digest in
   the request's `requires.packages`, the case of a publisher's own sibling
   packages on one strut. Core
   and lib types are recorded nowhere, an app's `graph/*`, `run/*` and
   `sqlite/*` grants among them. **An app's IMPORTS of other apps** are
   walked the same way (`apps.md` §3.4): a kit under the prefix is an item,
   one outside it a pin, `strut/views` — strut's own seed — recorded
   nowhere, like a core step. A closure that isn't `resolvable`
   (a templated `subflow` or grant) is refused, naming the step, unless
   `workflows` / `steps` list what it reaches. A named app itself goes in
   whole — its active version's directory as `materializeAppVersion` gives
   it, minus `data.db` and `dist/`, which are never an item's content.
2. **Helpers.** Every `_`-prefixed file in the prefix's step directory goes
   in. Imports aren't parsed; the namespace convention (`gitree/_shared`)
   is the boundary.
3. **Concepts.** Only those named in `concepts`, plus the subtree under
   each one (`PARENT_OF`). A Concept is documentation the author chooses,
   never inferred from what a run read.
4. **Step claims.** The live claims `ABOUT` each included step, written as
   its `.claims.yaml`. A claim whose check reaches outside the package and
   its requirements is left out, with a warning.
5. **Secrets.** `requires.secrets` starts from what can be found — the
   `secretsEnv` names in the YAML, string literals in `secrets.get("…")`
   calls in step source — and the author edits it. It is a declaration
   the install ENFORCES, so an under-declared package fails on the buyer's
   strut with the missing name, not silently. `requires.binaries` and
   `requires.runtimes` start the same way — every literal `cmd` of an
   `exec` step (ENV_SPEC §9's rule) and every `runtime:` field in the
   closure — and the author edits them; neither is enforced, both are
   reported at install (§11.2).
6. **Refusals.** An item in a sealed NAMESPACE (`eval/*`, `meta/*`,
   `STRUT_SEALED`; `src/sealed.ts`) can't be packaged — those are strut's.
   An item marked `sealed: true` on its def or at the top of its YAML can,
   and keeps the mark on install; a grader is the case (§12).

The manifest `buildPackage` writes is the one a person would write by
hand; the builder can author it too.

## 3. Install — `installPackage`

`installPackage(dir, { pin? })` takes a directory a resolver (§5) produced:

1. **Verify.** The tree digest against the pin when there is one. Each
   step file's declared `type`, and each workflow's path, against the
   prefix rule. Every core and lib type the YAML names is in this
   registry. **Each app's `app.yaml` shape-checks and its directory
   BUILDS against this strut's kit** (`apps.md` §2): a bare import the kit
   lacks, an import that leaves the directory, a manifest that does not
   parse, refuses the install naming it — the kit is this strut's, so the
   build is the compatibility check and the package declares nothing. Each
   app's granted workflows and custom steps are items of this package, of
   a required one, or core and lib. Every `requires.packages` entry is installed at that digest,
   else resolved from its hint and installed FIRST — the same function
   recursing; one name required at two digests, or already installed at
   a third, refuses. Missing `requires.secrets` and binaries are reported,
   not refused: the builder asks for the secrets (§8).
2. **Name rule.** For each item's name: free → published. Its versions
   carry an `upstream` of this package → an update (§4). Anything else —
   a local creation under the prefix, a core/lib type, a sealed namespace
   — is `package_conflict: <name>`, and **nothing is published**: an
   install is all or nothing, so every name is checked before the first
   write. Concepts join the same pass: a `concepts/<Name>.md` whose node
   exists unstamped, or stamped by a seed or another package, is
   `package_conflict: Concept <Name>` — never the seeder's silent skip. The rule holds after install too: creating a step or workflow
   under an INSTALLED prefix (`PUT /steps`, `create_step`, a publish) is
   refused with the package named — editing an installed item is a fork
   (§4), adding a sibling into someone else's namespace is not.
3. **Publish.** Steps first, in path order, then workflows, then apps,
   through `publishStep` / `publishWorkflowByContent` / `publishApp` with
   a new door, `VersionSource: "install"`, and the new field `upstream` on
   the version record. An app's publish is the publish `apps.md` §1.3
   describes: the document built (already proven in step 1), the
   `db/*.sql` files the buyer's `data.db` has not seen applied in order —
   install IS a publish, and a failing migration fails the install, which
   is all or nothing — and its declared graph types registered add-only
   (`apps.md` §4.3), a type that conflicts with what the graph holds
   refusing, naming both. Concepts go through `seedConcepts` as a set with the prefix
   `pkg/<package>/` and one new option, `keepEdited`: a page whose fields
   no longer equal the installed file is left alone and reported (§4),
   where a boot seed overwrites. On a filesystem workspace (no graph)
   Concepts are skipped, with a warning.
4. **Claims.** A workflow's `claims:` block is reconciled at publish, as
   for any publish (`reconcileWorkflowClaims`,
   `src/claims-authoring.ts:489`). A step's `.claims.yaml` goes through the
   same reconcile, extended to a step subject, with the package as the
   speaker. `publish`-kind checks fire at install as at any publish. `run`
   checks fill the buyer's own ledger from the first runs on this strut;
   until then each claim reads `unknown`, which is the truth.
5. **The fence.** `upstream.secrets` is the package's declared list. When
   the runner dispatches a step whose active version carries an `upstream`,
   the secrets view it hands that step (`forPrincipal` already makes one
   per run) refuses every other name, naming the package in the error.
   Steps only: a bought WORKFLOW is YAML a person can read, and its
   `secretsEnv` names are in the install ask; a bought STEP is code that
   could ask for anything at run time. A fork inherits the fence; a person
   widens it through the UI or the keyed API (a field on the version),
   never through the builder. Not isolation — the step still has `shell`
   and `http` — but the install ask then says exactly what the code can
   reach, and means it.

**There is no package store.** `GET /packages` folds the workspace: every
name whose versions carry an `upstream`, plus every Concept whose stamp
starts with `pkg/`, grouped by package, each item with `{ installed:
version, digest, source, active: <its version>, modified }` — `modified`
is active ≠ the installed hash for a step or workflow, and fields ≠ the
installed file for a Concept. Uninstalling is deleting those names the
way a seeder retires one — the versions go (soft on a graph), the RUNS,
evidence and jobs stay, never `store.deleteRuns` — so history keeps the
name it ran under
(`DELETE /packages/:publisher/:name` deletes every name under the prefix
whose active version is still the package's own, retires every untouched
Concept of the package through `seedConcepts`'s `retired` path, and lists
the forks and edited pages it left alone).

**Version records gain one field.** `upstream?: { package, version,
digest, source: { ref }, key?, secrets }` on `WorkflowVersionInfo`,
`StepVersionInfo` and `AppVersionInfo` — the file store's `_metadata.json`,
and one optional attribute on `StrutWorkflowVersion` / `StrutStepVersion` /
`StrutAppVersion` (the AGENTS.md schema convention, plus a conformance
case). **A publish over an existing
name carries the active version's `upstream` forward** unless it sets its
own. So a builder edit of an installed workflow is a fork that still knows
its base. `key` (2026-10-24, proposed) is the publisher key the install
resolved — for a `pk:` ref the key it names, for an index name the key
the index row named at that moment — and is absent for `file:` and
`git+`. It is the PIN §4's update follows: what an index name meant on
the day it was installed is what it keeps meaning for that install.

## 4. Fork and update

**A fork is an edit.** `edit_workflow` / `edit_step` / the UI publish a
new local version (door `builder` / `ui`) whose `upstream` is inherited.
Its hash differs from the installed one, so the fold says `modified`.
Nothing else changes. For an app the edit is to a directory —
`app/checkout`, files, `app/publish`, by the builder or a job agent alike
(`apps.md` §8) — and the new tree hash says `modified` the same way.

**Coexistence is the model, not the exception row** (2026-10-24,
proposed; `plans/p2p-distribution-research.md` Option A — Unison, Nix
overlays, Fossil's leaves). A name on a strut is per-node metadata
pointing at a hash — the `vN` labels already are — and two versions of an
item side by side is the normal state of a fork, not a conflict to
resolve. So an update never implies a merge: the new upstream version
lands as a hash with an edge to its parent, the active pointer stays where
the person put it, and converging is a thing the builder is ASKED for. The
way a good fork travels back is not a PR into the publisher's repo: the
forker's strut publishes it as its own package (its own prefix, `upstream`
recorded, §13), and the original publisher may re-point to it or not.

**A re-point is classified before it asks.** For each item the update
would re-point, compare the new version's CONTRACT with the old under every
dependent in the workspace: a step whose Zod input and output schemas and
claims are unchanged, a workflow whose `input:` block and claims are
unchanged → `silent` (the ask lists it under "unchanged contract"); anything
else → `named` (the ask lists what changed and which workflows name it,
through `flowClosure`). Elm's `elm bump` over the API diff is the
precedent; `stepSchemas` and `flowClosure` already compute both sides.
The classification informs the ask and never skips it (*ruled*: an update
asks).

**An update is an install of the same package from its recorded ref.**
`update_package({ package, ref? })` re-resolves `upstream.source.ref`: a
tag never moves, so a package installed at `@v1.4.0` updates only when a
person names a new ref; a branch floats, like Go's `@latest`; a `pk:`
ref with no digest is whatever the publisher's catalog says now (§13).
**An update follows the pinned key, not the name** (proposed): an install
by index name re-resolves the name, and when the row now names a key other
than `upstream.key`, the update stops before fetching anything and asks —
both keys, the index that changed, and the choice to follow the new key
(re-pinning) or stay on the old one, whose record still resolves until it
lapses. A
new digest **asks** the way the first install did (*ruled*): the items
that changed, each `silent` or `named`, the new requirements, then
accept. Per item, compare the ACTIVE version with the hash the previous
install put there:

| Active version | Result |
| --- | --- |
| Equal to the previous install's hash (untouched) | **Fast-forward:** publish the new version and activate it |
| A local version (forked) | **Diverged:** publish the new version WITHOUT activating it (a new `activate: false` on `PublishByContentOptions`) and report it. The fork stays active |
| The new hash already (same content) | Nothing |
| An item the new version no longer ships | Retired only if it is untouched, as a seeder's retired step is today. A fork is kept and reported |
| A Concept | The same four rows, read off the node against the installed file (`keepEdited`): untouched → updated and restamped; edited → left alone and reported, with the three texts for the merge below — base the file in the previous install's cached directory, theirs the new file, ours the node |

A required package at a new digest is updated the same way, first.

**Rebase is the builder's.** `update_package` does, per diverged item: a
three-way merge of base (the version the fork inherited `upstream` from),
theirs (the new upstream) and ours (the active fork), by `git merge-file`
on the three texts. It's deterministic and needs no model. A clean merge
is published as a local version upstreamed to the new version. A
conflicted one comes back to the model with the markers, and it resolves
them with `edits`, as `edit_workflow` already takes them. **Then the
claims run:** the package's own, which the fork inherited, and the
buyer's. The tool result is the ledger. "Did my change or their update
break what I paid for?" is answered by checks, not by reading the diff.

**An app merges per file.** The same three-way merge, run inside the
directory: base is the installed version's directory under
`<dataDir>/packages/<digest>/`, theirs the new package's, ours the active
fork materialized. A file only one side changed is taken; a file both
changed goes through `git merge-file`; a binary under `public/` changed on
both sides takes theirs and is reported; `db/*.sql` are never merged —
migrations are additive files, so theirs are added and run at the
publish. The merged directory must BUILD: a result that does not build is
a conflict for the builder like a marker is. A clean result is published
as a local version upstreamed to the new one; `data.db` is untouched
throughout, which is the whole reason to update in place rather than
reinstall. (`app/checkout`, `app/build` and `app/publish` are the builder's
hands here, `apps.md` §8.)

**Wrap rather than edit** is what the builder's prompt should prefer for a
bought STEP: compose around it (a step or workflow that calls it), so
updates keep fast-forwarding. It's a nudge in the prompt, not a rule.

**For an app the nudge inverts** (*ruled* 2026-10-20: apps are forkable and
flexible). An app cannot be wrapped, only edited, so the fork is its normal
path: fork freely, and the merge above is the update — shadcn's model, the
code copied into your project so that you can change it, with the update
path shadcn lacks. The app is itself the wrapper around the package's
steps: a forked `apps/issues/` leaves `acme/linear/create-issue`
fast-forwarding underneath it, which is what "wrap rather than edit" was
for. A COPY under a new name — `app/init { template: acme/linear/issues }`
— is not a fork: it carries no `upstream`, lives under the buyer's own
names, and no update reaches it.

## 5. Sources

A source turns a reference into a package directory under
`<dataDir>/packages/<digest>/` (content-addressed, so a second fetch of
the same digest is a no-op, and what was installed is kept whatever
happens upstream — the left-pad rule). One interface,
`resolve(ref, ctx) → { dir, digest, source }`:

| Ref | Resolver | Notes |
| --- | --- | --- |
| `file:/path/to/pkg` | copy | dev, tests, packages a host ships in its image |
| `git+https://host/org/repo@<ref>[#<path>]` | `git/checkout`'s bare cache under `<dataDir>/repos`, credential from a named secret (`tokenSecret`, default `GITHUB_TOKEN`) | GitHub, Forgejo, GitLab — anything git. The repo's ACL is the access control, so a private repo is a private package. The recorded ref is what an update re-resolves |
| `pk:<z32 key>/<publisher>/<name>[@sha256:…]` | the publisher's Pkarr record (through the relay, §13) → its signed catalog, fetched by the hash the record names and checked against it and the key → the package's row: digest + archive URLs → the archive fetched by digest from the first URL that answers, verified | The protocol between struts (*ruled 2026-10-24*). A URL in the catalog is anything that serves the bytes: a strut's archive route — the publisher's, a mirror's — `GET /packages/:publisher/:name/archive?digest=sha256:…`, a tar of the directory, open for a public package and behind the seller's token when selling (§6); or a file the publisher uploaded, a GitHub release asset (§13). With no `@sha256` the ref floats to whatever the catalog says now, its newest release not yanked (§13); the install records the digest it took and the key it resolved (§3). An index name with no key (`acme/linear`) resolves through the index catalog's `acme → key` row first (§7) |

OCI (`oci://…`, ORAS) as a TRANSPORT for packages is not designed: the
digest model is OCI's already, so it would be a fourth resolver and
nothing else. OCI *images* are something else — how an environment a
package needs is named and pinned — and that is §11.

The 2026-10-18 `peer:` source — a peer's archive route behind the peer
key, "a desktop pulling from its cloud strut" — is gone as a source
(2026-10-24): a peer's route is one URL in a catalog, the pointer to it is
a public signed record, and its credential, when it needs one, is the
seller's token (§6), never the peer key. A desktop no longer pulls from
its cloud strut by name; it resolves the same `pk:` ref everyone does.

**Exporting is the other direction, for git:** federation §2.3's
`export_workflow` mechanics (`git/checkout` → write files → `git/push` →
`github/create-pr`, always a PR, the actor's token), with `buildPackage`
writing the files. A package's repo IS its upstream: merging the PR, then
the next update on every strut that installed it from there, is the
distribution.

## 6. Selling — a gated download

Nothing in §1–§5 knows about money, and nothing has to: **a paid package
is a download someone was allowed to make.** Two forms, both already in
§5:

- **A private git repo.** Buying is being granted read access; the forge
  is the gate. Zero new code, and the right answer for a company selling
  to a few customers it already talks to.
- **A strut's archive route behind a token the seller mints.** Strut
  already mints and checks a scoped HMAC token for one run's or job's
  files (`fileToken`, `src/auth.ts:162`): the same thing with a scope of
  `package:acme/linear` and an expiry is the entitlement. The buyer's strut
  keeps it in an encrypted file beside `peers.json` (`entitlements.json`,
  keyed by publisher key and package, §13) and presents it on every fetch
  of that package's archive, so updates flow until it expires — then you
  keep what you installed and stop getting new digests. The record and the
  catalog stay public either way (§13); the token gates the bytes. How
  the buyer paid to get that token is a checkout, outside this plan.

**No DRM, ever:** a bought package can be read, forked and evolved, and
that's the point — the money buys the updates, the evidence on them, and
legitimacy. No per-buyer watermark: the digest and the recorded source
are the provenance.

**Later, in its own plan — paid execution.** A buyer who never gets the
item and calls it on the seller's strut (`strut/run-workflow`, already
built), and the inverse of that: running a seller's logic and knowledge
base on the BUYER's tokens by carrying the buyer's Mothership credential
on the launch (`plans/mothership-cost-control.md`; federation §2.2 defers
exactly this). Both are access on the launch route, not on the download,
and both sit beside this plan without changing a line of §1–§5.

## 7. The index

An index is **a list of PUBLISHERS, not of packages** (2026-10-24; the
2026-10-19 draft listed packages in `index.yaml`). ***Ruled
(2026-10-24):* the public index ships now**, reversing 2026-10-19's "no
public index yet". It is one more Pkarr key (§13), operated by Stakwork:
its record points at a signed **index catalog**, the same card as a
publisher's (§13), sealed under the prefix `strut-index\n` (shown
indented here; it is served in its RFC 8785 form):

```json
{
  "v": 1,
  "key": "<the index key, z32>",
  "seq": 1792972800000000,
  "publishers": {
    "acme": { "key": "<z32>", "description": "Linear, Notion and Slack tools", "url": "https://acme.example" },
    "hive": { "key": "<z32>", "description": "Stakwork's distro" }
  },
  "sig": "<128 hex>"
}
```

a row per prefix: the key that may publish under it, a description, a
homepage. **It holds no content and no package list.** A strut that wants
`acme`'s packages resolves `acme`'s key to `acme`'s own catalog (§13), so
the index is the phone book and the publishers are the shops; a listing
costs the index one row, and a publisher's new release costs it nothing.
The door is `PUT /index/:prefix { key, description?, url? }` on the index
strut, behind its key — a person's act, Stakwork's for now; a change is
one re-signed catalog and one re-put record. **Recovery lives here**
(§13): a publisher who loses a key gets a new row with the new key, and
every NEW install of the name follows it. An install already made pinned
the key it resolved (§3), so its next update asks before following (§4):
the index decides the first introduction, and only a person moves an
install to another key. So a name is not owned by whoever the row names
today — "alice" means the key it meant when you installed from her.

A strut subscribes to indexes BY KEY — `STRUT_PACKAGE_INDEXES`, a JSON
list of `{ id, key }` with Stakwork's public one as the default, and
`PUT /packages/indexes/:id { key }`, the peers' paste door in the same
shape. The index catalog is also served over plain HTTPS at the index
strut's `GET /index/catalog` (`STRUT_PACKAGE_INDEX_URL`, §13's shipped
defaults), checked as a card against the subscribed key, so a strut with
no relay reachable still reads the phone book. Fetched that way, no
record names its digest, so the seal and the `seq` rule are the whole
check (§13). **`index.yaml` in a git repo** — a Homebrew tap, `{ package,
version, digest, source, description }` per entry, listing by PR — stays
as the shape for a deployment's PRIVATE index, subscribed by `git+` ref.
Both are cached under `<dataDir>/packages/index/`, refreshed when a
record's timestamp moves. `search_packages` is `src/search.ts` — the
sidebar's matcher — over the union of every subscribed index's
publishers' catalogs, plus `GET /packages` on every peer on file (the fold
of §3: what that strut INSTALLED, an index of its own kind).

What an index can't carry is the **track record** — per digest, claims
supported / refuted and run counts on other struts. Federation §2.1's
read-through (not built) would give it, labelled *reported* and never
trusted as is: after install, the buyer's strut measures the same claims
itself (§3, step 4). A `StrutPackage` node and the graph's hybrid search
over listings are the later form, once there is a track record to hold.

## 8. The builder, and who may install

Builder tools (`src/ai/tools.ts`), each thin over the functions above:

- `list_packages`: the fold (§3).
- `search_packages({ query })`: the subscribed indexes' publishers'
  catalogs and the peers' folds (§7). The prompt says: before writing an
  integration, search what's installed, then the indexes.
- `install_package({ ref })`: fetches and verifies, then **asks**
  (`ask_user`, plans/elicitation.md) with the manifest summary: publisher
  (the prefix, the key that signed the catalog, and the index row that
  vouches for the pair, §13 — the key is pinned on accept, §3), digest,
  source, the items (which are code), the required packages it will
  install too, the secret names the code may read, the binaries and
  runtimes it needs with which are missing here (§11.2), and the license
  or that there is none (§1). A pin to a yanked release puts the yank's
  reason first (§13). Two more lines are READ OFF THE CLOSURE, since a
  package declares neither (2026-10-26, proposed):
  - **What can spend:** each workflow with an `agent` or `llm` step
    anywhere in its closure, or a closure that is not resolvable — the
    verify pass's presumed-paid test (`PAID_STEP_TYPES`,
    `src/verify.ts`). No budget is shipped: the run cap is the buyer's
    to set (`maxRunCostUsd`).
  - **What can act:** each step type in the closure that does not
    declare `effect: "read"`. This follows the host convention that an
    undeclared step counts as `write` (`StepDef.effect`, `src/core.ts`),
    so `exec`, `http`, `agent`, a package step that says nothing and an
    undeclared lib step all show. The control-flow steps, `llm`, `log`,
    `pack` and `wait` are left out.

  It installs only on accept, then `request_secret` for each missing name.
- `update_package({ package, ref? })`: §4, and it asks the same way
  (*ruled*), with the same two lines for what changed, and a yank of the
  installed release at its head.
- `export_package({ package, workflows?, apps?, to })`: §2 + §5.

**Installing is a person's act.** Installing a step is running someone
else's TypeScript in the server process — its module top level runs when
the registry rebuilds, before any workflow calls it, this world's npm
`postinstall` — so:

- `POST /packages/install { ref }` and
  `POST /packages/:publisher/:name/update` are behind the key at `full`
  scope; a peer can't install.
- The builder's tools install or update only after the user accepts in
  the same turn.
- There's no `meta/*` twin: an in-run agent can never pull code. That's
  the sealed surface's job (EVOLVE_SPEC §6), and installing joins what it
  refuses.
- The one door with no ask is a DISTRO's (§12, *ruled*): the operator's
  merge to the channel is the accept, and branch protection on the distro
  repo is the gate. On a fleet fed by its central strut, the accept is a
  person's publish there (§12.1, proposed). Still a person, still never an
  agent.

## 9. What this changes in `federation.md` §2.3

§2.3 (not built) planned one origin per workflow, `source: { repo, path }`,
multi-repo seeding, export as a PR, and **"no strut-to-strut copy"**. This
plan subsumes it:

- `source` becomes the version's `upstream`, which also says *what* it
  came with (the package, the digest) and whether it was edited since.
- Seeding from repos becomes installing from `git+` sources. Strut's own
  seeds (`job`, `orchestrator`, the browser workflows) stay seeds: a seed
  is strut's template and overwrites. The lab's seeding becomes a distro
  (§12), whose items follow §4 — a swarm's edit is never overwritten.
- Export is unchanged in mechanics, and writes a package.
- **The "no strut-to-strut copy" ruling is revised for PACKAGES** (*ruled*
  2026-10-18, widened 2026-10-24): a strut serves a package it built, by
  digest, on its archive route — openly for a public package, behind a
  token it minted when selling (§6) — or uploads it to a host that serves
  it when nothing can reach the strut (§13), and any strut that installed one may
  serve it as a MIRROR, since the digest is the identity and a catalog may
  list a mirror's URL (§13). The peer key is no longer the credential for a
  package read: the pointer is public (a Pkarr record), the bytes are open
  or token-gated.
  Git stays the hub for collaboration on a TEMPLATE under review — it
  travels as a PR, never as a copy — but it is no longer how a change
  travels between struts: a fork worth sharing is published as a package
  under the forker's prefix, and the original publisher re-points or not
  (§4). Read-through (§2.1) is still the only way one strut reads
  another's runs.

## 10. What not to do — and what the first draft did

| Not this | Because | The first draft had |
| --- | --- | --- |
| A dependency solver, or version ranges | Exact pins union; a disagreement is a refusal a person reads | Neither — kept |
| A package store | The items carry their provenance; the list is a fold | Same — kept |
| A generated line in the manifest | A tree hash pins every byte; a list of per-file hashes is a lockfile that drifts | `items:` with a sha256 per file, `requires.steps` |
| Ownership bound at install | Install order decided who owned a name: a package vendoring acme's step locked acme out of its own name | "Bound to the first upstream that installed it" |
| Another publisher's item inside a package | The consumer vendors; the published unit never does | A workflow package vendored its whole closure |
| A flat workflow name | Two publishers' `linear-sync` collide and the first wins — npm before scopes | `workflow: linear-sync` |
| An update that activates over a fork | A fork is the buyer's work | Same — kept |
| An update without a person | New code never runs on an accept given for other code | A silent fast-forward |
| An install from an agent | Installing joins what the sealed surface refuses | Same — kept |
| DRM, or a per-buyer signed manifest | A bought package is meant to be read and forked; a watermark contradicts that | Optional per-buyer signing |
| An index as a service | A list in a repo, or a peer's fold, is an index already; a node type waits for a track record | `StrutPackage` nodes on an index strut |
| Isolation in v1 | *Ruled*: in-process plus the secrets fence; a worker or container is a later piece that changes what a step can reach | Same, without the fence |
| A Dockerfile or compose fragment in a package | An install would become a build; a container is the deployment's. The package pins an image digest and names a runtime (§11) | Nothing — the question came up 2026-10-19 |
| A kit version in a package, or in an app's hash | The kit is the installing strut's and the build at install is the check; an app's identity is its directory, its document a derived artifact (`apps.md` §1.3) | Nothing — `apps.md`'s first draft put the kit in the version hash |
| A package that IS an app (`src/` at the root) | Two shapes for one thing; a package of zero or several apps is the common case, so an app is a folder like every kind (§1) | Nothing — considered 2026-10-20 |
| One DHT record per package | A Pkarr packet is ≤1000 bytes per key; a publisher with thirty packages does not fit. The record points at ONE catalog by hash (§13) | Nothing — the question came up 2026-10-24 |
| A laptop as the HOST of its own bytes, or the only keeper of its record | Nothing can reach into a home network, and a record expires in hours. The laptop holds the key and signs; its bytes go to a host it uploads to, and the relays and every strut that installed from it keep the record alive (§13, *revised 2026-10-24*) | The `peer:` source's "a desktop pulling from its cloud strut"; earlier on 2026-10-24, no publishing from a laptop at all |
| Plain HTTP with no pointer — the ref is the catalog's URL plus the key | The byte host becomes the pointer: it can serve an older, validly signed catalog that an installer cannot tell from current, and leaving it breaks every ref unless it forwards or the index row is edited. Putting the pointer on the index over HTTP fixes both, but leaves Stakwork as the one party that can withhold it. The Pkarr record keeps the pointer off the byte host and the index alike — the one thing it adds, and what a publisher with no address of its own needs (§13) | Nothing — weighed 2026-10-24 |
| A merge as what an update implies | Two versions side by side is the normal state of a fork; converging is asked for. Every registry with numbers pins and asks rather than auto-merging an approved copy — the MCP "rug pull" (`plans/p2p-distribution-research.md`) | §4's table had coexistence as the diverged row only |
| A new DHT or transport (Hyperswarm's HyperDHT, iroh's QUIC) | Strut already speaks HTTP by hash and a desktop pulls; what was missing was the POINTER, which Pkarr gives on the Mainline DHT that already exists. iroh's blob layer is mid-rewrite; Hyperswarm is a second DHT and a second key format (research Option C) | Nothing — chosen 2026-10-24 |
| A package list in the index | Every release would be an index edit; the index is a phone book of prefix → key, and each publisher's catalog is its own list (§7) | `index.yaml` with `{ package, version, digest }` rows as the public shape |
| A signed YAML catalog | YAML has no one byte form, so a verifier that parses and re-dumps changes the bytes: strut's `loadYaml` (js-yaml's default schema) turns `2026-10-26T17:02:00Z` into a `Date` that dumps as `…00.000Z`, and `1.10` dumps as `1.1`. "Signed" without the bytes, the place and the encoding is no check, and the index over HTTPS has nothing else. The catalog is a card: RFC 8785 JSON sealed over its fingerprint (§13) | §13 on 2026-10-24: "a signed YAML file", its signature never defined |

## 11. Environments — what a package needs but never carries

A package is what strut publishes into its workspace: files, each with a
publisher and a version record. Everything its steps need that strut does
not publish — a binary, a service, a container — is **declared in
`requires` and provided by the deployment**. That is already the rule for
the host (AGENTS.md "Shell": *environment ≠ step; what's on PATH is the
deployment's business*, and ENV_SPEC's `external`), and a specialized
container is the same rule one process space over. Three kinds; only the
third needs anything new:

| The steps need | Example | Declared as | Reached through | Provided by |
| --- | --- | --- | --- | --- |
| A binary on PATH | `ffmpeg`, `yt-dlp` | `requires.binaries` — ENV_SPEC §9's workflow-level `requires`, folded over the package's items | `exec`, `ctx.services.shell` | ENV_SPEC's manifest (`env_add`), the image, the host |
| A service over the network | another team's browser grid; a vector DB; a Neo4j | `requires.secrets` — its URL and token are secrets by NAME, like any credential | `ctx.services.http`; or a service object strut has (`ctx.services.browser` for anything that speaks Playwright's protocol) | the deployment: a compose service, a SaaS, whatever answers the URL |
| A shell that is not the host's | a Kali box; a toolchain image; a GPU container | `requires.runtimes` (below) | `exec { runtime }`, `agent { runtime }` → `ctx.services.shell` | a named **runtime** the deployment configures |

**Not a fourth folder.** A folder is an item: a file strut publishes, with
a publisher, a version record and an `upstream` the fold reads. An image is
built and hosted elsewhere, pulled by a container engine, and bound to a
platform — strut has no publisher for it, and a `Dockerfile` or compose
fragment in a package would make an install a *build* (root, minutes, a
network, a platform), which ENV_SPEC §2 refuses for the host environment
already: the engine image carries `pixi` and `uv`, and everything a
deployment learns it needs lives on the volume. So a package **pins** an
image the way it pins a package — an exact digest, OCI's own — and ships
nothing to build. Same digest model, same refusal on disagreement (§1).
That is also the answer to "more OCI": OCI *images* are how an environment
is named (here); OCI *registries* as a transport for strut packages stay
what §5 says, a fourth resolver and nothing else.

**The other team's browser is a service, and needs nothing designed.** If
their setup speaks Playwright's protocol, `BROWSER_WS_URL` points at it and
strut's `browser/*` steps drive it unchanged (`BrowserService.fromEnv`,
`src/browser/service.ts:268`). If it doesn't, their steps drive it through
`ctx.services.http` with a URL and a token from `requires.secrets`, and
ship as a package — `theirteam/browser/*` — whose Concept says what it is
for. The container is theirs either way. `images/browser` is special only
because strut's own service object knows Playwright; it is not a kind of
thing a package ships.

### 11.1 Runtimes — a named place a command runs

A **runtime** is where `ctx.services.shell` spawns. The host is one (name
`host`, always present, ENV_SPEC's prefix on its PATH); every other is
deployment configuration, never a package's — `STRUT_RUNTIMES` (JSON) or
`createStrut({ runtimes })`, two shapes:

```json
{
  "kali":  { "url": "ws://kali:3000", "path": "<secret>" },
  "cuda":  { "exec": ["ssh", "strut@gpu-box"] }
}
```

- **`url` + `path`: an exec server** — `images/exec`, the twin of
  `images/browser`: one small server (a static binary, so one `COPY
  --from` line adds it to any base image — `FROM kalilinux/kali-rolling`
  and nothing else) that takes a `ProcessRequest` and answers a
  `ProcessResult` (`src/shell.ts:145`, `:171`) over a websocket on a
  secret path, non-root, on a network of its own that strut joins. Because
  it runs `runProcess`'s contract *inside* the container — stdin, the
  per-stream caps, the timeout, the process-group kill, `onLeftover` — the
  `exec` step and the agent's `bash` behave in a runtime exactly as on the
  host, and strut holds no docker socket (root on the host) and no SSH
  key. The browser image's trust shape, for a shell.
- **`exec`: a command prefix** — the escape hatch for what a deployment
  already has: `docker exec -i -w {cwd} strut-kali`, `podman exec`,
  `ssh strut@box`, `kubectl exec -i`, `nsenter`. Strut spawns the prefix
  on the host with the request's `cmd` and `args` appended, `{cwd}`
  substituted; `runProcess`'s contract then holds for the prefix process
  only — a kill ends `docker exec`, not necessarily what it started, and
  the request's `env` crosses only if the prefix forwards it (`env:
  ["-e", "{name}={value}"]`, a fragment repeated per variable, is the one
  concession). Right for a desktop with Docker Desktop, where the person
  owns the machine; the server image carries no docker CLI.

**One tree, mounted at one path.** `cwd` is a path in the run's artifact
directory or the job's (`exec`, `src/steps/core/exec.ts:141`), and the
runtime must see it at the *same* path: the deployment mounts `dataDir`
(the compose file's `strut-workspace` volume) into the runtime container
where strut has it. Then the agent's file tools, `repo_overview` and
`fulltext_search` stay on the host and its `bash` runs in the runtime,
over one set of files, and `{{ dir.path }}` means the same thing on both
sides. A runtime where `cwd` does not exist fails the call naming the
path and the runtime, before anything runs.

**What changes in code.** `ShellRequest` gains `runtime?: string`
(`src/capabilities.ts:337`); the standard bag's `shell` dispatches by it,
and a name that is not configured fails the call naming the runtimes that
are. `exec` and `agent` gain a `runtime` config field (an `agent`'s `bash`
tool goes through it; its other tools do not), and a custom step wrapping
a CLI passes it through. It is config, so `step.start` records it and a
check runs where its config says. `GET /health` lists the configured
runtimes by name. Nothing else: no lifecycle, no pulls, no builds.

### 11.2 The declaration

```yaml
requires:
  secrets: [SHODAN_API_KEY]
  binaries: [nmap]                   # on the host, or in a runtime named below
  runtimes:
    - name: kali                     # what the steps say: `exec { runtime: kali }`
      image: docker.io/kalilinux/kali-rolling@sha256:…   # the publisher's suggestion; strut pulls nothing
      binaries: [nmap, nikto, sqlmap]  # checked THROUGH the runtime at install, reported
```

- `name` is the package's word for it and the deployment's: a deployment
  that calls its Kali box `pentest` configures `kali` as an alias, as it
  would map any name. No registry of runtime names; a collision between
  two packages wanting different things under one name is the
  deployment's to resolve by configuring two.
- `image` is a digest-pinned suggestion of what to build the runtime
  from. Strut never pulls or runs it (v1); it is what the install ask
  shows, and what a deployment copies into its compose file. A
  deployment may run something else under that name — the install checks
  `binaries` through the runtime (`which`, one call), not the image.
- At install, a runtime that is not configured, or a binary a runtime
  lacks, is **reported, not refused** — the rule §3 already applies to
  secrets and host binaries. The builder's ask lists it with the image;
  the fix is the deployment's (a compose service, a Docker Desktop
  container), and there is **no `runtime_add` tool**: a container is the
  deployment's, as ENV_SPEC's `external` is, and as `env_add` can add a
  package but never a channel.

### 11.3 What this is not

- **Not isolation for installed code.** A runtime is where a *command*
  runs; the package's steps still run in strut's process, with the secrets
  fence (§3) and nothing more. Open question 1 stands.
- **Not a per-run or per-job container.** A v1 runtime is long-running
  and deployment-owned, shared by every run, the browser server's shape.
  A fresh container per job — a Kali box that is this job's, a pod — is a
  lifecycle: `runtime/start` would hold it on the job (`jobs.md` §6,
  `ctx.services.jobs.hold`) and `runtime/stop` release it, and the pinned
  `image` would then be what strut pulls. That is the lab's `pod/*` today
  (a host-owned pool, `plans/pod-config.md`), and a strut-owned form is a
  later plan.
- **Not a sandbox.** What the runtime's container can reach on the
  network, a command in it can — the compose file puts it on a network of
  its own for that reason, as it does the browser.

## 12. Distros — an operator's packages on its own fleet

> *Proposed* 2026-10-19. Everything above is a person installing someone
> else's package. A **distro** is the other use of the same format: an
> operator rolling ITS OWN packages out to a fleet of struts it runs —
> every swarm's strut, today fed by the mcp lab's boot seeders. *Ruled
> by the owner:* the fleet rollout is automatic, and the lab's names move
> under package prefixes (`pod/claim` → `hive/pod/claim`). What a distro
> changes in the sections above is written there, in place: §2 step 6
> (sealed items), §3 (uninstall keeps runs), §8 (the no-ask door), §9
> (the lab's seeding). Reviewed 2026-10-19 (the renames rule, the
> seed-to-package bridge, the trial load, `gitsee`).

**What it replaces.** The lab (`mcp/src/lab`) is four layers: files
(about 100 steps, 40 workflows and 20 Concepts in 15 directories, each
with its own `seed.ts`, plus `SEED_OPTS`, the `RETIRED_*` lists,
`MOVED_TO_STRUT` and `anchorConcepts`); the host's delta on strut's
seeded workflows (`JOB_SEED`, `ORCHESTRATOR_SEED`); in-process services
(`concepts`, `gitsee`, `harvey`, `gaia`, `optimizer`); and host glue (the
Express bridge, JWT → actor and scope, the gitree proxies, the Mothership,
the stores pinned to disk). A distro takes the first two. The services
are ported to strut's own (below); the glue is what is left of an
embedding host, and with nothing else in it, a swarm can run the
published strut image on its own instead. That ends mcp's git pin on
strut and the "bump strut to X" PR on every strut change, the
one-copy-per-process peer trap (AGENTS.md), and the tsx loader mcp needs
for workspace steps.

**A distro is a git repo:**

```
distro.yaml
packages/hive/pod/strut.yaml          # package hive/pod → hive/pod/claim, hive/pod/release, …
packages/hive/pod/steps/claim.ts
packages/hive/code/workflows/change-pr.yaml
packages/stakwork/gaia/…
```

```yaml
# distro.yaml
distro: stakwork/hive
packages:                              # every package a strut on this distro holds, at exact digests
  - { package: hive/pod,  digest: "sha256:…", source: "file:packages/hive/pod" }
  - { package: hive/code, digest: "sha256:…", source: "file:packages/hive/code" }
  - { package: acme/linear, digest: "sha256:…", source: "git+https://github.com/acme/linear@v1.4.0" }
host:                                  # STRUT_HOST_CONFIG's shape (src/server.ts:39), now versioned with the packages
  job: { tools: ["hive/pod/*"], system: "…" }
  orchestrator: { tools: [], approve: [], system: "…" }
renames:                               # old name → new, for the migration (below)
  pod/claim: hive/pod/claim
  pod/release: hive/pod/release
```

- **Packages are the §1 format, unchanged.** A `file:` source resolves
  relative to the distro repo, so most packages live in it; a `git+` one
  is a package the operator chose from elsewhere, pinned the same way.
  The digest is in `distro.yaml` because the pinner computes it (§1);
  CI on the distro repo recomputes every `file:` digest and fails a
  commit whose line is stale, so a hand edit to a step cannot ship
  without its pin.
- **`host:` moves the delta into the distro.** It is what
  `createStrut({ job, orchestrator, automation })` takes and
  `STRUT_HOST_CONFIG` reads today; in the distro it changes in the same
  commit as the grants it names (`hive/pod/*` on the job agent), and
  `templateWithDelta` (`src/job-seed.ts:69`) applies it as before. A poll
  that changes `job` or `orchestrator` reseeds them live (the seeders are
  callable); `automation` is wired at construction and takes effect at
  the next boot, which `GET /distro` says.
- **Nothing else.** No secrets, no automations, no owners, no per-swarm
  values: what differs between swarms is their env and their workspace,
  never a distro per swarm.

**Rollout — automatic, by channel.** A strut names one distro and one
ref: `STRUT_DISTRO=git+https://github.com/stakwork/hive-distro@stable`
(or `createStrut({ distro })`). A **channel is a branch** of the distro
repo: `stable`, `canary`, whatever the operator keeps. A tag pins a
swarm; a branch makes it follow.

1. **At boot**, strut resolves the ref through the `git+` resolver (§5),
   verifies every digest, and installs: `installPackage` per package,
   with a new door, `VersionSource: "distro"`, and **no ask**. The
   operator's commit to the channel is the accept — whoever can merge to
   `stable` can run code on every swarm, which is who can merge to
   stakgraph today; branch protection is the gate. Then `host:` is
   applied, then the registry is built, as seeding does now.
2. **While it runs**, strut re-resolves the ref every
   `STRUT_DISTRO_POLL_MINUTES` (default 10; `0` = boot only), and on a new
   commit applies it live: the same install, then `rebuildRegistry()`.
   No restart, so no run is cut off. `POST /distro/sync` (keyed, `full`
   scope; hive can call it after a merge) does the same now. A run in
   flight keeps the step defs it was launched with; the next run gets
   the new ones.
3. **Rollback is a revert** on the channel, which the next poll applies
   like any other commit — every item goes back to the content it had,
   which its records already hold, so nothing is fetched twice.
4. **One update rule for an item, §4's:** untouched → fast-forward;
   edited on this swarm → the new version published beside it, the edit
   left active, and reported. A swarm's own work is never overwritten by
   the fleet; the builder rebases it on request. This is a change from
   seeding, where a changed template activates over an edit
   (`SEED_OPTS`); it is the reason to accept the change. The one
   exception is strut's own seeds: a `host:` change reseeds `job` and
   `orchestrator` through `templateWithDelta`, and a changed template
   activates over a swarm's edit of them, as §9 says a seed does.
   **The fence (§3 step 5) holds for a distro's steps too:** a lab step
   reads only what its package's `requires.secrets` names, so an
   under-declared package fails on the first swarm with the name. That
   is what the `canary` channel is for: the migration lands each package
   on `canary` and runs its claims there before `stable` sees it.
5. **Removal:** a package or item the new commit no longer lists is
   uninstalled the §3 way — deleted only if untouched, a fork kept and
   reported. That retires the `RETIRED_STEPS` / `RETIRED_WORKFLOWS` lists:
   the distro's diff IS the list.
6. **What it can't apply, it refuses whole.** A digest that does not
   match, a `package_conflict:`, a step that fails to load — the commit
   is not applied, the swarm keeps the last one it applied, and says so
   (below). An install is all or nothing per commit, not per package.
   The load check runs BEFORE the first write: every step file of the
   commit is materialized to a scratch directory and imported there (the
   pin loader's own path, `materializeStepVersion`, so nothing new), and
   one that throws at module top level refuses the commit, naming it.
   The same trial load belongs to §3's install, where a person's accept
   should not be followed by a registry that will not build.
7. **At boot, offline is not an error.** A ref that cannot be resolved at
   boot (no network, a bad token) leaves the workspace as the last
   applied commit left it — the items are already published — and strut
   boots on them, with the failure on `GET /distro`. The `git+` resolver's
   credential is `GITHUB_TOKEN` through the secrets capability: on a
   first boot that means env, later boots read the store on the volume.

**The fleet's view.** `GET /distro` (keyed) on each strut: the distro,
the ref, the commit applied and when, the last poll and its error if
any, and every item `diverged` (edited here, the new version waiting)
— the §3 fold, filtered. Hive already holds every swarm's key and can
show the fleet as one table: which swarms are on which commit of which
channel, which are stuck, which have local edits. No new service; the
struts are the source.

**Sealed items ship (§2 step 6).** A package may carry items
marked `sealed: true` — a grader step (`defineStep({ sealed: true })`) or
a grading harness (the workflow's top-level key). The install keeps the
mark; `sealedInClosure` (`src/sealed.ts:55`) refuses every candidate
that reaches one, as it does for a seeded grader; the meta surface's
publisher rule (`requirePublisher: "ai"`, `src/authoring.ts:664`) already
keeps it from editing a step it did not author. Holding a grader in a
package adds what the lab pins by hand: the digest is the grader's
exact bytes, so a check's evidence records `upstream.digest` in place of
`SCORER_SHA256` / `benchmarkRev`, and a person's edit to a grader shows
as `modified` beside every score it produced. Not changed: gold answers
are data the step fetches at first use (GAIA's terms forbid shipping
them), and an agent with `bash` on the same server can read files on its
disk, as with `GAIA_DIR` today — open question 1. This applies to any
package, not only a distro's; it is here because harvey and gaia are the
first to need it.

**Renames — the lab's names move under prefixes.** §1's rule (an item is
`<package>/<path>`) gives every lab item a new name: `pod/claim` →
`hive/pod/claim`, `jarvis/*` → `hive/jarvis/*`, `code-change-pr` →
`hive/code/change-pr`, `explore` → `hive/explore/explore`. What refers to
the old names and cannot be edited in the same commit:

| Holds an old name | Example | Handled by |
| --- | --- | --- |
| Hive, and peers' `strut/run-workflow` calls | `workflow: "explore"`, `code-change-pr` | `renames`: a launch by an old workflow name runs the new one |
| A hold on a job already on file | `release: { type: "pod/release" }` (`pod/claim`) | `renames`: `releaseWith` (`src/jobs.ts:392`) resolves the old type to the new |
| A workflow a person wrote on a swarm | `type: pod/claim` in their YAML | `renames`: `resolveStep` resolves it, and the builder is told the new name in the result |
| Concept pages, the `job` prompt's grants | `Pod` names `pod/claim`; `tools: ["pod/*"]` | edited in the same distro commit |
| Old runs, evidence, stats | `workflows/code-change-pr/runs/` | nothing — history keeps the name it ran under |

`renames` is a map from the distro alone (no other door writes one),
consulted at exactly those lookups — `resolveStep`, the launch route's
workflow lookup, `releaseWith`, and `flowClosure`'s registry check
(`src/closure.ts:126`, so a person's workflow naming `pod/claim` still
resolves, and a publish reaching a sealed item through an old name is
still refused) — and only when the old name does not exist. **The event
log records the NEW name:** `step.start.stepType` is what the step
resolved to, never the YAML's spelling (today it is `s.type` as written,
`src/runner.ts:517`), so stats, claims, verify and the palette see one
name for one step. A GLOB is not renamed: `agentTools: ["pod/*"]`
expands against the registry and matches nothing after the move
(`expandAgentTools` already warns on that); the two seeds' grants change
in the distro commit, and a person's workflow gets the warning with the
new prefix named at its next validate or publish. An entry is dropped from the map once nothing calls the
old name — hive's callers moved, no hold names it — which `GET /distro`
helps tell by counting the lookups each entry served (an in-process
count, reset by a restart — a hint, not a record). An old name's
items are uninstalled by the commit that installs the new ones,
untouched or not — a renamed item is the same item, so an edit on a
swarm moves with it: it is published under the new name as a local
version upstreamed to the package, and reported diverged.

**The bridge from seeds.** The first distro commit meets items no package
installed: the lab's seeds, with no `upstream`. The §4 table needs a
previous install's hash to tell untouched from forked; here the version's
`source` tells it — an old name whose ACTIVE version is a `seed` version
is untouched (uninstalled, the new name installed), any other source
(`ui`, `builder`, `api`) is a fork and moves as above. That is the whole
bridge; it applies to any entry in `renames` whose old name has no
`upstream`. Ordering with mcp: the mcp build that stops seeding a
directory (its `seed.ts` deleted, `STRUT_DISTRO` set) deploys BEFORE the
distro commit that renames its items — the other order has the seeder
publishing `pod/claim` again on its next boot, beside `hive/pod/claim`.
Between the two deploys the old names stay and nothing breaks.

**The first distro app** (2026-10-20). Hive's OpenHealth UI — ~6.6k lines
keyed on one workflow's internals, `apps.md`'s opening problem — becomes
`apps/climb/` in a `stakwork/openhealth` package, beside the four
workflows it drives, so hive#5573's `BENCHMARK_RUN_VIEWS` escape hatch
goes and a benchmark's UI ships with its workflows in the same channel
commit. Hive renders it through the `apps.md` §7.4 contract and changes
nothing per benchmark after that. The components hive's apps share — the
escalation badge every tracker wants, the score tile every benchmark
wants — are `apps/ui/` in the same distro, a kit (`apps.md` §3.4), which
each app imports as `hive/ui`.

**The services are ported, not packaged.** A package cannot carry a live
object, and a distro does not try. Per lab service:

| Service | Becomes |
| --- | --- |
| `gaia`, `harvey` (sealed graders running a pinned Python scorer) | Sealed steps over `ctx.services.shell` + `secrets` (`HF_TOKEN`), the dataset cloned at first use — a `stakwork/gaia` package, a `stakwork/harvey` one |
| `optimizer` (the evolve loop runs child workflows) | The launch `meta/run-workflow` already uses, on the step's context |
| `gitsee` (a per-run browser and booted stack) | `ctx.services.browser` for the browser; the booted stack is a per-run container, which §11 does NOT give (a v1 runtime is long-running and the deployment's) — it waits on open question 4, or stays a hold on the job the host's pool provides |
| `concepts` (storage, LLM, clone, summarizer over mcp's aieo and `repo/*`) | The gitree → workflows rollout: `graph/*`, `git/checkout`, `agent`. The last to go |

Until a service is ported, its packages need a host that provides it,
and the distro and an embedding host compose: mcp passes
`createStrut({ distro, services })`, the distro brings the files, mcp
brings what is not ported yet. A package states the service it needs as
it states a binary — reported at install, not refused (§3) — so a swarm
without mcp installs it and its steps fail naming the service.

**Migration order.** Each step ships alone and leaves every swarm working:

1. **The distro mechanism**, in strut: `STRUT_DISTRO`, `distro.yaml`,
   the boot install with no ask, the poll, `POST /distro/sync`,
   `GET /distro`, `renames`. Needs §"Step order" 1–2 (provenance,
   nested names, the install) and the `git+` resolver from 3.
2. **Sealed items in a package** (above): a test that a candidate
   reaching an installed grader is refused.
3. **The lab's files move**, one package per lab directory, starting
   with those that use only strut's services: `code`, `job`'s Concepts,
   `janitor`, `explore`, `pods`, `pod-setup`, `jarvis`, `eval`,
   `wfbench`, `artifacts`. Per directory, mcp deploys first (its
   `seed.ts` deleted, `STRUT_DISTRO` set), then the distro commit lands
   (the bridge above); `JOB_SEED` and `ORCHESTRATOR_SEED` move to
   `host:`. Hive's callers move to the new names behind `renames`.
4. **The services**, per the table: `gaia` and `harvey`, then
   `optimizer`, `gitsee`, `concepts`.
5. **Strut leaves mcp.** With nothing but glue left, a swarm runs the
   published strut image beside mcp, on the same Neo4j: `STRUT_API_KEY`
   and `STRUT_PEER_KEY` for what `labAuth` and the `lab:peer` JWT do,
   `x-strut-actor` from hive as today. mcp's `/lab` mount and its gitree
   proxies go when hive calls strut directly.

**Not in a distro:** a solver or ranges (pins, as §1); per-swarm
packages (a swarm that needs a package the channel lacks installs it
through §8, by a person, and the distro leaves it alone — it is not
the distro's item, and the inverse holds: `update_package` and
`DELETE /packages/…` on an item whose `upstream.source` is `distro`
are refused, naming the channel that owns it); a push from hive to a swarm (each strut pulls,
which works behind NAT and needs no route back, federation's reasoning
for the tail); a staged percentage rollout inside one channel (two
channels are the stage).

### 12.1 A fleet fed by its central strut

> *Proposed* 2026-10-27, not ruled. In hive, each org has a central strut
> (the default workspace's swarm), and its agents run workflows on the
> org's other workspace struts through `strut/run-workflow` (federation
> §2.2). Today those workflows reach every swarm because each swarm's mcp
> seeds them from the stakgraph repo, so a change ships as a stakgraph PR
> and a deploy of every swarm. Here the central strut is the source: it
> publishes, and every workspace strut follows. This is §12's rollout and
> §13's card with the Pkarr record left out; only where the channel comes
> from changes.

**The child trusts a key, not a connection.** The central strut is a
publisher (§13): it has a key (`publisher.json`) and a catalog card that
lists its releases. A child SUBSCRIBES to that key. It installs what a
card sealed by that key names, at the digests the card names, whatever
served the bytes. So the connection carries no authority, and the child
holds no credential that lets it do anything on the central strut. The
pointer is the central strut's own catalog route. §13 needs a record so
that neither the byte host nor Stakwork controls the pointer; on a fleet
the publisher is the operator, so that concern does not arise. The seal
and the `seq` rule are the whole check, as for the index catalog over
HTTPS (§7).

**A private catalog.** An org's workflows are not public, so this catalog
is never put in the DHT, and its route stays behind the gate. A child
reads it with a READ TOKEN: §6's package token, scoped to one catalog
instead of one package. It is an HMAC over
`catalog:<key>:<subscriber>:<exp>` under the central strut's secret, the
way the file token is made (`src/auth.ts`). It opens `GET
/packages/catalog` and the archive route for the digests that catalog
names. It opens nothing else: no runs, no workflows, no launch. Leaked,
it is worth the org's packages, which every child holds anyway. The child
sends it only to the subscription's own origin, never to another URL a
release lists.

**The path of an update:**

1. **Edit on the central strut.** The builder or a person changes
   `hive/fleet/explore` there. That is a local version; nothing leaves.
2. **Publish.** A person (the UI, or hive) calls `POST /packages/publish
   { package, version, channel? }`. It runs `buildPackage`, adds the
   release to the card (newest first, earlier ones kept), moves
   `channels[channel]` to it when a channel is named, moves `seq` forward
   and seals the card. This is §13's publish with `host: self`, and like
   it, a person's act: the builder edits and never publishes (§8).
3. **Tell the children.** The central strut POSTs
   `/packages/subscriptions/<id>/sync` to each peer on file, best effort.
   That route is open to `peer` scope because the ping carries nothing:
   it makes the child read its own subscription's URL, which it would do
   on its next poll anyway. One sync runs at a time per subscription; a
   ping during one queues a single re-run.
4. **The child applies.** On a ping, at boot, and every
   `STRUT_DISTRO_POLL_MINUTES` (§12's setting, default 10), the child:
   - fetches the card and runs every check of §13 against the subscribed
     key;
   - takes each package's digest from the channel (or, with no channel,
     the newest release not yanked);
   - fetches each archive with `fetchArchive` from the release's `urls`,
     with the token;
   - installs the whole set through `installPackage`, door `distro`, no
     ask, all or nothing per `seq`.

   Per item it follows §4's table:
   - untouched → fast-forward;
   - edited on the child → the new version lands beside it, the edit
     stays active, and the item is reported;
   - a package or item the channel no longer lists → retired if
     untouched.

   Then the registry rebuilds.
5. **What it can't apply, it refuses whole** (§12 step 6): a step type
   this strut lacks, a conflict, a step that does not load. The child
   stays on the last `seq` it applied and says why.
6. **Rollback is a later card.** Yank the bad release (the channel falls
   back to the newest release not yanked) or move the channel back.
   Either is a new `seq`, so the children apply it like any other.

**Versions.** The digest is a release's identity, `version:` its label,
and `seq` the order of the catalog's states. On a child, each item's
`upstream` names the release it came from: `source.ref` is
`subscription:<id>`, and `key` is the subscribed key (§3's pin). A
child's `vN` labels are its own. `update_package` and `DELETE
/packages/…` on such an item are refused, naming the subscription, as for
a distro's item (§12).

**`channels`** is a member of the card: `channels: { stable: {
"hive/fleet": "sha256:…" }, canary: { … } }`, each naming a release the
catalog lists. A subscription with no channel takes the newest release
not yanked.

**The subscription** is the operator's act: a full-scope write on the
child, `PUT /packages/subscriptions/:id { key, url, channel?, token }`.
It is kept in an encrypted file beside `peers.json`
(`subscriptions.json`), since the token is a credential.
`STRUT_PACKAGE_SUBSCRIPTIONS` is the paste door for a strut nobody pushes
to. Hive's `strut-peers` cron already writes `/self` on every workspace
swarm with that swarm's own key. The same pass would:
- read the central strut's public key from `GET /publisher`;
- mint a token there (`POST /publisher/tokens { subscriber, days? }`,
  full scope, `POST /peers/tokens`'s twin, re-minted each pass as the
  `lab:peer` tokens are);
- write each child's subscription.

The child never learns the key from a card or a peer. If the central
strut mints a new key, a child follows it only once the operator writes
it.

**What the fleet sees.** `GET /packages/subscriptions` on a child shows,
per subscription: the `seq` applied and when, each package's digest and
version, every item `diverged`, and the last error. The central strut can
read it over its peer record (a peer reads every GET). So its agent can
check what a workspace runs before calling a workflow there, and hive
can draw the fleet as one table (§12, "The fleet's view").

**A child's edit stops that item following.** An edit of
`hive/fleet/explore` on a child is a fork (§4): the next release lands
beside it, and that workspace keeps running its own version until the
builder merges. That is §12's rule. A fleet where the central strut must
win everywhere wants a seed, which this is not.

**What it reuses, and what is new.**
- **Reused:** the card and its checks (§13), the update table (§4), the
  distro door with no ask (§12), `fetchArchive` and the archive route
  (both built), and the file token's HMAC (`src/auth.ts`).
- **New in strut:**
  - the publisher key and the card with `host: self` and no record
    (step 6's first half);
  - `channels`;
  - `POST /packages/publish`;
  - the read token (step 8's, narrowed to a catalog);
  - subscriptions and the sync ping.
- **New in mcp:** `labAuth` hands a `?t=` on `/packages/catalog` and
  `/packages/*/archive` through to strut, as it already does for
  `/artifacts` and `/jobs/:id/files` (`mcp/src/lab/mount.ts`).
- **New in hive:** the subscription in the `strut-peers` pass.
- **Later, with no change to a child:** a `pk:` record for the key, so
  `url` becomes optional.

**Considered: the central strut pushes.** It already holds a credential
for every child (hive's `lab:peer` records), and a sealed card is safe to
accept from any sender. So a child could take the card and the archives
through an inbound door and hold nothing at all. Not chosen, for three
reasons:
- it adds a new inbound door on every strut;
- the central strut would have to track its children on every release;
- a strut it cannot reach, such as Peel behind NAT, would get nothing.

A pull with the read token covers both cases, and it is what §12 already
says ("each strut pulls").

**Before the first release: the lab's steps must read as seeds.**
`buildPackage` records a seed's item nowhere (step 2, "a seed's item
outside the prefix"). But a lab step published before step versions
recorded their door (strut#340) has no `source`. A seeder publishing the
same content again changes nothing (`reactivateKnown: false`), so a fleet
workflow that uses `jarvis/*` or `pod/*` is refused as if those steps
were local. The fix is strut's: a publish of content equal to a version
whose record names no door records the door this publish names. The next
boot of every swarm then stamps the lab's steps.

**Not designed here:**
- the distro's `host:` delta and `renames` (§12) riding in the card;
- revoking one subscriber before its token expires;
- whether §12's git distro becomes one more kind of subscription, so a
  strut has one list (`GET /distro` and `GET /packages/subscriptions`
  today) and one sync route. A strut may hold several subscriptions
  (Peel following two orgs), where §12 gives it one distro.

## 13. Pkarr — keys, records, catalogs

*Ruled 2026-10-24:* the protocol, publishing (from a swarm, revised the
same day to any strut, with its bytes on a host it uploads to), the
public index. The shapes below are mine, proposed. The research behind the
choice is `plans/p2p-distribution-research.md` (Options B, C and F, and
the Pkarr design documents it cites).

**One shape, two levels: a key points at a catalog by hash, a catalog
points at bytes by hash.**

- **A publisher is an Ed25519 key.** Minted once per publishing strut (the
  first `publish_package`, or `POST /publisher`), kept in the encrypted
  store beside `peers.json` — `publisher.json`: the secret key, the z32
  public key, the prefixes it publishes under, and its byte host (below).
  Minting is refused while the secret store runs on the dev default
  (`STRUT_SECRET_KEY` unset, `src/secret-store.ts`): that file is only
  obfuscated, and a laptop checkout is where the default is most likely.
  The public key is the publisher's identity between struts; `acme` is
  what people call it, and the index catalog binds the two (§7).
- **The record** is the key's one Pkarr packet: a signed, compressed DNS
  packet under 1000 bytes, a microsecond timestamp as its sequence number,
  put into the Mainline DHT as a BEP 44 mutable item. Strut writes one TXT
  record, `_strut.<key>`: `v=1 catalog=sha256:… url=https://… url=https://…`
  — the hash of the publisher's catalog and where to fetch it. Nothing else
  rides in the packet; a package name never does.
- **The catalog** is a signed JSON file — a CARD, defined below —
  content-addressed, served by the publisher's byte host like any archive
  (`GET /packages/catalog?digest=…` on a strut, an uploaded file
  elsewhere; the record's `url`s): `v`, `key`, `seq`, `publisher`, and
  `packages: { "acme/linear": { description, releases: [{ version,
  digest, urls, license?, requires?, yanked? }, …] } … }` — every package
  the strut BUILT (§2), each with its releases newest first and the
  earlier ones kept, so an installed digest stays fetchable after a new one
  is published (the left-pad rule, publisher side). It is `GET
  /packages`'s twin: that route folds what a strut INSTALLED (§3); the
  catalog lists what it PUBLISHED. The index catalog (§7) is the same card
  one level up — `publishers:` where this has `packages:`.
- **Resolve** (`pk:` in §5; an index name in §7): record → catalog digest
  + URLs → catalog fetched from the first URL that answers and checked as
  a card (below): its digest against the record's, its seal against the
  key, its `seq` against the last catalog accepted from that key → the
  package's newest release not yanked, or the one the ref pins → archive
  fetched by digest from its `urls` → `installPackage`. Every fetch is by
  hash, so any URL that serves the bytes is as good as the publisher's: a
  mirror is a strut that installed the package and lists its own archive
  route (§9).
- **Publish** (`publish_package`, on any strut, a person's act like
  install): `buildPackage` → the archive under `<dataDir>/packages/<digest>/`
  → the catalog rewritten, its `seq` moved forward and sealed (below) →
  both put where the byte host serves them (nothing to do on a strut that
  serves its own archive route; an upload otherwise) → the record
  re-signed with a new timestamp, naming the catalog's digest and its URLs
  on the byte host, and PUT to the relays. One command, every write
  outbound, nothing to run afterwards but the re-put.

**The catalog is a card** (2026-10-26, proposed). The card form is the
Graph Protocol group draft's (the 2026-10-24 thread): RFC 8785 JSON,
SHA-256, Ed25519. The domain prefix is an addition of mine, not in the
draft. §13's first draft called the catalog "a signed YAML file" and
defined neither the bytes signed nor where the signature sits; YAML has
no one byte form (§10).

| Part | Rule |
| --- | --- |
| Bytes | A JSON object written in its RFC 8785 form (JCS: members sorted, no whitespace, ECMAScript number and string forms), `sig` included. That is the only byte form: a reader parses the file, writes it back the same way and refuses a file that differs (`catalog_noncanonical:`), so no host can serve two byte forms of one catalog |
| Digest | `sha256:<hex>` over the served bytes, as an archive's (§1). It is what the record's `catalog=` names and what `GET /packages/catalog?digest=` serves by, so a byte host or a mirror checks a file without reading JSON |
| Fingerprint | `sha256:<hex>` over the RFC 8785 form of the object WITHOUT its `sig` member. This, not the digest, is what is signed: a hash of bytes cannot be signed inside those bytes |
| Seal | `sig`: the Ed25519 signature (RFC 8032), lowercase hex, by the publisher key over the UTF-8 bytes `strut-catalog\n` followed by the fingerprint as written (`sha256:` and 64 hex). The prefix keeps the signature from passing as anything else the key signs: its Pkarr record, an index catalog (`strut-index\n`), a later kind of card |
| Key | Checked against the key the reader EXPECTED — the one a `pk:` ref names, the index row's, the subscription's for an index catalog (§7) — never taken from the file. A file whose `key` differs is refused before its seal is checked |
| Version | `v: 1`. A member the reader does not know is ignored, and the seal still covers it; a change of meaning is a new `v`, which a reader refuses, naming both (`catalog_version:`) |
| Order | `seq` is the signing time in microseconds since the epoch, the clock Pkarr uses for the record, so a key restored onto another machine needs no counter. A publish takes `max(now, previous seq + 1)` (the previous catalog is the base of the new one anyway). A reader keeps, per key, the last catalog it accepted (under `<dataDir>/packages/index/`, §7) and refuses a lower `seq` (`catalog_rollback:`, keeping the one it has) or a different digest at the same `seq` (`catalog_conflict:` — one key sealing two catalogs at once is a misused or stolen key; it is reported, never picked between) |

**Which check guards which path.** On a `pk:` resolve, the record, signed
by Pkarr itself, names the digest, so a catalog that matches it is already
the key's word. The seal and `seq` are what hold when no record names the
catalog. That covers the index catalog over plain HTTPS (§7, a shipped
default that exists for a strut that reaches no relay), a catalog read
from a mirror or a cache while its record has lapsed, and a host serving
an older catalog it was once given. Every reader runs every check on every
catalog, whichever way it came, so no path skips one.

**Yanking** (2026-10-26, proposed; cargo's `yank`). `yanked: "<reason>"`
on a release withdraws a digest without deleting it:
- it stays fetchable (the left-pad rule);
- a floating `pk:` ref and a new install by name take the newest release
  not yanked;
- an install pinned to a yanked digest still installs, with the reason
  at the head of its ask (§8);
- an installed copy's next update, or `GET /packages` once the catalog
  is read again, says it is yanked and why.

Un-yanking is a later catalog without the field. A yank is a publisher's
word about its own release; an index has no field for it.

**Topology.** Three layers, two of them someone runs:

| Layer | What it is | Who runs it |
| --- | --- | --- |
| The client | `@synonymdev/pkarr` (WASM, Node and browser) inside strut: sign and put a record, resolve one, verify. No native build, no UDP listener | Every strut — a swarm's and Peel's alike |
| The relay | the Pkarr relay binary: `PUT /:key` verifies the signature and puts the packet into the DHT, `GET /:key` resolves and caches, and it re-puts for the keys it has served. One container, stateless but for its cache | One per swarm (a sphinx-swarm image), which talks to the public DHT like everyone else. **One run by Stakwork as the shipped default** (2026-10-24, below), so a strut with no swarm resolves out of the box. Synonym's public relays as fallback. Peel, a standalone docker strut and a laptop checkout run none — they resolve and publish through the default list |
| The Mainline DHT | BitTorrent's; a record lives a few hours and anyone may re-put a still-valid signed packet | Nobody |

The JS client is believed to speak only to relays (the WASM build has no
DHT socket) — **to confirm before building**; if it reaches the DHT
directly, the relay becomes a cache and an availability aid, not a
dependency — and the defaults below stay as they are.

**The shipped defaults** (2026-10-24, proposed). A strut with no swarm
behind it — Peel, a bare `docker run`, a laptop checkout — must be able to
RESOLVE from the first boot with nothing configured, and publishes through
the same defaults once it has a key and a byte host. Three values are
built into strut, each overridable:

| Default | Env | What it is for |
| --- | --- | --- |
| The index key | `STRUT_PACKAGE_INDEXES`, Stakwork's `{ id: "stakwork", key }` as the one entry when unset (§7) | Which phone book a resolve of a bare name (`acme/linear`) consults |
| The relay list | `STRUT_PKARR_RELAYS`, a JSON list of URLs; unset = Stakwork's relay first, then Synonym's public relays | Where the client PUTs (a publisher, and an installer's re-put) and GETs (everyone) records. A GET asks the first that answers and reads a second when it can, since a relay can be stale; a swarm's own relay goes first in its list, by sphinx-swarm |
| The index catalog URL | `STRUT_PACKAGE_INDEX_URL`; unset = the Stakwork strut's `GET /index/catalog` | The signed index catalog over plain HTTPS, verified against the index key — so the INDEX resolves with no relay and no DHT at all, and the DHT is only needed to follow PUBLISHER records, which is what it is for |

Stakwork's relay is the same container a swarm runs, at one stable
hostname, and it re-puts the index record with the rest of what it has
served — keeping the index pointer alive is Stakwork's job whatever runs
it. It is not a trust point: it verifies signatures and cannot forge a
record; what it can do is be down or stale, and the fallback relays, the
catalog URL and a publisher's own `url` list cover that. A deployment that
wants nothing of Stakwork's sets all three to its own.

**Peel's setting** is the default list, not its org's relay: a Peel user
may have no org, and one with several orgs installs from all of them. An
org's swarm relay is reachable only inside the swarm's network in any
case; it serves the swarm's own PUTs, and its records reach Peel through
the public DHT and the default relays like anyone's.

**Publishing from anywhere** (*ruled 2026-10-24*, revising the same day's
"a swarm only"; the shapes below are mine, proposed). A publisher is three
roles, and they need not be one machine:

| Role | What it does | On a swarm | On a laptop checkout or Peel |
| --- | --- | --- | --- |
| The KEY | signs the catalog and the record | `publisher.json` on the swarm | `publisher.json` on the laptop |
| The BYTE HOST | serves the catalog and the archives to anyone. Untrusted: every fetch is by hash, and the catalog is signed | its own archive route | a host it uploads to — GitHub release assets first |
| The POINTER | says which catalog is current, and where | the key's record, in the DHT through the relays | the same |

Every connection a laptop makes is outbound — an upload to its byte host,
a PUT to a relay. Nothing reaches into its network, and nothing has to.

**The byte host is a setting of the publisher** (`publisher.json`'s
`host`, `PUT /publisher { host }`): `self`, the strut's own archive route —
the default on a strut with a public URL (`STRUT_PUBLIC_URL`) — or an
upload target. The first target is GitHub release assets, `{ kind:
"github-release", repo, tokenSecret? }`: one release per publish, tagged
by the catalog's digest, holding the catalog and the archives it added,
so an earlier digest stays in its earlier release (the left-pad rule).
The upload is a new lib step, `github/upload-release-asset`, over the
token `git+` reads (`GITHUB_TOKEN` by default, the actor's when one is on
file). Anything else that serves a file at a stable URL — S3, a Blossom
server — is the same seam later. A strut with no public URL and no upload
target cannot publish, and says which setting is missing.

**Why the pointer is not the byte host** (§10's plain-HTTP row). Were the
ref the catalog's URL, the host would be the pointer too: it could keep
serving an older, validly signed catalog that an installer which never saw
the newer one cannot tell from current, and leaving it would break every
ref unless it forwarded or Stakwork edited the index row. The record names
the current catalog's HASH, so a stale host is caught and the next URL
tried, and leaving a host is an upload to another and one re-put. Neither
the host nor Stakwork can withhold or freeze the pointer.

**A sleeping publisher.** A record lasts hours. A swarm re-puts its own
hourly (a timer beside the automations tick); a laptop does the same while
it is awake. While it is not, two things keep the record alive: the relays
re-put the keys they have served (for how long is open, question 9), and
**every strut that installed from a publisher re-puts that publisher's
record** on the same timer — BEP 44 lets anyone re-put a still-valid
signed packet, and the record is verified before it is re-put, so a reader
keeps a pointer alive and can never change it. A package people use stays
resolvable; one nobody installed lapses. A lapsed record breaks nothing
installed — an install is local and pinned by digest; new installs and
updates wait for the publisher's next re-put.

**An org's fork** still goes the earlier way when it should carry the
org's name: a desktop hands it to the org's swarm, which publishes it
under the org's prefix. What changed is that a person may also publish
under a prefix of their own, from where they work.

**"Latest" is the publisher's word.** The record's timestamp orders
records and the catalog's `seq` orders catalogs; a package's newest
release not yanked is what "latest" means, and a `pk:` ref with no digest
takes it. No quorum, no canonical
branch: one key, one catalog. An org with several people publishing gives
each a prefix and a key, or shares one swarm strut's key through the
swarm's own access control. Radicle's threshold-of-delegates is the
primitive to borrow if a shared prefix ever needs more than one key
(research, Option A) — not designed.

**Key loss and rotation.** No spec here answers it — BEP 44 and Pkarr
both say so — so a key is final, and strut's answer is INDIRECTION. The
index binds a prefix to a key: a lost or compromised publisher key is a
new key and a new index row. A NEW install of the name follows the row;
an installed package pinned the key it resolved (§3), so its next update
stops and asks, naming both keys (§4) — a genuine rotation costs each
installer one prompt, and a row changed by mistake or by an attacker
never silently redirects code already installed. The index decides the
first introduction, nothing after it. A `pk:` ref that names the old key
keeps resolving whatever the old record says until it expires. The
secret key is backed up with the secret store's key (`STRUT_SECRET_KEY`,
the deployment's), the custody the deployment already has; on a laptop
that custody is the person's, and a lost laptop is a lost key, recovered
through the index the same way. Nothing cross-signs; the index row is
the recovery.

**What is public and what is gated.** The record, the catalog and the
index are public by construction: anyone who knows a key can see which
packages a publisher has, at which digests, served where. The bytes are
what §6's token gates, at a strut's archive route; a release asset on a
public repo is public whatever the catalog says. A package nobody should see
is not published to a public catalog. It travels by `file:` or a private
`git+` repo as before, or in a PRIVATE catalog: the same card, never put
in the DHT, served behind the gate to subscribers holding its read token
(§12.1).

**Scale.** A record is under 1000 bytes and a catalog a few kilobytes per
hundred packages; archives are kilobytes to a few megabytes. At ten to ten
thousand struts the relay carries pointers and the byte hosts carry bytes
they already serve — a swarm's archive route, a GitHub release; nothing
here needs more than the one container. The research found no 2024–2026 measurement of the Mainline
DHT's size — only that iroh adopted the Pkarr format for its own
discovery, which is the adoption signal the choice rests on.

## Step order

**After step 2, the fleet first (2026-10-27, proposed; §12.1).** In this
order:
1. The lab-seed stamp fix. *Built: strut#355.*
2. Step 4's update table without the ask: the `distro` door. *strut#356.*
3. Step 6 without the record: the publisher key, the card with `host:
   self` and `channels`, `POST /packages/publish`, `GET
   /packages/catalog`, and the card's test vector. *Built 2026-10-27
   (step 6's note).*
4. The read token, subscriptions, the poll, the sync ping and `GET
   /packages/subscriptions`.
5. Then mcp's `labAuth` line and hive's subscription pass.

Steps 3, 5 and the rest of 6–8 follow as written.

**Built first, out of order (2026-10-24):** the bottom of steps 2 and 6,
which needs nothing from step 1 — `readPackage` and the digest
(`src/packages/format.ts`), the cache with the `file:` resolver
(`cache.ts`), and the archive with `fetchArchive` (`archive.ts`), plus
`GET /packages/:publisher/:name/archive?digest=`. The cache directory is
`<dataDir>/packages/sha256-<hex>/`, not `<digest>/`: no `:` in a path a
Windows desktop may hold. The route is behind the key like every route
until step 6 opens what a catalog publishes; nothing fills the cache in
production until install (step 2) calls the resolver.

1. **Provenance + names.** `upstream` on version records (file store,
   graph schema, conformance case), carried forward by every publish;
   `VersionSource: "install"`; `activate: false` on the content-hash
   publishers; and workflow names with slashes. **Names need no data
   migration** (2026-10-24, proposed; checked on `strut@3abcb97`): every
   workflow today has a one-segment name, which is the base case of the
   nested layout — the same folder, the same graph node, the same URL.
   What changes is code, and it matters only once a name has a slash:
   - **The stores.** The run store already nests a name on `/` (`runsDir`,
     `src/store.ts:456`, written for the `step:<type>` buckets), and the
     graph store keys a workflow by its name, slashes included. The file
     store is the one to change: `listWorkflows` and `snapshot()` (what
     the Ladybug import reads) walk nested directories for
     `_metadata.json` instead of one flat `readdir` (`src/workspace.ts:639`,
     `:1471`), and `deleteWorkflow` takes segments instead of refusing any
     `/` (`src/workspace.ts:821`).
   - **The name rule, for slashed names only.** Neither store checks a
     workflow name at create today (`createWorkflow`,
     `src/workspace.ts:722`, and its graph twin), so a rule tightened for
     every name could refuse a republish of a name someone already has.
     The rule applies only to a name with a `/`: no empty, `.` or `..`
     segment, no `\`, and no segment named `runs`.
   - **`runs` is reserved** because a workflow's directory on the file
     store already holds its run records in `runs/`, beside
     `_metadata.json` and the `vN.yaml` files; a workflow `acme/runs`
     would land inside `acme`'s run records. The version files are files,
     so `vN` needs no reservation.
   - **A workflow beside its namespace.** A workflow `acme` and an
     installed `acme/linear/sync` share `workflows/acme/` on the file
     store: `acme`'s own files, and `linear/sync/` below them. So the walk
     keeps descending after it finds a `_metadata.json` (skipping `runs/`);
     `createWorkflow`'s taken-name check reads `_metadata.json`, not the
     directory (`pathExists`, `src/workspace.ts:733` — a namespace folder
     is not a workflow, and today it would rename a new `acme` to
     `acme-2`); and deleting `acme` removes its own files and `runs/`,
     never the names under it (today's `deleteWorkflow` is an `rm -rf` of
     the directory, `src/workspace.ts:828`). The graph store has no such
     case: names are keys, not paths.
   - **The URL rule.** 25 routes take `/workflows/:name/…` as one segment,
     and `:name{.+}` would swallow the `/:version` catch-all behind it, so
     a slashed name travels URL-ENCODED on the wire
     (`/workflows/acme%2Flinear%2Fsync/run`, as GitLab encodes a project
     path). Checked on Hono 4.12.32: the router's `decodeURI` leaves `%2F`
     alone, so `…/run`, `…/:version/run` and `…/flow` each match with
     `param("name")` = `acme/linear/sync`, and a one-segment name routes as
     before. An unencoded slashed name 404s in every case tried: a launch
     matches no route, and `GET /workflows/acme/linear` asks `acme` for a
     version named `linear`, which no workflow has (labels are `vN`). The
     step routes keep `:type{.+}` as they are.
   - **The clients.** Whoever builds the URL encodes the name. Strut's web
     UI puts it in raw in 20 places in `web/src/api.ts` (5 encode) — fixed
     in this step. Already encoded: the deep links (`?wf=`, query
     parameters written through `URLSearchParams`), the MCP doors' `ui`
     links (`src/ai/tools.ts:327`, `src/ai/assistant-tools.ts:147`), the
     peer client (`src/peers.ts:312`, `:330`, `:566`), and hive's launch,
     run-read and control paths (`src/services/strut-runs.ts:372`, `:534`,
     `:694`, `strut-runs/job-turn.ts`, `strut-runs/orchestrator-turn.ts`,
     `strut-runs/lab.ts`; `hive@3bc899bce`). Hive's legal-benchmarks route
     and the mcp lab's smoke tests put fixed one-segment names in raw and
     never meet a slashed one. A host that builds URLs raw keeps working
     for every one-segment name.
   - **A slashed name already on a graph.** The graph store accepts a slash
     today, so a swarm may already hold one, unreachable over HTTP because
     the slash splits the URL. This step makes it reachable; one query per
     swarm says whether any exist (not checked).
   - **Where names do change** is §12's lab renames, with the distro's
     `renames` map — not this step. Strut's own seeds (`job`,
     `orchestrator`, `builder`) keep their names.
   - **Built 2026-10-24.** `Upstream` (`src/workspace.ts`) on workflow,
     step and app versions with `upstreamFor`'s carry-forward,
     `getStepMetadata` (steps had no read of a version's record),
     `activate: false` on all three content-hash publishers, and
     `validateWorkflowName`; conformance cases on the file store, Ladybug
     and Neo4j 5.19.
   - **Found while building it, not in this step: a run's workflow from its
     event path.** A step's `ctx.path` begins with the run's root workflow
     (`acme/linear/sync/fetch`), and `StepContext` carries no workflow, so
     eight places read it as `path.split("/")[0]` — `acme` for a slashed
     name: a proposal's `by.workflow` (`src/proposals.ts:291`), the
     Mothership's billing dimension (`src/llm.ts:208`), the agent's
     `created_by` stamp and a session turn's `workflow`
     (`src/steps/core/agent.ts:821`, `:1903`), `meta/add-evidence`'s asker
     (`src/steps/lib/meta/add-evidence.ts:25`), a job thread with no agent
     (`src/job-threads.ts:319`), the run graph's root
     (`src/apps/views/…/RunGraph.tsx:752`), and the flyout a run event
     opens (`web/src/app.tsx:898`, `split("/")[1]`). The fix is the run's
     workflow on `StepContext`, set by the runner, read at each — needed
     before step 2 installs a slashed name.
   - **Built 2026-10-25: the run's workflow.** Event paths keep their shape
     — the run's name, slashes included, then its steps — so every log on
     disk, a host matching ``path.startsWith(`${workflow}/`)`` (hive's run
     report) and every one-segment name read exactly as before; what changed
     is the readers that took the first `/` as the end of the name.
     `StepContext.workflow` (optional; the runner sets it in every frame, an
     agent's tool calls inherit it) and `workflowOf(ctx)`, which falls back
     to the path's first segment for a context the runner did not build — a
     test, a host calling a step itself, a proposal's apply (its path is
     `proposals/<id>`, so its billing dimension is what it was). The five
     server reads above use it; a job thread's no-agent turn takes the
     run's own path; `foldRun` (the builder's `get_run`) takes its root
     from the run's `run.*` event; the kit's run overview the same; the
     web flyout strips the selected workflow's name. The RUN GRAPH (kit
     `project.ts`, hive's copy at `src/lib/strut-run-graph`) reads a path's
     first segment as the run and the next as its step — lanes, tree,
     scopes — so the projection writes a slashed root as one segment,
     `%2F`-escaped as the name travels in a URL (`rootSegment`), and the
     labels decode it (`segmentLabel`); a name with no slash projects as
     before. And the name rule refuses `#` in a slashed name: an event path
     marks an iteration with it. Not in strut: the mcp lab's pod steps bill
     with `ctx.path.split("/")[0]` (`mcp/src/lab/pods/steps/_shared.ts`,
     `llmGrant`) and hive's run-graph copy splits the same way — both right
     for every name they run today (the lab's seeds, a job's `job` /
     `builder`), both a one-line `workflowOf` / `rootSegment` port before a
     slashed workflow runs through them; under hive's copy a slashed child
     run only draws its name as nested branches.
2. **Format + install from `file:`.** The tree digest (`treeHash`, shared
   with `apps.md` §1.3), `buildPackage`,
   `installPackage` (verify, the prefix rule, `requires.packages`
   recursion, all or nothing, Concepts, step claims, the fence),
   `GET /packages`, `POST /packages/install`,
   `DELETE /packages/:publisher/:name` (a package name has one slash, so
   the routes take it as two segments). **Apps as a kind** join here once
   `apps.md`'s work item 1 exists: grants in the closure, the build against
   the kit at install, migrations and graph types at the publish,
   `upstream` on app versions.
   - **Built 2026-10-26: install from `file:`** (`src/packages/install.ts`,
     `installed.ts`, `fence.ts`; `specs/API.md` §16). §3 as written, with
     these choices of mine, proposed:
     - **The fence wraps the step in the registry**, not the runner's
       dispatch: `buildRegistry({ fences })` replaces each custom step whose
       active version carries an `upstream` with a wrapper whose `run`
       hands the real one a fenced `secrets`, and `resolveStep` does the
       same for a pinned version — so a workflow, an agent's tool call,
       `run_step`, a check and a proposal's apply are all fenced with no
       change at each. `StepListEntry` carries the active version's
       `upstream` for it; `materializeStepVersion` returns a pin's.
     - **The rule after install lives in the stores**
       (`refuseUnderInstalledPackage`, both backends, a conformance case):
       a publish of a NEW workflow or step name under a prefix where an
       item of that package lives is refused unless it carries that
       package's `upstream`. Every door gets it, a future one too.
       Concepts do not hold the prefix (a store never sees them).
     - **Step versions record their door** (`source`, `actor`, as workflow
       versions do; `version_source` + `actor` on `StrutStepVersion`):
       the fold's installed version is the newest one `source: install`
       wrote, so a fork's version — which carries the same `upstream` — is
       never mistaken for it.
     - **The file store's `deleteWorkflow` keeps `runs/`**: they are the run
       store's, and an uninstall keeps history. `DELETE /workflows/:name`
       still calls `RunStore.deleteRuns` first, so it removes them as before.
     - **`keepEdited` also takes a deleted node** under a page's name
       (whoever stamped it): the install checked every LIVE name first, and
       a deleted page is nobody's — the seeder's silent skip would have
       left the package without it.
     - **Uninstall keeps the helpers while a forked step of the package
       stays**: a fork may import them, and deleting one breaks the fork at
       registry load, silently.
     - **The checks before the first write** are the names (prefix,
       sealed namespace, Concept stamps and parents), the workflow files
       (YAML, `name:` = the path, every step type, literal grant and
       subflow target here or in the set) and the claims files' shape. A
       step's declared `type` and whether it loads can only be known by
       loading it, so that check runs after the steps are written, and
       takes back everything the install wrote when it fails.
     - **Apps were refused** (`package_unsupported`) until the third PR
       (below), and **another digest of an installed package** is
       (`package_update_not_built`): step 4.
     - **Open, found while building it:** a package of Concepts ALONE
       records no source ref anywhere — its pages carry a stamp, not an
       `upstream` — so `GET /packages` finds its digest and version in the
       cache, and §4's update (which re-resolves `upstream.source.ref`)
       has nothing to re-resolve for it. A PINNED version of a step that
       imports a sibling helper (`./_shared.js`) did not load either: the
       version archive had no helper beside it. **Fixed (strut#341):** a
       pinned version is imported from beside the active steps
       (`materializePinnedStep`), so a helper it imports is the helper's
       ACTIVE version — a pin of a package step holds the step's own
       file, not the helpers it shipped with.
   - **Built 2026-10-26: `license:`** (§1, proposed). An optional
     non-empty string in the strict manifest schema
     (`src/packages/format.ts`); its SPDX syntax is not checked, since
     nothing enforces it. A strut built before this refuses a package that
     carries the line (`bad_package`), which costs nothing while none is
     published. Showing it in the install ask is step 5's.
   - **Built 2026-10-26: `buildPackage`** (`src/packages/build.ts`;
     `POST /packages/build`, `specs/API.md` §16). §2 as written, built into
     the cache by `putDir` so the archive route serves it and an install
     takes it from `file:<the cache directory>`. These choices are mine,
     proposed:
     - **A seed's item outside the prefix is recorded nowhere**, like a core
       step: a workflow or step whose active version says `source: "seed"`
       (strut's `job`, `private-ask`, a host's seeds). The installing strut
       must have it, and the install already checks that it does.
     - **Two packages built on one strut can depend on each other**
       (found while building it; added at the owner's ask). As §2 reads, a
       pin comes from an `upstream`, which only an install writes — so a
       publisher's own `acme/util`, built and never installed here, could
       not be required by its `acme/linear`, and "install it from its
       package" does not work on the strut that holds the local items. The
       build request takes `requires.packages: [{ package, digest }]`, the
       digest an earlier build returned: the cache must hold that package,
       every item the closure reaches under its prefix must be in it byte
       for byte as it is here now (else "rebuild it and require its new
       digest"), and it is pinned with `source: file:<its cache
       directory>` — whether or not anything reaches it, since a closure
       read only in part may. Building several packages in one call,
       ordered by what each reaches, could sit on top of this later.
     - **The closure stops at the prefix.** `flowClosure` walks a subflow
       under the prefix and is handed an empty flow for one outside it: a
       pin's closure is its own package's business, and a seed's is the
       installing strut's.
     - **A version label in the closure refuses the build** (`type@vN`, a
       `subflow`'s `version:`): labels are per strut, and the installing
       one numbers its versions from v1.
     - **"Unless `workflows` / `steps` list what it reaches"** is read as:
       a closure that cannot be read whole (a templated subflow target, a
       grant read only when the run starts, a templated step type) is
       refused, naming the step, unless the request names more than the
       workflows it is the closure of — then it builds, with a warning that
       the package holds what was listed. Nothing can check that the list
       is complete. A workflow or step the request names outside the prefix
       is classified like a reached one: a pin, a seed, or a refusal.
     - **A named Concept keeps its parent** as front matter, the first by
       name when it has several; a parent outside the package that is not a
       page strut ships or one of a required package is a warning, since
       the install refuses a page whose parent it cannot find. A page
       another seeder stamped (strut's `Job`, a host's, another package's)
       refuses the build: a package carries pages of its own.
     - **A step's claims** are read through the claims reader
       (`claimsFor` / `checksFor`), every check written out with its
       stored `when`, `policy` and `name`, sorted so the same claims are
       the same bytes. A claim is left out WHOLE when one of its checks
       reaches outside the package and its requirements — a claim's checks
       are its contract.
     - **`requires`** also reads a package step's declared `secrets` (its
       def's field), a step's schema defaults through `secretNamesIn` (a
       `git/*` step names GITHUB_TOKEN), and the kept checks' configs (an
       `exec` check's command is a binary). A command with a `/` is a
       path, not a name on PATH, and is skipped; a templated secret or
       runtime is a warning. Editing what was inferred waits for export
       (step 3), where the directory is the author's.
     - **Refusals** are one code, `package_build_refused: …`, naming every
       problem at once (an app was `package_unsupported` until the next
       PR). A step under the
       prefix that does not load here as its own type refuses too, since
       the install would.
     - **The route** is `POST /packages/build`, a person's act at full
       scope like install, one write at a time with install and uninstall.
     - **Not covered:** a pin's `source` is the ref its install recorded,
       or a sibling's cache directory, so a package that requires one
       resolves only where that path exists (or from a cache that holds the
       digest) until `git+` and `pk:` sources land.
   - **Built 2026-10-26: apps as a kind** (`src/packages/build.ts`,
     `install.ts`, `installed.ts`; `specs/API.md` §16). §2's closure and
     §3's build check as written, except what waits on `apps.md`: an app's
     `db/*.sql` migrations and its declared graph types are work items 3
     and 4 there, and nothing runs them yet. The install publishes an app
     through the apps capability — the publish `POST /apps` makes — so when
     those items make the publish run them, an install runs them with no
     change here. These choices are mine, proposed:
     - **An app's imports are read off its build**, `dist/build.json`,
       which its publish wrote from the sources the version hash covers. A
       version with no build of those sources (a restore whose rebuild
       failed) refuses the build: its imports cannot be read.
     - **An import pinned to a version** (`acme/linear/ui@v3`) refuses the
       build, as `type@vN` does: the installing strut numbers from v1.
     - **An app under the prefix has one segment after it**
       (`acme/linear/issues`): the format is `apps/<name>/`, so
       `acme/linear/ui/kit` refuses the build, naming the rule.
     - **A step an app grants directly** counts toward `requires` as the
       step with no config: its schema's secret-name defaults (a `git/*`
       step's `GITHUB_TOKEN`), since the page may call it with any config.
     - **The build check runs on a copy** of each app outside the cache (a
       build writes `dist/`), with the set's workflows and apps in reach —
       an app of the set resolves to its copy. The publish then builds it
       again against what was published, so its `dist/build.json` names
       the versions it compiled in here. Apps are published after the
       workflows, each after the set's apps it imports.
     - **Apps hold the prefix** in both stores
       (`refuseUnderInstalledPackage` takes an app; a conformance case): a
       package of apps alone holds its prefix as one of steps does, and a
       new app under an installed prefix is refused at every door. A local
       app under the prefix refuses the install, as a local workflow does.
     - **Uninstall deletes an app's pointer** (`apps.delete`, soft on a
       graph; the version directories stay, as a workspace delete leaves
       them). A forked app is kept, like any fork; one of the package's
       apps it imports is not — the fork's built document still runs, and
       its next build names the missing app.
     - **An install is a person's publish** (`surface: "person"`), as
       installing is a person's act: the meta surface's grant rules (no
       `llm`, `agent`, `exec`, nothing sealed) do not apply to it.
3. **`git+` source + export to git**, the §2.3 export over the package
   layout.
4. **Updates:** the ask, each re-point classified `silent` / `named` by
   schema and claims diff (§4), fast-forward / coexist / retire, and
   `update_package`'s merge on request — per file for an app.
5. **Builder tools + UI:** an "installed from acme/linear 1.4.0 ·
   modified" line on a workflow's Versions tab and in a step's info
   flyout; the install and update asks as elicitation forms, with the
   license and the spend and act lines (§8).
6. **`pk:` source + the publisher key + the catalog** (§13): confirm the
   JS client's transport (relay-only or direct) first; the catalog CARD —
   RFC 8785 form, digest, fingerprint, seal, `seq` and the rollback and
   conflict refusals, `yanked` — with a TEST VECTOR (a fixed key, catalog,
   fingerprint, seal and digest) in the tests for another implementation
   to check itself against; `publisher.json`
   (minting refused on the dev secret key), `publish_package` (build →
   catalog → byte host → record) on any strut, `GET
   /packages/:publisher/:name/archive?digest=` and `GET /packages/catalog`
   for `host: self`, and the first upload target — `github-release`, over
   a new `github/upload-release-asset` lib step; the resolver (record →
   catalog → archive, every fetch verified by hash) with `upstream.key`
   pinned at install and an update that asks when the index names another
   key; the hourly re-put — a publisher's own, and every installer's for
   the publishers it installed from; the Pkarr relay image in sphinx-swarm.
   - **Built 2026-10-27: the half with no record**, the fleet's item 3
     (§12.1; `src/packages/card.ts`, `publisher.ts`; `specs/API.md` §16).
     It covers the card and every reader check, the test vector,
     `publisher.json`, `host: self`, `channels`, `POST /packages/publish`,
     `GET /packages/catalog` and `PUT /packages/channels/:channel`. Not
     built: the record, the relay, the resolver, `yanked` as a write (a
     reader already skips a yanked release), the upload target. These
     choices are mine, proposed:
     - **A release on `host: self` lists no `urls`.** Its archive is the
       route beside the catalog, `GET /packages/:publisher/:name/archive`,
       which the subscriber already knows the base of. So a swarm whose URL
       changes needs no new seal, and a URL is written only by an upload
       target, which is a later item.
     - **The test vector uses RFC 8032's first key** (seed `9d61b1…7f60`,
       public key `d75a98…511a`), so another implementation checks its key
       handling against a published vector too. Its z-base-32 is
       `47pjoycnsrfmxikm95jh13y88e8qnhzu5kungjpxyepgt7a8krpy`; the encoder
       matches the z-base-32 spec's example (`0xF0BFC7` → `6n9hq`). Whether
       it matches Pkarr's own client is checked when the client lands.
     - **A reader's checks run in §13's order,** then the card's shape: a
       sealed catalog whose channel holds a release it does not list is
       `catalog_invalid`. Each publish starts from a copy of the current
       catalog, so every member in it is carried forward.
     - **The minting refusal applies to a FILE secret store only.** A
       memory store writes nothing to obfuscate, so it mints, and its key
       is gone at the next boot.
     - **`POST /packages/publish` is build then release, in one write.**
       The key is ensured first, so an unsafe store refuses before
       anything is built. The same build published again adds no release,
       though it may still move a channel.
     - **The catalogs** are files under `<dataDir>/packages/catalogs/`, each
       sealed one by its digest plus a `current` pointer, so an earlier
       catalog stays servable by digest.
     - **The publisher's members** are `v`, `key`, `seq`, `packages`,
       `channels` and `sig`. §13's `publisher` member is left out until
       something reads it.
7. **The public index + the shipped defaults** (§7, §13): the index key
   and its catalog (step 6's card, prefix `strut-index`) on a Stakwork
   strut, `PUT /index/:prefix` and `GET /index/catalog`, `STRUT_PACKAGE_INDEXES` by key with the public one as
   default, the paste door, `search_packages` over the publishers'
   catalogs; `index.yaml` by `git+` for a private index. **Stakwork's
   relay** at a stable hostname (the step 6 container, deployed once) and
   the defaults built into strut — `STRUT_PKARR_RELAYS` (Stakwork's, then
   Synonym's), `STRUT_PACKAGE_INDEX_URL` — so a Peel or a bare `docker
   run` resolves a bare name on first boot with nothing configured. The
   env table in AGENTS.md gains the three names when this lands.
8. **Selling:** the package token on the archive route,
   `entitlements.json`, the fetch presenting it.
9. **Runtimes** (§11.1), independent of 1–8 and useful before any of
   them: `runtime` on `ShellRequest`, the two runtime shapes behind the
   standard bag's `shell`, the field on `exec` and `agent`, `/health`;
   then `images/exec`. `requires.binaries` / `requires.runtimes` join the
   install ask in step 2 as reported items.

## Validation

- A round trip on one strut: build a workflow package whose closure has a
  custom step, a helper and a Concept; install it into a fresh workspace
  on a Ladybug file and on the filesystem backend (Concepts skipped there,
  with the warning); run it; its claims verify on the buyer's strut; its
  step reads its declared secret and is refused another.
- The step-centric case: a package of one step; a workflow authored
  locally against it; an update fast-forwards it under that workflow,
  after the ask.
- Dependencies: a package requiring another at an exact digest installs
  both under one ask; the same name required at two digests refuses; a
  build whose closure reaches a local step outside the prefix with no
  `upstream` refuses, naming it.
- A conflict: a local step under the package's prefix refuses the whole
  install and writes nothing; creating one under an installed prefix is
  refused with the package named.
- The fork path: edit an installed workflow, update the package, and see
  the fork stay active with the new version beside it and `diverged`
  reported; `update_package`'s merge, asked for, merges a clean case and
  returns markers for a conflicting one.
- The classified ask: an upstream step with unchanged schemas and claims
  is listed `silent`; one with a changed output schema is listed `named`
  with the workflows that name it; neither installs without the accept.
- Integrity: one byte changed in an item fails the install against its
  pin; a git tag moved under an installed digest fails the update the same
  way.
- Pkarr: a package published on one strut (the record put through a
  relay, the catalog served) installs on another by `pk:` and by its index
  name, the catalog's signature and every hash verified; a byte changed in
  the served archive fails the install; a second publish moves the record's
  timestamp and the catalog, and the first digest is still fetchable; a
  relay restarted from empty resolves the record again (from the DHT, or
  from the publisher's next re-put if the client proves relay-only); with
  selling on, an expired package token stops the next fetch and leaves the
  installed version running.
- The catalog card:
  - A catalog a host re-serialized (another member order, whitespace) is
    refused as not canonical.
  - One byte changed in `packages` fails the seal, and so does a catalog
    sealed by a key other than the one the ref names.
  - The index catalog fetched over HTTPS with every relay unreachable
    verifies against the subscribed key.
  - An older catalog served after a newer one was accepted is refused, and
    the kept one is used; two catalogs at one `seq` are refused and
    reported.
  - `v: 2` is refused, naming both versions; a member v1 does not know is
    ignored and still covered by the seal.
  - The test vector verifies.
  - A yanked release is skipped by a floating ref and by an install by
    name, and a pin to it installs with the reason first in the ask.
- Publishing from a laptop: a plain checkout (`npm run dev`, a real
  `STRUT_SECRET_KEY`, no public URL) with `host: github-release` publishes
  a package — the catalog and archive land as release assets, the record
  names their URLs — and another strut installs it by `pk:` and by its
  index name. With the laptop stopped for longer than a record lives, the
  record still resolves through the installer's re-put, and a new install
  from a third strut succeeds. A second publish after a host change (a
  different repo) moves the record, and the installer's next update
  fetches from the new host with no ref changed. A checkout on the dev
  secret key refuses to mint a key; one with neither a public URL nor an
  upload target refuses to publish, naming the missing setting.
- The index: a prefix re-pointed to a new key in the index catalog makes
  a NEW install of its name follow the new key, while an installed copy's
  next update stops and asks, naming both keys, and installs nothing
  unless the person follows; a `pk:` ref to the old key still resolves
  the old record until it expires.
- The defaults: a strut booted with none of `STRUT_PACKAGE_INDEXES`,
  `STRUT_PKARR_RELAYS` or `STRUT_PACKAGE_INDEX_URL` set installs a package
  by its bare index name through Stakwork's index and relay; with the
  default relay unreachable it still reads the index catalog over HTTPS
  and follows the publisher's record through the fallback relays; a
  deployment that sets all three to its own never contacts Stakwork.
- A runtime: with `STRUT_RUNTIMES` naming a container that shares the
  workspace volume, `exec { runtime }` runs a command there and the
  agent's `bash` does too, over the files its editor tool wrote on the
  host; an unconfigured name fails naming the configured ones; a package
  requiring a runtime the deployment lacks installs with it reported, and
  the same package on a deployment that has it reports the binaries it
  lacks through the runtime.
- A swarm on `stable` applies a commit within one poll, with no
  restart; a run in flight finishes on the old defs; the next run uses
  the new.
- A step edited on one swarm survives a commit that changes it, and
  `GET /distro` reports it diverged; an untouched one fast-forwards.
- A commit with a stale digest, or one step that fails to load, is
  refused whole, the swarm stays on its last commit, and `GET /distro`
  names the error; a revert on the channel is applied by the next poll.
- An item dropped from the distro is uninstalled when untouched and
  kept and reported when edited.
- With `pod/release` in `renames`, a job holding a pod claimed under
  the old name is released by the new step; a launch of `explore`
  runs `hive/explore/explore`.
- An installed `sealed: true` grader: a candidate whose closure reaches
  it is refused at publish; its evidence records the package digest.
- Concepts alone: a package of two Concept pages, one the other's parent,
  installs, shows in `GET /packages`, uninstalls; an edit to one page in
  the graph survives an update of the package and is reported as
  diverged, and the other page fast-forwards; a page whose name a seed
  already holds refuses the whole install.
- An app in a package: build one holding an app and the two workflows its
  grants name; its item hash equals the app's version hash on the source
  strut. Install it on a strut whose kit builds it: the app is published,
  its migrations run, its graph types register, its granted workflows are
  items. (Built 2026-10-26 without the migrations and graph types, which
  wait on `apps.md` items 3 and 4: `src/packages/build.test.ts`, on the
  filesystem and every graph backend.) A kit lacking one import refuses the whole install naming it. Fork
  one component file, then update the package: the forked file is merged,
  an untouched one fast-forwards, a new `db/*.sql` is added and run,
  `data.db` is untouched, and a merge whose result does not build comes
  back to the builder as a conflict.
- A fleet (§12.1):
  - A central strut publishes `hive/fleet` 1.0 to `stable`, and two child
    struts subscribed to its key install it within one ping.
  - A 1.1 publish fast-forwards both. On a child where
    `hive/fleet/explore` was edited, the edit stays active, 1.1 lands
    beside it, and the item is reported diverged.
  - A yank brings both children back to 1.0 at the next `seq`.
- A fleet's checks:
  - A card sealed by another key, or one with an older `seq`, is refused,
    and the child stays where it was.
  - The read token opens the catalog and its archives and nothing else
    on the central strut: a launch or a run read with it is a 401.
  - A sync ping from a peer reads only the subscribed URL.
  - A release whose workflow names a step one child lacks is refused
    whole on that child and applied on the other, and that child's `GET
    /packages/subscriptions` names the step.
- The lab seeds: on a swarm whose lab steps were seeded before strut#340,
  a fleet workflow using `jarvis/*` builds after one boot.

## Open questions

1. **Isolation for installed code.** Ruled in-process for v1, with the
   fence. If buying tools becomes the main path, a worker or a container
   changes what a step can reach (`ctx.services`), and that is its own
   plan.
2. **Cassettes in a package.** A step's recorded HTTP fixtures would let
   its claims verify offline on the buyer's strut, without the live API or
   a key. That needs a check that replays a cassette (`run-step.ts` has
   replay; the check runner doesn't take one).
3. **The checkout.** What mints the package token after a payment —
   Lightning through Sphinx, a card page — and who hosts it. A product
   question; the token is the same whatever answers it.
4. **Per-job runtimes.** A container that is one job's — started from
   the pinned image at first use, held on the job, released when the job
   goes (§11.3) — is the natural next step once runtimes exist, and the
   first time strut would pull an image. Whether strut should own that or
   keep it the host's (the lab's pod pool) is open.
5. **The track record.** Read-through (federation §2.1) is not built;
   until it is, an index carries no evidence and the buyer's strut
   measures from zero. Whether a publisher may *report* numbers into an
   index file, labelled as such, is open. The other direction — a buyer's
   strut telling the publisher what failed, opt-in and previewed (the
   Graph Protocol draft's RECEIPT) — needs a channel to the publisher that
   nothing here has, and a privacy pass of its own, so it is a plan of
   its own rather than a step of this one.
6. **An app's claims in a package.** `apps.md` §11 makes a workspace app a
   claim subject; a workflow's claims ride in its YAML and a step's in a
   sibling `.claims.yaml`. An app's could be a `claims:` block in
   `app.yaml`, the workflow's shape, so the render check travels with the
   app. Not designed.
7. **The JS Pkarr client's transport.** Relay-only (believed) or direct to
   the DHT. Decides whether the relay is a dependency or a cache (§13);
   confirm before step 6.
8. **Several keys under one prefix.** One key per publisher in v1; an org
   with several publishing people shares a swarm strut or takes several
   prefixes. If a shared prefix ever needs several keys, Radicle's
   threshold-of-delegates is the primitive (§13).
9. **How long a relay keeps a silent key alive.** Pkarr's relays re-put
   the keys they have served, but its design does not say for how long
   once the publisher stops re-putting. Installers' re-puts cover a
   package someone installed; a package published from a laptop that
   nobody has installed yet may lapse while the laptop sleeps, and the
   first install waits for it to wake. Measure on the relay before step 6
   says more than that (§13).

