# App channels: live messages between the people on an app

> **Status (2026-11-04): ruled; work items 1–7 and 9 built
> (stakwork/strut#487: the service, the ticket, the socket at `GET /channels`,
> the peer relay, the steps, strut's UI as a host, the kit's `useChannel`,
> `app/look`, the `App` page). The monitor (item 8) waits until an app
> misbehaves: the limits already hold without it.** Written after the question
> "could someone build a multiplayer game as a strut app?" A game has few
> workflows (a scoreboard, a referee) and needs fast messages between the
> people playing it, which strut does not have. The owner ruled every
> question in one conversation the same day (the table below); the first
> draft, a long-poll over `step_run`, is under "Rejected". Companion to
> `apps.md` (the app door, its grants, the kit and the hosts) and
> `live-feeds.md` (the `LiveFeed` this keeps its messages in). Not the
> same thing as `chained-orchestrators.md` §3's ROOMS: a room is one
> person's socket for their own callbacks. A channel is shared by
> everyone on an app.

## Rulings

| # | Question | Ruled |
| --- | --- | --- |
| 1 | Long-poll through `step_run`, or a socket | **A socket held by each host**, relayed to the page over the MCP Apps bridge |
| 2 | Where Hive's socket ends (Hive runs on Vercel, which cannot hold one) | **At the swarm's strut**: Hive's page connects straight to it with a short-lived **ticket strut mints** |
| 3 | A host that holds no socket | **No channels there.** The kit reports `unavailable`; no long-poll fallback |
| 4 | A peer's app (`?app=@<peer>/<name>`, Peel's org apps) | **Relayed through the local strut**, which reaches the peer with the peer record's person token |
| 5 | Channels by app name or by version | **By name**, shared by every version. Previews keep their own (mine, not objected to) |
| 6 | Who may join | **Anyone in the app's audience who has the name.** An app builds its own authorized rooms with a gatekeeper step (§6) |
| 6b | Should strut derive room names for that gatekeeper | **Yes**: `channel/derive { scope }` |
| 7 | Presence | **On the server, from the sockets** |
| 8 | Whose state a keyed message replaces | **Only the sender's own** |
| 9 | May an app's steps and workflows send | **Yes, as themselves** (the step type or workflow name is the sender) |
| 10 | The word | **Channel** ("room" is taken twice in the same layer: callback rooms and LiveKit call rooms) |

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
| The app monitor: `repeat` warns at 120 identical calls a minute, `volume` at 600 a minute per app version | a door that is meant to be busy |

So a turn-based game works today, slowly, with every move a graph node
forever. Anything live (cursors, positions, a lobby that fills as people
arrive) does not: polling for it trips the monitor in seconds.

## Design in one paragraph

A **channel** is a short in-memory log of JSON messages, named by an app
and shared by every viewer of that app. The page still connects nowhere:
its HOST holds one WebSocket to strut while the page is open, and relays
between the socket and the page over the MCP Apps bridge. A browser host
opens the socket with a short-lived ticket strut minted for that viewer and
that app. Strut stamps every message with its sender (the socket's actor
and a client id strut assigns, or the step or workflow that sent it),
knows who is present from the sockets that are open, and keeps nothing:
no run, no log line, no graph node, and a restart empties every channel.
An app's own steps and workflows reach the same channels in process,
which is how a referee no player controls, or an AI player, takes part.
What must last (scores, results) still goes through a workflow or the
graph. The channel carries what is happening now.

## 1. A channel

**Where it lives.** One `LiveFeed` (`src/live-feed.ts`, which gained
`evictable`, `remove` and a synchronous `readNow` for it) per
channel, in this process, plus the sockets joined to it. A channel is
named by `(app name, channel name)`: every version of the app shares it,
as it shares `app/state` and the app's jobs, so a publish mid-game never
splits the players. A **preview** (`app/look { path }`, version
`preview-<hex>`) gets channels of its own, keyed by its label, so the
builder's test never joins a live game. An app that changes its message
format puts a format number in its messages.

**A message** as a page or a step gets it:

```ts
interface ChannelMessage {
  /** The sender, stamped by strut: never what the page wrote. */
  from: {
    actor?: string;    // vouched by the socket's ticket, or the run's actor
    client?: string;   // a page: the id strut gave its socket
    code?: string;     // a step or workflow: its type or name (§5)
  };
  key?: string;        // a STATE: replaces this sender's last message with the same key
  data: unknown;       // the sender's JSON, at most CHANNEL_MESSAGE_MAX_BYTES
  at: number;          // when strut took it (ms)
}
```

**States and events.** A message with a `key` is a state. The newest one
replaces the last one from the SAME SENDER with the same key: a player's
position, their cursor, "ready", a referee's board. The feed's `keyOf` is
the sender (actor + client, or actor + code) plus the key, so nobody can
replace anyone else's state. A message with no key is an event (a chat
line, a move), which no later message replaces. This is `LiveFeed`'s own
model ("the newest state of each thing"), so a page that joins late, or
reconnects after the feed dropped what it missed, gets every sender's
current state and the most recent events at once.

**Order.** One order per channel, `LiveFeed`'s `seq`. A socket sees every
message in that order. A reconnect hands back its cursor and gets what it
missed, or `reset: true` and the snapshot.

**Presence** comes from the sockets. A socket that joins makes its sender
present; strut sends `joined` to the channel and a newcomer gets the
members first. A socket that closes makes it leave: `left`, and strut drops
that sender's states, so a departed player's cursor does not linger. A
channel socket is pinged every 10 s (rooms ping every 30 s), so a dead
connection leaves within about 10 s. A reconnect within
`CHANNEL_REJOIN_MS` keeps the same client id and is no leave. "Present"
means "has the app open": the host holds the socket while the page is
mounted, even in a hidden tab, and a game that cares whether someone is
looking sends its own `away` state. A step or workflow that sends is not a
member, and its states stay until replaced, evicted or the channel goes
idle.

**Limits** (constants, `src/channels.ts`):

| | Value | Why |
| --- | --- | --- |
| `CHANNEL_MESSAGE_MAX_BYTES` | 8 KB of JSON | a move, not a file; files go in a job (`job/upload`) |
| `CHANNEL_KEEP` | 256 messages | the feed's `max`: states plus recent events; when it is full, events go first |
| `CHANNEL_STATES_PER_SENDER` | 16 keys | so one sender's states never crowd out the rest |
| `CHANNEL_KEY_MAX` | 64 characters | a key names a state, it does not carry one |
| `CHANNEL_SEND_RATE` | 30 messages a second per sender, bursts of 60 | a token bucket per sender |
| `CHANNEL_REJOIN_MS` | 10 s | a reconnect inside it is no leave |
| `CHANNEL_IDLE_MS` | 10 minutes | a channel with no socket and no message is dropped |
| `CHANNELS_PER_APP` | 1 000 | past it a new channel is refused, naming the cap |
| `CHANNELS_PER_SOCKET` | 8 | one page, a few channels (a lobby and a game) |

## 2. The socket

**One per open page.** The host opens it on the page's first join and
closes it when the frame goes away. It carries every channel the page has
joined.

**`GET /channels`** (WebSocket; top-level like `/rooms`, since
`/apps/channels` would shadow an app named `channels`), upgraded through
the app's own gate and hooks like `/rooms` (`strut.upgrade(req, socket,
head, { basePath })`, so a standalone strut and a host that owns the
server, mcp under `/lab`, decide it the same way). It takes one of two
credentials:

- **A ticket** as `?ticket=`, from a browser host, since a browser cannot
  set headers on an upgrade. The request log prints `ticket=…`, as it
  prints `key=…` for the dictation socket.
- **A header credential** (the key, a person token), from a server: the
  peer relay of §4. It names the app as `?app=<name>@<version>`.

**The ticket.** `POST /apps/:name/channel-ticket { version }` → `{ ticket,
exp }`. It is `strut-channel.<claims>.<hmac>`, signed like a file token
(`STRUT_API_KEY`, else `STRUT_SECRET_KEY`), with claims `{ actor?, app,
version, exp }`. It lives a minute, which is long enough to connect, and
the socket outlives it. The key or a session mints one, for the actor
`resolveActor` gives (none: a viewer stamped by its client id alone).
No peer credential may: a person token connects with its own header
instead (§4). The route refuses an app or version that
is not there. The host names the app it is showing, and the socket is
bound to that app, so a page can never reach another app's channels.

**Frames** are JSON, one per message. Client → strut: `{ op: "join",
channel, since? }`, `{ op: "leave", channel }`, `{ op: "send", channel,
messages: [{ key?, data }] }`. Strut → client: `{ op: "joined", channel,
client, cursor, members, messages, reset? }`, `{ op: "message", channel,
cursor, message }`, `{ op: "presence", channel, joined | left }`, `{ op:
"error", channel?, error }`. A refusal (size, rate, count, a bad name)
is an `error` frame naming the limit; the socket stays open.

## 3. The hosts

Every host that wants channels does the same three things:

1. **Gets a ticket** from strut for the viewer and the app it is showing.
2. **Opens the socket** on the page's first join, and reconnects with
   backoff, rejoining each channel with its last cursor.
3. **Relays over the bridge.** The page sends `strut/channels/join`,
   `strut/channels/leave` and `strut/channels/send` as requests on the
   bridge; the host sends strut's frames to the page, as they came, as
   `strut/channels/frame` notifications. ext-apps 2.0's `App` and
   `AppBridge` each take their own request and notification handlers, so
   no fork of the bridge is needed. The host says it carries channels in
   its answer to `ui/initialize` (wherever ext-apps lets a host add a
   capability of its own; item 5 checks the exact field).

A host that does not (Claude Desktop, Goose, any other MCP Apps host)
gives a page no channels, and `useChannel` reports `unavailable` at once.

- **Strut's UI** (`web/src/app-host.ts`, `AppHost.tsx`, `SoloApp.tsx`):
  mints its own ticket from its own origin with its session or key, opens
  `/channels` there. Peel shows apps through this UI, so Peel needs
  nothing of its own.
- **Hive**: a Vercel route cannot hold a socket, so Hive's SERVER only
  mints the ticket (`POST <swarm>/lab/apps/:name/channel-ticket`, with the
  swarm key and `x-strut-actor`, the credential its relay already sends;
  the place to put a role floor if Hive wants one), and Hive's PAGE opens
  `wss://<swarm>/lab/channels?ticket=…` itself. The channel lives on
  the swarm's strut, so a Hive viewer and a strut-UI viewer of the same
  app meet there.
- **mcp (stakgraph)**: routes the `/lab/channels` upgrade to
  `strut.upgrade` as it routes `/lab/rooms` (stakgraph#1811), and lets a
  `?ticket=` through `labAuth` for strut to judge, as it lets a file
  token's `?t=` through.

## 4. A peer's app

Strut's UI shows an app that lives on another strut as
`?app=@<peer>/<name>`; that is how Peel shows an org's apps. Its channel
lives on the peer, where the app lives, and the socket gets there through
the LOCAL strut:

- The UI mints a ticket from its own strut for `@<peer>/<name>` (`POST
  /apps/<name>/channel-ticket { version, peer }`) and opens its own
  `/channels`, as for any app.
- The local strut sees a peer's app and opens a socket to the peer's
  `/channels?app=<name>@<version>` with the peer record's token in
  `Authorization` (a person token, so the peer stamps the person), trusting
  the record's `ca` and `servername` like every other peer request. It
  pipes frames both ways.
- The web view only ever talks to its own strut, and the person token and
  the peer's URL never reach the page. The extra hop is web view →
  localhost, so it adds next to nothing.

One hop, as the app read-through is today (`GET /peers/:id/apps`).

## 5. Steps and workflows

Code the app runs (anything with `ctx.app` set: a custom step a page calls
through `step_run`, a workflow the app launched with `run/launch`) reaches
the same channels in process, through `ctx.services.channels`:

- **`channel/send { channel, data, key? }`** (one message: a workflow sends one at a time), stamped
  with the code as the sender: the workflow's name, or the type of the
  step the page called, plus the actor who set it off. So `game/move`'s
  `board` state replaces the last `board` from `game/move`, whichever
  player triggered it, and no page can overwrite it.
- **`channel/read { channel, since?, wait? }`**, `LiveFeed`'s waiting read
  (up to `FEED_MAX_WAIT_MS`), for an agent that plays: grant it
  `channel/*` and it reads the room and sends like anyone else.
- **`channel/derive { scope }`** → `{ channel }`: a room name only the
  app's code can work out (§6).

All three refuse to run without `ctx.app`, and a page calling them
directly through `step_run` is refused (`NOT_A_PAGES` in
`src/apps/tools.ts`): a page uses its host's socket, and a page that could
call `channel/derive` could derive any room. A workflow's `channel/*`
steps are in its run log like every step it runs; a custom step a page
called keeps no log, as today.

## 6. Who may join, and authorized rooms

**The audience is the gate.** Only someone who may open the app gets a
ticket: a key or session holder on strut, a workspace member with read
access in Hive, a person token's person on a peer. Inside that audience,
anyone with a channel's name may join it.

- **A public room** is a fixed name (`lobby`).
- **A private game** is a name the kit mints (`newChannel()`, 128 random
  bits): it cannot be guessed, so it is as strong as a bearer token, and
  `appLink(app, { channel })` is the invite. Like a bearer token, it is
  only as secret as where the link travels (chat, history, the host's
  request logs; on the socket the name travels inside frames, not the
  URL), and it cannot be revoked.

**An app's own authorized rooms** need no more from strut than this:

1. **A gatekeeper step**, a custom step the app grants, say
   `game/join { game }`. It runs as the viewer, so `ctx.actor` is who is
   asking, vouched by the connection. It applies the app's rules (a roster
   in the graph, the host's say-so) and returns the room name, or refuses.
   A step, not a workflow: Hive's relay asks the Developer role for
   `run/launch`, while a step passes on read access.
2. **The name is derived, never stored**: `channel/derive { scope:
   "<game>:<epoch>" }`. Strut computes `HMAC(app key, scope)`, the app key
   being `HMAC(strut's secret, "channel:" + app name)` (the file token's
   secret; a fixed dev key, with strut's existing warning, when there is
   none). Nothing is in the graph for a page to read (a page with graph
   reads granted can read any node by `ref_id`), and the app needs no
   secret of its own, which a builder could not set. To kick someone, the
   step moves the epoch and hands the new name only to those still on the
   roster.
3. **Pages ignore anyone not on the roster.** Every message carries
   strut's stamp of its sender, which a page cannot forge, so a page drops
   what an actor off the roster sends.

The kit's README and the `App` page carry this pattern.

## 7. The kit: `useChannel`

```ts
const { available, ready, members, states, events, send, error } = useChannel(name, {
  onMessage?: (m: ChannelMessage & { mine: boolean }) => void,   // a game loop: no React state per message
});
send(data);                       // an event
send({ x, y }, { key: "pos" });   // a state
```

`available` is false in a host that carries no channels. The hook joins
on mount and leaves on unmount, through the bridge methods of §3; `states`
is the newest state per sender and key, `events` the recent events,
`members` who is present. Plus `newChannel()` and `appLink`.

## 8. What it is good for

**Delay.** A message goes page → host → strut → the other host → the
other page, about one round trip to strut. Hive's page talks to the swarm
directly, so Hive adds no hop of its own.

**Good for:** turn-based games, cards, quizzes with a live lobby, drawing
together, cursors and "who is here", chat in an app, a referee, an AI
player. A fast action game works as well as a WebSocket game on one
server does; what strut does not offer is anything closer to the players
than that server.

## 9. Security

- The page still opens no `fetch`, XHR or WebSocket: the CSP and the frame
  are unchanged. The host holds the socket. WebRTC is the exception (the
  last bullet).
- A socket is bound to the app its ticket or `?app=` names; a step to its
  `ctx.app`. Nothing reaches another app's channels.
- The sender is strut's stamp: the socket's actor from its ticket or
  credential, a client id strut assigned, or the code that sent it.
- The audience gates the ticket; a name gates the room; an app's
  gatekeeper (§6) gates its own.
- Nothing is recorded for socket traffic: no run, no log, no store.
  Messages live in memory until replaced, dropped from the 256, or the
  channel goes idle.
- **Not end to end.** Strut reads the messages, the same trust the app's
  other calls get.
- **WebRTC (item 0: open, nothing blocks it).** Browsers do not apply
  `connect-src` to WebRTC, and none of those tested honors `webrtc
  'block'`. Two pages can swap connection details through a channel (or,
  more slowly, through graph writes) and talk directly, past strut, each
  learning the other's public IP address. One page alone can send to any
  STUN or TURN host it names. The CSP holds an honest app to the bridge;
  it does not hold in a hostile one.

## 10. Work items

0. **Probe WebRTC in the app frame. Done 2026-11-04: every browser lets
   the frame connect, and none honors `webrtc 'block'`, so `cspFor` is
   unchanged.** The probe: two frames framed as AppHost frames an app
   (`srcdoc` of `<iframe sandbox="allow-scripts allow-downloads"
   allow="microphone">`, `cspFor()`'s policy in a `<meta>`). Each makes an
   `RTCPeerConnection` with a public STUN server. The parent relays the
   offer and the answer, as a channel would, and a data channel carries a
   message each way. It ran three ways: no CSP, the app's CSP, and the
   app's CSP plus `webrtc 'block'`. It also ran with `webrtc 'block'` in
   the parent page's own `<meta>` and in its HTTP header, which a `srcdoc`
   frame inherits, and on two connections in the parent page itself.

   | Browser | In the app frame | `webrtc 'block'` |
   | --- | --- | --- |
   | Chrome 157 (macOS) | candidates gathered, data channel open | no effect: frame meta, page meta, page header |
   | Chromium 152 (the desktop app's browser pane) | same | no effect: frame meta, page header |
   | Chromium 153 (Playwright, Linux) | same | no effect: all three |
   | Firefox 157 (macOS) | same | no effect: frame meta |
   | Firefox 155 (Playwright, Linux) | same | no effect: all three |
   | Safari 26.6 (macOS) | same | no effect: frame meta, page header |
   | WKWebView, macOS 26 (default configuration) | same | no effect: all three |
   | Mobile Safari, iOS 26.5 simulator | same | no effect: frame meta |
   | WKWebView, iOS 26.5 simulator (what Peel hosts) | same | no effect: frame meta, page header |
   | WebKitGTK (Playwright, Linux, in Docker) | candidates gathered; no connection, even with no CSP (the container's network) | no effect on gathering: all three |

   No `securitypolicyviolation` fired anywhere. In every engine the frame
   got a server-reflexive candidate from the STUN server, so UDP reached a
   host the page chose. That candidate carries the viewer's public IP. Host
   candidates were mDNS names (`<uuid>.local`) everywhere, so LAN addresses
   stayed hidden. Not tested: a real iPhone, Android, Edge, Hive's frame
   (its own document carries the same `<meta>`), and a frame the viewer
   granted the microphone (`allow="microphone"`), where browsers expose raw
   host addresses.

   **What stays open, in all of them:** a hostile app can send data to any
   STUN or TURN host it names, with no other page involved, and two pages
   that swap SDP through a channel or the graph can open a direct
   connection. The limits that hold are the ones that bound an app
   already: grants checked on every call, who may publish an app, and a
   package's app being code a person chose to install. Later: add `webrtc
   'block'` once an engine ships it (run this probe again then); a build
   warning on `RTCPeerConnection` like the one on `fetch` would catch an
   honest app, never a hostile one. Item 9 says on the `App` page that a
   direct connection is not the door.
1. **BUILT (#487). `src/channels.ts`**: the service (a `LiveFeed` and the sockets per
   channel, previews apart, the stamp, presence and its pings, the
   limits, idle drops). Unit tests: states replace per sender only, a
   leave drops the leaver's states, a rejoin inside the window keeps the
   client, a reconnect with a cursor gets what it missed, `reset` past the
   keep, the refusals, one app never reaching another's channel.
2. **BUILT (#487). The ticket and the socket door**: `POST /apps/:name/channel-ticket`
   (auth.ts beside the file and person tokens), `GET /channels`
   through `strut.upgrade`, the frames. Tests over a real socket, as the
   rooms tests do, and the route sweeps.
3. **BUILT (#487). The peer relay** (§4) in the same door, with a test against a second
   strut.
4. **BUILT (#487). The steps** `channel/send`, `channel/read`, `channel/derive`
   (`src/steps/lib/channel/`), refused without `ctx.app` and in
   `NOT_A_PAGES`. Add the test files to the `npm test` list.
5. **BUILT (#487). Strut's UI as a channel host** (`web/src/app-host.ts`): the
   capability in `ui/initialize`, the ticket, the socket, the relay; the
   pure parts in `app-links.ts` with their tests.
6. **BUILT (#487). The kit**: `useChannel`, `newChannel`, the bridge methods; hook tests;
   the README with §6's pattern.
7. **BUILT (#487). `app/look`**: answer the channel socket in process with Playwright's
   `page.routeWebSocket`, as `page.route` answers the rest, so the builder
   can test a multiplayer app.
8. **The monitor**: channel traffic per app in Usage (messages, bytes,
   peak members per minute), and a warning when a sender keeps hitting
   the rate limit, with the fix: send fewer messages, or make them states.
9. **BUILT (#487). The `App` Concept page**: when a channel is the tool (live, lossy,
   unrecorded) and when a workflow or the graph is; grant `channel/*` to
   the app's steps; the referee and the gatekeeper patterns; a direct
   WebRTC connection between pages is not the door (item 0).
10. **Docs**: `specs/API.md` (the ticket route, the socket and its frames,
    and the bridge methods in the host contract, §14.3), `AGENTS.md`.
11. **Validation** (§11).

**Outside strut**: Hive (§3: the ticket on its server, the socket and the
relay on its page) and mcp (the upgrade route and the ticket through
`labAuth`). Until they land, Hive's apps report channels unavailable and
nothing else changes. Peel needs nothing.

## 11. Validation

- A fixture app beside `__fixtures__/hello`: two-player tic-tac-toe.
  A `game/move` step checks each move and sends the board as its state; a
  cursor is each player's own state; a `scoreboard` workflow records the
  winner in the graph and announces it.
- Two frames of it in the browser pane as two viewers: a move shows in the
  other frame, a cursor follows, closing one frame sends `left` at once
  and killing its connection within about 10 s.
- The same through a peer: one viewer on the app's strut, one on a second
  strut showing `@<peer>/<name>`.
- Send → receive delay at the median and p95, on strut's UI and on a
  swarm through Hive.
- Ten messages a second from each of four viewers for ten minutes: memory
  flat once the channels go idle, the traffic in Usage, no warning.

## Rejected

- **A long-poll over `step_run`** (the first draft): `channel/send` and
  `channel/read` as a page's steps, the read held on the server like
  `job/updates` and answered at once, a fast path in the door around
  `runStep`, the monitor's rules relaxed for it. No host would have
  changed. Rejected for the socket (ruling 1): one round trip per message
  instead of two, presence for free, and no busy door.
- **Hive's Pusher** for Hive's socket: the channel would live in a third
  party, only Hive viewers would meet, and strut could not stamp senders
  or let a referee post.
- **A long-poll fallback** for hosts without a socket: a second transport
  to keep in step.
- **Straight from the web view to a peer**: fails for a peer with its own
  CA, and puts the peer's URL in the page.
- **Channels per version**: every publish would split a game.
- **A member list per channel**: an app builds one with a gatekeeper and
  `channel/derive`.
- **Presence from heartbeats in the kit**, with page-chosen client ids:
  slow to notice a leave, traffic all day, and forgeable.
- **States keyed per channel**: one silent loser in every race, and any
  member could wipe shared state.

## Not in v1

- Surviving a restart, or more than one strut process. Like rooms and the
  live feeds, a channel is a notification, not a record.
- Binary messages (JSON only; base64 if a page must).
- End-to-end encryption.
- A step or workflow as a member (an AI player is not listed in
  `members`; a game lists it itself).
- More than one peer hop for a channel.
