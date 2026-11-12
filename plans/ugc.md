# User-generated content: slots, measured claims, budgets

> **Status (2026-11-12): proposed.** From one design conversation with the
> owner, and nothing in it is ruled yet. Written against strut `main`
> @9d74d291. The example throughout is a multiplayer game whose players have
> agents make characters and fortresses, but the primitives are general:
> any app that shows one person's content to another. Companion to
> `apps.md` (the app object, `data.graph`, `step_run`'s grants),
> `claims.md` (claims, checks, evidence), `paid-runs.md` (L402, public
> runs), `app-repos.md` §5 (signed-in visitors) and `app-channels.md`.

## Problem

A strut app can already let its viewers make things, and the things are
getting heavy. Agents and workflows can call a 3D-generation API, convert
the result for three.js and rig it, so a player's character is a few
minutes of a job away. The model that comes back can be four million
triangles with 8K textures. One such model in a shared world lowers
everyone's frame rate, and a hundred of them makes the world unplayable.

The same holds for any content one person makes and others load: a
scene, a shader, a feed ranking, an app over someone else's data, a
character's behaviour written as code. Strut's question is how such
content gets into a shared space without one person's content costing
everyone else.

**Check data, meter code.** A static check can decide what data costs (a
mesh's triangles, a texture's bytes). It cannot decide what code costs:
the halting problem rules that out. So code is metered while it runs, and
anything that can be data should be turned into data and checked against a
schema and a budget.

| Strut has | Strut lacks |
| --- | --- |
| `data.graph` types an app declares, registered at publish (`src/apps/graph-types.ts`); `step_run`'s `graphWriteRefusal` holds a page to them | A content type that declares a BUDGET and the workflow that admits content into it |
| Sealed workflows and steps (`src/sealed.ts`): nobody's agent can edit, run or reach them | — |
| Claims, checks and evidence keyed by version, status computed on read (`claims.md`) | Claims about one piece of content, by its hash, at the scale of thousands of items |
| `app/look` over strut's own host, `window.__debug` read in the frame | A bench harness that spawns N copies of an asset and reports frame time and draw calls |
| The app monitor (`src/apps/monitor.ts`): warnings per version in tumbling windows | The same for content: which hash cost the most frames |
| `exec` steps, `uv` scripts, `npx` | `asset/*` steps over gltf-transform |
| Public runs priced over L402 with per-run and daily caps (`src/public-runs.ts`); signed-in visitors with daily limits | — |
| Channels with stamped senders (`src/channels.ts`) | A convention that a channel carries hashes, never content |
| `run/files` (≤ ~3.7 MB binary, scoped to runs) | An asset store addressed by hash, readable by every viewer, a visitor included |
| The kit's game stack (R3F, Rapier, drei, three-mesh-bvh) and the `game` starter | A loader that spends a per-viewer budget across LODs and impostors |

## The shape

Four layers of checks, outermost first. Each catches what the one before
it lets through.

| Layer | When | What it decides | Strut piece |
| --- | --- | --- | --- |
| **Ingest** | Before anyone else can load it | Does it fit the slot's budget once compiled? | A slot's sealed ingest workflow (item 1) |
| **Measured** | At ingest, again when the gate changes | Does the gate still do what it says? | A claim on the workflow, its check a sealed bench (item 3) |
| **Social** | After it is live | Do people say it is griefing, broken, offensive? | Evidence by signed-in people and labelers, on the hash (item 5) |
| **Runtime** | Every frame, on every viewer | How much of my budget does it get? | The kit's loader (item 4); the monitor (item 6) |

Code a person writes for a slot (a character's behaviour) gets a fifth:
**metered** at runtime (item 7). Payments run under all of it: a priced
submission pays for the compute it takes to check it (item 2).

## The flow, end to end (the heavy glTF)

```
player's agent ── 3D API ──▶ raw.glb (4M tris, 8K textures)
        │
        ▼  page: job/upload + run/launch (the slot's only door)
┌─ <slot>'s ingest workflow (sealed, published by a person) ────────┐
│  asset/inspect   → tris, draw calls, bones, texture MB, bytes     │
│  if: past what can be saved → reject, with the counts             │
│  asset/optimize  → gltf-transform: weld, simplify, resize + KTX2, │
│                    meshopt, merge draws, LOD0/1/2 + impostor      │
│  asset/inspect   → must fit the slot's budget, else the run fails │
│  asset/bench     → app/look on a bench app, reads __debug         │
│  slot/admit      → the content node { hash, tier, lods, counts }  │
└───────────────────────────────────────────────────────────────────┘
        │  claims: on the workflow; the check a sealed bench; evidence every run
        ▼
channel carries { avatar: "<hash>" } ── viewers' kit loader:
  admitted hashes only, a LOD chosen by the viewer's frame budget
```

Nobody else's client ever loads the mesh the player made. It loads what a
workflow the app's owner controls made from it, and the claims layer says
whether that workflow still does its job.

## Work items

### 1. Slots: a content type with a budget and an ingest workflow

A slot is declared in `app.yaml` beside `data.graph`:

```yaml
slots:
  Character:
    ingest: game/ingest-character      # a workflow; sealed
    budget:
      triangles: 15000
      drawCalls: 4
      bones: 40
      clips: 8
      textures: { count: 2, maxSize: 1024 }
      bytes: 2_000_000
    tiers: [A, B, C]                   # what the bench may report
    price: { base: 0.02 }              # optional; a priced submission (item 2)
```

What a slot means:

- **The slot's type is a graph type the page cannot write.** Declaring
  `Character` as a slot registers it like a `data.graph` type
  (`registerAppGraph`), with fixed fields strut owns (`hash`, `tier`,
  `lods`, `counts`, `admittedBy`, `run`) plus the app's own. A page's
  `graph/create-node` on it is refused by `graphWriteRefusal` whatever
  `grants.steps` says: only `slot/admit`, in a run of the slot's ingest
  workflow, writes one. Reads (`graph/find`) work as on any declared type.
- **The ingest workflow is the slot's only door.** It is granted to the
  app implicitly (`grants.workflows`), with `run/launch` the page's way to
  submit. It must be sealed (`sealed: true`), and the app build refuses a
  slot whose workflow is not, so no agent, the builder's included, can
  edit, run directly, read or reach the gate (EVOLVE_SPEC fixed point:
  the grader is never the candidate's). A model never grants or publishes a
  sealed workflow (`app/publish` refuses it); a person does, or accepts
  `app/grant` as a proposal, as for `orchestrator` today.
- **`slot/admit`** (a new lib step) runs only inside a run of a workflow
  some app names as a slot's `ingest` (`ctx.app` and the run's workflow
  checked). It takes the compiled output's files, checks the counts it is
  handed against the slot's budget once more in code (the workflow's
  author may have a bug; strut's check is the last word), writes the files
  to the asset store by content hash (item 4), and writes the node. Its
  input is the counts and the files, never "admit this": a run that never
  reaches it admits nothing.
- **The budget is the app owner's knob, in the manifest.** Changing it is
  a new app version; the ingest workflow reads it through `ctx.app`
  (`slot/budget`), so one workflow can serve several slots.
- **Not game-specific.** A slot's budget fields are a closed grammar per
  KIND: `mesh` (above), `image` (pixels, bytes), `text` (chars), `json`
  (a schema, bytes), `code` (item 7). A kind is added to strut when an app
  needs one, never named by an app.

Built: the manifest field, the type's registration, the refusal, the
implicit grant and the sealed check, `slot/admit`, `slot/budget`, and
`app/get` reporting the slots. Tests over the `hello` fixture with a
`json` slot (no 3D needed).

### 2. Submissions cost something

A submission is a run of the ingest workflow. Optimizing and benchmarking
a model costs compute, and a free door is a flood.

- **Signed-in players** submit through `run/launch` as themselves, under
  the visitor's daily launch limit (`DEFAULT_VISITOR_LIMITS`) and the
  per-address budget. Nothing new.
- **Priced submissions:** with `price` on the slot, the ingest workflow
  is a runnable public item (`runnable`, `paid-runs.md` §2) and a launch
  without credit is a `payment_required` the host's sheet pays, as for any
  priced workflow. Per-run and daily caps bound what one submitter spends.
- A rejection is charged like any other run: the submitter paid for the
  inspection. The `reject` output names the counts and the budget, so the
  submitter's agent can fix the model and try again.

Mostly configuration of what exists. Built: `slot.price` written as a
`runnable` item when the app is in the public view, and the reject's shape.

### 3. Measured claims: the gate is checked, not trusted

The ingest workflow carries its contract:

```yaml
claims:
  - text: An admitted Character renders 20 copies at tier B under 8 ms a frame
    checks:
      - step: asset/bench-check         # sealed: true on its def
        when: always
```

- **`asset/bench`** (in the workflow) and **`asset/bench-check`** (the
  check) both run `app/look` on a bench app — a small app strut ships with
  the asset package, a fixed scene and camera — with
  `input=hash=<hash>&copies=20`. The bench app spawns the copies through
  the kit loader (item 4) and sets `window.__debug` to `{ frameMs,
  drawCalls, triangles, textureMB }` from three's `renderer.info`, the
  convention the `Game` page already teaches.
- **Counts gate, frame time advises.** Headless Chrome's software GL is
  not a phone, and its timings are noisy. The admission decision rests on
  the counts (item 1, deterministic); the frame time is the claim's
  evidence and sets the `tier`. A claim that goes `refuted` says the gate
  let something through that renders badly even within budget: the budget
  is wrong.
- **An edit makes it stale.** A new version of the ingest workflow, or a
  loosened param, makes the claim `stale` until a run checks it again
  (`on_change` semantics). The Claims panel and the ledger show it.
- **Per item, by hash, is the gap.** Today a claim's subject is a step, a
  workflow, a job or a Concept. The per-asset verdict is the ingest run's
  own output and the node's `tier`; a claim ABOUT one asset (item 5's
  reports) needs a fifth subject kind, `content` (the slot's type and the
  hash, its version the hash itself, so it never goes stale; a re-ingest
  is a new hash). Decided in this item whether the kind is built here or
  left to item 5.

Built: `asset/bench-check` (sealed), the bench app, the `debug` reading,
and the claims block on the reference ingest workflow.

### 4. The asset store and the loader

**The store.** Content a slot admits is served by hash to every viewer
of the app, a visitor included:

- `<dataDir>/apps/<name>/.assets/<sha256>` (an app's, like `.state/`),
  written only by `slot/admit`, never overwritten.
- Read through a new `asset/get { hash, part? }` step — `part` the LOD or
  the impostor — always granted to a page whose app declares the slot,
  answering bytes as `run/files` does, but with no run scope and a higher
  cap (a LOD0 is a few MB). Served as a blob URL, which the app CSP
  already allows; no host.
- A hash that is not admitted is a 404 with no body: a page can never use
  the store to fetch a raw upload.
- Later: content addressed by hash is exactly what `torrents.md`
  distributes, and an index could mirror it.

**The loader** (the kit, `useAsset(slot, hash)` and `<SlotAsset>`):

- Resolves the hash with `graph/find` on the slot's type; no node → a
  placeholder (a capsule, a box), never a fetch.
- Spends a per-viewer **frame budget**: the nearest few and the viewer's
  friends at LOD0, then LOD1/2 by distance, then impostors, then
  placeholders, from the counts on the node (no measuring at runtime).
  The budget is the viewer's setting (`useAppState`), with defaults by
  device class.
- Unverified (`tier` missing, or a claim refuted on its hash once item 5
  lands) never loads above the impostor.

**Channels carry hashes.** The convention, in the `Game` page and the
kit's docs: a player's channel state is `{ avatar: "<hash>" }`, never a
mesh or a URL. A hacked client can broadcast anything and still cannot
make another viewer load an unvetted file, because every viewer resolves
the hash through the store. Not enforced by strut (a channel carries
JSON); enforced by the loader, which is the only way a page draws slot
content.

### 5. The social layer: reports and labelers

What passes the gate can still be griefing, offensive or broken in a way
no count catches.

- A signed-in viewer's report is **evidence** on the content (item 3's
  `content` subject): `asserted`, by the person, with what they said. Its
  identity is the visitor's actor (`p256:` / `secp:`), so a report costs
  a signature and is rate-limited per actor.
- A **labeler** is a person or a workflow whose evidence a viewer chooses
  to trust (Bluesky's labelers): a list of actors on the viewer's own
  state, and the app's defaults. The loader hides or downgrades content a
  trusted labeler refuted. A labeler that is a workflow can be priced
  (paid per review) and is a package anyone can install.
- A **fork starts clean**: a re-ingest of an edited model is a new hash
  with no evidence, and gets none of the old one's reports or trust.
- Feeds over slot content (what a world shows, in what order) are
  workflows too: open, versioned, forkable, in packages. A viewer picks a
  feed as they pick a labeler.

Needs item 3's `content` subject. Built: the subject, `slot/report`,
the labeler list on the loader, and one reference labeler workflow.

### 6. The monitor, for content

`src/apps/monitor.ts` counts what an app's pages cost the server. The
same shape for what content costs the client: the loader reports, every
minute, the frame time spent per hash on screen (sampled, batched through
one `app/state`-like step), and the monitor warns on a hash whose cost
is far over its tier. A warning on a hash is evidence (item 5), so a gate
that keeps admitting such content shows up against its claim (item 3).

Later than items 1–5: the counts already bound the cost, and this catches
what they miss.

### 7. Code as content: metered, not checked

A slot of kind `code` holds behaviour: `tick(state, input) → actions`.

- **In the page:** run in a Worker (never the page's own thread) under a
  WASM interpreter with **fuel** (QuickJS-in-wasm counts instructions);
  out of fuel for the tick → that tick's actions are dropped. The slot's
  budget is fuel per tick and memory, checked at runtime by the kit, not
  at ingest.
- **Ingest** for code checks what can be checked statically (size, that
  it parses, that it exports `tick`), runs it against a reference state in
  the same interpreter for N ticks, and admits it with the fuel it used.
- **Authority:** the world's state is a referee's (a workflow, stamped by
  channels as the sender), and user code only proposes actions the
  referee accepts or drops. Code never holds a credential, never calls
  `step_run`; it gets `state` and `input` and returns data.
- **On the server:** user code is a workflow under `maxRunCostUsd`, a
  public run's caps and its price, as today.

The largest item and the most open; built after a game has needed items
1–4.

## Order, and what each unlocks

| Item | Unlocks | Depends on |
| --- | --- | --- |
| 1. Slots | Content that only a sealed workflow admits | — |
| 4. Asset store + loader | Another viewer can load admitted content at all | 1 |
| 2. Priced submissions | A public world without a flood | 1 |
| 3. Measured claims | The gate is checked; `tier` | 1, 4 (the bench loads through the loader) |
| 5. Reports, labelers, feeds | What counts cannot catch | 3's `content` subject |
| 6. Content monitor | What slipped through, measured on real clients | 4, 5 |
| 7. Code slots | Behaviour as content | 1, 4 |

The `asset/*` steps (`inspect`, `optimize`, `bench`, `bench-check`), the
bench app, a reference `ingest-character` workflow and an update to the
`game` starter ship as a **package**, not in core: meshes are a domain.
Core carries slots, `slot/admit`, `slot/budget`, `asset/get`, the
`content` subject and the loader.

A package can be built today, before item 1, to find what is really
missing: the ingest workflow as an ordinary granted workflow writing an
ordinary `data.graph` type through a step the page is not granted. That
gives items 2–4's shape with item 1's guarantees enforced by convention
only.

## Open questions

1. **Is a slot an app's, or a package's?** Several apps sharing one
   world would share a slot. Lean: the app's, and a package carries the
   app.
2. **Who may change a slot's budget, and what happens to admitted
   content when it tightens?** Lean: a new app version; admitted content
   keeps its node and its tier, and the loader treats content over the
   current budget as one tier lower.
3. **The `content` subject** (item 3): in claims.md's four kinds, or a
   lighter evidence-only record for thousands of items? Evidence per hash
   at a world's scale is many more nodes than claims.md planned for.
4. **Visitors' assets:** an anonymous visitor cannot submit (no actor);
   is a priced submission with no sign-in enough? Lean: yes, the credit
   token is the identity for that run, as for any public run.
5. **Storage:** who pays to keep an asset, and for how long? Lean: the
   submission's price covers a period; unloaded assets past it are
   dropped, their node kept with `gone: true`.
6. **Generation inside ingest:** should the ingest workflow also be the
   one that calls the 3D API (a prompt in, a model out), or only judge
   what a job made? Lean: only judge; generation is a job's or an agent's,
   and the gate stays small.

## Tests

- Item 1: a page's write on a slot type refused; a run of another
  workflow calling `slot/admit` refused; an over-budget admit refused in
  code even when the workflow passed it; an unsealed `ingest` fails the
  build.
- Item 4: an unadmitted hash is a 404; the loader never fetches without a
  node; LOD choice under a fixed budget is a pure function, tested.
- Item 3: the bench app's `__debug` read through `app/look`; the claim
  goes `stale` on a new ingest version.
- End to end (opt-in, like `test:browser`): a 1M-triangle fixture glTF
  submitted, compiled under budget, admitted with LODs, loaded by a second
  viewer at the tier the bench reported.
