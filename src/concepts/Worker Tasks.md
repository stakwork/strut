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
  start: they know who is paid), or *anyone with the link*. Paid work open
  to anyone first needs a short qualifying test — tasks with known answers
  that an admin sets up — so it is a later step, not a first one.
- **The pay**, per task, in dollars. Say too that earnings wait three days
  before a worker can withdraw them, and that the money comes from this
  server's wallet, so it has to be added first.

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

Say these in order, in a few lines, and point to where each is done (an
app is pointed to by name: `{ kind: "app", app: "strut/staff" }`):

1. **Approve.** The pay comes on one card, putting the worker page online
   on another. An admin approves both: the person themself, when they are
   one.
2. **Add money.** In Earnings (`strut/earnings`), Add sats: an invoice
   they pay from their own wallet.
3. **Bring workers in.** Tasks and workers (`strut/staff`) opens with the
   worker page's links once it is online: Invite makes a one-use link that
   sets up a new worker's phone (it costs a few sats), and the Peel link
   and its QR code are for someone already set up. For work only invited
   people do, they then give each worker the task on the Workers tab.
   Point there; never paste a link in the conversation.
4. **Try it.** Open the link on their own phone and do one, so they see
   what a worker sees and what comes back.

## Building it

The conventions are on `Workflow Builder` ("When a workflow asks a
person", "When the worker starts the work") and `App` ("Worker apps").
What the person decided maps onto them:

- *Any time* is a STANDING type: `standing: { workflow }`, the workflow's
  first step its `human` step. When the worker picks the item (which
  place, which page), it is a pick from a list in the answer.
- *One for each item* is a `human` step in a run, one task for each item.
  A schedule is an automation, and only when the person asked for one.
- *Only people you invite* is `open: false`; *anyone* is open.
- Photos are the type's `attachments`.
- The pay is `paySats`. You have no exchange rate: never turn dollars into
  sats yourself and state the result as the dollars. Ask for the type with
  your figure, say it in sats, and say the approval card shows it in
  dollars at today's rate.

Put the person's decisions in the type's `rationale`, in their words. In
your reply, say what was built and what the person does next, in the
order above; the card already lists the type's fields, so do not repeat
them.
