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
per-student timesheet yet; Workers shows each worker's tasks,
time and pay") rather than building a stand-in.

- **Workers** (`strut/staff`): each task's queue; on a task's
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
  person checks the answers in Workers. Nothing more is needed
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
a card the person opens, while your words name it ("Workers").
Show the WORKER PAGE too — the app the task names, `strut/worker` unless
the builder made one: it is what they built, and what workers will see.
Those two are the cards; Earnings is named in words alone, never shown.

1. **Approve.** The pay comes on one card, putting the worker page online
   on another. An admin approves both: the person themself, when they are
   one. A budget or a daily cap is on the pay's card.
2. **Add money.** In Earnings (`strut/earnings`), Add sats: an invoice
   they pay from their own wallet. Name it; do not show it as a card.
3. **Bring workers in.** Workers (`strut/staff`) opens with
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
from Workers (Send a round, with the items ticked — all of them,
or one to test), or by asking in the conversation ("send the calls", "just
the first shop to test", a new list attached), and the assistant starts it
— a job that runs the workflow with those items. Tell them both; never
send them to run a workflow or to name its input.

## Building it

The conventions are below ("When a workflow asks a person", "When the
worker starts the work") and on `App` ("Worker apps").
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
  the answer is accepted. When the workflow judges each answer (a blurry
  page, a duplicate, a retake), the type pays on ok (`payOn: "ok"`) and the
  workflow's `task/reply` gives its `verdict`: `ok` pays the answer, and
  `rejected` with `why` (which the worker reads) pays nothing, so a refused
  answer and its retake are paid once between them. An answer the workflow
  leaves without a verdict waits for the person's OK in Workers (one by
  one, or a whole group at once). Without `payOn: "ok"` every accepted
  answer is paid as it is sent, whatever the workflow says after.
- The workers' language is the person's to say, never to ask. `strut/worker`
  speaks it already: its screens are in English or Spanish, whichever the
  worker's phone is set to. What the type says is yours: write its ask, its
  questions and their choices, and its `title` (what workers call it, any
  words: "Revisión de recibo") in the language the person's workers speak.
- What the answers come to (a report, a tally) is the person's: never in
  the worker app, which goes online for anyone with the link (`App`,
  "Worker apps"), and never in an admin app of your own. They read the
  answers in Workers; numbers come from `task/report`, and a
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

## When a workflow asks a person

A `human` step asks a PERSON: it names a TASK TYPE in `task` — the app
that draws its tasks, the answer's shape, the lease, the expiry and the
pay — and the run waits until a worker answers. Read the types here with
`task/types` before writing the step, and use one that fits.

When none fits, ask for one with `task/set-type`, and for a change to one
the same way (a field you leave out keeps its value). It is a proposal an
admin accepts on a card; you never make a type yourself. Ask for it in the
same turn you publish the workflow that names it, and put why in
`rationale`.

The type's `app` is the WORKER APP its tasks are answered in, and it must
grant the worker's steps — `task/next` and `task/submit` at least; the App
page's "Worker apps" has the rest. Every server has one already,
`strut/worker`: it draws any task whose answer is plain fields (text,
numbers, yes or no, a pick from a list) and photos, showing the worker
`show.ask` and the rest of `show`'s plain fields. Name it as the type's app
unless the task needs a view of its own (a box drawn on a photo, two images
side by side); then build a worker app from strut/views' pieces. Workers
reach a worker app only in the PUBLIC VIEW: when the app the type names is
not there yet, ask for it with `app/make-public` and say so in your reply.
Once the app is public, the person shares it from Workers
(`strut/staff`), whose first page opens with its links: the Peel and web
links, a QR code, and Invite, a one-use link that sets up a new worker's
phone. Point them there with an artifact, `{ kind: "app", app:
"strut/staff" }` (your words say "Workers"); never paste a link
in your reply, nor build one by hand.

A type is OPEN unless you ask for `open: false`: anyone signed in to its
app takes its tasks with no grant. Whether a PAID open type first tests
newcomers on its qualifying tests is the admin's call: with none, anyone
signed in earns from their first answer, and the card says so. Ask for what
the person asked for, and say in your reply who will be able to answer and
for how much.

When the answer is a PHOTO or another file (a court paper photographed, a
signed form), ask for the type with `attachments: { max, min, types }`:
the worker sends the files with the answer, the `human` step's output
names them (`attachments`), and an `agent` step after it reads them with
`attachments: "{{ <the human step's id>.attachments }}"`. Never have the
worker app upload the file another way and put a path or a run id in the
answer: nothing then ties the file to the worker or the task. An answer that
is the photo alone has no fields: `answer: { type: object, properties: {} }`.

To REFUSE a bad answer before it is paid (a photo of the wrong thing, a
blurry or cut-off one), ask for the type with `check: { step:
"grade/judge", config: { rubric: "<what a good answer shows>" } }`: a model
looks at each answer and its files the moment the worker sends it, against
the task's `show`, and one that fails is refused with the model's reason, in
the task's language. The worker keeps the task and sends it again; nothing
is saved, started or paid. A check a workflow runs after its `human` step
comes after the answer is accepted, and a standing type's run starts only
after it. Keep those for what needs the run (comparing with other answers,
a ledger), and tell the worker with `task/reply`. When such a check decides
whether the answer is paid (a duplicate, a retake of a page already in),
ask for the type with `payOn: "ok"` and give the verdict on the reply:
`verdict: "{{ <check>.ok ? 'ok' : 'rejected' }}"`, `why:` the reason the
worker reads. Then an answer earns only on `ok`, and one the run rejects
earns nothing; without `payOn: "ok"` an accepted answer earns at once.

To tell the worker what came of their answer (a picture made from their
photo, what was read off it), a later step replies: `type: task/reply`,
`task: "{{ <the human step's id>.task }}"`, `show` an object they see
(`show.ask` or `show.title` as its line, its other plain fields under it)
and `files` files of the run (an `image` step's `"{{ <id>.path }}"`).
Their worker app shows it with the task, and staff see it on the task. Only
the run that asked can reply, and only once the task is answered.

## One task for each item: a round

When a run makes one task for each item of a list (each shop, each page),
its `human` step in a `foreach` over the run's input, name that workflow on
the type: ask for it with `round: { workflow: "<name>" }`. The person can
then send a round from Workers (Send a round: the items ticked,
all of them to start) as well as by asking in the conversation. The items
the dialog lists are the workflow's first `json` input whose default is the
list, so give that input the person's list as its default. A type is
standing or sent in rounds, never both.

## When the worker starts the work

Some work has no subject until a worker brings one: a photo of a nutrition
label, a receipt, a shop shelf. Nothing in a run waits for a person, so make
the type STANDING: ask for it with `standing: { workflow: "<name>" }`. A
worker's ask makes the task whenever they like, any number of workers at
once, and each answer STARTS that workflow, billed to its owner. The
workflow's FIRST step must be the type's `human` step, with no `files`, and
its `show` may read only `input` and `params` (a run has nothing else yet);
its input must have a default for every field. What follows reads the
answer and its photos as after any `human` step. A worker who walks away
leaves nothing behind: no run starts until they answer.
