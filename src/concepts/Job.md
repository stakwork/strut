---
description: The kinds of work a job agent has a way to do here, and how to do each.
---
The kinds of work a job agent has a way to do here, and how to do each.

Each child Concept of this node (PARENT_OF from here) is one KIND of
request. Its docs say how to handle it: a workflow to run and its input,
or a way of working. A kind's own children refine it, each with its own
docs.

A message that opens with a kind's page is that kind: follow the page.
Otherwise match the request to a kind and open that page before you act.
When a page names a workflow, run it rather than doing the work by hand,
and say in `text` which page you followed. When no kind fits, the work is
yours — a plan, a page, notes — as files in your directory.

You coordinate; other agents do the heavy work. A workflow a page names
runs as its own agent with its own budget, handing back only what it
found or made. Hand work to them rather than doing it in your own thread.
Your thread is the conversation with the person, and what you keep from
the work is its conclusions (a note, a file, a screenshot), never the
files you would have read to get there. What one of them found is written
down in your directory, so the next one starts from it.

Your shell is this server's, shared with everything else it runs: keep
it to light work (reading, editing, git, a short script). Installing a
project, building it and running its tests or the app are heavy. When
this server gives a job a machine of its own, they run there, as a
kind's page says, never in your shell. A message that asks you to run
something says what to run, not where.

Running a workflow (a person may call one a "strut"):
meta/list-workflows lists the workflows here;
meta/get-workflow shows a workflow's input and output;
meta/run-workflow runs it as its own run under this job (same job id,
same directory) and returns its output; meta/get-run explains a
failure. Prefer running a workflow that does the work over doing it by
hand, and say in `text` which one you ran. strut/run-workflow runs one
on a PEER — another strut server, named by its id (`@<id>` in a message) —
and returns its output; its files stay there. strut/list-peers says
which peers there are and what each holds, and also names THIS
server (`self`) and its repositories — code there is here.

What a message names (a repository, an app, a workflow) you match against
the latest Recent Work list in your thread before searching for it. A
repository is checked out (`git/checkout`, by its https URL), never
looked for on the disk: another job's directory is never where to look.

Seeing what a page shows is a workflow too. You have no browser to look
around with: to look at a site or a running app, open the `Browser` page
under this one and run browser-explore as it says; it also says what to
do when a captcha stops it. An app published on this server needs no
address: app/list finds it, app/look { name } shows it as the person sees
it. Never install or launch a browser yourself
(playwright, puppeteer, a headless chrome from bash): what it captures is
a file you cannot see, and it runs beside the strut server, not in the
browser set aside for this.

Work done before is findable, whatever its kind. When a message refers to
earlier work — a plan, a page, a screenshot, "what we did last week" —
look before starting over: `job/list { q }` finds earlier jobs by words (a
title, or what one delivered), `job/get` shows what one produced (each
deliverable with a `url`, and the `path` `job/read` takes) and the thread
it ran on, `job/read` opens one of its files (an image, you then see).
Say in `text` which job you built on. An earlier job's deliverable you
point the person to goes in `artifacts` like one of yours, by the `url`
`job/get` gave it, with its id and title — never as a path in `text`,
which they cannot open. To change one, copy it into your directory and
list your copy by `path`: another job's directory is not yours to write.

A WORKFLOW, or an APP published here, to build, change, test or debug —
the whole ask, or a part of it ("…and run it every morning",
"…published as an app") — is yours to build, with the authoring tools
(meta/*, app/*). Before you write a workflow or a step, open the
`Workflow Language` page —
graph/graph-get { node_type: "Concept", name: "Workflow Language" } —
and work as it says: the workflow language here, the tools and the order
to work in. What is built here is under the `Workflow Builder` Concept,
a page under this one: when the ask is one of its kinds (an app, work by
people), open that kind's page too. An app with no workflow or step to
write behind it needs its kind's page alone. A build is verified as
`Workflow Language` says: the claim is on the workflow, and
meta/verify-run on its test run, not on the job. When this thread has
been compacted, what a page said went with it: open the page again
before you write more.

An app's line in Recent Work, and in app/list, says where it comes from
when it was not made here: that is where a change to it goes. One from a
repository opened here is changed here, in place, even when the person
names the repository, and reaches it with package/commit when they ask.
Save what you changed in it with package/commit-message: the person's
Commit starts from that message. Strut's own comes back at the next boot. When the repository its line
names is one of the person's, a change to it is a change to its code
there; otherwise change a copy of it, under a name of your own.

One published on a PEER is built there, by that server's builder. Run it
as you run any workflow:

```
meta/run-workflow { name: "builder", input: { prompt, session: "<your job id>/build", peer } }
```

- `prompt` stands alone: the builder sees nothing of your thread. Say what
  the workflow or app should do, its input and output, what you learned,
  the names and links it needs.
- `session` is the build's own thread: the same on every turn of this job,
  so a later turn continues the build ("also post it to Slack") instead of
  starting over.
- `peer` is the other server's id, as strut/list-peers gives it.
- It answers `{ text, artifacts, ask? }`. Say in your `text` what it
  published and what its test run showed; its `ask` is yours to put to the
  person, and their answer goes back to it next turn on the same session.

What the builder publishes it names in its reply — a workflow, an app by name
— and you hand it on as it gave it (an app: `{ kind: "app", app: "<name>" }`
in your `artifacts`).

Something for the person to LOOK AT or use over this job's own results — a
tracker, a chart, a small tool — is an HTML page in your directory
(`index.html`, its data beside it), handed over as a file like any other.

A SECRET (an API key, a token) the work needs and this server lacks: name
it in your reply's `ask.secret` (the NAME alone) and say in `ask.message`
what it is for. The person types the value into a masked box under your
question and it is stored on this server; your next turn begins `[secret]
NAME stored` (or `[secret] NAME is already set here`). You never see a
value: never ask for one in a reply, and never tell the person to add one by
hand somewhere. One secret per turn.

The work is done when it is VERIFIED, not when your last tool call
returned. Once you understand what is asked, state it as a claim about
the job — meta/add-claim with subject { kind: job, name: <your job id>
}, one plain sentence about what the person gets ("the settings page
shows the notification preferences", "GET /api/settings answers 200",
"`acme export --csv` writes one row per order"). ONE claim for a
change; several only when the ask has separate parts, one per part.
Its check uses what you delivered the way its user would, where it
runs:
- a page: browser/verify (browser/walkthrough for a flow, a frame
  per step), on the running app the job holds
  (`{{ input.urls.pod }}/<path>`) or the page as its user opens it.
  It answers with a screenshot.
- an endpoint: http/verify, the request and the answer expected, at
  `{{ input.urls.pod }}/<path>`.
- a command, a script or a file you deliver: exec with `cwd: "{{
  input.dir }}"`, running it as its user would, exiting 0 when the
  claim holds.
- what cannot run here (no running app holds it) or only a person can
  judge: an external check ({ description }) saying what the person
  should open and look at. They accept or reject it.
Never a check that reads your own diff or code to confirm you wrote
what you meant to: it only says your work agrees with itself.
meta/list-claims shows the job's contract and what the person claimed
from their side; hang your check on their claim rather than writing a
second. When you believe the work is ready, call meta/verify-job: it
runs the checks against the job as it is now and returns the ledger.
Refuted means not done — fix the work (or a wrong check,
meta/edit-check), verify again, and only then answer. A claim waiting
on the person is theirs: say in `text` what to look at. A later turn
makes the ledger `stale` until someone verifies again. On the checklist
the person watches, making something and checking it are two steps.

To record a new kind, add a child Concept here with how to do it as its
docs. knowledge/add-page adds a page and knowledge/edit-page changes
one; each waits for the person's yes on a card, so say in `text` what
you proposed.
