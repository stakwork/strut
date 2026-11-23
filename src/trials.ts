/**
 * Trials and tests: how often a rule holds, and whether a change to a page
 * makes the difference (plans/claim-trials.md).
 *
 * A CASE is one input to a workflow, a `TestCase` node in the graph that
 * `TESTS` one or more claims about Concepts (src/graph/claims.ts). Its id is
 * a hash of the two, so the same case is one node however many claims it
 * tests. A TRIAL runs a claim's cases as fresh runs (`RunTrial`, src/core.ts:
 * nothing a trial starts leaves it), and EVERY claim a case tests judges each
 * run of it whatever its checks' policy (src/verify.ts): one run, however
 * dear, feeds every claim it was written for. Each verdict is ordinary
 * evidence, on the version of the page the run read, naming the case.
 *
 * A case whose workflow is a job's (`JOB_WORKFLOWS`, src/jobs.ts) runs as a
 * JOB OF ITS OWN: a new id for each sample, so a tool that needs a job (a
 * pod) has one, and the job is closed once the sample is judged, which lets
 * go whatever it held (`deleteJob`). Strut knows nothing of what was held.
 *
 * A TEST is two wordings of one page run against the same checks: the page
 * as it is, and the page with a change. The other wording is read by its
 * runs on a Concept branch made for them (src/branches.ts) and dropped when
 * they end; the test itself is kept, both texts with it, so the diff and
 * its verdicts stay whatever the page becomes. A test never decides
 * anything: `use` puts the other wording on the page when a person asks.
 * Taking lines out and getting worse, and changing lines and getting
 * better, are the same record read from either side.
 *
 * Verdicts are counted by TEXT: a page version (src/graph/concept-version.ts)
 * names one wording, and every verdict on it counts, from a run on main or
 * from a run on one of that page's own tests. Status keeps reading per side
 * (plans/concept-evals.md ruling 4); this is the count beside it.
 *
 * On disk, under `<dataDir>/trials/`: `tests/<id>.json`. What is running is
 * in memory only: a restart forgets the samples not yet started, and
 * `sweep` drops the branch they left.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { branchNamespace, type BranchesCapability } from "./branches.js";
import type { ClaimsAuthoring } from "./claims-authoring.js";
import { caseSchema, type Case, type PageClaim } from "./claims-schemas.js";
import { renderConceptPage } from "./concept-seed.js";
import type { ConceptSources, ProposedCheckout } from "./concept-sources.js";
import type { RunResult, RunTrial } from "./core.js";
import type { GraphBackend } from "./graph/backend.js";
import { CLAIM_EDGES, TESTCASE_TYPE, testCaseId, type EvidenceRow } from "./graph/claims.js";
import { conceptVersionOf } from "./graph/concept-version.js";
import { claimOf, conceptCheckSpec, type KnowledgeClaim } from "./knowledge.js";
import type { Proposal } from "./proposals.js";
import type { RunStore } from "./store.js";

const CONCEPT = "Concept";
const PARENT_OF = "PARENT_OF";

/** The most samples of one case one call starts. */
export const TRIAL_N_MAX = 20;
/** The most cases one claim is tested by. */
export const CASES_MAX = 20;
/** Trial runs in flight at once, across every batch. */
const CONCURRENCY = 4;
/** Who a claim strut's own page files carry is by. */
export const SEED_SPEAKER = "strut";
/** A test's branch: `test-<id>`. */
const TEST_BRANCH = "test-";

/** One verdict: a run a claim's check judged. */
export interface Sample {
  /** The run judged (a work's root), and the workflow it ran. */
  run: string;
  workflow?: string;
  supports: boolean;
  /** What the judge saw, in a line. */
  content?: string;
  /** When, epoch seconds. */
  at?: number;
  /** A trial's: the `TestCase` it replayed, by id. Absent on a person's own work. */
  case?: string;
  trial?: true;
  /** A trial's: how long its run took, in milliseconds, and what its model
   *  calls cost, in dollars (0 when none did), from the run's own summary
   *  (`durationMs`, `totals.cost`: its sub-agents and the runs it waited on
   *  included). Not a verdict: read beside one, so a change that passes as
   *  often in half the time shows. */
  ms?: number;
  cost?: number;
}

/** A case as a claim lists it: the `TestCase`'s id, the workflow and its input. */
export interface TestCase extends Case {
  id: string;
}

/** A claim on the page as its keeper reads it (its status, who wrote it:
 *  a seeder — `strut` — `ai`, a person; the newest evidence), with its
 *  cases, and its verdicts on the page's wording now. */
export interface CheckView extends KnowledgeClaim {
  cases: TestCase[];
  samples: Sample[];
}

/** One wording of a test, with each claim's verdicts on it. */
export interface TestSide {
  version: string;
  docs: string;
  samples: Record<string, Sample[]>;
}

/** A test as the page reads it: the page's wording against the other one. */
export interface TestView {
  id: string;
  at: string;
  by?: string;
  /** The page's side: its wording now when `live`, else what it was when the test was made. */
  page: TestSide;
  /** The other wording. */
  change: TestSide;
  /** One of the two is the page now, so it can be run again and the other used. */
  live: boolean;
  /** Which side is the wording the test tried, the other being what it was
   *  tried against: `change` until it is used, then `page`. A rewording is
   *  drawn in that order. */
  tried: "page" | "change";
}

/** What is running: samples started and not yet judged. */
export interface Batch {
  id: string;
  concept: string;
  /** The test it runs, or the claim alone. */
  test?: string;
  claim?: string;
  total: number;
  done: number;
  /** Samples that could not be run or judged, in a line each. */
  errors: string[];
}

export interface ChecksView {
  concept: string;
  ref_id: string;
  /** The page's wording now, whole, and its version. */
  version: string;
  docs: string;
  /** The page's text comes from git (a seed, a package): `checkout` is where
   *  a change to it is written here, `why` why there is none. */
  fromGit?: { set: string; checkout?: string; why?: string };
  checks: CheckView[];
  /** Newest first. */
  tests: TestView[];
  running: Batch[];
  /** The last run here left samples with no verdict (a run that failed, a
   *  judge that could not be reached): how many, and why, in a line. Gone
   *  when the next one starts. */
  problem?: string;
}

/** A test on disk: the two wordings, in the order they were when it was made. */
interface TestRecord {
  id: string;
  concept: string;
  createdAt: string;
  by?: string;
  /** The page then, and the change. */
  sides: [{ version: string; docs: string }, { version: string; docs: string }];
}

type Fail = { error: string };

/** One sample to run: the case, the claims that judge it, and the branch it reads the page on. */
interface Sampled {
  c: TestCase;
  claims: string[];
  branch?: string;
}

export interface TrialsCapability {
  /** A page's checks, their verdicts and its tests; null when there is no such page. */
  checks(concept: string): Promise<ChecksView | null>;
  /** A claim on a page, by a person: the standard check judges it. */
  addCheck(input: { concept: string; text: string; by?: string }): Promise<{ ok: true; id: string; existing?: true } | Fail>;
  /** The cases a claim is tested by, replaced whole: a case already written is the same
   *  node, linked; one taken away is unlinked from this claim alone. */
  setCases(input: { claim: string; cases: Case[] }): Promise<{ ok: true; cases: TestCase[] } | Fail>;
  /** Run a claim's cases `n` times each on the page as it is. Returns at once. */
  trial(input: { claim: string; n: number; by?: string }): Promise<{ ok: true; batch: Batch } | Fail>;
  /** Test a change: every check on the page, `n` samples a case on the
   *  change and the page topped up to as many. `docs` makes a new test;
   *  `test` runs an existing one again, `n` more on both. Returns at once. */
  test(input: { concept?: string; docs?: string; test?: string; n: number; by?: string }): Promise<{ ok: true; test: string; batch: Batch } | Fail>;
  /** The page takes a test's other wording. A page from git becomes a
   *  proposal into its checkout, or is refused where there is none. */
  use(input: { test: string; by?: string; proposer?: Proposal["by"] }): Promise<{ ok: true; landed?: true; proposed?: ProposedCheckout } | Fail>;
  /** A trial run's message and reply; null when the run was no trial. */
  sample(input: { workflow: string; run: string }): Promise<{ status: string; input: unknown; output?: unknown; error?: string } | null>;
  /** The claims and cases a seeded page's file carries, recorded, so the page's checks match its file: a sentence
   *  the file no longer carries is retired, when `speaker` wrote it (never a person's or the dream's); a new one is
   *  written with the checks it names, or the standard check; cases are only added. `speaker` is strut for its own
   *  pages, a package's name for its. What was not recorded, a line each. */
  seed(pages: ReadonlyArray<{ name: string; claims: PageClaim[] }>, speaker: string): Promise<string[]>;
  /** Boot: the test branches a restart left, dropped. */
  sweep(): Promise<void>;
}

export interface TrialsDeps {
  dataDir: string;
  /** The backend, unscoped: main is its own namespace. */
  graph: GraphBackend;
  claims: ClaimsAuthoring;
  verifier: { verifyRun(key: string, runId: string): Promise<unknown> };
  store: Pick<RunStore, "getRunSummary">;
  branches?: BranchesCapability;
  sources?: ConceptSources;
  history?: { touch(t: { cause: string; actor?: string }): void };
  /** Whether a workflow of that name is published here. */
  hasWorkflow(name: string): Promise<boolean>;
  /** Run a workflow to its end, as a trial; `job`: as that job's turn. */
  run(workflow: string, input: unknown, o: { actor?: string; branch?: string; trial: RunTrial; job?: string }): Promise<RunResult>;
  /** A case whose workflow is one of `workflows` IS a job: each sample runs as a job of its own, and
   *  `close` lets the job go once the sample is judged (what it held, its directory, its record). */
  jobs?: { workflows: readonly string[]; close(id: string): Promise<void> };
  now?: () => Date;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const str = (v: unknown): string => (typeof v === "string" ? v : "");
/** A case in a line, for the node's name: its one string, else its input as JSON. */
const labelOf = (c: Case): string => {
  const strings = Object.values(c.input).filter((v): v is string => typeof v === "string" && !!v.trim());
  const line = (strings.length === 1 ? strings[0]! : JSON.stringify(c.input)).replace(/\s+/g, " ").trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
};

/** Pure: an evidence row as a sample, or null when it is no verdict of a check. */
export function sampleOf(e: EvidenceRow): (Sample & { version?: string; branch?: string }) | null {
  if (e.evidence_status !== "collected" || typeof e.strength !== "number" || !e.check_id || !e.source?.run_id) return null;
  const c = e.source.context ?? {};
  return {
    run: e.source.run_id,
    ...(e.source.run_key ? { workflow: e.source.run_key } : {}),
    supports: e.strength > 0,
    ...(e.content ? { content: e.content } : {}),
    ...(typeof e.observed_at === "number" ? { at: e.observed_at } : {}),
    ...(typeof c.case === "string" && c.case ? { case: c.case } : {}),
    ...(c.trial === true ? { trial: true as const } : {}),
    ...(typeof c.version === "string" ? { version: c.version } : {}),
    ...(typeof c.branch === "string" && c.branch ? { branch: c.branch } : {}),
  };
}

/** Pure: a test as the page reads it now (`version`: the page's). */
export function orient(rec: Pick<TestRecord, "sides">, version: string): { page: 0 | 1; live: boolean } {
  if (rec.sides[1].version === version) return { page: 1, live: true };
  return { page: 0, live: rec.sides[0].version === version };
}

/** At most `n` at once, in the order asked. */
function pool(n: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((go) => waiting.push(go));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

export function createTrials(deps: TrialsDeps): TrialsCapability {
  const { graph, claims } = deps;
  const reader = claims.reader;
  const testsDir = join(deps.dataDir, "trials", "tests");
  const limit = pool(CONCURRENCY);
  const batches = new Map<string, Batch>();
  const newId = () => `t${randomBytes(5).toString("hex")}`;
  const branchOf = (test: string) => `${TEST_BRANCH}${test}`;

  const readJson = async <T>(path: string): Promise<T | null> => {
    try {
      return JSON.parse(await readFile(path, "utf-8")) as T;
    } catch {
      return null;
    }
  };
  const writeJson = async (dir: string, file: string, value: unknown) => {
    await mkdir(dir, { recursive: true });
    const path = join(dir, file);
    await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n", "utf-8");
    await rename(`${path}.tmp`, path);
  };
  /** A test id is a file name here: only what `newId` makes. */
  const fileOf = (id: string) => (/^[A-Za-z0-9_-]{1,80}$/.test(id) ? `${id}.json` : null);

  /** The cases a claim is tested by, first written first, with their `TESTS` edges. */
  const linkedTo = (claim: string) => reader.testCasesFor(claim);
  const casesOf = async (claim: string): Promise<TestCase[]> => (await linkedTo(claim)).map(({ id, workflow, input }) => ({ id, workflow, input }));
  /** Each case written (the same one again is the node it was) and linked to the claim; none unlinked. */
  const link = async (claim: string, cases: readonly Case[]) => {
    const row = await reader.getClaim(claim);
    if (!row) throw new Error(`no claim "${claim}"`);
    const have = new Set((await linkedTo(claim)).map((t) => t.id));
    const added = cases.filter((c) => !have.has(testCaseId(c.workflow, c.input)));
    if (!added.length) return;
    const written = await graph.nodes.writeMany(
      added.map((c) => ({ type: TESTCASE_TYPE, data: { id: testCaseId(c.workflow, c.input), name: labelOf(c), case_workflow: c.workflow, case_input: JSON.stringify(c.input) } })),
      "create",
    );
    await graph.edges.writeMany(written.map((w) => ({ edge: CLAIM_EDGES.TESTS, source_ref_id: w.ref_id, target_ref_id: row.ref_id })));
  };
  /** The claims a case tests, the one asked for among them. */
  const claimsOfCase = async (id: string, claim?: string): Promise<string[]> => {
    const all = await reader.claimsOfTestCase(id);
    return claim && !all.includes(claim) ? [...all, claim] : all;
  };

  const readTest = async (id: string): Promise<TestRecord | null> => {
    const file = fileOf(id);
    const rec = file ? await readJson<TestRecord>(join(testsDir, file)) : null;
    return rec && rec.id === id && Array.isArray(rec.sides) && rec.sides.length === 2 ? rec : null;
  };
  const testsOf = async (concept: string): Promise<TestRecord[]> => {
    let files: string[];
    try {
      files = (await readdir(testsDir)).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const all = await Promise.all(files.map((f) => readTest(f.slice(0, -5))));
    return all.filter((t): t is TestRecord => t !== null && t.concept === concept).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  };

  /** Main's page, whole: what a version is made of. */
  const pageOf = async (name: string) => {
    const d = graph.dialect;
    const [node] = await graph.query(
      `MATCH ${d.node("p", CONCEPT, { namespace: "$ns", name: "$name" })} WHERE ${d.live("p")}
       RETURN p.ref_id AS ref_id, p.name AS name, p.description AS description, p.docs AS docs LIMIT 1`,
      { ns: graph.namespace, name },
    );
    if (!node || typeof node["ref_id"] !== "string") return null;
    const children = await graph.query(
      `MATCH ${d.node("p", CONCEPT, { ref_id: "$ref" })}-[r:\`${PARENT_OF}\`]->${d.node("c", CONCEPT)}
       WHERE ${d.edgeLive("r")} AND ${d.live("c")} RETURN c.name AS name, c.description AS description`,
      { ref: node["ref_id"] },
    );
    const page = {
      name: str(node["name"]),
      description: str(node["description"]),
      docs: str(node["docs"]),
      children: children.map((c) => ({ name: str(c["name"]), description: str(c["description"]) })),
    };
    return { ref_id: node["ref_id"], ...page, version: conceptVersionOf(page), versionWith: (docs: string) => conceptVersionOf({ ...page, docs }) };
  };

  /** The Concept a claim is about, or null. */
  const conceptOf = async (claim: string): Promise<string | null> => {
    const about = (await reader.subjectsOf(claim)).map((s) => s.subject).find((s): s is { kind: "concept"; name: string } => s.kind === "concept");
    return about?.name ?? null;
  };

  const claimsOn = async (concept: string) => {
    const listed = await claims.listClaims({ kind: "concept", name: concept });
    return "ok" in listed ? listed.claims : [];
  };

  /** A claim's verdicts by the version they judged: main's works, and the
   *  works of this page's own tests. */
  const verdictsOf = async (claim: string, concept: string, branches: ReadonlySet<string>): Promise<Map<string, Sample[]>> => {
    const out = new Map<string, Sample[]>();
    for (const e of await reader.evidenceFor(claim, { kind: "concept", name: concept })) {
      const s = sampleOf(e);
      if (!s?.version || (s.branch && !branches.has(s.branch))) continue;
      const { version, branch: _, ...sample } = s;
      out.set(version, [...(out.get(version) ?? []), sample]);
    }
    for (const list of out.values()) list.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.run.localeCompare(b.run));
    return out;
  };

  const validCases = async (cases: Case[]): Promise<string | null> => {
    if (cases.length > CASES_MAX) return `a claim keeps at most ${CASES_MAX} cases`;
    for (const c of cases) if (!(await deps.hasWorkflow(c.workflow))) return `no workflow "${c.workflow}" here: a case is a workflow and one input to it`;
    return null;
  };

  const nOf = (n: number): number | null => (Number.isInteger(n) && n >= 1 && n <= TRIAL_N_MAX ? n : null);

  /** Who started each batch: whose run each sample is. Never on what a page is shown. */
  const actors = new Map<string, string>();
  /** Each batch's samples as they ran: the claims judging it and the run, to see which were judged. */
  const ran = new Map<string, Array<{ claims: string[]; run: string }>>();
  /** What the last batch on a page left unjudged, in a line (`ChecksView.problem`). */
  const problems = new Map<string, string>();

  /** One sample: the case run as a trial (a job's case as a job of its own), judged, then its job closed. */
  const sampleRun = async (batch: Batch, s: Sampled) => {
    const job = deps.jobs?.workflows.includes(s.c.workflow) ? `trial-${batch.id}-${randomBytes(4).toString("hex")}` : undefined;
    try {
      const res = await deps.run(s.c.workflow, s.c.input, {
        ...(actors.get(batch.id) ? { actor: actors.get(batch.id)! } : {}),
        ...(s.branch ? { branch: s.branch } : {}),
        trial: { case: s.c.id, claims: s.claims },
        ...(job ? { job } : {}),
      });
      ran.get(batch.id)?.push({ claims: s.claims, run: res.runId });
      if (res.status !== "success") batch.errors.push(res.error?.message ?? `the run ended ${res.status}`);
      await deps.verifier.verifyRun(s.c.workflow, res.runId);
    } catch (err) {
      batch.errors.push(errorText(err));
    } finally {
      // A job that will not close (a hold that will not let go) is kept, and the idle sweep tries again.
      if (job) await deps.jobs!.close(job).catch((err) => console.warn(`[trials] ${batch.id}: the sample's job ${job} was not closed: ${errorText(err)}`));
      batch.done++;
    }
  };
  /** Start a batch's samples; `after` runs when the last one is judged. */
  const start = (batch: Batch, by: string | undefined, samples: Sampled[], after?: () => Promise<void>) => {
    batch.total = samples.length;
    batches.set(batch.id, batch);
    ran.set(batch.id, []);
    problems.delete(batch.concept);
    if (by) actors.set(batch.id, by);
    void Promise.all(samples.map((s) => limit(() => sampleRun(batch, s))))
      .then(() => after?.())
      .then(() => unjudged(batch))
      .catch((err) => console.error(`[trials] ${batch.id}:`, err))
      .finally(() => {
        batches.delete(batch.id);
        actors.delete(batch.id);
        ran.delete(batch.id);
      });
  };

  /** A batch that ended with samples no verdict came of says so on the page, until the next one starts. */
  const unjudged = async (batch: Batch) => {
    const runs = ran.get(batch.id) ?? [];
    const judged = new Set<string>();
    for (const claim of new Set(runs.flatMap((r) => r.claims))) {
      for (const e of await reader.evidenceFor(claim, { kind: "concept", name: batch.concept })) if (e.source?.run_id) judged.add(e.source.run_id);
    }
    const missing = batch.total - runs.filter((r) => judged.has(r.run)).length;
    if (!missing) return;
    const why = batch.errors[0];
    const line = `${missing} of ${batch.total} samples have no verdict${why ? `: ${why.length > 300 ? `${why.slice(0, 300)}…` : why}` : " (the judge gave none)"}`;
    problems.set(batch.concept, line);
    console.warn(`[trials] ${batch.concept}: ${line}`);
  };

  const dropBranch = async (name: string) => {
    if (!deps.branches || !(await deps.branches.get(name))) return;
    await deps.branches.drop(name).catch((err) => console.warn(`[trials] the branch ${name} was not dropped: ${errorText(err)}`));
  };

  const cap: TrialsCapability = {
    async checks(concept) {
      const page = await pageOf(concept);
      if (!page) return null;
      const [list, tests, source] = await Promise.all([claimsOn(concept), testsOf(concept), deps.sources?.fromGit([concept]).then((m) => m.get(concept))]);
      const branches = new Set(tests.map((t) => branchOf(t.id)));
      const verdicts = new Map<string, Map<string, Sample[]>>();
      const cases = new Map<string, TestCase[]>();
      await Promise.all(
        list.map(async (c) => {
          const [v, k] = await Promise.all([verdictsOf(c.id, concept, branches), casesOf(c.id)]);
          verdicts.set(c.id, v);
          cases.set(c.id, k);
        }),
      );
      // A trial's time and cost, from its run's summary: read once a run,
      // however many claims judged it.
      const spend = new Map<string, Promise<Pick<Sample, "ms" | "cost">>>();
      const spentBy = (workflow: string, run: string) => {
        const k = `${workflow}\n${run}`;
        if (!spend.has(k)) {
          spend.set(
            k,
            deps.store.getRunSummary(workflow, run).then(
              (r) => (r ? { ...(typeof r.durationMs === "number" ? { ms: r.durationMs } : {}), cost: r.totals?.cost ?? 0 } : {}),
              () => ({}),
            ),
          );
        }
        return spend.get(k)!;
      };
      const trialSamples = [...verdicts.values()].flatMap((m) => [...m.values()].flat()).filter((s) => s.trial && s.workflow);
      await Promise.all(trialSamples.map(async (s) => Object.assign(s, await spentBy(s.workflow!, s.run))));
      const side = (s: { version: string; docs: string }): TestSide => ({
        version: s.version,
        docs: s.docs,
        samples: Object.fromEntries(list.map((c) => [c.id, verdicts.get(c.id)?.get(s.version) ?? []])),
      });
      return {
        concept,
        ref_id: page.ref_id,
        version: page.version,
        docs: page.docs,
        ...(source ? { fromGit: { set: source.set, ...(source.checkout ? { checkout: source.checkout } : {}), ...(source.why ? { why: source.why } : {}) } } : {}),
        checks: list.map((c) => ({
          ...claimOf(c),
          cases: cases.get(c.id) ?? [],
          samples: verdicts.get(c.id)?.get(page.version) ?? [],
        })),
        tests: tests.map((t) => {
          const o = orient(t, page.version);
          return { id: t.id, at: t.createdAt, ...(t.by ? { by: t.by } : {}), page: side(t.sides[o.page]), change: side(t.sides[o.page === 0 ? 1 : 0]), live: o.live, tried: o.page === 1 ? "page" : "change" };
        }),
        running: [...batches.values()].filter((b) => b.concept === concept).map((b) => ({ ...b, errors: [...b.errors] })),
        ...(problems.has(concept) ? { problem: problems.get(concept)! } : {}),
      };
    },

    async addCheck({ concept, text, by }) {
      const sentence = text?.trim() ?? "";
      if (!sentence) return { error: "text is empty: a check is ONE sentence the page's readers should hold to" };
      // The sentence is written into the check's config, which is a template.
      if (sentence.includes("{{")) return { error: "a check's text may not contain {{ — write the rule in plain words" };
      if (!(await pageOf(concept))) return { error: `no Concept named "${concept}"` };
      const same = (await claimsOn(concept)).find((c) => c.text.trim() === sentence);
      if (same) return { ok: true, id: same.id, existing: true };
      const made = await claims.addClaim({ subjects: [{ kind: "concept", name: concept }], text: sentence, checks: [conceptCheckSpec(sentence)] }, { publisher: by || "person", scoped: false, concepts: true });
      return "ok" in made ? { ok: true, id: made.id } : { error: made.error };
    },

    async setCases({ claim, cases }) {
      if (!(await conceptOf(claim))) return { error: `claim "${claim}" is not about a Concept: cases test a claim on a page` };
      const parsed = caseSchema.array().safeParse(cases);
      if (!parsed.success) return { error: "cases is a list of { workflow, input }" };
      const kept = parsed.data.filter((c, i, all) => all.findIndex((x) => testCaseId(x.workflow, x.input) === testCaseId(c.workflow, c.input)) === i);
      const problem = await validCases(kept);
      if (problem) return { error: problem };
      // Taken away: this claim's edge alone. The case, its other claims and every verdict on it stay.
      const wanted = new Set(kept.map((c) => testCaseId(c.workflow, c.input)));
      for (const t of await linkedTo(claim)) if (!wanted.has(t.id)) await graph.edges.delete({ ref_id: t.edge_ref_id, edge: CLAIM_EDGES.TESTS });
      await link(claim, kept);
      return { ok: true, cases: await casesOf(claim) };
    },

    async trial({ claim, n, by }) {
      const each = nOf(n);
      if (!each) return { error: `n is a whole number from 1 to ${TRIAL_N_MAX}: the samples of each case` };
      const concept = await conceptOf(claim);
      if (!concept) return { error: `claim "${claim}" is not about a Concept` };
      const cases = await casesOf(claim);
      if (!cases.length) return { error: "this check has no case yet: add a message that tests it" };
      const batch: Batch = { id: newId(), concept, claim, total: 0, done: 0, errors: [] };
      const samples: Sampled[] = [];
      for (const c of cases) {
        const judges = await claimsOfCase(c.id, claim);
        for (let i = 0; i < each; i++) samples.push({ c, claims: judges });
      }
      start(batch, by, samples);
      return { ok: true, batch };
    },

    async test(input) {
      const each = nOf(input.n);
      if (!each) return { error: `n is a whole number from 1 to ${TRIAL_N_MAX}: the samples of each case` };
      if (!deps.branches) return { error: "a test needs the Concept branches (a graph workspace): the other wording is read on one" };
      let rec: TestRecord;
      let both = false;
      if (input.test) {
        const found = await readTest(input.test);
        if (!found) return { error: `no test "${input.test}"` };
        rec = found;
        both = true;
      } else {
        const concept = input.concept ?? "";
        const page = concept ? await pageOf(concept) : null;
        if (!page) return { error: `no Concept named "${concept}"` };
        const docs = (input.docs ?? "").trim();
        if (!docs) return { error: "the page needs some text" };
        if (docs === page.docs.trim()) return { error: "that is the page as it is: change something first" };
        const other = { version: page.versionWith(docs), docs };
        // The same two wordings again are the same test.
        const same = (await testsOf(concept)).find((t) => t.sides.some((s) => s.version === page.version) && t.sides.some((s) => s.version === other.version));
        rec = same ?? {
          id: newId(),
          concept,
          createdAt: (deps.now?.() ?? new Date()).toISOString(),
          ...(input.by ? { by: input.by } : {}),
          sides: [{ version: page.version, docs: page.docs }, other],
        };
        if (!same) await writeJson(testsDir, `${rec.id}.json`, rec);
      }
      const concept = rec.concept;
      if ([...batches.values()].some((b) => b.test === rec.id)) return { error: "this test is running: its samples are still coming in" };
      const page = await pageOf(concept);
      if (!page) return { error: `no Concept named "${concept}"` };
      const o = orient(rec, page.version);
      if (!o.live) return { error: "neither wording of this test is the page now: test the change again against the page as it is" };
      const change = rec.sides[o.page === 0 ? 1 : 0];
      const list = await claimsOn(concept);
      // Every case a check on the page is tested by, once, with every claim it tests.
      const cases = new Map<string, TestCase>();
      for (const c of list) for (const t of await casesOf(c.id)) if (!cases.has(t.id)) cases.set(t.id, t);
      if (!cases.size) return { error: "no check on this page has a case yet: add a message to one first" };

      const branch = branchOf(rec.id);
      // What a restart, or a run cut off, left under the name.
      await dropBranch(branch);
      await deps.branches.create({ name: branch, from: "main", ...(input.by ? { by: input.by } : {}) });
      try {
        await graph.nodes.writeMany([{ type: CONCEPT, data: { name: concept, docs: change.docs } }], "upsert", { namespace: branchNamespace(branch), embed: "later" });
        const on = await reader.activeVersion({ kind: "concept", name: concept }, branch);
        if (on !== change.version) throw new Error(`the branch's page reads as version ${on ?? "none"}, not the change's ${change.version}`);
      } catch (err) {
        await dropBranch(branch);
        return { error: `the change could not be set up to run: ${errorText(err)}` };
      }

      // The page is topped up to `each` runs a case (again: `each` more), so the two rows are measured
      // alike: a run of a case on the page's wording counts once, whichever of its claims judged it.
      const have = new Map<string, Set<string>>();
      if (!both) {
        const mine = new Set((await testsOf(concept)).map((t) => branchOf(t.id)));
        for (const c of list) {
          for (const s of (await verdictsOf(c.id, concept, mine)).get(page.version) ?? []) {
            if (s.case) have.set(s.case, (have.get(s.case) ?? new Set()).add(s.run));
          }
        }
      }
      const samples: Sampled[] = [];
      for (const c of cases.values()) {
        const judges = await claimsOfCase(c.id);
        const missing = both ? each : Math.max(0, each - (have.get(c.id)?.size ?? 0));
        for (let i = 0; i < missing; i++) samples.push({ c, claims: judges });
        for (let i = 0; i < each; i++) samples.push({ c, claims: judges, branch });
      }
      const batch: Batch = { id: newId(), concept, test: rec.id, total: 0, done: 0, errors: [] };
      start(batch, input.by, samples, () => dropBranch(branch));
      return { ok: true, test: rec.id, batch };
    },

    async use({ test, by, proposer }) {
      const rec = await readTest(test);
      if (!rec) return { error: `no test "${test}"` };
      if ([...batches.values()].some((b) => b.test === rec.id)) return { error: "this test is running: use it once its samples are in" };
      const page = await pageOf(rec.concept);
      if (!page) return { error: `no Concept named "${rec.concept}"` };
      const o = orient(rec, page.version);
      if (!o.live) return { error: "neither wording of this test is the page now: test the change again against the page as it is" };
      const change = rec.sides[o.page === 0 ? 1 : 0];
      const source = (await deps.sources?.fromGit([rec.concept]))?.get(rec.concept);
      if (source) {
        // A page from git is never changed in the graph (src/concept-sources.ts): its file is, on a person's yes.
        const now = await deps.sources!.pageOf(rec.concept);
        if (!now || !proposer) return { error: `"${rec.concept}" is a page ${source.set} ships: a change to it is a proposal into its checkout, and this call cannot make one` };
        const r = await deps.sources!.propose([{ source, text: renderConceptPage({ ...now.page, docs: change.docs }) }], { by: proposer, cause: `test ${rec.id}` });
        if (r.proposed[0]) return { ok: true, proposed: r.proposed[0] };
        return { error: `"${rec.concept}" is a page ${source.set} ships, and it is not changed here: ${r.skipped[0]?.why ?? source.why ?? "this strut server has no checkout to write it to"}` };
      }
      await graph.nodes.writeMany([{ type: CONCEPT, data: { name: rec.concept, docs: change.docs } }], "upsert", { embed: "later" });
      deps.history?.touch({ cause: `test ${rec.id}: ${rec.concept} takes the wording tested against it`, ...(by ? { actor: by } : {}) });
      return { ok: true, landed: true };
    },

    async sample({ workflow, run }) {
      const s = await deps.store.getRunSummary(workflow, run).catch(() => null);
      if (!s?.trial) return null;
      return { status: s.status, input: s.input, ...(s.output !== undefined ? { output: s.output } : {}), ...(s.error?.message ? { error: s.error.message } : {}) };
    },

    async seed(pages, speaker) {
      const problems: string[] = [];
      const said = (line: string) => {
        problems.push(line);
        console.warn(`[trials] ${line}`);
      };
      for (const page of pages) {
        try {
          const have = await claimsOn(page.name);
          // Seeds match git: the seeder's own claim on a sentence its file no longer carries is retired.
          const texts = new Set(page.claims.map((c) => c.text));
          for (const old of have) {
            if (old.speaker !== speaker || texts.has(old.text.trim())) continue;
            const gone = await claims.retireClaim(old.id, { publisher: speaker, scoped: false, concepts: true });
            if (!("ok" in gone)) said(`${page.name}: a claim its file no longer carries was not retired: ${gone.error}`);
          }
          for (const c of page.claims) {
            if (!c.text || c.text.includes("{{")) continue;
            let id = have.find((x) => x.text.trim() === c.text)?.id;
            if (!id) {
              // The checks the file names (a workflow's claims block takes the same), else a model reading the work.
              const checks = c.checks?.length ? c.checks : [conceptCheckSpec(c.text)];
              const made = await claims.addClaim({ subjects: [{ kind: "concept", name: page.name }], text: c.text, checks }, { publisher: speaker, scoped: false, concepts: true });
              if (!("ok" in made)) {
                said(`${page.name}: its claim "${c.text.slice(0, 80)}" was not recorded: ${made.error}`);
                continue;
              }
              id = made.id;
            }
            // The file's cases are added to whatever the claim has; none is taken away.
            const linked = new Set((await linkedTo(id)).map((t) => t.id));
            const added = c.cases.filter((x) => !linked.has(testCaseId(x.workflow, x.input)));
            if (added.length) await link(id, added.slice(0, Math.max(0, CASES_MAX - linked.size)));
          }
        } catch (err) {
          said(`${page.name}: its claims were not recorded: ${errorText(err)}`);
        }
      }
      return problems;
    },

    async sweep() {
      if (!deps.branches) return;
      for (const b of await deps.branches.list().catch(() => [])) if (b.name.startsWith(TEST_BRANCH)) await dropBranch(b.name);
    },
  };
  return cap;
}
