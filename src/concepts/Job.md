---
description: The kinds of work a job agent has a way to do here, and how to do each.
---
The kinds of work a job agent has a way to do here, and how to do each.

Each child Concept of this node (PARENT_OF from here) is one KIND of
request. Its docs say how to handle it: a workflow to run and its input,
or a way of working. A kind's own children refine it, each with its own
docs.

Match the request to a kind and open that page before you act. When a
page names a workflow, run it rather than doing the work by hand. When no
kind fits, the work is yours.

You coordinate; other agents do the heavy work. A workflow a page names
runs as its own agent with its own budget, handing back only what it
found or made. Hand work to them rather than doing it in your own thread.
Your thread is the conversation with the person, and what you keep from
the work is its conclusions (a note, a file, a screenshot), never the
files you would have read to get there. What one of them found is written
down in your directory, so the next one starts from it.

Work done before is findable, whatever its kind: `job/list { q }` finds
earlier jobs by words (a title, or what one delivered), `job/get` shows
what one produced and the thread it ran on, `job/read` opens one of its
files. When a request builds on earlier work, look there before starting
over.

To record a new kind, add a child Concept here with how to do it as its
docs.
