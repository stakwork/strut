import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { CONVERSATION_TURNS_MAX, type ConversationTurn, type ConversationsCapability } from "../../../conversations.js";
import type { KnowledgeCapability } from "../../../knowledge.js";
import { dataDirOf, readState } from "./_state.js";

/** A turn still in flight: the dream waits for it, and for the turns after it. */
const LIVE = new Set(["running", "paused", "stale"]);
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)} […${s.length - max} more chars]` : s);

/** A run, named as `knowledge/add-evidence` takes it, with the Concept pages
 *  it opened: null when its log does not say. */
export interface DreamRun {
  workflow: string;
  run: string;
  opened: string[] | null;
}

export interface DreamTurn extends DreamRun {
  session: string;
  turn: number;
  at: string;
  status: string;
  /** The person's words. Absent on a WAKE: strut's own turn after a job
   *  ended, kept so the reply a person then corrects is in the transcript. */
  said?: string;
  /** What the assistant answered. */
  reply: string;
  /** Who said it, when the turn names them. */
  said_by?: string;
  /** A wake: the job run(s) it reports on. */
  jobs?: Array<{ job: string } & Partial<DreamRun>>;
}

const openedLine = (label: string, opened: string[] | null | undefined) =>
  `${label}: ${opened === null || opened === undefined ? "not known" : opened.length ? opened.join(", ") : "no Concept page"}`;

/** The turns as a transcript: each header names the run a remark can be
 *  recorded against. */
export function renderTurns(turns: readonly DreamTurn[]): string {
  return turns
    .map((t) =>
      [
        `[session ${t.session} · turn ${t.turn} · ${t.at} · ${t.status} · run ${t.workflow} ${t.run}${t.said === undefined ? " · after a job ended" : ""}${t.said_by ? ` · said by ${t.said_by}` : ""}]`,
        openedLine("OPENED", t.opened),
        ...(t.jobs ?? []).map((j) => openedLine(`JOB ${j.job}${j.run ? ` (run ${j.workflow ?? "?"} ${j.run})` : ""} OPENED`, j.opened)),
        ...(t.said === undefined ? [] : [`PERSON: ${t.said}`]),
        `ASSISTANT: ${t.reply || "(no reply)"}`,
      ].join("\n"),
    )
    .join("\n\n");
}

/**
 * The turns of the conversations with the assistant that no dream has read
 * yet, oldest first. Deterministic: the model is handed the transcript, it
 * does not go looking for it.
 */
export default defineStep({
  type: "dream/turns",
  effect: "read",
  // It reads EVERY person's conversations: the dream's alone, never a
  // step the meta surface runs or an app's page calls (src/sealed.ts).
  sealed: true,
  description:
    "The turns of the conversations with the assistant that no dream has read yet, oldest first: { count, turns: [{ session, turn, at, status, workflow, run, opened, said, reply, said_by?, jobs? }], cursor, more, text }. " +
    "`workflow` + `run` name the turn's own run and `opened` the Concept pages it opened (null: its log does not say). A turn with no `said` is a WAKE, the assistant reporting on a job that ended: " +
    "it is kept so that what a person then corrects is in the transcript, with `jobs`, the job run(s) it reports on and the pages each opened. " +
    "`text` is the same turns as a transcript. `cursor` is what dream/done takes once they are dealt with; `more` says turns were left for the next run. " +
    "A turn the person stopped has status `cancelled`. The first dream reads the last `days` only. It refuses when the tree's root Concept does not exist.",
  input: z.object({
    tree: z.string().optional().default("Personal").describe("The tree this dream tends (its root Concept's name): each tree keeps its own marks."),
    limit: z.number().int().positive().max(200).optional().default(60).describe("Most turns to return (default 60)."),
    days: z.number().int().positive().max(365).optional().default(14).describe("How far back the FIRST dream reads (default 14 days). Later ones read from where the last left off."),
  }),
  output: z.any(),
  async run(cfg, ctx: StepContext) {
    const services = ctx?.services as { conversations?: ConversationsCapability; knowledge?: KnowledgeCapability } | undefined;
    const conversations = services?.conversations;
    if (!conversations) throw new Error("dream/turns needs the conversation index (ctx.services.conversations). The standard strut server provides it.");
    const knowledge = services?.knowledge;
    if (!knowledge) throw new Error("dream/turns needs the claims layer (ctx.services.knowledge): a graph-backed workspace with claims on");
    // A dream with no tree to tend stops here: nothing read, nothing sent to a model, nothing marked.
    if (!(await knowledge.page(cfg.tree))) throw new Error(`dream/turns: there is no Concept "${cfg.tree}" to tend: the dream's \`root\` names the tree's root Concept`);

    const state = await readState(dataDirOf(ctx, "dream/turns"), cfg.tree);
    const floor = state ? 0 : Date.now() - cfg.days * 86_400_000;
    // The dream is strut's own job over the conversations: it reads them all, as the run logs can be.
    const viewer = { all: true } as const;
    const pool: Array<{ c: string; t: ConversationTurn }> = [];
    const seen: Record<string, number> = {};
    for (const c of await conversations.all()) {
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
        // Read, whether or not it is kept: the mark moves past turns older than the first dream's window.
        seen[c.id] = t.turn;
        if ((!t.wake && !t.prompt?.trim()) || Date.parse(t.at) < floor) continue;
        pool.push({ c: c.id, t });
      }
    }
    pool.sort((a, b) => a.t.at.localeCompare(b.t.at));
    const kept = pool.slice(0, cfg.limit);
    const more = pool.length > kept.length;
    // A conversation cut by the limit is marked at its last turn returned; the rest wait.
    const cursor: Record<string, number> = {};
    if (more) for (const { c, t } of kept) cursor[c] = Math.max(cursor[c] ?? -1, t.turn);
    else Object.assign(cursor, seen);

    // Which pages each run opened, off its log: what tells "never opened" from "opened and not followed".
    const opened = (workflow: string, run: string) => knowledge.opened(workflow, run).catch(() => null);
    const turns: DreamTurn[] = [];
    for (const { c, t } of kept) {
      const wake = t.wake && typeof t.wake === "object" ? [{ job: t.wake.job, runId: t.wake.runId }, ...(t.wake.also ?? [])] : [];
      const jobs: NonNullable<DreamTurn["jobs"]> = [];
      for (const j of wake) {
        // The job run's workflow is on what it delivered; without it the run cannot be named.
        const workflow = t.delivered?.find((d) => d.runId === j.runId)?.workflow;
        jobs.push({ job: j.job, ...(workflow ? { workflow, run: j.runId, opened: await opened(workflow, j.runId) } : {}) });
      }
      turns.push({
        session: c,
        turn: t.turn,
        at: t.at,
        status: t.status,
        workflow: t.workflow,
        run: t.runId,
        opened: await opened(t.workflow, t.runId),
        ...(t.wake ? {} : { said: cut(t.prompt!.trim(), 2000) }),
        reply: cut((t.text ?? t.ask ?? t.error ?? "").trim(), 1500),
        ...(t.by ? { said_by: t.by } : {}),
        ...(jobs.length ? { jobs } : {}),
      });
    }
    return { count: turns.length, turns, cursor, ...(more ? { more: true } : {}), text: renderTurns(turns) };
  },
});
