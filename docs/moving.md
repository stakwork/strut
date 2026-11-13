# Moving strut between hosts, and home sync

Moving a data folder, `strut move`, and keeping a read copy of a home box's memory.

This file is the reference for one area of strut; [AGENTS.md](../AGENTS.md) is the
index. A change in this area updates this file, not AGENTS.md.

## Moving a data folder

A stopped strut's data folder can be copied to another host (Peel moving
the brain to a home server and back; peel `docs/always-on.md`). The new
host must get the same `STRUT_SECRET_KEY`: the encrypted files copy as
they are. Whoever copies it leaves `moved.json` at the folder's root, and
the default server's next boot (`src/server.ts`, before any store opens)
applies it and removes it (`src/moved.ts`):

```json
{
  "from": "/Users/tom/Library/Application Support/Peel/Strut/workspace",
  "bridge": {
    "from": { "url": "http://127.0.0.1:54321", "token": "<old token>" },
    "to":   { "url": "http://127.0.0.1:8090",  "token": "<new token>" }
  },
  "secrets": { "PEEL_BRIDGE_PORT": "8090", "PEEL_BRIDGE_TOKEN": "<new token>" }
}
```

Every field is optional. `from` (the folder's absolute path on the old
host): the upload and run-attachment paths (`<from>/uploads/…`,
`<from>/artifacts/…`) in `chats/*/messages.jsonl` and
`sessions/*/messages.jsonl` move onto this folder's path; run history is
left alone. `bridge`: every stored callback
that starts with `from.url` — automations' run.end URLs
(`automation-callbacks.json`), runs' `callback.json` / `job-callback.json`
/ `mcp.json`, `jobs/.callbacks/` — moves onto `to.url`, with `from.token`
in it becoming `to.token`; leave it out when the new host's bridge is not
up yet and the host points them itself (Peel does at every bridge start).
`secrets`: set (a string) or delete (`null`) deployment secrets through the
secret store. Rebuilt or machine-bound parts are dropped (`DROP` in
moved.ts: `steps/_graph*`, graph and memory snapshots and backups,
`audio/tmp`, `audio/dictation.json`, `repos`, `worktrees`,
`privacy/vault`, `acp/sessions`, temp and corrupt files,
`fs-workspace.imported-*`), and so are each job's checkouts — worktrees of
the dropped `repos/`, found by the job record's `repos` — which the record
then forgets; the job's own files (a plan, screenshots, deliverables)
stay. Every step is idempotent and the file goes only
once all of it is done, so a boot cut short does the move again. A
`moved.json` that does not parse fails the boot.

## Moving strut to another host

`strut move` (`src/move/`) copies a STOPPED strut to another host and back:
its data folder, its host config, named sidecars (opaque folders another
program owns, e.g. Peel's bridge) and env values, sealed with a pairing
code. The same code runs on both ends. A client stops its own processes
and runs it beside the server, never inside it:

| Where | How a client runs it |
|---|---|
| desktop package | `node desktop.js move …` (Peel; desktop.js's defaults apply, `--data` defaults to STRUT_WORKSPACE) |
| image or checkout | `node build/move/cli.js …` (an empty box's setup service: `… serve`) |

```
strut move check <link>
strut move send  <link> [folders] [--bridge <url>]
strut move serve        [folders] [--bridge <url>] [--set-secret N=V]... [--send-back]
                        [--listen [host:]port] [--host <h[:port]>] [--link <prefix>] [--name <n>]
strut move fetch <link> [folders] [--bridge <url>] [--set-secret N=V]...

folders: --data <dir> --host-config <file> --sidecar <name>=<path>... --env <file>
         --sidecar-env <name>=<file>... --state <dir>
```

- **Folders** are read when packing and written when unpacking, so both
  ends name theirs the same way. `--env` holds strut's own values
  (`KEY=value`; when sending, `<name>.KEY` is a sidecar's); strut's host
  settings (`STRUT_API_KEY`, ports, paths) never move. Received env files are
  written as `KEY='value'` (a shell or Compose `env_file` reads them), last,
  after the folders are in place. Not `--env-file`: node takes that flag
  for itself even after the script name. A host's sidecars must be the
  move's exactly, or the move is refused.
- **`serve`** on an empty data folder shows a page (link, code, QR) and
  takes one move, then exits 0 (`{"event":"received"}`); with `--send-back`
  it packs this host's folders under a fresh code, serves them until the
  other end confirms, sets them aside in `<data's parent>/sent-<time>/`
  and exits (`"sent"`). With strut already here and no `--send-back` it
  exits at once (`"already-here"`). The receive code is kept in `--state`
  (default `<data's parent>/.move`) until a move lands.
- **`moved.json` on arrival** (see "Moving a data folder"): `from` is the
  manifest's data path, `bridge` is the manifest's callbacks → this host's
  `--bridge` (its token in `STRUT_MOVE_BRIDGE_TOKEN`), `secrets` are the
  `--set-secret` values with `{bridge.url}`, `{bridge.port}`,
  `{bridge.token}` filled in. Peel: `--set-secret PEEL_BRIDGE_PORT={bridge.port}
  --set-secret PEEL_BRIDGE_TOKEN={bridge.token}`. On the sending side a
  `moved.json` not yet applied is applied before packing, and the
  workspace graph's WAL is folded into its file (opened and closed with
  this host's extensions): Ladybug logs each `LOAD EXTENSION` with its
  absolute path in the WAL and replays it on open, so a graph that travels
  with a WAL fails on any host without that path. `build/server.js` closes
  the graph on SIGTERM for the same reason, as desktop.js does.
- **Arrival is all or nothing**: the move is unpacked into `--state`,
  checked, then put in place; a step that fails (a folder it cannot
  write) takes back the ones before it, and `serve` keeps waiting. An
  empty target folder is filled rather than replaced, so it may be a mount
  point.
- **`check`** refuses another move format, another strut (`STRUT_VERSION`:
  the commit, which the image (`publish-image.yml`) and the desktop package
  (`desktop.json`'s `strut`) both stamp; a plain checkout reports
  package.json's version, so set it there to move to or from one) or
  another Ladybug core, and a wrong code. `send` and `fetch` check first.
- **The link**: plain `http://<host>/?code=<code>` (the page), or
  `<prefix>?host=<host>&code=<code>` with `--link <prefix>`
  (`STRUT_MOVE_LINK`; Peel: `peel://home-setup`). `--host` /
  `STRUT_MOVE_HOST` is the address it names; else the request's, or the
  first LAN address. `--listen` / `STRUT_MOVE_LISTEN` defaults to 8090.
- **stdout** is one JSON line per result (`ready` with `link`, `code`,
  `port`; `checked`; `sent`; `fetched`; `received`; `error`); words and the
  QR go to stderr. Exit 0 done, 1 refused or failed, 2 usage.
- **A peer record after the move**: `send --peer-actor <actor>` asks for
  one (the upload's `x-strut-move-peer` header); a `serve` given
  `--peer-url` (`STRUT_MOVE_PEER_URL`, e.g. `https://{host}:8443`, `{host}`
  the address the move came in on) answers the upload with `peer: { baseUrl,
  token, actor, exp, ca?, servername? }`, and the `sent` line carries it. The token is a
  person token (see "Auth") for that actor, living `--peer-days` (365),
  signed as the arriving strut signs: serve's `STRUT_API_KEY`, else its
  `STRUT_SECRET_KEY`, else the secret key the move carried. So run serve
  with the box strut's own `STRUT_API_KEY`. `ca` is `--peer-ca`'s PEM
  (`STRUT_MOVE_PEER_CA`), left out when the file is missing; with it,
  `servername` is `--peer-servername` (`STRUT_MOVE_PEER_SERVERNAME`), the
  name the box's certificate is issued for (a fixed name, so it stays valid
  when the box's address changes). The sender puts it on file with
  `PUT /peers/<id> { baseUrl, token, ca, servername }`. A host with no
  `--peer-url` answers `peer: { error }`.

HTTP (plain, home network only, everything that matters sealed):

| Request | Mode | |
|---|---|---|
| `GET /move/info` | both | `{ mode: "receive" \| "send-back", format: 1, strut, graph, ready? }` |
| `POST /move/check` | both | `{ salt: <32 hex>, token: <64 hex> }`, token = HKDF(code, salt, `strut move v1 check`): 200, or 401 |
| `PUT /move` | receive | the sealed move: 200 once in place; 401 wrong code; 400 not a move, bad archive, sidecars that don't match; 409 busy or already here |
| `GET /move` | send-back | the sealed move (`Range: bytes=a-[b]` resumes) |
| `POST /move/received` | send-back | `Authorization: Bearer <HKDF(code, the move's salt, "strut move v1 received")>`: 200 and this host's copy is set aside |

**The format.** Sealed: `STRUTMOV`, version `0x01`, a 16-byte salt, the
chunk size (u32 BE, 1 MiB written, 64 KiB–16 MiB read), then AES-256-GCM
chunks under HKDF-SHA256(code, salt, `strut move v1`); chunk *i*'s
nonce is `[final,0,0,0] ‖ i` (u64 BE), its AAD the header, written as
ciphertext ‖ tag; the last chunk is final. The code is 20 Crockford base32
characters (shown `XXXX-XXXX-…`, typed with dashes or not). The
construction is peel's first draft's; the constants are strut's, and the
test vector in `src/move/move.test.ts` is what a client's implementation
checks itself against.
Inside, a gzip-compressed ustar of regular files (`src/tar.ts`; a path
ustar cannot hold in a PAX extended header):
`move.json` (`{ format: "strut-move", version: 1, strut, graph, created,
from, hostConfig, sidecars, callbacks? }`), `env.json` (`{ strut, sidecars:
{ <name>: {…} } }`), `host-config.json`, `data/…` (minus `leftBehindIn` in
moved.ts: what arrival drops, temp files, jobs' checkouts) and
`sidecars/<name>[/…]`. Empty folders do not move.

## Home sync

Two normal struts share one memory: a home box (the one writer) and a
strut that keeps a read copy of it (a Mac's, for dictation; peel
`docs/always-on.md`). The copy pushes what it changed, then pulls, with a
person token (`strut move` hands one over, above). The box runs with
`STRUT_HOME_SYNC=box`, which opens two routes to a person's credential
only: the plain peer key and the deployment key are refused, and so is a
request with no credential on a box with no `STRUT_API_KEY`:

| Route | Body | Reply |
|---|---|---|
| `POST /home/push` | one key per kind of change; today `{ dictation? }`, `dictation/changes-since`'s `changes` (at most 10 000) | `{ dictation: { applied: [{ op, heard?, written, result }] } }` |
| `POST /home/pull` | `{ hash? }`, the `content_hash` of the copy the caller holds | `{ unchanged: true, content_hash }`, else `memory/export`'s inline reply (`data`, `content_hash`, …) for `memory/import { replace: true }` |

On a box whose memory is the graph (`memory: "graph"`), `/home/pull` carries
dictation's vocabulary alone: `{ content_hash, dictation }`,
`dictation/changes-since`'s changes since the copy's last pull, which
`home/sync` on a graph copy replays with `dictation/apply-changes`. Its
`content_hash` is a cursor (`graph-dictation:<until>`) that the copy sends
back as `hash`; any other hash pulls the whole vocabulary, which the copy
skips as known. What it replays is pushed back once, and the box skips it as
known. The rest of the graph is not pulled, and a graph copy refuses a
whole-memory snapshot (`src/steps/lib/home/_graph-pull.ts`).

Routes, not workflows: a run's input and output stay in the run store,
which every peer scope may read, so a whole-memory export there would
outlive the pull and reach other credentials. A route answers its caller
(`cache-control: no-store`) and keeps nothing.

- **`dictation/changes-since { since? }`** reads the changes from the graph
  itself, no outbox: mishearing facts `created_by: "dictation"` (and terms,
  dictation-type entities with none) created from `since` up to `until`,
  and those forgotten with reason `undone` in that span. Each is keyed by
  its pair (`heard`, `written`, and `name` when `written` is another form
  of that entity), never a ref_id. It returns `until`, the next call's
  `since`, and reads in the writes' queue: a write stamps its time before
  it commits, so a read beside one would miss it for good. A learn later
  undone says so (`undone: true`); one later forgotten for another reason
  (`dictation/remove`) is left out.
- **`dictation/apply-changes { changes }`** replays them in order through
  `dictation/add` (which takes `name` and `term` for this) and
  `dictation/undo`, matching an undo by its pair (the entity, when
  dictation made it and the pair is all that is known of it). Idempotent:
  `known`, `already undone`, `not found` and `not dictation's` are reported,
  not errors. A learn marked `undone` of a pair already undone here is
  `already undone` and writes nothing: learned again it would be undone
  again, a new entity each time the batch is sent. One not marked (added
  again by hand after an undo) is learned.
- **The copy's side: `home-sync { peer? }`**, seeded by
  `STRUT_HOME_SYNC=copy`; one step, `home/sync`, so neither the changes nor
  the memory pass through a run's journal (its output is a summary:
  `{ pushed, pulled, hash, counts?, backup?, kept }`). The home is a peer
  on file (default `home`) whose token is a person token. It reads the
  last sync (`home/state`: `since`, `hash`, kept in
  `<dataDir>/home-sync.json`), sends `dictation/changes-since`'s changes to
  `/home/push`, then asks `/home/pull` with its hash; a changed memory is
  loaded with `memory/import`'s replace (backed up, put back on failure).
  Only then does it record the new hash and `since`: the push's `until`,
  or, when it pulled, the `until` of its read inside the import's lock
  (below), so the home's copies of what it pushed, stamped when the home
  applied them, are not pushed back by the next sync.
  A sync that fails (away from home, a push refused) records nothing; the
  next one pushes the same changes again (idempotent) and catches up. Run
  it on a timer, on wake, after a correction.
- **Dictation while it syncs**: `home/sync` reads the push's changes in
  the writes' queue, as `dictation/changes-since` does. Then, inside the
  memory lock (`memoryExclusive`, which `memory/import` holds too), it
  reads what dictation changed from the push's `until` on from the old
  graph (kept in `home-sync.json` as `pending` until replayed), replaces the graph,
  and replays those changes onto the new one (`kept`), so the next push
  carries them. A write that arrives meanwhile waits for the lock; a
  transcription that reads the vocabulary mid-import gets no rewrite for
  that utterance (audio/routes.ts falls back to the plain text).
- **A new kind** (one that exists, not before): a `<kind>/changes-since`
  and `<kind>/apply-changes` pair, a key on `/home/push`, and its changes
  read and sent in `home/sync`.
