import { describe, it } from "node:test";
import assert from "node:assert/strict";
// The server's own formatters: the card parses what they write, so a format
// change that would blind the card fails here.
import { formatRunNotification } from "../../src/ai/notifier.js";
import { formatElicitationResponse } from "../../src/ai/elicitation.js";
import { STILL_VERIFYING } from "../../src/ai/verify-waker.js";
import { formatLedgerLines, formatVerifyNotification, type Ledger } from "../../src/ledger.js";
import { countLedger, isNotice, lastVerifyLabel, noticeTone, parseNotice } from "./notice";

const ledger: Ledger = {
  "clip/compute-times": [
    {
      id: "c1",
      text: "Parses hh:mm:ss timestamps.",
      status: "supported",
      assertedOnly: false,
      unverified: 0,
      latest: { content: "located 7162.96-7208.4s", observed_at: 1789678601, mode: "observed", check: "k1", checkVersion: "exec" },
      checks: [{ id: "k1", name: "reparse-and-compare", lastVerify: { ran: true } }],
    },
  ],
  "youtube-moment-clip": [
    {
      id: "c2",
      text: 'The clip covers the "moment" — described\tin the prompt.',
      status: "supported",
      assertedOnly: true,
      unverified: 0,
      checks: [{ id: "k2", name: "prompt-matches-quote", lastVerify: { ran: true } }],
    },
    {
      id: "c3",
      text: "The cut has no audible click.",
      status: "unknown",
      assertedOnly: false,
      unverified: 1,
      checks: [{ id: "k3", name: "ear", external: true, lastVerify: { planned: "e9" } }],
    },
  ],
};

describe("parseNotice", () => {
  it("ignores ordinary messages", () => {
    assert.equal(isNotice("make me a workflow"), false);
    assert.equal(parseNotice("make me a workflow"), null);
  });

  it("reads a [verify-notification]", () => {
    const n = parseNotice(formatVerifyNotification({ workflow: "youtube-moment-clip", runId: "1789678592950", ledger, costUsd: 0.0012 }))!;
    assert.equal(n.kind, "verify");
    assert.equal(n.workflow, "youtube-moment-clip");
    assert.equal(n.runId, "1789678592950");
    assert.equal(n.cost, "$0.0012");
    assert.deepEqual(n.ledger, ledger);
    // The guidance to the model is kept, not dropped.
    assert.equal(n.notes.length, 1);
    assert.match(n.notes[0]!, /^A refuted or unknown claim/);
  });

  it("reads a [run-notification] that carries the ledger", () => {
    const text = formatRunNotification({ workflow: "wf", runId: "42", status: "success", durationMs: 48_000, output: { clip: "clip.mp4" } }) + `\n${formatLedgerLines(ledger)}`;
    const n = parseNotice(text)!;
    assert.equal(n.kind, "run");
    assert.deepEqual([n.workflow, n.runId, n.runStatus, n.duration], ["wf", "42", "success", "48s"]);
    assert.deepEqual(n.output, { clip: "clip.mp4" });
    assert.deepEqual(n.ledger, ledger);
    assert.deepEqual(n.notes, ['Full details: get_run("wf", "42").']);
  });

  it("keeps a truncated output as text", () => {
    const n = parseNotice(formatRunNotification({ workflow: "wf", runId: "42", status: "success", output: { big: "x".repeat(50) } }, 20))!;
    assert.equal(n.outputTruncated, true);
    assert.equal(n.output, '{"big":"xxxxxxxxxxxx');
  });

  it("reads a multi-line error and a pending verify pass", () => {
    const text = formatRunNotification({ workflow: "wf", runId: "42", status: "error", error: { message: "ffmpeg exited 1\n  at step clip" } }) + `\n${STILL_VERIFYING}`;
    const n = parseNotice(text)!;
    assert.equal(n.runStatus, "error");
    assert.equal(n.error, "ffmpeg exited 1\n  at step clip");
    assert.equal(n.verifying, true);
    assert.equal(n.output, undefined);
    assert.equal(noticeTone(n), "error");
  });

  it("keeps an unparseable claims line as a note", () => {
    const n = parseNotice('[verify-notification] Run 1 of "wf" was verified against its claims — wf: 1 supported.\nclaims: {oops')!;
    assert.equal(n.ledger, undefined);
    assert.deepEqual(n.notes, ["claims: {oops"]);
  });
});

describe("ledger summaries", () => {
  it("counts statuses, asserted-only and waiting claims", () => {
    assert.deepEqual(countLedger(ledger), { total: 3, supported: 2, refuted: 0, unknown: 1, stale: 0, assertedOnly: 1, waiting: 1 });
  });

  it("tones a notice by the worst thing in it", () => {
    const verify = (l: Ledger) => parseNotice(formatVerifyNotification({ workflow: "wf", runId: "1", ledger: l }))!;
    assert.equal(noticeTone(verify(ledger)), "warning");
    assert.equal(noticeTone(verify({ wf: ledger["clip/compute-times"]! })), "ok");
    assert.equal(noticeTone(verify({ wf: [{ ...ledger["clip/compute-times"]![0]!, status: "refuted" }] })), "error");
  });

  it("a check that cannot launch reads as broken, not skipped-and-fine", () => {
    assert.deepEqual(lastVerifyLabel({ skipped: "cannot-launch", reason: "step_config is not JSON" }), { label: "skipped · cannot-launch", tone: "error", detail: "step_config is not JSON" });
    assert.equal(lastVerifyLabel({ skipped: "policy" }).tone, "dim");
    assert.equal(lastVerifyLabel(undefined).label, "did not fire");
  });
});

// ── [elicitation-response] ─────────────────────────────────────────────────

describe("elicitation responses", () => {
  it("parses an accepted form answer: who answered and the content", () => {
    const text = formatElicitationResponse({ elicitationId: "e1", action: "accept", by: "alice-42", content: { repo: "a/b", env: "staging" } });
    assert.ok(isNotice(text));
    const n = parseNotice(text)!;
    assert.equal(n.kind, "elicitation");
    assert.equal(n.elicitationId, "e1");
    assert.equal(n.action, "accept");
    assert.equal(n.by, "alice-42");
    assert.deepEqual(n.content, { repo: "a/b", env: "staging" });
    assert.equal(n.secretName, undefined);
    assert.equal(noticeTone(n), "ok");
  });

  it("parses a stored secret by name only", () => {
    const n = parseNotice(formatElicitationResponse({ elicitationId: "e2", action: "accept", secret: { name: "SLACK_BOT_TOKEN" } }))!;
    assert.equal(n.action, "accept");
    assert.equal(n.by, undefined);
    assert.equal(n.secretName, "SLACK_BOT_TOKEN");
    assert.equal(n.secretStored, true);
    assert.equal(n.content, undefined);
  });

  it("parses a declined secret and a cancelled form", () => {
    const d = parseNotice(formatElicitationResponse({ elicitationId: "e3", action: "decline", by: "bob", secret: { name: "K" } }))!;
    assert.equal(d.action, "decline");
    assert.equal(d.secretName, "K");
    assert.equal(d.secretStored, false);
    assert.equal(noticeTone(d), "warning");
    const c = parseNotice(formatElicitationResponse({ elicitationId: "e4", action: "cancel" }))!;
    assert.equal(c.action, "cancel");
    assert.equal(c.by, undefined);
    assert.equal(noticeTone(c), "neutral");
    assert.deepEqual(c.notes, []);
  });
});
