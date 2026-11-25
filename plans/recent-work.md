# Recent Work: what a person has been working on, in every prompt

Status: proposed (2026-11-24). The owner ruled three points that day: the
idea (a Concept root whose pages are injected), that the lists are the
PERSON's (whoever is speaking), and the root's name, `Recent Work`. The
rest is mine, each open question with a default.

Companion: `plans/one-job-agent.md`. It grants a job the app tools, which
the pages here point to.

## The ask

Two recorded calls on stadeum.stakwork.ai (2026-11-24, Call Canvas jobs):

- **23:41, `call-de75cf304493e411`.** Asked to read experiments.md "in the
  stadium repo". The job ran `find / -name experiments.md` in bash. It
  found nine copies in other people's job folders and read one from a job a
  day old. That copy happened to be current. The job held
  `stadeum/code/repositories` and `git/checkout` and used neither: nothing
  told it that "the stadium repo" is stakwork/stadeum.
- **00:03, `call-addc3b7cc6c78da6`.** Asked for a screenshot of the trials
  UI in the Knowledge app. The job ran one graph search and gave up: "I
  don't have the knowledge app's address". Nothing told it that
  `strut/knowledge` exists.

The owner: *"How do agents know whats important? Like which
repos/workspaces or apps/workflows the user has been making prs or changes
to recently? … it should probably just be INJECTED since its so
important"*, as *"the concept as a page which lists the top 20 or so most
likely things you might be talking about: repos or apps you've edited
recently, plus instructions of the tools to find more"*. And the catch:
*"'apps' are built-in to strut and 'repos' are from a package"*.

## What strut has today

Nothing is injected. Every agent has to think to look.

| Agent | In its prompt | Tools to look |
| --- | --- | --- |
| Orchestrator turn | Its rules page, the kinds of job and build, the person's own pages when a host keeps them, the peers line | `job/list`. Packages grant tools to jobs only (`job:` in `strut.yaml`) |
| Job turn | The `Job` page, the kind's page, `input.repos` checked out | `job/list`, `graph/graph-search`, `meta/list-workflows`, a package's own (`stadeum/code/repositories`). No `app/*` |

The peers line names this server's repositories only from `STRUT_SELF`,
which a Stadeum box does not set, so it is empty there.

## Proposal

### 1. The `Recent Work` root

Strut seeds one root Concept, `Recent Work` (`src/concepts/Recent Work.md`):

> What this person has been working on lately, newest first. Each list is
> the top few; the page says how to find the rest. When a message names
> something ("the stadium repo", "the knowledge app"), match it here first.

Strut and every package hang pages under it, as they hang kinds under
`Job` today. A package needs nothing new to ship one: its `concepts/`
folder already seeds pages under any parent.

### 2. A page may name a step

A Concept gains one optional attribute, `step`: a step type. Strut runs it
as the person reading and shows its items under the page. The page's docs
are the "how to find more" part, and a person or the dream may change them
like any page's.

```markdown
---
name: Workspaces
description: The person's workspaces and the repositories in each.
step: stadeum/code/recent
parents:
  - Recent Work
---
Every workspace: `stadeum/code/repositories`. A repository in one is
checked out with `git/checkout`.
```

The contract of the step:

- It declares `effect: "read"`. Any other step is refused, with one log
  line, as `checkRunner` refuses a check that is not a read
  (`src/steps/lib/graph/_shared.ts`).
- It runs as the person (`runSingleStep` with `actor`), so it sees only
  what they may.
- It answers `{ items: [{ name, what?, at?, link? }] }`, newest first:
  - `name`: what the person would call it (`stakwork/stadeum`,
    `strut/knowledge`);
  - `what`: a few words (`your PR #109 merged`, `opened 3 times`);
  - `at`: when, ISO;
  - `link`: where to open it.

  Strut drops an item without a `name` and cuts long fields.

The attribute is declared on `Concept` in `src/graph/seed-types.ts`, with
a conformance case and `npm run test:graph`, since the graph writer
refuses an undeclared attribute. It is called `step`, not `source`:
`src/concept-sources.ts` already uses "source" for a page whose text comes
from git.

### 3. One step renders the section: `context/recent`

`context/recent { name, session? }`:

1. Reads the root and its children with `graph/graph-get`
   (`children: PARENT_OF`), then each child's page.
2. Runs each page's `step` as the person, all at once. Each run gets 2 s;
   a slow or failing one is left out, and its page still shows its docs.
   Results are kept 5 minutes per person and step, so a busy chat does not
   rerun them every turn.
3. Renders one section: the root's docs, then each page's name, its docs
   (cut at 600 characters) and its items, one line each:
   `- stakwork/stadeum: your PR #109 merged (Nov 24) <link>`. Dates are
   absolute, never "2 d ago", so the text does not change from turn to
   turn by itself.
4. Caps it: at most 8 items a page and 20 in all, the newest kept.
5. Returns `{ text, hash }`. `hash` is the hash of the text.

The renderer never names a package, a type or a domain. Apps (strut's) and
repositories (a package's) are both pages under one root, which is the
answer to "apps are built-in, repos are from a package".

### 4. Where it goes, and only when it changed

History sent to a model is append-only, and an orchestrator session lasts
for days, so the section goes in the TURN's prompt, never the frozen system
prompt:

- **Orchestrator** (`src/workflows/orchestrator.yaml`): a step beside
  `peers`. Its text goes before the person's message, after the peers line.
- **Job** (`src/workflows/job.yaml`): the same step. Its text goes after
  "Your job id", before the kind's page.

It is sent only when it changed since that session last saw it:

- The agent step gains `tags`, a small map of strings it records on the
  session's turn line (`NewTurn` in `src/session-store.ts`) and never
  reads.
- The workflow passes `tags: { recent: <hash> }`.
- `context/recent` reads the session's last turn line (`turns(id)`, the
  lines alone) and returns `text: ""` when the hash is the same and no
  compaction happened since. A compaction can drop the earlier copy, which
  `replayFrom` moving shows.

A shared conversation re-sends when a different person speaks, since their
list differs. A wake turn runs as the person who started the job, so it is
their list.

### 5. Strut's own pages

Three small pages under the root (the new page form, for `step`), each with
a read step:

| Page | Step | Items | Docs: find more with |
| --- | --- | --- | --- |
| Apps | `app/recent` | Apps the person published (`StrutAppVersion.actor`) or opened (the monitor's call log, `plans/app-calls.md`), with the address a person opens each at | `app/list`, `app/get`; `app/look` to see one |
| Workflows | `meta/recent-workflows` | Workflows the person published (`StrutWorkflowVersion.actor`) or ran (`StrutRun.actor`) | `meta/list-workflows` |
| Jobs | `job/recent` | The person's recent jobs: title, kind, repositories, whether it is still working | `job/list { q }`, `job/get` |

The Jobs page also covers repositories worked on through strut, since a
job records its `repos`. Work done anywhere else comes from a package's
page.

### 6. One line on two pages

- `Orchestrator.md`: what a person names is matched against Recent Work
  before asking or starting a job, and the repositories found there go in
  `start.repos`.
- `Job.md`: the same, before searching the disk. Another job's folder is
  never where to look.

## The packages' pages (their repos, after strut's part)

This tests the seam: each package adds one page and one read step, and
neither strut nor any other package changes.

- **stadeum/code**, `Workspaces`: the person's workspaces and their
  repositories, newest used first.
- **stadeum/github**, `Repositories`: repositories where the person opened
  or merged a pull request, or pushed, in the last 14 days. It uses their
  own token. This is the page that catches work done outside strut (a
  laptop session's PRs).
- **stadeum/canvas**, `Initiatives`: the initiatives the person wrote on
  lately.

## Decided

| # | Question | Answer | Status |
| --- | --- | --- | --- |
| 1 | Injected or looked up | Injected, as a Concept root whose pages list the top few and say how to find more | owner, 2026-11-24 |
| 2 | Whose list | The person's: whoever is speaking this turn | owner, 2026-11-24 |
| 3 | The root's name | `Recent Work` | owner, 2026-11-24 |
| 4 | How a package adds a list | A page under the root naming a read step (§2), no new `strut.yaml` field | proposed |
| 5 | Where it goes | The turn's prompt, only when changed (§4) | proposed |

## Open questions, each with a default

1. **The caps.** Default: 8 items a page, 20 in all, 600 characters of
   docs a page.
2. **Which steps a page may name.** A person can edit a page in the
   Knowledge app, and its step then runs on everyone's turns. Default: any
   step that declares `effect: "read"`. It runs as the reader, so it shows
   them only their own, and 2 s caps its cost. The alternative is only the
   page's own package's steps (strut's steps for strut's pages).
3. **A launch with no person** (a host's key, an automation). Default: no
   section.
4. **The builder.** Default: none until `plans/one-job-agent.md` folds it
   into the job, which then has the section.

## Work items, in order

1. `Concept.step` on the type, a conformance case, `test:graph`.
2. `context/recent` and the agent step's `tags`, with tests: refusal of a
   write step, the timeout, the caps, the unchanged-hash skip, the resend
   after a compaction.
3. Strut's root and three pages with `app/recent`, `meta/recent-workflows`
   and `job/recent`.
4. The step in `orchestrator.yaml` and `job.yaml`; the lines on
   `Orchestrator.md` and `Job.md`.
5. Docs: `docs/knowledge.md` (the attribute, the root), `docs/jobs.md`
   (where the section goes).
6. Check it with a real model on a scratch strut: replay the 23:41 chunk
   ("experiments.md … in the stadium repo"). The job should check out
   stakwork/stadeum, not search the disk. The 00:03 one should name
   `strut/knowledge`.

## Not in this plan

- **Ranking the graph nodes a person's runs touched.** It misses git work
  done outside strut, it is noisy (tool calls, sessions), and it would need
  a list of types, which names domains.
- **A `context:` field in `strut.yaml`.** It would put the "how to find
  more" words in YAML, where no person or dream can change them.
- **A job's shell reads every job's folder.** The 23:41 job's `find /`
  listed other people's checkouts. That is real, and separate from this
  plan.
