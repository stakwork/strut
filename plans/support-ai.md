# Support answers with AI

> **Status (2026-11-23): ruled. Item 1 built (#855).**
>
> - **Written against:** strut `main` @94bf903a.
> - **The Rulings** are Evan's, from one conversation on 2026-11-23.
> - **§8's open questions** were ruled the same day: Evan took every
>   default ("go with your defaults").
> - **Companion to:**
>   - `support-chat.md`: Support as staff use it today;
>   - `people-and-hosts.md` §5: Support as an app (its SQLite, its tools,
>     the daemon's push);
>   - `human-steps.md`: workers, task types, payouts.
>
> **Keeping this plan current.** Each PR that builds an item edits this file:
> its row in §9 says it is built and names the PR. Wherever a section says
> something other than what was built, the PR marks it **Built differently
> (#N):**, with what was built and why.

## Rulings (2026-11-23)

| # | Question | Ruled |
| --- | --- | --- |
| 1 | What Support may read | **What the worker can already see.** Nothing more |
| 2 | Answering from docs written about the apps | **No.** Apps change "tons and tons of times", and apps → docs → answers is lossy. Support reads the apps themselves. The support job's notes (§5) only say where to look |
| 3 | The whole app in the prompt | **No.** Apps outgrow a prompt. Support explores the app, and a support job keeps what it learned |

## Problem

Workers DM "Support" from Peel. Only staff answer, and staff are not always
there. Most questions are one of two kinds:

- **About the worker's own state:** where is my withdrawal, why was my
  answer rejected, why do I see no tasks. Strut holds every answer.
- **About how something works:** this app's task, Peel's wallet, the Tasks
  page. The apps on the box hold the answer for their part. Peel and the
  Tasks page are the same on every box.

## Design in one paragraph

When a worker writes to Support, `support/receive` (which keeps the message
today) also starts `support-reply`. That run gathers what the worker can
already see: their own task state, the thread, the shared `Worker Help`
page, and the support job's notes on the apps they work in. One agent then
reads it, with a single tool that reads those apps' files at the version
people open, and answers `{ reply?, handoff? }`. Then a step that is not the
model's either keeps the reply as a draft for staff or sends it, and a
handoff marks the conversation for staff. The model never holds a tool that
sends or writes. A **support job** per app keeps notes on the app as a
worker meets it, updated from the files that changed when the version
people open moves. The notes are an index into the source, not the answer.

## 1. Who gets an answer

Support already knows who wrote. Each conversation keeps the sender's actor,
`secp:<the key without its first byte>`, and the task store has a `workers`
row for every worker who opened Tasks.

The one test: **a worker row for the conversation's actor, with status `new`
or `active`.**

| Who wrote | AI |
| --- | --- |
| A worker, `new` or `active` | Yes |
| A worker, `suspended` or `banned` | No: what they ask is staff's |
| A Stadeum member who linked Peel and never did tasks | No: they have Jamie (open question 4) |
| A stranger who has Support's address | No |

A member who does tasks from Peel signs in to Tasks with the same key, so
they have a worker row and are answered as a worker. Being linked doesn't
change anything here.

Jamie's orchestrator never answers a worker:

- a turn a host starts needs a linked person;
- the orchestrator's tools are a member's (workflows, the builder,
  proposals);
- a worker has only a visitor's access.

## 2. What Support reads

Ruling 1, as a table. The reply turn and the support job read the same
things, since the job's notes become part of the reply's prompt.

| Reads | Why the worker can already see it |
| --- | --- |
| Their own state, as `task/me { all: true }` and `task/history { all: true }` answer them | Their Tasks page shows it |
| Their thread with Support, photos included | They wrote it, or Support sent it |
| Each public-view app's files, at the version people open | Their browser loads the app's code |
| The `Worker Help` Concept (§2.3) | It is written for workers |
| The support job's notes on those apps (§5) | Written from the rows above alone |

**Never read:**
- task types' tests, their expected answers, graders and checks;
- workflows (their prompts and logic);
- other workers and their conversations;
- staff notes on a worker;
- private apps, and app versions people don't open;
- other jobs' files, the web, a shell.

### 2.1 The worker's state

A new step, `support/context` (§3), reads it through the task store's own
service with the conversation's actor:

- status;
- their task types, with pay, `qualifying`, `standing` and what waits;
- the task in hand;
- held and withdrawable earnings, and when the next hold ends;
- whether they may withdraw, the least and most, and a payout on its way
  (`stale` too);
- their newest 50 tasks: what each asked, its status, what it earned, the
  workflow's reply, and a review's verdict with its why.

Two catches:

- **`me` writes.** A first `me` writes a new worker. The context reads only
  a worker the store already has (§1), so the read never writes.
- **`no_address`.** A worker's Sphinx address comes from their sign-in
  session, and Support has no session. Read without one, `payout.why` would
  say `no_address` ("sign in with Peel") of a worker who has one. The
  context leaves that reason out.

### 2.2 The apps: `app/public-files`

A new read step, one tool:

```
app/public-files { app?, path?, maxChars? }
```

- With no `app`: the public view's apps, each with its title, description
  and the version people open.
- With `app`: that app's source files at that version, each `{ path, size,
  sha }`.
- With `app` and `path`: one file's text, cut like `job/read`'s, or
  `binary: true`.

It reads only apps in the public view, and only the version people open (the
app's live version, which the public view holds). It takes no other version
and no other app. It is `app/get`'s files, narrowed to what any visitor can
open. `app/get` itself reads every app on the box, private and admin apps
included, so it is not given to these agents.

**Built (#855):**
- A version's files are its tree: the sources an app version's identity is
  made of. That leaves out `dist/` (built from them), `data.db`, dotfiles and
  `node_modules/`.
- A path is read only when it is in that list.
- The public view's capability gained `apps()`, the names it lists.

### 2.3 The `Worker Help` Concept

What is the same on every box, written once for workers, and seeded by
strut so every box gets updates with the image:

- **Peel:** signing in to an app, the wallet, withdrawals (keysend, the
  fee, how long they take), what a failed withdrawal looks like in Peel.
- **The Tasks page:** strut's own `strut/worker` and the kit's
  `WorkerPage`, which every task app's page builds on. A task app's source
  shows `<WorkerPage/>`, not what it renders, so reading it explains
  nothing here.
- **Pay:** holds, the least and the most a withdrawal may ask, and what each
  `payout.why` means for the worker (`off`, `no_wallet`, `no_keysend`,
  `not_here`).

It is the one summary left, and it covers the part of the worker's world
that moves slowest. Written from `stakwork/peel`, `stakwork/peel-android` and
strut's kit (item 2).

## 3. A reply turn: `support-reply`

A seeded workflow of `strut/staff`'s, beside `support-outbox`
(`src/workflows/system/support-reply/`). It runs as an app's run, so its bag
carries the `sphinx` capability (`sendsAsSupport`), as the outbox's does.

**The trigger.** After `support/receive` keeps a worker's message or file
(not Support's own), it launches `support-reply { pubkey, key }` when:

- the mode is not `off` (§4);
- §1 says the sender is answered;
- the conversation is not handed off and no admin took it (`assignee`).

`key` is the message's. The run's launch key is `<pubkey>/<key>`.

**The newest message answers.** Workers write in bursts. Each message starts
a run, and every run stands down if a newer message from the worker, or a
reply from staff, has come in. The check runs twice: when the context is
read (after a short wait, so a burst can land), and again just before the
answer goes out. The newest message's run answers everything above it. No
queue, no flag, no loop.

**The steps.**

1. `support/context { pubkey, key }`: waits a few seconds, stands down if it
   should, then gathers §2:
   - the worker's state;
   - the thread's last 50 messages, and the photos among the newest ones as
     the run's attachments;
   - `Worker Help`;
   - the notes on each app the worker has task types in.

   An app whose notes are missing, or older than the version people open,
   starts its notes job (§5). This turn answers from the source.
2. `agent`, with:
   - `toolFilter: ["none"]`;
   - `agentTools: ["app/public-files"]`;
   - `mcp: false`;
   - the photos as `attachments`;
   - a `schema` of `{ reply?, handoff? }`, where `handoff` is a reason for
     staff;
   - no session: the thread lives in Support's SQLite, and each turn reads
     it fresh.

   The prompt is a posture, in the workflow's own YAML:
   - Answer as Support, short and plain, in the worker's language.
   - What you know is the worker's own state, their apps, and the help
     page.
   - Never promise money or access, and never say you are a person.
   - When the answer needs a person, or you can't find it, hand off and say
     so.
3. `support/answer { pubkey, key, reply?, handoff? }`: stands down if it
   should. Otherwise:
   - **draft:** keeps the reply on the conversation for staff (§4);
   - **auto:** sends it the way `support/send` does, kept with
     `by: "ai"`;
   - **handoff:** marks the conversation for staff, with the reason. In
     auto mode, a reply the model wrote with it (that a person will look)
     still goes.

The recipient is always the run's `pubkey`, from the trigger. The model
never names it.

## 4. The staff's side

`strut/staff`'s Support tab, and one migration, `db/002-support-ai.sql`
(additive):

| Where | Column | What |
| --- | --- | --- |
| `settings` | `ai` | `off` (the default), `draft` or `auto` |
| `settings` | `ai_by` | The admin who last set it: the reply and notes runs run as them (open question 2) |
| `conversations` | `draft`, `draft_key`, `draft_at` | The newest suggested reply, and the worker message it answers |
| `conversations` | `handoff`, `handoff_at` | Why the AI handed it to staff. Cleared when staff mark the conversation done |

On the page:

- **Settings:** the mode, beside the welcome.
- **A draft** shows above the composer, with Send, Edit (into the composer)
  and Dismiss. A newer draft replaces it. A staff reply clears it.
- **A handed-off conversation** is marked in the list with its reason, at
  the top.
- **A message the AI sent** carries a small mark, for staff only (`by:
  "ai"`). The worker sees "Support", as ruling 4 of `support-chat.md` says.

## 5. The support job: notes per app

One job per public-view app, with an id made from the app's name
(`support-<app>`, in the session-id format). Each app gets its own memory,
and two apps never wait on each other: a job runs one turn at a time.

**Its directory** holds `notes.md`, which starts with what it describes:
the app's version and each file's `sha` at that version. The rest is the app
as a worker meets it:

- what each screen asks;
- how a task goes, from taking it to being paid;
- what goes wrong, and what the worker sees when it does;
- where in the files each of these lives.

**Its workflow**, `support-notes { app }`, is seeded beside `support-reply`:

```
job/dir
  → agent:
      cwd: the job's directory
      session: the job
      toolFilter: only the text editor
      agentTools: [app/public-files]
      mcp: false
```

**A turn:**

1. reads its notes;
2. lists the app's files;
3. reads the files whose `sha` changed (and whatever else it needs to make
   sense of them);
4. rewrites `notes.md` for the new version.

A small change is a short turn. The session remembers its earlier reading,
and compaction keeps a long one in bounds.

**When it runs.** `support/context` starts it when a worker asks about an
app whose notes are missing or behind (open question 5). It is launched with
the job and a launch key per app, so one turn runs at a time. A version
change for an app nobody asks about costs nothing.

**Who reads the notes.** `support/context` puts them in the reply's prompt.
The reply agent never holds `job/read`, which would open every job on the
box.

## 6. Security

- **The worker's words are untrusted.** What they can steer is one reply,
  to themselves, built from what they could already see. No tool the model
  holds writes anything. The send is a step bound to the trigger's
  `pubkey`.
- **No built-ins in the reply agent.** `bash` would reach the box and its
  data, `web_fetch` could carry data out, and the editor has nothing to
  edit. A general-purpose seeded agent keeps its built-ins. This agent is
  not general-purpose: its prompt is a stranger's.
- **The job never reads a worker's words.** Its editor stays inside its own
  directory, and its one other tool reads public-view apps.
- **Money and access stay with staff.** The AI only reads a worker's
  balance, and hands off anything that would change it, grant them a type,
  or reverse a review.
- **Cost.** One answer per burst. `suspended` and `banned` workers start no
  run. Each workflow sets its own `maxRunCostUsd`, since strut's default is
  $100 a run (open question 6).

## 7. What stays the same

- `support/receive` keeps every record as it does now. The trigger comes
  after the transaction, like the outbox's.
- Staff can always reply themselves. A staff reply makes any run in flight
  stand down.
- The welcome, payout lines, files and the daemon's push are unchanged.
- No new route. `specs/API.md` §22 gains the new tools.

## 8. Open questions (ruled 2026-11-23: the defaults)

| # | Question | Ruled |
| --- | --- | --- |
| 1 | Does an AI reply say it is AI? | No label: every reply is from "Support" (support-chat ruling 4). The posture never claims to be a person, and staff see the mark |
| 2 | Whose model access pays for the runs? | The admin who set the mode (`ai_by`): strut's "everything is a person" rule, as a subscription keeps the actor who set it up. Another admin hands it over by setting the mode again |
| 3 | Is an app's source more than the worker can see? | Read all of the app's published files. The bundle the worker loads carries the same code. Comments and any file the build leaves out are the difference |
| 4 | A Stadeum member DMs Support | No AI. Staff answer, or point them to Jamie |
| 5 | When do notes update? | When a worker asks about an app whose notes are behind (lazy). The alternative is a hook when the version people open moves |
| 6 | A cap on a worker's answers per day? | None per worker; Evan took the tribe budget out on 2026-11-20. Each run is capped by its workflow: `maxRunCostUsd: 1` on `support-reply`, `5` on `support-notes` |
| 7 | Draft before auto? | Yes: item 3 ships draft only, and auto is item 6 |
| 8 | Who keeps `Worker Help` current? | A Peel or kit change that changes what a worker sees updates it in strut's git |

## 9. Work items

| # | What | Where |
| --- | --- | --- |
| 1 | `app/public-files`: list and read a public-view app's files at the version people open. **Built (#855)** | `src/steps/lib/app/`, `src/public-view.ts` |
| 2 | The `Worker Help` Concept, written from Peel (Apple and Android) and the kit's worker pages | `src/concepts/` |
| 3 | Draft mode: `db/002-support-ai.sql`, `support/context`, `support/answer`, the `support-reply` workflow, receive's trigger | `src/apps/staff/`, `src/steps/lib/support/`, `src/workflows/system/` |
| 4 | The page: the mode, drafts, handoffs, the AI mark | `src/apps/staff/src/` |
| 5 | The support job: `support-notes`, and the notes in `support/context` | `src/workflows/system/`, `src/steps/lib/support/` |
| 6 | Auto mode: the send, a handoff's reply | `src/steps/lib/support/` |

Items 1–4 make draft mode work without notes: the reply reads the source
itself. Item 5 makes replies cheaper and more consistent. Item 6 lets them go
without a click.

Each item adds tests beside `src/apps/support.test.ts`, which already runs
a strut with the stand-in daemon pushing to it, and a stand-in model
(`registerModelWrapper`). Covered there:

- §1's test;
- standing down for a newer message or a staff reply;
- the recipient taken from the trigger;
- the reads refused for a private app or another version;
- a draft kept, a send in auto, a handoff.

Each item updates `docs/tasks.md` (the Support entry) and `docs/apps.md`
(`app/public-files`).

## 10. Later

- **Jamie reads Support.** An admin asks Jamie what workers are stuck on
  this week, or to change how Support explains holds. Jamie needs a read of
  `strut/staff`'s SQLite.
- **Learning from staff.** The job reads conversations staff closed, and
  staff's edits to drafts, and keeps what it learns beside its notes.
- **A box's own notes for Support** ("we pay on Fridays"): one free-text
  field beside the welcome.
- **A handoff that is a bug** becomes a job the builder can fix.
- **Browser workers:** a thread in the worker app (`support-chat.md` §12).

## 11. Rejected

- **Docs per app, written by hand or rewritten each version** (ruling 2).
  They drift, and they lose what the source says.
- **The whole app in the prompt** (ruling 3).
- **Jamie's orchestrator answering as the worker** (§1).
- **`staff/worker` in the agent's hands.** It is an admin page's read, and
  it carries staff notes. `staff/*` refuses an agent anyway.
- **A send tool in the model's hands.** An injected prompt could name
  another recipient.
- **An agent session per conversation.** It would be a second copy of the
  thread, carrying a balance from three days ago as if it were now.
- **One job for every app.** A job runs one turn at a time, so a new
  version of one app would hold up notes on every other, and its memory
  would mix apps.
