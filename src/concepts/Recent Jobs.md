---
name: Recent Jobs
description: The person's recent jobs, with the repositories each one checked out.
step: job/recent
parents:
  - Recent Work
---
Every job, by words: `job_list` with `q`. One job, what it delivered and
its thread: `job_get`. A repository a job worked on is checked out again
with `git_checkout`, by its URL.
