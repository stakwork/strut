<h1 align="center">strut</h1>

<p align="center"><strong>An agent-native workflow engine.</strong><br/>
Workflows are YAML. Steps are TypeScript. Runs are JSONL on disk.<br/>
Ships with an HTTP API, a visual editor, and an AI builder that writes workflows for you.</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#workflows">Workflows</a> ·
  <a href="#steps">Steps</a> ·
  <a href="#agents">Agents</a> ·
  <a href="#web-ui">Web UI</a> ·
  <a href="#http-api">HTTP API</a> ·
  <a href="#use-as-a-library">Library</a> ·
  <a href="#architecture">Architecture</a>
</p>

---

strut runs workflows that are small enough for a person to read and regular enough for an LLM to write. A workflow is one YAML file: an ordered list of steps, each with a type, a config, and optional dependencies. Templates like `{{ input.repo }}` wire step outputs together. Every step start, end, and error is appended to a JSONL log, so a run can be inspected, tailed, replayed, or resumed after a crash.

The step catalog is where the work happens. Ten core steps cover HTTP, logging, branching, loops, sub-workflows, LLM calls, and full agent loops. Library steps add integrations (GitHub, Slack, Google Drive, a Neo4j knowledge graph). Custom steps are `.ts` files dropped into the workspace at runtime, by you or by the built-in AI builder, and are usable immediately.

There are three ways to use it:

1. **Run the server.** HTTP API plus the web UI on one port.
2. **Embed it.** `createStrut()` returns a Hono app and a `run()` function you can mount inside your own service.
3. **Package it for the desktop.** A self-contained tarball with local speech-to-text and no environment to configure.

## Quick start

Needs Node 22 or newer.

```bash
git clone https://github.com/stakwork/strut.git
cd strut
npm install
npm --prefix web install
```

Create a `.env` in the repo root:

```ini
STRUT_WORKSPACE_BACKEND=fs      # keep workflows on disk (see "Graph backend" below)
ANTHROPIC_API_KEY=sk-ant-...    # for llm/agent steps and the AI builder
```

Then start it:

```bash
npm run dev
```

Open http://localhost:3000. Create a workflow in the UI, or publish one over HTTP:

```bash
curl -X POST localhost:3000/workflows/hello \
  -H 'Content-Type: application/json' \
  -d '{ "version": "v1", "yaml": "name: hello\nsteps:\n  - id: greet\n    type: log\n    config:\n      message: \"Hello {{ input.name }}!\"\n" }'

curl -X POST localhost:3000/workflows/hello/run \
  -H 'Content-Type: application/json' \
  -d '{ "input": { "name": "World" } }'
```

`npm test` runs the unit suite in about a second.

## Workflows

A workflow is a named list of steps. Steps run in order unless `depends` says otherwise. Any string in a config can hold a `{{ }}` expression that reads the run's `input`, the workflow's `params`, or the output of an earlier step.

```yaml
name: review-pr
steps:
  - id: fetch
    type: github/fetch-pr
    config:
      owner: "{{ input.owner }}"
      repo: "{{ input.repo }}"
      pull_number: "{{ input.number }}"

  - id: review
    type: llm
    config:
      model: "{{ params.model }}"
      prompt: |
        {{ params.instructions }}

        {{ fetch.markdown }}

  - id: notify
    type: slack/post-message
    config:
      channel: "#code-review"
      text: "*{{ fetch.pr.title }}*\n{{ review.text }}"

# tunable knobs, overridable per run
params:
  model: claude-sonnet-5
  instructions: You are a senior engineer reviewing a pull request. Be concise.
```

Run it with an input, and optionally override a knob for just this run:

```bash
curl -X POST localhost:3000/workflows/review-pr/run \
  -H 'Content-Type: application/json' \
  -d '{ "input": { "owner": "stakwork", "repo": "strut", "number": 42 },
        "params": { "instructions": "You are a paranoid security auditor." } }'
```

A few rules that make the format predictable:

- **`depends` builds the DAG.** Omit it and a step waits for the previous one. `depends: []` runs immediately. `depends: [a, b]` waits for both. Steps with the same dependencies run concurrently. There is no `parallel` step.
- **`input` is the subject, `params` are the knobs.** Input is validated per run and has no defaults. Params are all defaults, shallow-merged with per-run overrides. A hundred prompt variants are a hundred runs, not a hundred workflow versions.
- **Templates are quoted.** YAML reads a bare `{{` as a mapping, so write `pull_number: "{{ input.number }}"`. A lone expression keeps its real type; a number stays a number.
- **Workflows are versioned.** Publishing writes `v1.yaml`, `v2.yaml`, and so on. One version is active; any can be run or rolled back to.

## Steps

Every step is a `defineStep()` export with a Zod input schema, an output schema, and a `run()` function. The schemas drive the UI's config forms and the AI builder's tool descriptions.

**Core steps** are always loaded:

| Type      | What it does                                                                 |
| --------- | ---------------------------------------------------------------------------- |
| `http`    | Request a URL. Output is `{ status, body }`.                                 |
| `log`     | Emit a message at `info`, `warn`, or `error`.                                |
| `if`      | Evaluate a condition. Downstream steps branch with `when: true` or `false`. |
| `loop`    | Repeat a body step until an expression over the last output is true.        |
| `foreach` | Run a body step per item, with optional bounded concurrency.                 |
| `subflow` | Run another published workflow by name and version.                          |
| `wait`    | Sleep for a duration.                                                        |
| `pack`    | Assemble one object from several step outputs.                              |
| `llm`     | One model call. Free text, or structured output from a schema.               |
| `agent`   | A tool-using agent loop. See [Agents](#agents).                              |

**Library steps** ship with the engine but load their SDKs lazily, so a workflow that never touches Slack never loads the Slack client. Namespaces today: `github/*`, `slack/*`, `gdrive/*`, `html/*`, `graph/*` (a Neo4j knowledge graph), and `meta/*` (steps that author, run, and inspect other workflows and steps).

**Custom steps** live in `<workspace>/steps/custom/`. Write one, and it is in the registry on the next rebuild:

```ts
// workspace/steps/custom/word-count.ts
import { z, defineStep } from "strut";

export default defineStep({
  type: "word-count",
  input: z.object({ text: z.string() }),
  output: z.object({ words: z.number() }),
  async run(cfg) {
    return { words: cfg.text.trim().split(/\s+/).length };
  },
});
```

Custom steps are versioned like workflows, and `POST /steps` publishes one over HTTP. Credentials reach steps through `ctx.services.secrets`, backed by an encrypted secret store managed from the UI, never through `process.env` directly.

## Agents

The `agent` step runs a model in a tool loop. Its built-in tools are a shell, a map of the working directory, and full-text search over it. Beyond those, **tools are steps**: name any registry step types in `agentTools` and each one becomes a tool, with the step's input schema as the tool schema and its `run()` as the executor. Every tool call is logged as a nested step in the run.

```yaml
- id: triage
  type: agent
  config:
    cwd: "{{ input.repoDir }}"
    system: You are a release engineer.
    prompt: Find the failing test and explain the root cause.
    agentTools: ["github/*", "graph/graph-search"]
    finalAnswer: The root cause, in two sentences.
```

Glob patterns grant a whole namespace, and new steps in it are picked up automatically. Secrets an agent needs in shell commands are injected as environment variables by name and masked from every tool output before the model sees it.

The same machinery powers the **AI builder** in the web UI. It is an agent whose tools are the `meta/*` steps, so it can search the step catalog, write a custom step, publish a workflow, run it, read the events, and iterate. Chats run detached on the server and survive a page reload.

## Web UI

Served from the same port as the API.

- **Canvas editor.** Workflows render as a DAG. Drag to connect steps, click a node to edit its config, add steps from a searchable picker.
- **Runs.** Trigger a run with an input payload, watch the event stream live, and see each node turn green, red, or yellow. Cancel, pause, and resume long runs.
- **Versions and params.** Browse a workflow's published versions from the topbar. Edit its `params` in a flyout and publish the result as a new version. After a run, review a diff before promoting a winning value into the defaults.
- **AI builder.** A chat flyout that authors workflows and steps against your live workspace.
- **Dictation.** Streaming speech-to-text runs locally over sherpa-onnx, with hotword biasing you can tune per deployment.
- **Secrets.** Add credentials once; values are write-only and encrypted at rest.

## HTTP API

| Method | Path                                          | Description                                   |
| ------ | --------------------------------------------- | --------------------------------------------- |
| GET    | `/workflows`                                  | List workflows                                |
| POST   | `/workflows/:name`                            | Publish a version from `yaml` or a `steps` array |
| PUT    | `/workflows/:name/active`                     | Set the active version                        |
| POST   | `/workflows/:name/run`                        | Run the active version with `input` and `params` |
| GET    | `/workflows/:name/runs/:runId/events`         | All events for a run                          |
| GET    | `/workflows/:name/runs/:runId/stream`         | Live SSE tail of a run                        |
| POST   | `/workflows/:name/runs/:runId/cancel`         | Cancel a run tree. `pause` and `resume` too    |
| GET    | `/steps`                                      | List core, library, and custom steps          |
| POST   | `/steps`                                      | Publish a custom step from source             |
| POST   | `/chat`                                       | Start or continue an AI builder session       |
| GET    | `/health`                                     | Workspace path and step count                 |

Set `STRUT_API_KEY` to require a bearer token on mutating routes. The full route list is in [specs/SPEC.md](specs/SPEC.md).

## Use as a library

The package builds on install, so it can be added straight from git:

```bash
npm install stakwork/strut
```

`createStrut()` is the primary entry point. Everything is injectable: the workspace store, the run store, the step registry, and a `services` bag that every step sees as `ctx.services`.

```ts
import { createStrut, createRegistry, defineStep, z } from "strut";

const wordCount = defineStep({
  type: "word-count",
  input: z.object({ text: z.string() }),
  output: z.object({ words: z.number() }),
  async run(cfg) {
    return { words: cfg.text.trim().split(/\s+/).length };
  },
});

const strut = await createStrut({
  registry: await createRegistry([wordCount]),
  services: { db },
});

await strut.listen(3000);
// or mount it inside your own Hono app:
// app.route("/strut", strut.app);

const result = await strut.run("review-pr", { owner: "stakwork", repo: "strut", number: 42 });
```

Pass `MemoryRunStore` for tests, `serveUi: false` when your app owns the routes, and `enableChat: false` to skip the AI SDK entirely.

## Graph backend

By default the server keeps workflows and steps in Neo4j and reads the connection from `NEO4J_URI` or `NEO4J_HOST` (localhost when unset). That gives the `graph/*` steps and the AI builder's read-only Cypher tool a shared knowledge graph, and lets runs and chats be projected into it for provenance queries. Set `STRUT_WORKSPACE_BACKEND=fs` to skip Neo4j and keep everything on disk. Runs, chats, secrets, and artifacts stay under `STRUT_WORKSPACE` either way.

## Desktop packaging

`npm run package:desktop -- --tar` stages a self-contained directory with the built server, the web UI, production dependencies, and the speech addon for one platform, then writes `strut-<platform>.tar.gz`. Unpack it anywhere with Node 20 or newer and run:

```bash
./strut --open
```

It binds to localhost on a free port, keeps its workspace in the platform's app-support directory, and prints one JSON line a host application can parse.

## Environment

| Variable                  | Default            | Description                                              |
| ------------------------- | ------------------ | -------------------------------------------------------- |
| `STRUT_WORKSPACE`         | `./workspace`      | Where workflows, runs, and steps persist                 |
| `STRUT_WORKSPACE_BACKEND` | graph              | `fs` keeps workflows on disk instead of Neo4j            |
| `STRUT_PORT`              | `3000`             | HTTP port. `0` lets the OS choose                        |
| `STRUT_API_KEY`           | unset              | Bearer token for mutating routes                         |
| `STRUT_SECRET_KEY`        | unset              | Encryption key for the secret store                      |
| `STRUT_LLM_MODEL`         | per provider       | Default model for `llm` and `agent` steps                |
| `STRUT_CHAT_MODEL`        | `claude-sonnet-5`  | Model for the AI builder                                 |
| `NEO4J_URI`               | `bolt://localhost:7687` | Graph backend connection                            |

The complete list, with the auth and secrets model, is in [AGENTS.md](AGENTS.md).

## Architecture

```
strut/
├── src/
│   ├── core.ts          # flow(), step(), defineStep(), types
│   ├── expr.ts          # {{ }} expression evaluator (no eval)
│   ├── runner.ts        # DAG execution, retry, control flow, journal replay
│   ├── run-control.ts   # cancel / pause / resume for run trees
│   ├── store.ts         # RunStore: JSONL events + run summaries
│   ├── workspace.ts     # WorkspaceStore: versioned workflows and steps
│   ├── createStrut.ts   # the factory: Hono routes, run launch, SSE tails
│   ├── steps/
│   │   ├── core/        # http, log, if, loop, foreach, subflow, wait, pack, llm, agent
│   │   ├── lib/         # github, slack, gdrive, html, graph, meta
│   │   └── registry.ts  # discovery: core + lib + <workspace>/steps/custom
│   ├── ai/              # the AI builder: prompt + tools over the meta steps
│   ├── audio/           # streaming speech-to-text over sherpa-onnx
│   └── graph/           # Neo4j backend: schemas, writers, search, projector
├── web/                 # Preact + Vite UI, built to web/dist and served by the engine
├── specs/               # design specs
└── scripts/             # desktop packager and launcher
```

The design lives in [specs/SPEC.md](specs/SPEC.md). Three companion specs cover [run control](specs/RUN_CONTROL_SPEC.md) (cancel, pause, durable resume), [evals](specs/EVAL_SPEC.md) (scoring a run against a gold standard), and [self-evolving workflows](specs/EVOLVE_SPEC.md) (what a workflow may change about itself, and how a change is measured and promoted). [AGENTS.md](AGENTS.md) is the guide for working on the codebase.

## Contributing

```bash
npm test                  # unit suite, node:test via tsx
npm run test:graph        # live Neo4j suite, needs STRUT_TEST_NEO4J_URI (it wipes the database)
npm run test:stt          # live speech-to-text suite, downloads a model on first run
cd web && npm run dev     # UI with hot reload on :5173, proxied to the API on :3000
```

Read [AGENTS.md](AGENTS.md) before adding a step or an endpoint. The conventions there, in particular lazy-loading heavy SDKs inside `run()`, are what keep the engine's cold start small.

## License

[Apache 2.0](LICENSE)
