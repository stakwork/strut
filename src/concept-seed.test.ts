import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { PERSONAL_CONCEPTS, conceptFiles, parseConceptFile, planConceptSeed, renderConceptPage, seedConcepts, stampOf, STRUT_CONCEPTS, type ConceptSet } from "./concept-seed.js";
import graphGet from "./steps/lib/graph/graph-get.js";
import { builderSystem, renderBuilderSystem } from "./ai/builder-system.js";
import conceptStep, { renderConceptSection } from "./steps/lib/context/concept.js";
import { accessedNodesOf, defineStep } from "./core.js";
import { runSingleStep } from "./run-step.js";
import { z } from "zod";
import { createRegistry } from "./steps/registry.js";
import { createStrut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import { MemoryChatStore } from "./chat-store.js";
import type { GraphBackend } from "./graph/backend.js";
import { seedStrutDomain } from "./graph/schema-seed.js";
import { testBackends } from "./graph/test-util.js";
import { projectRun, runsThatRead } from "./graph/projector.js";
import { runWorkflow } from "./runner.js";

describe("concept files (pure)", () => {
  it("parses front matter into description + parent, the body into docs, and stamps the file", () => {
    const text = "---\ndescription: What it is.\nparent: Root\n---\nThe page.\n";
    assert.deepEqual(parseConceptFile("Child.md", text, "p/"), {
      name: "Child",
      description: "What it is.",
      attributes: { description: "What it is." },
      parents: ["Root"],
      docs: "The page.",
      stamp: stampOf("Child.md", text, "p/"),
    });
    assert.match(stampOf("Child.md", text, "p/"), /^p\/Child\.md@[0-9a-f]{12}$/);
    assert.deepEqual(parseConceptFile("Bare.md", "just docs", "p/"), { name: "Bare", attributes: {}, parents: [], docs: "just docs", stamp: stampOf("Bare.md", "just docs", "p/") });
  });

  it("reads the new form: named by `name` whatever its file, every attribute, every parent — and nothing the graph stamps or derives", () => {
    const text = "---\nname: acme/linear\ndescription: The tracker's code\nrepo: acme/linear\nalt_names: [Linear code]\nref_id: r-1\nunique_source_id: someone/else@1\ntext_embeddings: [0.1]\ndocs: not the body\nparents:\n  - Law\n  - Repos\n---\nIts README.\n";
    assert.deepEqual(parseConceptFile("anything.md", text, "p/"), {
      name: "acme/linear",
      description: "The tracker's code",
      attributes: { description: "The tracker's code", repo: "acme/linear", alt_names: ["Linear code"] },
      parents: ["Law", "Repos"],
      docs: "Its README.",
      stamp: stampOf("anything.md", text, "p/"),
    });
    assert.deepEqual(parseConceptFile("law.md", "---\nname: Law\nparents: Root\n---\n", "p/").parents, ["Root"], "one parent may be written bare");
    assert.deepEqual(parseConceptFile("law.md", "---\nname: Law\n---\n", "p/").parents, []);
    assert.throws(() => parseConceptFile("n.md", "---\nname: 2024\n---\n", "p/"), /a page's name is a string/);
    assert.throws(() => parseConceptFile("n.md", "---\nname: ''\n---\n", "p/"), /a page's name is a string/);
    assert.throws(() => parseConceptFile("n.md", "---\nname: N\nparents: [1]\n---\n", "p/"), /parents is a list of Concept names/);
  });

  it("reads a page's claims block in either form: each claim's sentence and its cases, never an attribute, never the page's docs", () => {
    const block = ["claims:", "  - text: It says yes.", "    workflow: orchestrator", "    cases:", "      - prompt: Can you use bash?", "      - prompt: Can you read a PDF?", "  - text: It is brief."].join("\n");
    const claims = [
      { text: "It says yes.", cases: [{ workflow: "orchestrator", input: { prompt: "Can you use bash?" } }, { workflow: "orchestrator", input: { prompt: "Can you read a PDF?" } }] },
      { text: "It is brief.", cases: [] },
    ];
    const old = parseConceptFile("Rules.md", `---\ndescription: The rules\n${block}\n---\nBe kind.\n`, "p/");
    assert.deepEqual([old.name, old.attributes, old.docs, old.claims], ["Rules", { description: "The rules" }, "Be kind.", claims]);
    const now = parseConceptFile("r.md", `---\nname: Rules\ndescription: The rules\n${block}\n---\nBe kind.\n`, "p/");
    assert.deepEqual([now.attributes, now.claims], [{ description: "The rules" }, claims], "not an attribute in the new form");
    assert.equal(parseConceptFile("Bare.md", "just docs", "p/").claims, undefined);
    // A block that is not one is left out, and the page is still a page: cases with no workflow to run them, a list of strings.
    assert.equal(parseConceptFile("Rules.md", "---\nclaims:\n  - text: x\n    cases:\n      - prompt: y\n---\nd", "p/").claims, undefined);
    assert.equal(parseConceptFile("Rules.md", "---\nclaims: [a, b]\n---\nd", "p/").docs, "d");
    // A claim names its checks as a workflow's claims block does; one that names none gets the standard check later.
    const checked = parseConceptFile("Rules.md", "---\nclaims:\n  - text: It bakes.\n    checks:\n      - { type: acme/pods/baked, policy: always }\n  - text: It is brief.\n---\nd", "p/");
    assert.deepEqual(checked.claims, [
      { text: "It bakes.", cases: [], checks: [{ type: "acme/pods/baked", policy: "always" }] },
      { text: "It is brief.", cases: [] },
    ]);
    assert.equal(parseConceptFile("Rules.md", "---\nclaims:\n  - text: x\n    checks: []\n---\nd", "p/").claims, undefined, "an empty list of checks is no block");
    // Writing the page's text back keeps the block byte for byte (a change of its docs is a diff of its docs).
    assert.ok(!renderConceptPage({ ...now, docs: "Be kinder." }).includes("claims"), "a page rendered anew carries no block");
  });

  it("renders a page that reads back as it was, byte for byte", () => {
    const page = { name: "acme/linear", attributes: { repo: "acme/linear", description: "Its code", alt_names: ["a", "b"] }, parents: ["Repos", "Law"], docs: "---\nIts README." };
    const text = renderConceptPage(page);
    assert.equal(text, "---\nname: acme/linear\nalt_names:\n  - a\n  - b\ndescription: Its code\nrepo: acme/linear\nparents:\n  - Law\n  - Repos\n---\n---\nIts README.\n");
    const back = parseConceptFile("concept-acmelinear.md", text, "p/");
    assert.deepEqual([back.name, back.attributes, back.parents, back.docs], [page.name, page.attributes, ["Law", "Repos"], page.docs]);
    assert.equal(renderConceptPage(back), text);
    assert.equal(renderConceptPage({ name: "Law", attributes: {}, parents: [] }), "---\nname: Law\n---\n", "a root with no docs");
  });

  it("plans create / keep / update / skip by the stamp, a legacy path counting as ours", () => {
    const stamp = "strut/concepts/Job.md@aaaaaaaaaaaa";
    const legacy = ["lab/job/concepts/Job.md@"];
    assert.equal(planConceptSeed(null, stamp), "create");
    assert.equal(planConceptSeed({ ref_id: "r", unique_source_id: stamp }, stamp), "keep");
    assert.equal(planConceptSeed({ ref_id: "r", unique_source_id: "strut/concepts/Job.md@bbbbbbbbbbbb" }, stamp), "update");
    assert.equal(planConceptSeed({ ref_id: "r", unique_source_id: stamp, deleted: true }, stamp), "update", "a deleted page of ours comes back");
    assert.equal(planConceptSeed({ ref_id: "r" }, stamp), "skip", "no stamp: a person's page");
    assert.equal(planConceptSeed({ ref_id: "r", unique_source_id: "other/Job.md@aaaaaaaaaaaa" }, stamp), "skip");
    assert.equal(planConceptSeed({ ref_id: "r", deleted: true }, stamp), "skip", "a person's deleted page stays deleted");
    assert.equal(planConceptSeed({ ref_id: "r", unique_source_id: "lab/job/concepts/Job.md@aaaaaaaaaaaa" }, stamp), "skip", "a legacy path counts only when the set names it");
    assert.equal(planConceptSeed({ ref_id: "r", unique_source_id: "lab/job/concepts/Job.md@aaaaaaaaaaaa" }, stamp, legacy), "keep", "same text: kept, stamp and all");
    assert.equal(planConceptSeed({ ref_id: "r", unique_source_id: "lab/job/concepts/Job.md@cccccccccccc" }, stamp, legacy), "update");

    // A seed always matches git: the same stamp over text edited in the
    // graph is put back; a field the file does not set is not the seed's.
    const file = { attributes: { description: "The job." }, docs: "How a job works." };
    const node = { ref_id: "r", unique_source_id: stamp, description: "The job.", docs: "How a job works." };
    assert.equal(planConceptSeed(node, stamp, [], file), "keep", "the file's text: nothing to write");
    assert.equal(planConceptSeed({ ...node, docs: "Edited in the graph." }, stamp, [], file), "update", "edited docs are put back");
    assert.equal(planConceptSeed({ ...node, description: "Edited." }, stamp, [], file), "update", "an edited description is put back");
    assert.equal(planConceptSeed({ ...node, description: "Added in the graph." }, stamp, [], { attributes: {}, docs: file.docs }), "keep", "a field the file does not set is left as it is");
    assert.equal(planConceptSeed({ ref_id: "r", docs: "A person wrote this." }, stamp, [], file), "skip", "a person's page stays theirs");

    // A package's set (`keepEdited`, plans/marketplace.md §3): an edit is kept,
    // and a deleted node under the name is taken — the install checked every live one.
    assert.equal(planConceptSeed({ ...node, docs: "Edited in the graph." }, stamp, [], file, true), "keep", "an edit made here stays");
    assert.equal(planConceptSeed(node, stamp, [], file, true), "keep");
    assert.equal(planConceptSeed({ ref_id: "r", unique_source_id: "other/Job.md@aaaaaaaaaaaa", deleted: true }, stamp, [], file, true), "update", "a deleted page is nobody's");
    assert.equal(planConceptSeed({ ref_id: "r", docs: "A person wrote this." }, stamp, [], file, true), "skip", "a live page of someone else's is never written");

    // Every attribute the file carries is compared, lists by value.
    const rich = { attributes: { description: "The job.", repo: "acme/x", alt_names: ["J"] }, docs: file.docs };
    assert.equal(planConceptSeed({ ...node, repo: "acme/x", alt_names: ["J"] }, stamp, [], rich), "keep");
    assert.equal(planConceptSeed({ ...node, repo: "acme/y", alt_names: ["J"] }, stamp, [], rich), "update", "an edited attribute is put back");
    assert.equal(planConceptSeed({ ...node, repo: "acme/x", alt_names: ["K"] }, stamp, [], rich), "update");

    // A package's set: any file of it is ours, and a page a release moved to
    // another file (the old form rebuilt under its key) is written again.
    const moved = "pkg/acme/x/concept-job.md@aaaaaaaaaaaa";
    assert.equal(planConceptSeed({ ref_id: "r", unique_source_id: "pkg/acme/x/Job.md@aaaaaaaaaaaa" }, moved, [], file, true, "pkg/acme/x/"), "update");
    assert.equal(planConceptSeed({ ref_id: "r", unique_source_id: "pkg/acme/xy/Job.md@aaaaaaaaaaaa" }, moved, [], file, true, "pkg/acme/x/"), "skip", "another package's page");
    assert.equal(planConceptSeed({ ref_id: "r", unique_source_id: "pkg/acme/x/Job.md@aaaaaaaaaaaa" }, moved, [], file, true), "skip", "only a package's set reads another file as its own");
  });

  it("ships Workflow Builder and Job as roots and App under Workflow Builder: one tree per agent, workspace-general, the legacy lab stamps named, Workflow Build and Job App retired", async () => {
    const read = async (file: string) => parseConceptFile(file, await readFile(join(STRUT_CONCEPTS.dir, file), "utf-8"), STRUT_CONCEPTS.prefix);
    const wb = await read("Workflow Builder.md");
    const job = await read("Job.md");
    for (const c of [wb, job]) {
      assert.deepEqual(c.parents, [], `${c.name} is a root`);
      assert.ok(c.description && c.docs?.includes("PARENT_OF"), c.name);
    }
    // One tree per agent: `Workflow Build` — the builder's entry under Job,
    // there only while the orchestrator read Job alone — is retired, and a
    // job agent's way to the builder is in Job's own docs: a workflow or an
    // app published here or on a peer, met on a job, it runs the builder for,
    // on a thread of its own, rather than bouncing it back to the person.
    assert.deepEqual(STRUT_CONCEPTS.retired, ["Workflow Build.md", "Job App.md"]);
    assert.ok(job.docs!.includes('meta/run-workflow { name: "builder", input: { prompt, session: "<your job id>/build", peer } }'), job.docs);
    assert.ok(job.docs!.includes("an APP published here or on a peer") && job.docs!.includes("`Workflow Builder` Concept"), job.docs);
    // `{{ input.urls.pod }}` is strut's own: the address a job's check
    // reaches what the job holds at (browser/verify's description has it).
    for (const c of [wb, job]) assert.doesNotMatch(c.docs!, /hive|@<slug>|(?<!input\.urls\.)\bpod\b|pull request/i, `${c.name} names nothing one deployment has`);
    // Looking at a site is a kind of job work, with a page of its own.
    const browser = await read("Browser.md");
    assert.deepEqual(browser.parents, ["Job"]);
    assert.ok(browser.description && browser.docs!.includes("browser-explore") && browser.docs!.includes("[captcha-answer]"));
    assert.doesNotMatch(browser.docs!, /hive|@<slug>|\bpod\b|pull request/i, "Browser names nothing one deployment has");
    // The App page (plans/apps.md §8): the builder's prompt for an app, one
    // of the kinds under Workflow Builder — the layout, the kit's hooks,
    // the grants, routines, the four shapes.
    const app = await read("App.md");
    assert.deepEqual(app.parents, ["Workflow Builder"]);
    for (const must of ["app.yaml", "grants", "useLaunch", "useRun", "never on a render", "llm", "@/components/ui", "strut/views", "app/build", "app/publish", "wallet:", "useWallet", "useTransaction", "Pending is not failed", "Packages → Repos", "never `ghost`"]) assert.ok(app.docs!.includes(must), must);
    assert.doesNotMatch(app.docs!, /hive|@<slug>|\bpod\b/i, "names nothing one deployment has");
    // A game is a kind of app: its page under App, read when the builder
    // makes one — the starter, the loop, input, assets, physics, the look.
    const game = await read("Game.md");
    assert.deepEqual(game.parents, ["App"]);
    for (const must of ['template: "game"', "useFrame", "touch-action: none", "useGLTF", "data: URL", "useAppState", "useChannel", "permissions:", "window.__debug", "keydown"]) assert.ok(game.docs!.includes(must), must);
    assert.doesNotMatch(game.docs!, /hive|@<slug>|\bpod\b/i, "names nothing one deployment has");
    // Work by people is a kind the builder builds, and the page the
    // assistant opens before the build: what the person decides (when there
    // is work, who, the pay), in their words, and what they do once it is
    // built. Workspace-general: no one deployment's task.
    const work = await read("Worker Tasks.md");
    assert.deepEqual(work.parents, ["Workflow Builder"]);
    for (const must of ["ONE message", "Any time, as many as they like", "One for each item", "Only people you invite", "in dollars", "Never ask about the rest", "strut/staff", "strut/earnings", "standing: { workflow }", "open: false", "never turn dollars into", "a round goes out when the person says so", "never theirs to hear about", "Invite a worker", "open work only", "What is built in", "never in an admin app", "task/report", "task/grant", "perWorkerDay", "strut/worker", "Show the WORKER PAGE too", "paid from their first one", "round: { workflow }", "Send a round", "Earnings is named in words alone, never shown"]) assert.ok(work.docs!.includes(must), must);
    // A worker app goes public with every workflow it grants, runs and all:
    // the person's reports stay out of it (a built app once hid a Reports tab
    // behind `useHost().public` while its workflow's runs were open to anyone).
    assert.ok(app.docs!.includes("keep the person's reports out of it") && app.docs!.includes("locks nothing"), "App: no reports in a worker app");
    assert.ok(work.docs!.includes("never in\n  the worker app"), "Worker Tasks: no reports in the worker app");
    // Ruling 12: open paid work needs no qualifying test first.
    assert.doesNotMatch(work.docs!, /first needs a short qualifying test/, "open paid work is not held for a test");
    assert.doesNotMatch(work.docs!, /hive|@<slug>|\bpod\b|coffee/i, "names nothing one deployment has");
    // A worker app's links are shared from Workers, which opens with
    // them (a QR code, Invite): every page points there, none pastes a link.
    for (const c of [wb, app, work]) {
      assert.ok(c.docs!.includes("strut/staff"), `${c.name} points to Workers`);
      assert.match(c.docs!, /never\s+paste\s+a\s+link/, `${c.name}: no link pasted in a reply`);
      assert.doesNotMatch(c.docs!, /hand the person `peelLink`|give the person the `peelLink`/, `${c.name}: no pasted peelLink`);
    }
    // No job side of an app (retired 2026-10-22, with the `Job App` page):
    // an app is the builder's, handed over by NAME — the job agent passes
    // the builder's deliverable on — and a page over the job's own results
    // is an HTML file in its directory. The App page says the same to the
    // builder: hand it over by name, never as a directory.
    assert.ok(job.docs!.includes('{ kind: "app", app: "<name>" }'), job.docs);
    assert.ok(job.docs!.includes("HTML page in your directory"), job.docs);
    assert.ok(!job.docs!.includes("Job App") && !job.docs!.includes("app/init"), "nothing points at the retired kind");
    assert.ok(app.docs!.includes('{ id, kind:\n"app", title, app: "<name>" }') || app.docs!.includes('app: "<name>"'), "the builder hands an app over by name");
    assert.ok(app.docs!.includes("never hand over an app directory"), "an app is never a file deliverable");
    assert.ok(!app.docs!.includes("## A job's app"), "App stays the builders' manual");
    assert.deepEqual(STRUT_CONCEPTS.legacyPrefixes, ["lab/builder/concepts/", "lab/job/concepts/"]);
  });

  it("ships Plan under Job: what the plan file holds, and claims with their cases in place of a rule per failure", async () => {
    const plan = parseConceptFile("Plan.md", await readFile(join(STRUT_CONCEPTS.dir, "Plan.md"), "utf-8"), STRUT_CONCEPTS.prefix);
    // A kind of job work: the orchestrator lists it by its description and
    // passes it as `kind`, and the job opens it every turn.
    assert.deepEqual(plan.parents, ["Job"]);
    // The description is the one line the orchestrator routes by. It says a JOB writes the plan, whatever
    // the work is made of: without that, asked to plan a workflow and an app, a real model wrote the plan
    // in its own reply and started no plan job (2026-11-21).
    assert.match(plan.description!, /A job writes the plan/);
    assert.match(plan.description!, /code in repositories, workflows and apps here, documents/);
    // The file's parts are named, since several agents read and write it;
    // the person reads the reply alone.
    for (const must of ["`plan.md`", "Work items", "Contracts", "Open questions", "each with a default", "Progress", '"Go" takes every default']) assert.ok(plan.docs!.includes(must), must);
    // plans/orchestrator-plans.md, ruling 7: what goes wrong (access control
    // built too deep, a migration nobody needs) is a CASE of the page's one
    // claim, never a rule on the page.
    assert.doesNotMatch(plan.docs!, /auth|token|migrat|backward/i, "no rule per failure");
    assert.doesNotMatch(plan.docs!, /hive|@<slug>|\bpod\b/i, "names nothing one deployment has");
    // A plan need not be about code at all (ruled 2026-11-21): the page
    // speaks of a repository in one sentence, which applies only to work
    // that is in one, and an item names repositories only if it has any.
    assert.equal(plan.docs!.match(/repositor/g)?.length, 2);
    assert.match(plan.docs!, /Work in\s+a repository goes on one branch there for the whole plan, and ends as\s+one pull request\./);
    assert.match(plan.docs!, /its repositories if it has any/);
    // The person may never have built software, or may be a developer (2026-11-22): the questions are about
    // what gets built, in words the person can answer; how it is built the job decides and records, where a
    // developer reads it. And a plan always looks for a smaller one.
    assert.match(plan.docs!, /someone\s+who\s+has\s+never\s+built\s+software\s+can\s+answer\s+it,\s+unless\s+the\s+request\s+shows\s+the\s+person\s+builds\s+software\s+themselves/);
    // Few questions, whatever the brief lists: the orchestrator's real briefs ("Consider: … unit conversion, stock
    // tracking, saving past days, scaling") drew 6 to 8 questions, a bakery owner's whole conversation 7 and 8
    // (2026-11-22). The number is how many there often are, never a cap: a plan can be a dozen lines or a thousand,
    // and a large one can have ten real questions. The smaller plan is planned and its cuts named, not each asked.
    assert.match(plan.docs!, /the few whose answer would\s+change the plan, often three or four\./);
    assert.doesNotMatch(plan.docs!, /at most|\bmust\b|never more/, "no hard cap on the questions");
    assert.match(plan.docs!, /Every other\s+choice is yours, how it is built above all, even when the request\s+raises it/);
    assert.match(plan.docs!, /First look for a smaller plan[^]*plan that one, and say what it leaves out/);
    // The questions are the reply's `ask`, named beside `text`, and tied to the job's own rule for one ("if you
    // cannot go on without a decision"): with defaults on every question, the real briefs left them in the text
    // 4 times of 6 on main's page; with the reason, 13 of 15 cases sent `ask` (2026-11-22).
    assert.match(plan.docs!, /a short overview as\s+your `text`, and the questions as your `ask`, since you cannot go on\s+without their go/);
    assert.match(plan.docs!, /The detail is in `plan\.md`\s+for whoever wants it/);
    // The review reads the item's work (its job, what it published), not the reply that hands it back: told
    // "finished and verified", the plan's job only edited its file (2026-11-22, a whole conversation).
    assert.match(plan.docs!, /Check what it made against\s+the plan, from its job's work rather than the report/);
    assert.equal(plan.claims?.length, 2);
    assert.deepEqual(
      plan.claims!.map((claim) => claim.cases.map((c) => [c.workflow, (c.input as { kind?: string }).kind])),
      [
        [
          ["job", "Plan"],
          ["job", "Plan"],
        ],
        [
          ["job", "Plan"],
          ["job", "Plan"],
        ],
      ],
      "each case is a plan job",
    );
  });

  it("ships Dream as a root with a page per kind of source under it: the dream's rules, general, none of them naming a kind of task", async () => {
    const read = async (file: string) => parseConceptFile(file, await readFile(join(STRUT_CONCEPTS.dir, file), "utf-8"), STRUT_CONCEPTS.prefix);
    const dream = await read("Dream.md");
    assert.deepEqual(dream.parents, [], "a root: the dream's own tree");
    assert.ok(dream.description && dream.docs?.includes("PARENT_OF"), "says its children are the sources");
    // What holds for any source: the posture, what a lesson is, the three things, where a lesson goes.
    for (const must of ["You tend a tree of Concepts", "## What is a lesson", "THE CLAIM.", "WHAT WAS SAID.", "THE CHANGE.", "## Where a lesson goes", "stuck", "Never\nrewrite a page"]) assert.ok(dream.docs!.includes(must), must);
    // A root is never edited, only the pages under it (ruled 2026-11-13): a lesson for almost every turn is a page
    // directly under the root, whose description the assistant always sees in the root's list.
    assert.ok(dream.docs!.includes("never the root itself") && dream.docs!.includes("a page directly under the\n  root"), dream.docs);
    assert.doesNotMatch(dream.docs!, /docs of the tree's\s+root/);
    // The dream changes the tree itself; review is the tree's switch, said by the tool's answer (ruled 2026-11-13).
    assert.match(dream.docs!, /Make the smallest change[^]*make it now/);
    assert.doesNotMatch(dream.docs!, /nothing changes until|A person decides each one/);
    // The page such a lesson goes on may not exist yet (made later in the run, or waiting on a person): its claim is
    // written now, on the page the new one will sit under (a real model held it back otherwise).
    assert.match(dream.docs!, /does not exist yet, write the claim on the page the new one\s+will sit under/);
    // A page from git is put back on every start, so where a change to one is skipped (a deployed strut), the
    // lesson goes on a page under it, the workspace's own (2026-11-22): otherwise a box never learns about a page
    // strut ships, such as Plan.
    assert.match(dream.docs!, /comes from git, and a change to it is skipped[^]*Make the change on a page under it instead/);
    // The first source: the conversations dream/turns hands over.
    const convs = await read("Assistant Conversations.md");
    assert.deepEqual(convs.parents, ["Dream"]);
    for (const must of ["PERSON", "ASSISTANT", "cancelled", "OPENED", "not known"]) assert.ok(convs.docs!.includes(must), must);
    for (const c of [dream, convs]) assert.doesNotMatch(c.docs!, /hive|@<slug>|\bpod\b|pull request|knowledge_|graph_/i, `${c.name}: no deployment, no tool's name (the workflow says how a tool is called)`);
  });

  it("ships Personal as a root of its own set, kept as shipped, and apart from strut's pages", async () => {
    const file = "Personal.md";
    const c = parseConceptFile(file, await readFile(join(PERSONAL_CONCEPTS.dir, file), "utf-8"), PERSONAL_CONCEPTS.prefix);
    assert.deepEqual(c.parents, [], "a root");
    assert.ok(c.description && c.docs?.includes("PARENT_OF"), "says how to walk it");
    assert.doesNotMatch(c.docs!, /hive|@<slug>|\bpod\b|workspace/i, "names nothing one deployment has");
    assert.equal(PERSONAL_CONCEPTS.keepEdited, undefined, "the page is strut's; the person's knowledge is its children");
    assert.notEqual(PERSONAL_CONCEPTS.dir, STRUT_CONCEPTS.dir);
  });

  it("renders the builder's section: the page, its kinds, and how to open one", () => {
    const text = renderBuilderSystem({ name: "Workflow Builder", docs: "The notes.", children: [{ name: "Janitor", description: "Cleans up." }], more: true });
    assert.match(text, /^Knowledge on this server — the "Workflow Builder" Concept/);
    assert.ok(text.includes("The notes.") && text.includes("- Janitor — Cleans up.") && text.includes("… and more"));
    assert.ok(text.includes('graph_get({ node_type: "Concept", name: "<name>", children: "PARENT_OF" })'));
    assert.ok(!renderBuilderSystem({ name: "Workflow Builder", children: [] }).includes("Kinds recorded"));
    assert.ok(renderBuilderSystem({ name: "W", docs: "x".repeat(7000), children: [] }).includes(`${"x".repeat(6000)}…`), "docs are capped");
    const job = renderConceptSection({ name: "Job", children: [{ name: "Explore" }] }, "graph_graph_get");
    assert.ok(job.includes('graph_graph_get({ node_type: "Concept", name: "<name>", children: "PARENT_OF" })'), "the tool the agent calls");
    assert.ok(job.includes("- Explore\n"));
  });

  it("a page strut ships is read from its file where there is no graph: by name through graph/graph-get, so context/concept renders it and the pages under it open the same way", async () => {
    const files = conceptFiles([STRUT_CONCEPTS]);
    const job = (await files.get("Job"))!;
    assert.equal(job.ref_id, "file:strut/concepts/Job.md", "the file's own ref, never a node's");
    assert.ok(job.docs!.includes("To record a new kind, add a child Concept here"));
    assert.deepEqual(job.parents, []);
    assert.ok(job.children.some((c) => c.name === "Plan" && c.description), "its kinds: the pages that name it as a parent");
    assert.equal((await files.get("workflow builder"))!.name, "Workflow Builder", "by name as a Concept's key reads it: case and spaces ignored");
    assert.equal((await files.get(job.ref_id))!.name, "Job", "or by the ref a read gave");
    assert.equal(await files.get("Nope"), undefined);

    // graph/graph-get, no graph: the page in the step's own shape, with no connection attempt.
    const services = { conceptFiles: files };
    const get = (config: Record<string, unknown>) => graphGet.run(graphGet.input.parse(config), { services } as never) as Promise<Record<string, any>>;
    const read = await get({ node_type: "Concept", name: "Job", children: "PARENT_OF" });
    assert.deepEqual([read["ref_id"], read["node_type"], read["name"], read["source"]], [job.ref_id, "Concept", "Job", "file"]);
    assert.equal(read["properties"].docs, job.docs);
    assert.equal(read["properties"].description, "The kinds of work a job agent has a way to do here, and how to do each.");
    assert.deepEqual(read["children"].map((c: { name: string }) => c.name), job.children.map((c) => c.name));
    assert.ok(read["children"].every((c: { node_type: string; ref_id: string }) => c.node_type === "Concept" && c.ref_id.startsWith("file:")));
    assert.equal(read["edges"].PARENT_OF, job.children.length);
    assert.equal((await get({ node_type: "Concept", name: "Job" }))["children"], undefined, "no table of contents unless asked");
    const plan = await get({ ref_id: read["children"].find((c: { name: string }) => c.name === "Plan").ref_id });
    assert.deepEqual([plan["name"], plan["edges"]["<-PARENT_OF"]], ["Plan", 1], "a child opens by the ref the list gave");

    // context/concept: the same section a graph would give.
    const run = (config: Record<string, unknown>, sv: Record<string, unknown> = services) => conceptStep.run(conceptStep.input.parse(config), { services: sv } as never);
    const out = await run({ name: "Job", max: 10000 });
    assert.ok(out.text.startsWith('Knowledge on this server — the "Job" Concept'), out.text.slice(0, 80));
    assert.ok(out.text.includes("The work is done when it is VERIFIED") && out.text.includes("To record a new kind, add a child Concept here"), "the page's docs, whole under the cap the job gives it");
    assert.ok(out.text.includes("- Browser — Looking at a site or a running app"), "its kinds");
    assert.ok(out.text.includes('graph_graph_get({ node_type: "Concept", name: "<name>"'), "opened with the same tool");
    assert.equal(accessedNodesOf(out)?.length ?? 0, 0, "no node was read");
    const rules = await run({ name: "Orchestrator", frame: false, max: 20000 });
    assert.match(rules.text, /^You are a person's assistant, in one long conversation with them\./, "an agent's rules, as they are");
    assert.deepEqual(await run({ name: "Nope" }), { text: "" }, "a name strut does not ship: nothing, and no connection attempt");
    assert.deepEqual(await run({ name: "Job" }, {}), { text: "" }, "no files either: nothing");
  });

  it("context/concept with no name renders nothing, graph or not (a template naming no page)", async () => {
    assert.deepEqual(await conceptStep.run(conceptStep.input.parse({}), { services: {} } as never), { text: "" });
    assert.deepEqual(await conceptStep.run(conceptStep.input.parse({ name: undefined }), { services: { graph: {} } } as never), { text: "" });
  });

  it("renders the kinds alone (docs: false) for an agent that routes by them, with no opener when it has no tool, and nothing when there are no kinds", () => {
    const page = { name: "Job", docs: "The job agent's instructions.", children: [{ name: "Explore", description: "Finding out." }] };
    const kinds = renderConceptSection(page, "", { docs: false });
    assert.match(kinds, /^Knowledge on this server — the "Job" Concept/);
    assert.ok(kinds.includes("- Explore — Finding out."));
    assert.ok(!kinds.includes("The job agent's instructions.") && !kinds.includes("(no docs)"), "the page's docs are not for this reader");
    assert.ok(!kinds.includes("OPEN ITS PAGE") && !kinds.includes("node_type"), "no way to open a page is named");
    const opener = renderConceptSection(page, "graph_graph_get", { docs: false });
    assert.ok(opener.includes('A kind\'s page — graph_graph_get({ node_type: "Concept", name: "<name>", children: "PARENT_OF" })'), "with a tool, how to open one — never 'follow its convention'");
    assert.ok(!opener.includes("OPEN ITS PAGE FIRST"));
    assert.equal(renderConceptSection({ name: "Job", docs: "x", children: [] }, "", { docs: false }), "", "no kinds, nothing to route by");
    // A page that IS an agent's rules (`frame: false`): its docs alone, as they are, up to `max`.
    assert.equal(renderConceptSection({ name: "Orchestrator", docs: "  You are an assistant.\n", children: [{ name: "A kind" }] }, "graph_graph_get", { frame: false }), "You are an assistant.");
    assert.equal(renderConceptSection({ name: "Orchestrator", children: [] }, "graph_graph_get", { frame: false }), "", "no docs: nothing, so a prompt falls back to its own");
    assert.equal(renderConceptSection({ name: "O", docs: "x".repeat(7000), children: [] }, "", { frame: false, max: 20000 }).length, 7000, "the cap is the step's to raise");
    assert.equal(renderConceptSection({ name: "O", docs: "x".repeat(7000), children: [] }, "", { frame: false }), `${"x".repeat(6000)}…`);
    assert.ok(!renderConceptSection(page, "", { docs: true }).includes("OPEN ITS PAGE"), "with docs and no tool, the docs and the kinds, no opener");
  });
});

for (const tb of testBackends()) {
  describe(`seedConcepts (${tb.name})`, { skip: tb.skip }, () => {
    let b: GraphBackend;
    let dir: string;
    const set = (extra: Partial<ConceptSet> = {}): ConceptSet => ({ dir, prefix: "test/concepts/", ...extra });
    const page = (name: string, body: string, front: Record<string, string> = {}) => {
      const fm = Object.entries(front).map(([k, v]) => `${k}: ${v}`);
      return writeFile(join(dir, `${name}.md`), `${fm.length ? `---\n${fm.join("\n")}\n---\n` : ""}${body}\n`);
    };
    const props = async (ref_id: string) => (await b.tx((tx) => b.nodeEngine.readRaw(tx, ref_id)))!.props;
    const children = async (ref_id: string) => {
      const out = await b.tx((tx) => b.edgeEngine.liveEdgesOf(tx, ref_id, "PARENT_OF", true));
      return (out?.edges ?? []).map((e) => e.other).sort();
    };
    const concept = async (name: string, data: Record<string, unknown> = {}) => (await b.nodes.write({ type: "Concept", data: { name, ...data } })).ref_id;
    const byName = (outcomes: Awaited<ReturnType<typeof seedConcepts>>) => Object.fromEntries(outcomes.map((o) => [o.name, o]));

    before(async () => {
      b = await tb.open();
    });
    after(async () => {
      await tb.close(b);
    });
    beforeEach(async () => {
      await tb.wipe(b);
      if (b.kind === "neo4j") await seedStrutDomain(b);
      dir = await mkdtemp(join(tmpdir(), "strut-concepts-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("creates the pages and their tree, then keeps them; every boot puts a graph-side edit back to the file's text", async () => {
      await page("Root", "The root page.", { description: "The root." });
      await page("Child", "A kind.", { description: "One kind.", parent: "Root" });
      const first = byName(await seedConcepts(b, [set()]));
      assert.equal(first["Root"]!.action, "create");
      assert.equal(first["Child"]!.action, "create");
      const root = first["Root"]!.ref_id!;
      const child = first["Child"]!.ref_id!;
      assert.deepEqual(await children(root), [child]);
      const p = await props(root);
      assert.equal(p["docs"], "The root page.");
      assert.equal(p["description"], "The root.");
      assert.match(String(p["unique_source_id"]), /^test\/concepts\/Root\.md@[0-9a-f]{12}$/);

      const again = byName(await seedConcepts(b, [set()]));
      assert.deepEqual([again["Root"]!.action, again["Child"]!.action], ["keep", "keep"], "the file's text: nothing written");

      await b.nodes.update(root, { set: { docs: "Edited in the graph." } });
      const second = byName(await seedConcepts(b, [set()]));
      assert.deepEqual([second["Root"]!.action, second["Child"]!.action], ["update", "keep"]);
      assert.equal(second["Root"]!.ref_id, root, "same node");
      assert.equal((await props(root))["docs"], "The root page.", "a seed always matches git");
      assert.deepEqual(await children(root), [child], "the edge is merged, never duplicated");

      await page("Root", "The root page, revised.", { description: "The root." });
      const third = byName(await seedConcepts(b, [set()]));
      assert.equal(third["Root"]!.action, "update");
      assert.equal(third["Root"]!.ref_id, root, "same node");
      assert.equal((await props(root))["docs"], "The root page, revised.");
    });

    it("writes a new-form page's attributes and a PARENT_OF from each parent, leaves out what the graph does not declare, and keeps every edge it declares", async () => {
      await page("Root", "r");
      await page("Other", "o");
      await writeFile(join(dir, "task.md"), "---\nname: acme/task\nrepo: acme/task\njurisdiction: Delaware\nparents:\n  - Other\n  - Root\n---\nThe task.\n");
      const out = byName(await seedConcepts(b, [set()]));
      assert.deepEqual([out["acme/task"]!.action, out["acme/task"]!.file], ["create", "task.md"]);
      const task = out["acme/task"]!.ref_id!;
      const p = await props(task);
      assert.deepEqual([p["name"], p["repo"], p["jurisdiction"] ?? null, p["docs"]], ["acme/task", "acme/task", null, "The task."]);
      assert.match(String(p["unique_source_id"]), /^test\/concepts\/task\.md@/);
      assert.deepEqual(await children(out["Root"]!.ref_id!), [task]);
      assert.deepEqual(await children(out["Other"]!.ref_id!), [task]);

      const again = byName(await seedConcepts(b, [set()]));
      assert.equal(again["acme/task"]!.action, "keep", "what the graph does not declare is no edit");
      assert.deepEqual(await children(out["Root"]!.ref_id!), [task], "both declared edges kept");
      assert.deepEqual(await children(out["Other"]!.ref_id!), [task]);
      await b.nodes.update(task, { set: { repo: "acme/other" } });
      assert.equal(byName(await seedConcepts(b, [set()]))["acme/task"]!.action, "update");
      assert.equal((await props(task))["repo"], "acme/task", "a seed always matches git");
    });

    it("brings back a deleted page of its own, and leaves a person's page alone while parenting under it", async () => {
      await page("Root", "The root page.");
      const root = byName(await seedConcepts(b, [set()]))["Root"]!.ref_id!;
      assert.ok(await b.nodeEngine.softDelete(root, b.namespace, { type: "Concept" }));
      assert.ok((await props(root))["deleted_at"] != null);
      assert.equal(byName(await seedConcepts(b, [set()]))["Root"]!.action, "update");
      assert.equal((await props(root))["deleted_at"] ?? null, null, "restored in place");

      const theirs = await concept("Theirs", { docs: "A person wrote this." });
      await page("Theirs", "The file's version.");
      await page("Under", "Hangs under a person's page.", { parent: "Theirs" });
      const out = byName(await seedConcepts(b, [set()]));
      assert.equal(out["Theirs"]!.action, "skip");
      assert.equal((await props(theirs))["docs"], "A person wrote this.");
      assert.equal((await props(theirs))["unique_source_id"] ?? null, null);
      assert.deepEqual(await children(theirs), [out["Under"]!.ref_id]);
    });

    it("counts a legacy stamp as its own: the same text kept as it is, a changed one taken over", async () => {
      const text = "---\ndescription: Same.\n---\nSame text.\n";
      await writeFile(join(dir, "Same.md"), text);
      await page("Moved", "New text.");
      const same = await concept("Same", { description: "Same.", docs: "Same text.", unique_source_id: stampOf("Same.md", text, "old/") });
      const moved = await concept("Moved", { docs: "Old text.", unique_source_id: "old/Moved.md@000000000000" });
      const out = byName(await seedConcepts(b, [set({ legacyPrefixes: ["old/"] })]));
      assert.equal(out["Same"]!.action, "keep");
      assert.equal((await props(same))["unique_source_id"], stampOf("Same.md", text, "old/"), "nothing written");
      assert.equal(out["Moved"]!.action, "update");
      assert.equal(out["Moved"]!.ref_id, moved);
      assert.equal((await props(moved))["docs"], "New text.");
      assert.match(String((await props(moved))["unique_source_id"]), /^test\/concepts\/Moved\.md@/);
    });

    it("removes a PARENT_OF between its own pages that no file declares, and no other", async () => {
      await page("Root", "r");
      await page("Child", "c", { parent: "Root" });
      await page("Loose", "l");
      const out = byName(await seedConcepts(b, [set()]));
      const [root, child, loose] = [out["Root"]!.ref_id!, out["Child"]!.ref_id!, out["Loose"]!.ref_id!];
      const foreign = await concept("Foreign");
      await b.edges.write({ edge: "PARENT_OF", source_ref_id: root, target_ref_id: loose });
      await b.edges.write({ edge: "PARENT_OF", source_ref_id: root, target_ref_id: foreign });
      await seedConcepts(b, [set()]);
      assert.deepEqual(await children(root), [child, foreign].sort());
    });

    it("retires a file's page only while it still carries that file's stamp", async () => {
      await page("Old", "o");
      await page("Taken", "t");
      const out = byName(await seedConcepts(b, [set()]));
      await b.nodes.update(out["Taken"]!.ref_id!, { remove: ["unique_source_id"] });
      await rm(join(dir, "Old.md"));
      await rm(join(dir, "Taken.md"));
      await seedConcepts(b, [set({ retired: ["Old.md", "Taken.md"] })]);
      assert.ok((await props(out["Old"]!.ref_id!))["deleted_at"] != null);
      assert.equal((await props(out["Taken"]!.ref_id!))["deleted_at"] ?? null, null);
    });

    it("the `Workflow Build` page an earlier strut seeded under Job goes at the next boot", async () => {
      await seedConcepts(b, [STRUT_CONCEPTS]);
      // What strut shipped until the orchestrator read both roots: the
      // builder's entry under Job, under strut's own stamp.
      await page("Workflow Build", "A builder job.", { description: "Build a WORKFLOW.", parent: "Job" });
      const old = byName(await seedConcepts(b, [set({ prefix: STRUT_CONCEPTS.prefix })]))["Workflow Build"]!;
      assert.equal(old.action, "create");
      const strut = byName(await seedConcepts(b, [STRUT_CONCEPTS]));
      assert.ok((await props(old.ref_id!))["deleted_at"] != null, "retired");
      assert.deepEqual(await children(strut["Job"]!.ref_id!), [strut["Browser"]!.ref_id!, strut["Plan"]!.ref_id!].sort(), "Job keeps only what strut ships under it: Browser and Plan, since Job App went too");
    });

    it("the `Job App` page an earlier strut seeded under Job goes at the next boot", async () => {
      await page("Job App", "Hand over an app.", { description: "Hand over an interactive app as a deliverable.", parent: "Job" });
      const old = byName(await seedConcepts(b, [set({ prefix: STRUT_CONCEPTS.prefix })]))["Job App"]!;
      assert.equal(old.action, "create");
      const strut = byName(await seedConcepts(b, [STRUT_CONCEPTS]));
      assert.ok((await props(old.ref_id!))["deleted_at"] != null, "retired");
      assert.deepEqual(await children(strut["Job"]!.ref_id!), [strut["Browser"]!.ref_id!, strut["Plan"]!.ref_id!].sort(), "Browser and Plan, the kinds strut ships under Job");
    });

    it("strut's pages seed, a host's page hangs under one, and the builder's section reads them", async () => {
      const strut = byName(await seedConcepts(b, [STRUT_CONCEPTS]));
      assert.deepEqual(
        [strut["Workflow Builder"]!.action, strut["Job"]!.action, strut["App"]!.action],
        ["create", "create", "create"],
      );
      assert.equal(strut["Job App"], undefined, "no job side of an app ships");
      assert.deepEqual(await children(strut["Job"]!.ref_id!), [strut["Browser"]!.ref_id!, strut["Plan"]!.ref_id!].sort(), "strut ships two kinds under Job, Browser and Plan; a deployment grows that tree");
      await page("Janitor", "How a janitor is built here.", { description: "Cleans something up.", parent: "Workflow Builder" });
      const host = byName(await seedConcepts(b, [set()]));
      const wb = strut["Workflow Builder"]!.ref_id!;
      // Under Workflow Builder: strut's own App and Worker Tasks pages, and the host's Janitor.
      const under = [strut["App"]!.ref_id!, strut["Worker Tasks"]!.ref_id!, host["Janitor"]!.ref_id!].sort();
      assert.deepEqual(await children(wb), under);
      const again = byName(await seedConcepts(b, [STRUT_CONCEPTS]));
      assert.deepEqual([again["Workflow Builder"]!.action, again["Job"]!.action, again["App"]!.action], ["keep", "keep", "keep"]);
      assert.deepEqual(await children(wb), under, "a page another call owns is not strut's to unlink");

      const text = await builderSystem({ graph: b, registry: await createRegistry([]), services: { graph: b } });
      assert.ok(text?.startsWith('Knowledge on this server — the "Workflow Builder" Concept'), text);
      assert.ok(text!.includes("To record a new kind, add a child Concept here"));
      assert.ok(text!.includes("- Janitor — Cleans something up."));
      assert.ok(text!.includes("- App — An APP — a front-end project"), "strut's own kind is listed");
      assert.equal(await builderSystem({ registry: await createRegistry([]), services: {} }), undefined, "no graph, no section");
    });

    it("context/concept renders a page and the kinds under it for an agent's prompt, reports the page it read, and is empty without one", async () => {
      const strut = byName(await seedConcepts(b, [STRUT_CONCEPTS]));
      await page("Explore", "How to explore here.", { description: "Finding out how something works.", parent: "Job" });
      await seedConcepts(b, [set()]);
      const run = (config: Record<string, unknown>, services: Record<string, unknown> = { graph: b }) =>
        conceptStep.run(conceptStep.input.parse(config), { services } as never);

      const out = await run({ name: "Job", max: 10000 }); // the job workflow's own read: the page is its agent's whole instructions
      assert.ok(out.text.startsWith('Knowledge on this server — the "Job" Concept'), out.text);
      assert.ok(out.text.includes("To record a new kind, add a child Concept here"), "the page's docs");
      assert.ok(out.text.includes("- Explore — Finding out how something works."), "its kinds");
      assert.ok(out.text.includes('graph_graph_get({ node_type: "Concept", name: "<name>"'), "opened with the agent's name for graph-get");
      assert.deepEqual(accessedNodesOf(out)?.map((n) => n.ref_id), [strut["Job"]!.ref_id], "the page it read, never its children");

      const kinds = await run({ name: "Job", docs: false, tool: "" });
      assert.ok(kinds.text.includes("- Explore — Finding out how something works.") && !kinds.text.includes("To record a new kind"), "docs: false — the kinds alone, the orchestrator's read");
      assert.ok(!kinds.text.includes("Job App"), "no third way to an app in the orchestrator's list");
      const builds = await run({ name: "Workflow Builder", docs: false, tool: "" });
      assert.ok(builds.text.includes("- App — An APP") && !builds.text.includes("To record a new kind"), "the builder's kinds, the orchestrator's second list");
      assert.ok(!out.text.includes("Job App"), "nor in the job agent's");
      assert.ok(!kinds.text.includes("graph_graph_get"), "no tool, no opener");
      const appKinds = await run({ name: "App", docs: false, tool: "" });
      assert.ok(appKinds.text.includes("- Game — A GAME"), "a game is a kind of app: the builder finds its page under App");
      assert.deepEqual(await run({ name: "Game", docs: false }), { text: "" }, "no kinds under it, nothing");
      assert.deepEqual(await run({ name: "Nope" }), { text: "" }, "no such page");
      assert.deepEqual(await run({ name: "Job" }, {}), { text: "" }, "no graph");
      // A page strut ships that this graph does not hold is still its file;
      // one the graph holds is the graph's, whatever the file says.
      await page("Loner", "Shipped, never seeded here.", { description: "Only in the files." });
      await page("Job", "THE FILE'S JOB PAGE.", { description: "The file's." });
      const files = conceptFiles([set()]);
      assert.deepEqual(await run({ name: "Loner", frame: false }, { graph: b, conceptFiles: files }), { text: "Shipped, never seeded here." });
      const live = await run({ name: "Job", max: 10000 }, { graph: b, conceptFiles: files });
      assert.ok(live.text.includes("To record a new kind, add a child Concept here") && !live.text.includes("THE FILE'S JOB PAGE"), "the graph's page wins");
      assert.deepEqual(accessedNodesOf(live)?.map((n) => n.ref_id), [strut["Job"]!.ref_id]);
      const viaRegistry = await runSingleStep("context/concept", await createRegistry([]), { graph: b }, { config: { name: "Job", tool: "graph_get" } });
      assert.ok((viaRegistry.output as { text: string }).text.includes('graph_get({ node_type: "Concept"'), "discovered as a lib step");
    });

    it("a tree of hundreds of pages is read and written in a few batches, not a round trip per page, and says how far it is", async () => {
      // Root → 20 areas → 280 pages, every tenth under two areas.
      await page("Root", "The root.");
      for (let a = 0; a < 20; a++) await page(`Area ${a}`, `Area ${a}.`, { parent: "Root" });
      for (let i = 0; i < 280; i++) {
        const parents = i % 10 === 0 ? `["Area ${i % 20}", "Area ${(i + 1) % 20}"]` : `["Area ${i % 20}"]`;
        await page(`p${i}`, `Page ${i}.`, { name: `"Page ${i}"`, parents });
      }
      const calls: Record<string, number> = {};
      const count = <T extends object>(obj: T, method: keyof T & string) => {
        const f = (obj[method] as (...a: unknown[]) => unknown).bind(obj);
        (obj as Record<string, unknown>)[method] = (...a: unknown[]) => ((calls[method] = (calls[method] ?? 0) + 1), f(...a));
        return () => ((obj as Record<string, unknown>)[method] = f);
      };
      const undo = [count(b.nodes, "write"), count(b.nodes, "writeMany"), count(b.edges, "write"), count(b.edges, "writeMany"), count(b, "tx")];
      const seen: string[] = [];
      try {
        const first = await seedConcepts(b, [set()], { progress: (p) => seen.push(`${p.phase} ${p.done}/${p.total}`) });
        assert.equal(first.length, 301);
        assert.ok(first.every((o) => o.action === "create"), JSON.stringify(first.find((o) => o.action !== "create")));
        assert.deepEqual(calls, { writeMany: 4, tx: 4 }, "two node batches, two edge batches; the reads: the names, the parents' edges");
        assert.deepEqual(seen, ["pages 0/301", "pages 250/301", "pages 301/301", "edges 250/328", "edges 328/328"]);
        const ref = (name: string) => byName(first)[name]!.ref_id!;
        assert.equal((await children(ref("Root"))).length, 20);
        const underArea1 = Array.from({ length: 280 }, (_, i) => i).filter((i) => i % 20 === 1 || (i % 10 === 0 && (i + 1) % 20 === 1));
        assert.deepEqual(await children(ref("Area 1")), underArea1.map((i) => ref(`Page ${i}`)).sort());
        for (const k of Object.keys(calls)) delete calls[k];
        seen.length = 0;
        // Again: everything kept, nothing written.
        const again = await seedConcepts(b, [set()], { progress: (p) => seen.push(`${p.phase} ${p.done}/${p.total}`) });
        assert.ok(again.every((o) => o.action === "keep"));
        assert.deepEqual(calls, { tx: 4 }, "the names and the parents' edges, two reads each; no write");
        assert.deepEqual(seen, ["pages 301/301"]);
      } finally {
        for (const u of undo) u();
      }
    });
  });
}

// createStrut on a graph: the pages at boot, the builder's prompt from them.
const ladybug = testBackends().find((t) => t.kind === "ladybug")!;
describe("createStrut with a graph", { skip: ladybug.skip }, () => {
  let b: GraphBackend;
  let workspaceDir: string;
  const ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"];
  let saved: Record<string, string | undefined> = {};
  before(async () => {
    b = await ladybug.open();
  });
  after(async () => {
    await ladybug.close(b);
  });
  beforeEach(async () => {
    await ladybug.wipe(b);
    workspaceDir = await mkdtemp(join(tmpdir(), "strut-concepts-ws-"));
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  });
  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });
  let chats = new MemoryChatStore();
  const make = (extra: Partial<Parameters<typeof createStrut>[0]> = {}) => {
    chats = new MemoryChatStore();
    return createStrut({ workspace: new WorkspaceManager(workspaceDir), graph: b, store: new MemoryRunStore(), chatStore: chats, serveUi: false, scheduler: false, ...extra });
  };
  // namesLike answers nothing for an empty query: every name here has an "a" or an "o".
  const names = async () => [...new Set([...(await b.reader.namesLike("Concept", "a", 20)), ...(await b.reader.namesLike("Concept", "o", 20))].map((n) => n.name))].sort();

  it("seeds Workflow Builder, Job and Dream at boot, with the pages under them; concepts: false seeds nothing", async () => {
    await make({ concepts: false });
    assert.deepEqual(await names(), []);
    const strut = await make();
    assert.deepEqual(await names(), ["App", "Assistant Conversations", "Browser", "Dream", "Game", "Job", "Orchestrator", "Plan", "Recent Apps", "Recent Jobs", "Recent Work", "Recent Workflows", "Worker Tasks", "Workflow Builder"]);
    // Each Recent Work page keeps the read step it names (`Concept.step`),
    // and context/recent renders the pages under the root from the graph.
    for (const [page, step] of [["Recent Apps", "app/recent"], ["Recent Jobs", "job/recent"], ["Recent Workflows", "meta/recent-workflows"]] as const) {
      const ref = (await b.reader.namesLike("Concept", page, 1))[0]!.ref_id;
      assert.equal((await b.tx((tx) => b.nodeEngine.readRaw(tx, ref)))!.props["step"], step, page);
    }
    const res = await strut.app.request("/steps/context/recent/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: { name: "Recent Work" } }) });
    const { output } = (await res.json()) as { output: { text: string; hash: string } };
    assert.ok(output.text.startsWith("[Recent Work:") && ["Recent Apps:\n", "Recent Jobs:\n", "Recent Workflows:\n"].every((p) => output.text.includes(p)), output.text);
  });

  it("concepts: { personal: true } seeds Personal; an agent walks it with context/concept and graph_get, and the run records both reads", async () => {
    const store = new MemoryRunStore();
    const strut = await make({ concepts: { personal: true }, store });
    assert.deepEqual(await names(), ["App", "Assistant Conversations", "Browser", "Dream", "Game", "Job", "Orchestrator", "Personal", "Plan", "Recent Apps", "Recent Jobs", "Recent Work", "Recent Workflows", "Worker Tasks", "Workflow Builder"]);
    const root = (await b.reader.namesLike("Concept", "Personal", 1))[0]!.ref_id;
    // A page the person taught, under the root.
    const cooking = (await b.nodes.write({ type: "Concept", data: { name: "Cooking", description: "How meals are planned", docs: "Plan on Sundays." } })).ref_id;
    await b.edges.write({ edge: "PARENT_OF", source_ref_id: root, target_ref_id: cooking });

    const flow = {
      name: "walk",
      input: z.any(),
      steps: [
        { id: "root", type: "context/concept", config: { name: "Personal", tool: "graph_get" } },
        { id: "open", type: "graph/graph-get", config: { node_type: "Concept", name: "Cooking", children: "PARENT_OF" }, depends: "root" },
      ],
    };
    const res = await runWorkflow(flow, {}, await createRegistry([]), { store, services: strut.services });
    assert.equal(res.status, "success", JSON.stringify(res.error));
    const events = await store.getRunEvents("walk", res.runId);
    const end = (id: string) => events.find((e) => e.type === "step.end" && e.path === `walk/${id}`)!;
    const text = (end("root").output as { text: string }).text;
    assert.ok(text.includes('the "Personal" Concept') && text.includes("- Cooking — How meals are planned"), text);
    assert.ok(text.includes('graph_get({ node_type: "Concept", name: "<name>", children: "PARENT_OF" })'), "says how to open the next page");
    assert.equal((end("open").output as { properties: { docs: string } }).properties.docs, "Plan on Sundays.");
    assert.deepEqual(end("root").nodes?.map((n) => n.ref_id), [root], "the page it rendered, never its children");

    // The run's record: one ACCESSED edge to each page, read back as Concept use.
    const runRef = await projectRun(b, store, "walk", res.runId);
    for (const ref of [root, cooking]) assert.deepEqual((await runsThatRead(b, ref)).map((r) => [r.run_ref_id, r.workflow_name]), [[runRef, "walk"]]);
    await strut.close();
  });

  it("puts the Job page at the end of the job agent's system prompt", async () => {
    const systems: string[] = [];
    // Stands in for the core `agent` step: records the system prompt it was handed.
    const fakeAgent = defineStep({
      type: "agent",
      input: z.object({ system: z.string() }).passthrough(),
      output: z.any(),
      async run(cfg) {
        systems.push(cfg.system);
        return { result: "ok", object: { text: "ok", artifacts: [] }, steps: 1, usage: {}, cost: 0 };
      },
    });
    const strut = await make({ registry: await createRegistry([fakeAgent]) });
    const res = await strut.run("job", { prompt: "How does billing work?" });
    assert.equal(res.status, "success", JSON.stringify(res.error));
    const [system] = systems;
    assert.ok(system!.startsWith("You are working on a JOB with a person"), "strut's prompt leads");
    const at = system!.indexOf('Knowledge on this server — the "Job" Concept');
    assert.ok(at > 0 && system!.slice(0, at).endsWith("the next turn's message.\n\n"), "the page follows the mechanics after a blank line");
    assert.ok(system!.slice(at).includes("The work is done when it is VERIFIED"), "the agent's instructions are the page's");
    assert.ok(system!.includes("To record a new kind, add a child Concept here"), "the page whole: the job's read raises the cap for it");
    assert.ok(!system!.includes("open the `Job` Concept: graph/graph-get"), "no tool call to make for the list");
  });

  it("with Personal, the orchestrator's prompt closes with it and the pages under it, with how to open one; without it, nothing of it", async () => {
    const systems: string[] = [];
    const fakeAgent = defineStep({
      type: "agent",
      input: z.object({ system: z.string() }).passthrough(),
      output: z.any(),
      async run(cfg) {
        systems.push(cfg.system);
        return { result: "ok", object: { text: "ok", artifacts: [] }, steps: 1, usage: {}, cost: 0 };
      },
    });
    const strut = await make({ concepts: { personal: true }, registry: await createRegistry([fakeAgent]) });
    const root = (await b.reader.namesLike("Concept", "Personal", 1))[0]!.ref_id;
    const style = (await b.nodes.write({ type: "Concept", data: { name: "Communication style", description: "Short, plain replies; start a message sent for me with [peel agent].", docs: "Short." } })).ref_id;
    await b.edges.write({ edge: "PARENT_OF", source_ref_id: root, target_ref_id: style });
    let res = await strut.run("orchestrator", { prompt: "send hive a test", session: "s-1" });
    assert.equal(res.status, "success", JSON.stringify(res.error));
    const system = systems.at(-1)!;
    const at = system.indexOf('Knowledge on this server — the "Personal" Concept');
    assert.ok(at > system.indexOf('the "Job" Concept'), "after the kinds of job");
    assert.ok(system.includes("write under it, never on it"), "the root's own docs: where to write");
    assert.ok(system.includes("- Communication style — Short, plain replies; start a message sent for me with [peel agent]."), system.slice(at));
    assert.ok(system.slice(at).includes('graph_graph_get({ node_type: "Concept", name: "<name>", children: "PARENT_OF" })'), "and how to open one");
    await strut.close();

    const plain = await make({ registry: await createRegistry([fakeAgent]) });
    res = await plain.run("orchestrator", { prompt: "send hive a test", session: "s-2" });
    assert.equal(res.status, "success", JSON.stringify(res.error));
    assert.ok(!systems.at(-1)!.includes('the "Personal" Concept'), "a host without Personal: not in the prompt, even with the page in the graph");
    await plain.close();
  });

  it("puts the Workflow Builder page in a chat's system prompt unless the host passes its own", async () => {
    const bodies: Array<{ system: unknown }> = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        bodies.push(JSON.parse(raw));
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "recorded" } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const systemOf = (body: { system: unknown }): string =>
      typeof body.system === "string" ? body.system : (body.system as Array<{ text: string }>).map((s) => s.text).join("");
    const turn = async (strut: Awaited<ReturnType<typeof make>>) => {
      const res = await strut.app.request("/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "hi" }) });
      const { chatId } = (await res.json()) as { chatId: string };
      for (let i = 0; i < 200 && (await chats.getMeta(chatId))?.status === "live"; i++) await new Promise((r) => setTimeout(r, 25));
    };
    try {
      await turn(await make());
      assert.ok(systemOf(bodies[0]!).includes('Knowledge on this server — the "Workflow Builder" Concept'));
      await turn(await make({ chatSystem: () => "HOST-SECTION" }));
      assert.ok(systemOf(bodies[1]!).includes("HOST-SECTION"));
      assert.ok(!systemOf(bodies[1]!).includes("Knowledge on this server"), "the host's hook replaces the default");
    } finally {
      server.close();
    }
  });
});
