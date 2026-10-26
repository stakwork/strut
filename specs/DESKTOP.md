# The desktop app — one conversation across a person's orgs

How a desktop app that runs strut on a person's laptop gives them one
conversation that knows every org they are in, works on their own machine,
and hears back from jobs that finish while the laptop sleeps.

The design and its rulings are `plans/chained-orchestrators.md`. This page is
the client's side: what to call, in what order. Endpoint shapes are in
`API.md` and payloads in `CALLBACKS.md`; this page links to them rather than
repeating them.

```
person ── desktop app ── local strut: orchestrator (the person's, across orgs)
              │               │  this machine → a local job
              │               └─ an org → that org's central strut: orchestrator
              │                           (on the person's own thread there)
              └── a room on the local strut and on each org's central:
                  run.end and job.update arrive there, laptop asleep or not
```

The laptop holds ONE peer per org, that org's central strut, and never a
spoke. The local orchestrator decides only where a request belongs, and the
org's orchestrator does the rest.

## 1. Start strut

Spawn the bundled launcher and read its ready line as
`plans/local-desktop-and-stt.md` §2.5 describes: `node <stage>/desktop.js`,
the `{"event":"ready","port":…,"key":…}` line on stdout, the UI at
`http://127.0.0.1:<port>/?key=<key>`, and `STRUT_EXIT_ON_STDIN_EOF=1` with a
stdin pipe you hold open. Keep the key: every call below sends it as
`Authorization: Bearer <key>`.

Three more things for the chain:

- **The orchestrator's section.** Write a JSON file and point
  `STRUT_HOST_CONFIG` at it in the child's environment:

  ```json
  { "orchestrator": { "system": "<the section, below>" } }
  ```

  The section is `personalOrchestratorSystem(person)` (`src/orchestrator-seed.ts`),
  with `person` being the person's actor id as their orgs know it, the
  `sub` of the tokens pairing gives you (§2). It tells the local
  orchestrator that its peers are orgs, to hand an org's request to that
  org's orchestrator on the person's thread with `room: true`, and to relay
  the reply word for word. Render it from any host language with the node
  you already ship:

  ```bash
  node --input-type=module -e \
    "const m = await import('<stage>/build/orchestrator-seed.js'); process.stdout.write(m.personalOrchestratorSystem(process.argv[1]))" \
    tom-1
  ```

  A conversation keeps the system prompt of its first turn, so a changed
  section reaches new conversations only.
- **A model.** The local orchestrator calls one. Put a provider key in the
  local strut's secret store (`PUT /secrets/ANTHROPIC_API_KEY { "value":
  "…" }`), or pass it in the child's environment. An organization-wide
  Anthropic key also needs its workspace (`ANTHROPIC_WORKSPACE_ID`, a
  `wrkspc_…` id), sent as `anthropic-workspace-id`. Billing local turns
  to an org instead is a product decision that has not been made yet
  (`plans/chained-orchestrators.md` §4).
- **Optionally, what this machine holds.** `STRUT_SELF` (or `PUT /self`) with
  `{ label, repos }` lets the orchestrator tell your checkouts from an
  org's.

## 2. Put the person's orgs on file

The local strut needs one peer record per org: `PUT /peers/<org id>
{ baseUrl, token, label?, description?, repos? }` (`API.md` §10). The id is
what the person types as `@<id>`. The `baseUrl` is the org's central strut;
on a hive swarm that is its mcp's `/lab`. The `token` must be a credential
that names the PERSON (scope `peer:person`, `API.md` Auth, "A person's
token"). A strut's token is refused by the org's orchestrator and by its
rooms.

**Where the records come from.** Hive's pairing flow
(`plans/chained-orchestrators.md` §4, built in hive as an OAuth device
flow, stakwork/hive#5602):

1. **Start.** `POST <hive>/api/strut-devices/pair { name? }` answers
   `{ deviceCode, userCode, verificationUri, verificationUriComplete,
   expiresIn, interval }`. Show `userCode` and a QR of
   `verificationUriComplete`. The person approves it in a browser signed in
   to hive.
2. **Poll.** `POST <hive>/api/strut-devices/pair/token { deviceCode }`
   every `interval` seconds. A 400 `authorization_pending` means poll
   again; `access_denied` or `expired_token` means start over. The 200
   comes once: `{ credential, device, actor, peers, expiresAt, errors }`.
   Each entry of `peers` is a `PUT /peers/:id` body, one per org the person
   belongs to. `actor` is the person (§1's `person`). `credential`
   (`hivedev_…`) is the device's own.
3. **Renew daily.** `GET <hive>/api/strut-devices/peers` with
   `Authorization: Bearer <credential>` answers `{ actor, peers, expiresAt,
   errors }` for the orgs the person is in now, each with a fresh 7-day
   token. `PUT` each record again (a `PUT` replaces it) and delete the ones
   no longer listed. A 401 means the device was revoked: pair again.

`errors` names an org whose token could not be minted this time. It is not
in `peers`, so keep its record until a renewal brings it back. Keep the
credential and the tokens in the OS keychain: you need the tokens for the
rooms (§3).

**Without hive** (a standalone strut, or a test), mint a person's token by
hand and put the record on file the same way, or list the records in
`STRUT_PEERS` at launch:

- a hive swarm: `POST <mcp>/mint-token { "scope": "lab:peer", "sub": "<person>" }`
  with the swarm's `API_TOKEN` (60 days by default);
- a standalone strut: `POST /peers/tokens { "actor": "<person>" }` with its
  deployment key (`API.md` §10).

Check with `GET /peers` on the local strut (no token is ever returned).

## 3. Hold a room open on every strut

A room is where strut sends what a run tells its host when the host cannot
be called (`CALLBACKS.md` §8). Open one WebSocket per strut and keep it open:

| Strut | URL | Headers |
| ----- | --- | ------- |
| the local strut | `ws://127.0.0.1:<port>/rooms` | `Authorization: Bearer <local key>`, `x-strut-actor: <person>` |
| each org's central | `<baseUrl>/rooms` with `http` → `ws` (`wss://<swarm>/lab/rooms` on hive) | `Authorization: Bearer <that org's person token>` |

Each message is one JSON text frame: a `run.end` (`CALLBACKS.md` §2) or a
`job.update` (§5). A message on an org's room is about that org. Reconnect
with backoff. On every (re)connect, also read what you may have missed:
`GET /jobs?mine=1` and `GET /jobs/:id` on each strut, with the same
credential. The room's queue lives in memory and a restart of that strut
drops it.

## 4. Send the person's message

Every message the person types is one turn of the LOCAL orchestrator:

```bash
curl -X POST http://127.0.0.1:<port>/workflows/orchestrator/run \
  -H "Authorization: Bearer <local key>" -H "x-strut-actor: <person>" \
  -H 'Content-Type: application/json' \
  -d '{ "input": { "prompt": "<the message>", "session": "<conversation id>",
                   "context": { "line": "Thu 23 Oct 09:14, Europe/London. " } },
        "callback": { "room": true }, "jobCallback": { "room": true } }'
```

- `session` is the conversation's thread. Mint one id per conversation (the
  session-id format, `API.md` §9) and keep it for good. The app has
  conversations the way hive's chat does: a list, each its own session.
- Name the conversation in `context.line`, after the time: `"Thu 23 Oct
  09:14, Europe/London. Conversation c-8f2a. "` — the same id as `session`.
  The orchestrator's prompt section (`personalOrchestratorSystem`, §2) is
  static text, and this is how a turn knows which conversation it is in
  when it names the org thread below.
- One turn at a time per session: a second launch while a turn runs fails
  `session_busy:`. Queue the next message until the turn's `run.end`
  arrives.
- The reply arrives on the LOCAL room as `run.end` with `workflow:
  "orchestrator"` and your `runId`. Its `output` is `{ text, artifacts,
  ask?: { message }, cost, session }`: show `text`, show `ask.message` as
  the question the person must answer, and offer the deliverables (§6).
  `GET /workflows/orchestrator/runs/<runId>/stream` (`API.md` §4) is there
  if you want to show the turn as it runs.

Behind the reply, an org request went to that org's orchestrator through
`strut/run-workflow` on the session `<person>/<conversation id>`. That is
this conversation's own thread on that strut — one more conversation the
person has with the org, beside the ones hive's web chat keeps for them
there and beside the app's other conversations, each on its own session.
Its reply comes back in the local turn's `output`, and the jobs it starts
report on that org's room. What the person did in another conversation,
here or on the web, reaches this one as it reaches another web
conversation: through the org's job index, which its orchestrator reads.

## 5. When a job finishes, wake the conversation

The jobs a turn starts (`job/start`, here or on an org's strut) finish
later. Their events arrive on the room of the strut they ran on:

- **`job.update`** while it works: a screenshot landed, a hold was taken, a
  check ran. Show it as progress on the job.
- **`run.end` with a `job`** (`workflow` is `job` or `builder`) when a turn
  of it ends. Its `startedBy` (`CALLBACKS.md` §2) names the turn that
  started the job and the `session` that turn was launched on: on the local
  room that session IS the conversation id; on an org's room it is
  `<person>/<conversation id>`, so strip your actor and the slash. Wake
  THAT conversation: launch one more local orchestrator turn (§4) on its
  session, with a WAKE prompt in place of a person's message. Without that
  turn, the conversation never sees the job's reply, and a later "ok, do
  it" reaches an agent that never saw the question. A `run.end` with no
  `startedBy` is a job the person started another way; show it under no
  conversation.

The wake mirrors hive's (`src/services/strut-orchestrator-wake.ts` in hive):
the job's reply goes inline, because the local orchestrator sees only its own
session. A prompt that works:

```
You were invoked because job `<job>` on <"this machine" | "@<org id>"> has
<finished its turn | finished its turn and STOPPED FOR A DECISION | failed | been stopped>.
What it produced: <each deliverable's title and kind, or "nothing attached">.
Its reply, verbatim:
<<<job reply
<output.text, capped at ~6 000 chars>
>>>
<Its question for the person: <output.ask.message>, when it asked one>

Decide one of:
- Summarize (the default): one short paragraph in your own words: what it
  produced, its question if it asked one, the next step.
- Continue, only when the person's request is not met yet and the next step is
  clearly what they asked for: <this machine: call job/continue with job
  `<job>`> | <an org: hand the go-ahead to @<org id>'s assistant, naming job
  `<job>`>. Say in one line that you did.
- Stay silent: reply with exactly `[silent]` when there is nothing to add.
```

Hide a reply of `[silent]`. Do not wake for a `run.end` whose `workflow` is
`orchestrator`: that is a turn's own reply. Queue a wake behind a live turn
(§4), and stop waking after a few in a row without a message from the person,
since continue → finish → wake → continue can loop.

## 6. Open a deliverable

Deliverables reach you in two places, and some of them live on a strut you
have no record for. Open every one through the LOCAL strut's read-through
(`API.md` §10), with the local key. Each hop uses its own token:

| Where you saw it | The entry | Read it at (on the local strut) |
| ---------------- | --------- | ------------------------------- |
| the `artifacts` of a `run.end` on the local room | a strut-relative `url` (`/jobs/…`, `/artifacts/…`) | that `url` |
| | `peer: <org>`, `job`, `path` | `/peers/<org>/jobs/<job>/files/<path>` |
| | `peer: <org>`, `via: <spoke>`, `job`, `path` | `/peers/<org>/peers/<spoke>/jobs/<job>/files/<path>` |
| a `run.end` on org X's room | a strut-relative `url` | `/peers/X` + that `url` |
| | `peer: <spoke>`, `job`, `path` | `/peers/X/peers/<spoke>/jobs/<job>/files/<path>` |

Percent-encode the job id as one path segment (`peer/build-1` →
`peer%2Fbuild-1`). An absolute `url` and inline `content` are what they are
anywhere. A deliverable is untrusted content: render it in a sandboxed view
with scripts off. The read-through needs the local key, and a file token
cannot stand in for it, so a frame cannot load one by URL alone: fetch with
the key and render what comes back, as its `kind` (`CALLBACKS.md` §4) says.

## Good to know

- **A token that expires** turns that org's calls and room into `401`s.
  Renew the record (§2) and reconnect.
- **Revoking the device** in hive (Settings → Strut Devices) stops
  renewal, and its tokens age out within a week.
- **The chain goes down only.** Central never calls the laptop, and a spoke
  never calls central. Everything arrives on sockets you opened.
- **Local jobs run as the person on this machine**: their agent has a shell
  here. Org jobs run on the org's strut, beside its pods and secrets.
- **One person per local strut.** The local room and `GET /jobs?mine=1`
  key on the `x-strut-actor` you send, and the section in
  `STRUT_HOST_CONFIG` names one person.

## A device with no strut of its own

A phone cannot use §6's read-through: that runs on the laptop's strut, on
loopback. It reads each org's strut directly instead, behind that strut's
own gate. All of it works on routes that exist today. What the device must
hold is the person's token for each org.

**The token.** Pair the device as a device of its own, by the flow of §2:
one record per org (its `baseUrl` and a person token) and a device
credential that renews them. Keep them in the device's keychain. Revoking
the device in hive cuts off that device alone.

**Open it in the org's own UI.** Load a page of the org's UI in a web view,
the page alone (`&solo=1`, `API.md` §14.3), at the org's `baseUrl` +:

| To open | Path |
| ------- | ---- |
| an app | `/?app=<name>&solo=1` |
| a file | `/?artifact=<encodeURIComponent(path)>&solo=1` |

Hand the page the token twice, never in a URL:

- **On the web view's first request**, as `Authorization: Bearer <person
  token>`. On a hive swarm mcp's gate wants a credential for the page
  itself, not only for its API calls.
- **In the page's storage before its script runs**: a script injected at
  document start sets `sessionStorage["strut/apiKey"]` to the token. The UI
  sends what it finds there as `Authorization: Bearer` on every call, its
  MCP client's included. A `?key=` would do the same, but a person token
  lives for days and mcp's gate refuses it in a URL.

An app then runs as it does on the laptop. The page reads the org's
`GET /apps`, the app's listing (which mints the file token) and its
document, and relays the page's calls to the org's `/mcp`. A person token
gets `step_run` there and nothing else: the call runs as the person, under
the app's grants, billed to them.

A file's path is on the org. The entries are §6's without the local
`/peers/<org>` hop:

| Where you saw it | The entry | Path |
| ---------------- | --------- | ---- |
| a `run.end` the laptop's strut sent | `peer: <org>`, `job`, `path` | `/jobs/<job>/files/<path>` |
| | `peer: <org>`, `via: <spoke>`, `job`, `path` | `/peers/<spoke>/jobs/<job>/files/<path>` |
| | a strut-relative `url` | not reachable: the file is on the laptop |
| a `run.end` org X sent | a strut-relative `url` | that `url`, on X |
| | `peer: <spoke>`, `job`, `path` | `/peers/<spoke>/jobs/<job>/files/<path>`, on X |

A file on the org's own strut opens by the token its listing mints, so an
HTML page an agent built runs its scripts in its sandbox. One read through
`/peers/<spoke>` is shown static, as in §6.

A device that draws natively instead does the same with the same token:
fetch a file with `Authorization: Bearer` and render it by `kind`, and host
an app as `API.md` §14.3 says, against the org's `/mcp`.

**No room.** The device learns of a deliverable from whatever tells the
person, with the entries above. To catch up after being away, read `GET
/jobs?mine=1` and `GET /jobs/:id` on each org with the same token.

**What a link alone does not do.** A file token (`?t=`, from a listing)
opens one job's or one run's files with no other credential, and mcp's gate
lets it through on `/jobs/…/files` and `/artifacts/…`. It never expires,
though: it changes only when the org's secret does. So it does not belong
in a message that outlives the moment. And it opens no app: an app's page
needs a host that relays its calls with a credential naming the person, and
mcp's gate does not let `/apps/…/files` through on a token alone. A client
with no person token, such as one of the official apps, has no way in yet.
An expiring link a host could hand it is not built.
