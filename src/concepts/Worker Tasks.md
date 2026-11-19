---
description: "WORK BY PEOPLE: a workflow where people do a step — photograph something, visit a place, check a page, answer a question — on their phone, usually for pay; what the person decides before it is built, and what they do once it is."
parent: Workflow Builder
---
Work by people: a workflow where PEOPLE do a step — photograph a label,
visit a place, check a page, answer a question — in a worker app on their
phone, usually for pay. Two readers: the assistant, who talks it through
with the person before anything is built, and the builder, who builds it.

## What is built in

Everything an admin does with the work is in strut already. Never build an
app, a dashboard, a settings page or a workflow of your own for any of it
— not even when a long spec asks for one. Point to what is here, and when
something the person asks for is not here, say so plainly ("there is no
per-student timesheet yet; Tasks and workers shows each worker's tasks,
time and pay") rather than building a stand-in.

- **Tasks and workers** (`strut/staff`): each task's queue; on a task's
  page, what it has paid against its budget and, for the last 7 days, each
  worker's tasks, time spent, tasks per hour and pay; the workers, who
  holds which work, grant and revoke; the answers and a verdict on each;
  tests; payouts; Support (workers' messages). Its Invite a worker makes
  a link for one person, with or without Peel, that opens their work in
  Tasks. A new invite-only task is its makers' from the start (whoever
  asked for it and the admin who approved it), so they try it at once;
  "Try it yourself" on a task gives any other admin its work.
- **Earnings** (`strut/earnings`): the wallet, adding money, what was paid.
- **Limits on the task**, enforced by the server whenever it hands one
  out: a BUDGET (the most it pays in all; then no more is handed out) and
  a DAILY CAP (the most one worker does in a day). A budget or a cap in a
  spec is these two, never code.
- **Your own tools**: `task/report` answers "how is it going", "what have
  we spent", "who did what" inside the turn; `task/grant` gives a worker
  already here the work (a card an admin approves).

## Before it is built: what the person decides

A long spec (a pilot, a requirements list): before anything else, sort it
in ONE message — what is built in (above), what the worker page needs
built, what is not possible here (a camera that shoots by itself: every
photo needs a tap), and what is theirs to decide — and build only the
second. A cap in hours is a daily cap in tasks at the pace they expect
(3 hours at 20 seconds a task: 540); a budget in dollars is the budget.

The person asking is usually not technical. They know the work and the
pay; they do not know task types, leases or sats, and they should not have
to. Settle these in ONE message before the build starts, each with the
answer you would pick, so that "yes" settles all of them. Leave out what
their request already said.

- **What a worker does and hands in.** The photos (how many, of what) and
  the few questions they answer. Propose them from the request. For paid
  work, say too what makes one good enough to pay ("a sharp photo of one
  whole page"): each is checked the moment it is sent, and one that is not
  is refused with the reason, so the worker sends it again and it is never
  paid.
- **When there is work.**
  - *Any time, as many as they like* — a worker starts one whenever they
    want, and many can work at once. Nothing has to be sent out, so it can
    be tried the moment it is built. It cannot promise that every item is
    covered: two workers may pick the same one.
  - *One for each item, when you send a round* — a list (places, pages,
    forms) where each item needs exactly one answer. Nothing happens until
    a round is sent; it can go out on a schedule if they ask for one.

  Pick "any time" unless every item must be covered.
- **Who can do it.** *Only people you invite* (pick this for paid work to
  start: they know who is paid), or *anyone with the link*: anyone signed
  in to the worker page does it and is paid from their first one, and the
  person checks the answers in Tasks and workers. Nothing more is needed
  first: a qualifying test (tasks with known answers) is something an admin
  may add later, never a step before the first try.
- **The pay**, per task, in dollars. Say too that the money comes from
  this server's wallet, so it has to be added first, and that workers can
  withdraw what they earn at once.

Never ask about the rest — how long a worker has once they start one, when
an untaken task expires, the hold, tests, copies, the field names, which
worker app. Those are the builder's to choose.

Talk in the person's words:

| Not this | This |
| --- | --- |
| task type | the task, by what it is ("the visit") |
| standing / a `human` step in a run | any time / one for each item |
| open / invite-only | anyone with the link / only people you invite |
| public view, make public | put the worker page online |
| sats | dollars (sats, if at all, in brackets) |
| lease | the time a worker has once they start one |

## Once it is built: what the person does

Say these in order, in a few lines, and point to where each is done: an
app is an artifact, `{ kind: "app", app: "strut/staff" }`, which shows as
a card the person opens, while your words name it ("Tasks and workers").
Show the WORKER PAGE too — the app the task names, `strut/worker` unless
the builder made one: it is what they built, and what workers will see.
Those two are the cards; Earnings is named in words alone, never shown.

1. **Approve.** The pay comes on one card, putting the worker page online
   on another. An admin approves both: the person themself, when they are
   one. A budget or a daily cap is on the pay's card.
2. **Add money.** In Earnings (`strut/earnings`), Add sats: an invoice
   they pay from their own wallet. Name it; do not show it as a card.
3. **Bring workers in.** Tasks and workers (`strut/staff`) opens with
   Invite a worker: it makes a one-use link for one person, for one kind
   of work or anything open. On a phone without Peel it sets Peel up (it
   costs a few sats); someone with Peel goes straight in. Either way it
   opens Tasks on that work and gives them invite-only work, so nothing
   more is needed. Folded under it, one link for a group: open work only,
   for people who have Peel. If Tasks is not online yet, the panel says so
   and puts it online in one click. Point there; never paste a link in the
   conversation.
4. **Try it.** In the worker page, right here: they are signed in as
   themselves, see the work as a worker does, do one and see what comes
   back (and earn its pay). They hold invite-only work they asked for
   already; on their phone in Peel they are another account until Peel is
   linked to this server, so there an invite to themself is the way in,
   and shows the work as a worker opens it. For work one for each item, that is after
   asking for a round of one (below).

For work *one for each item*, a round goes out when the person says so:
from Tasks and workers (Send a round, with the items ticked — all of them,
or one to test), or by asking in the conversation ("send the calls", "just
the first shop to test", a new list attached), and the assistant starts it
— a job that runs the workflow with those items. Tell them both; never
send them to run a workflow or to name its input.

## Building it

The conventions are on `Workflow Builder` ("When a workflow asks a
person", "When the worker starts the work") and `App` ("Worker apps").
What the person decided maps onto them:

- *Any time* is a STANDING type: `standing: { workflow }`, the workflow's
  first step its `human` step. When the worker picks the item (which
  place, which page), it is a pick from a list in the answer.
- *One for each item* is a `human` step in a run, one task for each item,
  and the type names that workflow: `round: { workflow }`, so Tasks and
  workers can send a round. The items are the run's first `json` input; a
  list the person attached (a spreadsheet) is its default, so a round with
  no input sends all of them.
  Size it for the list they have, and for one many times as long: how many
  go out at once is yours to set, never theirs to hear about. A schedule
  is an automation, and only when the person asked for one.
- *Only people you invite* is `open: false`; *anyone* is open.
- Photos are the type's `attachments`.
- What makes an answer good enough to pay is the type's `check`, written
  from what the person said: `{ step: "grade/judge", config: { rubric } }`.
  It runs when the worker sends the answer, before it is accepted or paid,
  and a fail is refused with its reason. Checks in the workflow run after
  the answer is accepted, when the pay is already the worker's: they can
  tell the worker (`task/reply`) and flag the answer, never stop the pay.
- The workers' language is the person's to say, never to ask. `strut/worker`
  speaks it already: its screens are in English or Spanish, whichever the
  worker's phone is set to. What the type says is yours: write its ask, its
  questions and their choices, and its `title` (what workers call it, any
  words: "Revisión de recibo") in the language the person's workers speak.
- What the answers come to (a report, a tally) is the person's: never in
  the worker app, which goes online for anyone with the link (`App`,
  "Worker apps"), and never in an admin app of your own. They read the
  answers in Tasks and workers; numbers come from `task/report`, and a
  report they ask for is a job's, made when they ask.
- A budget and a daily cap are the type's `limits` (`budgetSats`,
  `perWorkerDay`): never counted or enforced in a workflow or an app, which
  a worker's own page could get around.
- Settings an admin may tune later (a threshold, a list of categories) are
  the workflow's `params`, changed by asking you: never a settings page.
- The pay is `paySats`. You have no exchange rate: never turn dollars into
  sats yourself and state the result as the dollars. Ask for the type with
  your figure, say it in sats, and say the approval card shows it in
  dollars at today's rate.

Put the person's decisions in the type's `rationale`, in their words. In
your reply, say what was built and what the person does next, in the
order above, in their words: no workflow names, inputs or limits. The card
already lists the type's fields, so do not repeat them.
