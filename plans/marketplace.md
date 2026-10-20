# Packages — sharing workflows, steps and Concepts between struts

> **Status (2026-10-19): design only, nothing built.** Revised 2026-10-18
> after a review against npm, Go modules, cargo, bundler, Homebrew taps and
> OCI: the first draft's generated manifest, its first-installer name rule,
> its vendored foreign items and its server-shaped index are gone (§10 says
> what replaced each). Revised again 2026-10-19: **the product is finding,
> downloading and using a package, paid or not** — paid EXECUTION and
> bring-your-own-billing are a later plan (§6), and a package may be only
> Concepts, or only steps (§1, §3). Rows marked *ruled* in "Decided" are
> the owner's; every other row is *proposed*. Companion plans this builds
> on: `federation.md` (peers, `strut/run-workflow`, and §2.3's git
> library, which this subsumes; see §9), `claims.md` (the contract a
> package carries), `specs/ENV_SPEC.md` (the binaries a package needs).
> Code citations are on `strut@83a5b10`.

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
| What is sold | ***Ruled (revised 2026-10-19):* packages.** A paid package is a gated download. Paid execution is a later plan (§6) |
| Ownership | **By prefix.** Package `acme/linear` owns every name under `acme/linear/`, workflows included (`acme/linear/sync`). Who owns a name is read off the name; nothing is bound at install (§1) |
| Dependencies | **A package carries only its own prefix.** Another package it executes is a `requires.packages` pin — an exact digest with a source hint — and the install resolves those with the same function, under one ask. No ranges, no solver: exact pins union, and two that disagree refuse (§1, §3) |
| Identity | **The digest is a tree hash** over the directory, manifest included. The manifest holds nothing derivable from the files: no item list, no per-file hashes, no step types (§1) |
| Where it lives once installed | **Nowhere new.** Installed items are ordinary workflows, steps and Concepts. Each version records its `upstream`, and "installed packages" is a fold over those records. There's no package store (§3) |
| Conflicts | **Refuse.** A local creation under an installed prefix, or one name pinned at two digests, refuses the whole install; nothing is written (§3) |
| An update over a local edit | **Never activates over a fork.** Untouched items fast-forward. A modified one gets the new version beside it, with the local edit left active, and the builder rebases on request (§4) |
| An update, and a person | ***Ruled:* an update asks like an install.** New code never lands on an accept that was given for other code (§4, §8) |
| Transport | **`file:`, `git+` and `peer:` in v1.** *Ruled:* the `peer:` source is in; it revises federation §2.3's "no strut-to-strut copy" for packages (§9). OCI is not designed (§5) |
| Trust | ***Ruled:* in-process, with one fence.** An installed step runs like a `POST /steps` step today, and `requires.secrets` is ENFORCED: a step with an `upstream` reads only the names its package declared (§3) |
| Price | **Not in the package.** The source gates the download: a private repo's ACL, or a token the seller mints for the peer's archive route (§6) |
| The index | **A list, not a service.** `index.yaml` in a git repo, or a peer's `GET /packages`. ***Ruled:* no public index yet**; each deployment names its own (§7) |
| Who installs | **A person.** Installing is publishing third-party code onto the server: a keyed `full`-scope route, or a builder tool that asks first. No `meta/*` twin (§8) |

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
fast-forwards what nobody changed, and leaves the rest to a three-way
merge the builder runs, after which the claims re-run. Where the directory
comes from — a path, a git ref, a peer's archive route — is a resolver's
job, and the archive route is also where a price is charged.

## 1. The package

```
strut.yaml                        # the manifest: a few lines, none generated
workflows/sync.yaml               # → the workflow acme/linear/sync, the YAML as published
steps/create-issue.ts             # → the step acme/linear/create-issue
steps/create-issue.claims.yaml    # optional: the step's claims
steps/_shared.ts                  # → acme/linear/_shared; helpers ride with their namespace
concepts/Linear.md                # front matter as seedConcepts reads it
```

```yaml
# strut.yaml
package: acme/linear          # publisher/name — the prefix every item here is named under
version: 1.4.0                # the publisher's label; the digest is the truth
description: Linear issues, comments and sync, tested against the live API
requires:
  secrets: [LINEAR_API_KEY]   # the names its steps may read — enforced after install (§3)
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
  workflow over core and lib steps with no code at all. Nothing in the
  format or the install says which kind it is, and `requires.packages`
  pins any kind. **A new kind is a new folder** — prompt files, hotword
  lists, cassettes later are one folder and one publisher each — and an
  unknown top-level folder is REFUSED, not ignored, so a package from a
  newer strut fails whole instead of installing half.
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
- **Not in a package:** runs, evidence, secret values, automations,
  owners, run caps, params overrides, prices, signatures.

## 2. Building one — `buildPackage`

`buildPackage(workspace, { package, version, description?, workflows?,
steps?, concepts? })` writes the directory:

1. **Closure.** For each named workflow, `flowClosure` (`src/closure.ts:60`),
   `agentTools` globs expanded against the registry. Every reached
   workflow and custom step under the prefix is an item. One outside the
   prefix: with an `upstream`, its package and digest become a
   `requires.packages` pin (a second pin of the same package at another
   digest refuses the build); without one, the build is refused naming it
   — package it under your prefix, or install it from its package. Core
   and lib types are recorded nowhere. A closure that isn't `resolvable`
   (a templated `subflow` or grant) is refused, naming the step, unless
   `workflows` / `steps` list what it reaches.
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
   strut with the missing name, not silently.
6. **Refusals.** A sealed item (`src/sealed.ts`: by namespace,
   `sealed: true` on a def, a sealed workflow) can't be packaged.

The manifest `buildPackage` writes is the one a person would write by
hand; the builder can author it too.

## 3. Install — `installPackage`

`installPackage(dir, { pin? })` takes a directory a resolver (§5) produced:

1. **Verify.** The tree digest against the pin when there is one. Each
   step file's declared `type`, and each workflow's path, against the
   prefix rule. Every core and lib type the YAML names is in this
   registry. Every `requires.packages` entry is installed at that digest,
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
3. **Publish.** Steps first, in path order, then workflows, through
   `publishStep` / `publishWorkflowByContent` with a new door,
   `VersionSource: "install"`, and the new field `upstream` on the version
   record. Concepts go through `seedConcepts` as a set with the prefix
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
installed file for a Concept. Uninstalling is deleting those names
(`DELETE /packages/:publisher/:name` deletes every name under the prefix
whose active version is still the package's own, retires every untouched
Concept of the package through `seedConcepts`'s `retired` path, and lists
the forks and edited pages it left alone).

**Version records gain one field.** `upstream?: { package, version,
digest, source: { ref }, secrets }` on `WorkflowVersionInfo` and
`StepVersionInfo` — the file store's `_metadata.json`, and one optional
attribute on `StrutWorkflowVersion` / `StrutStepVersion` (the AGENTS.md
schema convention, plus a conformance case). **A publish over an existing
name carries the active version's `upstream` forward** unless it sets its
own. So a builder edit of an installed workflow is a fork that still knows
its base.

## 4. Fork and update

**A fork is an edit.** `edit_workflow` / `edit_step` / the UI publish a
new local version (door `builder` / `ui`) whose `upstream` is inherited.
Its hash differs from the installed one, so the fold says `modified`.
Nothing else changes.

**An update is an install of the same package from its recorded ref.**
`update_package({ package, ref? })` re-resolves `upstream.source.ref`: a
tag never moves, so a package installed at `@v1.4.0` updates only when a
person names a new ref; a branch floats, like Go's `@latest`; a `peer:`
ref with no digest is the peer's current. A new digest **asks** the way
the first install did (*ruled*): the items that changed, the new
requirements, then accept. Per item, compare the ACTIVE version with the
hash the previous install put there:

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

**Wrap rather than edit** is what the builder's prompt should prefer for a
bought STEP: compose around it (a step or workflow that calls it), so
updates keep fast-forwarding. It's a nudge in the prompt, not a rule.

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
| `peer:<id>/<publisher>/<name>[@sha256:…]` | `GET {peer}/packages/:publisher/:name/archive` through `ctx.services.peers`: a tar of the directory, the digest in a header | A strut serves what it built or installed, by digest, to a holder of its peer key (federation §3: read scope) — an org's struts sharing, a desktop pulling from its cloud strut. The same route takes a seller-minted token when selling (§6) |

OCI (`oci://…`, ORAS) is not designed: the digest model is OCI's already,
so it would be a fourth resolver and nothing else.

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
  keyed by peer and package) and presents it on every fetch of that
  package, so updates flow until it expires — then you keep what you
  installed and stop getting new digests. How the buyer paid to get that
  token is a checkout, outside this plan.

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

An index is **a list** — `{ package, version, digest, source, description }`
per entry — in one of two places:

- **`index.yaml` in a git repo**, a Homebrew tap. Listing a package is a
  PR; anyone hosts one by making a repo; a company's private index is the
  same file in its own repo. A strut subscribes by ref
  (`STRUT_PACKAGE_INDEXES`, a JSON list of `git+` refs, and
  `PUT /packages/indexes/:id` — the peers' paste door, the same shape),
  fetches on demand, and caches under `<dataDir>/packages/index/`.
- **A peer's `GET /packages`** — the fold of §3, which is exactly this
  list for what that strut holds. Every peer on file is an index of what
  it has.

`search_packages` is `src/search.ts` over the union — the sidebar's
matcher. ***Ruled:* no public index yet.** The format and the subscription
door are in this plan; a public one is a product decision for later.

What an index can't carry is the **track record** — per digest, claims
supported / refuted and run counts on other struts. Federation §2.1's
read-through (not built) would give it, labelled *reported* and never
trusted as is: after install, the buyer's strut measures the same claims
itself (§3, step 4). A `StrutPackage` node and the graph's hybrid search
over listings are the later form, once there is a track record to hold.

## 8. The builder, and who may install

Builder tools (`src/ai/tools.ts`), each thin over the functions above:

- `list_packages`: the fold (§3).
- `search_packages({ query })`: the subscribed indexes and the peers. The
  prompt says: before writing an integration, search what's installed,
  then the indexes.
- `install_package({ ref })`: fetches and verifies, then **asks**
  (`ask_user`, plans/elicitation.md) with the manifest summary: publisher,
  digest, source, the items (which are code), the required packages it
  will install too, the secret names the code may read.
  It installs only on accept, then `request_secret` for each missing name.
- `update_package({ package, ref? })`: §4, and it asks the same way
  (*ruled*).
- `export_package({ package, workflows, to })`: §2 + §5.

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

## 9. What this changes in `federation.md` §2.3

§2.3 (not built) planned one origin per workflow, `source: { repo, path }`,
multi-repo seeding, export as a PR, and **"no strut-to-strut copy"**. This
plan subsumes it:

- `source` becomes the version's `upstream`, which also says *what* it
  came with (the package, the digest) and whether it was edited since.
- Seeding from repos becomes installing from `git+` sources. The lab's own
  boot seeding stays as it is: a seed is a host's template and overwrites.
  A package is someone else's product and never does (§4).
- Export is unchanged in mechanics, and writes a package.
- **The "no strut-to-strut copy" ruling is revised for PACKAGES** (*ruled*
  2026-10-18): a strut serves a package it built or installed, by digest,
  on its archive route — to a holder of its peer key, or of a token it
  minted for that package (§6).
  Git stays the hub for collaboration: a template under review travels as
  a PR, never as a copy, and read-through (§2.1) is still the only way one
  strut reads another's runs.

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

## Step order

1. **Provenance + names.** `upstream` on version records (file store,
   graph schema, conformance case), carried forward by every publish;
   `VersionSource: "install"`; `activate: false` on the content-hash
   publishers; workflow names with slashes — the file store's listing
   walking nested directories for `_metadata.json`, and the run store's
   `workflows/<name>/runs/` under a nested name.
2. **Format + install from `file:`.** The tree digest, `buildPackage`,
   `installPackage` (verify, the prefix rule, `requires.packages`
   recursion, all or nothing, Concepts, step claims, the fence),
   `GET /packages`, `POST /packages/install`,
   `DELETE /packages/:publisher/:name` (a package name has one slash, so
   the routes take it as two segments).
3. **`git+` source + export to git**, the §2.3 export over the package
   layout.
4. **Updates:** the ask, fast-forward / diverged / retire, and
   `update_package`'s merge.
5. **Builder tools + UI:** an "installed from acme/linear 1.4.0 ·
   modified" line on a workflow's Versions tab and in a step's info
   flyout; the install and update asks as elicitation forms.
6. **`peer:` source** + `GET /packages/:publisher/:name/archive` behind
   the peer key.
7. **Index files:** `STRUT_PACKAGE_INDEXES`, the paste door,
   `search_packages` over indexes + peers.
8. **Selling:** the package token on the archive route,
   `entitlements.json`, the fetch presenting it.

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
  the fork stay active and `diverged` reported; `update_package` merges a
  clean case and returns markers for a conflicting one.
- Integrity: one byte changed in an item fails the install against its
  pin; a git tag moved under an installed digest fails the update the same
  way.
- Peer: a package built on one strut installs on another through `peer:`;
  with selling on, an expired package token stops the next fetch and
  leaves the installed version running.
- Concepts alone: a package of two Concept pages, one the other's parent,
  installs, shows in `GET /packages`, uninstalls; an edit to one page in
  the graph survives an update of the package and is reported as
  diverged, and the other page fast-forwards; a page whose name a seed
  already holds refuses the whole install.

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
4. **The track record.** Read-through (federation §2.1) is not built;
   until it is, an index carries no evidence and the buyer's strut
   measures from zero. Whether a publisher may *report* numbers into an
   index file, labelled as such, is open.
