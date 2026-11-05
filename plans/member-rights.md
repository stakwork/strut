# Member rights: what a person a host signs in may do

> **Status (2026-11-05): proposed, not ruled. Nothing is built.** Written
> after a read of strut `main` @7eb40d3 (#530: sign-in tickets) and
> stadeum `main` @838a979. Companion to `chained-orchestrators.md` §2 (the
> person token), `jamie-app.md` §3 (a first-party page acts as its viewer)
> and `proposal-links.md` (a person token reads by id).

## Problem

Stadeum signs each person into strut's framed UI with a ticket. Its server
mints one with the key (`POST /auth/ticket { actor }`,
`createStrut.ts:1718`), and strut's page trades `?ticket=` for its session
cookie (`:1673`). That session is `full`, the key's equal: `carriesApiKey`
counts any session (`auth.ts:70`), and so does `scopeFromKey` (`:169`).

The cookie belongs to strut's origin. A person who opened Jamie in a frame
can then open `strut.$HOST/` and get the operator console with full power:

- secret names;
- publishing, editing and deleting workflows and steps;
- packages, peers, the public view, automations and `/drain`;
- minting tickets and person tokens for anyone;
- every run, job, transcript and file.

The same session gets the assistant tool set on `POST /mcp`
(`createStrut.ts:7523`), which talks to the builder chat and runs any
workflow. Stadeum's admin/member split (`ui/src/lib/roles.ts`,
`requireAdmin` in `ui/src/lib/session.ts:23`) stops at stadeum's own pages.

## 1. What a member uses

A member uses the org's apps, Jamie first. Each is framed as
`?app=<name>&solo=1` (stadeum `ui/src/lib/strut/client.ts:295`). A member
changes an app by asking Jamie. Jamie's orchestrator turn then starts a
`builder` job as that member.

The solo page makes these calls (paths under `web/src/`):

| Call | Where | What for |
|---|---|---|
| `POST /auth/session { ticket }` | `api.ts:327` | the sign-in, before any other request (`main.tsx:28`) |
| `GET /apps` | `use-listed-app.ts:26` | find the app and its live version |
| `GET /apps/:name/:version/files`, then `…/dist/index.html` and `…/dist/build.json` by `?t=` | `components/AppHost.tsx:59,83,90` | the listing mints the app's token, which the document carries as its identity |
| `POST /mcp` (`step_run`) | `app-host.ts:84` | every call the page makes |
| `POST /apps/:name/channel-ticket`, then `GET /channels?ticket=` | `app-host.ts:140` | the app's channels |
| `GET /artifacts/:runId`, `GET /jobs/:id/files`, then files by `?t=` | `use-artifact-url.ts:16` | a deliverable Jamie hands the side panel as `?artifact=<path>` (`src/apps/jamie/src/lib/artifacts.ts:76`) |
| `GET /apps/:name/versions` | `components/AppWithPanel.tsx:177` | the side panel's version list (viewing only) |

It makes no other calls. Jamie reaches everything else as STEPS through
`step_run`, under its grants (`src/apps/jamie/app.yaml:11`):

- `run/*` on `orchestrator`, `job` and `builder`;
- `conversation/*`, `job/get`, `job/updates`, `job/verify` and `job/evidence`;
- `proposal/get` and `proposal/decide`;
- `llm/models`, `graph/find`, `sheets/get-values`, `github/pr-status` and `github/merge-pr`.

The app door judges each call by the viewer's actor and the app's grants,
never by the HTTP scope (`buildAppTools`, `src/apps/tools.ts`).

**A member's rights are the union of their apps' grants, run as them.** The
page holds the app's identity, so the person can make any call the page can.
The HTTP scope only has to keep everything else closed.

## 2. What exists

| Piece | What it gives | As a member's scope |
|---|---|---|
| `peer:person`: a person token (`auth.ts:159`, `:599`) | `step_run` alone on `/mcp` (`personAppHandler`, `createStrut.ts:7470`), its own sessions, `peer: person` workflows, its own proposals and conversations | Closest, but it **reads every GET route**. The gate checks only writes (`createStrut.ts:1656-1662`), and `requireApiKey` lets it read (`auth.ts:117`). So it sees `/secrets` names, `/workflows/*/runs`, `/jobs`, `/sessions`, and every transcript and file. It is also a PEER: an HTTP launch is stamped `origin: "peer"` and its job is kept as `peer/<job>` (`peerLaunchBody`, `createStrut.ts:5686`). And it is a Bearer token, not a cookie |
| A first-party page (`firstPartyApp`, `src/apps/tools.ts:318`) | Jamie acts as its viewer: their conversations, and their runs of the sealed `orchestrator` whoever launched them (`openFlow`, `ownRun`: `createStrut.ts:5758`, `:5778`) | Right inside the app, but for SEALED workflows only (§4) |
| The conversations index | lists and reads per viewer (`conversationViewer`, `createStrut.ts:6100`) | Right as it is |

**Should a member be `peer:person`?** No. A member is a local person, not a
strut, and shares the org with others. Reading every GET route would show
them other people's runs, jobs, transcripts and files.

The 2026-11-01 ruling (`proposal-links.md`, "Decided") let a person token
read any run by id, on two grounds: the lists stay each person's own, and
the ids cannot be guessed. Neither holds for the GET routes:

- `GET /workflows/:name/runs` and `GET /jobs` LIST everyone's work;
- a run id is a millisecond timestamp.

So a member gets a scope of its own, `member`, beside the others. Its reads
are refused like its writes, except for the routes it is given.

## 3. What a member gets and is refused

| Route family | Member | Why |
|---|---|---|
| UI files, `GET /health`, `/auth/session` | open, as now | `/health` answers `{ ok: true }` alone: `createStrut.ts:7556` stops counting a member session as the key |
| `GET /apps`, `GET /apps/:name/versions` | yes | the solo page and the side panel |
| `GET /apps/:name/:version/files[/…]` | yes | the listing is the app's identity |
| `POST /apps/:name/channel-ticket` (no `peer`), `GET /channels` | yes | channels; the ticket names the member |
| `POST /mcp` | `step_run` alone (`personAppHandler`) | never the assistant set |
| `GET /artifacts/:runId[/…]`, `GET /jobs/:id/files[/…]` | **their own only** (§4), 404 otherwise | the side panel |
| `/workflows*`, `/steps*`, `/claims`, `/checks`, `/automations`, `/runs/active` | 403, reads included | the console |
| `/secrets`, `/actors/*`, `/peers*`, `/self`, `/mcp-servers*`, `/llm/*` | 403 | the deployment's |
| `/packages*`, `/publisher*`, `/index*`, `/public-view*` | 403 | publishing and installing |
| `/drain`, `/home/*`, `/conversations/wake` | 403 | the operator's |
| `/auth/ticket`, `/peers/tokens`, `/publisher/tokens` | 403 | minting credentials |
| `/jobs` (list, detail, updates, verify, delete), `/sessions*`, `/chat*`, `/chats`, `/proposals*`, `/conversations*`, `/graph/*` | 403 | Jamie reaches its share as steps; a route is added when a page needs it |
| `/mcp/builder`, `/audio/*` and the dictation socket, `/rooms`, `/voice/calls` | 403 | no member page uses them |
| a route a host mounts later | 403 | default deny, like the gate today |

## 4. "Their own": one rule, two doors

One predicate, `mayRead(viewer, run | job)`, lifted from `ownRun`
(`createStrut.ts:5778`).

A **run** is the viewer's when any of these holds:

- it was launched for them (`actor` on its summary, its `run.start` or the live launch);
- it is a turn of a conversation they may read (`input.session`, with the record `shared` or listing them in `viewers`);
- such a turn started it (`run.start.startedBy.session`).

A **job** is the viewer's when its record lists them in `actors`
(`src/jobs.ts:66`), or a conversation they may read lists it in `jobs`
(`src/conversations.ts:172`).

**Door one: the member's file listings** (`/artifacts/:runId`,
`/jobs/:id/files`: `createStrut.ts:2890`, `:4075`). Today they check nothing
but the credential. The listing mints the `?t=` token, so a file read by
token stays as it is.

**Door two: the first-party page.** Today Jamie shows only the viewer's runs
of the sealed `orchestrator`. For an unsealed workflow `openFlow` returns
`scoped: false` (`createStrut.ts:5760`), and `job` and `builder` are
unsealed. So through Jamie's `step_run`:

- `run/list { workflow: "job" }` lists every person's job runs (`runsCap`, `:5819`);
- `run/events`, `run/transcript` and `run/files` read any of them;
- `job/get` and `job/updates` read any job by id (`src/steps/lib/job/get.ts:33`). A first-party page's configs are not put in an app namespace (`src/apps/tools.ts:355`);
- `job/verify` and `job/evidence` already check `actors` (`src/steps/lib/job/_shared.ts:148`).

A member can make these calls without Jamie's page:
`GET /apps/strut%2Fjamie/vN/files` mints the token that is Jamie's identity.
That is true today for every session, and for every Peel person token on an
org's strut.

The fix: for a first-party page, `openFlow` scopes every workflow to
`mayRead`, and `job/get` and `job/updates` refuse a job the viewer may not
read. Shared conversations keep working: a job that another person's turn
started is readable through the conversation.

Domain apps do not change. An app that lists a workflow's runs lists
everyone's, as its grants decided (Q3).

## 5. The contract

**The ticket.** `POST /auth/ticket { actor, role?: "admin" | "member" }`,
full scope as now. Strut signs `role` into the ticket's claims, `member`
when it is absent. Any other value is a 400.

**An absent role is `member`.** A ticket is a person signing in, and the
safe default is the narrow one. This breaks nothing in use:

- Stadeum is the only caller. #530 shipped today, and the "tickets" in hive and stakgraph are the gateway's own.
- Stadeum never links to strut's console. Its admins lose console access only until stadeum sends `role: "admin"`, and the two changes land the same day.

A ticket minted before the upgrade (no `role` claim) and traded after it
signs in a member.

**The session cookie.** `Session` (`auth.ts:392`) gains
`role?: "admin" | "member"`:

- a ticket session always carries one;
- the key login (`POST /auth/session { key }`) carries none and stays full;
- a ticket session minted before the upgrade has no `role` and stays full until it ends (`STRUT_SESSION_HOURS`, 12 h). No stadeum box serves members yet.

**`GET /auth/session`** answers `{ actor?, exp, role? }`. The UI keeps
`role` in its session marker (`web/src/api.ts:179`).

**The gate.**

- `Scope` (`auth.ts:159`) gains `"member"`, and `scopeFromKey` answers it for a member session. `isPeerScope` stays false for it.
- `carriesApiKey` stops counting a member session. It is the key's equal in `requireApiKey`, in `/health`'s details, and in the audio, automation, claims and Mothership routes.
- A new `memberOf(c)` admits a member session to the gate. Past the credential, a member request passes only the §3 allowlist (method and path, reads included); anything else is 403.
- The CSRF rules (`sessionOf`, `auth.ts:560`) are unchanged.
- A host's own `resolveScope` may return `"member"` for its own credential.
- `resolveActor` is the session's actor, as now. An `x-strut-actor` header beside it is ignored.
- The dictation socket's check (`apiKeyMatches` with the cookie, `src/audio/ws.ts:57`) refuses a member session.

**`POST /mcp`** routes a `member` to `personAppHandler`, as it routes
`peer:person` (`createStrut.ts:7523`).

**Strut's UI with no `app`.** A member may open `strut.$HOST/`, or follow a
link to `?wf=`, `?run=` or `?job=` (a page's link opens in a new tab). They
get a member home, not the shell:

- the apps `GET /apps` lists, as links to `?app=<name>&solo=1`, Jamie first;
- one line saying the console is for the org's admins.

The shell never mounts, so its reads (`/workflows`, `/steps`,
`/runs/active`) are never made. `?app=…&solo=1` and `?artifact=…&solo=1`
are unchanged.

## 6. Stadeum

The change is one line, `ui/src/lib/strut/client.ts:296`:
`embedUrl(actor, role, app, input)` sends `{ actor, role }`. Around it:

- `app/(app)/apps/app-frame.tsx:18` passes `user.role`;
- the fake stack (`ui/src/test/fake-stack.ts:240`) records the role, and `client.test.ts` asserts it;
- AGENTS.md's row for `ui/src/lib/strut/` and README's frame line say that a ticket names the person's role.

A demoted admin is a member at their next framed page: every page load
mints a ticket, and the trade replaces the cookie. A tab already open on
`strut.$HOST` keeps the old session until it ends (Q6). Nothing else
changes: stadeum's admin pages reach strut with the key, from its server.

## 7. Tests

- **The member sweep** (`createStrut.test.ts`, beside "the API key gate" at `:1352` and the peer sweep at `:1433`). Mint a ticket with no role, trade it, and request every route in `strut.app.routes` with the cookie and `x-strut-ui: 1`:
  - the §3 allowlist answers neither 401 nor 403;
  - every other route answers 403, reads included, and so do a `GET` and a `POST` a host mounted;
  - the number of allowed routes is asserted, so adding one is a decision.
- **Roles.** A `role: "admin"` session passes every route the API key sweep covers, as the key does. A bad `role` is a 400. A ticket with no role claim signs in a member. A key-login session is full.
- **The edges.** `GET /auth/session` names the role. `/health` gives a member `{ ok: true }` alone. `POST /auth/ticket` and `/peers/tokens` are 403 to a member. `/mcp`'s `tools/list` gives a member `step_run` alone. The dictation socket refuses a member's cookie.
- **Their own.** As member A, the file listings answer 200 with a token for A's run, for a turn of a conversation shared with A, and for a job such a turn started. B's run and B's job answer 404.
- **The first-party door.** As A, Jamie's `run/list { workflow: "job" }` lists A's runs and the shared conversation's, never B's. `run/get` of B's job run is null. `job/get` of B's job is refused.
- **The UI.** A pure function picks the page (shell, solo or member home) from the session and the query. It is tested in `web/src/`.

## 8. Work items (one PR each)

1. **`mayRead`, and the first-party door scoped by it** (§4). Strut only. It changes what Jamie shows a person on every strut, Peel's org pages included. It lands first, because the member scope relies on it.
2. **The member scope.** The ticket's `role` and the session's, `GET /auth/session`, `Scope`, the gate's allowlist, `carriesApiKey`, `/mcp`, the dictation socket, the file listings through `mayRead`, and the sweep. Also `specs/API.md` §13.1 and AGENTS.md "Auth".
3. **The member home** in strut's UI (§5).
4. **Stadeum** sends the role (§6), the same day as item 2.

## 9. What this does not close

**The builder.** Through Jamie a member starts `builder` jobs as
themselves, and the builder is code execution on strut. It can publish and
run a workflow with an `exec` step, or a custom step
(`src/workflows/builder.yaml:24-37`). Such a step can read `STRUT_API_KEY`
by name:

- the secrets capability falls back to the boot env for any name (`src/capabilities.ts:85-90`);
- an in-process step can read anything.

With the key, a member can mint `role: "admin"` tickets. Stadeum keeps the
org key and the Docker socket out of strut's container (its AGENTS.md
rule 4), so the damage stops at strut, not the box. The member scope closes
strut's console. Containing the builder is a separate decision (Q1).

Also left out: narrowing `peer:person`'s GET reads (Q4), and a per-role
audience for domain apps (Q3).

## 10. Open questions for Evan

1. **The builder for members.** Three options:
   - (a) accept it: members are trusted to author, as Hive org members are today through a peer `builder`;
   - (b) stadeum sets `builder.reach` (`src/reach.ts`) for everyone: no step code, and allowlists for tools and secrets;
   - (c) the role travels into runs, and a member's builder publishes wait for an admin's yes.

   Whichever you pick, strut's own keys (`STRUT_API_KEY`, `STRUT_SECRET_KEY`, `STRUT_PEER_KEY`) should never resolve through `secrets.get`. That is one small PR, recommended either way.
2. **Who makes a member's app change live?** An app that follows latest goes live, for everyone, at the builder's publish. Holding a release (`PUT /apps/:name/active`, stadeum's Organisation → Apps) turns a member's change into a draft that an admin makes live. Should stadeum hold every domain app by default?
3. **Admin-only apps.** Every app `GET /apps` lists is open to a member, grants and all. Does an app need an audience (`audience: admin` in `app.yaml`)? And should a domain app's `run/*` reads be the viewer's by default?
4. **`peer:person` reads.** It still reads every GET route. Narrow it to this allowlist plus what Peel's org pages read (the `/peers/:id/*` read-through), or leave it under the 2026-11-01 ruling?
5. **Role names.** `role: "admin" | "member"`, with strut mapping `admin` to `full`? Or a scope-shaped `{ scope: "member" }`?
6. **A ticket session's life.** Should the ticket name how long its session lasts, so a host can keep a member's session short and make a demotion take effect quickly?
