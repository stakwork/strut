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
  examples. The `git/*` steps take it one step further: no token or secret
  name in their config at all. Each reads the run's token for its
  repository's HOST (`gitAuthOf(ctx, url)` in `_shared.ts` → `secrets.git`,
  src/git-hosts.ts): `GITHUB_TOKEN` for github.com, a package's
  `provides.git` secret for another host, none for a host no secret serves
  — so a token goes to its own host alone, whoever names the URL (a
  workflow, an agent's tool call, a package's step). `tokenSecret` is gone
  (2026-11-20); a config that still passes it is ignored.
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

### `src/steps/lib/btc/`

btc/price (`effect: "read"`): the live price of bitcoin. Input `{ currency = "USD" (case-insensitive), sats? }`; output `{ currency, perBtc (fiat per 1 BTC), at (ISO time of the figure), source (host), cached, fiat? }` (`fiat` = `sats` valued). USD EUR GBP CAD AUD JPY CHF and whatever the sources quote; one neither quotes is an error naming that list. Reads mempool.space (`urlRateSource`, `currency`), falling back to Coinbase (`coinbaseRateSource`, no time of its own so `at` is the read time) when the first throws, answers non-200 or a bad reading. A figure is kept 60 s per currency (`cached: true`, no request), concurrent reads share one request, and a failing source never serves a stale figure (`staleMs: 0`). Only `ctx.services.http`; the caches live in a `createBtcPrice(http, { now })` reader held per http capability in a WeakMap (tests inject a clock). VISITORS: `http` is in `VISITOR_SERVICES`, so a signed-in visitor may call it through `POST /public/mcp` `step_run` when the app grants it (`grants.steps`, as strut/worker and strut/staff do) AND the public view lists it under the app's `reads` (the Publish dialog pre-checks it, being a read; an already-public app needs it ticked once). Tests: price.test.ts (stubbed http), price.door.test.ts (visitor door), price.live.test.ts (`npm run test:btc-price`, real sources).

### `src/steps/lib/git/`

git/remote-head (one `git ls-remote --symref <url> HEAD`, no clone, nothing written: `{ branch, head }`, the remote's default branch and its full commit; `remote_denied:` / `remote_not_found:` / `remote_unreachable:` / `remote_empty:`; what a list of repositories checks on a schedule, stadeum/code's `check`), git/checkout (a fresh isolated working copy per run: credential-free bare cache under <dataDir>/repos — the remote's branches fetched into `origin/*`, so a branch an agent makes in a working copy is its own and no other run's `fetch --prune` deletes it; a cache from before that, a `clone --bare` mirror, is moved over at its next checkout — + a detached worktree INSIDE THE RUN'S OWN DIRECTORY — <artifacts>/<runId>/<repo>, the dir job/dir hands a run with no job, so `cwd: "{{ dir.path }}"` holds the repositories with or without a job; <dataDir>/worktrees/<runId> only on a bare bag with no artifacts capability — removed by ctx.onRunEnd — or, with `workdir`, a KEPT one inside a job's directory, <dataDir>/jobs/<name>/<repo>, reused by the next run that names it, one run at a time (`job_busy:`), the repository removed when the job is idle; the token — the run's for the repository's host — reaches git through the child env + an inline credential helper that answers that host ONLY, so a redirect elsewhere gets nothing; git gets no credential of the machine's: helpers reset, no askpass, no system config, HOME=/dev/null so no ~/.gitconfig or ~/.netrc, no ssh — except on a person's own machine, `STRUT_GIT_LOCAL=1`, where a run with no token for the host keeps the machine's own setup; a token wins either way), git/diff (stage all, one unified diff, caps, gitleaks when on PATH), git/apply (a unified diff on stdin, --index --check then --index, `patch_conflict:` when it no longer applies, sha256 of the bytes as given) and git/push (the token for origin's host — `git remote get-url --push origin`; commit the index as the token's GitHub identity — GET /user via ctx.services.http, only with GitHub's own token, the one https://github.com gets, else the author is "strut" — push HEAD to a new branch, never --force, never origin's default branch — asked of the remote at the push — and only from a working copy git/checkout made for this run or its job, its top level under the run's own directory or `<dataDir>/jobs/<job>` and its repository one of the caches under `<dataDir>/repos/`, symlinks resolved (`notOwnWorkingCopy`; docs/security.md "A package's grant of strut's steps"); `push_rejected:` / `no_push_permission:`). The landing primitives (plans/code-change.md §6): the error codes are a contract hive classifies on. _shared.ts: the git runner over ctx.services.shell, parseRepo, one lock per cache

### `src/steps/lib/ssh/`

ssh/keygen: the public half of the SSH key a job's shell logs in with (the agent step's `sshKeys`, docs/agent-step.md), made the first time it is asked for. No input. An `SSH_KEY` the run already resolves (the principal's own, else the server's, else env) is the answer, never replaced: `{ publicKey, fingerprint, created: false }`. Otherwise it makes an Ed25519 key in code and stores the private half through `secretBlanks.fill("SSH_KEY", pem, ctx.principal)` — the principal's actor secret, or the server's blank when the run has none — and answers with the public half, `created: true`; a run that loses the race to fill it answers with the winner's. The private half is in no output, event, file or prompt. One key per person: adding the public half to a server's `authorized_keys` is that person's consent, removing it revokes. Needs strut's own secret store (`secretBlanks`). A tool of the `job` workflow

### `src/steps/lib/docx/`

docx/to-html and docx/redline: Word files in JavaScript, no pandoc and no npm dependency (_zip.ts: ZIP over node:zlib, the src/tar.ts precedent; _xml.ts: an XML tree that serializes back as it read, so untouched parts of `document.xml` stay as Word wrote them; _docx.ts: the package's parts by relationship, and where a step's file lives — this run's files, the job's directory on a job run else its artifacts, or another's by served link; writes only into this run's own). to-html (_html.ts): headings (style or outline level), Word's own list numbers as text ("12.3", "(b)") so a citation matches, bullets as nested `<ul>`, tables with merged cells, links, inline marks; tracked changes as `<ins>`/`<del>` with `datetime`, `title` and `data-author` (DocumentView keeps the first two, kit/src/folds/document.ts) and as `changes`; comments, footnotes and endnotes as numbered notes `[n]` listed at the end and as `notes` (a comment's anchor is its range's text, changes accepted); `text` is the document with every change accepted; `out` writes the HTML as a page. redline (_redline.ts): each edit's `find` matched in a body paragraph's shown text across runs, links and content controls (exact, then with curly quotes / dashes / no-break spaces read as plain), `paragraph` picks among matches, `all` takes every one; the difference from `replace` goes in by whole words (numbers whole, the brackets and signs stuck to a replaced word with it, changes a wordless gap apart joined) as `w:del` + `w:ins` (author, date, each its own id; deleted runs keep their formatting, the insertion takes the first one's); `reason` + `sources` become one Word comment over the whole match (made, related and typed when the file has none), its marks outside anyone else's revision. Refused, with the reason and the paragraphs seen: not found (or a near miss in case or spacing), ambiguous, text inside a tracked change already there or a field's result, a span over a picture or note reference — nothing of that edit is written. docx.test.ts builds its .docx fixtures in code and reads a redline back through pandoc when it is installed

### `src/steps/lib/sheets/`

sheets/create-spreadsheet, update-values, batch-update-values, get-values, add-sheet, import-spreadsheet: Google Sheets over raw REST through `ctx.services.http` (moved from the mcp lab's seed, 2026-10-16). get-values' `grid: true` is ONE `spreadsheets.get` (title, tabs, and per cell display text, value and formula; an empty range = the first tab whole) — what strut/views' SheetView polls, under Google's 60 reads a minute. _shared.ts signs the service-account JWT (spreadsheets + drive scopes) from GOOGLE_SERVICE_ACCOUNT_JSON, the gdrive/* steps' secret, and a new spreadsheet goes into GOOGLE_DRIVE_FOLDER_ID when set. An API error is a string the agent reads; only missing or invalid credentials throw, worded as "unavailable here, go on without them". Grant with `agentTools: ["sheets/*"]`
