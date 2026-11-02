# Concept tools: a Concept names the tool for its work

> **Status (2026-11-02): proposed, nothing ruled.** Every row below is
> mine, for Evan's ruling. No code. Written against strut `main` @561ecdf,
> stakgraph `main` @3ec1da73 and jarvis-backend `master` @413dd748.
> Companions: `concept-tree.md` (what a Concept is and who writes it),
> `graph-walk.md` (`graph/walk`), `walk-chat-demo.md` (the live walk
> graph), `proposals.md` (how a person approves a write).

## Problem

A matter's useful knowledge is Concepts plus the tools that reach
authoritative sources and make its work products. The graph holds
hundreds of Concepts (Law → M&A → NDA → Drafting rules), and none of them
names a tool. An agent that walks to "Drafting rules" learns how to draft,
but not that this firm reviews an NDA in a deviation matrix built as a
Google Sheet. And a viewer has no event to draw the moment the agent
moves from the page to the tool.

The demo: walk Law → M&A → NDA → Drafting rules, land on a page that says
to use a sheet here, make the sheet, and show it filling in.

## What exists

- **Routing in prose.** In `src/concepts/Job.md`, each child of `Job` is
  a kind of request whose docs name a workflow, and the job agent runs it
  with `meta/run-workflow`. Nothing parses the name; the model reads it.
- **Reads.** `graph/graph-get { node_type, name, children: "PARENT_OF" }`
  returns a page and its children as `{ ref_id, node_type, name,
  description }` (`src/steps/lib/graph/graph-get.ts:44`).
  `context/concept` renders a page and its kinds into a system prompt
  (`src/steps/lib/context/concept.ts:42`). `graph/walk` shows its decider
  a name and a snippet (`src/steps/lib/graph/walk.ts:174`, state at
  `:378`), returns kept nodes with clipped properties (`:499`), and emits
  one `walk:hop` pair per hop (`:365`, `:455`).
- **How each writer merges a Concept:**
  - *gitree and the lab's concepts pipeline* (stakgraph
    `mcp/src/gitree/store/graphStorage.ts` and
    `mcp/src/lab/concepts/store/graphStorage.ts`, `saveConcept`):
    `MERGE (:Data_Bank:Concept {id})` on the repo-prefixed slug, then
    `SET` a fixed list (name, repo, description, docs, PRs, commits,
    usage). A property outside the list survives. `docs` does not:
    `concepts/summarize` rewrites every modified feature's docs on every
    sweep (`concept-tree.md` decision 6). Hive Learn's accepted proposals
    use the same `saveConcept` (`mcp/src/gitree/proposals.ts:262`).
  - *jarvis* (`api/helper/schema_node_helper.py`, `create_or_merge_node`):
    keyed on `(node_key = concept-<name>, namespace)`. A write of an
    existing Concept is a no-op unless it asks for `reprocess` (`SET` each
    property sent) or restores a deleted node (`SET n += props`). An unsent
    property survives both. An undeclared attribute is skipped, not refused
    (`api/helper/schema_validation.py:207`).
  - *strut* (`graph/create-node`, `graph/edit-node`, `seedConcepts` in
    `src/concept-seed.ts`): the node writer refuses an attribute the type
    does not declare (`src/graph/node-writer.ts:116`). On Neo4j, Concept
    declares jarvis's attributes; on Ladybug, only what strut uses
    (`src/graph/ladybug/registry.ts`). Since the dynamic-ontology ruling
    (2026-10-28), a declared attribute is a column (`ALTER TABLE Node ADD`).
- **Tools as nodes.** Every workflow is a `StrutWorkflow` node. Only a
  custom step is a `StrutStep` (`src/graph/workspace-store.ts:587`):
  `sheets/*`, `docx/*` and `courtlistener/*` are lib steps, with no node.
- **Grants.** An agent's tools are its `agentTools`, usually
  `{{ params.tools }}`. Any other templated grant is unread, and the
  sealed check refuses it (`src/closure.ts:16`). `meta/run-workflow` runs
  any unsealed workflow. Each tool call is a `step.start`/`step.end` pair
  at `<agent>/NNN-<tool>`, with a read's provenance marker lifted onto
  `step.end.nodes` (`wrapToolsWithEmit`, `src/steps/core/agent.ts:1032`).

## Decisions (all *proposed*)

| # | Decision |
|---|---|
| 1 | A Concept names its tools in a structured field, `tools`, not in its docs and not as a node (§1). |
| 2 | A hint never grants. The agent calls a tool it already holds, by the name it already has. No dynamic grant (§2). |
| 3 | The reads (`graph-get`, `graph/walk`, `context/concept`) return the hints parsed, and the provenance marker carries them (§2.1). |
| 4 | Code records the handoff as `concept` on the tool call's `step.start`, never inferred from prose (§3). |
| 5 | Authoring v1 is by hand and by front matter. A suggestion pass comes later, writing proposals a person accepts (§4). |

## 1. Representation

| Option | For | Against |
|---|---|---|
| **a. Docs convention** ("use `sheets/*` here"), as `Job.md` does | Nothing to build; Hive Learn edits docs today | No machine-readable form, so no event and no check. The lab's sweep rewrites a feature page's docs every run. |
| **b. A `tools` field on Concept** | One read returns it. It survives gitree's and jarvis's merges. It names lib steps and MCP tools. One attribute per engine. | A JSON string, so graph queries can't follow it. Hive Learn has no field for it. |
| **c. A `Tool` node + `Concept -USES_TOOL-> Tool`** | Queryable ("which pages use CourtListener?") | A Schema row, edge rules and a rel table on both engines; a second read per page and per walk hop; a node that mirrors a registry name and goes stale when the step is renamed |
| **c′. An edge to `StrutWorkflow` / `StrutStep`** | No new type | Lib steps and MCP tools have no node, so `sheets/*` cannot be a target |

**Recommendation: b.** Shape, a JSON string:

```json
[{ "use": "step", "name": "sheets/*", "label": "Deviation matrix",
   "when": "Reviewing a counterparty NDA against these rules: one row per clause.",
   "input": { "title": "NDA deviation matrix — <counterparty>" } }]
```

- `use` is `step` or `workflow`. `name` uses the grant grammar: a step
  type, a namespace glob as `agentTools` writes one (`sheets/*`),
  `mcp/<server>/<tool>` (`src/mcp-registry.ts`), or a workflow name.
  `label` is for people, `when` is one line for the model, and `input` is
  an example that strut never merges into a call (§2.3). The docs keep the
  why in prose; the field holds only what code reads.
- **Ontology.** Declare `tools: "?string"` on Concept, outside `index` so
  it is never embedded. On Ladybug it is a seed attribute in
  `registry.ts`, which adds a `STRING` column; check first that no other
  type declares `tools` with another column type. On Neo4j it is an
  add-only extend at boot through `createNodeSchema`
  (`src/graph/schema-crud.ts`), plus a jarvis library migration so
  jarvis's schema agrees.
- **Writers.** gitree/lab and jarvis need no change: neither sends
  `tools`. Add one stakgraph test that `saveConcept` keeps the field.
  `seedConcepts` reads `tools:` from front matter, so a package's Concepts
  (`src/packages/install.ts`) ship their links beside the steps they name.
- **Parsing** is one pure function, `parseConceptTools`, in a new
  `src/concept-tools.ts`. A malformed field reads as no tools plus a
  warning, and never fails a read or a walk.

## 2. Discovery

### 2.1 What the reads return

- **`graph-get`**: the page's parsed `tools`. Each child also gets
  `tools: [{ label, use, name }]` when it has any, so the parent shows
  which page offers a tool.
- **`graph/walk`**: `tools` on each hop's `candidates[]` and on each
  output node. The decider's snippet gains `· offers: Deviation matrix
  (sheets/*)`, so a page offering what the goal needs ranks higher. This
  adds no question and no cost.
- **`context/concept`**: a kind's line ends `— offers: <label>`.
- **The marker**: `AccessedNode` gains `tools?` (`src/core.ts`), so
  `step.end.nodes` shows what was offered before anything is called.

### 2.2 From a hint to a call

| Option | Reach | Verdict |
|---|---|---|
| **i. Tools the workflow already grants** | The hint chooses among what the agent holds; a step outside the grant has no tool | **Recommended** |
| **ii. `meta/run-workflow` for a workflow hint** | The job agent and builder already hold it, reaching every unsealed workflow, so a hint adds no reach. But an editable page picks which workflow runs. | Allowed, within §2.3 |
| **iii. A dynamic grant** (`agentTools: "{{ walk.tools }}"`) | Graph data becomes the grant; `closure.ts` already calls it unread | **Refused** |
| iv. A `concept/use { concept, tool, input }` wrapper | Re-reads the hint and checks the caller's grant: explicit intent, but it needs the grant list on `ctx`, shadows every tool, and must re-implement `approve:` | Not v1; the upgrade if §3's matching is too loose |

For the demo, the matter agent holds `graph/graph-get`, `graph/walk` and
`sheets/*`. It reads "Drafting rules", sees `sheets/*` offered, and calls
`sheets_create_spreadsheet`, a tool it already had.

### 2.3 Limits (a Concept is data anyone with a write door can edit)

- **No hint adds a tool.** The tool set is fixed when the agent step
  starts; nothing in a tool result changes it.
- **No hint's `input` is applied.** The model writes its own call, so a
  page cannot slip `serviceAccount` or `driveFolderId` into `sheets/*`.
- **Gates hold.** It is an ordinary call: a step in `approve:` still
  becomes a proposal, `meta/run-workflow` refuses a sealed workflow, and
  `reach.ts` applies inside AI-published workflows.
- **Hint text is framed as the workspace's notes,** as `context/concept`
  frames docs. `label` and `when` are capped at 200 chars.
- **Matter agents take the narrow posture:** grant the steps their pages
  may name (`sheets/*`, `docx/*`, `courtlistener/*`), not
  `meta/run-workflow`, so an edited page only reorders choices in that
  set. A per-workflow grant (`agentTools: ["workflow/<name>"]`) would
  narrow option ii; it is not in v1.

## 3. Visibility: the handoff event

No new event type, so every log, tail, fold and resume carries it as is.
Two fields go on events that exist:

1. **Offered.** A read's `step.end.nodes[]` entry carries `tools` (§2.1),
   and so does a `walk:hop` candidate.
2. **Picked.** `wrapToolsWithEmit` keeps, for the agent's turn, every hint
   an earlier call returned, keyed by tool name. The hint's `name` goes
   through `toolNameFor` (`src/steps/core/agent.ts:411`), and a glob
   matches by prefix. A workflow hint matches a `meta/run-workflow` call
   whose `input.name` is that workflow. A matching call's `step.start`
   gets one more field:

```json
{ "type": "step.start", "path": "matter/review/014-sheets_create_spreadsheet",
  "stepType": "tool:sheets_create_spreadsheet", "toolCallId": "toolu_…",
  "input": { "title": "NDA deviation matrix — Acme" },
  "concept": { "ref_id": "…", "name": "Drafting rules", "label": "Deviation matrix",
               "hint": "sheets/*", "offeredBy": "matter/review/013-graph_graph_get" } }
```

When several pages offer one tool, the latest read wins. The claim is
narrow and true by construction: this call is to a tool this page offered,
after the agent read it. It never says "because of"; option iv would.

**The live walk view draws:**
- the Concept nodes from the walk's hops;
- a dim satellite, "Deviation matrix", when a page arrives with `tools`;
- a solid edge, "Drafting rules → Deviation matrix", at the stamped
  `step.start`;
- the result at its `step.end`. Its output is the spreadsheet id, which
  the work-product contract makes a shelf item and SheetView opens.

Each later `sheets/*` call is stamped too and hangs under the same
satellite, so the view pulses it while `sheets/update-values` fills rows.
For a workflow hint, the satellite links to the child run named in the
call's output.

## 4. Authoring and review

| Way | What it takes | When |
|---|---|---|
| **By hand** | `graph/edit-node { ref_id, properties: { tools } }` or jarvis `POST /v2/nodes/<ref_id>`. Hive Learn's proposals carry only description and docs, so it needs a field of its own (a Hive change). | v1 |
| **Front matter** | `tools:` in a seeded or package Concept file: a legal package ships "Drafting rules" with its link and the steps it names | v1 |
| **The builder** | One line in the `Workflow Builder` page: after publishing a workflow that does a page's work, propose the link with `graph/edit-node` | Next |
| **A suggestion pass** | A seeded workflow, `concept-tools-suggest { root }`. For each Concept under `root` with no `tools`: candidates are workflows (graph search on `StrutWorkflow` by the page's description) and steps (`searchSteps`, `src/search.ts`). jev judges "would this tool do this page's work?"; above a threshold, a gated `graph/edit-node` makes one proposal per page. | After the demo, on an automation |

**Review is the proposals primitive** (`plans/proposals.md`). A gated
`graph/edit-node` records the change with its `rationale`; a person
accepts or rejects it on strut's run overview or Hive's card, and strut
applies it on accept. The pass checks each name against the registry and
the published workflows before proposing, so no card offers a dead link.
A target renamed later just makes no call possible, and the next pass
lists it.

## 5. First slice (one strut PR, built for the demo)

1. **The field.** Declare `tools` on Concept on both engines (§1). Add
   `parseConceptTools` and hint matching in `src/concept-tools.ts`, with
   offline tests, and `tools:` front matter in `seedConcepts`.
2. **The reads.** `graph-get` returns page and child `tools`; `walk` puts
   them on candidates and output nodes and adds "offers" to the snippet;
   `AccessedNode.tools`. Tests in `walk.test.ts` and the graph-get suite on
   a Ladybug file.
3. **The stamp.** In `wrapToolsWithEmit` (§3). An agent-step test with a
   stand-in provider: graph-get returns a page offering `sheets/*`, and
   the next `sheets_*` call's `step.start` carries `concept`.
4. **Demo data on swarm38.** One `graph/edit-node` on "Drafting rules"
   with the §1 hint, and docs naming the matrix's columns (clause, our
   rule, their text, deviation, risk, proposed redline). The matter agent
   grants `graph/graph-get`, `graph/walk`, `sheets/*`, `docx/*` and
   `courtlistener/*`. The live walk view and SheetView, built in their own
   sessions, fold §3's fields.

Left out of the slice: the builder line, the suggestion pass, Hive
Learn's field and option iv.

## Not in v1

- **Hints a DAG step hands an agent.** A `graph/walk` step whose `nodes`
  go into an agent's prompt shows them as offered on its own `step.end`,
  but the agent saw no read, so its calls are not stamped.
- **Hints in a system prompt** from `context/concept`: not tracked, for
  the same reason.
- **Queries across pages** ("every page that uses CourtListener") scan a
  JSON string until option c is wanted.
