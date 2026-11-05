/**
 * The PEER RELAY for channels (plans/app-channels.md §4): a page in this
 * strut's UI showing an app that lives on a PEER (`?app=@<peer>/<name>`,
 * how Peel shows an org's apps) uses that app's channels, which live on the
 * peer. Its host opens its socket HERE, as for any app; this strut opens a
 * socket to the peer's `GET /channels?app=<name>@<version>` with the peer
 * record's token in `Authorization` (a person token, so the peer stamps the
 * person), trusting the record's `ca` and `servername` as every request to
 * that peer does, and pipes frames both ways. The web view only ever talks
 * to its own strut; the token and the peer's URL never reach the page.
 *
 * A clean close on either side is passed on as clean (the peer sends
 * `left` at once); anything else ends the other side abruptly, so the peer
 * keeps the member's place while the host comes back (`?client=` rides
 * along). The page's side is pinged here, since nothing else is watching
 * it. One hop.
 */
import { WebSocket } from "ws";
import type { Peer } from "./peers.js";
import { CHANNEL_PING_MS } from "./channels.js";

/** Frames kept for the peer while its socket opens. */
export const PEER_PIPE_QUEUE_MAX = 256;

/** The peer's channel socket for `app`, with the client id to come back as. */
export function peerChannelUrl(peer: Pick<Peer, "baseUrl">, app: { name: string; version: string }, client?: string): string {
  const url = new URL(`${peer.baseUrl}/channels`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("app", `${app.name}@${app.version}`);
  if (client) url.searchParams.set("client", client);
  return url.toString();
}

const clean = (code: number) => code === 1000 || code === 1001;
const errorFrame = (error: string) => JSON.stringify({ op: "error", error });

/** Pipe the page's socket to the peer's. `connect` is for tests. */
export function pipeChannelToPeer(
  local: WebSocket,
  peer: Peer,
  app: { name: string; version: string },
  opts: { client?: string; pingMs?: number; connect?: (url: string, options: ConstructorParameters<typeof WebSocket>[2]) => WebSocket } = {},
): void {
  const options = {
    headers: { authorization: `Bearer ${peer.token}` },
    ...(peer.ca ? { ca: peer.ca } : {}),
    ...(peer.servername ? { servername: peer.servername } : {}),
  };
  const url = peerChannelUrl(peer, app, opts.client);
  const remote = opts.connect ? opts.connect(url, options) : new WebSocket(url, options);
  const queue: string[] = [];
  let done = false;
  let alive = true;
  const ping = setInterval(() => {
    if (!alive) return local.terminate();
    alive = false;
    try {
      local.ping();
    } catch {
      // its close follows
    }
  }, opts.pingMs ?? CHANNEL_PING_MS);
  ping.unref?.();

  /** The peer is out of reach: the page hears why, and its host tries again. */
  const refuse = (why: string) => {
    if (done) return;
    done = true;
    clearInterval(ping);
    if (local.readyState === WebSocket.OPEN) {
      local.send(errorFrame(why));
      local.close(1011);
    }
  };

  local.on("pong", () => {
    alive = true;
  });
  local.on("message", (data) => {
    const text = String(data);
    if (remote.readyState === WebSocket.OPEN) return remote.send(text);
    if (queue.length >= PEER_PIPE_QUEUE_MAX) {
      if (local.readyState === WebSocket.OPEN) local.send(errorFrame(`the peer's channel socket is not open yet and ${PEER_PIPE_QUEUE_MAX} frames are waiting`));
      return;
    }
    queue.push(text);
  });
  local.on("close", (code) => {
    clearInterval(ping);
    done = true;
    if (remote.readyState === WebSocket.OPEN && clean(code)) remote.close(code);
    else remote.terminate();
  });
  local.on("error", () => undefined); // its close follows

  remote.on("open", () => {
    for (const text of queue.splice(0)) remote.send(text);
  });
  remote.on("message", (data) => {
    if (local.readyState === WebSocket.OPEN) local.send(String(data));
  });
  remote.on("unexpected-response", (req, res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      if (body.length < 2_000) body += chunk;
    });
    res.on("end", () => {
      let reason = body;
      try {
        reason = (JSON.parse(body) as { error?: string }).error ?? body;
      } catch {
        // as it came
      }
      refuse(`the peer refused the channel socket: ${res.statusCode}${reason ? ` ${reason}` : ""}`);
      req.destroy();
    });
  });
  remote.on("error", (err) => refuse(`the peer's channel socket: ${err.message}`));
  remote.on("close", (code) => {
    if (done) return;
    done = true;
    clearInterval(ping);
    if (local.readyState === WebSocket.OPEN) local.close(clean(code) ? code : 1011);
  });
}
