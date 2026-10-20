import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import acpStep, { decidePermission, parseAgent } from "./prompt.js";

/**
 * A fake ACP agent: a few dozen lines of node on stdio. Each prompt streams
 * two prose chunks, one shell call that asks for permission, then a closing
 * chunk. It supports session/load and remembers how many prompts a session
 * has had, so a test can see a thread continue. Its cost is the session
 * total, as real agents report it. With ACP_TEST_LEAK in its env the closing
 * chunk echoes it (what an agent in auto mode could do with `env`); with
 * FAKE_HOLD it holds the prompt until session/cancel, counts the cancels it
 * gets, and answers "cancelled" a little later.
 */
const FAKE_AGENT = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
const turns = {};
let pendingPerm = null;
const modes = { currentModeId: "default", availableModes: [{ id: "default" }, { id: "plan" }, { id: "acceptEdits" }, { id: "bypassPermissions" }] };
let held = null;
let cancels = 0;
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "session/cancel") {
    cancels++;
    if (held && cancels === 1) setTimeout(() => {
      update(held.sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "cancels=" + cancels } });
      send({ id: held.prompt, result: { stopReason: "cancelled" } });
    }, 700);
    return;
  }
  if (m.method === "initialize") return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  if (m.method === "session/new") { const id = "s-" + Date.now(); turns[id] = 0; return send({ id: m.id, result: { sessionId: id, modes } }); }
  if (m.method === "session/load") {
    const id = m.params.sessionId;
    turns[id] = Number(process.env.FAKE_PRIOR_TURNS || 0);
    update(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "(replayed history)" } });
    return send({ id: m.id, result: { modes } });
  }
  if (m.method === "session/set_mode") { process.stderr.write("mode=" + m.params.modeId + "\\n"); return send({ id: m.id, result: {} }); }
  if (m.method === "session/prompt") {
    const sid = m.params.sessionId;
    if (process.env.FAKE_HOLD) { held = { prompt: m.id, sid }; return; }
    turns[sid] = (turns[sid] || 0) + 1;
    update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Turn " + turns[sid] + ": " } });
    update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "looking." } });
    update(sid, { sessionUpdate: "tool_call", toolCallId: "e1", title: "Write calc.py", kind: "edit", status: "completed", locations: [{ path: process.cwd() + "/calc.py" }] });
    update(sid, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Run tests", kind: "execute", status: "pending" });
    pendingPerm = { prompt: m.id, sid };
    if (process.env.FAKE_PLAN) {
      // Ask to leave plan mode first; the answer is ignored, then the shell call asks too.
      send({ id: 98, method: "session/request_permission", params: { sessionId: sid, toolCall: { toolCallId: "p1", title: "Ready to code?", kind: "switch_mode", rawInput: { plan: "1. Fix add()" } },
        options: [{ optionId: "yes", name: "Yes", kind: "allow_once" }, { optionId: "no", name: "No", kind: "reject_once" }] } });
    }
    return send({ id: 99, method: "session/request_permission", params: { sessionId: sid, toolCall: { toolCallId: "t1", title: "Run tests", kind: "execute" },
      options: [{ optionId: "yes", name: "Yes", kind: "allow_once" }, { optionId: "no", name: "No", kind: "reject_once" }] } });
  }
  if (m.id === 98) return;
  if (m.id === 99 && pendingPerm) {
    const ok = m.result.outcome.optionId === "yes";
    const { sid, prompt } = pendingPerm;
    update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: ok ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: ok ? "3 passed" : "denied" } }] });
    const leak = process.env.ACP_TEST_LEAK ? " leak=" + process.env.ACP_TEST_LEAK : "";
    update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: (ok ? "All good." : "Could not run tests.") + leak } });
    update(sid, { sessionUpdate: "usage_update", used: 10, size: 100, cost: { amount: 0.01 * turns[sid], currency: "USD" } });
    pendingPerm = null;
    return send({ id: prompt, result: { stopReason: "end_turn" } });
  }
});
`;

function setup(control?: { state: string; checkpoint: () => Promise<void> }) {
  const dir = mkdtempSync(join(tmpdir(), "acp-test-"));
  const agent = join(dir, "fake-agent.cjs");
  writeFileSync(agent, FAKE_AGENT);
  const events: Array<Record<string, any>> = [];
  const ctx = {
    runId: "r1",
    path: "wf/work",
    scope: {},
    input: {},
    services: { dataDir: dir },
    emit: async (e: Record<string, any>) => void events.push(e),
    ...(control ? { control } : {}),
  } as any;
  const run = (cfg: Record<string, unknown>, env?: Record<string, string>) =>
    acpStep.run(acpStep.input.parse({ agent: `${process.execPath} ${agent}`, cwd: dir, env, ...cfg }) as any, ctx) as Promise<any>;
  return { dir, events, run };
}

describe("acp/prompt", () => {
  it("runs a turn, streams prose and tool calls as events, and allows what auto mode allows", async () => {
    const { events, run } = setup();
    const out = await run({ prompt: "check it", mode: "auto" });
    assert.equal(out.text, "Turn 1: looking.\n\nAll good.");
    assert.equal(out.stopReason, "end_turn");
    assert.deepEqual(out.denied, []);
    assert.equal(out.ask, undefined);
    assert.equal(out.toolCalls, 2);
    assert.deepEqual(out.artifacts, [{ id: "calc.py", title: "calc.py", kind: "code", path: "calc.py" }]);
    assert.equal(out.cost, 0.01);
    assert.deepEqual(
      events.map((e) => `${e.type} ${e.stepType}`),
      [
        "step.start message", "step.end message",
        "step.start tool:edit", "step.end tool:edit",
        "step.start tool:execute", "step.end tool:execute",
        "step.start message", "step.end message",
      ],
    );
    const tool = events.find((e) => e.type === "step.end" && e.stepType === "tool:execute")!;
    assert.equal(tool.path, "wf/work/003-execute");
    assert.deepEqual(tool.output, { title: "Run tests", input: undefined, output: "3 passed" });
  });

  it("refuses what the mode doesn't allow and says so in denied and ask", async () => {
    const { events, run } = setup();
    const out = await run({ prompt: "check it", mode: "edit" });
    assert.deepEqual(out.denied, [{ title: "Run tests", kind: "execute" }]);
    assert.match(out.ask.message, /edit mode.*Run tests/);
    assert.ok(events.some((e) => e.type === "step.error" && e.stepType === "tool:execute"));
  });

  it("turns a refused exit from plan mode into an ask that carries the plan", async () => {
    const { run } = setup();
    const out = await run({ prompt: "plan it", mode: "plan" }, { FAKE_PLAN: "1" });
    assert.deepEqual(out.denied.map((d: any) => d.kind), ["switch_mode", "execute"]);
    assert.match(out.ask.message, /^The agent has a plan and wants to carry it out:\n\n1\. Fix add\(\)/);
    assert.match(out.ask.message, /kept the agent from: Run tests\./);
  });

  it("continues a named session with session/load, ignores the replayed history, and reports each turn's own cost", async () => {
    const { run } = setup();
    const first = await run({ prompt: "one", session: "job-1", mode: "auto" });
    assert.equal(first.session, "job-1");
    const second = await run({ prompt: "two", session: "job-1", mode: "auto" }, { FAKE_PRIOR_TURNS: "1" });
    assert.match(second.text, /^Turn 2: /);
    assert.doesNotMatch(second.text, /replayed/);
    assert.equal(first.cost, 0.01);
    assert.equal(Number(second.cost.toFixed(6)), 0.01, "the turn's own spend, not the session total");
  });

  it("hands the agent the scrubbed shell env plus the step's own, nothing of the server's", async () => {
    const { run } = setup();
    process.env["ACP_TEST_LEAK"] = "server-secret";
    try {
      const out = await run({ prompt: "check it", mode: "auto" });
      assert.equal(out.text, "Turn 1: looking.\n\nAll good.", "the server's env never reaches the agent");
      const seen = await run({ prompt: "check it", mode: "auto" }, { ACP_TEST_LEAK: "1" });
      assert.match(seen.text, /All good\. leak=1$/, "the step's own env does");
    } finally {
      delete process.env["ACP_TEST_LEAK"];
    }
  });

  it("on cancel tells the agent once and lets checkpoint() raise, so the cut-off turn is no result", async () => {
    let checkpoints = 0;
    const control = {
      state: "cancelling",
      checkpoint: async () => {
        checkpoints++;
        throw new Error("cancelled");
      },
    };
    const { events, run } = setup(control);
    await assert.rejects(run({ prompt: "long task", mode: "auto" }, { FAKE_HOLD: "1" }), /^Error: cancelled$/);
    assert.equal(checkpoints, 1);
    const last = events.filter((e) => e.type === "step.end" && e.stepType === "message").pop();
    assert.equal(last?.output, "cancels=1", "session/cancel went out once, not every 300 ms");
  });

  it("fails with the agent's own words when it cannot start", async () => {
    const { run } = setup();
    await assert.rejects(run({ agent: "definitely-not-an-acp-agent", prompt: "x" }), /could not start|exited/);
  });

  it("rejects a session name a missing template would produce", async () => {
    const { run } = setup();
    await assert.rejects(run({ prompt: "x", session: "/review" }), /session has an empty segment/);
  });
});

describe("acp/prompt helpers", () => {
  it("expands presets and splits a command line", () => {
    assert.deepEqual(parseAgent("goose"), ["goose", "acp"]);
    assert.deepEqual(parseAgent('node "/a b/agent.js" --x'), ["node", "/a b/agent.js", "--x"]);
  });

  it("decides permission by tool kind", () => {
    const req = (kind: string) => ({
      sessionId: "s",
      toolCall: { toolCallId: "t", kind },
      options: [
        { optionId: "a", name: "Yes", kind: "allow_once" },
        { optionId: "r", name: "No", kind: "reject_once" },
      ],
    });
    assert.equal(decidePermission("plan", req("read")).allowed, true);
    assert.equal(decidePermission("plan", req("edit")).allowed, false);
    assert.equal(decidePermission("edit", req("edit")).allowed, true);
    assert.deepEqual(decidePermission("edit", req("execute")), { outcome: "selected", optionId: "r", allowed: false });
    assert.deepEqual(decidePermission("auto", req("execute")), { outcome: "selected", optionId: "a", allowed: true });
  });
});
