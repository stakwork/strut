import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { CONVERSATION_LIST_MAX, CONVERSATION_TURNS_MAX, type ConversationTurn, type ConversationsCapability } from "../../../conversations.js";
import { dataDirOf, readState } from "./_state.js";

/** A turn still in flight: the dream waits for it, and for the turns after it. */
const LIVE = new Set(["running", "paused", "stale"]);
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)} […${s.length - max} more chars]` : s);

export interface DreamTurn {
  session: string;
  turn: number;
  at: string;
  status: string;
  run: string;
  /** The person's words. */
  said: string;
  /** What the assistant answered. */
  reply: string;
}

/**
 * The turns of the person's conversations with their assistant that no dream
 * has read yet, oldest first (plans/dream.md). Deterministic: the model is
 * handed the transcript, it does not page for it.
 */
export default defineStep({
  type: "dream/turns",
  effect: "read",
  description:
    "The turns of the person's conversations with the assistant that no dream has read yet, oldest first: { count, turns: [{ session, turn, at, status, run, said, reply }], " +
    "cursor, more, text }. `text` is the same turns as a transcript. `cursor` is what dream/done takes once they are dealt with; `more` says turns were left for the next run. " +
    "A turn the person stopped has status `cancelled`. A wake (strut's own turn after a job) is skipped. The first dream reads the last `days` only.",
  input: z.object({
    limit: z.number().int().positive().max(200).optional().default(60).describe("Most turns to return (default 60)."),
    days: z.number().int().positive().max(365).optional().default(14).describe("How far back the FIRST dream reads (default 14 days). Later ones read from where the last left off."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const conversations = (ctx.services as { conversations?: ConversationsCapability } | undefined)?.conversations;
    if (!conversations) throw new Error("dream/turns needs the conversation index (ctx.services.conversations). The standard strut server provides it.");
    const state = await readState(dataDirOf(ctx, "dream/turns"));
    const floor = state ? 0 : Date.now() - cfg.days * 86_400_000;
    // The dream is strut's own job over the person's conversations: it reads them all, as the run logs can be.
    const viewer = { all: true } as const;
    const pool: DreamTurn[] = [];
    const seen: Record<string, number> = {};
    const { conversations: list } = await conversations.list({ limit: CONVERSATION_LIST_MAX }, viewer);
    for (const c of list) {
      const mark = state?.marks[c.id] ?? -1;
      if (c.turns - 1 <= mark || Date.parse(c.updatedAt) < floor) continue;
      const fresh: ConversationTurn[] = [];
      let before: number | undefined;
      for (;;) {
        const view = await conversations.get({ session: c.id, limit: CONVERSATION_TURNS_MAX, ...(before !== undefined ? { before } : {}) }, viewer);
        if (!view) break;
        fresh.push(...view.turns.filter((t) => t.turn > mark));
        if (view.next === undefined || view.turns.every((t) => t.turn <= mark) || view.turns.some((t) => Date.parse(t.at) < floor)) break;
        before = view.next;
      }
      fresh.sort((a, b) => a.turn - b.turn);
      for (const t of fresh) {
        if (LIVE.has(t.status)) break;
        // Read, whether or not it is kept: the mark moves past wakes and turns older than the first dream's window.
        seen[c.id] = t.turn;
        if (t.wake || !t.prompt?.trim() || Date.parse(t.at) < floor) continue;
        pool.push({ session: c.id, turn: t.turn, at: t.at, status: t.status, run: t.runId, said: cut(t.prompt.trim(), 2000), reply: cut((t.text ?? t.ask ?? t.error ?? "").trim(), 1500) });
      }
    }
    pool.sort((a, b) => a.at.localeCompare(b.at));
    const turns = pool.slice(0, cfg.limit);
    const more = pool.length > turns.length;
    // A conversation cut by the limit is marked at its last turn returned; the rest wait.
    const cursor: Record<string, number> = {};
    if (more) for (const t of turns) cursor[t.session] = Math.max(cursor[t.session] ?? -1, t.turn);
    else Object.assign(cursor, seen);
    const text = turns
      .map((t) => `[session ${t.session} · turn ${t.turn} · ${t.at} · ${t.status}]\nPERSON: ${t.said}\nASSISTANT: ${t.reply || "(no reply)"}`)
      .join("\n\n");
    return { count: turns.length, turns, cursor, ...(more ? { more: true } : {}), text };
  },
});
