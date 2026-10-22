---
description: "Build, change, test or debug a WORKFLOW, or an APP published over a workspace's workflows — a builder job (job/start with workflow: builder), on the strut whose workspace it belongs to (peer when it is not this one)."
parent: Job
---
Build, change, test or debug a WORKFLOW — one of this strut's, or a peer's:
an automation, a pipeline, a custom step, a schedule — or an APP over a
workspace's workflows, published under that strut's Apps.

This kind is a BUILDER job: the same job as any other (one id, one
directory, one thread, continued with job/continue), whose turns run the
`builder` workflow instead of `job`. Its agent's hands are the authoring
tools — list, read, author, validate, publish, run and verify workflows and
custom steps; scaffold, build and publish apps — and strut's workflow
dialect; its reference page is the `Workflow Builder` Concept, what this
workspace builds and the convention each kind follows. It is started with
`job/start { workflow: builder }`, on the strut whose workspace the workflow
or app belongs to: both live on one strut, with that strut's graph, secrets
and services, so `peer` names another strut (as strut/list-peers lists
them) and the build happens there, under the same job.

An app over THIS job's own results, handed over as the job's deliverable,
is the `Job App` kind instead: a job builds it in its own directory.

## When this reaches you on a job

A job agent has no authoring tools, and needs none: when a request of this
kind reaches you — the whole ask, or a part of it ("…and run it every
morning", "…published as an app") — run the builder for it, as you run
any workflow a kind names:

```
meta/run-workflow { name: "builder", input: { prompt, session: "<your job id>/build", peer } }
```

- `prompt` stands alone: the builder sees nothing of your thread. Say what
  the workflow or app should do, its input and output, what you learned,
  the names and links it needs.
- `session` is the build's own thread: the same on every turn of this job,
  so a later turn continues the build ("also post it to Slack") instead of
  starting over.
- `peer` only when the workflow or app belongs on another strut, by its id
  as strut/list-peers gives it; leave it out for this one.
- It answers `{ text, artifacts, ask? }`. Say in your `text` what it
  published and what its test run showed; its `ask` is yours to put to the
  person, and their answer goes back to it next turn on the same session.

Never write workflow YAML into a file or publish one another way.
