/**
 * Trials and tests: how often a rule holds, and whether a change to a page
 * makes the difference (plans/claim-trials.md).
 *
 * A CASE is one input to a workflow, kept on a claim about a Concept. A
 * TRIAL runs a claim's cases as fresh runs (`RunTrial`, src/core.ts: nothing
 * a trial starts leaves it), and the claim's check judges each one whatever
 * its policy (src/verify.ts). Each verdict is ordinary evidence, on the
 * version of the page the run read.
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
 * On disk, under `<dataDir>/trials/`: `cases/<claim id>.json` and
 * `tests/<id>.json`. What is running is in memory only: a restart forgets
 * the samples not yet started, and `sweep` drops the branch they left.
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
import type { EvidenceRow } from "./graph/claims.js";
import { conceptVersionOf } from "./graph/concept-version.js";
import { conceptCheckSpec } from "./knowledge.js";
import type { Proposal } from "./proposals.js";
import type { RunStore } from "./store.js";

const CONCEPT = "Concept";
const PARENT_OF = "PARENT_OF";

/** The most samples of one case one call starts. */
export const TRIAL_N_MAX = 20;
/** The most cases a claim keeps. */
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
  /** A trial's: which of the claim's cases it replayed. Absent on a person's own work. */
  case?: number;
  trial?: true;
}

/** A claim on the page with its cases, and its verdicts on the page's wording now. */
export interface CheckView {
  id: string;
  text: string;
  /** Who wrote it: a seeder (`strut`), `ai`, a person. */
  speaker?: string;
  cases: Case[];
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

export interface TrialsCapability {
  /** A page's checks, their verdicts and its tests; null when there is no such page. */
  checks(concept: string): Promise<ChecksView | null>;
  /** A claim on a page, by a person: the standard check judges it. */
  addCheck(input: { concept: string; text: string; by?: string }): Promise<{ ok: true; id: string; existing?: true } | Fail>;
  /** A claim's cases, replaced whole. */
  setCases(input: { claim: string; cases: Case[] }): Promise<{ ok: true; cases: Case[] } | Fail>;
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
  /** The claims and cases a seeded page's file carries, recorded: additive, as a workflow's block is. */
  seed(pages: ReadonlyArray<{ name: string; claims: PageClaim[] }>, speaker: string): Promise<void>;
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
  /** Run a workflow to its end, as a trial. */
  run(workflow: string, input: unknown, o: { actor?: string; branch?: string; trial: RunTrial }): Promise<RunResult>;
  now?: () => Date;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const sameCase = (a: Case, b: Case) => a.workflow === b.workflow && JSON.stringify(a.input) === JSON.stringify(b.input);

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
    ...(typeof c.case === "number" ? { case: c.case } : {}),
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
  const casesDir = join(deps.dataDir, "trials", "cases");
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
  /** A claim id is a file name here: only what `newEpistemicId` makes. */
  const fileOf = (id: string) => (/^[A-Za-z0-9_-]{1,80}$/.test(id) ? `${id}.json` : null);

  const casesOf = async (claim: string): Promise<Case[]> => {
    const file = fileOf(claim);
    const kept = file ? await readJson<{ cases?: unknown }>(join(casesDir, file)) : null;
    const parsed = caseSchema.array().safeParse(kept?.cases);
    return parsed.success ? parsed.data : [];
  };
  const writeCases = async (claim: string, cases: Case[]) => {
    const file = fileOf(claim);
    if (!file) throw new Error(`claim "${claim}" is not a claim id`);
    await writeJson(casesDir, file, { cases });
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

  /** One sample: the case run as a trial, then judged. */
  const sampleRun = async (batch: Batch, s: { claim: string; k: number; c: Case; branch?: string }) => {
    try {
      const res = await deps.run(s.c.workflow, s.c.input, {
        ...(actors.get(batch.id) ? { actor: actors.get(batch.id)! } : {}),
        ...(s.branch ? { branch: s.branch } : {}),
        trial: { claim: s.claim, case: s.k },
      });
      await deps.verifier.verifyRun(s.c.workflow, res.runId);
    } catch (err) {
      batch.errors.push(errorText(err));
    } finally {
      batch.done++;
    }
  };
  /** Start a batch's samples; `after` runs when the last one is judged. */
  const start = (batch: Batch, by: string | undefined, samples: Array<{ claim: string; k: number; c: Case; branch?: string }>, after?: () => Promise<void>) => {
    batch.total = samples.length;
    batches.set(batch.id, batch);
    if (by) actors.set(batch.id, by);
    void Promise.all(samples.map((s) => limit(() => sampleRun(batch, s))))
      .then(() => after?.())
      .catch((err) => console.error(`[trials] ${batch.id}:`, err))
      .finally(() => {
        if (batch.errors.length) console.warn(`[trials] ${batch.id}: ${batch.errors.length} of ${batch.total} samples failed: ${batch.errors[0]}`);
        batches.delete(batch.id);
        actors.delete(batch.id);
      });
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
      const cases = new Map<string, Case[]>();
      await Promise.all(
        list.map(async (c) => {
          const [v, k] = await Promise.all([verdictsOf(c.id, concept, branches), casesOf(c.id)]);
          verdicts.set(c.id, v);
          cases.set(c.id, k);
        }),
      );
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
          id: c.id,
          text: c.text,
          ...(c.speaker ? { speaker: c.speaker } : {}),
          cases: cases.get(c.id) ?? [],
          samples: verdicts.get(c.id)?.get(page.version) ?? [],
        })),
        tests: tests.map((t) => {
          const o = orient(t, page.version);
          return { id: t.id, at: t.createdAt, ...(t.by ? { by: t.by } : {}), page: side(t.sides[o.page]), change: side(t.sides[o.page === 0 ? 1 : 0]), live: o.live };
        }),
        running: [...batches.values()].filter((b) => b.concept === concept).map((b) => ({ ...b, errors: [...b.errors] })),
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
      const kept = parsed.data.filter((c, i, all) => all.findIndex((x) => sameCase(x, c)) === i);
      const problem = await validCases(kept);
      if (problem) return { error: problem };
      await writeCases(claim, kept);
      return { ok: true, cases: kept };
    },

    async trial({ claim, n, by }) {
      const each = nOf(n);
      if (!each) return { error: `n is a whole number from 1 to ${TRIAL_N_MAX}: the samples of each case` };
      const concept = await conceptOf(claim);
      if (!concept) return { error: `claim "${claim}" is not about a Concept` };
      const cases = await casesOf(claim);
      if (!cases.length) return { error: "this check has no case yet: add a message that tests it" };
      const batch: Batch = { id: newId(), concept, claim, total: 0, done: 0, errors: [] };
      start(
        batch,
        by,
        cases.flatMap((c, k) => Array.from({ length: each }, () => ({ claim, k, c }))),
      );
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
      const withCases = (await Promise.all(list.map(async (c) => ({ claim: c.id, cases: await casesOf(c.id) })))).filter((c) => c.cases.length);
      if (!withCases.length) return { error: "no check on this page has a case yet: add a message to one first" };

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

      // The page is topped up to `each` a case (again: `each` more), so the two rows are measured alike.
      const have = new Map<string, Map<number, number>>();
      if (!both) {
        const mine = new Set((await testsOf(concept)).map((t) => branchOf(t.id)));
        for (const c of withCases) {
          const counts = new Map<number, number>();
          for (const s of (await verdictsOf(c.claim, concept, mine)).get(page.version) ?? []) if (s.case !== undefined) counts.set(s.case, (counts.get(s.case) ?? 0) + 1);
          have.set(c.claim, counts);
        }
      }
      const samples: Array<{ claim: string; k: number; c: Case; branch?: string }> = [];
      for (const { claim, cases } of withCases) {
        cases.forEach((c, k) => {
          const missing = both ? each : Math.max(0, each - (have.get(claim)?.get(k) ?? 0));
          for (let i = 0; i < missing; i++) samples.push({ claim, k, c });
          for (let i = 0; i < each; i++) samples.push({ claim, k, c, branch });
        });
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
      for (const page of pages) {
        try {
          const have = await claimsOn(page.name);
          for (const c of page.claims) {
            if (!c.text || c.text.includes("{{")) continue;
            let id = have.find((x) => x.text.trim() === c.text)?.id;
            if (!id) {
              const made = await claims.addClaim({ subjects: [{ kind: "concept", name: page.name }], text: c.text, checks: [conceptCheckSpec(c.text)] }, { publisher: speaker, scoped: false, concepts: true });
              if (!("ok" in made)) {
                console.warn(`[trials] ${page.name}: its claim was not recorded: ${made.error}`);
                continue;
              }
              id = made.id;
            }
            // The file's cases are added to whatever the claim has; none is taken away.
            const kept = await casesOf(id);
            const added = c.cases.filter((x) => !kept.some((k) => sameCase(k, x)));
            if (added.length) await writeCases(id, [...kept, ...added].slice(0, CASES_MAX));
          }
        } catch (err) {
          console.warn(`[trials] ${page.name}: its claims were not recorded: ${errorText(err)}`);
        }
      }
    },

    async sweep() {
      if (!deps.branches) return;
      for (const b of await deps.branches.list().catch(() => [])) if (b.name.startsWith(TEST_BRANCH)) await dropBranch(b.name);
    },
  };
  return cap;
}
