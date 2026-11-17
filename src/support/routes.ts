/**
 * Support's routes (plans/support-chat.md §3, §10 item 1): the staff's side
 * of the chat with workers. FULL SCOPE only, reads included — the
 * deployment key or an admin's session — like the task store's staff
 * routes; `strut/staff` reaches them through the `staff/support-*` steps.
 * Without a Sphinx daemon's message token every route answers 501
 * `not_available`. `:worker` is the worker's actor, one encoded segment.
 *
 * - `GET /support[?q=&filter=]` → `{ conversations }`: unread first, then
 *   the newest; `q` over names (the worker's Sphinx alias, their note),
 *   actors and text; `filter` one of `all` (the default), `open`, `mine`
 *   (open, taken by the asker), `unassigned` (open, taken by no one),
 *   `done`. Each `{ worker, pubkey, alias?, unread, last?, seenAt?,
 *   welcomedAt?, status, assigned? }`, `assigned` `me` or `other`
 * - `GET /support/unread` → `{ unread, conversations }`: messages from
 *   workers no one marked seen, and the conversations they are in (a host
 *   may show it in its navigation)
 * - `GET /support/settings` → `{ settings: { welcome, since?, savedAt?,
 *   savedBy?, payoutLines, photo?: { url, mediaType, savedAt, savedBy?,
 *   base64? } } }`
 * - `PUT /support/settings { welcome?, payoutLines? }` → `{ settings }`:
 *   the automatic welcome's text, `""` turns it off (§5); payout lines on
 *   or off (§6)
 * - `PUT /support/photo { base64, type }` → `{ settings }`: Support's
 *   picture, through the daemon, at most 1 MiB; `DELETE /support/photo`
 *   clears it
 * - `GET /support/:worker[?before=&limit=]` → `{ conversation, messages,
 *   more }`: the thread's newest 200 (`limit`, at most 500) before the
 *   message key `before`, oldest first; `404 no_conversation` for a worker
 *   who never added Support as a contact
 * - `PUT /support/:worker { status?, assignee? }` → `{ conversation }`:
 *   `status` `open` or `done` (a worker writing again reopens it);
 *   `assignee` `"me"` takes it, `null` lets it go
 * - `POST /support/:worker { text?, replyTo?, file? }` → `{ message }`:
 *   kept, then sent from "Support"; a failed send is `status: "failed"`
 *   with `error`. `file` is `{ base64, type, name }`, at most 2.5 MiB, kept
 *   by strut too; `text` is then its caption. `{ retry: <key> }` sends a
 *   failed one again under the same id
 * - `POST /support/:worker/delete { key }` → `{ message }`: one of
 *   Support's messages deleted for both sides
 * - `POST /support/:worker/seen` → `{ conversation }`: marked seen up to
 *   its newest message, for every admin
 * - `GET /support/:worker/files/:id[?offset=]` → `{ id, name?, mediaType,
 *   bytes, offset, base64, next? }`: a worker's file, by its message's
 *   Sphinx id, 3 MB of it from `offset` (a step's result is capped at 5 MB);
 *   `next` is the next piece's offset. `404 no_file` while it is being
 *   fetched, or when it was too large or deleted
 */
import type { Context, Hono } from "hono";
import type { SupportFilter } from "./store.js";
import { SupportError, type SendFile, type Support } from "./support.js";

export interface SupportRoutesDeps {
  isFull: (c: Context) => Promise<boolean>;
  /** Who sent a reply or saved the welcome: kept, never shown (ruling 4). */
  actorOf: (c: Context) => Promise<string | undefined>;
  support: Support;
}

export function supportRoutes(app: Hono<any>, deps: SupportRoutesDeps): void {
  const { support } = deps;
  const answer = async (c: Context, fn: () => Promise<object>) => {
    if (!(await deps.isFull(c))) return c.json({ error: "forbidden: Support is an admin's: the deployment key or an admin's session" }, 403);
    try {
      return c.json(await fn());
    } catch (err) {
      if (err instanceof SupportError) return c.json({ error: err.message, code: err.code }, err.status);
      throw err;
    }
  };
  const body = async (c: Context): Promise<Record<string, unknown>> => {
    const v = (await c.req.json().catch(() => undefined)) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new SupportError("bad_request", "the body is a JSON object");
    return v as Record<string, unknown>;
  };
  const worker = (c: Context) => c.req.param("worker") ?? "";
  const num = (c: Context, k: string): number | undefined => {
    const v = c.req.query(k);
    if (v === undefined || v === "") return undefined;
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n <= 0) throw new SupportError("bad_request", `${k} must be a whole number above 0`);
    return n;
  };

  app.get("/support", (c) =>
    answer(c, async () => {
      const filter = c.req.query("filter") || undefined;
      const me = await deps.actorOf(c);
      return support.conversations(c.req.query("q") ?? "", { ...(filter ? { filter: filter as SupportFilter } : {}), ...(me ? { me } : {}) });
    }),
  );
  app.get("/support/unread", (c) => answer(c, () => support.unread()));
  app.get("/support/settings", (c) => answer(c, () => support.settings()));
  app.put("/support/settings", (c) =>
    answer(c, async () => {
      const b = await body(c);
      const extra = Object.keys(b).filter((k) => k !== "welcome" && k !== "payoutLines");
      if (extra.length) throw new SupportError("bad_request", `the settings are welcome and payoutLines; not ${extra.join(", ")}`);
      return support.saveSettings(b, await deps.actorOf(c));
    }),
  );
  app.put("/support/photo", (c) => answer(c, async () => support.savePhoto(await body(c), await deps.actorOf(c))));
  app.delete("/support/photo", (c) => answer(c, async () => support.savePhoto(null, await deps.actorOf(c))));
  app.get("/support/:worker", (c) =>
    answer(c, async () => {
      const me = await deps.actorOf(c);
      const before = num(c, "before");
      const limit = num(c, "limit");
      return support.thread(worker(c), { ...(before !== undefined ? { before } : {}), ...(limit !== undefined ? { limit } : {}), ...(me ? { me } : {}) });
    }),
  );
  app.put("/support/:worker", (c) => answer(c, async () => support.update(worker(c), await body(c), await deps.actorOf(c))));
  app.post("/support/:worker", (c) =>
    answer(c, async () => {
      const b = await body(c);
      if (b["retry"] !== undefined) {
        if (typeof b["retry"] !== "number" || !Number.isSafeInteger(b["retry"])) throw new SupportError("bad_request", "retry is a message's key");
        return support.send(worker(c), { retry: b["retry"] }, await deps.actorOf(c));
      }
      if (b["replyTo"] !== undefined && (typeof b["replyTo"] !== "string" || !b["replyTo"])) throw new SupportError("bad_request", "replyTo is the Sphinx id of the message quoted");
      return support.send(
        worker(c),
        { text: b["text"] as string, ...(b["replyTo"] ? { replyTo: b["replyTo"] as string } : {}), ...(b["file"] !== undefined ? { file: b["file"] as SendFile } : {}) },
        await deps.actorOf(c),
      );
    }),
  );
  app.post("/support/:worker/delete", (c) =>
    answer(c, async () => {
      const key = (await body(c))["key"];
      if (typeof key !== "number" || !Number.isSafeInteger(key)) throw new SupportError("bad_request", "key is the message's key");
      return support.remove(worker(c), key);
    }),
  );
  app.post("/support/:worker/seen", (c) => answer(c, async () => support.seen(worker(c), await deps.actorOf(c))));
  app.get("/support/:worker/files/:id", (c) =>
    answer(c, () => {
      const offset = c.req.query("offset");
      return support.file(worker(c), c.req.param("id") ?? "", offset === undefined || offset === "" ? 0 : Number(offset));
    }),
  );
}
