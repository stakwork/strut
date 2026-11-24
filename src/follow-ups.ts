/**
 * A step says "look again later" (plans/job-follow-ups.md): strut runs a
 * step again and again, as the person of the run that asked, until its
 * output says `settled: true`, then sends the job ONE turn carrying that
 * answer. For work that goes on after the step returns — a pod's bake takes
 * ten minutes — so the job's agent ends its turn instead of sleeping in a
 * shell, and the person can talk to the job meanwhile.
 *
 * - **Asked for** in a job's turn: `ctx.services.jobs.followUp` → `ask`,
 *   kept on the job's record (`JobRecord.followUps`, marked in
 *   `jobs/.follow-ups/`), so it outlives the process. The ask names a run
 *   of the job, never a person: strut reads who ran it and which
 *   conversation its end woke from its `run.start`.
 * - **Looked at** on strut's own timer, armed while one is pending: each
 *   follow-up every `everyMs`, outside any run (`deps.look`). A look that
 *   throws, or takes over five minutes, is tried again.
 * - **Settled** (or past its `until`): the turn's prompt is kept on the
 *   record (`ready`), and the turn goes as soon as no run of the job is in
 *   flight — the job's own workflow (`turnOf`), as that person, naming the
 *   conversation, `wake: true`, so src/wake.ts relays its end as it does
 *   for a pull request's fix (src/pr-checks.ts).
 * - **Once:** taken off the record before the launch, put back when the
 *   launch is refused. Ready ones of one job go as one turn.
 */

import { editFollowUps, jobRoot, jobsFollowingUp, readJobRecord, turnOf, type FollowUp, type FollowUpAsk, type JobRecord } from "./jobs.js";
import type { Reporter } from "./pr-checks.js";
import { idProblem } from "./session-store.js";

/** How often the timer wakes while a follow-up is pending. */
export const FOLLOW_UP_TICK_MS = 15_000;
/** The turn's last line: for the agent, and for whoever reads the thread. */
export const FOLLOW_UP_SENT = "Strut sent this: a step of an earlier turn asked it to follow up. The person didn't type it.";
/** An answer as the prompt carries it, at most. */
const ANSWER_MAX = 6_000;
/** A look that takes longer has failed: the ticks wait for each look. */
const LOOK_MAX_MS = 5 * 60_000;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

/** The look's output says it has settled. */
export function settled(answer: unknown): boolean {
  return !!answer && typeof answer === "object" && (answer as { settled?: unknown }).settled === true;
}

const show = (v: unknown): string => {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > ANSWER_MAX ? `${s.slice(0, ANSWER_MAX)}…` : s;
};
const lookOf = (f: FollowUp) => `${f.look.type} ${show(f.look.input)}`;

/** The turn's words for a look that settled. */
export function settledPrompt(f: FollowUp, answer: unknown): string {
  return `${lookOf(f)} settled. Its answer:\n${show(answer)}`;
}

/** The turn's words for a look that didn't settle in time. */
export function timedOutPrompt(f: FollowUp, last?: { answer?: unknown; error?: string }): string {
  const minutes = Math.round((Date.parse(f.until) - Date.parse(f.at)) / 60_000);
  const head = `${lookOf(f)} didn't settle in ${minutes} minutes, and strut stopped looking.`;
  if (last?.error !== undefined) return `${head} Its last look failed: ${last.error}`;
  if (last && "answer" in last) return `${head} Its last answer:\n${show(last.answer)}`;
  return head;
}

export interface FollowUpsDeps {
  dataDir: string;
  /** Who ran one of the job's runs, and where its end went: its `run.start`. */
  person(rec: JobRecord, runId: string): Promise<Reporter | undefined>;
  /** Run the look once, as `f.by`'s person, outside any run: its output. */
  look(job: string, f: FollowUp): Promise<unknown>;
  /** Whether a run of the job is in flight now. */
  busy(job: string): boolean;
  /** Launch the job's next turn: its run id. Refused (`job_busy:`) while a
   *  run of the job is in flight. */
  launch(o: { job: string; workflow: string; prompt: string; conversation?: string; actor?: string; principal?: string; model?: string }): Promise<string>;
  now?(): number;
  warn?(message: string): void;
}

export interface FollowUps {
  /** What `jobs.followUp` runs. */
  ask(a: FollowUpAsk): Promise<{ id: string; until: string }>;
  /** One look at every pending follow-up, and the turns that are due. A
   *  call while one runs gets that one. The timer's; tests call it. */
  tick(): Promise<void>;
  /** Arm the timer: at boot, for what a dead process left. */
  start(): void;
  /** Stop the timer, and wait for a look in flight. */
  stop(): Promise<void>;
}

export function createFollowUps(deps: FollowUpsDeps): FollowUps {
  const now = () => deps.now?.() ?? Date.now();
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  /** Each follow-up's last look, by `<job>\n<id>\n<at>`: when, and what it
   *  said. Memory: a restart looks again at once. */
  const last = new Map<string, { at: number; answer?: unknown; error?: string }>();
  const key = (job: string, f: Pick<FollowUp, "id" | "at">) => `${job}\n${f.id}\n${f.at}`;
  /** Follow-ups whose refused launch was warned about: once each, not every tick. */
  const warned = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;

  function arm(delay = FOLLOW_UP_TICK_MS): void {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void tick();
    }, delay);
    timer.unref?.();
  }

  async function ask(a: FollowUpAsk): Promise<{ id: string; until: string }> {
    const problem = idProblem(a.job);
    if (problem) throw new Error(`follow_up: job id "${a.job}" ${problem}`);
    if (!a.look?.type) throw new Error("follow_up: name the step to look with (look.type)");
    const root = jobRoot(deps.dataDir, a.job);
    const rec = await readJobRecord(root);
    if (!rec?.runs?.some((r) => r.runId === a.runId)) throw new Error(`follow_up: run ${a.runId} is not a run of job "${a.job}"`);
    const { trial, ...who } = (await deps.person(rec, a.runId)) ?? {};
    // A trial's job is closed once its run is judged (src/trials.ts).
    if (trial) throw new Error("follow_up: a trial's run asks for no follow-up: nothing a trial starts outlives it");
    const t = now();
    const f: FollowUp = {
      id: a.id ?? a.look.type,
      look: { type: a.look.type, input: a.look.input ?? {} },
      everyMs: clamp(a.everySeconds ?? 60, 30, 3600) * 1000,
      at: new Date(t).toISOString(),
      until: new Date(t + clamp(a.limitMinutes ?? 60, 1, 1440) * 60_000).toISOString(),
      by: { runId: a.runId, ...who },
    };
    await editFollowUps(root, (list) => {
      const i = list.findIndex((x) => x.id === f.id);
      if (i >= 0) list.splice(i, 1);
      list.push(f);
    });
    // The first look comes one interval from now: the work just started.
    last.set(key(a.job, f), { at: t });
    arm();
    return { id: f.id, until: f.until };
  }

  /** Look at the job's follow-ups that are due, then send what is ready.
   *  How many are still pending. */
  async function passJob(rec: JobRecord): Promise<number> {
    const job = rec.name;
    const root = jobRoot(deps.dataDir, job);
    const ready = new Map<string, string>();
    for (const f of rec.followUps ?? []) {
      if (f.ready) continue;
      const k = key(job, f);
      const seen = last.get(k);
      if (now() >= Date.parse(f.until)) {
        ready.set(k, timedOutPrompt(f, seen));
        continue;
      }
      if (seen && now() - seen.at < f.everyMs) continue;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const late = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`the look took over ${LOOK_MAX_MS / 60_000} minutes`)), LOOK_MAX_MS);
          timer.unref?.();
        });
        const answer = await Promise.race([deps.look(job, f), late]);
        last.set(k, { at: now(), answer });
        if (settled(answer)) ready.set(k, settledPrompt(f, answer));
      } catch (err) {
        last.set(k, { at: now(), error: err instanceof Error ? err.message : String(err) });
      } finally {
        clearTimeout(timer);
      }
    }
    // Kept on the record, so a turn that waits for the job outlives the process.
    if (ready.size) {
      await editFollowUps(root, (list) => {
        for (const f of list) if (!f.ready && ready.has(key(job, f))) f.ready = ready.get(key(job, f))!;
      });
    }
    if (deps.busy(job)) return (await readJobRecord(root))?.followUps?.length ?? 0;

    const taken =
      (await editFollowUps(root, (list) => {
        const out = list.filter((f) => f.ready);
        list.splice(0, list.length, ...list.filter((f) => !f.ready));
        return out;
      })) ?? [];
    if (taken.length) {
      const lead = taken[0]!.by;
      try {
        await deps.launch({
          job,
          workflow: turnOf(rec.runs)?.workflow ?? "job",
          prompt: [...taken.map((f) => f.ready!), FOLLOW_UP_SENT].join("\n\n"),
          ...(lead.conversation ? { conversation: lead.conversation } : {}),
          ...(lead.actor ? { actor: lead.actor } : {}),
          ...(lead.principal ? { principal: lead.principal } : {}),
          ...(lead.model ? { model: lead.model } : {}),
        });
        for (const f of taken) last.delete(key(job, f));
      } catch (err) {
        // Refused (a run took the job first): put back, so the next tick sends it.
        await editFollowUps(root, (list) => {
          for (const f of taken) if (!list.some((x) => x.id === f.id)) list.push(f);
        });
        const message = err instanceof Error ? err.message : String(err);
        const k = key(job, taken[0]!);
        if (!message.startsWith("job_busy:") && !warned.has(k)) {
          warned.add(k);
          warn(`[follow-ups] job ${job}: the turn was not launched: ${message}`);
        }
      }
    }
    return (await readJobRecord(root))?.followUps?.length ?? 0;
  }

  function tick(): Promise<void> {
    if (running) return running;
    running = (async () => {
      let pending = 0;
      for await (const rec of jobsFollowingUp(deps.dataDir)) {
        try {
          pending += await passJob(rec);
        } catch (err) {
          pending++;
          warn(`[follow-ups] job ${rec.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (pending) arm();
    })()
      .catch((err) => warn(`[follow-ups] ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        running = undefined;
      });
    return running;
  }

  return {
    ask,
    tick,
    start() {
      stopped = false;
      arm(0);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await running;
    },
  };
}
