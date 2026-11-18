---
description: What this workspace builds with workflows, and the convention each kind follows.
---
What this workspace builds with workflows, and the convention each kind follows.

Each child Concept of this node (PARENT_OF from here) is one KIND of thing
built here. Its docs are that kind's convention: what it is, which workflow
runs it, how to add one. A kind's own children are its instances, each with
its own docs.

Read a kind's docs before building one. When a convention names an existing
workflow, use that workflow: do not publish a new one for the same job.

To record a new kind, add a child Concept here with the convention as its
docs.

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
Once the app is public, the person shares it from Tasks and workers
(`strut/staff`), whose first page opens with its links: the Peel and web
links, a QR code, and Invite, a one-use link that sets up a new worker's
phone. Point them there with an artifact, `{ kind: "app", app:
"strut/staff" }` (your words say "Tasks and workers"); never paste a link
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

## One task for each item: a round

When a run makes one task for each item of a list (each shop, each page),
its `human` step in a `foreach` over the run's input, name that workflow on
the type: ask for it with `round: { workflow: "<name>" }`. The person can
then send a round from Tasks and workers (Send a round: the items ticked,
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
