/**
 * Trials and tests (src/trials.ts, plans/claim-trials.md), end to end: a
 * whole strut on a graph workspace, the shipped `orchestrator` and
 * `concept-check` workflows, the `Orchestrator` page strut seeds with its
 * claim and cases, and a stand-in model. A check's cases run as trials and
 * the check judges every sample; a change to a page is tested against the
 * page as it is and kept; the page takes the other wording only when asked.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphBackend } from "./backend.js";
import { projectionsSettled } from "./projector.js";
import { testBackends } from "./test-util.js";
import { GraphWorkspaceStore } from "./workspace-store.js";
import { createStrut, type Strut } from "../createStrut.js";
import { ORCHESTRATOR_PAGE, ORCHESTRATOR_WORKFLOW, orchestratorRules } from "../orchestrator-seed.js";
import { createRegistry } from "../steps/registry.js";
import { MemoryRunStore, type RunStore } from "../store.js";
import { SEED_SPEAKER, createTrials, type ChecksView, type TrialsCapability } from "../trials.js";
import type { ConceptSources, PageSource } from "../concept-sources.js";

const sse = (o: unknown) => `event: ${(o as { type: string }).type}\ndata: ${JSON.stringify(o)}\n\n`;
const start = sse({
  type: "message_start",
  message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
});
const toolUse = (id: string, name: string, input: unknown) =>
  start +
  sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } }) +
  sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }) +
  sse({ type: "content_block_stop", index: 0 }) +
  sse({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } }) +
  sse({ type: "message_stop" });

/** The line of the rules the stand-in model answers by. */
const REACH = "What a job can do, you can do.";
const POLITE = "The reply is polite";

for (const tb of testBackends()) describe(`trials and tests of a page, on ${tb.name}`, { skip: tb.skip }, () => {
  let backend: GraphBackend;
  let provider: http.Server;
  let dir = "";
  let store: RunStore;
  const struts: Strut[] = [];
  /** How many times each kind of request reached the model. */
  let turns = 0;
  let judged = 0;
  const ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "STRUT_API_KEY", "AI_SDK_LOG_WARNINGS"];
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

  before(async () => {
    let n = 0;
    provider = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw) as { system?: unknown; messages: Array<{ role: string; content: unknown }> };
        const system = JSON.stringify(body.system ?? "");
        const all = JSON.stringify(body.messages);
        const say = (name: string, input: unknown) => res.end(toolUse(`toolu_${++n}`, name, input));
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (system.includes("You judge whether a piece of work did what a rule says")) {
          judged++;
          // The greeter's rule: its page's words came out. The assistant's: it never says it has no shell.
          if (all.includes(POLITE)) return say("final_answer", { supports: all.includes("Be polite"), content: all.includes("Be polite") ? "the reply is polite" : "the reply is curt" });
          return say("final_answer", /no shell/.test(all) ? { supports: false, content: "says it has no shell" } : { supports: true, content: "says yes and offers to do it" });
        }
        // A turn of the assistant: it answers from the rules it was handed.
        turns++;
        const can = system.includes(REACH);
        if (all.includes("START A JOB")) return say("final_answer", { text: "On it.", artifacts: [], start: { brief: "Do the thing, start to end.", title: "The thing" } });
        say("final_answer", { text: can ? "Yes, I can do that for you." : "I can't: I have no shell.", artifacts: [] });
      });
    });
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["AI_SDK_LOG_WARNINGS"] = "false";
    delete process.env["STRUT_API_KEY"];
    backend = await tb.open();
    await tb.wipe(backend);
    const { seedStrutDomain } = await import("./schema-seed.js");
    await seedStrutDomain(backend);
    backend.schemas.invalidate();
  });
  after(async () => {
    provider.close();
    await tb.close(backend);
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });
  beforeEach(async () => {
    await tb.clear(backend);
    turns = 0;
    judged = 0;
    dir = join(tmpdir(), `strut-trials-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    store = new MemoryRunStore();
  });
  afterEach(async () => {
    await projectionsSettled(backend);
    for (const s of struts.splice(0)) await s.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  const boot = async (): Promise<Strut> => {
    const strut = await createStrut({
      workspace: new GraphWorkspaceStore(backend, { materializeDir: join(dir, "steps") }),
      store,
      registry: await createRegistry([]),
      dataDir: dir,
      serveUi: false, enableChat: false, scheduler: false, stt: false, autoResume: false, wakeDelayMs: 0,
      job: false, builder: false, orchestrator: {},
    });
    struts.push(strut);
    await strut.secretStore.set("STRUT_DEFAULT_MODEL", "anthropic/claude-sonnet-4-5");
    return strut;
  };
  const trialsOf = (strut: Strut) => (strut.services as unknown as { trials: TrialsCapability }).trials;
  const ok = <T extends object>(r: T | { error: string }): T => {
    assert.ok(!("error" in r), "error" in r ? r.error : "");
    return r as T;
  };
  /** The page's checks once nothing is running. */
  const settled = async (strut: Strut, concept: string, ms = 60_000): Promise<ChecksView> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await trialsOf(strut).checks(concept);
      assert.ok(v, `no page "${concept}"`);
      if (!v.running.length) {
        await projectionsSettled(backend);
        return (await trialsOf(strut).checks(concept))!;
      }
      if (Date.now() > end) throw new Error(`the samples of ${concept} never finished: ${JSON.stringify(v.running)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  it("the page strut ships carries its check and cases; running it judges every sample as a trial, and a job a trial would start is held", async () => {
    const strut = await boot();
    const trials = trialsOf(strut);
    const view = (await trials.checks(ORCHESTRATOR_PAGE))!;
    assert.equal(view.docs, await orchestratorRules(), "the page's whole text");
    assert.equal(view.checks.length, 1);
    const check = view.checks[0]!;
    assert.equal(check.speaker, SEED_SPEAKER);
    assert.match(check.text, /^Asked whether it can do something its work can do/);
    assert.equal(check.cases.length, 1);
    assert.deepEqual(check.cases[0], { workflow: ORCHESTRATOR_WORKFLOW, input: { prompt: "Can you use bash?" } });
    assert.deepEqual(check.samples, [], "nothing ran yet");
    assert.ok(view.fromGit, "its text comes from git");
    // A second boot adds nothing: the same sentence, the same cases.
    await trials.seed([{ name: ORCHESTRATOR_PAGE, claims: [{ text: check.text, cases: check.cases }] }], SEED_SPEAKER);
    assert.equal((await trials.checks(ORCHESTRATOR_PAGE))!.checks[0]!.cases.length, 1);

    // One more case, a person's: the turn it gets would start a job.
    const cases = [...check.cases, { workflow: ORCHESTRATOR_WORKFLOW, input: { prompt: "START A JOB for the thing" } }];
    ok(await trials.setCases({ claim: check.id, cases }));
    assert.match((await trials.setCases({ claim: check.id, cases: [{ workflow: "nope", input: {} }] }) as { error: string }).error, /no workflow "nope"/);

    const started = ok(await trials.trial({ claim: check.id, n: 2, by: "ada" }));
    assert.equal(started.batch.total, 4, "two cases, two samples each");
    const after = await settled(strut, ORCHESTRATOR_PAGE);
    const samples = after.checks[0]!.samples;
    assert.equal(samples.length, 4, "an on_change check judged every sample of its trial");
    assert.ok(samples.every((s) => s.supports && s.trial && s.workflow === ORCHESTRATOR_WORKFLOW), JSON.stringify(samples));
    assert.deepEqual([...new Set(samples.map((s) => s.case))].sort(), [0, 1]);
    assert.equal(turns, 4);
    assert.equal(judged, 4);

    // Each sample is a run marked a trial, and nothing it started left it.
    const held = samples.find((s) => s.case === 1)!;
    const opened = (await trials.sample({ workflow: ORCHESTRATOR_WORKFLOW, run: held.run }))!;
    assert.equal(opened.status, "success");
    assert.deepEqual(opened.input, { prompt: "START A JOB for the thing" });
    const out = opened.output as { text: string; job?: string; runId?: string; held?: { brief: string }; startError?: string };
    assert.equal(out.text, "On it.", "no \"the job did not start\" on the reply");
    assert.equal(out.startError, undefined);
    assert.equal(out.runId, "", "no run was started");
    assert.equal(out.held?.brief, "Do the thing, start to end.", "the brief it would have started is what is judged");
    const summary = await store.getRunSummary(ORCHESTRATOR_WORKFLOW, held.run);
    assert.deepEqual(summary?.trial, { claim: check.id, case: 1 });
    assert.equal(summary?.actor, "ada");
    assert.ok(!("trial" in ((summary?.input ?? {}) as object)), "never in the input");
    assert.deepEqual(await store.listRuns("job"), [], "no job ran");
    // A run that was no trial is not opened this way.
    const plain = await strut.run(ORCHESTRATOR_WORKFLOW, { prompt: "What time is it?" });
    assert.equal(await trials.sample({ workflow: ORCHESTRATOR_WORKFLOW, run: plain.runId }), null);
  });

  it("a change is tested against the page as it is and kept; a page from git is not changed here", async () => {
    const strut = await boot();
    const trials = trialsOf(strut);
    const before = (await trials.checks(ORCHESTRATOR_PAGE))!;
    const check = before.checks[0]!;
    assert.ok(before.docs.includes(REACH));
    const worse = before.docs.replace(REACH, "");

    assert.match((await trials.test({ concept: ORCHESTRATOR_PAGE, docs: before.docs, n: 1 }) as { error: string }).error, /change something first/);
    const made = ok(await trials.test({ concept: ORCHESTRATOR_PAGE, docs: worse, n: 1, by: "ada" }));
    assert.equal(made.batch.total, 2, "one case: the page topped up to one, the change one");
    const view = await settled(strut, ORCHESTRATOR_PAGE);
    assert.equal(view.tests.length, 1);
    const t = view.tests[0]!;
    assert.equal(t.id, made.test);
    assert.equal(t.live, true);
    assert.equal(t.page.version, view.version);
    assert.equal(t.page.docs, before.docs);
    assert.equal(t.change.docs, worse.trim());
    assert.deepEqual(t.page.samples[check.id]!.map((s) => s.supports), [true], "the page says yes");
    assert.deepEqual(t.change.samples[check.id]!.map((s) => s.supports), [false], "without the line it says it has no shell");
    assert.deepEqual(view.checks[0]!.samples.length, 1, "the page's own verdicts are the page side's");
    assert.deepEqual(await (strut.services as unknown as { branches: { list(): Promise<unknown[]> } }).branches.list(), [], "the branch its runs read is gone");
    assert.equal(view.docs, before.docs, "the page did not change");

    // Again: more samples on both, the same test. The same two wordings are never a second test.
    const again = ok(await trials.test({ test: t.id, n: 1 }));
    assert.equal(again.batch.total, 2);
    const more = await settled(strut, ORCHESTRATOR_PAGE);
    assert.equal(more.tests.length, 1);
    assert.equal(more.tests[0]!.page.samples[check.id]!.length, 2);
    assert.equal(more.tests[0]!.change.samples[check.id]!.length, 2);
    assert.equal(ok(await trials.test({ concept: ORCHESTRATOR_PAGE, docs: worse, n: 1 })).test, t.id);
    await settled(strut, ORCHESTRATOR_PAGE);

    // Strut ships this page: on a server with no checkout for it, it is not changed.
    const used = await trials.use({ test: t.id, by: "ada", proposer: { workflow: "__run_step__", runId: "r1", path: "" } });
    assert.match((used as { error: string }).error, /ships/);
    assert.equal((await trials.checks(ORCHESTRATOR_PAGE))!.docs, before.docs);
  });

  it("an ordinary page takes the other wording when asked, and the test then reads from the page's new wording", async () => {
    const strut = await boot();
    const trials = trialsOf(strut);
    await backend.nodes.writeMany([{ type: "Concept", data: { name: "Tone", description: "how replies sound", docs: "Be polite." } }]);
    await strut.workspace.publishWorkflowByContent(
      "greeter",
      ["name: greeter", "steps:", "  - id: page", "    type: context/concept", "    config: { name: Tone, frame: false }", "  - id: result", "    type: pack", '    config: { text: "{{ page.text }}" }', ""].join("\n"),
    );
    const added = ok(await trials.addCheck({ concept: "Tone", text: POLITE, by: "ada" }));
    assert.equal(ok(await trials.addCheck({ concept: "Tone", text: POLITE })).existing, true);
    assert.match((await trials.trial({ claim: added.id, n: 1 }) as { error: string }).error, /no case yet/);
    ok(await trials.setCases({ claim: added.id, cases: [{ workflow: "greeter", input: {} }] }));

    ok(await trials.test({ concept: "Tone", docs: "Be terse.", n: 2 }));
    const view = await settled(strut, "Tone");
    assert.equal(view.fromGit, undefined);
    const t = view.tests[0]!;
    assert.deepEqual([t.page.docs, t.change.docs], ["Be polite.", "Be terse."]);
    assert.deepEqual(t.page.samples[added.id]!.map((s) => s.supports), [true, true]);
    assert.deepEqual(t.change.samples[added.id]!.map((s) => s.supports), [false, false]);

    // Were the page's text from git with a checkout here (dev mode, a repo opened here), using the change would
    // be a proposal to write its file: the page as a file holds it, with the other wording, and the page as it is.
    const asked: Array<{ source: PageSource; text?: string }> = [];
    const source: PageSource = { name: "Tone", set: "strut/concepts/", file: "Tone.md", checkout: "strut" };
    const fromGit = (propose: ConceptSources["propose"]) =>
      createTrials({
        dataDir: dir,
        graph: backend,
        claims: { reader: strut.claims } as never,
        verifier: { verifyRun: async () => ({}) },
        store,
        sources: {
          fromGit: async () => new Map([["Tone", source]]),
          pageOf: async () => ({ ref_id: view.ref_id, page: { name: "Tone", description: "how replies sound", attributes: { description: "how replies sound" }, parents: [], docs: "Be polite.", stamp: "" }, text: "" }),
          propose,
        } as unknown as ConceptSources,
        hasWorkflow: async () => true,
        run: async () => {
          throw new Error("nothing runs here");
        },
      });
    const proposer = { workflow: "__run_step__", runId: "r1", path: "" };
    const dev = fromGit(async (changes) => {
      asked.push(...changes);
      return { proposed: [{ checkout: "strut", proposal: "p1", url: "/proposals/p1", pages: [{ name: "Tone", change: "edited" as const }] }], skipped: [] };
    });
    assert.deepEqual(await dev.use({ test: t.id, proposer }), { ok: true, proposed: { checkout: "strut", proposal: "p1", url: "/proposals/p1", pages: [{ name: "Tone", change: "edited" }] } });
    assert.deepEqual([asked[0]!.source, asked[0]!.text], [source, "---\nname: Tone\ndescription: how replies sound\n---\nBe terse.\n"]);
    assert.match((await dev.use({ test: t.id }) as { error: string }).error, /a change to it is a proposal into its checkout/);
    const nowhere = fromGit(async () => ({ proposed: [], skipped: [{ name: "Tone", change: "edited" as const, source: "strut/concepts/Tone.md", why: "this strut server runs from a build" }] }));
    assert.match((await nowhere.use({ test: t.id, proposer }) as { error: string }).error, /ships, and it is not changed here: this strut server runs from a build/);
    assert.equal((await trials.checks("Tone"))!.docs, "Be polite.", "nothing was written");

    assert.deepEqual(ok(await trials.use({ test: t.id, by: "ada" })), { ok: true, landed: true });
    const now = (await trials.checks("Tone"))!;
    assert.equal(now.docs, "Be terse.");
    assert.equal(now.version, t.change.version, "the page is the wording that was tested");
    const flipped = now.tests[0]!;
    assert.equal(flipped.live, true);
    assert.deepEqual([flipped.page.docs, flipped.change.docs], ["Be terse.", "Be polite."], "the same test, read from the page's new wording");
    assert.deepEqual(flipped.page.samples[added.id]!.map((s) => s.supports), [false, false], "the verdicts on a wording stay with it");
    assert.deepEqual(now.checks[0]!.samples.map((s) => s.supports), [false, false]);

    // A third wording: the earlier test is no longer about the page, and is still shown.
    ok(await trials.test({ concept: "Tone", docs: "Be polite and brief.", n: 1 }));
    const third = await settled(strut, "Tone");
    assert.equal(third.tests.length, 2);
    ok(await trials.use({ test: third.tests[0]!.id }));
    const last = (await trials.checks("Tone"))!;
    assert.equal(last.docs, "Be polite and brief.");
    const old = last.tests.find((x) => x.id === t.id)!;
    assert.equal(old.live, false);
    assert.match((await trials.test({ test: old.id, n: 1 }) as { error: string }).error, /neither wording/);
    assert.match((await trials.use({ test: old.id }) as { error: string }).error, /neither wording/);
  });
});
