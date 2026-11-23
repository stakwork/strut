/**
 * SENDING THROUGH SPHINX (plans/people-and-hosts.md §4): the `sphinx`
 * capability, Support's three calls to the treasury daemon over its MESSAGE
 * token (`messageToken` on a `sphinx` wallet, src/payments/settings.ts) —
 * `POST /dm`, `POST /dm/:id/delete`, `PUT` / `DELETE /dm/photo`
 * (specs/LIGHTNING.md, "Support's DMs"). Strut no longer READS with the
 * token: the daemon hands each DM to `support/receive` itself (§5).
 *
 * Like the payer it is never on the shared bag. It is on the bag of a
 * first-party page's call shown to an admin, and of a run such an app
 * launched (`support-outbox`), and the withdrawals' `paid` hook sends a
 * payout's line through it (createStrut). Never on an agent's tools or a
 * host's call. With no daemon or no message token every call refuses
 * `not_available` (an NWC wallet has no Support, plans/support-chat.md
 * ruling 11).
 *
 * A refusal throws an Error whose message starts with the daemon's code
 * (`not_a_contact: …`, `too_long: …`, `not_deletable: …`).
 */

/** The daemon as Support reaches it: its URL and the message token. */
export interface SphinxDaemon {
  url: string;
  token: string;
}

/** A send's state as the daemon tells it: `sending` until the LSP answers
 *  (or while a publish that failed partway is settled), `failed` with
 *  nothing sent, `sent` otherwise. */
export type SphinxSendStatus = "sending" | "sent" | "failed";

/** One DM from Support. `id` is strut's own (1 to 128 printable characters):
 *  the daemon sends one id once, and a FAILED one again under it (Retry). */
export interface SphinxDm {
  id: string;
  /** A contact's pubkey (66 hex), or anyone's Sphinx address, where the
   *  daemon meets someone new first (3 sats). Never a tribe. */
  to: string;
  text?: string;
  /** The Sphinx id of the message quoted. */
  reply?: string;
  /** A file, its bytes as base64 (the daemon keeps none of them). */
  file?: { data: string; type: string; name?: string };
}

export interface SphinxCapability {
  /** `POST /dm`: the send as the daemon's feed shows it — its Sphinx id once
   *  it has one, its status, why it failed, and its `seq` there. */
  send(dm: SphinxDm): Promise<{ id?: string; status: SphinxSendStatus; error?: string; seq?: number }>;
  /** `POST /dm/:id/delete`: one of Support's own messages, for both sides. */
  delete(id: string): Promise<void>;
  /** `PUT /dm/photo { data, type }` → the URL Peel loads, sent as `img` on
   *  every message; `null` clears it (`DELETE /dm/photo`). */
  setPhoto(photo: { data: string; type: string } | null): Promise<{ url: string | null }>;
}

/** How long one call may take. A send waits about 10 s for the LSP's word. */
const CALL_TIMEOUT_MS = 10_000;
const SEND_TIMEOUT_MS = 30_000;

/** A send's status as the daemon says it (`pending` is the LSP's PENDING, still going). */
export function sendStatusOf(v: unknown): SphinxSendStatus {
  if (v === "pending" || v === "sending") return "sending";
  if (v === "failed") return "failed";
  return "sent";
}

/** The capability over `daemon()`: the daemon and its message token now, or
 *  null for none. */
export function sphinxCapability(deps: { daemon: () => Promise<SphinxDaemon | null>; fetch?: typeof fetch }): SphinxCapability {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const call = async (method: string, path: string, body?: unknown, timeout = CALL_TIMEOUT_MS): Promise<Record<string, unknown>> => {
    const d = await deps.daemon();
    if (!d) throw new Error("not_available: sending as Support needs this server's wallet to be a Sphinx daemon with its message token (LIGHTNING_DAEMON_MESSAGE_TOKEN)");
    let res: Response;
    try {
      res = await fetchImpl(`${d.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${d.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      throw new Error(`daemon_unreachable: the daemon did not answer: ${err instanceof Error ? err.message : String(err)}`);
    }
    const b = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = typeof b["code"] === "string" ? b["code"] : `http_${res.status}`;
      const error = typeof b["error"] === "string" ? b["error"].replace(/^[a-z_]+: /, "") : `HTTP ${res.status}`;
      throw new Error(`${code}: ${error}`);
    }
    return b;
  };
  return Object.freeze({
    async send(dm: SphinxDm) {
      const b = await call(
        "POST",
        "/dm",
        { id: dm.id, to: dm.to, ...(dm.text ? { text: dm.text } : {}), ...(dm.reply ? { reply: dm.reply } : {}), ...(dm.file ? { file: dm.file } : {}) },
        SEND_TIMEOUT_MS,
      );
      return {
        ...(typeof b["id"] === "string" && b["id"] ? { id: b["id"] } : {}),
        status: sendStatusOf(b["status"]),
        ...(typeof b["error"] === "string" && b["error"] ? { error: b["error"] } : {}),
        ...(typeof b["seq"] === "number" && Number.isSafeInteger(b["seq"]) ? { seq: b["seq"] } : {}),
      };
    },
    async delete(id: string) {
      await call("POST", `/dm/${encodeURIComponent(id)}/delete`);
    },
    async setPhoto(photo: { data: string; type: string } | null) {
      if (photo === null) {
        await call("DELETE", "/dm/photo");
        return { url: null };
      }
      const b = await call("PUT", "/dm/photo", { data: photo.data, type: photo.type }, SEND_TIMEOUT_MS);
      if (typeof b["url"] !== "string" || !b["url"]) throw new Error("daemon_error: the daemon answered no url for the picture");
      return { url: b["url"] };
    },
  });
}
