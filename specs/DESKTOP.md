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
  "…" }`), or pass it in the child's environment. Billing local turns
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
(`plans/chained-orchestrators.md` §4), which hive has not built yet: you
show a short code and a QR of the same link, the person approves it in a
browser signed in to hive, and you poll hive until it hands back one record
per org the person belongs to, plus a device credential. Renew daily through
hive with that credential, and `PUT` each record again (a `PUT` replaces the
record). Keep the tokens yourself too, in the OS keychain: you need them for
the rooms (§3).

**Until pairing exists**, mint a person's token by hand and put the record
on file the same way, or list the records in `STRUT_PEERS` at launch:

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
  session-id format, `API.md` §9) and keep it for good. One conversation per
  person is the simple start, and the wake (§5) assumes it.
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
`strut/run-workflow` on the session `<person>/<org id>`. That is the
laptop's own thread on that strut — one more conversation the person has
with the org, beside the ones hive's web chat keeps for them there, each
on its own session. Its reply comes back in the local turn's `output`,
and the jobs it starts report on that org's room. What the person did in
a web conversation reaches this one as it reaches another web
conversation: through the org's job index, which its orchestrator reads.

## 5. When a job finishes, wake the conversation

The jobs a turn starts (`job/start`, here or on an org's strut) finish
later. Their events arrive on the room of the strut they ran on:

- **`job.update`** while it works: a screenshot landed, a hold was taken, a
  check ran. Show it as progress on the job.
- **`run.end` with a `job`** (`workflow` is `job` or `builder`) when a turn
  of it ends. Wake the conversation: launch one more local orchestrator turn
  (§4) on the same session, with a WAKE prompt in place of a person's
  message. Without that turn, the conversation never sees the job's reply,
  and a later "ok, do it" reaches an agent that never saw the question.

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
- **Revoking the device** in hive, once pairing exists, stops renewal, and
  its tokens age out within a week.
- **The chain goes down only.** Central never calls the laptop, and a spoke
  never calls central. Everything arrives on sockets you opened.
- **Local jobs run as the person on this machine**: their agent has a shell
  here. Org jobs run on the org's strut, beside its pods and secrets.
- **One person per local strut.** The local room and `GET /jobs?mine=1`
  key on the `x-strut-actor` you send, and the section in
  `STRUT_HOST_CONFIG` names one person.
