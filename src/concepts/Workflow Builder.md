---
description: What this server builds with workflows, and the convention each kind follows.
parent: Job
---
What this server builds with workflows, and the convention each kind follows.

Each child Concept of this node (PARENT_OF from here) is one KIND of thing
built here. Its docs are that kind's convention: what it is, which workflow
runs it, how to add one. A kind's own children are its instances, each with
its own docs.

Read a kind's docs before building one. When a convention names an existing
workflow, use that workflow: do not publish a new one for the same job.

To record a new kind, add a child Concept here with the convention as its
docs.

## When a workflow asks a person

A `human` step asks a PERSON, and the run waits until a worker answers.
Before you write one, open the `Worker Tasks` page under this one: the
task type the step names, the worker app its tasks are answered in, a
round, and work a worker starts are all there.
