// The calling end of a move (AGENTS.md, "Moving strut to another host"):
// `check` a link, `send` this host's stopped folders to a strut serving
// receive, `fetch` them from one serving a send-back.
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { FORMAT_VERSION, install, moveVersion, packFolders, unpack, type Arrival, type Endpoint, type Manifest, type MoveFolders } from "./archive.js";
import { parseLink } from "./link.js";
import { open, proof, saltOf, seal } from "./seal.js";
import { stateDir } from "./serve.js";

export interface MoveInfo {
  mode: "receive" | "send-back";
  format: number;
  strut: string;
  graph: string | null;
  ready?: boolean;
}

async function call(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw new Error(`could not reach ${new URL(url).origin}: ${err instanceof Error ? (err.cause as Error)?.message ?? err.message : err}`);
  }
}

async function refused(res: Response, what: string): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return new Error(`${what}: ${body.error ?? `HTTP ${res.status}`}${res.status === 401 ? " (check the code)" : ""}`);
}

/** The serving strut's mode, once its format and versions match this one's
 *  and it takes the link's code. `expect` refuses the other mode. */
export async function check(link: string, opts: { expect?: MoveInfo["mode"]; version?: { strut: string; graph: string | null } } = {}): Promise<MoveInfo> {
  const { base, code } = parseLink(link);
  const res = await call(`${base}/move/info`);
  if (!res.ok) throw await refused(res, "the other end is not serving a move");
  const info = (await res.json()) as MoveInfo;
  if (info.format !== FORMAT_VERSION) throw new Error(`the other end speaks move format ${info.format}; this strut speaks ${FORMAT_VERSION}`);
  const mine = opts.version ?? moveVersion();
  if (info.strut !== mine.strut || info.graph !== mine.graph) {
    throw new Error(`versions differ: the other end runs strut ${info.strut} (Ladybug ${info.graph ?? "none"}), this one ${mine.strut} (Ladybug ${mine.graph ?? "none"}); update one first`);
  }
  if (opts.expect && info.mode !== opts.expect) {
    throw new Error(opts.expect === "receive" ? "the other end is not empty: it is sending a move back" : "the other end is waiting to receive a move, not sending one back");
  }
  const salt = randomBytes(16);
  const ok = await call(`${base}/move/check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ salt: salt.toString("hex"), token: proof(code, salt, "check").toString("hex") }),
  });
  if (!ok.ok) throw await refused(ok, "the code was refused");
  return info;
}

/** Pack this host's folders (stopped), seal them with the link's code and
 *  upload them. `bridge`: the bridge their callbacks point at. */
export async function send(link: string, f: MoveFolders, opts: { bridge?: Endpoint; version?: { strut: string; graph: string | null } } = {}): Promise<Manifest> {
  await check(link, { expect: "receive", ...(opts.version ? { version: opts.version } : {}) });
  const { base, code } = parseLink(link);
  const { manifest, plain } = await packFolders(f, opts.bridge);
  const sealed = seal(plain, code);
  const res = await call(`${base}/move`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: Readable.toWeb(Readable.from(sealed)) as ReadableStream,
    duplex: "half",
  } as RequestInit);
  if (!res.ok) throw await refused(res, "the move was refused");
  return manifest;
}

/** Download a sent-back move, put it in place here with `moved.json`
 *  (`arrival`: this host's bridge and secrets), then tell the other end,
 *  which sets its copy aside. */
export async function fetchMove(
  link: string,
  f: MoveFolders,
  opts: Arrival & { state?: string; version?: { strut: string; graph: string | null } } = {},
): Promise<Manifest> {
  const info = await check(link, { expect: "send-back", ...(opts.version ? { version: opts.version } : {}) });
  if (!info.ready) throw new Error("the other end has not packed the move yet");
  const { base, code } = parseLink(link);
  const res = await call(`${base}/move`);
  if (!res.ok || !res.body) throw await refused(res, "the move could not be downloaded");
  const incoming = join(stateDir({ data: f.data, ...(opts.state ? { state: opts.state } : {}) }), "incoming");
  await rm(incoming, { recursive: true, force: true });
  let salt: Buffer | null = null;
  let manifest: Manifest;
  try {
    await unpack(open(Readable.fromWeb(res.body as never), code, (h) => (salt = Buffer.from(saltOf(h)))), incoming);
    manifest = await install(incoming, f, { ...(opts.bridge ? { bridge: opts.bridge } : {}), ...(opts.secrets ? { secrets: opts.secrets } : {}) });
  } finally {
    await rm(incoming, { recursive: true, force: true });
  }
  const done = await call(`${base}/move/received`, {
    method: "POST",
    headers: { authorization: `Bearer ${proof(code, salt!, "received").toString("hex")}` },
  });
  if (!done.ok) throw await refused(done, "the move is in place here, but the other end did not take the confirmation (it still holds its copy)");
  return manifest;
}
