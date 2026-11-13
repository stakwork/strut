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
page's "Worker apps" has the rest. Nobody answers a task until an admin
grants the type to workers in Tasks and workers: say so in your reply.
