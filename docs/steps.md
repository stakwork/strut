# Built-in lib steps

Lib steps that are integrations (git, http, docx, sheets) and how lib steps read credentials. Other lib namespaces are documented with their area.

This file is the reference for one area of strut; [AGENTS.md](../AGENTS.md) is the
index. A change in this area updates this file, not AGENTS.md.

## Lib step credentials

Lib steps read credentials through the secrets capability, with explicit step
config taking precedence:

```ts
const token = cfg.token ?? (await ctx?.services?.secrets?.get("GITHUB_TOKEN"));
```

- **`cfg.<field>` wins** (a workflow can pass a token via `{{ input.x }}`),
  otherwise fall through to the managed secret store / env.
- Type `ctx` as `StepContext<StrutCapabilities>` (import both from the relative
  `core.js` / `capabilities.js`) so `ctx.services.secrets` is typed. Use
  optional chaining — a bare `runWorkflow` without a services bag has no
  `secrets`.
- This also gets the step **cassette scrubbing for free**: every value read
  through `secrets.get()` is scrubbed from recorded fixtures.
- `github/fetch-pr` / `github/create-pr` (`GITHUB_TOKEN`) and `gdrive/export-file`
  (`GOOGLE_ACCESS_TOKEN` or `GOOGLE_SERVICE_ACCOUNT_JSON`) are the reference
  examples. The `git/*` steps take it one step further: no `token` config at
  all, only `tokenSecret` (a NAME, default `GITHUB_TOKEN`) — a step's config
  is recorded on `step.start`, so only a name may ride in a workflow.
- The `sheets/*` steps read `cfg.serviceAccount ?? secrets.get("GOOGLE_SERVICE_ACCOUNT_JSON")`
  (the gdrive/* secret) and `cfg.driveFolderId ?? secrets.get("GOOGLE_DRIVE_FOLDER_ID")`.
  Their missing- or invalid-credential error is written for the CALLING AGENT:
  sheets are unavailable here, do not search for keys, go on without them.
  Never "paste the key into env": that wording sent an agent searching the
  filesystem for service-account JSON.

## Files

What each file and folder in this area is, in the order of the tree.

### `src/steps/lib/`

built-in domain integrations (github/fetch-pr, github/create-pr — open a PR or return the open one for that head, github/pr-status — a PR's state and checks now, github/merge-pr — a person's merge only: strut's own page or an accepted proposal, at the head they saw, ...) — file dynamic-imported at build; heavy SDKs lazy-imported in run() (see "Lib step dependency convention")

### `src/steps/lib/http/`

http/verify: the ENDPOINT instrument (plans/job-claims.md §4) — one request over `ctx.services.http`, the check contract back: `{ supports, content, locator: { url }, status, ms, failed }`, so a check is one line of config and `mapCheckResult` needs nothing new. No `expect`: a 2xx supports; `expect` names a status (or several), response headers (substring, names case-insensitive), `contains` substrings, `json` dot paths → deep-equal, `maxMs`. The endpoint failing is a RESULT (a wrong status, 500 included, `supports: false` with `failed` naming each); the instrument failing — refused, DNS, timeout — THROWS, which the pass maps to cannot-run and writes nothing. `secrets: { Authorization: "Bearer {API_TOKEN}" }` maps a header to a value template whose `{NAME}` placeholders (single braces: the `{{ }}` engine never sees them) resolve through the secrets capability in code; a missing one throws, the values are masked out of `content` and `failed`. Grantable to the job agent, so what it saw mid-turn is what the pass records

### `src/steps/lib/git/`

git/checkout (a fresh isolated working copy per run: credential-free bare cache under <dataDir>/repos — the remote's branches fetched into `origin/*`, so a branch an agent makes in a working copy is its own and no other run's `fetch --prune` deletes it; a cache from before that, a `clone --bare` mirror, is moved over at its next checkout — + a detached worktree INSIDE THE RUN'S OWN DIRECTORY — <artifacts>/<runId>/<repo>, the dir job/dir hands a run with no job, so `cwd: "{{ dir.path }}"` holds the repositories with or without a job; <dataDir>/worktrees/<runId> only on a bare bag with no artifacts capability — removed by ctx.onRunEnd — or, with `workdir`, a KEPT one inside a job's directory, <dataDir>/jobs/<name>/<repo>, reused by the next run that names it, one run at a time (`job_busy:`), the repository removed when the job is idle; the token reaches git through the child env + an inline credential helper ONLY), git/diff (stage all, one unified diff, caps, gitleaks when on PATH), git/apply (a unified diff on stdin, --index --check then --index, `patch_conflict:` when it no longer applies, sha256 of the bytes as given) and git/push (commit the index as the token's GitHub identity — GET /user via ctx.services.http — push HEAD to a new branch, never --force; `push_rejected:` / `no_push_permission:`). The landing primitives (plans/code-change.md §6): the error codes are a contract hive classifies on. _shared.ts: the git runner over ctx.services.shell, parseRepo, one lock per cache

### `src/steps/lib/docx/`

docx/to-html and docx/redline: Word files in JavaScript, no pandoc and no npm dependency (_zip.ts: ZIP over node:zlib, the src/tar.ts precedent; _xml.ts: an XML tree that serializes back as it read, so untouched parts of `document.xml` stay as Word wrote them; _docx.ts: the package's parts by relationship, and where a step's file lives — this run's files, the job's directory on a job run else its artifacts, or another's by served link; writes only into this run's own). to-html (_html.ts): headings (style or outline level), Word's own list numbers as text ("12.3", "(b)") so a citation matches, bullets as nested `<ul>`, tables with merged cells, links, inline marks; tracked changes as `<ins>`/`<del>` with `datetime`, `title` and `data-author` (DocumentView keeps the first two, kit/src/folds/document.ts) and as `changes`; comments, footnotes and endnotes as numbered notes `[n]` listed at the end and as `notes` (a comment's anchor is its range's text, changes accepted); `text` is the document with every change accepted; `out` writes the HTML as a page. redline (_redline.ts): each edit's `find` matched in a body paragraph's shown text across runs, links and content controls (exact, then with curly quotes / dashes / no-break spaces read as plain), `paragraph` picks among matches, `all` takes every one; the difference from `replace` goes in by whole words (numbers whole, the brackets and signs stuck to a replaced word with it, changes a wordless gap apart joined) as `w:del` + `w:ins` (author, date, each its own id; deleted runs keep their formatting, the insertion takes the first one's); `reason` + `sources` become one Word comment over the whole match (made, related and typed when the file has none), its marks outside anyone else's revision. Refused, with the reason and the paragraphs seen: not found (or a near miss in case or spacing), ambiguous, text inside a tracked change already there or a field's result, a span over a picture or note reference — nothing of that edit is written. docx.test.ts builds its .docx fixtures in code and reads a redline back through pandoc when it is installed

### `src/steps/lib/sheets/`

sheets/create-spreadsheet, update-values, batch-update-values, get-values, add-sheet, import-spreadsheet: Google Sheets over raw REST through `ctx.services.http` (moved from the mcp lab's seed, 2026-10-16). get-values' `grid: true` is ONE `spreadsheets.get` (title, tabs, and per cell display text, value and formula; an empty range = the first tab whole) — what strut/views' SheetView polls, under Google's 60 reads a minute. _shared.ts signs the service-account JWT (spreadsheets + drive scopes) from GOOGLE_SERVICE_ACCOUNT_JSON, the gdrive/* steps' secret, and a new spreadsheet goes into GOOGLE_DRIVE_FOLDER_ID when set. An API error is a string the agent reads; only missing or invalid credentials throw, worded as "unavailable here, go on without them". Grant with `agentTools: ["sheets/*"]`
