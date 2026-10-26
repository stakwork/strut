// `strut move serve` (AGENTS.md, "Moving strut to another host"): the
// receiving end of a move on an empty host, and the sending end of a move
// back. Plain HTTP, meant for a home network only while a move is under way:
// everything that crosses it is sealed with the code.
//
//   receive    the data folder is empty: show the link and code, take one
//              sealed move (PUT /move), put it in place with moved.json, end.
//   send-back  `sendBack`: pack this host's folders (stopped) under a fresh
//              code, serve them (GET /move) until the other end proves it
//              has them (POST /move/received), set them aside, end.
//
// Anything else — the data folder holds a strut and no send-back was asked
// for — ends at once ("already-here").
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, mkdir, open as openFile, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { personToken } from "../auth.js";
import { bootEnv } from "../env.js";
import { FORMAT_VERSION, install, moveVersion, packFolders, unpack, type Endpoint, type MoveEnv, type MoveFolders } from "./archive.js";
import { makeLink, qrSvg } from "./link.js";
import { groupCode, HEADER_SIZE, newCode, open as openSealed, saltOf, seal, verifyProof, WrongCode } from "./seal.js";

export interface ServeOptions extends MoveFolders {
  /** Where to listen; default port 8090 on every interface. */
  port?: number;
  host?: string;
  /** This host's address as the link names it; else the request's Host, or
   *  the first LAN address. */
  publicHost?: string;
  /** The link's scheme prefix (`makeLink`); default a plain http link. */
  linkPrefix?: string;
  /** What the page calls what moves; default "strut". */
  name?: string;
  /** Codes, the staged move: default `<data's parent>/.move`. */
  state?: string;
  /** This host's bridge: on receive, where `moved.json` points the
   *  callbacks; on send-back, the bridge the packed folder's callbacks name. */
  bridge?: Endpoint;
  /** Secrets for `moved.json` on receive (`Arrival.secrets`). */
  secrets?: Record<string, string>;
  sendBack?: boolean;
  /** After a move lands, hand the sender a peer record for this strut, when
   *  it asks (`send { peerActor }`): `url` is where peers reach this strut
   *  (`https://{host}:8443`: `{host}` is the address the move came in on),
   *  `ca` a PEM file their TLS should trust (read when the record is made;
   *  left out when missing), `servername` the name its certificate is
   *  issued for when that is not the URL's host, `days` the person token's
   *  life (default 365). */
  peer?: { url: string; ca?: string; servername?: string; days?: number };
  /** Overrides `moveVersion()` (tests). */
  version?: { strut: string; graph: string | null };
  /** Told once the link works. */
  onReady?: (ready: { link: string; code: string; port: number; mode: "receive" | "send-back" }) => void;
}

export type ServeResult = "received" | "sent" | "already-here";

export function stateDir(o: { data: string; state?: string }): string {
  return resolve(o.state ?? join(dirname(resolve(o.data)), ".move"));
}

async function isEmpty(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw err;
  }
}

/** The code kept in `file`, or a new one written there: a restart keeps a
 *  link already shown. */
async function keptCode(file: string): Promise<string> {
  try {
    const { code } = JSON.parse(await readFile(file, "utf-8")) as { code?: unknown };
    if (typeof code === "string" && code) return code;
  } catch {
    /* none yet */
  }
  const code = newCode();
  await writeFile(file, JSON.stringify({ code }), { mode: 0o600 });
  return code;
}

function lanAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return undefined;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
const fail = (res: ServerResponse, status: number, error: string) => json(res, status, { error });

async function body(req: IncomingMessage, max = 4096): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > max) throw new Error("too large");
  }
  return JSON.parse(raw);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(res: ServerResponse, title: string, inner: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --bg: #fafaf9; --fg: #1c1917; --muted: #78716c; --card: #fff; --line: #e7e5e4; --accent: #1d4ed8; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1c1917; --fg: #fafaf9; --muted: #a8a29e; --card: #292524; --line: #44403c; --accent: #93c5fd; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 -apple-system, system-ui, sans-serif; }
  main { max-width: 34rem; margin: 3rem auto; padding: 0 1rem; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 1.5rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .75rem; }
  .muted { color: var(--muted); font-size: .9rem; }
  .qr { display: block; width: 14rem; height: 14rem; margin: 1.25rem auto; border-radius: 8px; }
  .code { font: 600 1.2rem/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .05em; text-align: center; margin: .5rem 0 1rem; }
  .actions { text-align: center; margin: 1rem 0 .5rem; }
  a.button { display: inline-block; background: var(--accent); color: var(--card); border-radius: 8px; padding: .6rem 1rem; text-decoration: none; }
</style></head>
<body><main><div class="card"><h1>${esc(title)}</h1>${inner}</div></main></body></html>`);
}

/** Serve one move, in or out, and resolve once it is done. */
export async function serve(o: ServeOptions): Promise<ServeResult> {
  const data = resolve(o.data);
  const receiving = await isEmpty(data);
  if (!receiving && !o.sendBack) return "already-here";
  const state = stateDir(o);
  await mkdir(state, { recursive: true, mode: 0o700 });
  const version = o.version ?? moveVersion();
  const name = o.name ?? "strut";
  const port = o.port ?? 8090;
  const mode = receiving ? "receive" : "send-back";
  const hostFor = (req?: IncomingMessage) => o.publicHost ?? req?.headers.host ?? `${lanAddress() ?? "localhost"}:${port}`;

  // Receive keeps its code across restarts; a send-back's is fresh.
  const code = receiving ? await keptCode(join(state, "receive.json")) : newCode();
  const outgoing = join(state, "outgoing.move");
  let salt: Buffer | null = null;
  if (!receiving) {
    await rm(outgoing, { force: true });
    const f: MoveFolders = { ...o, data };
    const sealed = seal((await packFolders(f, o.bridge)).plain, code);
    await pipeline(Readable.from(sealed), createWriteStream(`${outgoing}.part`, { mode: 0o600 }));
    await rename(`${outgoing}.part`, outgoing);
    const header = Buffer.alloc(HEADER_SIZE);
    const fh = await openFile(outgoing, "r");
    await fh.read(header, 0, HEADER_SIZE, 0);
    await fh.close();
    salt = Buffer.from(saltOf(header));
  }

  let busy = false;
  let finish!: (r: ServeResult) => void;
  const done = new Promise<ServeResult>((r) => (finish = r));

  const server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    try {
      if (req.method === "GET" && path === "/") {
        if (receiving) {
          const link = makeLink(hostFor(req), code, o.linkPrefix);
          return page(res, `Move ${name} here`,
            `<p>This host is ready for ${esc(name)}, moved from another machine.</p>
<p>Open this link where ${esc(name)} runs now, or scan the code.</p>
<div class="actions"><a class="button" href="${esc(link)}">Move ${esc(name)} here</a></div>
${qrSvg(link)}<p class="muted" style="text-align:center">Code</p><div class="code">${groupCode(code)}</div>
<p class="muted">The move is sealed with this code. ${esc(name)} is offline while it moves, about a minute.</p>`);
        }
        return page(res, `Sending ${name} back`,
          `<p>${esc(name)} is packed and ready to go back.</p><p class="muted">Open the link printed where the send-back was asked for.</p>`);
      }
      if (req.method === "GET" && path === "/move/info") {
        return json(res, 200, { mode, format: FORMAT_VERSION, ...version, ...(receiving ? {} : { ready: true }) });
      }
      if (req.method === "POST" && path === "/move/check") {
        const b = (await body(req).catch(() => ({}))) as { salt?: unknown; token?: unknown };
        return verifyProof(code, b.salt, b.token, "check") ? json(res, 200, { ok: true }) : fail(res, 401, "wrong code");
      }
      if (receiving && req.method === "PUT" && path === "/move") {
        if (busy) return fail(res, 409, "another move is being received");
        if (!(await isEmpty(data))) return fail(res, 409, `${name} is already on this host`);
        busy = true;
        const incoming = join(state, "incoming");
        let peer: MovePeer | { error: string } | undefined;
        try {
          await rm(incoming, { recursive: true, force: true });
          await unpack(openSealed(req, code), incoming);
          await install(incoming, { ...o, data }, { ...(o.bridge ? { bridge: o.bridge } : {}), ...(o.secrets ? { secrets: o.secrets } : {}) });
          const actor = req.headers["x-strut-move-peer"];
          // The move is in place: a record that cannot be made says why, it never refuses the move.
          if (typeof actor === "string" && actor) {
            peer = await peerRecord(o.peer, actor, req, join(incoming, "env.json")).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
          }
        } catch (err) {
          req.resume();
          console.error(`[move] a move was refused: ${err instanceof Error ? err.message : err}`);
          return fail(res, err instanceof WrongCode ? 401 : 400, err instanceof Error ? err.message : String(err));
        } finally {
          busy = false;
          await rm(incoming, { recursive: true, force: true });
        }
        await rm(join(state, "receive.json"), { force: true });
        json(res, 200, { ok: true, ...(peer ? { peer } : {}) });
        return finish("received");
      }
      if (!receiving && req.method === "GET" && path === "/move") return serveFile(req, res, outgoing);
      if (!receiving && req.method === "POST" && path === "/move/received") {
        const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
        if (!verifyProof(code, salt!.toString("hex"), token, "received")) return fail(res, 401, "wrong code");
        await setAside({ ...o, data }, state);
        json(res, 200, { ok: true });
        return finish("sent");
      }
      fail(res, 404, "not found");
    } catch (err) {
      if (!res.headersSent) fail(res, 500, err instanceof Error ? err.message : String(err));
    }
  });
  await new Promise<void>((r, j) => server.once("error", j).listen(port, o.host, () => r()));
  const bound = (server.address() as { port: number }).port;
  const named = o.host && o.host !== "0.0.0.0" && o.host !== "::" ? o.host : (lanAddress() ?? "localhost");
  const link = makeLink(o.publicHost ?? `${named}:${bound}`, code, o.linkPrefix);
  o.onReady?.({ link, code, port: bound, mode });
  const result = await done;
  await new Promise<void>((r) => server.close(() => r()));
  server.closeAllConnections();
  return result;
}

/** What a sender is handed after its move lands, to put on file as a peer
 *  (`PUT /peers/:id { baseUrl, token, ca? }`) on its side. */
export interface MovePeer {
  baseUrl: string;
  /** A person token for `actor` (auth.ts), the credential `peer: person` workflows take. */
  token: string;
  actor: string;
  exp: number;
  ca?: string;
  /** The name the box's certificate is issued for (`Peer.servername`). */
  servername?: string;
}

/** A peer record for the strut that just arrived. Its person token must
 *  verify there, so it is signed as that strut signs: with its
 *  STRUT_API_KEY, else its STRUT_SECRET_KEY — this process's, which the
 *  host gives it, else the secret key the move carried. */
async function peerRecord(cfg: ServeOptions["peer"], actor: string, req: IncomingMessage, envFile: string): Promise<MovePeer | { error: string }> {
  if (!cfg) return { error: "this host hands out no peer record (serve --peer-url)" };
  if (actor.length > 120 || /[\r\n]/.test(actor)) return { error: "the peer actor must be a short string" };
  const env = bootEnv();
  const moved = (JSON.parse(await readFile(envFile, "utf-8").catch(() => "{}")) as Partial<MoveEnv>).strut ?? {};
  const secret = env["STRUT_API_KEY"] || env["STRUT_SECRET_KEY"] || moved["STRUT_SECRET_KEY"];
  const minted = secret ? personToken(actor, (cfg.days ?? 365) * 86_400_000, secret) : undefined;
  if (!minted) return { error: "nothing to sign a person token with: give serve the strut's STRUT_API_KEY" };
  const host = new URL(`http://${req.headers.host ?? "localhost"}`).hostname;
  const ca = cfg.ca ? await readFile(cfg.ca, "utf-8").catch(() => undefined) : undefined;
  return {
    baseUrl: cfg.url.replace("{host}", host).replace(/\/+$/, ""), token: minted.token, actor, exp: minted.exp,
    ...(ca ? { ca, ...(cfg.servername ? { servername: cfg.servername } : {}) } : {}),
  };
}

/** The packed move, with `Range: bytes=a-[b]` so a download can resume. */
async function serveFile(req: IncomingMessage, res: ServerResponse, file: string): Promise<void> {
  const { size } = await stat(file);
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
  let start = 0;
  let end = size - 1;
  if (range) {
    start = Number(range[1]);
    end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end) {
      res.writeHead(416, { "content-range": `bytes */${size}` });
      return void res.end();
    }
  }
  res.writeHead(range ? 206 : 200, {
    "content-type": "application/octet-stream",
    "content-length": String(end - start + 1),
    "accept-ranges": "bytes",
    ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
  });
  await pipeline(createReadStream(file, { start, end }), res);
}

/** After a send-back: this host's parts go to `<data's parent>/sent-<time>/`,
 *  env files first, so a host waiting on them sees nothing here anymore. */
async function setAside(o: MoveFolders, state: string): Promise<void> {
  const sent = join(dirname(resolve(o.data)), `sent-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(2).toString("hex")}`);
  const moves: Array<[string, string]> = [];
  if (o.envFile) moves.push([o.envFile, "env"]);
  for (const [n, f] of Object.entries(o.sidecarEnv ?? {})) moves.push([f, `sidecar-env/${n}`]);
  moves.push([o.data, "data"]);
  if (o.hostConfig) moves.push([o.hostConfig, "host-config.json"]);
  for (const [n, p] of Object.entries(o.sidecars ?? {})) moves.push([p, `sidecars/${n}`]);
  for (const [from, rel] of moves) {
    const to = join(sent, rel);
    if (!(await stat(from).catch(() => null))) continue;
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    try {
      await rename(from, to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      await cp(from, to, { recursive: true });
      await rm(from, { recursive: true, force: true });
    }
  }
  await rm(join(state, "outgoing.move"), { force: true });
}
