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
import { secp256k1 } from "@noble/curves/secp256k1";
import { appIdentity } from "../auth.js";
import { lnSign, stepCall } from "../test-util/public-door.js";
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
import type { Conversations } from "../conversations.js";
import { BUSY_NOTICE, NOT_SHARED_NOTICE, NOT_YOURS_NOTICE, readRefusal, detectSlash, groupByDay, hostPlace, insertSlash, isOwn, mayContinue, modelChoices, modelParams, newConversationId, ownerLabel, readsAsAdmin, sendRefusal, sentModel, silentReply, timeLine, turnContext, withoutAsk } from "./jamie/src/lib/chat.js";
import { appKey, cardWord, carded, evidenceOf, inlineKind, openable, placeArtifact, placementOf, servedFile, turnDeliverables } from "./jamie/src/lib/artifacts.js";
import { answeredSince, askedSecret, captchaPrompt, claimPill, holdLinks, jobLook, jobRunWorkflow, livePicture, liveStrip, openSlot, parseCaptcha, secretAlreadySet, secretPrompt, sortClaims, tapAt, toggleCell } from "./jamie/src/lib/jobs.js";
import type { LedgerClaim, ModelCatalog } from "./jamie/src/lib/types.js";
import { canMerge, checksLine, fixPrompt, prKey, prLive, prOf, prPill } from "./jamie/src/lib/pr.js";
import { acceptLook, waitingFor } from "./jamie/src/lib/proposals.js";
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
  it("with an ask, the reply drops its closing question and request sentences, so the question shows once, in its box", () => {
    const plan = "Here's my plan:\n\n- **Pay:** $4 per visit. Please change this if you want.";
    const ask = "Does the plan work for you? Please send the names of your 6 shops.";
    // What the model wrote in real runs, the question again at the end of the reply.
    assert.equal(withoutAsk(`${plan}\n\nIs $4 per visit right, and do you want "any time" rather than a weekly round? I'd also need the names of your 6 shops.`, ask), plan);
    assert.equal(withoutAsk(`${plan}\n\nI need two things from you: the names and addresses of your 6 shops, and whether $4 is right.`, ask), plan);
    assert.equal(withoutAsk(`${plan}\n\nIs that OK, or what would you change?`, ask), plan);
    assert.equal(withoutAsk(`${plan}\n\nTwo things I need from you: the names of the 6 shops, and whether $4 suits you.`, ask), plan);
    assert.equal(
      withoutAsk(`${plan}\n\nI need one thing from you. Please attach the spreadsheet, with the shop name and phone number. Also tell me whether workers should say anything specific, such as a short pitch.`, ask),
      plan,
    );
    // And one that tells them how to answer.
    assert.equal(
      withoutAsk(`${plan}\n\nTo build it I need two things from you: your spreadsheet (attach it, or tell me the column names), and a couple of lines on what the caller should say. Reply "yes" with those, or change anything above.`, ask),
      plan,
    );
    // Only the CLOSING asks: a statement before them stays.
    assert.equal(withoutAsk("Built it. The pay is $4. Want me to change it?", ask), "Built it. The pay is $4.");
    // Left as it is: no ask; a reply that does not ask; a list; one that would be empty.
    assert.equal(withoutAsk(`${plan}\n\nIs that OK?`, undefined), `${plan}\n\nIs that OK?`);
    const done = `${plan}\n\nAfter it's built, you'll approve the pay and put the worker page online.`;
    assert.equal(withoutAsk(done, ask), done);
    assert.equal(withoutAsk(plan, ask), plan, "a list ends it: never cut");
    assert.equal(withoutAsk("Which repo?", ask), "Which repo?", "never an empty reply");
  });

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
    assert.equal(readRefusal('No conversation "bob/1a2b" (or not yours to read)'), NOT_SHARED_NOTICE, "a link to a chat not shared with you");
    assert.equal(readRefusal('step_run: No conversation "bob/1a2b" (or not yours to read)'), NOT_SHARED_NOTICE);
    assert.equal(readRefusal("fetch failed"), null, "any other error is shown as it is");
    assert.ok(silentReply(" [silent]\n"));
    assert.ok(!silentReply("Done."));
  });

  it("an admin's Everyone: whose a row is, which open as a reader, and which a reader may still continue", () => {
    assert.equal(ownerLabel({ id: "carol/c1", startedBy: "carol" }), "carol");
    assert.equal(ownerLabel({ id: "root/fork", startedBy: "carol" }), "root", "a fork's first turns are its source's: the id says whose it is");
    assert.equal(ownerLabel({ id: "hive-1", startedBy: "dave" }), "dave", "a bare id: who started it");
    assert.equal(ownerLabel({ id: "host/sphinx/abc", host: "sphinx", startedBy: "alice" }), "alice");
    assert.equal(ownerLabel({ id: "host/sphinx/abc", host: "sphinx" }), "a Sphinx tribe", "a host's with no one named: where it is continued");
    assert.equal(ownerLabel({ id: "hive-2" }), "");
    assert.equal(readsAsAdmin({ id: "carol/c1", startedBy: "carol" }, "root"), true);
    assert.equal(readsAsAdmin({ id: "root/c1" }, "root"), false, "their own id");
    assert.equal(readsAsAdmin({ id: "hive-1", startedBy: "root" }, "root"), false, "one they started");
    const view = (participants: string[], shared?: true) => ({ conversation: shared ? { shared } : {}, participants });
    assert.equal(mayContinue(view(["carol"]), "carol/c1", "root"), false, "someone else's: read-only");
    assert.equal(mayContinue(view(["carol", "root"]), "carol/c1", "root"), true, "one they took a turn in");
    assert.equal(mayContinue(view(["carol"], true), "carol/c1", "root"), true, "a shared one");
    assert.equal(mayContinue(view([]), "root/c1", "root"), true, "their own id");
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
    // What a message and a card's job turn carry: the pick, or nothing.
    assert.deepEqual(modelParams("anthropic/claude-opus-5-5"), { params: { model: "anthropic/claude-opus-5-5" } });
    assert.deepEqual(modelParams(""), {}, "Default: the workflow's own model");
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
    // The declared kind where it says more than the path: a recording listed
    // by its directory plays from its manifest; a spreadsheet file is the host's.
    assert.deepEqual(place({ id: "w", kind: "walkthrough", title: "Sign in", url: "/jobs/j1/files/walkthroughs/001" }), { show: "file", kind: "walkthrough", path: "walkthroughs/001/walkthrough.json", run: { workflow: "job", runId: "r-job" }, job: "j1" });
    assert.equal(place({ id: "x", kind: "table", title: "Book", url: "/jobs/j1/files/book.xlsx" }).show, "link", "an .xlsx is no CSV");
    assert.equal(inlineKind("rows.json", "table"), "table");
    assert.equal(inlineKind("src/App.tsx"), "text", "source reads as text");
    // A document's HTML rendition draws inline.
    assert.deepEqual(place({ id: "d", kind: "docx", title: "Contract", url: "/jobs/j1/files/c.docx", render: "/jobs/j1/files/c.html" }), { show: "file", kind: "html", path: "c.html", run: { workflow: "job", runId: "r-job" }, job: "j1" });
    // Words of a plain-text kind are text, not markdown: a diff's lines are no list.
    assert.deepEqual(place({ id: "df", kind: "diff", title: "Patch", content: "- a\n+ b" }), { show: "content", kind: "text", text: "- a\n+ b" });
    // The card's word: the agent's label, else its kind's.
    assert.equal(cardWord({ kind: "walkthrough" }), "recording");
    assert.equal(cardWord({ kind: "markdown", label: "Plan" }), "Plan");
    assert.equal(cardWord({ kind: "url" }, "notes/x.bin"), "file");
    assert.equal(cardWord({ kind: "markdown" }), "");
  });

  it("how deliverables lay out: pictures as thumbnails, reference material folded, the rest as rows; a claim's evidence drawn in place", () => {
    const lay = (ref: Parameters<typeof placeArtifact>[0]) => placementOf(ref, placeArtifact(ref, runs));
    assert.equal(lay({ id: "s", kind: "image", title: "Shot", url: "/jobs/j1/files/shots/001.png" }), "thumb");
    assert.equal(lay({ id: "w", kind: "walkthrough", title: "Flow", url: "/jobs/j1/files/walkthroughs/001/walkthrough.json" }), "thumb");
    assert.equal(lay({ id: "v", kind: "video", title: "Clip", url: "/jobs/j1/files/clip.mp4" }), "thumb");
    assert.equal(lay({ id: "l", kind: "log", title: "Build log", url: "/jobs/j1/files/build.log" }), "folded");
    assert.equal(lay({ id: "d", kind: "diff", title: "Patch", content: "- a" }), "folded");
    assert.equal(lay({ id: "p", kind: "markdown", title: "Plan", url: "/jobs/j1/files/plan.md" }), "row");
    assert.equal(lay({ id: "n", kind: "text", title: "Notes", url: "/jobs/j1/files/notes.txt" }), "row", "notes are no log");
    assert.equal(lay({ id: "pr", kind: "pull_request", title: "PR", url: "https://github.com/a/b/pull/1" }), "row");
    assert.deepEqual(evidenceOf({ url: "/jobs/j1/files/shots/002.png?t=x" }), { show: "image", path: "shots/002.png", href: "?artifact=%2Fjobs%2Fj1%2Ffiles%2Fshots%2F002.png" });
    assert.deepEqual(evidenceOf({ url: "/jobs/j1/files/walkthroughs/001/walkthrough.json" }), { show: "walkthrough", path: "walkthroughs/001/walkthrough.json", href: "?artifact=%2Fjobs%2Fj1%2Ffiles%2Fwalkthroughs%2F001%2Fwalkthrough.json" });
    assert.deepEqual(evidenceOf({ url: "/jobs/j1/files/out.html" }), { show: "link", href: "?artifact=%2Fjobs%2Fj1%2Ffiles%2Fout.html", external: false });
    assert.deepEqual(evidenceOf({ url: "https://pod.example/settings" }), { show: "link", href: "https://pod.example/settings", external: true });
    assert.equal(evidenceOf(undefined), null);
  });

  it("an app named only by its document's link is still an app; an entry that opens nothing is no card", () => {
    assert.equal(appKey({ id: "a", kind: "app", title: "Ask X", url: "/apps/x-research/v2/files/dist/index.html?t=tok" }), "x-research@v2");
    assert.equal(appKey({ id: "a", kind: "app", title: "Dash", url: "/apps/acme%2Fdash/v3/files/dist/index.html" }), "acme/dash@v3");
    assert.deepEqual(placeArtifact({ id: "a", kind: "app", title: "Ask X", url: "/apps/x-research/v2/files/dist/index.html" }, runs), { show: "link", href: "?app=x-research%40v2", external: false, what: "app" });
    assert.equal(openable({ id: "x", kind: "url", title: "Ask X", summary: "The app" }), false, "a copy that kept only its title and summary");
    assert.equal(openable({ id: "m", kind: "markdown", title: "Gone", error: "not found" }), false);
    assert.equal(carded({ id: "m", kind: "markdown", title: "Gone", error: "not found" }), true, "a job's deliverable says why it is missing");
    assert.equal(carded({ id: "x", kind: "url", title: "Ask X" }), false);
    assert.equal(openable({ id: "a", kind: "app", title: "Ask X", app: { name: "x-research", version: "v2" } }), true);
    assert.equal(openable({ id: "n", kind: "markdown", title: "Note", content: "# Hi" }), true);
    assert.equal(openable({ id: "f", kind: "markdown", title: "Far", peer: "acme-web", job: "j7", path: "report.md" }), true);
  });

  it("a turn's deliverables: under a wake's reply what the job delivered, a failed one saying why; the reply's copy of one, or its entry that opens nothing, never shows", () => {
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
    assert.deepEqual(delivered.map((d) => d.artifact.id), ["ask-x", "plan", "gone"]);
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

  it("a job's card: a row for each hold with an address, opened beside the chat by the job and kind — never the address", () => {
    const pod = "https://p1a2b3-3000.stakwork.bot/_pods/open/tok";
    assert.deepEqual(holdLinks("j 1", { pod }), [{ kind: "pod", label: "Open pod", url: pod, beside: "?job=j%201&hold=pod" }]);
    assert.deepEqual(holdLinks("j", undefined), []);
    assert.deepEqual(holdLinks("j", {}), [], "no hold has an address: no row");
    assert.deepEqual(holdLinks("j", { pod: "javascript:alert(1)", box: "/relative" }), [], "only an http(s) address");
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
    assert.deepEqual(strip.items, [], "a line with no checklist");
    assert.deepEqual(strip.tally, ["1 recording, 1 stopped", "2 shots", "pod held", "2 checks: 1 supported, 1 waiting on a look"]);
    assert.equal(strip.shot?.url, "/jobs/j/files/w/walkthrough.json");
  });

  it("the live strip's checklist: the newest status's items, what is whole of them; an older status's never", () => {
    const at = "2026-11-04T10:00:00Z";
    const first = { kind: "status", at, runId: "r1", title: "Reading the repo", detail: { items: [{ text: "Read the repo", state: "doing" }, { text: "Write the fix", state: "todo" }] } };
    assert.deepEqual(liveStrip([first], "r1").items, [{ text: "Read the repo", state: "doing" }, { text: "Write the fix", state: "todo" }]);
    // The feed keeps one status per run, the newest: its list is the list.
    const next = {
      kind: "status",
      at,
      runId: "r1",
      title: "Writing the fix",
      detail: { round: 2, items: [{ text: "Read the repo", state: "done" }, { text: "Write the fix", state: "doing" }, { text: "", state: "todo" }, { text: "Ship it", state: "later" }, null] },
    };
    const strip = liveStrip([{ kind: "status", at, runId: "r0", title: "an older turn's", detail: { items: [{ text: "x", state: "done" }] } }, next], "r1");
    assert.equal(strip.status, "Writing the fix");
    assert.deepEqual(strip.items, [{ text: "Read the repo", state: "done" }, { text: "Write the fix", state: "doing" }], "an empty step or an unknown state is dropped");
    assert.deepEqual(liveStrip([{ kind: "status", at, runId: "r1", title: "x", detail: { items: "not a list" } }], "r1").items, []);
  });

  it("the live strip's tile: a shot is its own picture, a recording its newest frame; only the job's own files", () => {
    const at = "2026-11-04T10:00:00Z";
    assert.deepEqual(livePicture({ kind: "image", at, url: "/jobs/j/files/shots/002.png" }, "j"), { open: "/jobs/j/files/shots/002.png", picture: "shots/002.png" });
    const rec = { kind: "walkthrough", at, url: "/jobs/j/files/walkthroughs/001/walkthrough.json", state: "recording" };
    // Until its manifest is read, a recording has no picture yet.
    assert.deepEqual(livePicture(rec, "j"), { open: rec.url, manifest: "walkthroughs/001/walkthrough.json" });
    const manifest = JSON.stringify({ status: "recording", frames: [{ file: "01.png", caption: "Sign-in page" }, { file: "02.png", caption: "Signed in" }] });
    assert.deepEqual(livePicture(rec, "j", manifest), {
      open: rec.url,
      manifest: "walkthroughs/001/walkthrough.json",
      picture: "walkthroughs/001/02.png",
      caption: "Signed in",
    });
    assert.deepEqual(livePicture(rec, "j", "not json"), { open: rec.url, manifest: "walkthroughs/001/walkthrough.json" });
    assert.equal(livePicture({ kind: "image", at, url: "/jobs/other/files/shots/001.png" }, "j"), null, "another job's file");
    assert.equal(livePicture({ kind: "image", at, url: "/artifacts/r1/shots/001.png" }, "j"), null, "a run's own artifacts");
    assert.equal(livePicture({ kind: "image", at }, "j"), null);
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

  it("a proposal only an admin accepts: Accept for an admin, the line for anyone else, neither until the live read says who the viewer is", () => {
    assert.equal(acceptLook(undefined, undefined), "accept", "any other proposal: Accept, as before");
    assert.equal(acceptLook(undefined, { admin: false }), "accept");
    assert.equal(acceptLook("admin", { admin: true }), "accept");
    assert.equal(acceptLook("admin", { admin: false }), "admin");
    assert.equal(acceptLook("admin", undefined), "unknown");
    // Someone else's card in a shared conversation: whose ask it was, by name.
    assert.equal(waitingFor("evanfeenstra-cd06a17ecfb5779b4a71"), "Waiting for evanfeenstra to decide: it was their ask.");
    assert.equal(waitingFor(undefined), "Waiting for the person who asked to decide.");
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

  /** The seeded app's `step_run`, as `actor` (none: no person); `admin`
   *  when the door holds full scope (an admin's session). */
  const page = (name: string, actor?: string, admin = false) => {
    const tools = buildAppTools({ apps: strut.apps, registry, services: strut.services, ...(actor ? { actor } : {}), admin, runStepDeps: { store, workspace: strut.workspace } });
    const app = appIdentity(name, "v1");
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
      // The app door, as a page reaches it (Connect's link challenge).
      enableMcp: true,
      scheduler: false,
      builder: false,
      autoResume: false,
      browserWorkflows: false,
      privacyWorkflows: false, mediaWorkflows: false,
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

  it("an admin's Everyone (plans/jamie-app.md §2.3): anyone's conversation listed and read as it is, its files too, never a member's; a turn in it still refused; Continue here forks the admin's own", async () => {
    const carol = page(JAMIE_APP, "carol");
    const root = page(JAMIE_APP, "root", true);
    const conversations = (strut.services as unknown as { conversations: Conversations }).conversations;
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
    const { runId } = await carol.ok("run/launch", {
      workflow: ORCHESTRATOR_WORKFLOW,
      input: { prompt: "how do I start?", session: "carol/c-new" },
      attachments: [{ name: "pic.png", mediaType: "image/png", data: png }],
    });
    assert.equal((await carol.ok("run/get", { workflow: ORCHESTRATOR_WORKFLOW, runId, wait: 20_000 })).status, "success");
    for (let i = 0; i < 500 && !(await conversations.record("carol/c-new"))?.turns.at(-1)?.status; i++) await new Promise((r) => setTimeout(r, 10));
    const carolsRow = async () => (await carol.ok("conversation/list")).conversations.find((c: any) => c.id === "carol/c-new");
    const before = { row: await carolsRow(), record: await conversations.record("carol/c-new") };

    // The list says who may ask: an admin's page; anyone else is refused.
    assert.deepEqual([(await root.ok("conversation/list")).admin, (await carol.ok("conversation/list")).admin], [true, undefined]);
    assert.match((await carol.call("conversation/list", { everyone: true })).error!, /conversation\/list \{ everyone \} is an admin's/);
    assert.match((await carol.call("conversation/get", { session: "carol/c-new", everyone: true })).error!, /conversation\/get \{ everyone \} is an admin's/);

    const listed = (await root.ok("conversation/list", { everyone: true, q: "carol" })).conversations;
    assert.deepEqual(listed.map((c: any) => [c.id, c.startedBy, c.unread]), [["carol/c-new", "carol", false]]);
    const view = await root.ok("conversation/get", { session: "carol/c-new", everyone: true });
    assert.deepEqual([view.turns[0].prompt, view.conversation.unread, view.participants], ["how do I start?", false, ["carol"]]);
    const file = { workflow: ORCHESTRATOR_WORKFLOW, runId, path: view.turns[0].attachments[0].path };
    assert.equal((await root.ok("run/files", file)).base64, png, "its turns' files too");
    assert.match((await page(JAMIE_APP, "bob").call("run/files", file)).error!, /No file/, "never a member's");
    assert.match((await root.call("conversation/get", { session: "carol/c-new" })).error!, /No conversation/, "without everyone it is not theirs");

    // Reading leaves no trace: not a viewer, not in the admin's list, carol's row as it was.
    assert.deepEqual(await conversations.record("carol/c-new"), before.record);
    assert.deepEqual(await carolsRow(), before.row);
    assert.ok(!(await root.ok("conversation/list")).conversations.some((c: any) => c.id === "carol/c-new"));

    // Reading is not a turn.
    assert.match((await root.call("run/launch", { workflow: ORCHESTRATOR_WORKFLOW, input: { prompt: "let me", session: "carol/c-new" } })).error!, /conversation_not_yours/);

    // Continue here: a copy that is the admin's, and theirs to continue.
    const fork = await root.ok("conversation/fork", { session: "carol/c-new", everyone: true });
    assert.match(fork.id, /^root\/[0-9a-f]{12}$/);
    assert.equal(fork.forkedFrom, "carol/c-new");
    assert.deepEqual((await root.ok("conversation/list")).conversations.map((c: any) => c.id), [fork.id]);
    const next = await root.ok("run/launch", { workflow: ORCHESTRATOR_WORKFLOW, input: { prompt: "carrying on", session: fork.id } });
    assert.equal((await root.ok("run/get", { workflow: ORCHESTRATOR_WORKFLOW, runId: next.runId, wait: 20_000 })).status, "success");
    assert.ok(!(await carol.ok("conversation/list")).conversations.some((c: any) => c.id === fork.id), "never carol's");
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

  it("Connect and tribe conversations (plans/people-and-hosts.md §2.1; plans/jamie-in-tribes.md §5.1): the viewer's own link challenge and links; a host's conversation forked, never continued here", async () => {
    assert.equal(hostPlace("sphinx"), "a Sphinx tribe");
    assert.equal(hostPlace("email"), "email");
    const alice = page(JAMIE_APP, "alice");
    // Link Peel, as the page asks on the app door: a challenge naming her,
    // bound to strut's address as the request reached it.
    const made = await stepCall((p, i) => strut.app.request(`http://jamie.box${p}`, i), "/mcp", "account/link", {}, { authorization: `Bearer ${KEY}`, "x-strut-actor": "alice" }, appIdentity(JAMIE_APP, "v1"));
    assert.equal(made.error, undefined, made.error);
    const offer = made.result as { challenge: string; link: string };
    assert.equal(new URL(offer.link).searchParams.get("url"), "http://jamie.box");
    // Peel signs it with its Sphinx key and posts it where the link says.
    const priv = secp256k1.utils.randomPrivateKey();
    const KEY_HEX = Buffer.from(secp256k1.getPublicKey(priv, true)).toString("hex");
    const res = await strut.app.request("http://jamie.box/people/link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challenge: offer.challenge, key: KEY_HEX, sig: Buffer.from(lnSign(priv, offer.challenge)).toString("hex"), name: "alice on sphinx" }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(((await res.json()) as { actor: string }).actor, "alice");
    assert.deepEqual((await alice.ok("account/links")).links.map((l: any) => [l.account, l.name]), [[`sphinx:${KEY_HEX}`, "alice on sphinx"]]);
    assert.deepEqual((await page(JAMIE_APP, "bob").ok("account/links")).links, [], "never another's");
    assert.deepEqual(await page(JAMIE_APP, "bob").ok("account/unlink", { account: `sphinx:${KEY_HEX}` }), { removed: false });
    assert.deepEqual(await alice.ok("account/unlink", { account: `sphinx:${KEY_HEX}` }), { removed: true });

    // A host's conversation: its host alone takes a turn in it.
    const hosted = await alice.call("run/launch", { workflow: ORCHESTRATOR_WORKFLOW, input: { prompt: "from the app", session: "host/sphinx/0123456789ab" } });
    assert.match(hosted.error!, /conversation_hosted: "host\/sphinx\/0123456789ab"/);
    assert.match((await alice.call("run/launch", { workflow: "job", job: "alice-jh", input: { prompt: "x" }, conversation: "host/sphinx/0123456789ab" })).error!, /conversation_hosted/);
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
