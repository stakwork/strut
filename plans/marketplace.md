# Packages — sharing workflows and steps between struts

> **Status (2026-10-18): design only, nothing built.** From one design
> conversation with the owner. The rulings in "Decided" marked *ruled* are
> his; every other row is *proposed*. Companion plans this builds on:
> `federation.md` (peers, `strut/run-workflow`, and §2.3's git library,
> which this generalizes; see §9), `claims.md` (the contract a package
> carries), `mothership-cost-control.md` (macaroons, the credential that
> selling reuses), `specs/ENV_SPEC.md` (the binaries a package needs). Code
> citations are on `strut@83a5b10`.

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
| `flowClosure`: what a workflow can execute, through subflows and `agentTools` (`src/closure.ts:60`) | A way to turn a closure into one shippable thing |
| A version's door (`VersionSource`, `src/workspace.ts:203`) and the service stamp (`publisher`) | Where a version CAME FROM, and whether it was edited since |
| A workflow's contract in its YAML (`claims:`, `readClaimsBlock`, `src/workspace.ts:75`) | A file form for a step's claims |
| Concept pages seeded by a stamp prefix (`seedConcepts`, `src/concept-seed.ts:151`) | Concepts that travel with the steps they document |
| Peers and `strut/run-workflow` (`src/peers.ts`, federation §2.2) | Anything to pull from a peer |

## Decided

| Question | Decision |
| --- | --- |
| The unit | ***Ruled:* one design serves both a workflow-centric package and a step-centric one.** A package is a CLOSURE: one shape whatever it exports (§1) |
| What is sold | ***Ruled:* both packages and execution.** A package (free, or a one-time / subscription fee, the WordPress-theme model) runs on the buyer's strut. A paid call runs on the publisher's. They compose: an open workflow can call a paid step remotely (§6) |
| Dependencies | **None. A package vendors its closure.** Items are content-addressed, so two packages carrying the same item install it once. No version ranges, no solver, no transitive fetch (§1) |
| Identity | **Full sha256 per item, in the manifest.** The local 12-char key stays the local dedup key; it's the same digest, truncated (§1) |
| Where it lives once installed | **Nowhere new.** Installed items are ordinary workflows, steps and Concepts. Each version records its `upstream`, and "installed packages" is a fold over those records. There's no package store (§3) |
| A name already taken | **Bound to the first upstream that installed it.** A local creation, or another package's item of the same name, is a conflict and the install is refused (§3) |
| An update over a local edit | **Never activates over a fork.** Unmodified items fast-forward. A modified one gets the new version beside it, with its local edit left active, and the builder rebases on request. This is the seeder's rule turned around: a seed overwrites, an install doesn't (§4) |
| Transport | **Pluggable sources behind one install.** `file:` and `git+` first, `peer:` next, OCI later. The format doesn't depend on any of them (§5) |
| Price | **Not in the package.** It belongs to the source (the repo's ACL, an entitlement on a peer fetch) or the index. The content stays the content (§6) |
| Who installs | **A person.** Installing is publishing third-party code onto the server: a keyed `full`-scope route, or a builder tool that asks first. No `meta/*` twin (§8) |

## Design in one paragraph

A **package** is a directory: a `strut.yaml` manifest plus the files it
names, laid out like federation §2.3's library convention
(`workflows/<name>.yaml`, `steps/<type>.ts`, `concepts/<Name>.md`). The
manifest names what it **exports** (one or more workflows or steps), lists
every **item** the exports can execute with its full sha256, and states
what it **requires** of the strut it lands on: core and lib step types,
secret names, binaries. Building one is `flowClosure` written to disk.
Installing one publishes each item through the content-hash publishers
that seeding already uses, refuses names that belong to someone else, and
stamps each version with `upstream: { package, version, source }`. A fork
is an ordinary edit, and the edited version carries its parent's
`upstream` forward. An update fast-forwards what nobody changed and leaves
the rest to a three-way merge the builder runs, after which the claims
re-run. Where the directory comes from (a path, a git repo, a peer, a
registry) is a resolver's job. What it costs is the source's or the
index's.

## 1. The package

```
strut.yaml                    # the manifest
workflows/linear-sync.yaml    # one file per workflow: the YAML as published
steps/acme/linear/create-issue.ts
steps/acme/linear/create-issue.claims.yaml   # optional: the step's claims block
steps/acme/linear/_shared.ts  # helpers ride with their namespace
concepts/Linear.md            # front matter as seedConcepts reads it
```

```yaml
# strut.yaml
package: acme/linear          # publisher/name. A convention, not an account
version: 1.4.0                # the publisher's label; the digest is the truth
description: Linear issues, comments and sync, tested against the live API
exports:
  - workflow: linear-sync
  - step: acme/linear/create-issue
items:
  - { workflow: linear-sync, sha256: 9f2c… }
  - { step: acme/linear/create-issue, sha256: 41ab… }
  - { step: acme/linear/_shared, sha256: 07de… }
  - { concept: Linear, sha256: c3e1… }
requires:
  steps: [http, agent, pack]  # core/lib types the items name
  secrets: [LINEAR_API_KEY]
  bin: []                     # ENV_SPEC names, when that lands
```

- **One shape for both kinds.** A step package exports a step, and its
  items are that step, its namespace's helpers and its Concept. A workflow
  package exports a workflow, and its items are its closure. Nothing in the
  format or the install says which kind it is.
- **The package digest** is the sha256 of `strut.yaml`. That file lists
  every item's hash, so pinning a digest (`…@sha256:<digest>`) pins
  everything. An install checks every file against its listed hash before
  publishing anything.
- **Vendoring, not dependencies.** A workflow that uses another
  publisher's step carries that step's file. Two packages carrying
  `acme/linear/create-issue@41ab…` install it once. The same name at a
  different hash from a different package is a name conflict (§3), never
  something a solver has to settle.
- **Claims ride with the item.** A workflow's are its `claims:` block,
  already part of its YAML and its hash. A step's live in the sibling
  `<type>.claims.yaml`, in the same shape (`claimsArgSchema`), about that
  step. They are the package's promise, and §4 re-runs them on the buyer's
  strut after every change.
- **Not in a package:** runs, evidence, secrets values, automations,
  owners, run caps, params overrides, anything with a price. What a
  package's runs proved belongs to an index (§7), and the buyer's strut
  measures it again for itself.

## 2. Building one — `buildPackage`

`buildPackage(workspace, { package, version, exports, include? })` writes
the directory:

1. **Closure.** For each exported workflow, `flowClosure` (`src/closure.ts:60`).
   Its `workflows` are included as items. Its `types` split into custom
   steps (items) and core/lib types (`requires.steps`). `agentTools` globs
   are expanded against the registry at build time the same way. A
   closure that isn't `resolvable` (a templated `subflow` or grant) is
   refused, naming the step, unless `include` lists the missing items.
2. **Helpers.** Every `_`-prefixed file in each included step's namespace
   directory goes in. Imports aren't parsed; the namespace convention
   (`gitree/_shared`) is the boundary.
3. **Concepts.** Only those named in `include`, plus the subtree under
   each one (`PARENT_OF`). A Concept is documentation the author chooses,
   never inferred from what a run read.
4. **Step claims.** The live claims `ABOUT` each included step, written
   as its `.claims.yaml`. A claim whose check reaches outside the package
   and `requires` is left out, with a warning.
5. **Requirements.** `requires.secrets` starts from what can be found: the
   `secretsEnv` names in the YAML and string literals in
   `secrets.get("…")` calls in step source. The author edits the
   manifest; it's a declaration, not an analysis.
6. **Refusals.** A sealed item (`src/sealed.ts`: by namespace,
   `sealed: true` on a def, a sealed workflow) can't be packaged.

## 3. Install — `installPackage`

`installPackage(dir)` takes a directory a resolver (§5) produced:

1. **Verify.** Every item's sha256 against the manifest, and the digest
   against the source's pin when there is one. `requires.steps` must all
   be in this registry. Missing `requires.secrets` and `requires.bin` are
   reported, not refused: the builder asks for the secrets (§8).
2. **Name rule.** For each item's name: if it's free, it's published. If
   its versions' `upstream.package` is this package, it's an update (§4).
   Anything else (a local creation, another package's item, a core/lib
   type, a sealed namespace) is `package_conflict: <name>`, and **nothing
   is published**: an install is all or nothing, so it checks every name
   before writing anything.
3. **Publish.** Steps first, in the manifest's order, then workflows,
   through `publishStep` / `publishWorkflowByContent` with a new door,
   `VersionSource: "install"`, and the new field `upstream: { package,
   version, digest, source }` on the version record. Concepts go through
   `seedConcepts` as a set with the prefix `pkg/<package>/`: the seeder's
   create / keep / update rules already make a graph-side edit survive
   until the file changes. On a filesystem workspace (no graph) Concepts
   are skipped, with a warning.
4. **Claims.** A workflow's `claims:` block is reconciled at publish, as
   for any publish (`reconcileWorkflowClaims`,
   `src/claims-authoring.ts:489`). A step's `.claims.yaml` goes through the
   same reconcile, extended to a step subject, with the package as the
   speaker. `publish`-kind checks fire at install as at any publish. `run`
   checks fill the buyer's own ledger from the first runs on this strut;
   until then each claim reads `unknown`, which is the truth.

**There is no package store.** `GET /packages` folds the workspace: every
name whose versions carry an `upstream`, grouped by package, each with
`{ installed: version, active: <its version>, modified: active ≠ the
installed hash }`. Uninstalling is deleting those names
(`DELETE /packages/:publisher/:name` deletes every name the package installed whose
active version is still its own, and lists the forked ones it left
alone).

**Version records gain one field.** `upstream?: { package, version,
digest, source }` on `WorkflowVersionInfo` and `StepVersionInfo` — the
file store's `_metadata.json`, and one optional attribute on
`StrutWorkflowVersion` / `StrutStepVersion` (the AGENTS.md schema
convention, plus a conformance case). **A publish over an existing name
carries the active version's `upstream` forward** unless it sets its own.
So a builder edit of an installed workflow is a fork that still knows its
base.

## 4. Fork and update

**A fork is an edit.** `edit_workflow` / `edit_step` / the UI publish a
new local version (door `builder` / `ui`) whose `upstream` is inherited.
Its hash differs from the installed one, so the fold says `modified`.
Nothing else changes.

**An update** is an install of a newer digest of the same package. Per
item, compare the ACTIVE version with the hash the previous install put
there:

| Active version | Result |
| --- | --- |
| Equal to the previous install's hash (untouched) | **Fast-forward:** publish the new version and activate it |
| A local version (forked) | **Diverged:** publish the new version WITHOUT activating it (a new `activate: false` on `PublishByContentOptions`) and report it. The fork stays active |
| The new hash already (same content) | Nothing |
| An item the new version no longer ships | Retired only if it is untouched, as a seeder's retired step is today. A fork is kept and reported |

**Rebase is the builder's.** `update_package({ package, item? })` does,
per diverged item: a three-way merge of base (the version the fork
inherited `upstream` from), theirs (the new upstream) and ours (the
active fork), by `git merge-file` on the three texts. It's deterministic
and needs no model. A clean merge is published as a local version
upstreamed to the new version. A conflicted one comes back to the model
with the markers, and it resolves them with `edits`, as `edit_workflow`
already takes them. **Then the claims run:** the package's own, which
the fork inherited, and the buyer's. The tool result is the ledger. "Did
my change or their update break what I paid for?" is answered by checks,
not by reading the diff.

**Wrap rather than edit** is what the builder's prompt should prefer for a
bought STEP: compose around it (a step or workflow that calls it), so
updates keep fast-forwarding. It's a nudge in the prompt, not a rule.

## 5. Sources

A source turns a reference into a package directory under
`<dataDir>/packages/<digest>/` (content-addressed, so a second fetch of
the same digest is a no-op). One interface, `resolve(ref, ctx) →
{ dir, digest, source }`:

| Ref | Resolver | Notes |
| --- | --- | --- |
| `file:/path/to/pkg` | copy | dev, tests, packages a host ships in its image |
| `git+https://host/org/repo@<ref>#<path>` | `git/checkout`'s bare cache under `<dataDir>/repos`, credential from a named secret (`tokenSecret`, default `GITHUB_TOKEN`) | GitHub, Forgejo, GitLab — anything git. The repo's ACL is the access control, so a private repo is a private package |
| `peer:<id>/<package>[@<digest>]` | `GET {peer}/packages/:publisher/:name/archive` through `ctx.services.peers` | the tar of the directory. A strut that installed or built a package can serve it. The token is the peer's (federation §3) |
| `oci://registry/repo@sha256:…` | ORAS pull | later. The digest model is OCI's already |

**Exporting is the other direction, for git:** federation §2.3's
`export_workflow` mechanics (`git/checkout` → write files → `git/push` →
`github/create-pr`, always a PR, the actor's token), with `buildPackage`
writing the files. A package's repo IS its upstream: merging the PR and
the next update on every strut that installed it from there is the
distribution.

## 6. Selling — two strategies, one credential

Nothing in §1–§5 knows about money. Both strategies sit on the source:

- **A paid package** (a one-time fee for a version line, or a
  subscription): the **source** gates the fetch. On git, the repo's ACL
  already does this: buying is being granted read access. On a peer or an
  index, the fetch carries an **entitlement**: a macaroon with caveats
  `package=acme/linear, updates_until=2027-10`, kept in an encrypted file
  like `peers.json` and never on the services bag. When `updates_until`
  passes, you keep what you installed and stop getting new digests.
  Optionally the publisher signs a per-buyer manifest, so a leaked copy
  can be traced. **No DRM**, ever: a bought package can be read, forked
  and evolved, and that's the point. The money buys the updates, the
  evidence on them, and legitimacy.
- **Paid execution:** the item is never shipped. The buyer's workflow
  names `strut/run-workflow { peer: acme, workflow: … }`, already built,
  and the peer's launch route answers `402` with an invoice and a
  macaroon (L402: a macaroon plus a Lightning payment, the credential
  gatekey already speaks) with caveats `workflow=…, per_call<=…`.
- **They compose:** an open package whose most valuable step is a paid
  call. The buyer owns and adapts the workflow, and only that step's
  inputs cross the wire.

An entitlement and a paid call are the same mechanism with different
caveats, so the marketplace needs one payment path and one credential
path.

## 7. The index

An index is **a strut**, not a new service. Listings are graph nodes
(`StrutPackage`: the manifest, its sources, the publisher, a price and
mode, and an evidence summary), found by the hybrid search the graph
already has. A buyer's strut names its indexes as peers. Anyone can run
one: a public marketplace, or a company's private one in front of its
Forgejo.

What an index shows that a repo can't is the **track record**: per digest,
claims supported / refuted and run counts, read from the publishers'
struts over read-through (federation §2.1, not built) or reported by
them, and
labelled *reported*. It is never trusted as is: after install, the
buyer's strut measures the same claims itself (§3, step 4).

## 8. The builder, and who may install

Builder tools (`src/ai/tools.ts`), each thin over the functions above:

- `list_packages`: the fold (§3).
- `search_packages({ query })`: the configured indexes. The prompt says:
  before writing an integration, search what's installed, then the
  indexes.
- `install_package({ ref })`: fetches and verifies, then **asks**
  (`ask_user`, plans/elicitation.md) with the manifest summary: publisher,
  digest, source, the items, which are code, the requirements, the price
  if any. It installs only on accept, then `request_secret` for each
  missing secret name.
- `update_package({ package })`: §4.
- `export_package({ exports, to })`: §2 + §5.

**Installing is a person's act.** Installing a step is running someone
else's TypeScript in the server process, so:

- `POST /packages/install { ref }` is behind the key at `full` scope; a
  peer can't install.
- The builder's tool installs only after the user accepts in the same
  turn.
- There's no `meta/*` twin: an in-run agent can never pull code. That's
  the sealed surface's job (EVOLVE_SPEC §6), and installing joins what it
  refuses.

## 9. What this changes in `federation.md` §2.3

§2.3 (not built) planned one origin per workflow, `source: { repo, path }`,
multi-repo seeding, and export as a PR, with **"no strut-to-strut copy"**.
This plan subsumes it:

- `source` becomes the version's `upstream`, which also says *what* it
  came with (the package) and whether it was edited since.
- Seeding from repos becomes installing from `git+` sources. The lab's own
  boot seeding stays as it is: a seed is a host's template and overwrites.
  A package is someone else's product and never does (§4).
- Export is unchanged in mechanics, and writes a package.
- **The `peer:` source revises the "no strut-to-strut copy" ruling.** It
  needs a ruling (open question 1). Everything else here stands without
  it, on `file:` and `git+`.

## 10. What not to do

- **No dependency resolver.** Vendoring plus content addressing makes it
  unnecessary. If two packages disagree about a name, that's a conflict a
  person sees.
- **No package store.** The items carry their provenance, and the list is
  a fold.
- **No price, owner or evidence inside a package.**
- **No update that activates over a fork.**
- **No install from an agent.**
- **No new trust model for the code in v1.** An installed step runs
  in-process like a `POST /steps` step does today; the person who
  accepted the install is the trust. Isolation is open question 3.

## Step order

1. **Provenance.** `upstream` on version records (file store, graph
   schema, conformance case), carried forward by every publish;
   `VersionSource: "install"`; `activate: false` on the content-hash
   publishers.
2. **Format + install from `file:`.** `buildPackage`, `installPackage`
   (verify, name rule, all or nothing, Concepts, step claims),
   `GET /packages`, `POST /packages/install`,
   `DELETE /packages/:publisher/:name` (a package name has one slash, so
   the routes take it as two segments).
3. **`git+` source + export to git**, the §2.3 export over the package
   layout.
4. **Updates:** fast-forward / diverged / retire, and `update_package`'s
   merge.
5. **Builder tools + UI:** an "installed from acme/linear 1.4.0 ·
   modified" line on a workflow's Versions tab and in a step's info
   flyout.
6. **`peer:` source** + `GET /packages/:publisher/:name/archive` (after open
   question 1).
7. **The index**, then **selling** (entitlements, L402 on launch).

## Validation

- A round trip on one strut: build a workflow package that uses a custom
  step, a helper and a Concept; install it into a fresh workspace on a Ladybug
  file and on the filesystem backend (Concepts skipped there, with the
  warning); run it; its claims verify on the buyer's strut.
- The step-centric case: a package exporting one step; a workflow
  authored locally against it; an update fast-forwards it under that
  workflow.
- A conflict: a local step of the same name refuses the whole install
  and writes nothing.
- The fork path: edit an installed workflow, update the package, and see
  the fork stay active and `diverged` reported; `update_package` merges a
  clean case and returns markers for a conflicting one.
- Integrity: one byte changed in an item fails the install.

## Open questions

1. **Peer copy.** Does the `peer:` source go ahead, revising federation
   §2.3's "struts never copy from each other"? The case for it: a desktop
   strut with no git credentials, and a publisher who sells from their
   own strut.
2. **Conflicts.** Is refusing right, or should an install take
   `as: { <name>: <new name> }`? Renaming a workflow changes its YAML's
   `name:` and so its hash, which the `modified` test would need to
   allow for.
3. **Isolation for installed code.** In-process is today's trust model
   for every custom step. If buying tools becomes the main path, bought
   steps may need a worker or a container. That's a larger piece of
   work, and it would change what a step can reach (`ctx.services`).
4. **Cassettes in a package.** A step's recorded HTTP fixtures would let
   its claims verify offline on the buyer's strut, without the live API
   or a key. That needs a check that replays a cassette (`run-step.ts`
   has replay; the check runner doesn't take one).
5. **Who runs the first index, and what pays.** L402 on Lightning fits
   Sphinx and gatekey. Card payments would need a hosted checkout that
   mints the same entitlement.
