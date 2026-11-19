---
description: "WORK BY PEOPLE: a workflow where people do a step — photograph something, visit a place, check a page, answer a question — on their phone, usually for pay; what the person decides before it is built, and what they do once it is."
parent: Workflow Builder
---
Work by people: a workflow where PEOPLE do a step — photograph a label,
visit a place, check a page, answer a question — in a worker app on their
phone, usually for pay. Two readers: the assistant, who talks it through
with the person before anything is built, and the builder, who builds it.

## Before it is built: what the person decides

The person asking is usually not technical. They know the work and the
pay; they do not know task types, leases or sats, and they should not have
to. Settle these in ONE message before the build starts, each with the
answer you would pick, so that "yes" settles all of them. Leave out what
their request already said.

- **What a worker does and hands in.** The photos (how many, of what) and
  the few questions they answer. Propose them from the request.
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
   one.
2. **Add money.** In Earnings (`strut/earnings`), Add sats: an invoice
   they pay from their own wallet. Name it; do not show it as a card.
3. **Bring workers in.** Tasks and workers (`strut/staff`) opens with the
   worker page's links once it is online: Invite makes a one-use link that
   sets up a new worker's phone (it costs a few sats) and gives them the
   work only invited people do, so nothing more is needed; the Peel link
   and its QR code are for someone already set up, and give that work
   only once the person is given it on the Workers tab — so for
   invite-only work, an invite is the one step. Point there; never paste
   a link in the conversation.
4. **Try it.** In the worker page, right here: they are signed in as
   themselves, see the work as a worker does, do one and see what comes
   back (and earn its pay). On their phone, Tasks and workers' link shows
   it as a worker opens it. For work one for each item, that is after
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
- The workers' language is the person's to say, never to ask. `strut/worker`
  speaks it already: its screens are in English or Spanish, whichever the
  worker's phone is set to. What the type says is yours: write its ask, its
  questions and their choices, and its `title` (what workers call it, any
  words: "Revisión de recibo") in the language the person's workers speak.
- What the answers come to (a report, a tally) is the person's: never in
  the worker app, which goes online for anyone with the link (`App`,
  "Worker apps"). They read the answers in Tasks and workers.
- The pay is `paySats`. You have no exchange rate: never turn dollars into
  sats yourself and state the result as the dollars. Ask for the type with
  your figure, say it in sats, and say the approval card shows it in
  dollars at today's rate.

Put the person's decisions in the type's `rationale`, in their words. In
your reply, say what was built and what the person does next, in the
order above, in their words: no workflow names, inputs or limits. The card
already lists the type's fields, so do not repeat them.
