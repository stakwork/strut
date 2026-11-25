import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { dmOf, keepRecord, OUTBOX_WORKFLOW, RECEIVE_MAX_RECORDS, SUPPORT_CHANNEL, supportDb, tx, welcomeOf, type Dm } from "./_shared.js";

/**
 * `support/receive` (plans/people-and-hosts.md §5): the Sphinx daemon hands
 * Support its DM records, through `strut/workers`'s `hosts:` (§3) — one
 * contact's at a time, the one `x-strut-account` names, in the feed's order.
 * Each is kept in one transaction: the conversation, the message (a new one,
 * or a change to one: a send's status, a deletion), a worker's file's bytes.
 * A record already kept changes nothing, so a retry is safe; a record that
 * cannot be kept is skipped and named, never the call, so one bad record
 * never holds the daemon's feed. The sender's name comes on the call's
 * `x-strut-account-name` (§1), never from here.
 *
 * Then it tells the app's channel — a contact's key exchange also says
 * `invites`, since the daemon marked the invite used before pushing it, so
 * the Workers page shows it used at once — and when a welcome is due starts
 * `support-outbox` (one run at a time) — this call cannot send: a host's bag
 * has no `sphinx`.
 */
export default defineStep({
  type: "support/receive",
  effect: "write",
  description:
    "The Sphinx daemon's call (strut/workers's hosts:): keep these DM records of the contact x-strut-account names, in order, in one transaction. " +
    "Each is a record of the daemon's DM feed ({ seq, id, clientId?, time, fromMe, peer: { pubkey, alias? }, kind, text, replyTo, sats, deleted, mediaType, fileName, status?, error? }), a worker's file with its bytes as file: { data, name? } (or fileError). " +
    "A record kept before changes nothing. Answers { kept, skipped: [{ seq?, id?, error }] }.",
  input: z.object({
    records: z.array(z.record(z.string(), z.any())).min(1).max(RECEIVE_MAX_RECORDS).describe("The contact's records, oldest first."),
  }),
  output: z.object({ kept: z.number(), skipped: z.array(z.object({ seq: z.number().optional(), id: z.string().optional(), error: z.string() })) }),
  async run(cfg, ctx?: StepContext<StrutCapabilities>) {
    const account = /^sphinx:(0[23][0-9a-f]{64})$/.exec(ctx?.host?.account ?? "")?.[1];
    if (!ctx?.host || !account) throw new Error("support/receive is the Sphinx daemon's call, as the contact the records are about (x-strut-account: sphinx:<pubkey>), through strut/workers's hosts:");
    const db = await supportDb(ctx, "support/receive");
    const app = ctx.app!;
    const at = Date.now();
    const skipped: Array<{ seq?: number; id?: string; error: string }> = [];
    const dms: Dm[] = [];
    for (const raw of cfg.records) {
      const d = dmOf(raw, at);
      const named = { ...(typeof raw["seq"] === "number" ? { seq: raw["seq"] } : {}), ...(typeof raw["id"] === "string" ? { id: raw["id"] } : {}) };
      if (typeof d === "string") skipped.push({ ...named, error: d });
      else if (d.pubkey !== account) skipped.push({ ...named, error: `the record is about ${d.pubkey}, and this call is ${account}'s: one contact's records a call` });
      else dms.push(d);
    }
    let kept = 0;
    let due = false;
    let joined = false;
    // One transaction; each record its own savepoint, so one that cannot be
    // kept is skipped, never the others.
    tx(db, () => {
      const welcome = welcomeOf(db);
      for (const d of dms) {
        db.exec("SAVEPOINT record");
        try {
          if (keepRecord(db, d, welcome)) due = true;
          db.exec("RELEASE record");
          kept++;
          if (d.kind === "contact") joined = true;
        } catch (err) {
          db.exec("ROLLBACK TO record");
          db.exec("RELEASE record");
          skipped.push({ ...(d.seq !== undefined ? { seq: d.seq } : {}), ...(d.id ? { id: d.id } : {}), error: err instanceof Error ? err.message : String(err) });
        }
      }
    });
    if (kept) {
      // The page reads again: a state, so a burst replaces one message. A
      // new contact is a worker who signed up with an invite: read those too.
      try {
        const said = [{ key: "changed", data: { at } }, ...(joined ? [{ key: "invites", data: { at } }] : [])];
        ctx.services?.channels?.send(app, { ...(ctx.actor ? { actor: ctx.actor } : {}), code: "support/receive" }, SUPPORT_CHANNEL, said);
      } catch {
        // Over the channel's rate: the page reads every 30 s besides.
      }
    }
    // A welcome due — this one, or one an earlier run left — goes with the
    // outbox's run; one in flight is the run (its `key`).
    if (due || db.prepare("SELECT 1 FROM conversations WHERE welcome_due = 1 AND welcomed_at IS NULL LIMIT 1").get()) {
      const runs = (ctx.services as { runs?: { launch(q: { workflow: string; key: string }, by: { app: typeof app }): Promise<unknown> } } | undefined)?.runs;
      await runs?.launch({ workflow: OUTBOX_WORKFLOW, key: OUTBOX_WORKFLOW }, { app }).catch((err: unknown) => console.warn(`[support] ${OUTBOX_WORKFLOW} did not start: ${err instanceof Error ? err.message : String(err)}`));
    }
    return { kept, skipped };
  },
});
