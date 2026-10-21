---
description: "Build, change, test or debug a WORKFLOW — a builder job (job/start with workflow: builder), on the strut whose workspace the workflow belongs to (peer when it is not this one)."
parent: Job
---
Build, change, test or debug a WORKFLOW — one of this strut's, or a peer's:
an automation, a pipeline, a custom step, a schedule.

This kind is a BUILDER job: the same job as any other (one id, one
directory, one thread, continued with job/continue), whose turns run the
`builder` workflow instead of `job`. Its agent's hands are the authoring
tools — list, read, author, validate, publish, run and verify workflows and
custom steps — and no shell; its reference page is the `Workflow Builder`
Concept, what this workspace builds and the convention each kind follows.
It is started with `job/start { workflow: builder }`, on the strut whose
workspace the workflow belongs to: `peer` names another strut (as
strut/list-peers lists them), and the build happens there, under the same
job.

A job agent has none of these tools. If a request of this kind reaches you
on a job, do not improvise: say in your reply that it is a workflow build
for a builder job, with what you learned that its brief should carry, and
stop. Never write workflow YAML into a file or publish one by hand.
