/**
 * `GET /apps/look/stream`: a look that streams, over a WebSocket (stadeum
 * plans/call-canvas.md §6.2). createStrut admits the upgrade through its own
 * gate, as the person (`upgrade`, as it admits `/rooms` and `/channels`);
 * this drives the socket it admitted. The page is the browser service's
 * (`BrowserService.streamApp`): an app opened as `app/look` opens it, kept
 * open while the socket is.
 *
 * Server → client:
 *   <binary>                   — one JPEG frame, 1280×720, sent when the page paints (≤ 5 a second)
 *   {"type":"error", error}    — text, why the stream could not open or ended; then a 1011 close
 * Nothing is read from the client. Closing the socket closes the page.
 */
import type { WebSocket } from "ws";
import type { AppStream, BrowserService } from "./service.js";

export const LOOK_STREAM_PATH = "/apps/look/stream";

/** What may wait unsent on the socket before a frame is dropped: a client
 *  that stopped reading. The next paint sends another. */
export const LOOK_STREAM_BUFFER_MAX = 4 * 1024 * 1024;

/** The app a stream opens, and as whom. */
export interface LookTarget {
  name: string;
  version: string;
  actor?: string;
  link?: Record<string, string>;
}

/** Drive one admitted socket. Exported for tests (any `ws`-shaped socket works). */
export function driveLookStream(ws: WebSocket, browser: Pick<BrowserService, "streamApp">, look: LookTarget): void {
  let stream: AppStream | undefined;
  let gone = false;
  const fail = (why: string) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: "error", error: why }));
    ws.close(1011, closeReason(why));
  };
  ws.on("error", () => undefined); // a close follows
  ws.on("close", () => {
    gone = true;
    void stream?.close();
  });
  const frame = (jpeg: Buffer) => {
    if (ws.readyState === ws.OPEN && ws.bufferedAmount <= LOOK_STREAM_BUFFER_MAX) ws.send(jpeg, { binary: true });
  };
  browser.streamApp(look, frame).then(
    (s) => {
      if (gone) return void s.close();
      stream = s;
      void s.ended.then(fail);
    },
    (err: unknown) => fail(err instanceof Error ? err.message : String(err)),
  );
}

/** A close frame's reason is at most 123 bytes of UTF-8. */
export function closeReason(why: string): string {
  let out = why;
  while (Buffer.byteLength(out) > 123) out = out.slice(0, -1);
  return out;
}
