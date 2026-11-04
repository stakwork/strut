# App channels: live messages between the people on an app

> **Status (2026-11-04): proposed. Nothing is ruled and nothing is built.**
> Written after the question "could someone build a multiplayer game as a
> strut app?" A game has few workflows (a scoreboard, a referee) and needs
> fast messages between the people playing it, which strut does not have.
> Every row below is mine and open to a ruling; the guesses are listed
> under "Open questions". Companion to `apps.md` (the app door, its grants,
> the kit and the hosts) and `live-feeds.md` (the long-poll this builds
> on). Not the same thing as `chained-orchestrators.md` §3's ROOMS: a room
> is one person's socket for their own callbacks. A channel is shared by
> everyone on an app.

## Problem

An app page reaches strut only through `step_run`: the page's CSP has
`connect-src 'none'` (`src/apps/build.ts`, `cspFor`), its frame is
`srcdoc` under `sandbox="allow-scripts"` with an opaque origin, and the
host relays its `tools/call` to strut's `/mcp`. So two people on the same
app can reach each other only through something strut stores and the
other one reads:

| Has | Lacks |
| --- | --- |
| Graph writes on the app's declared types, read by everyone | a message that is not a record: a move in progress, a cursor, a "ready" |
| `graph/changes` (`useGraphChanges`): a long-poll that answers 1 s after the first write (`FEED_GATHER_MS`) | anything faster than about a second, end to end |
| `app/state`: one viewer's own JSON | state shared between viewers that nobody needs to keep |
| Rooms (`src/rooms.ts`): a socket per ACTOR for their callbacks | anything between two people, or anything a page can use |
| The app monitor (`src/apps/monitor.ts`): `repeat` warns at 120 identical calls a minute, `volume` at 600 calls a minute per app version | a door that is meant to be busy |

What that means for a game today:

- **Turn-based works.** A move is a graph node; the other player sees it
  1–2 s later through `useGraphChanges`. Chess, cards and trivia work,
  slowly, and every move is a node forever.
- **Anything live does not.** Cursors, positions, "typing…", a lobby that
  fills as people arrive: polling for them trips the monitor in seconds,
  and each one written to the graph is a record nobody wanted.

## Design in one paragraph

A **channel** is a short in-memory log of JSON messages, named by an app
and shared by every viewer of that app. Two steps, `channel/send` and
`channel/read`, reach it through the same `step_run` every app already
uses. A read waits on the server, like `job/updates`, but answers at once,
not after a second. Strut stamps every message with who sent it. Nothing is
kept: no run, no log line, no graph node, and a restart empties every
channel. So it needs no host changes and leaves the page's CSP as it is,
and the app still reaches strut through one door. The kit wraps it as
`useChannel`. What must last (scores, results, the board after each turn)
still goes through a workflow or the graph. The channel carries what is
happening now.

## 1. A channel

**Where it lives.** One `LiveFeed` (`src/live-feed.ts`, unchanged) per
`(app name, channel name)`, in this process, built the first time anyone
sends to it or reads it. The app's NAME, not its version: every version
shares its channels, as it shares `app/state` and its jobs, so a publish
mid-game does not split the players. An app that changes its message
format puts a version in its messages.

**A message** as a reader gets it:

```ts
interface ChannelMessage {
  /** The sender, stamped by strut: never what the page wrote. */
  from: {
    actor?: string;   // the connection's actor: vouched by its credential
    client: string;   // the page's own id (the kit mints one per page load): not vouched
    run?: string;     // set when a workflow sent it (§3)
  };
  key?: string;       // a STATE: replaces this sender's last message with the same key
  data: unknown;      // the page's JSON, at most CHANNEL_MESSAGE_MAX_BYTES
  at: number;         // when strut took it (ms)
}
```

**State and events.** A message with a `key` is a state. The newest one
replaces the last one from the same sender with the same key: a player's
position, their cursor, "ready". The feed's `keyOf` is `actor + client +
key`, so a page can overwrite only its own states. A message with no key
is an event (a chat line, "fired"), which no later message replaces. This is
`LiveFeed`'s own model ("the newest state of each thing"), so a reader that
joins late, or falls behind and gets `reset: true`, still gets every
sender's current state and the most recent events in one answer.

**Order.** One order per channel, `LiveFeed`'s `seq`. A reader sees every
message after its cursor in that order, or `reset: true` when the feed has
dropped some of them.

**Limits** (constants, in `src/channels.ts`):

| | Value | Why |
| --- | --- | --- |
| `CHANNEL_MESSAGE_MAX_BYTES` | 8 KB of JSON | a move, not a file; files go in a job (`job/upload`) |
| `CHANNEL_KEEP` | 256 messages | the feed's `max`: states plus recent events |
| `CHANNEL_SEND_RATE` | 30 messages a second per sender, bursts of 60 | a token bucket per `(app, actor, client)` |
| `CHANNEL_GATHER_MS` | 20 ms | how long a woken read waits for more before it answers: batches a burst, adds little delay |
| `CHANNEL_IDLE_MS` | 10 minutes | a channel nobody sent to or read from is dropped |
| `CHANNELS_PER_APP` | 1 000 | past it a new channel is refused, naming the cap |

## 2. The steps

`src/steps/lib/channel/`, thin over `ctx.services.channels`
(`src/channels.ts`, built by `createStrut` like the job and graph feeds).
Both refuse to run without `ctx.app`: a channel always belongs to an app.

- **`channel/send { channel, messages: [{ key?, data }], client }`** →
  `{ cursor }`. Takes several messages at once, because the kit batches
  whatever is waiting while a send is in flight (§4). Refused past the
  size, rate or count limits, with the limit named.
- **`channel/read { channel, since?, wait?, limit?, client }`** →
  `{ cursor, reset?, more?, messages }`. `since` absent reads everything
  the channel keeps (what a newcomer needs); `"now"` reads only what comes
  after. `wait` holds while there is nothing new, up to
  `FEED_MAX_WAIT_MS`, and a woken read answers `CHANNEL_GATHER_MS` later.

`channel` is a name the app chooses: `lobby`, or a fresh unguessable name
for a private game (§4). Names follow the session-id format (`idProblem`).

## 3. Who may send and read

- **A page**, through `step_run`, when the app's `grants.steps` names
  `channel/*`. That uses the grant check that already exists; `app.yaml`
  gets no new field. The door takes the app from the page's signed
  identity (`appOfIdentity`), so a page can never name another app's
  channel. Any viewer of the app may read or send on any of its channels
  by name. The audience is the people the host already lets open the app
  (strut's key or session, a Hive workspace member, a person token on a
  peer), and a channel never adds to it.
- **A workflow** the app launched (`run/launch`, so `ctx.app` is set) may
  send and read, stamped `from.run`, with the run's actor. That covers a
  referee that announces a result, or an AI player whose agent is granted
  `channel/*`. A run without `ctx.app` is refused. Its own `channel/*`
  steps are in its run log, like every step a workflow runs.
- **Who sent it** is strut's stamp. `actor` is as good as the
  connection's credential (Hive sets the member as `x-strut-actor` on its
  relay; a person token is its own actor). `client` is the page's word,
  and only tells apart two tabs of the same person. A display name a page
  sends in its data is the page's word too. On a strut with no actor (dev,
  no key) every message is anonymous and only `client` tells senders
  apart.

## 4. The kit: `useChannel`

```ts
const { states, events, members, send, ready, error } = useChannel(name, {
  onMessage?: (m: ChannelMessage & { mine: boolean }) => void,   // for a game loop: no React state per message
});
send(data);                       // an event
send({ x, y }, { key: "pos" });   // a state
```

- **One read in flight**, as `useFeed` keeps one today: read everything
  kept, then wait on the cursor; none while the page is hidden.
- **One send in flight.** What is sent meanwhile waits and goes in the
  next call, a newer state replacing a waiting one with the same key. So
  messages leave in order and a page makes at most one send call per
  round trip, however often it calls `send`.
- **Presence in the kit, not on the server.** While the page is visible
  it sends `{ key: "$here" }` every 5 s, and `members` are the senders
  whose `$here` is under 15 s old. Strut has no presence code, a member
  is who strut stamped, and someone who closes the tab or hides it drops
  out on their own.
- **`newChannel()`** mints an unguessable name, and `appLink(app, {
  channel })` makes the invite. The link opens the app with the name as
  `tool-input` (apps.md §7.1). Whoever has the link can join the game,
  just as a link to the game would let them in.

## 5. The door's fast path

Every `step_run` today reads the app (`apps.get`), resolves the step, and
goes through `runStep`, which reads the workspace for `stepHashes` and the
claims layer to decide whether to keep the run. That is fine for a few
calls a minute and wrong for a game. `channel/*` gets a path of its own in
`buildAppTools` (`src/apps/tools.ts`):

1. The identity check, as now (an HMAC, no I/O).
2. The manifest from a cache keyed by `(name, version)`: a version is
   immutable, and a preview is already in memory. Deleting an app drops
   its entries.
3. The grant check, as now.
4. The input parsed by the step's own schema and handed to
   `services.channels` with `{ app, actor, client }`. No run, no claims
   read, no `stepHashes`, no store write.

**The monitor** still counts these calls (calls, bytes, server time) so the
app's Usage shows the traffic. `repeat`, `fanout` and `volume` leave
`channel/*` out, because the channel's own limits already bound it. A send
refused at the rate limit counts as a failure, so `failing` warns with a
fix: "send fewer messages, or make them states (`key`) so newer ones
replace older".

## 6. What it costs, and what it is not for

**Delay.** Without measurements (§9 takes them): a message goes page →
host → strut → the other player's waiting read → their host → their page.
On strut's own UI that is about one round trip to the server plus the MCP
door's per-request work. Through Hive each side adds a Hive function
(auth and a database read per call, `strut/apps/mcp/route.ts`). My guess is
tens of milliseconds direct, a few hundred through Hive.

**Good for:** turn-based games, cards, quizzes with a live lobby, drawing
together, cursors and "who is here" at a few updates a second, chat in an
app, a referee workflow, an AI player.

**Not for:** a fast action game at 60 updates a second with prediction
across the internet. That needs a socket, and the only socket a page could
have is one its HOST holds. If measurements say a socket is needed, it
becomes a second transport for the same two steps. Strut would serve a
WebSocket door for channels beside `/rooms`, a host that wants it would
hold one socket per framed app and relay over the bridge, and the kit
would pick it up from the host context. No host would be required to; v1
needs none of this.

**Connections.** Each held read occupies one of the host's connections
to its own origin. Over HTTP/2 (Hive, a swarm behind TLS) that is free.
Over HTTP/1.1 (a strut on plain `http://localhost`) the browser allows six
per origin, shared with the host's own polls and the page's other held
reads (`useRun({ live })`, `useGraphChanges`). The kit holds one read per
channel; an app should use one channel at a time.

## 7. Security

- The page still connects nowhere: the CSP and the frame are unchanged.
- A channel is reachable only by its app's pages and the runs the app
  launched (`ctx.app`, from a signed identity).
- The sender is strut's stamp; `actor` is vouched by the connection.
- The channel's name is the only thing that separates two games of the
  same app. The kit mints unguessable names, and sharing the name is the
  invite.
- Nothing is recorded by the door: no run, no log, no store. Messages live
  in memory until they are replaced, dropped from the 256, or the channel
  goes idle.
- **Not end to end.** Strut and any relay host (Hive) can read the
  messages, the same trust the app's other calls get. A key carried in the
  invite would not hide them from the host either, because the host sees
  `tool-input`.
- **Hive's relay** gates by role only `run/launch` and `run/cancel`; a
  `channel/*` call passes on read access to the workspace. Hive may put a
  floor on it; that is Hive's call, and strut works without it.
- **A gap this makes easier (item 0).** Browsers do not apply
  `connect-src` to WebRTC. If a sandboxed `srcdoc` frame can still
  construct an `RTCPeerConnection`, two pages could use a channel to
  exchange connection details and then talk directly, past strut,
  revealing each other's IP addresses. They could already do that through
  graph writes, more slowly. Item 0 checks this, and closes it where the
  CSP can (`webrtc 'block'`).

## 8. Work items

0. **Probe WebRTC in the app frame.** Can a page in strut's frame (Chrome,
   Firefox, Safari, and WKWebView for Peel) construct an
   `RTCPeerConnection` and gather candidates? If it can, add `webrtc
   'block'` to `cspFor` where it is honored, say on the `App` page that a
   direct connection is not the door, and record what stays open.
1. **`src/channels.ts`**: `ChannelsCapability` (send, read), one
   `LiveFeed` per `(app, channel)` with `keyOf` and `gatherMs` as in §1,
   the stamp, the limits, idle drops. Unit tests: states replace per
   sender, events never do, `reset` after the keep, rate and size refusals,
   idle eviction, one app never reading another's channel.
2. **`channel/send` and `channel/read`** (`src/steps/lib/channel/`),
   refusing without `ctx.app`, and `services.channels` wired in
   `createStrut`. Add both test files to the `npm test` list.
3. **The door's fast path** (§5): the manifest cache (invalidated by a
   delete), `channel/*` dispatched without `runStep`, the monitor's three
   rules leaving it out. Tests in the app tool suite: refused without the
   grant, scoped by the identity's app, `from.actor` the connection's, no
   run kept, no claims read.
4. **The kit**: `useChannel`, `newChannel`, batched sends, `$here`
   presence, `onMessage`; hook tests beside `useJobUpdates`'; the kit
   README.
5. **The `App` Concept page** (`src/concepts/App.md`): when a channel
   is the tool (live, lossy, unrecorded) and when a workflow or the graph
   is (anything that must last); grant `channel/*`; private games through
   `newChannel` + `appLink`.
6. **Docs**: `specs/API.md` (the two steps' shapes in the app section),
   `AGENTS.md` (the layout lines and a Key concepts paragraph).
7. **Validation** (§9).

**No host changes.** Hive's relay forwards a `step_run` of any type,
Peel shows apps through strut's own UI, and a peer's app reaches the
peer's strut through `POST /peers/:id/mcp`. The channel lives on the
strut where the app lives, whoever hosts the page.

## 9. Validation

- A fixture app beside `__fixtures__/hello`: two-player tic-tac-toe,
  where moves are events, each player's cursor is a state, and a
  `scoreboard` workflow records the winner in the graph and announces it
  on the channel.
- Two frames of it in the browser pane, as two viewers: a move shows in
  the other frame, a cursor follows, closing one drops it from `members`
  within 15 s.
- Send → receive delay, measured at the median and p95, on strut's own UI
  and through Hive's relay on a swarm. If the numbers rule out the games
  §6 says are good, revisit the socket transport.
- Ten messages a second from each of four viewers for ten minutes: no
  monitor warning, server time per call in Usage, memory flat once the
  channels go idle.

## Open questions

1. **Long-poll through `step_run`, or a socket the host holds.** The
   long-poll needs no host changes and keeps one door. A socket would be
   faster, but every host would have to relay it. My lean: long-poll now,
   and a socket as a second transport only if §9 needs one.
2. **Channels by app name or by version.** My lean: name, like `app/state`
   and jobs.
3. **Open by name, or a member list per channel.** My lean: open within
   the app's audience, with private games behind unguessable names. A
   list (only these actors) can come later as a field on the first send.
4. **Presence in the kit or on the server.** My lean: the kit
   (heartbeat states), so strut has no presence code.
5. **States keyed per sender or per channel.** My lean: per sender, so a
   page never overwrites another person's state; shared state that must
   be right goes through a workflow.
6. **May a workflow send.** My lean: yes, only with `ctx.app` set, so a
   referee or an AI player works.
7. **The word.** "Channel", because "room" already means one person's
   callback socket (`src/rooms.ts`).

## Not in v1

- Surviving a restart, or more than one strut process. Like rooms and the
  live feeds, a channel is a notification, not a record.
- Binary messages (JSON only; base64 if a page must).
- End-to-end encryption.
- A channel shared by two apps, or one reached by anything that is not an
  app's page or run.
- The socket transport (§6).
