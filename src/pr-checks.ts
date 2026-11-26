/**
 * A job's pull request fails its checks: strut sends the job a turn to fix
 * it (plans/pr-checks.md), as Hive does for the jobs it hosts (hive
 * `src/services/strut-jobs/check-failures.ts`).
 *
 * What a job delivered is already its artifacts: a pull request is one of
 * `kind: "pull_request"`, with the run that last reported it, and that run's
 * `run.start` says who ran it and which conversation its end woke. A pass
 * looks at the jobs used in the last `PR_WATCH_MS`, newest first (the
 * `.used` index), reads each such pull request as that run's person (their
 * token for github.com), and once every check has finished and one failed,
 * launches one turn of the job — the PR card's Fix, made by the server —
 * naming the conversation, so its end wakes it (src/wake.ts).
 *
 * - **Once per failure:** a failure is its failed checks, done at the last
 *   one's `finishedAt`. It is already in hand once a turn of the job has
 *   started since then with the fix's words: strut's own (`JobRecord.prFixes`,
 *   taken before the launch, given back when the launch is refused) or a
 *   person's Fix on the card, the same words. A re-run that fails, or a
 *   pushed fix that fails, is a new failure (peel#614, 2026-11-26: the one
 *   wake repeated a Fix click, then the re-run's real failure got none).
 * - **At most `PR_FIXES_MAX` a pull request:** a fix that keeps failing
 *   stops there, and the next is a person's click on the card.
 * - **One turn per job:** two failing pull requests are named in one turn.
 * - **Never beside a live turn:** a job with a run in flight is passed
 *   over, and the next pass is the retry.
 * - Merged, closed, still running or all passed: nothing.
 *
 * Strut's half is what acts as a person. When to look is a caller's: the
 * `job/pr-checks` step, which strut-github's schedule runs (later its
 * webhook too, with the pull request's URL). The step takes no person and no
 * text, so a caller can only make strut look sooner.
 */

import { editPrFixes, jobRoot, jobsByUse, turnOf, type JobRecord, type PrFix } from "./jobs.js";
import type { PrStatus, PrStatusApi } from "./steps/lib/github/pr-status.js";

/** How long after its last use a job's pull requests are still read. */
export const PR_WATCH_MS = 7 * 24 * 60 * 60 * 1000;

/** Automatic fixes one pull request gets, at most. */
export const PR_FIXES_MAX = 3;

/** The turn's second line: for the agent, and for whoever reads the thread. */
export const STRUT_SENT = "Strut sent this when the checks finished. The person didn't type it.";

const PR_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/;

export interface PrRef {
  /** `https://github.com/<owner>/<repo>/pull/<n>`. */
  url: string;
  owner: string;
  repo: string;
  number: number;
}

/** The pull request an artifact is: `kind: "pull_request"` with a GitHub
 *  link — its `url`, or a `url` in its content — else null. The Jamie
 *  card's `prOf`. */
export function prOf(a: { kind?: string; url?: string; content?: unknown }): PrRef | null {
  if (a.kind !== "pull_request") return null;
  let content = a.content;
  if (typeof content === "string") {
    try {
      content = JSON.parse(content);
    } catch {
      // a bare link, or words
    }
  }
  const inContent = (content as { url?: unknown } | null | undefined)?.url;
  const url = a.url ?? (typeof inContent === "string" ? inContent : typeof a.content === "string" ? a.content : "");
  const m = PR_URL.exec(url.trim());
  if (!m) return null;
  const [, owner, repo, n] = m;
  return { url: `https://github.com/${owner}/${repo}/pull/${n}`, owner: owner!, repo: repo!, number: Number(n) };
}

export type PrOutcome = "over" | "running" | "clean" | "failed";

/** What a pull request's state asks for: nothing once it is merged or
 *  closed, while a check runs, or when none failed. */
export function outcomeOf(s: Pick<PrStatus, "state" | "counts">): PrOutcome {
  if (s.state === "merged" || s.state === "closed") return "over";
  if (s.counts.running > 0) return "running";
  return s.counts.failed > 0 ? "failed" : "clean";
}

/** When the failure was done (ms): the last of its failed checks to finish.
 *  Undefined when one has no time. */
export function failedAt(s: Pick<PrStatus, "checks">): number | undefined {
  let at: number | undefined;
  for (const c of s.checks) {
    if (c.status !== "failed") continue;
    const t = Date.parse(c.finishedAt ?? "");
    if (Number.isNaN(t)) return undefined;
    at = Math.max(at ?? 0, t);
  }
  return at;
}

/** How many automatic fixes a mark counts: one from before `count`. */
const fixesIn = (fix: PrFix | undefined) => (fix ? (fix.count ?? 1) : 0);

/** Strut's own fix was for this failure: sent since it was done (or it
 *  has no time, as a mark from before failures did). */
const fixedSince = (fix: PrFix | undefined, since: number | undefined) => !!fix && (since === undefined || Date.parse(fix.at) >= since);

/** The fix turn's words for one pull request: the Jamie card's `fixPrompt`. */
export function checksFixPrompt(s: Pick<PrStatus, "repo" | "number" | "head" | "checks">): string {
  const failed = s.checks.filter((c) => c.status === "failed").map((c) => c.name);
  return `The checks on ${s.repo}#${s.number} failed: ${failed.join(", ")}. Find out why, fix it, and push the fix to ${s.head} — the same pull request.`;
}

/** Who ran a turn and where its end went: its `run.start`. */
export interface Reporter {
  /** The conversation its end woke: `startedBy.session`, else the launch's `conversation`. */
  conversation?: string;
  actor?: string;
  principal?: string;
  /** Its `params.model`. */
  model?: string;
  /** Its `input.prompt`: what the turn was told. */
  prompt?: string;
  /** It is a trial's run (`RunTrial`): nothing it starts outlives it. */
  trial?: true;
}

export interface PrChecksDeps {
  dataDir: string;
  /** The job's current deliverables, each with the run that last reported
   *  it (`JobView.artifacts`). */
  artifacts(job: string): Promise<ReadonlyArray<{ kind?: string; url?: string; content?: unknown; runId: string }>>;
  /** The `run.start` of one of the job's runs. */
  reporter(rec: JobRecord, runId: string): Promise<Reporter | undefined>;
  /** The person's token for a repository (`secrets.git`, bound to them). */
  token(principal: string | undefined, repoUrl: string): Promise<string | undefined>;
  /** Read a pull request with a token. Default: `readPullRequest` over Octokit. */
  read?(token: string, pr: PrRef): Promise<PrStatus>;
  /** Whether a run of the job is in flight now. */
  busy(job: string): boolean;
  /** Launch the job's next turn, naming the conversation; its run id. */
  launch(o: { job: string; workflow: string; prompt: string; conversation: string; actor?: string; principal?: string; model?: string }): Promise<string>;
  now?(): number;
  warn?(message: string): void;
}

/** How many jobs a pass read a pull request of, and how many it sent a turn. */
export interface PrChecksResult {
  jobs: number;
  sent: number;
}

/** `ctx.services.prChecks`: what the `job/pr-checks` step runs. */
export interface PrChecksCapability {
  /** One pass over the recent jobs; with `url`, that pull request alone. A
   *  call while a pass runs gets that pass's result and starts nothing. */
  check(o?: { url?: string }): Promise<PrChecksResult>;
}

async function readWithOctokit(token: string, pr: PrRef): Promise<PrStatus> {
  const [{ Octokit }, { readPullRequest }] = await Promise.all([import("@octokit/rest"), import("./steps/lib/github/pr-status.js")]);
  return readPullRequest(new Octokit({ auth: token }) as unknown as PrStatusApi, pr.owner, pr.repo, pr.number);
}

export function createPrChecks(deps: PrChecksDeps): PrChecksCapability & { checkJob(rec: JobRecord, only?: string): Promise<{ read: boolean; sent: boolean }> } {
  const now = () => deps.now?.() ?? Date.now();
  const read = deps.read ?? readWithOctokit;
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  // A pull request no token reads is warned about once per process, not on every pass.
  const warned = new Set<string>();
  const warnOnce = (key: string, message: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    warn(message);
  };

  async function checkJob(rec: JobRecord, only?: string): Promise<{ read: boolean; sent: boolean }> {
    const job = rec.name;
    const fixed = rec.prFixes ?? {};
    const prs: Array<{ pr: PrRef; runId: string }> = [];
    for (const a of await deps.artifacts(job)) {
      const pr = prOf(a);
      if (!pr || fixesIn(fixed[pr.url]) >= PR_FIXES_MAX || (only && pr.url !== only) || prs.some((p) => p.pr.url === pr.url)) continue;
      prs.push({ pr, runId: a.runId });
    }

    /** A turn of the job started since the failure was done, told to fix
     *  it: strut's own, or a person's Fix on the card (the same words). */
    const inHand = async (status: PrStatus, since: number | undefined): Promise<boolean> => {
      if (fixedSince(fixed[status.url], since)) return true;
      if (since === undefined) return false;
      const words = checksFixPrompt(status);
      for (const r of rec.runs ?? []) {
        if (r.parentRunId || !(Date.parse(r.at) >= since)) continue;
        if ((await deps.reporter(rec, r.runId))?.prompt?.includes(words)) return true;
      }
      return false;
    };

    let didRead = false;
    const failed: Array<{ status: PrStatus; url: string; since: number | undefined; who: Reporter & { conversation: string } }> = [];
    for (const { pr, runId } of prs) {
      const who = await deps.reporter(rec, runId);
      // Nowhere for the reply to land: the person fixes it from the card.
      if (!who?.conversation) continue;
      const token = await deps.token(who.principal, `https://github.com/${pr.owner}/${pr.repo}`);
      if (!token) {
        warnOnce(`${job} ${pr.url}`, `[pr-checks] job ${job}: no GitHub token reads ${pr.url} for ${who.principal ?? "nobody"}; its checks are not read`);
        continue;
      }
      let status: PrStatus;
      try {
        status = await read(token, pr);
      } catch (err) {
        warnOnce(`${job} ${pr.url}`, `[pr-checks] job ${job}: ${pr.url} not read: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      didRead = true;
      if (outcomeOf(status) !== "failed") continue;
      const since = failedAt(status);
      if (!(await inHand(status, since))) failed.push({ status, url: pr.url, since, who: { ...who, conversation: who.conversation } });
    }
    if (!failed.length || deps.busy(job)) return { read: didRead, sent: false };

    // The fix, taken under the record's lock before the launch: a pass and
    // a webhook's call beside it send one turn.
    const root = jobRoot(deps.dataDir, job);
    const at = new Date(now()).toISOString();
    const before = new Map<string, PrFix | undefined>();
    const taken =
      (await editPrFixes(root, (fixes) =>
        failed.filter((f) => {
          const fix = fixes[f.url];
          if (fixesIn(fix) >= PR_FIXES_MAX || fixedSince(fix, f.since)) return false;
          before.set(f.url, fix);
          fixes[f.url] = { at, count: fixesIn(fix) + 1 };
          return true;
        }),
      )) ?? [];
    if (!taken.length) return { read: didRead, sent: false };

    const lead = taken[0]!.who;
    const prompt = [...taken.map((t) => checksFixPrompt(t.status)), STRUT_SENT].join("\n");
    try {
      const runId = await deps.launch({
        job,
        workflow: turnOf(rec.runs)?.workflow ?? "job",
        prompt,
        conversation: lead.conversation,
        ...(lead.actor ? { actor: lead.actor } : {}),
        ...(lead.principal ? { principal: lead.principal } : {}),
        ...(lead.model ? { model: lead.model } : {}),
      });
      await editPrFixes(root, (fixes) => {
        for (const t of taken) if (fixes[t.url]) fixes[t.url] = { ...fixes[t.url]!, runId };
      });
      return { read: didRead, sent: true };
    } catch (err) {
      // Refused (strut could not launch it): given back, so the next pass tries again.
      await editPrFixes(root, (fixes) => {
        for (const t of taken) {
          const was = before.get(t.url);
          if (was) fixes[t.url] = was;
          else delete fixes[t.url];
        }
      });
      warn(`[pr-checks] job ${job}: the fix turn was not launched: ${err instanceof Error ? err.message : String(err)}`);
      return { read: didRead, sent: false };
    }
  }

  async function pass(only?: string): Promise<PrChecksResult> {
    const since = now() - PR_WATCH_MS;
    const out: PrChecksResult = { jobs: 0, sent: 0 };
    for await (const rec of jobsByUse(deps.dataDir)) {
      if ((Date.parse(rec.usedAt) || 0) < since) break;
      if (!rec.runs?.length) continue;
      try {
        const r = await checkJob(rec, only);
        if (r.read) out.jobs++;
        if (r.sent) out.sent++;
      } catch (err) {
        warn(`[pr-checks] job ${rec.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return out;
  }

  let running: Promise<PrChecksResult> | undefined;
  return {
    checkJob,
    check(o = {}) {
      if (running) return running;
      let only: string | undefined;
      if (o.url !== undefined) {
        only = prOf({ kind: "pull_request", url: o.url })?.url;
        if (!only) return Promise.reject(new Error(`job/pr-checks: "${o.url}" is not a GitHub pull request's URL`));
      }
      running = pass(only).finally(() => {
        running = undefined;
      });
      return running;
    },
  };
}
