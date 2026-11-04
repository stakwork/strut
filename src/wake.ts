/**
 * One wake (plans/jamie-app.md §1): when a job turn ends, strut runs one
 * more turn of the conversation that asked for it, so the conversation's
 * agent hears the job's reply — and its question — before the person's next
 * message. Every host's: Hive's web chat, a tribe, a call, Peel's DM.
 *
 * The trigger is createStrut's: a run of a job-shaped workflow
 * (`JOB_WORKFLOWS`) ends naming a conversation on this strut — the
 * `startedBy.session` job/start recorded, or the `conversation` a host's
 * launch named — or a host hands in an end that happened on another strut
 * (`POST /conversations/wake`). `jobEnded` answers what strut will do, for
 * the job's own `run.end` (`wake: "launched" | "capped" | "none"`):
 *
 * - **none**: no conversation, the wake is off, the host did not ask for it
 *   (`wake: true` on the launch of the person's turn that started the job,
 *   recorded as `wakeAsked`, or on its own launch of the job — opt-in, so a
 *   host that still wakes on its own never gets two; the door is a host
 *   asking), the conversation's workflow
 *   has no `params.wake`, or the conversation is a relay (a turn of it came
 *   from another strut or an app: `origin` peer or app on its `run.start` —
 *   a person token's turns are a peer's; the head of the chain wakes itself).
 * - **capped**: `max` wake turns since the last person's turn (the session's
 *   turn lines, `wake: true`) — the host shows the job's words as they are.
 * - **launched**: queued; a turn follows. While the session is busy (held, or
 *   a run launched on it still in flight) the end waits, and every end that
 *   waited goes as ONE turn.
 *
 * Durable: an end is written to `<dataDir>/wakes/<session>.json` before
 * anything launches, and leaves it when its turn ended; `reconcile` (at boot)
 * launches what a dead process left. Once per job run, keyed by its run id
 * (`<peer>/<runId>` for another strut's).
 *
 * The turn is one run of the conversation's workflow on its session, `input:
 * { prompt, session, context }`: the prompt is the workflow's own
 * `params.wake` filled with the ends (`wakePrompt`), the context the latest
 * person's turn's `where` and `timeZone` with the time now (`wakeContext`),
 * on that turn's `params.model`, as the job run's actor and principal, with
 * the callbacks of the latest person's turn that has them. The run is marked
 * `wake` (`run.start`, `ctx.wake`, and so its session turn line).
 */

import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Flow, RunEvent, StartedBy, WakeMark } from "./core.js";
import { JOB_WORKFLOWS, withLock } from "./jobs.js";
import { peerIdProblem } from "./peers.js";
import { encodeId, idProblem, type SessionStore, type SessionTurn } from "./session-store.js";
import type { RunStore } from "./store.js";

export const WAKE_SILENT = "[silent]";
/** The job's reply as the prompt carries it, at most. */
export const WAKE_REPLY_MAX = 6_000;
/** Wake turns since the person's last turn, at most. */
export const WAKE_MAX = 4;
/** Job runs remembered per session, so an end heard twice wakes once. */
const SEEN_MAX = 500;
/** How long a busy session is waited on when no run of ours will end it. */
const RETRY_MS = 2_000;

export type WakeOutcome = "launched" | "capped" | "none";

/** A job turn that ended, as the wake keeps it: everything the prompt needs,
 *  so a pending wake outlives the process. */
export interface WakeEnd {
  /** The job run, and its workflow (`job`, `builder`). */
  runId: string;
  workflow: string;
  job: string;
  title?: string;
  status: string;
  /** The job's reply and its question (`replyOf`). */
  text?: string;
  ask?: string;
  error?: string;
  /** What it produced: titles and kinds. */
  artifacts: Array<{ title: string; kind?: string }>;
  /** The strut it ran on, when not this one (the door). */
  source?: string;
  /** The turn of this conversation that started it (job/start). */
  startedBy?: StartedBy;
  /** The host's own launch of this job asked for the wake (`wake: true`
   *  beside `conversation`). */
  asked?: true;
  /** Who asked for the job: the wake runs as them. */
  actor?: string;
  principal?: string;
}

/** What a session's wakes are, on disk. */
export interface WakeFile {
  session: string;
  /** The conversation's workflow, the one the turn runs. */
  workflow?: string;
  /** Ends waiting for the session, oldest first. */
  queued: WakeEnd[];
  /** The wake turn in flight, and the ends it carries. */
  turn?: { workflow: string; runId: string; ends: WakeEnd[] };
  /** The job runs already woken on or capped, newest last. */
  seen: string[];
}

export function wakeFilePath(dataDir: string, session: string): string {
  return join(dataDir, "wakes", `${encodeId(session)}.json`);
}

// ── pure ───────────────────────────────────────────────────────────────────

/** The job's reply and question in its output: `output.object ?? output`,
 *  `text`, and `ask` as a string or `{ message }`. */
export function replyOf(output: unknown): { text?: string; ask?: string } {
  const o = output && typeof output === "object" ? (output as Record<string, unknown>) : undefined;
  const obj = o?.["object"] && typeof o["object"] === "object" ? (o["object"] as Record<string, unknown>) : o;
  const text = typeof obj?.["text"] === "string" ? obj["text"] : typeof output === "string" ? output : undefined;
  const a = obj?.["ask"];
  const ask = typeof a === "string" ? a : a && typeof a === "object" ? (a as Record<string, unknown>)["message"] : undefined;
  return {
    ...(text?.trim() ? { text: text.trim() } : {}),
    ...(typeof ask === "string" && ask.trim() ? { ask: ask.trim() } : {}),
  };
}

/** Wake turns since the person's last turn. */
export function trailingWakes(turns: readonly SessionTurn[]): number {
  let n = 0;
  for (let i = turns.length - 1; i >= 0 && turns[i]!.wake; i--) n++;
  return n;
}

const cap = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
/** One line: no control characters, runs of space as one. */
const line = (s: string, max = 200) => cap(s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim(), max);
/** The job's words cannot close the markers they sit between. */
const unmarked = (s: string) => s.replaceAll(">>>", "> > >").replaceAll("<<<", "< < <");

function outcomeOf(e: WakeEnd): string {
  if (e.status === "success") return e.ask ? "finished its turn and STOPPED FOR A DECISION (its question is below)" : "finished its turn";
  if (e.status === "cancelled") return "been stopped";
  return "failed (its reply says why)";
}

/** One job's values for the template's section. */
function jobValues(e: WakeEnd): Record<string, string> {
  const job = line(e.job);
  const produced = e.artifacts.slice(0, 10).map((a) => (a.kind ? `${line(a.title)} (${line(a.kind, 40)})` : line(a.title)));
  const reply = e.text ?? (e.error ? `(no reply; the error: ${e.error})` : "(no reply text)");
  return {
    job,
    title: line(e.title ?? e.job),
    on: e.source ? ` on @${e.source}` : "",
    started: e.source
      ? `which @${e.source}'s assistant started for this conversation`
      : e.startedBy
        ? "which you started"
        : "which was started from this conversation",
    outcome: outcomeOf(e),
    produced: produced.length ? `What it produced, which the person can open: ${produced.join(", ")}.` : "Nothing is attached to it.",
    reply: unmarked(cap(reply, WAKE_REPLY_MAX)),
    question: e.ask ? `Its question for the person: ${unmarked(cap(e.ask, 1_000))}\n` : "",
    continue: e.source ? `hand the go-ahead to @${e.source}'s assistant, naming job \`${job}\`` : `call job/continue with job \`${job}\``,
  };
}

const fill = (s: string, values: Record<string, string>) =>
  s.replace(/\{([a-z]+)\}/g, (whole, k: string) => values[k] ?? whole);

const SECTION = /\{each\}([\s\S]*?)\{\/each\}/;

/**
 * The wake prompt: `template` (the workflow's `params.wake`) with the part
 * between `{each}` and `{/each}` once per end, its placeholders that end's —
 * `{job}`, `{title}`, `{on}`, `{started}`, `{outcome}`, `{produced}`,
 * `{reply}` (capped, the markers it sits between unbreakable), `{question}`,
 * `{continue}` — and `{silent}` everywhere. Each piece is filled once, so a
 * job's words are never read as placeholders. Without a section, the whole
 * template once per end.
 */
export function wakePrompt(template: string, ends: readonly WakeEnd[]): string {
  const silent = { silent: WAKE_SILENT };
  const m = SECTION.exec(template);
  if (!m) return ends.map((e) => fill(template, { ...jobValues(e), ...silent })).join("\n\n");
  return (
    fill(template.slice(0, m.index), silent) +
    ends.map((e) => fill(m[1]!, { ...jobValues(e), ...silent })).join("") +
    fill(template.slice(m.index + m[0].length), silent)
  );
}

const validZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** The head of a wake's prompt: the time now in `timeZone` (else UTC), as
 *  hosts write it ("Thu 16 Oct 14:02, Europe/London. "). */
export function wakeLine(now: Date, timeZone?: string): string {
  const tz = timeZone && validZone(timeZone) ? timeZone : undefined;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz ?? "UTC",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return `${parts["weekday"]} ${parts["day"]} ${parts["month"]} ${parts["hour"]}:${parts["minute"]}, ${tz ?? "UTC"}. `;
}

/** A wake's `context`: the time now, and the `where` and `timeZone` of the
 *  person's latest turn's context. */
export function wakeContext(prev: unknown, now: Date): { line: string; where?: string; timeZone?: string } {
  const c = prev && typeof prev === "object" ? (prev as Record<string, unknown>) : {};
  const timeZone = typeof c["timeZone"] === "string" && validZone(c["timeZone"]) ? c["timeZone"] : undefined;
  const where = typeof c["where"] === "string" && c["where"].trim() ? c["where"].trim() : undefined;
  return { line: wakeLine(now, timeZone), ...(where ? { where } : {}), ...(timeZone ? { timeZone } : {}) };
}

/** The mark a wake turn carries for its ends. */
export function wakeMarkOf(ends: readonly WakeEnd[]): WakeMark {
  const one = (e: WakeEnd) => ({ job: e.job, runId: e.runId, ...(e.source ? { peer: e.source } : {}) });
  const [first, ...rest] = ends;
  return { ...one(first!), ...(rest.length ? { also: rest.map(one) } : {}) };
}

/** `POST /conversations/wake`'s body: `{ session, source, end }`, `end` a
 *  job turn's `run.end` as a peer's room delivered it. */
export function parseWakeDoor(body: unknown): { session: string; end: WakeEnd } | { error: string } {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const problem = idProblem(b["session"]);
  if (problem) return { error: `session ${problem}` };
  const sourceProblem = peerIdProblem(b["source"]);
  if (sourceProblem) return { error: `source ${sourceProblem}` };
  const end = b["end"] && typeof b["end"] === "object" ? (b["end"] as Record<string, unknown>) : undefined;
  if (!end) return { error: "end: the job's run.end, as it came" };
  const str = (k: string) => (typeof end[k] === "string" && end[k] ? (end[k] as string) : undefined);
  const workflow = str("workflow");
  if (!workflow || !(JOB_WORKFLOWS as readonly string[]).includes(workflow)) {
    return { error: `end.workflow must be a job's (${JOB_WORKFLOWS.join(", ")}): an orchestrator's run.end is a turn's own reply` };
  }
  const runId = str("runId");
  const job = str("job");
  const status = str("status");
  if (!runId || !job || !status) return { error: "end needs runId, job and status" };
  const error = end["error"] && typeof end["error"] === "object" ? (end["error"] as Record<string, unknown>)["message"] : undefined;
  return {
    session: b["session"] as string,
    end: {
      runId,
      workflow,
      job,
      status,
      ...(str("title") ? { title: str("title")! } : {}),
      ...replyOf(end["output"]),
      ...(typeof error === "string" ? { error } : {}),
      artifacts: artifactsOf(end["artifacts"]),
      source: b["source"] as string,
    },
  };
}

/** Titles and kinds of a resolved artifact list. */
export function artifactsOf(list: unknown): WakeEnd["artifacts"] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((a) => {
    const r = a && typeof a === "object" ? (a as Record<string, unknown>) : {};
    return typeof r["title"] === "string" && r["title"] ? [{ title: r["title"], ...(typeof r["kind"] === "string" ? { kind: r["kind"] } : {}) }] : [];
  });
}

// ── the queue ──────────────────────────────────────────────────────────────

export interface WakeLaunch {
  input: { prompt: string; session: string; context: Record<string, unknown> };
  params?: { model: string };
  actor?: string;
  principal?: string;
  /** Where the turn's `run.end` and its jobs' updates go: a URL or
   *  `room:<actor>`, as the run store keeps them. */
  callback?: string;
  jobCallback?: string;
  wake: WakeMark;
}

export interface WakeDeps {
  dataDir: string;
  enabled: boolean;
  max: number;
  store: Pick<RunStore, "getRunEvents" | "getRunSummary" | "getRunCallback" | "getRunJobCallback">;
  sessions: Pick<SessionStore, "load">;
  /** Who holds a session (`SessionsCapability.holder`). */
  holder(session: string): unknown;
  /** The runs in flight in this process that were launched on `session`. */
  liveOn(session: string): string[];
  isLive(workflow: string, runId: string): boolean;
  getWorkflow(name: string): Promise<Flow>;
  /** Launch the turn detached; its run id. */
  launch(flow: Flow, run: WakeLaunch): string;
  now?: () => Date;
}

export interface Wakes {
  readonly enabled: boolean;
  /** A job turn ended naming `session`: what strut does about it. */
  jobEnded(session: string, end: WakeEnd): Promise<WakeOutcome>;
  /** A wake turn's run ended. `error` is its error's message, if it failed. */
  turnEnded(session: string, runId: string, error?: string): Promise<void>;
  /** A run launched on `session` ended: a waiting wake may go. */
  kick(session: string): void;
  /** Launch what a dead process left waiting (boot). */
  reconcile(): Promise<void>;
}

export function createWakes(deps: WakeDeps): Wakes {
  const now = deps.now ?? (() => new Date());
  /** Sessions whose file holds something queued or in flight. */
  const pending = new Set<string>();
  const retrying = new Set<string>();

  const read = async (session: string): Promise<WakeFile> => {
    try {
      const f = JSON.parse(await readFile(wakeFilePath(deps.dataDir, session), "utf-8")) as WakeFile;
      return { ...f, session, queued: f.queued ?? [], seen: f.seen ?? [] };
    } catch {
      return { session, queued: [], seen: [] };
    }
  };
  const write = async (f: WakeFile) => {
    const file = wakeFilePath(deps.dataDir, f.session);
    await mkdir(join(deps.dataDir, "wakes"), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(f) + "\n", "utf-8");
    await rename(`${file}.tmp`, file);
    if (f.queued.length || f.turn) pending.add(f.session);
    else pending.delete(f.session);
  };
  const startOf = async (workflow: string, runId: string): Promise<RunEvent | undefined> =>
    (await deps.store.getRunEvents(workflow, runId).catch(() => [])).find((e) => e.type === "run.start");
  /** A turn that came from another strut or an app: the conversation is a
   *  relay, or a namespace the raw session id does not name. */
  const relay = (start: RunEvent | undefined) => start?.origin === "peer" || start?.origin === "app";

  /** The session's turns, and the person's latest turn: its `run.start`
   *  (context, model, origin) and the callbacks of the newest person's turn
   *  that has them — `launching` (the job's starting turn) last, for a turn
   *  that has not committed. */
  const anchorOf = async (session: string, launching?: StartedBy) => {
    const turns = (await deps.sessions.load(session).catch(() => null))?.turns ?? [];
    const runs = turns
      .filter((t) => !t.wake)
      .reverse()
      .slice(0, 20)
      .map((t) => ({ workflow: t.workflow, runId: t.runId }));
    if (launching) runs.push(launching);
    let start: RunEvent | undefined;
    let callback: string | null = null;
    let jobCallback: string | null = null;
    for (const r of runs) {
      start ??= await startOf(r.workflow, r.runId);
      if (!callback) {
        callback = await deps.store.getRunCallback(r.workflow, r.runId).catch(() => null);
        if (callback) jobCallback = await deps.store.getRunJobCallback(r.workflow, r.runId).catch(() => null);
      }
      if (start && callback) break;
    }
    return { turns, start, callback, jobCallback };
  };

  const drain = async (session: string): Promise<void> => {
    let retry = false;
    await withLock(`wake:${session}`, async () => {
      const f = await read(session);
      let changed = false;
      if (f.turn) {
        if (deps.isLive(f.turn.workflow, f.turn.runId)) return;
        // Not live and still here: a dead process's. Done when its run
        // finished; else its ends go again.
        const summary = await deps.store.getRunSummary(f.turn.workflow, f.turn.runId).catch(() => null);
        if (!summary || summary.error?.message.includes("session_busy:")) f.queued = [...f.turn.ends, ...f.queued];
        delete f.turn;
        changed = true;
      }
      if (!f.queued.length) return changed ? write(f) : undefined;
      if (deps.holder(session) || deps.liveOn(session).length) {
        retry = !deps.liveOn(session).length;
        if (changed) return write(f);
        // A file read at boot: the run that frees the session kicks it.
        pending.add(session);
        return;
      }
      const workflow = f.workflow ?? "orchestrator";
      const flow = await deps.getWorkflow(workflow).catch(() => null);
      const template = flow?.params?.["wake"];
      if (!flow || typeof template !== "string") {
        console.warn(`[wake] ${session}: "${workflow}" has no params.wake — ${f.queued.length} job end(s) dropped`);
        f.queued = [];
        return write(f);
      }
      const ends = f.queued;
      const first = ends[0]!;
      const local = first.source ? undefined : first.startedBy;
      const anchor = await anchorOf(session, local);
      const launching = local ? await startOf(local.workflow, local.runId) : undefined;
      const model = (launching?.params?.["model"] ?? anchor.start?.params?.["model"]) as unknown;
      const ctx = (anchor.start?.input as Record<string, unknown> | undefined)?.["context"];
      // Who asked for the job; an end from another strut names nobody here,
      // so the person's latest turn's.
      const who: { actor?: string; principal?: string } = first.actor ? first : (anchor.start ?? {});
      const runId = deps.launch(flow, {
        input: { prompt: wakePrompt(template, ends), session, context: wakeContext(ctx, now()) },
        ...(typeof model === "string" && model ? { params: { model } } : {}),
        ...(who.actor ? { actor: who.actor } : {}),
        ...(who.principal ? { principal: who.principal } : {}),
        ...(anchor.callback ? { callback: anchor.callback } : {}),
        ...(anchor.jobCallback ? { jobCallback: anchor.jobCallback } : {}),
        wake: wakeMarkOf(ends),
      });
      f.turn = { workflow: flow.name, runId, ends };
      f.queued = [];
      return write(f);
    });
    if (retry && !retrying.has(session)) {
      retrying.add(session);
      setTimeout(() => {
        retrying.delete(session);
        void drain(session).catch((err) => console.error(`[wake] ${session}:`, err));
      }, RETRY_MS).unref?.();
    }
  };
  const go = (session: string) => void drain(session).catch((err) => console.error(`[wake] ${session}:`, err));

  return {
    enabled: deps.enabled,
    async jobEnded(session, end) {
      if (!deps.enabled || idProblem(session)) return "none";
      const local = end.source ? undefined : end.startedBy;
      const anchor = await anchorOf(session, local);
      const launching = local ? await startOf(local.workflow, local.runId) : undefined;
      if (relay(launching) || relay(anchor.start)) return "none";
      // Opt-in (plans/jamie-app.md §7): only where the host asked on the
      // launch it made (`POST …/run { wake: true }`) — the person's turn
      // that started the job (`wakeAsked` on its run.start; for a job a wake
      // turn started, the person's latest turn), or the job's own launch for
      // one the host started itself (`asked`). A host that still wakes on
      // its own never gets two. An end handed in through the door is a host
      // asking.
      if (!end.source) {
        const person = end.startedBy ? (launching && !launching.wake ? launching : anchor.start) : undefined;
        if (!end.asked && !person?.wakeAsked) return "none";
      }
      const workflow = local?.workflow ?? anchor.turns.at(-1)?.workflow ?? "orchestrator";
      const flow = await deps.getWorkflow(workflow).catch(() => null);
      if (!flow || typeof flow.params?.["wake"] !== "string") return "none";
      const key = end.source ? `${end.source}/${end.runId}` : end.runId;
      const outcome = await withLock(`wake:${session}`, async (): Promise<WakeOutcome> => {
        const f = await read(session);
        if (f.seen.includes(key)) return "none";
        let outcome: WakeOutcome = "launched";
        // A new turn is needed only when nothing waits: an end that finds
        // others queued goes with them.
        if (!f.queued.length) {
          // A person's turn in flight starts the count over.
          const person = deps.liveOn(session).some((id) => id !== f.turn?.runId);
          const inFlight = f.turn && !anchor.turns.some((t) => t.runId === f.turn!.runId) ? 1 : 0;
          if (!person && trailingWakes(anchor.turns) + inFlight >= deps.max) outcome = "capped";
        }
        f.seen = [...f.seen, key].slice(-SEEN_MAX);
        if (outcome === "launched") {
          f.queued.push(end);
          f.workflow = flow.name;
        }
        await write(f);
        return outcome;
      });
      if (outcome === "launched") go(session);
      return outcome;
    },
    async turnEnded(session, runId, error) {
      await withLock(`wake:${session}`, async () => {
        const f = await read(session);
        if (f.turn?.runId !== runId) return;
        // The person got there first: the ends wait for the next free moment.
        if (error?.includes("session_busy:")) f.queued = [...f.turn.ends, ...f.queued];
        delete f.turn;
        await write(f);
      });
    },
    kick(session) {
      if (pending.has(session)) go(session);
    },
    async reconcile() {
      let names: string[];
      try {
        names = (await readdir(join(deps.dataDir, "wakes"))).filter((n) => n.endsWith(".json"));
      } catch {
        return;
      }
      for (const name of names) {
        let session: string;
        try {
          session = decodeURIComponent(name.slice(0, -".json".length));
        } catch {
          continue;
        }
        if (idProblem(session)) continue;
        await drain(session).catch((err) => console.error(`[wake] ${session}:`, err));
      }
    },
  };
}
