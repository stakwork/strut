# Member rights: admins run the box, members use apps

> **Status (2026-11-05): proposed, simplified after review. Nothing is
> built.** Written after a read of strut `main` @7eb40d3 (#530: sign-in
> tickets) and stadeum `main` @838a979.

## Problem

Stadeum signs each person into strut's framed UI with a ticket. Its server
mints one with the key (`POST /auth/ticket { actor }`,
`createStrut.ts:1718`), and strut's page trades `?ticket=` for its session
cookie (`:1673`). That session is the key's equal: `carriesApiKey` counts
any session (`auth.ts:70`).

So a member who opened Jamie in a frame can then open `strut.$HOST/` and get
the operator console with full power: secret names, publishing and deleting
workflows, packages, `/drain`, minting tickets, and every run and file.
Stadeum's admin/member split (`ui/src/lib/roles.ts`) stops at stadeum's own
pages.

## The idea

**Admins run the box; members use apps.** Strut learns one thing about a
person: admin or not.

- An **admin** gets today's session, the console included.
- A **member** gets apps. A member can do in strut exactly what their apps let them do, as themselves, and nothing else.

Jamie is an app, so a member still changes apps by asking Jamie, which
starts a builder job as them.

## What a member's session opens

These are the calls strut's page makes when it shows an app alone
(`?app=<name>&solo=1`), paths under `web/src/`:

| Route | Used for |
|---|---|
| `GET /apps`, `GET /apps/:name/versions` | finding the app (`use-listed-app.ts:26`), the side panel's version list (`components/AppWithPanel.tsx:177`) |
| `GET /apps/:name/:version/files[/…]` | the app's document; the listing mints its identity (`components/AppHost.tsx:59`) |
| `POST /mcp` | the page's calls. A member gets `step_run` alone, as a person token does (`personAppHandler`, `createStrut.ts:7470`) |
| `POST /apps/:name/channel-ticket` | the app's channels (`app-host.ts:140`) |
| `GET /artifacts/:runId[/…]`, `GET /jobs/:id/files[/…]` | a file an app hands the side panel (`use-artifact-url.ts:16`) |

The UI files, `GET /health` (`{ ok: true }` alone), `/auth/session` and
the routes that open with a token (`?t=`, a channel ticket) stay open as
they are now.

**Every other route answers 403, reads included.** That includes the
workflows, steps, secrets, packages, peers, the public view, automations,
`/drain` and the credential mints, as well as any route a host mounts later.

## Adding a secret

A member may **add** a secret, but never list, read, change or delete one.

- **The rule: fill a blank, never overwrite.** The value is refused when the name already has one, in the secret store or in the environment. A store value shadows the env (`src/capabilities.ts:85-90`), so this stops a member from replacing the team's model or GitHub key with their own.
- **Where they type it: Jamie.** Today the builder job can only say "add NAME under Secrets" (`src/ai/prompts.ts:384`), which sends a person to the console. Instead, the builder's reply names the secret it needs (`ask.secret: "NAME"` beside `ask.message`, `src/workflows/builder.yaml`). Jamie shows a password box under the question.
- **How it is stored.** Saving runs `secret/add { name, value }` through `step_run`. The step:
  - runs only as strut's own app's call, never as an agent's tool;
  - writes the deployment store;
  - returns the name alone.

  Jamie then sends the job its next turn, `[secret] NAME stored`, the way a captcha answer goes. The value never reaches a model, a run log or a transcript.

The same box serves admins too, so nobody needs the console for this.

## The contract

- **The ticket.** `POST /auth/ticket { actor, role?: "admin" | "member" }`, using stadeum's own words. With no role, the person is a member. Stadeum is the only caller, so its one-line change lands the same day.
- **The session.** The cookie gains `role`. The key login (`POST /auth/session { key }`) has none and stays full. `GET /auth/session` answers `{ actor?, exp, role? }`.
- **The gate.** A member session passes only the routes above. `carriesApiKey` stops counting it as the key, which also covers the per-route checks and the dictation socket (`src/audio/ws.ts:57`).
- **Strut's UI.** A member who opens strut directly gets a list of their apps (links to `?app=<name>&solo=1`, Jamie first), not the console. `?app=…&solo=1` and `?artifact=…&solo=1` work as now.

## What this is not

It is not a sandbox. The builder runs code on the box (`src/workflows/builder.yaml:24-37`), so a member who builds is trusted like a colleague with commit access. Stadeum keeps the org key and the Docker socket out of strut's container (its AGENTS.md rule 4), so the worst a member can do stops at strut, not the box. The member session keeps the console and its power tools out of a member's browser.

## Tests

- **The member sweep**, beside "the API key gate" in `createStrut.test.ts:1352`. Mint a ticket with no role, trade it, and request every route with the cookie and `x-strut-ui: 1`. The routes above answer neither 401 nor 403. Every other route answers 403, reads included, and so do a `GET` and a `POST` a host mounted. The number of allowed routes is asserted.
- **Roles and edges.**
  - A `role: "admin"` session reaches everything the key does.
  - A bad role is a 400.
  - `/mcp` gives a member `step_run` alone.
  - `POST /auth/ticket` is 403 to a member.
- **The secret.**
  - `secret/add` stores a new name and answers with the name.
  - It refuses a name already set in the store or the environment.
  - It refuses a call that is not strut's own app's.
  - The value is in no run, event or response.
- **The UI.** A pure function picks the page (shell, app alone, or a member's app list) from the session and the query.

## Work items (one PR each)

1. **Strut: the member session.** The ticket's role, the session's, the gate, `/mcp`, the member's app list in the UI, and the sweep. Also `specs/API.md` §13.1 and AGENTS.md "Auth".
2. **Strut: a secret from Jamie.** `secret/add`, the builder's `ask.secret`, and Jamie's password box.
3. **Stadeum: pass the role.** `embedUrl` sends `{ actor, role }` (`ui/src/lib/strut/client.ts:296`, called from `app/(app)/apps/app-frame.tsx:18` with `user.role`), along with its fake stack and test. Same day as item 1.

## Left out on purpose

- **Hiding members' runs from each other.** Members can build, so it would not be a real wall.
- **Holding apps for an admin's yes.** A change goes live as today, and an admin can make an older version live from Organisation → Apps.
- **Admin-only apps.** Admin tasks belong on stadeum's admin pages.
- **Blocking strut's own keys by name.** A custom step reads them from memory anyway.
- **Peel and Hive's person tokens.** A separate system.
- **A shorter session.** A box that wants one sets `STRUT_SESSION_HOURS`.
