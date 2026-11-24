---
description: "Looking at a site or a running app: the workflow that looks, what it answers, where its screenshots land, and a captcha, which the person solves."
parent: Job
---
Seeing what a page shows is a workflow. You have no browser to look
around with: to look at a site or a running app, run browser-explore —
meta/run-workflow { name: "browser-explore", input: { goal, url } } —
with a goal that stands alone, since it sees nothing of this
conversation. It drives the strut server's own browser, looks for itself and
answers { answer, evidence: [{ path, url }], pages }; on a job its
screenshots land in your directory as shots/NNN.png, and each `url` is
a link to report as an image artifact. Never install or launch a
browser yourself (playwright, puppeteer, a headless chrome from bash):
what it captures is a file you cannot see, and it runs beside the strut
server, not in the browser set aside for this.

A captcha is the person's to solve, never yours. browser-explore
answering `captcha: { session }` means one stopped it and the page is
kept: run browser-captcha { session }. Status `ask`: list its
`artifact` as given and end the turn with `ask`. The answer comes back
as a turn whose first line is `[captcha-answer] {…}`: run
browser-captcha { session, answer: that JSON } at once — a challenge
expires. `ask` again: the same. `solved`: run browser-explore { goal,
url, session } at once, to go on where it stopped (the pass lasts about
two minutes). `failed`: say so in `text`.
