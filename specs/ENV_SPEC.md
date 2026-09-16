# Environment Spec — the tools a workflow can call

**Status: proposed, not implemented.** Supersedes the *Promote* paragraph of
EVOLVE_SPEC §4.2 (build-time `env.manifest`); §4.1's reasoning stands and is
the constraint this design satisfies. Companion to SPEC.md §4.1.8 (`exec`),
AGENTS.md "Shell (subprocesses)" and "Artifacts".

## 1. Problem

The `exec` step spawns whatever is on `PATH`. Python libraries already have
a runtime story: a PEP 723 header in the script, `uv run` installs them on
the fly, `uv lock --script` pins them, and the workflow version therefore
fully describes its own Python environment. Native binaries — `ffmpeg`,
`tesseract`, `poppler`, `pandoc` — have no story. Today they come from
`mcp/Dockerfile`, edited by hand and rebuilt by CI, and a workflow that
needs one the image lacks simply fails at `command not found`.

The requirement that breaks the build-time answer: **the AI builder on a
production server must be able to add a binary for the workflow it is
authoring, in the same chat turn, without a rebuild of its own container.**
And the result must still be

- **persistent** — survive a container restart;
- **attributable** — pinned and versioned, so a graded run can say exactly
  which environment produced its score (EVOLVE_SPEC §4.1 reason 1);
- **reviewable** — a diff a human can approve or roll back, not a mutation
  buried in a shell history;
- **contained** — no root, nothing outside strut's own directories, on
  servers and on the desktop alike.

## 2. Design in one paragraph

The **manifest** is a versioned workspace document, like a workflow. The
**prefix** is a directory under `dataDir` that a user-space package manager
(pixi, over conda-forge) builds *from* the manifest and its lockfile. A
**sync** reconciles the prefix to the active manifest version at startup
and after every change; because `dataDir` is on the persistent volume, the
sync is a no-op across restarts and a deterministic rebuild on a fresh
volume. Every child process strut spawns — the `exec` step, the agent's
`bash`, the builder's `bash` — gets the prefix's activation environment
merged into its scrubbed env, so binaries are simply on `PATH`. The builder
gets `env_add` / `env_remove` tools that publish a new manifest version and
sync it; they are chat tools, not steps, so a running workflow can never
install anything. Each run records the manifest version it ran under.

SPEC §10 already splits the **engine image (immutable)** from the
**workspace (mutable, persistent)**. This design keeps that split: the image
only carries `pixi` and `uv`; everything a deployment learns it needs lives
on the volume, versioned.

## 3. What goes where

| Need | Mechanism | In the manifest? |
| --- | --- | --- |
| Python library (opencv, pandas) | PEP 723 header + `uv run`; `uv lock --script` to pin | No |
| Python-published CLI called by name as `cmd` (yt-dlp) | manifest, so it is on `PATH` | Yes |
| Node CLI | `npx -y`, or `nodejs` in the manifest | Only if called by name |
| Native binary (ffmpeg, tesseract, poppler, pandoc, imagemagick, sox, exiftool, graphviz, gh, ripgrep, git) | manifest → conda-forge | Yes |
| Not on conda-forge (chromium, a vendor SDK) | build-time only: Dockerfile / host install; listed as `external` so the drift check still covers it | As `external` |
| Credentials | never here — `secretsEnv` (AGENTS.md "Secrets") | No |

Rule of thumb for the builder: *if a workflow names it as `cmd`, it belongs
in the manifest; if a script imports it, it belongs in the script.*
Everything in EVOLVE_SPEC §4.4's baseline is on conda-forge; `chromium` is
the known exception, hence `external`.

## 4. The manifest

Strut's own small document, `env.yaml`, from which the pixi manifest is
*generated*. Keeping the stored format ours decouples the workspace from
pixi's schema and leaves room for `external`; pixi remains an
implementation detail that could be swapped.

```yaml
# env.yaml — versioned in the workspace store like a workflow
channels: [conda-forge]           # deployment-configurable, never by the builder
platforms: [linux-64, osx-arm64]  # every platform this workspace is used on
packages:                         # installed into the prefix by sync
  ffmpeg: ">=6"
  tesseract: "*"
  poppler: "*"
  yt-dlp: "*"
external: [chromium]              # expected on PATH from the image/host; checked, not installed
```

Generated `pixi.toml` (materialized, never edited by hand):

```toml
[workspace]
name = "strut-env"
channels = ["conda-forge"]
platforms = ["linux-64", "osx-arm64"]

[dependencies]
ffmpeg = ">=6"
tesseract = "*"
poppler = "*"
yt-dlp = "*"
```

**A version is the pair `env.yaml` + `pixi.lock`.** The lock is what runs
actually execute against — every package pinned to a build string with a
sha256 — so the lock is part of the reviewed, rolled-back object, never
regenerated on the fly. Publishing is content-hashed and labeled
`v1, v2, …` exactly like workflows (SPEC §11); there is one document per
workspace, named `env`.

- **fs backend:** `<workspace>/env/env.yaml`, `<workspace>/env/pixi.lock`,
  history under `<workspace>/env/_history/<vid>/`, an `env` entry in
  `_metadata.json`.
- **graph backend:** one node type for the env version, stored the way
  workflow versions are (plans/generic-storage.md label registry gains one
  row). Same content-hash ids.
- **Rollback:** `setActiveEnvVersion` on the store; `set_active_version`
  gains `kind: "env"`.

`platforms` matters: pixi resolves the lock for every listed platform at
once (a solve, no download), so a lock produced on a Linux server is valid
on an Apple-silicon desktop that opens the same workspace. `env_add`
always includes the current platform.

## 5. The prefix and the sync

Everything under `<dataDir>/env/` is **derived and disposable**:

```
<dataDir>/env/
├── pixi.toml            # materialized from the active env.yaml
├── pixi.lock            # materialized from the active version
├── .pixi/envs/default/  # the prefix: bin/, lib/, share/ …
├── activation.json      # captured child-env delta (§6)
├── pixi-cache/          # PIXI_CACHE_DIR — package downloads survive restarts
└── uv-cache/            # UV_CACHE_DIR — PEP 723 environments survive restarts
```

`envSync()`:

1. Materialize the active version's `env.yaml` → `pixi.toml`, and its
   `pixi.lock`.
2. `pixi install --locked --manifest-path <dataDir>/env/pixi.toml`. `--locked`
   makes pixi **fail** if the lock does not satisfy the manifest, rather
   than silently re-resolving — a stored version is either reproducible or
   it is an error, never "approximately what was reviewed".
3. `pixi shell-hook --json` → `activation.json` (§6).
4. Check `external` binaries on `PATH`; record what is missing.

Properties:

- **Idempotent and cheap when nothing changed.** pixi compares the prefix
  to the lock; a restart on a persistent volume is a no-op. A fresh volume
  downloads from the channel once (seconds to a minute for the baseline)
  and keeps the packages in `pixi-cache/`.
- **State machine:** `syncing → ready | error`. Exposed on `GET /health`
  as `env: { state, version, missing: [...] }` and in the UI (§8).
- **When it runs:** at `createStrut()` (kicked off, not awaited — the
  server is reachable immediately), and after every `env_add`,
  `env_remove`, and `set_active_version(kind: "env")`. One sync at a time;
  a change during a sync queues the next one.
- **Runs wait for an in-flight sync, never for a failed one.**
  `strut.run()` awaits `env.ready` before its first step so a run never
  sees a half-built prefix; if the last sync *failed* (offline, bad lock),
  runs proceed against whatever the prefix currently is and the run record
  carries `env.drift: true`. Blocking every run on an air-gapped server
  would be worse than an honest flag.

## 6. Child environment (shell.ts)

`minimalEnv()` (shell.ts) stays the single place every subprocess gets its
env, and stays an allowlist — this spec adds *one* sanctioned layer on top
of it, configured once by `createStrut`:

```ts
configureChildEnv({ activation: <activation.json>, env: { UV_CACHE_DIR, PIXI_CACHE_DIR } });
```

The activation JSON is what `pixi shell-hook --json` reports for the
prefix: a `PATH` prepend plus the handful of variables some tools need
(`TESSDATA_PREFIX`, `GDAL_DATA`, …). Capturing it **once at sync time** and
merging it into every child env is what makes the exec step, the agent's
`bash`, and the builder's `bash` all see the same tools with zero
per-spawn overhead — no wrapping every command in `pixi run`, no coupling
of the shell primitive to pixi at all. Library consumers who never call
`configureChildEnv` get today's behavior unchanged.

Ordering inside `PATH`: prefix first, then the host's. A workspace that
pins `ffmpeg >=6` beats a host's stale `/usr/bin/ffmpeg`, which is the
point of pinning.

## 7. Builder tools (src/ai/tools.ts)

All are chat tools behind the same API key as publishing. **None is a
step**, so nothing in the registry — and therefore no `agent` step, no
`meta/*` author, no prompt-injected workflow — can install anything. That
is the mechanism behind EVOLVE_SPEC §4.1 reason 3, not a prompt rule.

- `env_list()` → active version, each package with its resolved version and
  build, platforms, sync state, `external` with present/missing.
- `env_add(packages: string[])` → `pixi add --no-install <pkgs>` on a
  scratch copy of the manifest (this is the solve: an unknown package
  fails *here*, with the channel's message), publish the resulting
  `env.yaml` + `pixi.lock` as a new version, activate it, run the sync,
  await it (bounded — a minute on a warm cache), and return `env_list()`.
  The whole loop is one tool call: *"needs tesseract"* → *"tesseract 5.3.4
  is on PATH, v4"*.
- `env_remove(packages: string[])` → the inverse. Removing a package a
  published workflow names as `cmd` is allowed but warned (the validator
  knows — §9).
- `set_active_version(kind: "env", name: "env", version)` → rollback, then
  sync.

Prompt guidance (prompts.ts, alongside the `exec` and `ctx.services.shell`
text): on `command not found` from `run_step` / `run_workflow`, call
`env_list`, then `env_add`; Python *libraries* go in the script's PEP 723
header, not the manifest; never `pip install`, `apt`, or `brew` through
`bash` expecting it to persist — it will not, and it is not what runs use.

## 8. UI

- **Environment panel** next to Secrets: the package list, resolved
  versions, `external` status, sync state, and the version history with
  the same rollback control workflows have.
- **Drift warning** in the topbar when `env.state === "error"` or an
  `external` is missing, with the reason (offline, lock mismatch, missing
  binary) and — on the desktop — the fix.
- **Run view:** the env version each run used, from the run record.

## 9. Attribution and evals

- `run.json` (SPEC §7.3) gains `env: { version: "v4", lockHash, drift }`.
  The journal / event log need nothing: the version is a run-level fact.
- EVAL_SPEC batches record `env.version` beside `benchmarkRev` and
  `scorerSha256`. A run whose `env.version` differs from the batch's
  declared one, or that has `drift: true`, is **unattributable** and scored
  as such (flagged, not silently compared).
- EVOLVE_SPEC layer 2 becomes: *capture* (`env/missing-tools` over recent
  runs — unchanged), *propose* (`env_add` on a candidate, producing a
  version), *promote* (`set_active_version`). Whether a human must approve
  an env version before graded runs may use it is a deployment **policy**
  (a publish gate), not a mechanism this spec fixes.
- **Optional, cheap, recommended:** a workflow may declare
  `requires: [ffmpeg, yt-dlp]` — the binaries it calls by name. The static
  validator (`validate.ts`) errors when a `requires` entry is neither in the
  active manifest's packages nor `external`, and warns when an `exec`
  step's literal `cmd` is missing from `requires`. Demand (workflow) and
  supply (manifest) are then both versioned and checkable before a run.

## 10. Security

- **Sources.** `channels` is deployment configuration (`STRUT_ENV_CHANNELS`
  / `StrutOptions.env.channels`, default `conda-forge`); the builder can
  add packages, never channels or URLs. The lock pins each package to a
  sha256 and `--locked` installs verify it. conda-forge is a curated
  channel, but this is still third-party code executing on the server —
  the same class of trust as an npm dependency a custom step imports.
- **Authority.** `env_*` require the API key. A prompt-injected *builder*
  could add a package it read about on a web page; that residual is the
  same as `create_step` today and is bounded the same way — the change is
  a reviewable, rollback-able version, and the optional publish gate in §9
  closes it entirely for deployments that want that.
- **Containment.** No root, nothing written outside `dataDir`; the Docker
  image can stop running as root once `apt` is out of the loop. Env
  scrubbing (AGENTS.md "Secrets") is untouched: activation adds `PATH` and
  tool variables, never credentials.

## 11. Desktop

Same mechanism, `dataDir` = Application Support. `pixi` is a static binary
and ships in the bundle's `native/` directory so it is code-signed with the
rest (plans/local-desktop-and-stt.md §2.3) — preferred over downloading it
on first use like STT models, to keep Gatekeeper out of the picture. Nothing
touches Homebrew or `/usr/local`; uninstalling strut removes every tool it
installed. `platforms` lists `osx-arm64` (and `osx-64` if Intel ships). The
first `env_add` on a laptop downloads, later launches do not.

## 12. Bootstrap

- **Image:** `pixi` + `uv` + `git` + `bash`, nothing else. The persistent
  volume is mounted at `dataDir`.
- **First boot on an empty volume:** sync builds the prefix from the
  active lock. A deployment seeds its initial `env.yaml` the way it seeds
  workflows; the lab's seed is EVOLVE_SPEC §4.4's list minus what PEP 723
  now covers.
- **`mcp/Dockerfile`** shrinks to the bootstrap above plus any `external`
  entries; it stops being the place environment knowledge lives.

## 13. What does not change

The `exec` step and `ctx.services.shell` contracts, the env-scrubbing
allowlist, the secrets boundary, the immutable engine image, the artifacts
convention, and the runner. This spec adds one versioned document, one
derived directory, one activation layer in `minimalEnv`, three chat tools,
one field on the run record.

## 14. Implementation order

1. `configureChildEnv` in shell.ts + `UV_CACHE_DIR` / `PIXI_CACHE_DIR`
   under `dataDir` — makes the mechanism real with a hand-written prefix
   before any tooling exists.
2. `envSync()` + `/health.env` + `strut.run()` waiting on an in-flight sync.
3. The `env` document in both `WorkspaceStore` implementations, with
   versioning, and `set_active_version(kind: "env")`.
4. `env_list` / `env_add` / `env_remove` + prompt guidance.
5. Run record field; EVAL/EVOLVE hooks; the optional `requires` check.
6. UI panel + drift warning; desktop bundling of `pixi`.

## 15. Open questions

- **pixi vs micromamba.** pixi has the lockfile, the `--locked` contract
  and `shell-hook --json` built in; micromamba would need conda-lock
  alongside. pixi unless a blocker appears in step 1.
- **Windows.** conda-forge has `win-64` and pixi runs there; the open
  question is the agent's `bash` tool (desktop plan §2.2 item 6), not this
  spec.
- **Several workspaces on one server** each get their own prefix under
  their own `dataDir`. Whether a shared package cache across them is worth
  the cross-tenant coupling is a later call; default is per-workspace.
- **Publish gate for env versions** in graded deployments — policy, see §9.
