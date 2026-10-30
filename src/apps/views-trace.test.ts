// strut/views' AgentTrace: what it draws of the gallery's multi-agent run,
// its live replay read the way useRunEvents reads a run in flight, and the
// HTML file "Download HTML" saves. The DOM is happy-dom's (the kit's).
import "../../kit/src/test-dom.js";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { foldAgentTrace, type TraceEvent } from "@strut/kit/folds";
import { teardownDom } from "../../kit/src/test-dom.js";
import { createFixtureClient } from "./views/src/fixtures/client.js";
import { WORKFLOW } from "./views/src/fixtures/runs.js";
import { TRACE_EVENTS, TRACE_LIVE_RUN_ID, TRACE_RUN_ID } from "./views/src/fixtures/trace.js";
import { fileName, snapshotHtml } from "./views/src/components/agent-trace/snapshot.js";

after(teardownDom);

describe("strut/views — AgentTrace", () => {
  it("folds the gallery's run into its agents: three in parallel, then the writer, then the reviewer; two sub-agents", () => {
    const m = foldAgentTrace(TRACE_EVENTS as TraceEvent[]);
    assert.equal(m.finished, true);
    assert.deepEqual(m.agents.map((a) => [a.session.label, a.batch, a.session.status]), [
      ["plan", 0, "success"],
      ["read#0", 0, "success"],
      ["read#1", 0, "success"],
      ["write", 1, "success"],
      ["review", 2, "success"],
    ]);
    assert.deepEqual(m.sessions.filter((s) => s.parent).map((s) => s.label), ["read#1/007-agent", "write/008-agent"]);
    assert.deepEqual({ agents: m.summary.agents, subAgents: m.summary.subAgents, running: m.summary.running }, { agents: 5, subAgents: 2, running: false });
    const rows = m.agents[2]!.rows;
    assert.ok(rows.some((r) => r.kind === "agent" && r.depth === 1), "the sub-agent's lane");
    assert.ok(rows.some((r) => r.kind === "response" && r.merge), "and where it merges back");
    assert.ok(m.agents.flatMap((a) => a.rows).some((r) => r.kind === "node" && r.verb === "created" && r.node.node_type === "Finding"));
  });

  it("the live replay, read as useRunEvents reads it (`skip`), ends as the whole log; a transcript only once its agent ended", async () => {
    const client = createFixtureClient();
    const log: TraceEvent[] = [];
    let reads = 0;
    let sawRunning = false;
    while (!log.some((e) => e.type === "run.end")) {
      const page = await client.run<TraceEvent[]>("run/events", { workflow: WORKFLOW, runId: TRACE_LIVE_RUN_ID, ...(log.length ? { skip: log.length } : {}) });
      log.push(...page);
      const m = foldAgentTrace(log);
      sawRunning ||= m.summary.running;
      if (reads === 1) {
        const running = m.sessions.find((s) => s.status === "running")!;
        await assert.rejects(client.run("run/transcript", { workflow: WORKFLOW, runId: TRACE_LIVE_RUN_ID, path: running.path }), /No transcript/);
      }
      assert.ok(++reads < 200, "the replay ends");
    }
    assert.equal(sawRunning, true);
    assert.deepEqual(log, TRACE_EVENTS);
    const t = await client.run<{ messages: unknown[] }>("run/transcript", { workflow: WORKFLOW, runId: TRACE_RUN_ID, path: `${WORKFLOW}/read#1/007-agent` });
    assert.ok(t.messages.length > 2, "a sub-agent's transcript, by its path");
    const reasoned = foldAgentTrace(TRACE_EVENTS as TraceEvent[], { [`${WORKFLOW}/plan`]: (await client.run<{ messages: unknown[] }>("run/transcript", { workflow: WORKFLOW, runId: TRACE_RUN_ID, path: `${WORKFLOW}/plan` })).messages });
    assert.ok(reasoned.sessions[0]!.turns.some((x) => x.kind === "reasoning"));
  });

  it("Download HTML: the markup without its buttons, the page's stylesheet and the host's theme, in one file", () => {
    document.documentElement.className = "dark";
    document.documentElement.setAttribute("data-theme", "dark");
    const style = document.createElement("style");
    style.textContent = ".text-foreground{color:white}/* </style> */";
    document.head.appendChild(style);
    const el = document.createElement("div");
    el.innerHTML = '<span title="a &quot;tip&quot;">trace</span><button data-snapshot="omit">Download HTML</button>';
    const html = snapshotHtml(el, 'research · 1 · "agents"');
    assert.match(html, /^<!doctype html>\n<html lang="en" class="dark" data-theme="dark">/);
    assert.match(html, /<title>research · 1 · &quot;agents&quot;<\/title>/);
    assert.match(html, /\.text-foreground\{color:white\}\/\* <\\\/style> \*\//, "a `</style` in the stylesheet cannot close it");
    assert.match(html, /<span title="a &quot;tip&quot;">trace<\/span>/);
    assert.doesNotMatch(html, /Download HTML/);
    assert.equal(el.querySelectorAll("button").length, 1, "the page's own element is left alone");
    assert.equal(fileName("acme/review", "179", "agents"), "acme-review-179-agents");
  });
});
