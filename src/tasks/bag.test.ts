// The task store on the services bags (plans/human-steps.md §9.2): any step
// reaches the shared bag, a custom step the builder wrote included, so it
// carries the `human` step's `ensure` alone. The worker's calls (which take
// any actor) reach only a `worker: true` step's own call on an app door —
// src/tasks/worker-door.test.ts takes and answers tasks there — and the
// staff's only the `/tasks` routes.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createStrut } from "../createStrut.js";
import { defineStep, type StepContext } from "../core.js";
import { MemoryRunStore } from "../store.js";
import { WorkspaceManager } from "../workspace.js";
import { createRegistry } from "../steps/registry.js";
import { memoryTaskStores, createTasks } from "./tasks.js";

/** Every call of the store but the `human` step's. */
const NOT_ON_THE_BAG = ["next", "submit", "skip", "file", "me", "types", "setType", "deleteType", "workers", "setWorker", "grant", "revoke", "list", "task"];

interface Seen {
  keys: string[];
  reachable: string[];
  frozen: boolean;
}
const look = (tasks: unknown, names: string[]): Seen => {
  const t = (tasks ?? {}) as Record<string, unknown>;
  return { keys: Object.keys(t).sort(), reachable: names.filter((n) => typeof t[n] === "function"), frozen: Object.isFrozen(t) };
};

/** What a step finds on `ctx.services.tasks`, kept per call. */
let seen: Array<Seen & { agentTool: boolean }> = [];
const probe = defineStep({
  type: "test/probe",
  description: "Reports what the task store offers this step.",
  input: z.object({}),
  output: z.any(),
  async run(_cfg, ctx?: StepContext) {
    const out = { ...look((ctx!.services as Record<string, unknown>)["tasks"], NOT_ON_THE_BAG), agentTool: !!ctx!.agentTool };
    seen.push(out);
    return out;
  },
});

const sse = (o: unknown) => `event: ${(o as { type: string }).type}\ndata: ${JSON.stringify(o)}\n\n`;
const toolUse = (id: string, name: string, input: unknown) =>
  sse({
    type: "message_start",
    message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
  }) +
  sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } }) +
  sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }) +
  sse({ type: "content_block_stop", index: 0 }) +
  sse({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } }) +
  sse({ type: "message_stop" });

describe("the task store on the services bags (plans/human-steps.md §9.2)", () => {
  let dir: string;
  let provider: http.Server | undefined;
  const ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "AI_SDK_LOG_WARNINGS"];
  let saved: Record<string, string | undefined> = {};
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-tasks-bag-"));
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    seen = [];
  });
  afterEach(async () => {
    provider?.close();
    provider = undefined;
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("a registry step in a workflow, and the same step as an agent's tool, find the human step's ensure alone", async () => {
    // A stand-in model: the agent calls the probe, then answers.
    let n = 0;
    provider = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        n++;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(n === 1 ? toolUse("toolu_1", "test_probe", {}) : toolUse("toolu_2", "final_answer", { answer: "done" }));
      });
    });
    await new Promise<void>((r) => provider!.listen(0, "127.0.0.1", r));
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["AI_SDK_LOG_WARNINGS"] = "false";

    const strut = await createStrut({
      workspace: new WorkspaceManager(join(dir, "ws")),
      store: new MemoryRunStore(),
      registry: await createRegistry([probe]),
      serveUi: false,
      enableChat: false,
      scheduler: false,
      autoResume: false,
    });
    try {
      await strut.workspace.publishWorkflow("look", "v1", {
        steps: [
          { id: "step", type: "test/probe", config: {} },
          {
            id: "work",
            type: "agent",
            config: { cwd: dir, system: "sys", prompt: "look", model: "claude-sonnet-4-5", toolFilter: ["none"], finalAnswer: "Report.", agentTools: ["test/probe"] },
          },
        ],
      });
      const result = await strut.run("look", {});
      assert.equal(result.status, "success", JSON.stringify(result.error));
      assert.deepEqual(
        seen.map((s) => s.agentTool),
        [false, true],
        "the step, then the agent's tool call",
      );
      for (const s of seen) {
        assert.deepEqual(s.keys, ["ensure"], "the human step's call alone");
        assert.deepEqual(s.reachable, [], "no worker's call and no staff's");
        assert.equal(s.frozen, true);
      }
      // The store itself is whole: the staff routes hold it.
      assert.deepEqual(look(strut.tasks.capability, NOT_ON_THE_BAG).reachable, NOT_ON_THE_BAG);
    } finally {
      await strut.close();
    }
  });

  it("a custom step in a workflow finds the same", async () => {
    const ws = new WorkspaceManager(join(dir, "ws"));
    await ws.publishStep(
      "test/custom-probe",
      `import { z, defineStep } from "strut";
const NAMES = ${JSON.stringify(NOT_ON_THE_BAG)};
export default defineStep({
  type: "test/custom-probe",
  input: z.object({}),
  output: z.any(),
  async run(_cfg, ctx) {
    const t = ctx.services.tasks ?? {};
    return { keys: Object.keys(t).sort(), reachable: NAMES.filter((n) => typeof t[n] === "function") };
  },
});`,
    );
    await ws.publishWorkflow("custom", "v1", { steps: [{ id: "look", type: "test/custom-probe", config: {} }] });
    const strut = await createStrut({ workspace: ws, store: new MemoryRunStore(), serveUi: false, enableChat: false, scheduler: false, autoResume: false, stt: false });
    try {
      const result = await strut.run("custom", {});
      assert.equal(result.status, "success", JSON.stringify(result.error));
      assert.deepEqual(result.output, { keys: ["ensure"], reachable: [] });
    } finally {
      await strut.close();
    }
  });

  it("a host's own services.tasks is kept as it is, and the staff routes read it", async () => {
    const host = createTasks({ open: async () => memoryTaskStores() });
    await host.capability.setType("host-type", { app: "workers", answer: { type: "boolean" } });
    const strut = await createStrut({
      workspace: new WorkspaceManager(join(dir, "ws")),
      store: new MemoryRunStore(),
      registry: await createRegistry([probe]),
      services: { tasks: host.capability },
      serveUi: false,
      enableChat: false,
      scheduler: false,
      autoResume: false,
    });
    try {
      assert.equal((strut.services as Record<string, unknown>)["tasks"], host.capability);
      await strut.workspace.publishWorkflow("look", "v1", { steps: [{ id: "step", type: "test/probe", config: {} }] });
      assert.equal((await strut.run("look", {})).status, "success");
      assert.deepEqual(seen[0]!.reachable, NOT_ON_THE_BAG, "the host's whole capability, as it brought it");
      const types = (await (await strut.app.request("/tasks/types")).json()) as { types: Array<{ name: string }> };
      assert.deepEqual(
        types.types.map((t) => t.name),
        ["host-type"],
      );
    } finally {
      await strut.close();
      await host.close();
    }
  });
});
