# Place posts: a workflow posts in a linked place

> **Status (2026-11-26): a plan, nothing built.**
>
> - **Written against:** strut `main` @ea159f30, stakwork/sphinx `master`
>   @add04696 (`wasm/daemon`), stakwork/stadeum `main` @57904c3.
> - **The Rulings** are Evan's, from 2026-11-26 (ruling 4 relayed later
>   that day).
> - **The decisions in §8** are this plan's defaults. Evan may overrule them.
> - **Builds on** `jamie-in-tribes.md` (every item built): the daemon as a
>   strut HOST, linked accounts, linked places, the host's hook.
>
> **Keeping this plan current.** Each PR that builds an item edits this
> file: its row in §9 says it is built and names the PR. Wherever a section
> says something other than what was built, the PR marks it **Built
> differently (#N):**, with what was built and why.

## Rulings (2026-11-26)

| # | Question | Ruled |
| --- | --- | --- |
| 1 | Who may post | **Anyone linked to the box, in any place linked there.** A run whose person has a linked account of the host's kind may post. They need not be the place's linker, nor an admin |
| 2 | Who calls the step | **Only workflows.** It is not one of Jamie's tools, nor any agent's |
| 3 | Spending | **No cap.** Each post pays the tribe's price from the box's treasury, as Jamie's replies do (`jamie-in-tribes.md` ruling 6) |
| 4 | A Sphinx step, or a generic one | **Generic.** A workflow written for a tribe switches to, or adds, another kind of place by changing `host` and `key`. Strut routes a post by the place's `host` alone, to that host's hook, and knows nothing of the medium |

## Problem

Evan asked whether a workflow can post in a Sphinx tribe through a box's
treasury daemon: a scheduled digest, or a job's update to the tribe it was
asked in. It can't. The daemon posts in a tribe only to answer a turn it
launched itself: the turn's `run.end` on its callback, or a wake reply on
that conversation's callback (`jamie-in-tribes.md` §6). Nothing in strut
can start a post.

Strut holds nothing that posts in a tribe either. Its only door to the
daemon is the `sphinx` capability (`src/payments/sphinx-dm.ts`), which sends
DMs as Support on the daemon's MESSAGE token. That token opens DMs only.
The daemon's `POST /send` takes a tribe, but only on the ADMIN token, which
strut never holds.

A Sphinx tribe is the only kind of linked place today. The step is generic
all the same (ruling 4); §5, "A second host", says what another kind would
need.

## Design in one paragraph

A generic lib step, `place/post { host, key, text, reply?, id? }`, posts in
a linked place. Strut checks the run's person is linked to the box and the
place is linked here, then hands the post to the place's host on the hook
the host already registered (`PUT /hosts/me`), as `{ event: "post", … }`,
and waits for the answer. The host posts and answers what it sent. Each
post carries an id, and the host posts one id once, so a retry never posts
twice. The step refuses to run as an agent's tool. Strut gains no tribe
code and holds no daemon token. The daemon gains a second event on the hook
it already has.

## 1. What exists

| | Today |
| --- | --- |
| Places | `places (host, key, link, name, account, at)` in `<dataDir>/people.db` (`src/people.ts`: `linkPlace`, `hostPlaces`, `placesOf`). A person links one with the token Peel holds (`POST /people/places`); the host reads them (`GET /hosts/places`, `specs/API.md` §13.4, §13.6) |
| Hosts | `hosts (name, account, hook, at)`, written by `PUT /hosts/me`. A host is ready when it has a key (`STRUT_HOST_KEYS`) and has said who it is (`readyHost` in `createStrut.ts`) |
| The hook | Strut POSTs `{ event: "places" }` to it on each change to a host's places (`onPlaces` → `postCallback`: retried briefly, then dropped). It names no place |
| The daemon's hook | `POST /strut/places?token=<callback token>` (`wasm/daemon/src/http.ts`). The callback token opens it and `/strut/end`, nothing else. It ignores the body: every call reads strut's places again (`strutservice.ts` `reconcile`) |
| The daemon's posts | Its outbox posts each entry once by id (`state.isPosted`), threads a reply under the message it answers and that message's thread (`daemon.ts` `apply`), chunks a long one (`sendText`), and pays the tribe's price per message |
| Strut's `sphinx` capability | DMs as Support, on the message token. Never on the shared bag: only on a first-party admin page's call and the runs such an app launches (`sendsAsSupport`, `adminServices`) |

## 2. The step

```yaml
- id: post
  type: place/post
  config:
    host: sphinx
    key: "{{ input.tribe }}"
    text: "{{ digest.text }}"
```

| Field | |
| --- | --- |
| `host` | The host's name, as in `STRUT_HOST_KEYS`: `sphinx` |
| `key` | The place on the host's medium, as its place is kept: a tribe's pubkey |
| `text` | What to post. 1 to 10,000 characters. The host chunks a long one as it chunks a reply, and each chunk pays the tribe's price |
| `reply` | Optional. The id of a message in that place to post under: an earlier `place/post`'s `id`. The post goes into that message's thread |
| `id` | Optional. What makes a post once only across runs (`digest-2026-11-26`). Without it, the post is once per run and step: a retry or a resume of the same run posts nothing more (§5) |

It answers `{ id, sats?, again? }`: the message's id on the medium (what a
later `reply` takes), what it paid, and `again: true` when this id was
posted before and nothing was posted now.

`effect: "write"`. No `secrets`: strut holds no credential for it.

**`place/list`** beside it, a read: the places linked here, `{ places: [{
host, key, name? }] }`, for the same people (§3). A workflow names a place
by its key, and a person knows a tribe by its name, so the builder needs a
way from one to the other. No agent's tool list names either step: a job
finds both with `meta/search-steps` and runs `place/list` by name
(`meta/run-step`, `plans/tools-as-pages.md`).

Both live in `src/steps/lib/place/`, over a `places` capability on the
shared bag (`placesCapability` in `src/people.ts`, beside
`accountsCapability`).

## 3. Who may post (ruling 1)

The run's person is `ctx.principal`: who launched it, else the workflow's
owner (`runsAs`, which names the person for an automation's fire). They
may post when they hold a linked account of the host's kind
(`people.accountsOf`, an account whose `kind` is `host`). A Sphinx key's
own unlinked actor (`secp:…`) is nobody linked. Anyone else, and a run
with no principal, is `not_linked:`.

The place must be one of the host's places here (`hostPlaces(host)` holds
`key`). Strut checks nothing else about the place: not who linked it, not
whether the person is in the tribe.

A package's step holds `places.post` for its run's principal, whatever it
passes (`heldToItsRun`, `src/packages/fence.ts`), as it holds every
capability that says whom something is for.

## 4. Only workflows (ruling 2)

Strut keeps a step off an agent's tools in two ways today:

- **The capability is not on the bag.** The `sphinx` capability is only on
  a first-party admin page's call and the runs that app launches. That
  fences by who launched the run, not by what inside it calls the step: an
  agent in such a run holds what its workflow holds. It does not fit here,
  where any workflow run as a linked person may post.
- **The step refuses.** A step run as an agent's tool gets `ctx.agentTool:
  true` (`buildRegistryTools`, `src/steps/core/agent.ts`). `task/reply` and
  the `human` step refuse it ("a run's step, never an agent's tool").
  `secret/add`, `account/*` and the worker's `task/*` steps go further and
  run only as a page's own call (`pageCall`, `src/run-step.ts`).

`place/post` uses the second: it refuses unless it runs as a step of a
workflow's run. That is three refusals, one helper, `workflowStep(ctx)` in
`src/run-step.ts` beside `pageCall`:

- **an agent's tool call** (`ctx.agentTool`), granted by `agentTools` or a
  glob that matches it;
- **a one-step run** (`workflowOf(ctx) === RUN_STEP_FLOW`): an app page's
  or a host's `step_run`, `meta/run-step` (how an agent runs any step by
  name), and `POST /steps/:type/run`;
- **a proposal's apply** (`ctx.proposal`): an agent whose `approve:` gates
  the step proposes the call instead of running it, and the apply would
  otherwise post what the agent wrote.

Each fails with `workflow_only: place/post runs as a step of a workflow,
never an agent's tool`, which a model reads as its call's error.

`place/list` is a read and refuses none of these.

## 5. Strut hands the post to the host

First strut refuses what it can tell itself: `no_host:` (no host of
that name is ready: a key and `PUT /hosts/me`), `not_linked:` (§3) and
`no_place:` (not one of the host's places here). Then it POSTs to the
host's `hook`, the URL from `PUT /hosts/me`:

```json
{ "event": "post", "id": "9f86d081884c7d659a2feaa0c55ad015", "key": "<the tribe's pubkey>",
  "text": "…", "reply": "<a message id>", "run": "<runId>", "workflow": "morning-digest" }
```

- **`id`** is 32 hex: strut's hash of the workflow's name and the `id`
  given, or, with none, of the run's id and the step's path. A retry of the
  step (the workflow's `retry:`) and a run resumed after a restart send the
  first try's id again. Each `foreach` item has a path, so an id, of its
  own; a given `id` there names each item (`digest-{{ item.day }}`). One
  workflow's `id` never meets another's.
- **The answer**, `200 { id, sats? }`: posted. `200 { id, again: true }`:
  this id was posted before, and nothing was posted now. The step answers
  either.
- **A refusal** is `{ error, code }` with a `4xx`, and the step fails with
  `<code>: <error>`: `no_place` (the host has no such place), `not_joined`
  (a place it is not in yet), `bad_reply` (`reply` is no message of that
  place). A `502 send_failed` is a post the medium refused (the treasury's
  balance, the tribe server). Nothing was kept, so the same id may try
  again.
- **No answer**, a `429`, or a `5xx` other than `502`: tried again after 1
  and 5 s, each try waiting 30 s (a send waits for the LSP, as Support's DM
  does). Then the step fails with `host_unreachable:`. The host posts one id
  once, so a try that posted but whose answer was lost answers `again`.
- **A `2xx` with no `id`** is a host from before posts (the daemon answers
  the nudge `{ ok: true }` whatever the body): `host_cannot_post:`. Nothing
  was posted; that host only read its places again.

Strut logs the hook's origin alone: its URL carries the host's token,
which `PUT /hosts/me` never answers either.

**Routing.** Strut reads `host` and `key` only to check the person and
the place, then hands the post to that host's hook. It knows nothing of
the medium: no tribe, no thread root, no chunking. Every word of §6 is the
daemon's.

**A second host** (ruling 4). The daemon is the only host with places
today. Another kind of place needs two things, and nothing in strut's
step, capability or contract changes:

1. **Its hook takes the post**: `{ event: "post" }` as above, answering the
   message's id and posting one id once.
2. **Its places are in strut's table.** Today only a person adds one,
   through Peel (`POST /people/places`), because nobody can reach the
   daemon. `jamie-in-tribes.md` §5.4, "Other hosts", expects a host to
   write its own (a Slack host the channels it was `/invite`d to) through a
   host route that is not built. §10 has what Slack and mail would need
   besides.

## 6. The daemon posts it

In stakwork/sphinx `wasm/daemon`.

- **The route.** `POST /strut/places` takes both events: `{ event: "post" }`
  is a post in one of its places; anything else is the nudge, as now. The
  path stays: no new hook, no new token, and a strut that holds the old
  hook needs nothing.
- **The place.** `key` must be one of its places as last read from strut.
  A key it does not have, it reads the list once more first (a place linked
  a second ago, before the nudge's read), then answers `404 no_place`. A
  place whose tribe it is not a member of yet (a private tribe waiting on
  its owner, a join that failed) is `409 not_joined`.
- **Once per id.** It keeps each post's id with the message it sent and
  what it paid, the last 5,000, in `strut.json`. A repeated id answers the
  first post, `again: true`. A second call while the first is sending waits
  for it. A send that fails keeps nothing. A crash between a send and
  its keep can post twice, as the outbox can.
- **The post.** As a reply is posted (`daemon.ts` `apply`): under `reply`
  and in its thread, chunked when long, under the tribe name (Jamie), with
  `metadata.strut: { run, workflow }`. A `reply` that is no message of that
  tribe in its log is `400 bad_reply`.
- **A reply to it.** A member's reply to a workflow's post is a turn only
  when it mentions the account (`@jamie`), as a reply to another member is.
  A reply to Jamie's own answer stays a turn either way, as now. Such a
  turn's prompt opens with the post it answers (`(replying to Jamie:
  "…")`, its first 1,000 characters): the post is in no conversation, and
  `recent.txt` starts after the account last spoke.

## 7. Why the hook, not the message token

The other way was to open the daemon's message token to tribe posts (a
`POST /post { tribe, text, reply? }` beside `POST /dm`) and give strut a
capability over it, as Support's DMs are. Rejected:

1. **Strut would gain tribe code.** Which tribe a place is, whether the
   account is in it, a reply's thread root, chunking: the daemon already
   does each for its replies. `jamie-in-tribes.md` rulings 3 to 5 keep all
   of it in the host.
2. **Not generic** (ruling 4). A capability over a Sphinx token makes a
   Sphinx step, and a workflow written with it is tied to tribes. On the
   hook, it moves to another kind of place by changing `host` and `key`.
3. **A wider token.** The message token would post in every tribe the
   account is in, places or not.
   The hook posts only in the daemon's places, checked twice: strut checks
   its list, the daemon its own and its membership.
4. **Nothing to configure.** Strut already holds the hook. The message
   token is a wallet setting (`LIGHTNING_DAEMON_MESSAGE_TOKEN`) a box may
   not have, and the host key works without it.
5. **Its fence is the wrong one.** The `sphinx` capability is only on an
   admin app's bag. Posting is for any linked person's workflow, so a tribe
   capability on that token would need a new fence anyway.

The hook's token was already in strut's process, so a step that posts adds
no secret there. Stadeum's `AGENTS.md` rule 4 already accepts that an agent
could make Jamie post through it; this makes posting a designed door, fenced
from agents (§4).

## 8. Decisions (defaults; Evan may overrule)

| # | Question | Default | Why |
| --- | --- | --- | --- |
| 1 | How strut reaches the host | Its registered hook, `{ event: "post" }`, answered at once (§5) | §7 |
| 2 | Whose person a run posts as | `ctx.principal`: who launched it, else the workflow's owner | An automation's digest has no launcher. `runsAs` already names its person |
| 3 | A workflow an agent wrote | May post: it is a workflow. A host that wants otherwise leaves `place/*` out of `builder.reach.tools` (`src/reach.ts`) | Ruling 2 fences the agent's own calls. A digest is exactly a workflow Jamie builds for a person |
| 4 | A test run of a workflow that posts | Posts for real, as `slack/post-message`'s does. The step's description says so | No write step has a dry run |
| 5 | Who the post is from | The box's account under its tribe name (Jamie). The post names no person; the run and workflow ride in `metadata.strut` | As every reply. Strut can't post as the person: Peel holds their key |
| 6 | Once only | Per id, the host keeping the last 5,000 (§5, §6) | A retry, a resume and a lost answer each post once |
| 7 | A place the daemon isn't in yet | Refused, `not_joined:`, never queued | A digest posted a day late is wrong. The workflow's `retry:` decides |
| 8 | A post the medium refuses | `send_failed:`, nothing kept; the same id may try again | As the outbox drops a post after three failures, but the workflow decides |
| 9 | Threading | `reply` names an earlier post's `id`; under it and in its thread, as a reply is threaded | A workflow keeps a day's items under one post. A member's message id never reaches a workflow |
| 10 | A member's reply to a workflow's post | A turn only with `@jamie`, its prompt opening with the post (§6) | The post is not Jamie talking to anyone. Each turn costs a reply's price |
| 11 | Text | 1 to 10,000 characters, chunked by the host. Files later (§10) | A digest is text. The daemon's file posts are DMs only today |
| 12 | A host from before posts | `host_cannot_post:` on a `2xx` with no `id`. No version handshake | It answers the nudge and posts nothing, so nothing is lost |
| 13 | The daemon's route | `POST /strut/places` takes both events. No rename | A post goes into a place. Strut's stored hook stays right |
| 14 | Listing places | `place/list`, a read, for the same people as `place/post`: every place here, `{ host, key, name? }`, never the link or the linker's key | Ruling 1 lets them post anywhere here. A link would let a reader join a private tribe |
| 15 | Where the capability is | `places` on the shared bag, held to the run's person by the package fence | Any workflow may post (ruling 1). A visitor's bag is an allow list and does not get it |

## 9. Work items

Each is its own PR against its repo's default branch, never stacked.

| Item | Repo | What | Needs | State |
| --- | --- | --- | --- | --- |
| 1 | strut | **The steps** (§2 to §5): `place/post` and `place/list` in `src/steps/lib/place/`; `workflowStep(ctx)` in `src/run-step.ts`; `placesCapability` in `src/people.ts`, on the shared bag in `createStrut.ts`, `places` on `StrutCapabilities`; `places.post` in `heldToItsRun`. Tests in `src/places.test.ts` with a stand-in hook: one id posts once; `not_linked:`, `no_place:`, `no_host:`, `host_cannot_post:`, `host_unreachable:`; `workflow_only:` as an agent's tool, through `meta/run-step` and on a proposal's apply. Docs: `specs/API.md` §13.4 (the hook's two events and the post's contract), `docs/security.md` "Linked places", `AGENTS.md`'s Areas row for security adds `place/*` | — | Not started |
| 2 | sphinx | **The daemon posts** (§6): `{ event: "post" }` on `POST /strut/places`; the place and membership checks; once per id in `strut.json`; threading; a reply to a workflow's post. Tests post to its own hook, so no strut is needed. `wasm/daemon/README.md`: the admin API's row for `/strut/places` names both events, and "Answering in tribes as strut's host" gains "A workflow's post" | — | Not started |
| 3 | stadeum | **Docs only.** `docs/stack-spec.md`, "Jamie in tribes": a workflow run as a person linked to the box may post in a linked tribe, paid from the treasury as replies are. `AGENTS.md` rule 4: posting through strut is a designed door, fenced from agents. No setting changes | 1, 2 on `stable` | Not started |

Items 1 and 2 can be built at once: each tests against a stand-in for the
other. A box gets posts once both are on `stable`; until then a post fails
with `host_cannot_post:` and posts nothing.

## 10. Later

- **Files in a post** (an image with the digest): the daemon's tribe sends
  already take media (`sendTo`'s `media`); the hook would take `files` as
  a launch does.
- **A cap** on what posts spend, if a tribe's price ever becomes a problem
  (ruling 3, as `jamie-in-tribes.md` §11).
- **Places in the Jamie app**: a person's places and every place they may
  post in, beside Connect (`jamie-in-tribes.md` §11).
- **A reply to a workflow's post going to the workflow** (a poll, an
  approval asked in the tribe) rather than to Jamie.
- **Slack channels as places.** stadeum `plans/jamie-in-slack.md` (proposed,
  nothing built) has no places, its decision 6: Slack's `/invite` decides
  where Jamie is, and stadeum-ui is the host. Posting there would need that
  decision revisited, and the host route that adds a host's own places
  (§5, "A second host").
- **Mail as a place.** stakwork/strut-gmail is a package whose own steps
  send with each person's token: no host, no places. It would need a
  ruling on whether a package can act as a host.

## 11. Rejected

- **The daemon's message token opened to tribes**, with a strut capability
  over it (§7).
- **`place/post` as an agent's tool.** Ruling 2.
- **A Sphinx-only step.** Ruling 4.
- **A queue in strut the daemon reads** (Hive's outbox). A store and a
  loop, and the step would wait for the post's answer by parking.
- **Strut retrying with a fresh id.** A lost answer would post twice.
- **Posting as the person**, from their own Sphinx account. Strut and the
  box hold no person's key; Peel does.
