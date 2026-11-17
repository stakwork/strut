/**
 * Support's routes (plans/support-chat.md §3, §10 item 1): the staff's side
 * of the chat with workers. FULL SCOPE only, reads included — the
 * deployment key or an admin's session — like the task store's staff
 * routes; `strut/staff` reaches them through the `staff/support-*` steps.
 * Without a Sphinx daemon's message token every route answers 501
 * `not_available`. `:worker` is the worker's actor, one encoded segment.
 *
 * - `GET /support[?q=]` → `{ conversations }`: unread first, then the
 *   newest; `q` over names (the worker's Sphinx alias, their note), actors
 *   and text. Each `{ worker, pubkey, alias?, unread, last?, seenAt?,
 *   welcomedAt? }`
 * - `GET /support/unread` → `{ unread, conversations }`: messages from
 *   workers no one marked seen, and the conversations they are in (a host
 *   may show it in its navigation)
 * - `GET /support/settings` → `{ settings: { welcome, since?, savedAt?,
 *   savedBy? } }`
 * - `PUT /support/settings { welcome }` → `{ settings }`: the automatic
 *   welcome's text; `""` turns it off (§5)
 * - `GET /support/:worker[?before=&limit=]` → `{ conversation, messages,
 *   more }`: the thread's newest 200 (`limit`, at most 500) before the
 *   message key `before`, oldest first; `404 no_conversation` for a worker
 *   who never added Support as a contact
 * - `POST /support/:worker { text, replyTo? }` → `{ message }`: kept, then
 *   sent from "Support"; a failed send is `status: "failed"` with `error`.
 *   `{ retry: <key> }` sends a failed one again under the same id
 * - `POST /support/:worker/seen` → `{ conversation }`: marked seen up to
 *   its newest message, for every admin
 * - `GET /support/:worker/files/:id` → `{ id, name?, mediaType, bytes,
 *   base64 }`: a worker's file, by its message's Sphinx id; `404 no_file`
 *   while it is being fetched, or when it was too large or deleted
 */
import type { Context, Hono } from "hono";
import { SupportError, type Support } from "./support.js";

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

  app.get("/support", (c) => answer(c, () => support.conversations(c.req.query("q") ?? "")));
  app.get("/support/unread", (c) => answer(c, () => support.unread()));
  app.get("/support/settings", (c) => answer(c, () => support.settings()));
  app.put("/support/settings", (c) =>
    answer(c, async () => {
      const b = await body(c);
      const extra = Object.keys(b).filter((k) => k !== "welcome");
      if (extra.length) throw new SupportError("bad_request", `the settings are welcome; not ${extra.join(", ")}`);
      return support.saveSettings({ welcome: b["welcome"] as string }, await deps.actorOf(c));
    }),
  );
  app.get("/support/:worker", (c) =>
    answer(c, () => {
      const before = num(c, "before");
      const limit = num(c, "limit");
      return support.thread(worker(c), { ...(before !== undefined ? { before } : {}), ...(limit !== undefined ? { limit } : {}) });
    }),
  );
  app.post("/support/:worker", (c) =>
    answer(c, async () => {
      const b = await body(c);
      if (b["retry"] !== undefined) {
        if (typeof b["retry"] !== "number" || !Number.isSafeInteger(b["retry"])) throw new SupportError("bad_request", "retry is a message's key");
        return support.send(worker(c), { retry: b["retry"] }, await deps.actorOf(c));
      }
      if (b["replyTo"] !== undefined && (typeof b["replyTo"] !== "string" || !b["replyTo"])) throw new SupportError("bad_request", "replyTo is the Sphinx id of the message quoted");
      return support.send(worker(c), { text: b["text"] as string, ...(b["replyTo"] ? { replyTo: b["replyTo"] as string } : {}) }, await deps.actorOf(c));
    }),
  );
  app.post("/support/:worker/seen", (c) => answer(c, async () => support.seen(worker(c), await deps.actorOf(c))));
  app.get("/support/:worker/files/:id", (c) => answer(c, () => support.file(worker(c), c.req.param("id") ?? "")));
}
