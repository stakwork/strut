import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStrut, type Strut } from "../createStrut.js";
import { hostConfigFromEnv } from "../server.js";
import { MemoryRunStore } from "../store.js";
import { FileWorkspaceStore, WorkspaceManager } from "../workspace.js";
import { appIdentity } from "../auth.js";
import { kitForTests } from "../test-util/app-kit.js";
import { treeHash } from "../version.js";
import { ORCHESTRATOR_WORKFLOW } from "../orchestrator-seed.js";
import { createRegistry } from "../steps/registry.js";
import type { StepRegistry } from "../core.js";
import type { KitLocation } from "./kit.js";
import { STEP_RUN_TOOL, buildAppTools } from "./tools.js";
import { JAMIE_APP, JAMIE_DIR, RETIRED_APP, seedJamieApp } from "./jamie-seed.js";
import { VIEWS_APP } from "./views-seed.js";
import modelsStep from "../steps/lib/llm/models.js";
import verifyStep from "../steps/lib/job/verify.js";
import evidenceStep from "../steps/lib/job/evidence.js";
import type { JobsCapability } from "../jobs.js";
import { BUSY_NOTICE, NOT_YOURS_NOTICE, detectSlash, groupByDay, insertSlash, isOwn, modelChoices, newConversationId, sendRefusal, sentModel, silentReply, timeLine, turnContext } from "./jamie/src/lib/chat.js";
import { appKey, openable, placeArtifact, servedFile, turnDeliverables } from "./jamie/src/lib/artifacts.js";
import { answeredSince, askedSecret, captchaPrompt, claimPill, jobLook, jobRunWorkflow, liveStrip, openSlot, parseCaptcha, secretAlreadySet, secretPrompt, sortClaims, tapAt, toggleCell } from "./jamie/src/lib/jobs.js";
import type { LedgerClaim, ModelCatalog } from "./jamie/src/lib/types.js";
import { canMerge, checksLine, fixPrompt, prKey, prLive, prOf, prPill } from "./jamie/src/lib/pr.js";
import { attachmentShow } from "./jamie/src/lib/attachments.js";

/**
 * `strut/jamie` (plans/jamie-app.md §5): the person's assistant as a
 * first-party app strut ships — its pure parts (the turn's context, the
 * list's days, new ids, what a refused send means, "/" for a Concept, where
 * a deliverable shows, a job's card and captcha), its seed beside
 * strut/views, and the steps it calls through a whole strut as its viewer.
 */

const runs = { byJob: new Map([["j1", { workflow: "job", runId: "r-job" }]]), byRun: new Map([["r-turn", { workflow: "orchestrator", runId: "r-turn" }]]) };

describe("strut/jamie — the pure parts", () => {
  it("a turn's context: the time where the person is, then where the reply is read; UTC for a bad zone", () => {
    const now = new Date("2026-11-04T14:02:00Z");
    // Hive's format (`orchestratorContextLine`); ICU puts a comma after the weekday or not.
    assert.match(timeLine(now, "Europe/London"), /^Wed,? 4 Nov 2026, 14:02, Europe\/London\. $/);
    assert.match(timeLine(now, "Not/AZone"), /^Wed,? 4 Nov 2026, 14:02, UTC\. $/);
    assert.match(timeLine(now), /, UTC\. $/);
    const c = turnContext(now, "America/New_York");
    assert.equal(c.timeZone, "America/New_York");
    assert.match(c.line, /^Wed,? 4 Nov 2026, 09:02, America\/New_York\. /);
    assert.ok(c.line.endsWith(c.where), "`line` carries the medium too: a person's turn reads `line` alone");
    assert.match(c.where, /assistant app/);
    assert.equal(turnContext(now).timeZone, undefined);
  });

  it("the list's days: Today, Yesterday, a date, in the order the rows came", () => {
    const now = new Date(2026, 10, 4, 15, 0);
    const at = (d: number, h = 9) => new Date(2026, 10, d, h).toISOString();
    const groups = groupByDay([{ updatedAt: at(4, 14) }, { updatedAt: at(4, 8) }, { updatedAt: at(3) }, { updatedAt: at(1) }, { updatedAt: "nope" }], now);
    assert.deepEqual(groups.map((g) => [g.label === "Today" || g.label === "Yesterday" || g.label === "Earlier" ? g.label : "date", g.items.length]), [
      ["Today", 2],
      ["Yesterday", 1],
      ["date", 1],
      ["Earlier", 1],
    ]);
  });

  it("a new conversation is the viewer's own: <viewer>/<12 hex>", () => {
    let i = 0;
    const id = newConversationId("alice", () => (i++ % 16) / 16);
    assert.equal(id, "alice/0123456789ab");
    assert.ok(isOwn(id, "alice"));
    assert.ok(isOwn("alice", "alice"));
    assert.ok(!isOwn("alicex/1", "alice"));
    assert.ok(!isOwn("c-hive-123", "alice"), "a Hive conversation's bare id");
    assert.ok(!isOwn("alice/1", undefined));
  });

  it("what a refused send means: busy, another person's conversation, else the error", () => {
    assert.deepEqual(sendRefusal("step_run: session_busy: alice/c1 is mid-turn"), { kind: "busy", text: BUSY_NOTICE });
    assert.deepEqual(sendRefusal('step_run: conversation_not_yours: "c-1" is another person\'s conversation'), { kind: "not-yours", text: NOT_YOURS_NOTICE });
    assert.deepEqual(sendRefusal("boom"), { kind: "error", text: "boom" });
    assert.ok(silentReply(" [silent]\n"));
    assert.ok(!silentReply("Done."));
  });

  it('"/" opens a Concept at the start of a word only, and the pick replaces what was typed', () => {
    assert.deepEqual(detectSlash("look at /Car", 12), { start: 8, query: "Car" });
    assert.deepEqual(detectSlash("/", 1), { start: 0, query: "" });
    assert.equal(detectSlash("https://x.com/a", 15), null, "inside a URL");
    assert.equal(detectSlash("a/b", 3), null, "inside a path");
    assert.equal(detectSlash("/Car x", 6), null, "a space after it closed it");
    const t = detectSlash("see /car please", 8)!;
    assert.deepEqual(insertSlash("see /car please", t, "Cardiology"), { text: "see /Cardiology  please", caret: 16 });
  });

  it("the model picker: Default, then what llm/models lists; a remembered pick no longer listed is Default and sends no model", () => {
    const catalog: ModelCatalog = {
      default: "anthropic/claude-opus-5-5",
      models: [
        { name: "anthropic/claude-opus-5-5", provider: "anthropic", modelId: "claude-opus-5-5", alias: "opus", default: false, available: true },
        { name: "numes/z-ai/glm-5.3-flash", provider: "numes", modelId: "z-ai/glm-5.3-flash", default: false, available: true },
        { name: "xai/grok-4.7", provider: "xai", modelId: "grok-4.7", alias: "grok", default: true, available: false },
      ],
    };
    assert.deepEqual(modelChoices(catalog), [
      { value: "", name: "Default" },
      { value: "anthropic/claude-opus-5-5", name: "opus · anthropic" },
      { value: "numes/z-ai/glm-5.3-flash", name: "numes/z-ai/glm-5.3-flash" },
    ]);
    assert.deepEqual(modelChoices(undefined), [{ value: "", name: "Default" }]);
    assert.equal(sentModel("anthropic/claude-opus-5-5", catalog), "anthropic/claude-opus-5-5", "still listed");
    assert.equal(sentModel("xai/grok-4.7", catalog), "", "known, but no longer available");
    assert.equal(sentModel("openai/gpt-5", catalog), "", "gone from the list");
    assert.equal(sentModel("", catalog), "");
    assert.equal(sentModel("openai/gpt-5", undefined), "openai/gpt-5", "until the list is read, the pick stands");
  });

  it("where a deliverable shows: what strut/views draws inline, the rest handed to the host", () => {
    const place = (ref: Parameters<typeof placeArtifact>[0]) => placeArtifact(ref, runs);
    assert.deepEqual(servedFile("/jobs/a%2Fb/files/plan.md?t=x"), { job: "a/b", rel: "plan.md" });
    assert.deepEqual(servedFile("/artifacts/r1/out/x.png"), { runId: "r1", rel: "out/x.png" });
    assert.deepEqual(place({ id: "p", kind: "markdown", title: "Plan", url: "/jobs/j1/files/plan.md?t=tok" }), { show: "file", kind: "markdown", path: "plan.md", run: { workflow: "job", runId: "r-job" }, job: "j1" });
    assert.deepEqual(place({ id: "c", kind: "table", title: "Rows", url: "/jobs/j9/files/rows.csv" }), { show: "file", kind: "table", path: "rows.csv", job: "j9" }, "a job the turn did not start: the card finds its run");
    assert.deepEqual(place({ id: "s", kind: "image", title: "Shot", url: "/artifacts/r-turn/shot.png" }), { show: "file", kind: "image", path: "shot.png", run: { workflow: "orchestrator", runId: "r-turn" } });
    assert.deepEqual(place({ id: "pdf", kind: "pdf", title: "Brief", url: "/jobs/j1/files/brief.pdf?t=x" }), { show: "link", href: "?artifact=%2Fjobs%2Fj1%2Ffiles%2Fbrief.pdf", external: false, what: "PDF" }, "a PDF the page cannot frame: the host's");
    assert.equal(place({ id: "v", kind: "video", title: "Clip", url: "/artifacts/r-other/clip.mp4" }).show, "link", "an unknown run's file");
    assert.deepEqual(place({ id: "a", kind: "app", title: "Dash", url: "/apps/acme/dash/v3/files/dist/index.html", app: { name: "acme/dash", version: "v3" } }), { show: "link", href: "?app=acme%2Fdash%40v3", external: false, what: "app" });
    assert.equal(appKey({ id: "a", kind: "app", title: "x", peer: "web", app: { name: "dash", version: "v2" } }), "@web/dash", "a peer's app is its live version there");
    assert.deepEqual(place({ id: "f", kind: "markdown", title: "Report", peer: "acme-web", via: "lab", job: "j7", path: "report.md" }), { show: "link", href: "?artifact=%2Fpeers%2Facme-web%2Fpeers%2Flab%2Fjobs%2Fj7%2Ffiles%2Freport.md", external: false, what: "@acme-web" });
    assert.deepEqual(place({ id: "g", kind: "sheet", title: "Matrix", url: "https://docs.google.com/spreadsheets/d/abc_123/edit" }), { show: "sheet", spreadsheet: "abc_123" });
    assert.deepEqual(place({ id: "pr", kind: "pull_request", title: "PR", url: "https://github.com/a/b/pull/1" }), { show: "link", href: "https://github.com/a/b/pull/1", external: true, what: "github.com" });
    assert.deepEqual(place({ id: "n", kind: "markdown", title: "Note", content: "# Hi" }), { show: "content", kind: "markdown", text: "# Hi" });
    assert.deepEqual(place({ id: "k", kind: "captcha", title: "Captcha", url: "/jobs/j1/files/shots/captcha-1.json" }), { show: "captcha", job: "j1", path: "shots/captcha-1.json", run: { workflow: "job", runId: "r-job" } });
    assert.deepEqual(place({ id: "m", kind: "markdown", title: "Gone", error: "not found: x.md" }), { show: "missing", text: "not found: x.md" });
  });

  it("an app named only by its document's link is still an app; an entry that opens nothing is no card", () => {
    assert.equal(appKey({ id: "a", kind: "app", title: "Ask X", url: "/apps/x-research/v2/files/dist/index.html?t=tok" }), "x-research@v2");
    assert.equal(appKey({ id: "a", kind: "app", title: "Dash", url: "/apps/acme%2Fdash/v3/files/dist/index.html" }), "acme/dash@v3");
    assert.deepEqual(placeArtifact({ id: "a", kind: "app", title: "Ask X", url: "/apps/x-research/v2/files/dist/index.html" }, runs), { show: "link", href: "?app=x-research%40v2", external: false, what: "app" });
    assert.equal(openable({ id: "x", kind: "url", title: "Ask X", summary: "The app" }), false, "a copy that kept only its title and summary");
    assert.equal(openable({ id: "m", kind: "markdown", title: "Gone", error: "not found" }), false);
    assert.equal(openable({ id: "a", kind: "app", title: "Ask X", app: { name: "x-research", version: "v2" } }), true);
    assert.equal(openable({ id: "n", kind: "markdown", title: "Note", content: "# Hi" }), true);
    assert.equal(openable({ id: "f", kind: "markdown", title: "Far", peer: "acme-web", job: "j7", path: "report.md" }), true);
  });

  it("a turn's deliverables: under a wake's reply what the job delivered; the reply's copy of one, or an entry that opens nothing, never shows", () => {
    const app = { id: "ask-x", kind: "app", title: "Ask X", url: "/apps/x-research/v2/files/dist/index.html", app: { name: "x-research", version: "v2" } };
    const plan = { id: "plan", kind: "markdown", title: "Plan", url: "/jobs/j1/files/plan.md" };
    const { delivered, own } = turnDeliverables({
      delivered: [{ job: "j1", runId: "r-b", workflow: "builder", artifacts: [app, plan, { id: "gone", kind: "markdown", title: "Gone", error: "not found" }] }],
      artifacts: [
        { id: "app", kind: "url", title: "Ask X", summary: "The app" }, // the copy the wake's reply made: nothing to open
        { id: "x", kind: "app", title: "Ask X again", app: { name: "x-research", version: "v2" } }, // the same app
        { id: "p2", kind: "markdown", title: "The plan", url: "/jobs/j1/files/plan.md?t=tok" }, // the same file
        { id: "plan", kind: "markdown", title: "Plan", content: "# Plan" }, // the same id
        { id: "pr", kind: "pull_request", title: "PR", url: "https://github.com/a/b/pull/1" },
      ],
    });
    assert.deepEqual(delivered, [{ artifact: app, job: "j1" }, { artifact: plan, job: "j1" }]);
    assert.deepEqual(own.map((s) => s.artifact.id), ["pr"]);
    assert.deepEqual(turnDeliverables({}), { delivered: [], own: [] });
  });

  it("a job card reads its run as the workflow it is: the turn's word, else the job's record; `job` only for a job not on file", () => {
    const view = { workflow: "builder", runs: [{ workflow: "builder", runId: "r1", status: "success" }, { workflow: "browser-captcha", runId: "r2", status: "success" }] };
    assert.equal(jobRunWorkflow("r1", "builder", undefined), "builder", "the turn's word, no read");
    assert.equal(jobRunWorkflow("r3", undefined, undefined), undefined, "the record is being read");
    assert.equal(jobRunWorkflow("r3", undefined, view), "builder", "a continue saved before job/continue returned its workflow");
    assert.equal(jobRunWorkflow("r2", undefined, view), "browser-captcha", "the run's own line");
    assert.equal(jobRunWorkflow("r9", undefined, { runs: [] }), "job");
    assert.equal(jobRunWorkflow("r9", undefined, null), "job", "no record");
  });

  it("a build that asks for a secret: its NAME, the turn that says it is stored, and when the question is answered", () => {
    assert.equal(askedSecret({ message: "I need your Acme token.", secret: "ACME_TOKEN" }), "ACME_TOKEN");
    assert.equal(askedSecret({ message: "x", secret: " ACME_TOKEN " }), "ACME_TOKEN");
    for (const ask of [undefined, null, "Which repo?", { message: "x" }, { secret: "not a name" }, { secret: "1ABC" }, { secret: 7 }]) assert.equal(askedSecret(ask), null, JSON.stringify(ask));
    // The job's next turn names the secret, never a value.
    assert.equal(secretPrompt("ACME_TOKEN"), "[secret] ACME_TOKEN stored");
    assert.equal(secretPrompt("ACME_TOKEN", true), "[secret] ACME_TOKEN is already set here");
    assert.equal(secretAlreadySet("step_run: secret_set: ACME_TOKEN already has a value here"), true);
    assert.equal(secretAlreadySet("secret_name: bad"), false);
    // A later top-level turn of the job answered it; a child run did not.
    const runs = [{ runId: "1793900000000" }, { runId: "1793900005000", parentRunId: "1793900000000" }];
    assert.equal(answeredSince(runs, "1793900000000"), false);
    assert.equal(answeredSince([...runs, { runId: "1793900009000" }], "1793900000000"), true);
    assert.equal(answeredSince(undefined, "1793900000000"), false);
  });

  it("a job's card: its pill, and the live strip's line and tally for the run in flight", () => {
    assert.deepEqual(jobLook("success", "Which repo?"), { label: "Needs an answer", tone: "attention" });
    assert.deepEqual(jobLook("success"), { label: "Done", tone: "ok" });
    assert.deepEqual(jobLook("running"), { label: "Running", tone: "running" });
    assert.deepEqual(jobLook("error"), { label: "Failed", tone: "failed" });
    const at = "2026-11-04T10:00:00Z";
    const strip = liveStrip(
      [
        { kind: "status", at, runId: "r1", title: "Reading the repo" },
        { kind: "status", at, runId: "r0", title: "an older turn's line" },
        { kind: "image", at, runId: "r1", url: "/jobs/j/files/shots/001.png" },
        { kind: "image", at, runId: "r1", url: "/jobs/j/files/shots/002.png" },
        { kind: "walkthrough", at, runId: "r1", url: "/jobs/j/files/w/walkthrough.json", state: "stopped" },
        { kind: "pod", at, id: "pod-1", state: "held" },
        { kind: "evidence", at, runId: "r1", id: "e1", state: "supported" },
        { kind: "evidence", at, runId: "r1", id: "e2", state: "planned" },
        { kind: "graph", at, runId: "r1", id: "r1" },
      ],
      "r1",
    );
    assert.equal(strip.status, "Reading the repo");
    assert.deepEqual(strip.tally, ["1 recording, 1 stopped", "2 shots", "pod held", "2 checks: 1 supported, 1 waiting on a look"]);
    assert.equal(strip.shot?.url, "/jobs/j/files/w/walkthrough.json");
  });

  it("a claim waiting on a person's look comes first, with its slot", () => {
    const claim = (id: string, status: LedgerClaim["status"], planned?: string): LedgerClaim => ({
      id,
      text: id,
      status,
      assertedOnly: false,
      unverified: 0,
      checks: [{ id: `k-${id}`, name: "eyes", ...(planned ? { lastVerify: { planned } } : { lastVerify: { ran: true as const } }) }],
    });
    const look = claim("look", "unknown", "ev-1");
    assert.equal(claimPill(look), "needs a look");
    assert.equal(openSlot(look), "ev-1");
    assert.equal(claimPill(claim("r", "refuted", "ev-2")), "refuted", "a refutation stands over a pending look");
    assert.deepEqual(sortClaims([claim("ok", "supported"), claim("bad", "refuted"), look]).map((c) => c.id), ["look", "bad", "ok"]);
  });

  it("a captcha: its manifest, taps on a grid toggle cells, the answer is the job's next turn", () => {
    const m = parseCaptcha(JSON.stringify({ image: "captcha-2.png", instruction: "Pick the buses", site: "x.com", mode: "tap", round: 2, maxRounds: 5, grid: { rows: 3, cols: 3 }, state: "waiting", expiresAt: "2026-11-04T10:00:00Z" }))!;
    assert.deepEqual([m.image, m.mode, m.round, m.grid], ["captcha-2.png", "tap", 2, { rows: 3, cols: 3 }]);
    assert.equal(parseCaptcha("{}"), null);
    assert.equal(parseCaptcha("not json"), null);
    const tap = tapAt(150, 50, { left: 100, top: 0, width: 300, height: 300 });
    assert.deepEqual(tap, { nx: 1 / 6, ny: 1 / 6 });
    const once = toggleCell([], tap, m.grid!);
    assert.deepEqual(once, [{ nx: 1 / 6, ny: 1 / 6 }]);
    assert.deepEqual(toggleCell(once, { nx: 0.05, ny: 0.3 }, m.grid!), [], "the same cell again clears it");
    assert.equal(captchaPrompt({ round: 2, site: "x.com", taps: once }), '[captcha-answer] {"round":2,"site":"x.com","taps":[{"nx":0.16666666666666666,"ny":0.16666666666666666}]}');
  });

  it("a pull request: which artifact is one, its pill, its checks in a line, Merge and Fix", () => {
    const at = { repo: "a/b", number: 5, url: "https://github.com/a/b/pull/5" };
    assert.deepEqual(prOf({ kind: "pull_request", url: "https://github.com/a/b/pull/5/files" }), at);
    assert.deepEqual(prOf({ kind: "pull_request", content: '{"url":"https://github.com/a/b/pull/5","state":"open"}' }), at);
    assert.deepEqual(prOf({ kind: "pull_request", content: "https://github.com/a/b/pull/5" }), at, "a bare link");
    assert.equal(prOf({ kind: "markdown", url: "https://github.com/a/b/pull/5" }), null);
    assert.equal(prOf({ kind: "pull_request", url: "https://gitlab.com/a/b/-/merge_requests/5" }), null);
    assert.equal(prKey({ repo: "A/B", number: 5 }), prKey(at), "one card per pull request, whatever the case");
    assert.deepEqual(prPill("merged"), { label: "Merged", tone: "merged" });
    assert.deepEqual(prPill("draft"), { label: "Draft", tone: "muted" });
    assert.equal(checksLine({ passed: 2, failed: 1, running: 1, skipped: 0, total: 4 }), "2 of 4 checks passed · 1 failed · 1 running");
    assert.equal(checksLine({ passed: 0, failed: 0, running: 0, skipped: 0, total: 0 }), "");
    assert.equal(canMerge({ state: "open", mergeable: null }), true, "GitHub still checking: offered, it refuses a conflict itself");
    assert.equal(canMerge({ state: "open", mergeable: false }), false);
    assert.equal(canMerge({ state: "draft", mergeable: true }), false);
    assert.equal(prLive("open"), true);
    assert.equal(prLive("merged"), false);
    assert.equal(
      fixPrompt({ repo: "a/b", number: 5, head: "fix/login", checks: [{ name: "lint", status: "failed" }, { name: "test", status: "passed" }, { name: "e2e", status: "failed" }] }),
      "The checks on a/b#5 failed: lint, e2e. Find out why, fix it, and push the fix to fix/login — the same pull request.",
    );
  });

  it("an attached file: an image a thumbnail, text to read, the rest a chip; nothing without a path", () => {
    const at = (name: string, mediaType: string, path: string | null = `attachments/${name}`) => attachmentShow({ name, mediaType, ...(path ? { path } : {}) });
    assert.equal(at("a.png", "image/png"), "image");
    assert.equal(at("a.svg", "image/svg+xml"), "file", "an SVG is a document, never drawn as an image here");
    assert.equal(at("notes.md", "application/octet-stream"), "text", "by its name");
    assert.equal(at("data.json", "application/json"), "text");
    assert.equal(at("brief.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "file");
    assert.equal(at("a.png", "image/png", null), "file", "a turn read before strut said where");
  });

  it("STRUT_HOST_CONFIG's `jamie`: false or nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "strut-jamie-host-"));
    const file = join(dir, "host.json");
    try {
      await writeFile(file, JSON.stringify({ jamie: false }));
      assert.deepEqual(hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), { jamie: false });
      await writeFile(file, JSON.stringify({ jamie: { title: "x" } }));
      assert.throws(() => hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), /"jamie" must be false/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("strut/jamie — seeded at boot beside strut/views", () => {
  let kit: KitLocation;
  const dirs: string[] = [];
  const tmp = async (p: string) => {
    const d = await mkdtemp(join(tmpdir(), p));
    dirs.push(d);
    return d;
  };
  const quiet = { serveUi: false, enableChat: false, scheduler: false } as const;
  before(async () => {
    kit = await kitForTests();
  });
  after(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("publishes strut/jamie built against the kit with strut/views compiled in; a reboot is a no-op; `jamie: false` seeds nothing; strut/assistant, its old name, goes", async () => {
    const dataDir = await tmp("strut-jamie-seed-");
    const first = await createStrut({ ...quiet, workspace: new FileWorkspaceStore(dataDir), store: new MemoryRunStore(), kit });
    const app = await first.apps.get(JAMIE_APP);
    assert.ok(app, "seeded");
    assert.deepEqual([app.version, app.publisher, app.versions[app.version]?.source, app.stale], ["v1", "strut", "seed", false]);
    assert.equal(app.hash, await treeHash(JAMIE_DIR));
    assert.equal(app.manifest.title, "Jamie");
    assert.deepEqual(app.manifest.grants.workflows, ["orchestrator", "job", "builder"]);
    const info = JSON.parse(await readFile(join(app.dir, "dist", "build.json"), "utf8"));
    const views = (await first.apps.get(VIEWS_APP))!;
    assert.deepEqual(info.imports, [{ name: VIEWS_APP, version: views.version, hash: views.hash }], "strut/views compiled in");
    assert.deepEqual(info.warnings, [], "no global fetch, nothing the build warns about");
    const html = await readFile(join(app.dir, "dist", "index.html"), "utf8");
    assert.match(html, /What should we work on\?/);
    assert.doesNotMatch(html, /SPRINT-AF/, "the views gallery's fixtures stay out");
    assert.ok(info.bytes < 2_000_000, `${info.bytes} bytes`);

    const again = await createStrut({ ...quiet, workspace: new FileWorkspaceStore(dataDir), store: new MemoryRunStore(), kit });
    assert.deepEqual(Object.keys((await again.apps.get(JAMIE_APP))!.versions), ["v1"], "no second version");
    assert.deepEqual(await seedJamieApp({ workspace: again.workspace, kit }), { version: "v1", changed: false });

    const off = await createStrut({ ...quiet, workspace: new FileWorkspaceStore(await tmp("strut-jamie-off-")), store: new MemoryRunStore(), kit, jamie: false });
    assert.equal(await off.apps.get(JAMIE_APP), null);
    const noViews = await createStrut({ ...quiet, workspace: new FileWorkspaceStore(await tmp("strut-jamie-noviews-")), store: new MemoryRunStore(), kit, views: false });
    assert.equal(await noViews.apps.get(JAMIE_APP), null, "nothing to build it against: none, and no warning");

    // The app it was before it was Jamie: the next boot takes it out.
    const old = join(await tmp("strut-jamie-old-"), "app");
    await cp(JAMIE_DIR, old, { recursive: true });
    assert.ok((await again.apps.publish(old, RETIRED_APP, { surface: "person", source: "seed" })).ok);
    await createStrut({ ...quiet, workspace: new FileWorkspaceStore(dataDir), store: new MemoryRunStore(), kit });
    assert.equal(await again.apps.get(RETIRED_APP), null, "strut/assistant is gone");
    assert.ok(await again.apps.get(JAMIE_APP), "strut/jamie stays");
  });
});

describe("strut/jamie — its steps, as its viewer", () => {
  const KEY = "assistant-key";
  const ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "STRUT_API_KEY", "AI_SDK_LOG_WARNINGS"];
  let saved: Record<string, string | undefined> = {};
  let root = "";
  let server: http.Server;
  let strut: Strut;
  let registry: StepRegistry;
  const store = new MemoryRunStore();

  const sse = (o: unknown) => `event: ${(o as { type: string }).type}\ndata: ${JSON.stringify(o)}\n\n`;
  const reply = (input: unknown) =>
    sse({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }) +
    sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "final_answer", input: {} } }) +
    sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }) +
    sse({ type: "content_block_stop", index: 0 }) +
    sse({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } }) +
    sse({ type: "message_stop" });
  const lines: string[] = [];

  /** The seeded app's `step_run`, as `actor` (none: no person). */
  const page = (name: string, actor?: string, version = "v1") => {
    const tools = buildAppTools({ apps: strut.apps, registry, services: strut.services, ...(actor ? { actor } : {}), runStepDeps: { store, workspace: strut.workspace } });
    const app = appIdentity(name, version);
    const call = async (type: string, config: Record<string, unknown> = {}) =>
      (await (tools[STEP_RUN_TOOL] as any).execute({ type, config, app }, { toolCallId: "t", messages: [] })) as { error?: string; result?: any };
    const ok = async (type: string, config: Record<string, unknown> = {}) => {
      const r = await call(type, config);
      assert.equal(r.error, undefined, r.error);
      return r.result;
    };
    return { call, ok };
  };

  before(async () => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    process.env["STRUT_API_KEY"] = KEY;
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["AI_SDK_LOG_WARNINGS"] = "false";
    root = await mkdtemp(join(tmpdir(), "strut-jamie-steps-"));
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw);
        lines.push(JSON.stringify(body.messages.filter((m: any) => m.role === "user").at(-1)));
        res.writeHead(200, { "content-type": "text/event-stream" }).end(reply({ text: "Hello from the assistant.", artifacts: [] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${(server.address() as any).port}`;
    registry = await createRegistry([]);
    strut = await createStrut({
      workspace: new WorkspaceManager(join(root, "ws")),
      store,
      registry,
      kit: await kitForTests(),
      serveUi: false,
      enableChat: false,
      scheduler: false,
      builder: false,
      autoResume: false,
      browserWorkflows: false,
      privacyWorkflows: false,
    });
    await strut.workspace.publishWorkflow("job", "v-test", { steps: [{ id: "result", type: "pack", config: { text: "{{ input.prompt }}: done", artifacts: [] } }] });
  });
  after(async () => {
    await strut?.close?.().catch(() => {});
    server?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  it("the seeded app is first-party: the list says who it is for, a turn opens the viewer's own conversation, rename and archive are theirs", async () => {
    const alice = page(JAMIE_APP, "alice");
    const empty = await alice.ok("conversation/list");
    assert.deepEqual([empty.conversations, empty.viewer], [[], "alice"], "who the list is for: a new chat is <viewer>/<id>");

    const context = { line: "Wed 4 Nov 2026, 14:02, UTC. In the assistant app. ", where: "In the assistant app. ", timeZone: "UTC" };
    const { runId } = await alice.ok("run/launch", { workflow: ORCHESTRATOR_WORKFLOW, input: { prompt: "hello there", session: "alice/c1", context }, params: { model: "claude-sonnet-5-5" } });
    const done = await alice.ok("run/get", { workflow: ORCHESTRATOR_WORKFLOW, runId, wait: 20_000 });
    assert.equal(done.status, "success", JSON.stringify(done.error));
    assert.ok(lines.some((l) => l.includes("hello there") && l.includes("Wed 4 Nov 2026, 14:02, UTC")), "the context line heads the prompt");

    const view = await alice.ok("conversation/get", { session: "alice/c1" });
    assert.deepEqual([view.turns[0].prompt, view.turns[0].text, view.turns[0].status], ["hello there", "Hello from the assistant.", "success"]);
    const held = await alice.ok("conversation/get", { session: "alice/c1", wait: 50, since: view.rev });
    assert.equal(held.rev, view.rev, "nothing moved: held, then the same view");

    await alice.ok("conversation/update", { session: "alice/c1", title: "Greetings" });
    await alice.ok("conversation/update", { session: "alice/c1", archived: true });
    assert.deepEqual((await alice.ok("conversation/list")).conversations, []);
    const archived = await alice.ok("conversation/list", { archived: true });
    assert.deepEqual(archived.conversations.map((c: any) => [c.id, c.title, c.archived]), [["alice/c1", "Greetings", true]]);
    assert.deepEqual((await page(JAMIE_APP, "bob").ok("conversation/list", { archived: true })).conversations, [], "never another person's");
  });

  it("an attached file is read from its turn: the viewer's own, and a teammate's once the conversation is shared", async () => {
    const alice = page(JAMIE_APP, "alice");
    const bob = page(JAMIE_APP, "bob");
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
    const { runId } = await alice.ok("run/launch", {
      workflow: ORCHESTRATOR_WORKFLOW,
      input: { prompt: "what is this?", session: "alice/c-pic" },
      attachments: [{ name: "pic.png", mediaType: "image/png", data: png }],
    });
    assert.equal((await alice.ok("run/get", { workflow: ORCHESTRATOR_WORKFLOW, runId, wait: 20_000 })).status, "success");
    const [turn] = (await alice.ok("conversation/get", { session: "alice/c-pic" })).turns;
    assert.deepEqual(turn.attachments, [{ name: "pic.png", mediaType: "image/png", size: 16, path: "attachments/pic.png" }]);
    const read = { workflow: ORCHESTRATOR_WORKFLOW, runId, path: turn.attachments[0].path };
    assert.equal((await alice.ok("run/files", read)).base64, png);
    assert.match((await bob.call("run/files", read)).error!, /No file/, "not bob's to read");

    await alice.ok("conversation/update", { session: "alice/c-pic", shared: true });
    const row = (await bob.ok("conversation/list")).conversations.find((c: any) => c.id === "alice/c-pic");
    assert.deepEqual([row.team, row.startedBy], [true, "alice"], "in bob's list as the team's");
    assert.equal((await bob.ok("run/files", read)).base64, png, "shared: a teammate reads its turns' files");
    await alice.ok("conversation/update", { session: "alice/c-pic", shared: false });
    assert.match((await bob.call("run/files", read)).error!, /No file/, "unshared, and bob never opened it");
  });

  it("the model picker's list: llm/models is GET /llm/models", async () => {
    const alice = page(JAMIE_APP, "alice");
    const viaStep = await alice.ok("llm/models");
    const viaRoute = await (await strut.app.request("/llm/models", { headers: { authorization: `Bearer ${KEY}` } })).json();
    assert.deepEqual(viaStep, viaRoute);
    assert.ok(viaStep.models.some((m: any) => m.provider === "anthropic" && m.available), "the key set here");
    assert.equal(typeof viaStep.default, "string");
    const bare = (await modelsStep.run({}, { services: {} } as never)) as { models: unknown[]; default: string };
    assert.ok(bare.models.length > 0, "a bare bag still lists the catalog");

    // A host's list, written as stadeum writes it: the picker offers exactly
    // it, whatever keys strut holds, and its default is the host's.
    const put = (name: string, value: string) =>
      strut.app.request(`/secrets/${name}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ value }),
      });
    const drop = (name: string) => strut.app.request(`/secrets/${name}`, { method: "DELETE", headers: { authorization: `Bearer ${KEY}` } });
    assert.equal((await put("STRUT_MODELS", JSON.stringify(["numes/z-ai/glm-5.3-flash", "anthropic/claude-opus-5-5"]))).status, 200);
    assert.equal((await put("STRUT_DEFAULT_MODEL", "anthropic/claude-opus-5-5")).status, 200);
    try {
      const listed = await alice.ok("llm/models");
      assert.deepEqual(modelChoices(listed).map((c) => c.value), ["", "anthropic/claude-opus-5-5", "numes/z-ai/glm-5.3-flash"]);
      assert.equal(listed.default, "anthropic/claude-opus-5-5");
      assert.equal(sentModel("anthropic/claude-sonnet-5-5", listed), "", "a pick the host took off the list is Default");
    } finally {
      await drop("STRUT_MODELS");
      await drop("STRUT_DEFAULT_MODEL");
    }
  });

  it("Merge is the viewer's own: strut's page reaches github/merge-pr with the viewer's GitHub token, a model-written page never", async () => {
    // No token on file for alice: the step's own refusal, past the app's grant and the person gate.
    assert.match((await page(JAMIE_APP, "alice").call("github/merge-pr", { repo: "a/b", number: 5 })).error!, /no GitHub token for you|github_/, "a GITHUB_TOKEN in this env reaches GitHub, which knows no a/b");
    assert.match((await page("acme/other", "alice").call("github/merge-pr", { repo: "a/b", number: 5 })).error!, /not|no app/i, "another app holds no grant of it");
  });

  it("a job turn names the viewer's own conversation (a captcha's answer): strut's own app only, never another's", async () => {
    const alice = page(JAMIE_APP, "alice");
    const { runId } = await alice.ok("run/launch", { workflow: "job", job: "alice-j1", input: { prompt: "[captcha-answer] {}" }, conversation: "alice/c1" });
    const start = (await alice.ok("run/events", { workflow: "job", runId })).find((e: any) => e.type === "run.start");
    assert.deepEqual([start.conversation, start.job, start.wakeAsked], ["alice/c1", "alice-j1", true]);
    assert.match((await alice.call("run/launch", { workflow: "job", job: "alice-j2", input: { prompt: "x" }, conversation: "bob/c1" })).error!, /conversation_not_yours: "bob\/c1"/);
    // A conversation she took a turn in under a bare id (a Hive one: launched with the key) is hers to name (plans/jamie-app.md §2.2).
    const hive = await strut.app.request(`/workflows/${ORCHESTRATOR_WORKFLOW}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, "x-strut-actor": "alice" },
      body: JSON.stringify({ input: { prompt: "from hive", session: "c-hive-1" } }),
    });
    assert.equal(hive.status, 202);
    const hiveRun = ((await hive.json()) as { runId: string }).runId;
    assert.equal((await alice.ok("run/get", { workflow: ORCHESTRATOR_WORKFLOW, runId: hiveRun, wait: 20_000 })).status, "success");
    const named = await alice.ok("run/launch", { workflow: "job", job: "alice-j3", input: { prompt: "x" }, conversation: "c-hive-1" });
    assert.equal((await alice.ok("run/events", { workflow: "job", runId: named.runId })).find((e: any) => e.type === "run.start").conversation, "c-hive-1");
    assert.match((await page(JAMIE_APP, "bob").call("run/launch", { workflow: "job", job: "bob-j1", input: { prompt: "x" }, conversation: "c-hive-1" })).error!, /conversation_not_yours/, "never one bob had no turn in");
    assert.match((await alice.call("run/launch", { workflow: ORCHESTRATOR_WORKFLOW, input: { prompt: "x", session: "alice/c3" }, conversation: "alice/c1" })).error!, /a JOB turn belongs to/);

    // A model-written app may not name one.
    const dir = join(root, "plain");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "app.yaml"), "title: Plain\ngrants:\n  workflows: [job]\n");
    await writeFile(join(dir, "src", "App.tsx"), "export default function App() { return <p>hi</p>; }\n");
    const published = await strut.apps.publish(dir, "plain", { surface: "person" });
    assert.ok(published.ok, JSON.stringify(published));
    const plain = page("plain", "alice");
    assert.match((await plain.call("run/launch", { workflow: "job", job: "j", input: { prompt: "x" }, conversation: "alice/c1" })).error!, /only strut's own app/);
  });

  it("a run launched elsewhere is the viewer's before its first event lands: run/get waits on it, never 'not found'", async () => {
    const alice = page(JAMIE_APP, "alice");
    // Hold the run's `run.start` until run/get has read the log to decide
    // whether the run is hers (ownRun reads its head, `getRunStart`) — the
    // window between the launch's 202 and the first event, which a loaded
    // machine widens.
    const { append, getRunStart } = store;
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let runId = "";
    store.append = async (workflow, id, event) => {
      if (workflow === ORCHESTRATOR_WORKFLOW && event.type === "run.start") await released;
      return append.call(store, workflow, id, event);
    };
    store.getRunStart = async (workflow, id) => {
      const start = await getRunStart.call(store, workflow, id);
      if (runId && id === runId) release();
      return start;
    };
    try {
      const res = await strut.app.request(`/workflows/${ORCHESTRATOR_WORKFLOW}/run`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}`, "x-strut-actor": "alice" },
        body: JSON.stringify({ input: { prompt: "from hive", session: "c-hive-race" } }),
      });
      assert.equal(res.status, 202);
      runId = ((await res.json()) as { runId: string }).runId;
      assert.equal((await alice.ok("run/get", { workflow: ORCHESTRATOR_WORKFLOW, runId, wait: 20_000 })).status, "success");
      assert.match((await page(JAMIE_APP, "bob").call("run/get", { workflow: ORCHESTRATOR_WORKFLOW, runId })).error!, /not found/, "and never another viewer's");
    } finally {
      release();
      store.append = append;
      store.getRunStart = getRunStart;
    }
  });

  it("job/verify and job/evidence: a person's acts, from strut's own app, on a job they ran", async () => {
    const dataDir = (strut.services as { dataDir: string }).dataDir;
    await (strut.services as { jobs: JobsCapability }).jobs.recordRun!("alice-jobs", { runId: "r1", workflow: "job", at: new Date().toISOString(), actor: "alice" } as never);
    const fp = { name: JAMIE_APP, version: "v1", firstParty: true as const };
    const calls: unknown[] = [];
    const services = {
      dataDir,
      jobs: {
        verify: async (job: string, o: unknown) => (calls.push(["verify", job, o]), { job, started: true }),
        evidence: async (input: unknown) => (calls.push(["evidence", input]), { ok: true, evidence: "e1", filled: true }),
      },
    };
    const ctx = (over: Record<string, unknown> = {}) => ({ app: fp, actor: "alice", workflow: "__run_step__", services, ...over }) as never;
    const cfg = { job: "alice-jobs", detach: true };
    await assert.rejects(() => verifyStep.run(cfg, ctx({ app: { name: "plain", version: "v1" } })), /a person's act/);
    await assert.rejects(() => verifyStep.run(cfg, ctx({ workflow: ORCHESTRATOR_WORKFLOW })), /a person's act/, "never an agent's tool");
    await assert.rejects(() => verifyStep.run(cfg, ctx({ actor: "bob" })), /not one you started/);
    await assert.rejects(() => verifyStep.run({ job: "nope" }, ctx()), /No job "nope"/);
    assert.deepEqual(await verifyStep.run(cfg, ctx()), { job: "alice-jobs", started: true });
    const ev = { job: "alice-jobs", claim: "c1", runId: "r1", supports: false, content: "it 404s", slot: "ev-9" };
    assert.deepEqual(await evidenceStep.run(ev, ctx()), { ok: true, evidence: "e1", filled: true });
    assert.deepEqual(calls, [["verify", "alice-jobs", { detach: true }], ["evidence", { job: "alice-jobs", claim: "c1", runId: "r1", supports: false, content: "it 404s", slot: "ev-9" }]]);
    // A filesystem workspace keeps no claims: the step says so.
    await assert.rejects(() => verifyStep.run(cfg, ctx({ services: { dataDir, jobs: {} } })), /Claims need the graph-backed workspace/);
    // And through the page's door, on this (filesystem) strut.
    const alice = page(JAMIE_APP, "alice");
    assert.match((await alice.call("job/verify", { job: "alice-jobs", detach: true })).error!, /Claims need the graph-backed workspace/);
    assert.match((await page(JAMIE_APP, "bob").call("job/verify", { job: "alice-jobs" })).error!, /not one you started/);
  });
});
