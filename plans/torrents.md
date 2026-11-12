# Torrents: strut as a BitTorrent client

> **Status (2026-11-11): PROPOSED, nothing built.** Ruled so far: the
> engine is rqbit (Evan, 2026-11-11). Written after a read of strut `main`
> @f392bb2, of Evan's sphinx-bittorrent (2024: rqbit + a Rust server,
> `tome`), and of upstream rqbit at v9.1.0 (released 2026-10-29). Every
> other choice below is a lean, listed again in §11.

## Why

One engine, three uses:

1. **Viewing a torrent as a client.** Peel opens a magnet, sees what is in
   it before downloading — for a filepack package (§5), its title,
   artwork, creator and who signed it — and plays it while it downloads.
   This is the ask (2026-11-11).
2. **Big files between struts with no server in the middle**: a job's
   4 GB deliverable to a peer, the home box to the phone.
3. **Later, packages**: a strut that installed a package can seed it. A
   smaller step than `plans/marketplace.md` assumed (§8).

Not search. sphinx-bittorrent's `tome` searched Pirate Bay, torrent-csv
and YTS for magnets; that is left out on purpose (§7).

## 1. What carries over from sphinx-bittorrent

`tome` already had this shape: rqbit running as its own server, and a
server of ours calling rqbit's HTTP API (`RqbitApi`, `RQBIT_URL`). It
imported librqbit only for the API's types, from a fork whose four
commits add serde derives, a Dockerfile and a `price_msat` field; strut
calls the API from TypeScript, so it needs neither the fork nor the
library.

| tome (2024) | strut |
|---|---|
| rqbit server, called over HTTP | the same: §2 |
| `magnet_details` (`list_only=true`: files and size, priced) | `torrent/inspect`: §3 |
| `add_magnet`, paid per GB through a Sphinx bot | `torrent/add` behind the approve gate; selling through paid runs, later (§9) |
| `stats/:id`, a broadcast websocket | `torrent/status` and `job.update { kind: "torrent" }` |
| dufs serving the download folder | the job's file route, streaming (§4) |
| Sphinx key sign-in → JWT | person tokens and sessions, as they are |
| pay to upload, storage proof by HMAC challenge | later (§9) |
| search over Pirate Bay, torrent-csv, YTS | left out |

## 2. The engine: rqbit beside strut, never inside it

Upstream rqbit, unchanged. It runs as a process of its own, as the
browser does (`ctx.services.browser` over a Playwright server or a local
Chrome): a long-running network engine inside the server process is the
part that is hard to keep up.

- **`ctx.services.torrent`** (`TorrentService`, `src/torrent/service.ts`),
  built by `createStrut` from env unless the services bag has one, and
  connecting to nothing until a step asks. `TORRENT_URL` + `TORRENT_AUTH`
  name a running rqbit (a server); else `TORRENT_BINARY` (default: the
  one the desktop package bundles) is started on first use; neither, and
  the `torrent/*` steps fail naming what is missing.
- **On a server**: a compose service `torrent`, the `ikatson/rqbit` image
  pinned to a version (as `strut-browser` is), its API
  (`RQBIT_HTTP_API_LISTEN_ADDR`) on a network of its own that only strut
  joins, behind basic auth (`RQBIT_HTTP_BASIC_AUTH_USERPASS`), the peer
  port (`RQBIT_LISTEN_PORT`) published, UPnP off
  (`RQBIT_UPNP_PORT_FORWARD_DISABLE`).
- **On the desktop**: the rqbit binary in `native/`, its sha256 pinned as
  the Ladybug extensions' are; strut starts it on first use, on
  `127.0.0.1`, with a random port and password per process, and stops it
  on `close()` and when strut exits.

**Only strut talks to rqbit.** Its API adds a torrent from a local file
path (`POST /torrents` with a path) and creates and seeds a torrent from
any local folder (`POST /torrents/create`): a page, a step or an agent
that reached it could share any folder on the box. So the service is its
only client; its URL and password are never in `ctx`; every folder strut
hands it is one strut computed inside a job's directory, and a request
naming any other path is refused before rqbit sees it.

**Where downloads live.** rqbit writes into the folder strut names
(`output_folder`), so both must see one path. On the desktop they share a
disk. In compose, the jobs folder (`<dataDir>/jobs`) becomes a volume of
its own, mounted at the same path in both containers: rqbit sees jobs,
never `secrets.json` or the graph. A download is
`<job dir>/torrents/<infohash>/`, the torrent's own layout under it.

## 3. The steps

| Step | Does | Effect |
|---|---|---|
| `torrent/inspect { magnet }` | what is in it, downloading nothing: `{ infohash, name, size, files: [{ index, path, size }], peers }` (`POST /torrents?list_only=true`) | read |
| `torrent/add { magnet, files?, seed? }` | download into the job's directory, the files picked by index when given (`only_files`); `{ infohash, folder, files }` | write |
| `torrent/select { infohash, files }` | fetch more of it: the person pressed play (`update_only_files`) | write |
| `torrent/status { infohash, wait? }` | progress, rates, peers, state (`stats/v1`) | read |
| `torrent/remove { infohash, files: keep \| delete }` | stop it and forget it, keeping or deleting what arrived | write |
| `torrent/seed { path }` | make a torrent of a folder inside the job's directory and seed it: its magnet (§10 item 7) | write |

- **A torrent is held by its job** (`plans/jobs.md` §6): `torrent/add`
  holds `torrent:<infohash>` with `torrent/remove` as the release step,
  so deleting the job or the idle sweep stops it. A torrent without a
  job is refused: there is nowhere to put it.
- **Live**: while a job holds a torrent that is not done, the service
  reads its stats every few seconds and sends `job.update { kind:
  "torrent", id: <infohash>, state: downloading | paused | seeding | done
  | error, detail: { progress, bytes, total, down, up, peers } }`,
  coalesced like every update, so Jamie and any app's `useJobUpdates`
  show it.
- **Who may**: `torrent/add` and `torrent/seed` are proposals wherever
  they are granted (in the seed's `approve:`); `describe` puts the inspect
  answer on the card ("Download 'X': 12 files, 4.2 GB, 80 peers"), so the
  person approves the whole torrent and `torrent/select` within it asks
  nothing. No seed grants `torrent/*` until §11's question 3 is ruled; a
  host adds them in its delta.
- **Limits**: an add over `TORRENT_MAX_BYTES` (inspect's size) is refused
  before rqbit downloads anything.

## 4. Serving what arrived

Two things are missing today, and both matter beyond torrents:

- **The job's file route reads the whole file into memory and takes no
  `Range`** (`GET /jobs/:id/files/:path`, `createStrut.ts`; artifacts the
  same). A 4 GB film needs it to stream from disk and answer `Range` with
  206, `content-range` and `accept-ranges`. Safari and WKWebView, which
  Peel's web view is, will not seek a video without ranges.
- **The peer read-through passes back `etag` and `cache-control` only.**
  It must forward `range` and `if-range` and pass back `content-range`,
  `accept-ranges` and `content-length`, or the phone (§6) cannot seek
  through the home box.

**While it downloads**, a file not yet complete is served by proxying
rqbit's `GET /torrents/{id}/stream/{file}`, which blocks on the missing
pieces and fetches them first, behind the job's same file token: one URL
(`/jobs/:id/files/torrents/<infohash>/<path>`) whether the file is on
disk or still arriving. What arrives is untrusted content, served under
the artifact headers like any other file.

## 5. Filepack: reading what arrived

Casey Rodarmor's filepack (rodarmor.com/blog/filepack) is a folder with a
`manifest.filepack`: a BLAKE3 fingerprint over the folder, Ed25519
signatures over the fingerprint kept beside the files, and a fixed
metadata schema made for media (`title`, `creator`, `artwork`, `readme`,
`media`, `publisher`, `homepage` and a few more; unknown fields refused).
It says its format may still change.

- **A reader only.** Strut never writes a filepack and never makes its
  fingerprint anything's identity: packages keep their sha256 digest
  (`plans/marketplace.md` §1). Its filename lints are already strut's
  (`pathProblems`, stakwork/strut#642).
- **`filepack/read { path }`** → `{ fingerprint, verified, signatures:
  [{ key, time? }], metadata }`: the `filepack` binary through
  `ctx.services.shell` (`filepack verify`, `filepack metadata`), the
  path inside the job's directory. The binary is a requirement like
  ffmpeg: in the image and the desktop package at a pinned version, on
  `PATH` elsewhere; missing, the step fails naming it. Effect read. The
  exact commands and JSON shapes are to confirm against the version
  pinned.
- **Looking before downloading.** Inspect lists `manifest.filepack`,
  `metadata.filemeta` and the artwork; `torrent/add { files: [those] }`
  fetches them alone (kilobytes), and `filepack/read` reads the metadata.
  It is **unverified until every file is in**, since the fingerprint
  covers them all, and the card says so. Play is `torrent/select` of the
  rest.
- **Who signed it.** A filepack key is Ed25519 (`public1…`). Peel's people
  are Sphinx keys (secp256k1) and strut's publishers Ed25519 keys in
  z-base-32, so nothing says who a filepack key is. V1 shows the key, and
  whether it is one the person saved (§11 question 4).

## 6. The viewer, and Peel

- **A `strut/views` component**, `TorrentView`: the inspect answer, or a
  filepack's metadata when there is one — artwork, title, creator, the
  readme as markdown, the files or media with their sizes — each with a
  play button that selects it and opens it through the file route
  (streaming while it arrives), the progress from `useJobUpdates`, the
  signature line. Jamie draws it for a `kind: "torrent"` deliverable; any
  app imports it.
- **Peel on a Mac**: the desktop strut does all of it. Nothing in Swift.
- **Peel on the phone**: through the home box. The box downloads and does
  the uploading (it is up all night); the phone opens the deliverable
  through the read-through, which needs §4. No torrent code on the phone.
- **Not here**: rqbit or filepack compiled into the iOS app (Peel already
  links Rust over FFI). The App Store has historically not taken
  BitTorrent clients, and the home box makes it unnecessary.

## 7. Uploading, and what it costs

- **Seeding is outbound traffic.** On a cloud box that is billed (EC2
  about $0.09/GB) and, for whatever someone shares there, the provider
  gets the copyright notice. So a torrent is paused once complete unless
  it was added with `seed: true` or made by `torrent/seed`, and a server
  caps upload globally (`TORRENT_UPLOAD_LIMIT` → `RQBIT_RATELIMIT_UPLOAD`).
  On the desktop, seeding is the person's choice, UPnP off unless they
  turn it on.
- **Who may add a magnet** is the approve gate (§3). No search route: an
  agent with a search over pirate indexes is a piracy tool, whatever it
  was built for.
- **Between struts only**: rqbit can take a peer allowlist and refuse
  every other connection, a swarm of known struts. Not v1.
- **Disk**: `TORRENT_MAX_BYTES` per add (§3); the job's idle sweep keeps
  files, so a held torrent's folder stays until the job is deleted.

## 8. Packages: later, and smaller than marketplace.md thought

rqbit has no BitTorrent v2 (BEP 52, rqbit#70 open) and no web seeds
(BEP 19 is not in its list). The two ways `plans/marketplace.md` §13
names (a fixed archive served as a web seed, a v2 torrent of the folder
with a per-file route) are not rqbit's. With rqbit a package travels as a
v1 torrent made from its cache folder (`POST /torrents/create`), the card
naming its infohash beside the digest (a v1 infohash depends on how it
was made, so it is named, never derived), fetched from struts that hold
it. HTTP stays the base, and the install checks the digest whatever
brought the files. Not before §3–§6 have run.

## 9. Selling: later

- tome priced adding a magnet per GB (`ADD_MSAT_PER_GB`) and paid through
  a Sphinx bot. Strut sells through paid runs (`plans/paid-runs.md`): a
  priced workflow over `torrent/add`. Its price is base + markup × the
  run's model cost, so a price per GB is not expressible yet: the one
  addition would be a way for a step to report a cost of its own.
- tome's storage proof (an HMAC over a random range, keyed by the
  challenge) is a check in strut's claims terms.

## 10. Work items

1. **The file routes stream and take `Range`**; the read-through forwards
   it (§4). Worth having alone: every big deliverable needs it.
2. **`TorrentService`**, the compose service and volume, the desktop
   binary, the env. Tests against a stand-in rqbit API; an opt-in live
   test (`npm run test:torrent`): two local rqbit processes, one making a
   torrent of a temp folder, the other adding it with `initial_peers`, no
   internet.
3. **`torrent/inspect`, `add`, `select`, `status`, `remove`**: holds,
   `job.update`, the approve gate, `describe`.
4. **Streaming while it downloads** on the file route (§4).
5. **`filepack/read`** and the binary (§5).
6. **`TorrentView`** and Jamie's card (§6).
7. **`torrent/seed`**: strut to strut.

Later: packages (§8), selling (§9), the peer allowlist (§7).

## 11. Open questions

1. **The jobs volume.** In compose, the jobs folder shared with rqbit is a
   volume of its own: backups and `strut move` must take it too. Or rqbit
   gets the whole workspace volume and the isolation is the API alone.
2. **Upload defaults**: the server's cap, and whether the desktop seeds by
   default.
3. **Grants**: whether the `job` seed grants `torrent/*` (with `add`,
   `select` and `seed` in `approve:`), or no seed does until a host adds
   them.
4. **Filepack keys**: where a person keeps the keys they trust, and
   whether a Sphinx or publisher identity can vouch for one.
5. **The viewer**: a `strut/views` component only, or a first-party app
   (`strut/media`) that lists a person's torrents across jobs.
6. **Pinning rqbit**: upstream's image by version, or an image of our own
   as `images/browser` is; the desktop binary from rqbit's GitHub release,
   sha256 pinned.
