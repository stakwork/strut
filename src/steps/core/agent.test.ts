import { describe, it, beforeEach, afterEach } from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { coreRegistry } from "../registry.js";
import { CancelledError, RunController, isCancelledError } from "../../run-control.js";
import { runWorkflow } from "../../runner.js";
import { MemoryRunStore } from "../../store.js";
import { withAccessedNodes, withMessages, withMedia, messagesOf, accessedNodesOf, mediaOf, defineStep, flow, step, type StepContext, type StepRegistry } from "../../core.js";
import agent, {
  repoTree,
  textEdit,
  buildRegistryTools,
  expandAgentTools,
  wrapToolsWithEmit,
  buildSession,
  maskSecretValues,
  maskDeep,
  registryToolModelOutput,
  wrapToolsWithMask,
  classifyFinalAnswerStop,
  degenerateSchemaFields,
  finalAnswerOf,
  missingRequired,
  identicalTailCalls,
  NOOP_LOOP_STREAK,
  isTransientStreamError,
  streamFailure,
  streamError,
  AgentStreamError,
  buildPreamble,
} from "./agent.js";

// These tests are OFFLINE: they exercise registration, the input schema, and the
// config-validation guards in run() that fire BEFORE any model call. The actual
// generation loop needs a provider key + network and is covered by lab smokes.

describe("core agent step", () => {
  it("is registered in the core registry", () => {
    const reg = coreRegistry();
    assert.ok(reg["agent"], "agent should be a core step");
    assert.equal(reg["agent"]!.type, "agent");
  });

  it("applies input defaults (maxSteps, toolFilter)", () => {
    const cfg = (agent.input as any).parse({
      cwd: "/tmp/x",
      system: "you are a tester",
      prompt: "do the thing",
    });
    assert.equal(cfg.maxSteps, 200);
    assert.deepEqual(cfg.toolFilter, []);
  });

  it("rejects setting BOTH schema and finalAnswer", async () => {
    const cfg = (agent.input as any).parse({
      cwd: "/tmp/x",
      system: "s",
      prompt: "p",
      finalAnswer: "return the answer",
      schema: { type: "object", properties: {} },
    });
    await assert.rejects(() => (agent.run as any)(cfg, {}), /EITHER `schema`.*OR `finalAnswer`/);
  });

  it("rejects an unknown provider", async () => {
    const cfg = (agent.input as any).parse({
      cwd: "/tmp/x",
      system: "s",
      prompt: "p",
      provider: "not-a-provider",
    });
    await assert.rejects(() => (agent.run as any)(cfg, {}), /Unknown LLM provider/);
  });
});

describe("agentTools (buildRegistryTools — tools are steps)", () => {
  // A fake `tool()` factory: identity, so we can inspect the produced tool def
  // (description/inputSchema/execute) without importing the AI SDK.
  const fakeTool = (def: any) => def;

  const echoStep = defineStep({
    type: "demo/echo",
    description: "Echo the message back.",
    input: z.object({ msg: z.string() }),
    output: z.string(),
    async run(cfg) {
      return `got:${cfg.msg}`;
    },
  });
  const registry = { "demo/echo": echoStep } as StepRegistry;

  it("builds a tool per registry step, sanitizing the slash in the tool name", () => {
    const tools = buildRegistryTools(["demo/echo"], registry, undefined, fakeTool);
    assert.ok(tools["demo_echo"], "slash sanitized to underscore");
    assert.equal((tools["demo_echo"] as any).description, "Echo the message back.");
    assert.equal((tools["demo_echo"] as any).inputSchema, echoStep.input);
  });

  it("skips unknown step types (no throw)", () => {
    const tools = buildRegistryTools(["nope/missing", "demo/echo"], registry, undefined, fakeTool);
    assert.deepEqual(Object.keys(tools), ["demo_echo"]);
  });

  it("returns {} with no names or no registry", () => {
    assert.deepEqual(buildRegistryTools([], registry, undefined, fakeTool), {});
    assert.deepEqual(buildRegistryTools(["demo/echo"], undefined, undefined, fakeTool), {});
  });

  it("executes the step and returns its output (no emit here)", async () => {
    const ctx = {
      runId: "r1", path: "wf/diagnose", scope: {}, input: undefined,
      emit: async () => {}, services: undefined, registry,
    } as unknown as StepContext;
    const tools = buildRegistryTools(["demo/echo"], registry, ctx, fakeTool);
    const out = await (tools["demo_echo"] as any).execute({ msg: "hi" });
    assert.equal(out, "got:hi");
  });

  it("returns an Error string (not throw) on invalid tool input", async () => {
    const tools = buildRegistryTools(["demo/echo"], registry, undefined, fakeTool);
    const out = await (tools["demo_echo"] as any).execute({ wrong: 1 });
    assert.match(String(out), /Error: invalid input for "demo\/echo"/);
  });

  describe("media (withMedia → toModelOutput)", () => {
    const shotStep = defineStep({
      type: "demo/shot",
      description: "Take a screenshot.",
      input: z.object({}),
      output: z.any(),
      async run() {
        return withMedia({ path: "shots/1.png" }, [{ mediaType: "image/png", data: "iVBORw0KGgo=" }]);
      },
    });
    const reg = { "demo/shot": shotStep, "demo/echo": echoStep } as StepRegistry;

    it("hands the model the JSON as text plus one file part per media entry; the result itself stays plain", async () => {
      const tools = buildRegistryTools(["demo/shot"], reg, undefined, fakeTool);
      const t = tools["demo_shot"] as any;
      assert.equal(typeof t.toModelOutput, "function");
      const out = await t.execute({});
      assert.deepEqual(out, { path: "shots/1.png" });
      assert.equal(JSON.stringify(out), '{"path":"shots/1.png"}'); // what events / templates see
      assert.deepEqual(t.toModelOutput({ toolCallId: "c1", input: {}, output: out }), {
        type: "content",
        value: [
          { type: "text", text: '{"path":"shots/1.png"}' },
          { type: "file", data: { type: "data", data: "iVBORw0KGgo=" }, mediaType: "image/png" },
        ],
      });
    });

    it("carries a filename and sends bytes as base64", () => {
      const out = withMedia({ ok: true }, [{ mediaType: "image/png", data: new Uint8Array([1, 2, 3]), filename: "a.png" }]);
      const model = registryToolModelOutput(out) as any;
      assert.equal(model.type, "content");
      assert.deepEqual(model.value[1], { type: "file", data: { type: "data", data: "AQID" }, mediaType: "image/png", filename: "a.png" });
    });

    it("unmarked outputs get the SDK default — text for a string, json otherwise — so existing tools are unchanged", () => {
      const tools = buildRegistryTools(["demo/echo"], reg, undefined, fakeTool);
      const t = tools["demo_echo"] as any;
      assert.deepEqual(t.toModelOutput({ toolCallId: "c1", input: { msg: "hi" }, output: "got:hi" }), { type: "text", value: "got:hi" });
      assert.deepEqual(registryToolModelOutput({ a: 1, u: undefined }), { type: "json", value: { a: 1 } });
      assert.deepEqual(registryToolModelOutput([1, "x"]), { type: "json", value: [1, "x"] });
      assert.deepEqual(registryToolModelOutput(undefined), { type: "json", value: null });
    });
  });

  describe("glob expansion (expandAgentTools)", () => {
    const shoutStep = defineStep({
      type: "demo/shout",
      input: z.object({ msg: z.string() }),
      output: z.string(),
      async run(cfg) {
        return cfg.msg.toUpperCase();
      },
    });
    const otherStep = defineStep({
      type: "other/thing",
      input: z.object({}),
      output: z.any(),
      async run() {
        return null;
      },
    });
    const globReg = {
      "demo/echo": echoStep,
      "demo/shout": shoutStep,
      "other/thing": otherStep,
    } as StepRegistry;

    it("expands a namespace glob to every matching step type, sorted", () => {
      assert.deepEqual(expandAgentTools(["demo/*"], globReg), ["demo/echo", "demo/shout"]);
    });

    it("mixes globs and plain names, deduping (first occurrence wins)", () => {
      assert.deepEqual(
        expandAgentTools(["demo/echo", "demo/*", "other/thing"], globReg),
        ["demo/echo", "demo/shout", "other/thing"],
      );
    });

    it("a glob matching nothing expands to nothing (no throw)", () => {
      assert.deepEqual(expandAgentTools(["nope/*"], globReg), []);
    });

    it("does not treat regex metacharacters in the pattern as regex", () => {
      // "demo/e.ho" must NOT match "demo/echo" — dots are literal.
      assert.deepEqual(
        expandAgentTools(["demo/e.ho"], globReg),
        ["demo/e.ho"], // passes through as a plain (unknown) name
      );
    });

    it("buildRegistryTools consumes globs end-to-end", () => {
      const tools = buildRegistryTools(["demo/*"], globReg, undefined, fakeTool);
      assert.deepEqual(Object.keys(tools).sort(), ["demo_echo", "demo_shout"]);
    });
  });

  it("exposes the agent step itself as a tool (sub-agent recursion seam)", () => {
    const reg = coreRegistry();
    const tools = buildRegistryTools(["agent"], reg, undefined, fakeTool);
    assert.ok(tools["agent"], "the core agent step is grantable as an agentTool");
    assert.equal((tools["agent"] as any).inputSchema, reg["agent"]!.input);
  });

  it("nests a registry step's own emits under the tool-call span (child ctx path)", async () => {
    // A step that emits an event itself — stands in for a nested agent whose
    // own tool calls emit at `${ctx.path}/NNN-<tool>`.
    const emittingStep = defineStep({
      type: "demo/emitter",
      input: z.object({}),
      output: z.any(),
      async run(_cfg, sctx) {
        await (sctx.emit as any)({ type: "step.start", path: `${sctx.path}/001-inner`, stepType: "tool:inner" });
        return "ok";
      },
    });
    const reg = { "demo/emitter": emittingStep } as StepRegistry;
    const events: any[] = [];
    const ctx = {
      runId: "r1", path: "wf/parent-agent", scope: {}, input: undefined,
      emit: async (e: any) => { events.push(e); }, services: undefined, registry: reg,
    } as unknown as StepContext;

    const tools = buildRegistryTools(["demo/emitter"], reg, ctx, (d: any) => d);
    wrapToolsWithEmit(tools, ctx);
    await (tools["demo_emitter"] as any).execute({}, {});

    const paths = events.map((e) => e.path);
    // outer span from wrapToolsWithEmit…
    assert.ok(paths.includes("wf/parent-agent/001-demo_emitter"), `outer span missing: ${paths}`);
    // …and the step's own emit nests UNDER it (not as a flat sibling).
    assert.ok(
      paths.includes("wf/parent-agent/001-demo_emitter/001-inner"),
      `inner emit not nested: ${paths}`,
    );
  });

  it("registry tool keeps the parent ctx path when called without wrap options", async () => {
    const events: any[] = [];
    const probeStep = defineStep({
      type: "demo/probe",
      input: z.object({}),
      output: z.any(),
      async run(_cfg, sctx) {
        return sctx.path;
      },
    });
    const reg = { "demo/probe": probeStep } as StepRegistry;
    const ctx = {
      runId: "r1", path: "wf/agent", scope: {}, input: undefined,
      emit: async (e: any) => { events.push(e); }, services: undefined, registry: reg,
    } as unknown as StepContext;
    const tools = buildRegistryTools(["demo/probe"], reg, ctx, (d: any) => d);
    // Unwrapped (no wrapToolsWithEmit): no strutToolPath → parent path unchanged.
    assert.equal(await (tools["demo_probe"] as any).execute({}), "wf/agent");
  });
});

describe("wrapToolsWithEmit (per-call nested run events)", () => {
  function makeCtx(events: any[]): StepContext {
    return {
      runId: "r1", path: "wf/agent", scope: {}, input: undefined,
      emit: async (e: any) => { events.push(e); }, services: undefined,
    } as unknown as StepContext;
  }

  it("emits step.start/step.end around every tool, with a shared ordered counter", async () => {
    const events: any[] = [];
    const tools: Record<string, any> = {
      bash: { execute: async (i: any) => `ran:${i.command}` },
      assess: { execute: async () => ({ working: true }) },
    };
    wrapToolsWithEmit(tools, makeCtx(events));

    const a = await tools.bash.execute({ command: "ls" });
    const b = await tools.assess.execute({});
    assert.equal(a, "ran:ls");
    assert.deepEqual(b, { working: true }); // model still gets the REAL output

    assert.deepEqual(events.map((e) => [e.type, e.path, e.stepType]), [
      ["step.start", "wf/agent/001-bash", "tool:bash"],
      ["step.end", "wf/agent/001-bash", "tool:bash"],
      ["step.start", "wf/agent/002-assess", "tool:assess"],
      ["step.end", "wf/agent/002-assess", "tool:assess"],
    ]);
    assert.deepEqual(events[0].input, { command: "ls" });
    assert.equal(events[1].output, "ran:ls"); // event output is the summarized string
  });

  it("skips final_answer and provider-executed tools (no execute)", async () => {
    const events: any[] = [];
    const tools: Record<string, any> = {
      final_answer: { execute: async (i: any) => i.answer },
      web_search: { type: "provider-defined" }, // no execute
    };
    wrapToolsWithEmit(tools, makeCtx(events));
    await tools.final_answer.execute({ answer: "done" });
    assert.equal(events.length, 0);
  });

  it("emits step.error and rethrows when a tool throws", async () => {
    const events: any[] = [];
    const tools: Record<string, any> = { boom: { execute: async () => { throw new Error("nope"); } } };
    wrapToolsWithEmit(tools, makeCtx(events));
    await assert.rejects(() => tools.boom.execute({}), /nope/);
    assert.equal(events[0].type, "step.start");
    assert.equal(events[1].type, "step.error");
    assert.equal(events[1].error.message, "nope");
  });

  it("is a no-op without a runner ctx (in-code/test)", async () => {
    const tools: Record<string, any> = { bash: { execute: async () => "ok" } };
    const orig = tools.bash.execute;
    wrapToolsWithEmit(tools, undefined);
    assert.equal(tools.bash.execute, orig, "execute is left untouched");
  });

  it("lifts the provenance marker onto step.end as `nodes`, untruncated, without touching the tool result", async () => {
    const events: any[] = [];
    const big = "x".repeat(5000);
    const refs = Array.from({ length: 40 }, (_, i) => ({ ref_id: `ref-${i}`, node_type: "Concept" }));
    const tools: Record<string, any> = {
      search: { execute: async () => withAccessedNodes([{ ref_id: "ref-0", text: big }], refs) },
      plain: { execute: async () => ({ ok: true }) },
    };
    wrapToolsWithEmit(tools, makeCtx(events));

    const out = await tools.search.execute({});
    assert.deepEqual(accessedNodesOf(out), refs, "the model-facing result keeps the marker (invisible to JSON)");
    assert.equal(JSON.stringify(out), JSON.stringify([{ ref_id: "ref-0", text: big }]));
    const end = events.find((e) => e.type === "step.end" && e.path.endsWith("-search"));
    assert.deepEqual(end.nodes, refs, "all 40 refs survive even though output was truncated");
    assert.ok(end.output.length < big.length, "output itself is still summarized");

    await tools.plain.execute({});
    const plainEnd = events.find((e) => e.type === "step.end" && e.path.endsWith("-plain"));
    assert.ok(!("nodes" in plainEnd), "unmarked results emit no nodes field");
  });

  it("lifts a sub-agent's session onto step.end as `messages`, leaving the model-facing result slim", async () => {
    const events: any[] = [];
    const session = [
      { role: "system", content: "s" },
      { role: "user", content: "p" },
      { role: "assistant", content: "x".repeat(4000) },
    ];
    const tools: Record<string, any> = {
      agent: { execute: async () => withMessages({ result: "done", steps: 3 }, session) },
    };
    wrapToolsWithEmit(tools, makeCtx(events));
    const out = await tools.agent.execute({});
    assert.equal(JSON.stringify(out), '{"result":"done","steps":3}', "the parent model sees no transcript");
    const end = events.find((e) => e.type === "step.end" && e.path.endsWith("-agent"));
    assert.deepEqual(end.messages, session, "the whole session is on the event, untruncated");
  });
});

describe("maskDeep keeps the provenance marker", () => {
  it("carries `_nodes` across the rebuilt object/array", () => {
    const refs = [{ ref_id: "r1" }];
    const obj = maskDeep(withAccessedNodes({ key: "sk-123", nested: ["sk-123"] }, refs), ["sk-123"]) as any;
    assert.deepEqual(obj, { key: "[MASKED_SECRET]", nested: ["[MASKED_SECRET]"] });
    assert.deepEqual(accessedNodesOf(obj), refs);
    const arr = maskDeep(withAccessedNodes(["sk-123"], refs), ["sk-123"]) as any;
    assert.deepEqual(arr, ["[MASKED_SECRET]"]);
    assert.deepEqual(accessedNodesOf(arr), refs);
  });

  it("carries `_messages` too, masked", () => {
    const session = [{ role: "assistant", content: "the key is sk-123" }];
    const obj = maskDeep(withMessages({ result: "sk-123" }, session), ["sk-123"]) as any;
    assert.deepEqual(obj, { result: "[MASKED_SECRET]" });
    assert.deepEqual(messagesOf(obj), [{ role: "assistant", content: "the key is [MASKED_SECRET]" }]);
  });

  it("carries `_media` too, untouched (image bytes, not strings)", () => {
    const media = [{ mediaType: "image/png", data: "iVBORw0KGgo=" }];
    const obj = maskDeep(withMedia({ path: "sk-123" }, media), ["sk-123"]) as any;
    assert.deepEqual(obj, { path: "[MASKED_SECRET]" });
    assert.equal(mediaOf(obj), media);
  });
});

describe("buildSession", () => {
  it("prepends the system + task prompts to the generated turns", () => {
    const turns = [{ role: "assistant", content: "hi" }];
    assert.deepEqual(buildSession("be brief", "do it", turns), [
      { role: "system", content: "be brief" },
      { role: "user", content: "do it" },
      { role: "assistant", content: "hi" },
    ]);
  });
});

describe("repo_overview adaptive tree (repoTree)", () => {
  it("always shows every root entry and collapses noise dirs", () => {
    const files = [
      "package.json",
      "src/index.ts",
      "src/lib/a.ts",
      "prisma/migrations/0001_init/migration.sql",
      "prisma/migrations/0002_next/migration.sql",
      "node_modules/foo/index.js",
      "dist/bundle.js",
    ];
    const { text } = repoTree(files, { maxLines: 1000, maxDepth: 8 });
    // root entries present
    assert.ok(text.includes("package.json"), "root file shown");
    assert.ok(text.includes("src/"), "root dir shown");
    // noise dirs are shown but NOT expanded
    assert.ok(text.includes("migrations/"), "migrations dir shown");
    assert.ok(!text.includes("migration.sql"), "migration files collapsed away");
    assert.ok(text.includes("node_modules/") && !text.includes("foo"), "node_modules collapsed");
    assert.ok(text.includes("dist/") && !text.includes("bundle.js"), "dist collapsed");
  });

  it("deepens while under the line budget and steps back when it busts", () => {
    // 50 top-level dirs, each with a nested file: depth 1 = 50 lines, depth 2 = 100.
    const files: string[] = [];
    for (let i = 0; i < 50; i++) files.push(`dir${i}/sub/file${i}.ts`);

    const tight = repoTree(files, { maxLines: 60, maxDepth: 8 });
    assert.equal(tight.depth, 1, "depth-2 (100 lines) busts a 60-line budget → stay at depth 1");

    const roomy = repoTree(files, { maxLines: 1000, maxDepth: 8 });
    assert.ok(roomy.depth >= 2, "with room, it deepens past the root");
  });

  it("respects the hard depth cap", () => {
    const files = ["a/b/c/d/e/f/g/h/i/j/deep.ts"];
    const { depth } = repoTree(files, { maxLines: 10000, maxDepth: 3 });
    assert.equal(depth, 3, "never deeper than maxDepth even with budget to spare");
  });
});

describe("buildPreamble (the working dir, stated in the prompt)", () => {
  it("lists a non-empty dir, dirs with a slash, dotfiles hidden", () => {
    const cwd = mkdtempSync(join(tmpdir(), "strut-preamble-"));
    try {
      writeFileSync(join(cwd, "b.txt"), "");
      writeFileSync(join(cwd, ".hidden"), "");
      mkdirSync(join(cwd, "a"));
      assert.equal(buildPreamble(cwd), `Working directory (${cwd}) contains:\n- a/\n- b.txt`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("still states the absolute path of an EMPTY dir", () => {
    const cwd = mkdtempSync(join(tmpdir(), "strut-preamble-"));
    try {
      assert.equal(buildPreamble(cwd), `Working directory (${cwd}) is empty.`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("says nothing about a dir that does not exist", () => {
    assert.equal(buildPreamble(join(tmpdir(), "strut-preamble-missing-xyz")), "");
  });
});

describe("textEdit (str_replace_based_edit_tool handler)", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "strut-textedit-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("refuses a binary file instead of dumping it as text", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
    writeFileSync(join(cwd, "shot.png"), png);
    for (const input of [
      { command: "view" as const, path: "shot.png" },
      { command: "str_replace" as const, path: "shot.png", old_str: "PNG", new_str: "x" },
      { command: "insert" as const, path: "shot.png", insert_line: 0, insert_text: "x" },
    ]) {
      assert.equal(textEdit(input, cwd), "Error: binary file (12 bytes) — this tool reads text only");
    }
    assert.deepEqual(readFileSync(join(cwd, "shot.png")), png, "the file is untouched");
  });

  it("views a file with 1-indexed line numbers", () => {
    writeFileSync(join(cwd, "a.txt"), "one\ntwo\nthree");
    const out = textEdit({ command: "view", path: "a.txt" }, cwd);
    assert.equal(out, "1: one\n2: two\n3: three");
  });

  it("views a line range", () => {
    writeFileSync(join(cwd, "a.txt"), "one\ntwo\nthree\nfour");
    assert.equal(textEdit({ command: "view", path: "a.txt", view_range: [2, 3] }, cwd), "2: two\n3: three");
    assert.equal(textEdit({ command: "view", path: "a.txt", view_range: [3, -1] }, cwd), "3: three\n4: four");
  });

  it("lists a directory on view", () => {
    writeFileSync(join(cwd, "z.txt"), "");
    writeFileSync(join(cwd, "a.txt"), "");
    const out = textEdit({ command: "view", path: "." }, cwd);
    assert.equal(out, "a.txt\nz.txt");
  });

  it("creates a new file (including nested dirs)", () => {
    const out = textEdit({ command: "create", path: "sub/dir/new.txt", file_text: "hi" }, cwd);
    assert.match(out, /Successfully created/);
    assert.equal(readFileSync(join(cwd, "sub/dir/new.txt"), "utf-8"), "hi");
  });

  it("str_replace replaces exactly one match", () => {
    writeFileSync(join(cwd, "a.txt"), "foo bar baz");
    const out = textEdit({ command: "str_replace", path: "a.txt", old_str: "bar", new_str: "QUX" }, cwd);
    assert.match(out, /Successfully replaced/);
    assert.equal(readFileSync(join(cwd, "a.txt"), "utf-8"), "foo QUX baz");
  });

  it("str_replace refuses zero matches", () => {
    writeFileSync(join(cwd, "a.txt"), "foo");
    const out = textEdit({ command: "str_replace", path: "a.txt", old_str: "nope", new_str: "x" }, cwd);
    assert.match(out, /No match found/);
    assert.equal(readFileSync(join(cwd, "a.txt"), "utf-8"), "foo");
  });

  it("str_replace refuses multiple matches", () => {
    writeFileSync(join(cwd, "a.txt"), "x x x");
    const out = textEdit({ command: "str_replace", path: "a.txt", old_str: "x", new_str: "y" }, cwd);
    assert.match(out, /Found 3 matches/);
    assert.equal(readFileSync(join(cwd, "a.txt"), "utf-8"), "x x x");
  });

  it("inserts text after a line (0 = top of file)", () => {
    writeFileSync(join(cwd, "a.txt"), "one\ntwo");
    textEdit({ command: "insert", path: "a.txt", insert_line: 0, insert_text: "ZERO" }, cwd);
    assert.equal(readFileSync(join(cwd, "a.txt"), "utf-8"), "ZERO\none\ntwo");
  });

  it("refuses paths that escape the working dir", () => {
    writeFileSync(join(cwd, "a.txt"), "secret");
    const out = textEdit({ command: "view", path: "../../../etc/passwd" }, cwd);
    assert.match(out, /escapes the working directory/);
  });

  it("returns File not found for missing files", () => {
    assert.match(textEdit({ command: "view", path: "nope.txt" }, cwd), /File not found/);
    assert.ok(!existsSync(join(cwd, "nope.txt")));
  });

  it("accepts relative path under repo root (unchanged behaviour)", () => {
    writeFileSync(join(cwd, "rel.txt"), "hello");
    const out = textEdit({ command: "view", path: "rel.txt" }, [cwd, tmpdir()]);
    assert.equal(out, "1: hello");
  });

  it("accepts absolute path under the repo root", () => {
    const abs = join(cwd, "abs.txt");
    writeFileSync(abs, "world");
    const out = textEdit({ command: "view", path: abs }, [cwd, tmpdir()]);
    assert.equal(out, "1: world");
  });

  it("accepts absolute path under os.tmpdir() — create then str_replace round-trip", () => {
    const scratchPath = join(tmpdir(), `strut-scratch-${Date.now()}.py`);
    try {
      // Create the scratch file
      const createOut = textEdit(
        { command: "create", path: scratchPath, file_text: "x = 1\n" },
        [cwd, tmpdir()]
      );
      assert.match(createOut, /Successfully created/);
      // Edit it (the original bug: this used to fail with "escapes the working directory")
      const replaceOut = textEdit(
        { command: "str_replace", path: scratchPath, old_str: "x = 1", new_str: "x = 42" },
        [cwd, tmpdir()]
      );
      assert.match(replaceOut, /Successfully replaced/);
      assert.equal(readFileSync(scratchPath, "utf-8"), "x = 42\n");
    } finally {
      rmSync(scratchPath, { force: true });
    }
  });

  it("refuses absolute path outside all roots (e.g. /etc/passwd)", () => {
    const out = textEdit({ command: "view", path: "/etc/passwd" }, [cwd, tmpdir()]);
    assert.match(out, /escapes the working directory/);
  });
});

describe("secretsEnv masking", () => {
  const VALUES = ["tok-abc123def", "sk-other-secret-9"];

  it("maskSecretValues replaces every occurrence of every value", () => {
    const out = maskSecretValues("a tok-abc123def b tok-abc123def c sk-other-secret-9", VALUES);
    assert.equal(out, "a [MASKED_SECRET] b [MASKED_SECRET] c [MASKED_SECRET]");
  });

  it("maskDeep masks string leaves in nested objects/arrays, preserves shape", () => {
    const out = maskDeep(
      { a: "x tok-abc123def", n: 7, ok: true, none: null, arr: ["sk-other-secret-9", { b: "clean" }] },
      VALUES,
    ) as any;
    assert.deepEqual(out, {
      a: "x [MASKED_SECRET]",
      n: 7,
      ok: true,
      none: null,
      arr: ["[MASKED_SECRET]", { b: "clean" }],
    });
  });

  it("maskDeep with no values is identity", () => {
    const v = { a: "tok-abc123def" };
    assert.equal(maskDeep(v, []), v);
  });

  it("wrapToolsWithMask masks tool results (the echo-$KEY path)", async () => {
    const tools: Record<string, any> = {
      bash: {
        execute: async ({ command }: { command: string }) =>
          command === "echo $KEY" ? "tok-abc123def\n" : "ok",
      },
      // provider-executed tool (no execute) must be skipped, not crash
      web_search: {},
    };
    wrapToolsWithMask(tools, VALUES);
    assert.equal(await tools.bash.execute({ command: "echo $KEY" }), "[MASKED_SECRET]\n");
    assert.equal(await tools.bash.execute({ command: "other" }), "ok");
  });

  it("run() fails loudly when secretsEnv is set but no secrets capability exists", async () => {
    const cfg = (agent.input as any).parse({
      cwd: tmpdir(),
      system: "s",
      prompt: "p",
      secretsEnv: ["SOME_KEY"],
    });
    await assert.rejects(
      () => agent.run(cfg, { runId: "r", path: "p", scope: {}, input: undefined, emit: async () => {}, services: {}, registry: {} } as any),
      /secretsEnv requires the secrets capability/,
    );
  });

  it("secretsEnv defaults to []", () => {
    const cfg = (agent.input as any).parse({ cwd: "/tmp/x", system: "s", prompt: "p" });
    assert.deepEqual(cfg.secretsEnv, []);
  });
});

describe("classifyFinalAnswerStop (premature text-only stop vs exhausted budget)", () => {
  it("done when final_answer was called, regardless of budget", () => {
    assert.equal(classifyFinalAnswerStop(true, 3, 40), "done");
    assert.equal(classifyFinalAnswerStop(true, 40, 40), "done");
  });

  it("nudge when the loop stopped tool-lessly with budget remaining", () => {
    // The live incident: a mid-task narration ended a 32-step session with an
    // 80-step budget — the loop must be resumed, not force-answered.
    assert.equal(classifyFinalAnswerStop(false, 32, 80), "nudge");
    // A single pure-text first turn is also premature.
    assert.equal(classifyFinalAnswerStop(false, 1, 40), "nudge");
  });

  it("exhausted at (or beyond) the step cap — only a no-tools forced turn is left", () => {
    assert.equal(classifyFinalAnswerStop(false, 40, 40), "exhausted");
    assert.equal(classifyFinalAnswerStop(false, 41, 40), "exhausted");
  });
});

describe("degenerateSchemaFields (schema-mode premature stop)", () => {
  const schema = {
    type: "object",
    properties: {
      candidate: { type: "string" },
      version: { type: "string" },
      summary: { type: "string" },
      changes: { type: "array", items: { type: "string" } },
      score: { type: "number" },
    },
    required: ["candidate", "version", "summary", "changes"],
  };

  it("flags required strings that are empty, whitespace, or filler", () => {
    // The live incident: 3 of 8 authoring generations ended on a bare text
    // turn like this at a handful of steps into a 200-step budget.
    assert.deepEqual(
      degenerateSchemaFields(schema, { candidate: "gaia-produce-ai", version: "", summary: "  " }),
      ["version", "summary"],
    );
    assert.deepEqual(
      degenerateSchemaFields(schema, { candidate: "x", version: "v3", summary: "placeholder" }),
      ["summary"],
    );
    assert.deepEqual(degenerateSchemaFields(schema, { candidate: "x", version: "TBD.", summary: "n/a" }), [
      "version",
      "summary",
    ]);
  });

  it("returns nothing for a usable object", () => {
    assert.deepEqual(
      degenerateSchemaFields(schema, { candidate: "gaia-produce-ai", version: "v6", summary: "split research and format" }),
      [],
    );
  });

  it("only judges required STRING properties — arrays, numbers, optionals are not its business", () => {
    // `changes` is required but an array; `score` is a number; a missing
    // optional string is fine. None of those may trigger a nudge.
    assert.deepEqual(degenerateSchemaFields(schema, { candidate: "x", version: "v1", summary: "real", changes: [] }), []);
    const optionalOnly = { type: "object", properties: { note: { type: "string" } } };
    assert.deepEqual(degenerateSchemaFields(optionalOnly, { note: "" }), []);
  });

  it("treats a missing object as every required string missing, and a malformed schema as nothing to check", () => {
    assert.deepEqual(degenerateSchemaFields(schema, undefined), ["candidate", "version", "summary"]);
    assert.deepEqual(degenerateSchemaFields(undefined, { summary: "" }), []);
    assert.deepEqual(degenerateSchemaFields({ required: "summary" }, { summary: "" }), []);
  });
});

describe("the terminal tool's helpers", () => {
  const call = (toolName: string, input: unknown, id = "t1") => ({ type: "tool-call", toolCallId: id, toolName, input });
  const result = (toolName: string, output: unknown, id = "t1") => ({ type: "tool-result", toolCallId: id, toolName, output });

  it("finalAnswerOf: the newest EXECUTED final_answer's output, whatever its shape", () => {
    const steps = [
      { content: [call("bash", { command: "ls" }), result("bash", "a\n")] },
      { content: [call("final_answer", { answer: "first" }), result("final_answer", "first")] },
      { content: [call("final_answer", { candidate: "x" }), result("final_answer", { candidate: "x" })] },
    ];
    assert.deepEqual(finalAnswerOf(steps), { candidate: "x" });
    assert.equal(finalAnswerOf(steps.slice(0, 2)), "first");
    assert.equal(finalAnswerOf(steps.slice(0, 1)), undefined);
    assert.equal(finalAnswerOf([]), undefined);
  });

  it("finalAnswerOf: a call the tool refused is a tool-error, not an answer", () => {
    const steps = [{ content: [call("final_answer", { candidate: "x" }), { type: "tool-error", toolCallId: "t1", toolName: "final_answer", error: new Error("refused") }] }];
    assert.equal(finalAnswerOf(steps), undefined);
  });

  it("missingRequired: the top-level required keys the object leaves out, nothing else", () => {
    const schema = { type: "object", required: ["text", "artifacts"], properties: { text: { type: "string" }, artifacts: { type: "array" }, ask: { type: "object" } } };
    assert.deepEqual(missingRequired(schema, { text: "hi" }), ["artifacts"]);
    assert.deepEqual(missingRequired(schema, { text: "", artifacts: [] }), [], "present but empty is for degenerateSchemaFields to judge");
    assert.deepEqual(missingRequired(schema, undefined), ["text", "artifacts"]);
    assert.deepEqual(missingRequired({ type: "object" }, {}), [], "no required list, nothing to miss");
    assert.deepEqual(missingRequired(undefined, {}), []);
  });

  it("identicalTailCalls: counts trailing steps that are ONE identical call with an identical result", () => {
    const noop = (id: string) => ({ content: [call("bash", { command: "true" }, id), result("bash", "", id)] });
    assert.equal(identicalTailCalls([noop("a"), noop("b"), noop("c")]), 3);
    // Real work before the streak does not count; the streak is the tail.
    assert.equal(identicalTailCalls([{ content: [call("bash", { command: "ls" }), result("bash", "x")] }, noop("a"), noop("b")]), 2);
    // A different call in the tail resets it.
    assert.equal(identicalTailCalls([noop("a"), noop("b"), { content: [call("bash", { command: "ls" }), result("bash", "x")] }]), 1);
    assert.equal(identicalTailCalls([]), 0);
  });

  it("identicalTailCalls: a poll whose result changes is not a no-op loop, nor are parallel calls or text turns", () => {
    const poll = (id: string, out: string) => ({ content: [call("bash", { command: "gh run view" }, id), result("bash", out, id)] });
    assert.equal(identicalTailCalls([poll("a", "queued"), poll("b", "running"), poll("c", "done")]), 1);
    const two = { content: [call("bash", { command: "true" }, "a"), result("bash", "", "a"), call("bash", { command: "true" }, "b"), result("bash", "", "b")] };
    assert.equal(identicalTailCalls([two, two]), 0);
    assert.equal(identicalTailCalls([{ content: [{ type: "text", text: "done" }] }]), 0);
    // A call without a result (cut off) ends the streak too.
    assert.equal(identicalTailCalls([{ content: [call("bash", { command: "true" })] }]), 0);
  });

  it("the guard trips after three", () => {
    assert.equal(NOOP_LOOP_STREAK, 3);
  });
});

describe("isTransientStreamError (resume a severed stream, not a real failure)", () => {
  it("treats undici's bare `terminated` as transient", () => {
    // The live incident: a 34-tool-call case-law step died ~12 minutes in when
    // its streaming response body dropped. undici raises exactly this.
    assert.equal(isTransientStreamError(new TypeError("terminated")), true);
  });

  it("matches connection faults by message or errno code", () => {
    for (const e of [
      new Error("fetch failed"),
      new Error("socket hang up"),
      new Error("Premature close"),
      new Error("other side closed"),
      Object.assign(new Error("read"), { code: "ECONNRESET" }),
      Object.assign(new Error("x"), { code: "UND_ERR_BODY_TIMEOUT" }),
      Object.assign(new Error("x"), { code: "UND_ERR_HEADERS_TIMEOUT" }),
    ]) {
      assert.equal(isTransientStreamError(e), true, `expected transient: ${e.message}`);
    }
  });

  it("unwraps a nested cause (the SDK wraps the socket error)", () => {
    const wrapped = new Error("API call failed", { cause: new TypeError("terminated") });
    assert.equal(isTransientStreamError(wrapped), true);
  });

  it("does NOT resume deterministic API failures", () => {
    for (const e of [
      new Error("401 Unauthorized: invalid x-api-key"),
      new Error("400 Bad Request: messages.0 invalid"),
      new Error("No object generated: could not parse the response."),
      new Error("model not found"),
    ]) {
      assert.equal(isTransientStreamError(e), false, `expected fatal: ${e.message}`);
    }
  });

  it("does NOT resume an abort — run control must win over recovery", () => {
    // A paused or cancelled run surfaces as an abort; resuming one would
    // defeat the cooperative pause/cancel boundary.
    assert.equal(isTransientStreamError(Object.assign(new Error("x"), { name: "AbortError" })), false);
    assert.equal(isTransientStreamError(new Error("The operation was aborted")), false);
    // Even when a transient-looking cause is wrapped underneath it.
    assert.equal(
      isTransientStreamError(Object.assign(new Error("aborted"), { cause: new TypeError("terminated") })),
      false,
    );
  });

  it("never resumes a cancelled run, by identity not by wording", () => {
    // Run control outranks recovery. Matched on the CancelledError marker so a
    // reworded cancel can't start looking transient.
    assert.equal(isTransientStreamError(Object.assign(new Error("stopped"), { isStrutCancelled: true })), false);
    assert.equal(isTransientStreamError(Object.assign(new Error("stopped"), { name: "CancelledError" })), false);
    // Even wrapping a genuinely transient cause must not make a cancel resumable.
    assert.equal(
      isTransientStreamError(
        Object.assign(new Error("stopped"), { isStrutCancelled: true, cause: new TypeError("terminated") }),
      ),
      false,
    );
  });

  it("terminates on a self-referential cause chain", () => {
    const a: any = new Error("weird");
    a.cause = a;
    assert.equal(isTransientStreamError(a), false);
  });

  it("is safe on null/undefined/non-errors", () => {
    assert.equal(isTransientStreamError(undefined), false);
    assert.equal(isTransientStreamError(null), false);
    assert.equal(isTransientStreamError("terminated"), true);
  });
});

describe("streamFailure / streamError (a stream that ended in an error)", () => {
  async function* parts(...ps: { type: string; error?: unknown }[]) {
    yield* ps;
  }

  it("a stream that ran to its end has no failure", async () => {
    assert.equal(await streamFailure({ stream: parts({ type: "text-delta" }, { type: "finish" }) }), undefined);
  });

  it("an `error` part is the failure, though the stream itself closed normally — the first one wins", async () => {
    const refused = new Error("refused");
    const got = await streamFailure({
      stream: parts({ type: "finish-step" }, { type: "error", error: refused }, { type: "error", error: new Error("later") }),
    });
    assert.equal(got, refused);
    // An error part with nothing in it is still a failure.
    assert.ok((await streamFailure({ stream: parts({ type: "error" }) })) instanceof Error);
  });

  it("a stream that broke is the failure too", async () => {
    const broke = new TypeError("terminated");
    async function* severed() {
      yield { type: "text-delta" };
      throw broke;
    }
    assert.equal(await streamFailure({ stream: severed() }), broke);
  });

  const refusal = (statusCode: number, responseBody: string, message = "prompt is too long") =>
    Object.assign(new Error(message), { name: "AI_APICallError", statusCode, responseBody });

  it("says the status and the body in the MESSAGE — the run log records nothing else", () => {
    const api = refusal(400, '{"type":"error","error":{"message":"prompt is too long"}}');
    const e = streamError(api, 3) as Error;
    assert.ok(e instanceof AgentStreamError);
    assert.equal(
      e.message,
      'agent failed after 3 step(s): prompt is too long (HTTP 400: {"type":"error","error":{"message":"prompt is too long"}})',
    );
    assert.equal(e.cause, api);
  });

  it("finds the refused request under a wrapper: an explained error's `cause`, a RetryError's `lastError`", () => {
    const explained = new Error("Mothership authorization for u1 is exhausted", { cause: refusal(402, "spent") });
    assert.match((streamError(explained, 0) as Error).message, /^agent failed after 0 step\(s\): Mothership authorization for u1 is exhausted \(HTTP 402: spent\)$/);
    const retried = Object.assign(new Error("Failed after 3 attempts. Last error: Overloaded"), { lastError: refusal(529, "busy") });
    assert.match((streamError(retried, 2) as Error).message, /Failed after 3 attempts\. Last error: Overloaded \(HTTP 529: busy\)$/);
  });

  it("caps a long body, and says a failure that is not an Error as it is", () => {
    const e = streamError(refusal(502, "x".repeat(5000)), 1) as Error;
    assert.ok(e.message.length < 2200, String(e.message.length));
    assert.match(e.message, /… \[5000 chars\]\)$/);
    assert.equal((streamError("text part 1 not found", 1) as Error).message, "agent failed after 1 step(s): text part 1 not found");
    assert.equal(
      (streamError({ type: "overloaded_error", message: "Overloaded" }, 1) as Error).message,
      'agent failed after 1 step(s): {"type":"overloaded_error","message":"Overloaded"}',
    );
  });

  it("hands a cancel back untouched, wrapped or not", () => {
    const cancel = new CancelledError("r1");
    assert.equal(streamError(cancel, 1), cancel);
    const wrapped = new Error("stream failed", { cause: cancel });
    assert.equal(streamError(wrapped, 1), wrapped);
  });
});

// These stay OFFLINE in the sense that matters — nothing leaves the machine.
// They drive the real generation loop against a local server that speaks the
// Anthropic SSE wire format, because the failure being guarded is a TRANSPORT
// fault: only a genuinely severed socket reproduces `TypeError: terminated`.
describe("mid-stream socket death is resumed, not lost", () => {
  const sse = (o: any) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
  const msgStart = () =>
    sse({
      type: "message_start",
      message: {
        id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-5",
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 1 },
      },
    });
  const toolUse = (id: string, name: string, input: unknown) =>
    sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } }) +
    sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }) +
    sse({ type: "content_block_stop", index: 0 }) +
    sse({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } }) +
    sse({ type: "message_stop" });

  type Server = { port: number; bodies: string[]; heads: http.IncomingHttpHeaders[]; calls: () => number; close: () => void };
  async function serve(handler: (call: number, res: http.ServerResponse) => void): Promise<Server> {
    const bodies: string[] = [];
    const heads: http.IncomingHttpHeaders[] = [];
    let call = 0;
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => { bodies.push(raw); heads.push(req.headers); handler(++call, res); });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return {
      port: (server.address() as any).port,
      bodies, heads, calls: () => call,
      close: () => server.close(),
    };
  }
  const severMidStream = (res: http.ServerResponse) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(msgStart());
    res.write(sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    res.write(sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }));
    setTimeout(() => res.socket?.destroy(), 5);
  };

  let cwd = "";
  let saved: Record<string, string | undefined> = {};
  const ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "STRUT_LLM_PROVIDER", "AI_SDK_LOG_WARNINGS"];
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "strut-stream-"));
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    process.env["AI_SDK_LOG_WARNINGS"] = "false";
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  const run = (maxSteps = 10) =>
    agent.run(
      (agent.input as any).parse({
        cwd, system: "sys", prompt: "do the research",
        model: "claude-sonnet-4-5", maxSteps,
        finalAnswer: "Report what you found.", toolFilter: ["bash"],
      }),
      { runId: "r", path: "p", scope: {}, input: undefined, emit: async () => {}, services: {}, registry: {} } as any,
    ) as Promise<any>;

  it("takes the provider key from ctx.services.secrets when env has none", async () => {
    const s = await serve((_call, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(msgStart());
      res.write(toolUse("toolu_1", "final_answer", { answer: "done" }));
      res.end();
    });
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${s.port}`;
    delete process.env["ANTHROPIC_API_KEY"];
    const asked: string[] = [];
    const secrets = {
      get: async (name: string) => {
        asked.push(name);
        return name === "ANTHROPIC_API_KEY" ? "from-store" : undefined;
      },
    };
    try {
      const out = await agent.run(
        (agent.input as any).parse({
          cwd, system: "sys", prompt: "go", model: "sonnet",
          finalAnswer: "Report.", toolFilter: ["bash"],
        }),
        { runId: "r", path: "p", scope: {}, input: undefined, emit: async () => {}, services: { secrets }, registry: {} } as any,
      ) as any;
      assert.equal(out.result, "done");
      // Asked by the provider's env-var NAME, and the value reached the wire.
      assert.deepEqual(asked, ["ANTHROPIC_API_KEY"]);
      assert.equal(s.heads[0]?.["x-api-key"], "from-store");
      // The alias resolved to the concrete id on the request.
      assert.ok((s.bodies[0] ?? "").includes('"model":"claude-sonnet-5-5"'), s.bodies[0]);
    } finally {
      s.close();
    }
  });

  it("toolFilter ['none'] sends no built-in tool — only final_answer", async () => {
    const s = await serve((_call, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(msgStart());
      res.write(toolUse("toolu_1", "final_answer", { answer: "done" }));
      res.end();
    });
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${s.port}`;
    try {
      await agent.run(
        (agent.input as any).parse({ cwd, system: "sys", prompt: "go", model: "sonnet", finalAnswer: "Report.", toolFilter: ["none"] }),
        { runId: "r", path: "p", scope: {}, input: undefined, emit: async () => {}, services: {}, registry: {} } as any,
      );
      const tools = JSON.parse(s.bodies[0] ?? "{}").tools.map((t: { name: string }) => t.name);
      assert.deepEqual(tools, ["final_answer"]);
    } finally {
      s.close();
    }
  });

  it("resumes a severed stream and keeps the work done before it died", async () => {
    const s = await serve((call, res) => {
      if (call === 2) return severMidStream(res);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(msgStart());
      res.write(
        call === 1
          ? toolUse("toolu_1", "bash", { command: "echo 'finding one' > research.md" })
          : toolUse("toolu_2", "final_answer", { answer: "resumed and finished" }),
      );
      res.end();
    });
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${s.port}`;
    try {
      const out = await run();
      assert.equal(out.result, "resumed and finished");
      // The pre-error tool call's real side effect survived the socket death.
      assert.equal(readFileSync(join(cwd, "research.md"), "utf8").trim(), "finding one");
      // Banked + resumed steps are both counted, and usage is summed across
      // attempts (two message_starts at 100 input tokens each).
      assert.equal(out.steps, 2);
      assert.equal(out.usage.inputTokens, 200);
      // The resume replayed the banked conversation, the original task, and
      // told the model what actually happened.
      const resume = s.bodies[2] ?? "";
      assert.ok(resume.includes("toolu_1"), "resume must replay the banked tool call");
      assert.ok(resume.includes("do the research"), "resume must restate the task");
      assert.ok(resume.includes("interrupted mid-stream"), "resume must carry the nudge");
    } finally {
      s.close();
    }
  });

  it("gives up after a bounded number of resumes when the socket keeps dying", async () => {
    const s = await serve((call, res) => {
      if (call === 1) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(msgStart());
        res.write(toolUse("toolu_1", "bash", { command: "echo hi > research.md" }));
        res.end();
        return;
      }
      severMidStream(res);
    });
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${s.port}`;
    try {
      // v7 wraps the socket death (APICallError → TypeError: terminated), so
      // match anywhere on the cause chain.
      await assert.rejects(run(), (e: any) => {
        for (let c = e; c; c = c.cause) if (/terminated/.test(String(c.message))) return true;
        return false;
      });
      // 1 good call + the first sever + MAX_STREAM_ERROR_CONTINUATIONS resumes.
      assert.equal(s.calls(), 7);
    } finally {
      s.close();
    }
  });

  // Schema (structured-output) mode: the schema is the final_answer TOOL's
  // input — never an output grammar over the loop (see agent.ts: the grammar
  // forbids all free text, and a model that cannot narrate marks time with
  // no-op tool calls) — so a "final answer" is a final_answer call carrying
  // the object. A text-only turn is a premature stop, as in finalAnswer mode.
  const textTurn = (text: string) =>
    sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
    sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) +
    sse({ type: "content_block_stop", index: 0 }) +
    sse({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } }) +
    sse({ type: "message_stop" });
  const schema = {
    type: "object",
    properties: { candidate: { type: "string" }, version: { type: "string" }, summary: { type: "string" } },
    required: ["candidate", "version", "summary"],
    additionalProperties: false,
  };
  const ctxArg = { runId: "r", path: "p", scope: {}, input: undefined, emit: async () => {}, services: {}, registry: {} } as any;
  const runSchema = (maxSteps = 10) =>
    agent.run(
      (agent.input as any).parse({
        cwd, system: "sys", prompt: "author and publish the candidate",
        model: "claude-sonnet-4-5", maxSteps, schema, toolFilter: ["bash"],
      }),
      ctxArg,
    ) as Promise<any>;
  const answered = (id: string, obj: unknown) => toolUse(id, "final_answer", obj);
  const toolNames = (body: string | undefined) => (JSON.parse(body ?? "{}").tools ?? []).map((t: { name: string }) => t.name);

  it("schema mode: the schema is final_answer's input, and no output grammar rides on the loop", async () => {
    const obj = { candidate: "gaia-produce-ai", version: "v6", summary: "curl not html/extract" };
    const s = await serve((_call, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(msgStart());
      res.write(answered("toolu_1", obj));
      res.end();
    });
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${s.port}`;
    try {
      const out = await runSchema();
      assert.deepEqual(out.object, obj);
      assert.equal(out.result, JSON.stringify(obj));
      assert.equal(out.steps, 1);
      const body = JSON.parse(s.bodies[0] ?? "{}");
      const fa = body.tools.find((t: { name: string }) => t.name === "final_answer");
      assert.ok(fa, "final_answer is a tool the model can call");
      assert.deepEqual(fa.input_schema.required, schema.required);
      assert.deepEqual(Object.keys(fa.input_schema.properties), Object.keys(schema.properties));
      assert.equal(body.output_config, undefined, "no output grammar over the tool loop");
      assert.equal(body.output_format, undefined);
      assert.deepEqual(body.tool_choice, { type: "auto" }, "never a forced tool choice");
    } finally {
      s.close();
    }
  });

  it("schema mode: a final_answer missing a required field is refused, and the loop goes on", async () => {
    const s = await serve((call, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(msgStart());
      if (call === 1) res.write(answered("toolu_1", { candidate: "gaia-produce-ai" }));
      else res.write(answered("toolu_2", { candidate: "gaia-produce-ai", version: "v7", summary: "second try" }));
      res.end();
    });
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${s.port}`;
    try {
      const out = await runSchema();
      assert.equal(out.object.version, "v7");
      assert.equal(out.steps, 2);
      assert.equal(s.calls(), 2);
      // The refusal reaches the model as the tool's error, naming the fields.
      assert.ok((s.bodies[1] ?? "").includes("missing required field(s): version, summary"), s.bodies[1]);
    } finally {
      s.close();
    }
  });

  it("schema mode: a premature degenerate answer is nudged, and the continuation's work + object win", async () => {
    // The live incident: an author answered at 6/200 steps with summary ""
    // and a version it never published.
    const s = await serve((call, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(msgStart());
      if (call === 1) res.write(answered("toolu_1", { candidate: "gaia-produce-ai", version: "v11", summary: "" }));
      else if (call === 2) res.write(toolUse("toolu_2", "bash", { command: "echo v11 > published.txt" }));
      else res.write(answered("toolu_3", { candidate: "gaia-produce-ai", version: "v11", summary: "dual attempt + reconcile" }));
      res.end();
    });
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${s.port}`;
    try {
      const out = await runSchema();
      assert.equal(out.object.summary, "dual attempt + reconcile");
      assert.equal(out.object.version, "v11");
      // The nudged loop ran a REAL tool call before answering.
      assert.equal(readFileSync(join(cwd, "published.txt"), "utf8").trim(), "v11");
      // 1 original turn + 2 continuation turns; usage summed across all three.
      assert.equal(out.steps, 3);
      assert.equal(out.usage.inputTokens, 300);
      const nudge = s.bodies[1] ?? "";
      assert.ok(nudge.includes("empty or filler: summary"), "nudge must name the empty field(s)");
      assert.ok(nudge.includes("author and publish the candidate"), "nudge must restate the task");
      assert.ok(nudge.includes("call final_answer again"), "nudge must say how to answer");
    } finally {
      s.close();
    }
  });

  it("schema mode: a usable answer is returned without a nudge, and an exhausted budget is never nudged", async () => {
    let obj = { candidate: "gaia-produce-ai", version: "v6", summary: "" };
    const s = await serve((_call, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(msgStart());
      res.write(answered("toolu_1", obj));
      res.end();
    });
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${s.port}`;
    try {
      // Degenerate but the step budget is already spent: hand it back as-is.
      const exhausted = await runSchema(1);
      assert.equal(exhausted.object.summary, "");
      assert.equal(s.calls(), 1);
      obj = { candidate: "gaia-produce-ai", version: "v6", summary: "curl not html/extract" };
      const fine = await runSchema();
      assert.equal(fine.object.summary, "curl not html/extract");
      assert.equal(fine.steps, 1);
      assert.equal(s.calls(), 2, "a complete answer must not trigger a continuation");
    } finally {
      s.close();
    }
  });

  it("schema mode: no final_answer at all → one nudge, then a forced no-tools turn through the output grammar", async () => {
    const s = await serve((call, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(msgStart());
      // The loop, then the nudged loop, both stop on narration …
      if (call <= 2) res.write(textTurn("Still weighing the options."));
      // … and the forced turn answers under the grammar.
      else res.write(textTurn(JSON.stringify({ candidate: "gaia-produce-ai", version: "v8", summary: "forced" })));
      res.end();
    });
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${s.port}`;
    try {
      const out = await runSchema();
      assert.equal(out.object.version, "v8");
      assert.equal(out.object.summary, "forced");
      assert.equal(s.calls(), 3);
      assert.ok((s.bodies[1] ?? "").includes("have NOT called final_answer"), "the nudge");
      const forced = JSON.parse(s.bodies[2] ?? "{}");
      assert.equal(forced.tools, undefined, "the forced turn offers no tools");
      assert.ok(forced.output_config, "and asks for the object through the grammar, where no loop can go wrong");
      assert.ok((s.bodies[2] ?? "").includes("produce the final structured answer NOW"));
    } finally {
      s.close();
    }
  });

  // The no-op loop guard: three identical calls with identical results, and
  // the fourth step is offered only final_answer. The live shape: a model that
  // had finished, running `true` / `echo done` until the step cap.
  const runMode = (extra: Record<string, unknown>) =>
    agent.run(
      (agent.input as any).parse({ cwd, system: "sys", prompt: "mark time", model: "claude-sonnet-4-5", maxSteps: 10, toolFilter: ["bash"], ...extra }),
      ctxArg,
    ) as Promise<any>;
  const noopThenAnswer = (answer: () => string) =>
    serve((call, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(msgStart());
      if (call <= NOOP_LOOP_STREAK) res.write(toolUse(`toolu_${call}`, "bash", { command: "true" }));
      else res.write(answer());
      res.end();
    });

  it("the no-op loop guard: after three identical no-op calls the next step offers only final_answer", async () => {
    const s = await noopThenAnswer(() => answered("toolu_fa", { answer: "done" }));
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${s.port}`;
    try {
      const out = await runMode({ finalAnswer: "the report" });
      assert.equal(out.result, "done");
      assert.equal(out.steps, 4);
      assert.ok(toolNames(s.bodies[2]).includes("bash"), "the full tool set up to the trip point");
      assert.deepEqual(toolNames(s.bodies[3]), ["final_answer"], "only the way out on the guarded step");
    } finally {
      s.close();
    }
  });

  it("the no-op loop guard in schema mode: the guarded step still carries the schema'd final_answer", async () => {
    const obj = { candidate: "gaia-produce-ai", version: "v9", summary: "guarded" };
    const s = await noopThenAnswer(() => answered("toolu_fa", obj));
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${s.port}`;
    try {
      const out = await runMode({ schema });
      assert.deepEqual(out.object, obj);
      assert.equal(out.steps, 4);
      assert.deepEqual(toolNames(s.bodies[3]), ["final_answer"]);
    } finally {
      s.close();
    }
  });

  it("the no-op loop guard in text mode: the guarded step has no tools, so the model answers in text", async () => {
    const s = await noopThenAnswer(() => textTurn("finished"));
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${s.port}`;
    try {
      const out = await runMode({});
      assert.equal(out.result, "finished");
      assert.equal(out.steps, 4);
      assert.ok(toolNames(s.bodies[2]).includes("bash"));
      assert.equal(JSON.parse(s.bodies[3] ?? "{}").tools, undefined, "no tools on the guarded step");
    } finally {
      s.close();
    }
  });

  it("the no-op loop guard leaves a poll alone: same command, changing output, all tools stay", async () => {
    let n = 0;
    const s = await serve((call, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(msgStart());
      // Each `date +%N` call returns something new — the model is watching something, not marking time.
      if (call <= 3) res.write(toolUse(`toolu_${call}`, "bash", { command: `echo poll-${++n}` }));
      else res.write(answered("toolu_fa", { answer: "settled" }));
      res.end();
    });
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${s.port}`;
    try {
      const out = await runMode({ finalAnswer: "the report" });
      assert.equal(out.result, "settled");
      assert.ok(toolNames(s.bodies[3]).includes("bash"), "a changing poll never trips the guard");
    } finally {
      s.close();
    }
  });

  it("does not burn resumes on a deterministic API failure", async () => {
    const s = await serve((_call, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
    });
    process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${s.port}`;
    try {
      await assert.rejects(run());
      assert.equal(s.calls(), 1, "a 401 must fail on the first call, not retry");
    } finally {
      s.close();
    }
  });

  // A request the provider REFUSES is not a broken stream to the SDK: it
  // arrives as an `error` part and the stream closes normally, with the steps
  // banked so far — which reads exactly like a model that stopped.
  const REFUSAL = { type: "error", error: { type: "invalid_request_error", message: "prompt is too long" } };
  const refuse = (res: http.ServerResponse) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify(REFUSAL));
  };
  const ok = (res: http.ServerResponse, body: string) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(msgStart());
    res.write(body);
    res.end();
  };
  /** The provider's own words: the status, its message, and the body. */
  const isRefusal = (e: any) => {
    assert.match(e.message, /400/);
    assert.match(e.message, /prompt is too long/);
    assert.ok(e.message.includes(JSON.stringify(REFUSAL)), e.message);
    assert.doesNotMatch(e.message, /No output generated/);
    return true;
  };
  // The SDK prints every stream error it is not handed; keep the test output readable.
  const quietly = async (fn: () => Promise<void>) => {
    const error = console.error;
    const warn = console.warn;
    console.error = console.warn = () => {};
    try {
      await fn();
    } finally {
      console.error = error;
      console.warn = warn;
    }
  };

  it("a request refused after a successful step fails the step with the provider's message, and asks nothing more", () =>
    quietly(async () => {
      const s = await serve((call, res) =>
        call === 1 ? ok(res, toolUse("toolu_1", "bash", { command: "echo one > research.md" })) : refuse(res),
      );
      process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${s.port}`;
      try {
        await assert.rejects(run(), (e: any) => isRefusal(e) && /after 1 step/.test(e.message));
        assert.equal(s.calls(), 2, "no nudge, no forced final answer");
      } finally {
        s.close();
      }
    }));

  it("a refused FIRST request fails with the provider's message, not the SDK's `No output generated`", () =>
    quietly(async () => {
      const s = await serve((_call, res) => refuse(res));
      process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${s.port}`;
      try {
        await assert.rejects(run(), isRefusal);
        assert.equal(s.calls(), 1);
        await assert.rejects(runSchema(), isRefusal);
        assert.equal(s.calls(), 2);
      } finally {
        s.close();
      }
    }));

  it("a refusal in a continuation fails the step too: the nudge, the schema nudge, the forced final answer", () =>
    quietly(async () => {
      let first = textTurn("now let's write it up");
      const s = await serve((call, res) => (call % 2 ? ok(res, first) : refuse(res)));
      process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${s.port}`;
      try {
        // Stopped tool-lessly with budget left → the nudge is the refused request.
        await assert.rejects(run(), isRefusal);
        assert.equal(s.calls(), 2, "a refused nudge must not go on to the forced turn");
        // Budget spent without final_answer → the forced turn is.
        first = toolUse("toolu_1", "bash", { command: "true" });
        await assert.rejects(run(1), isRefusal);
        assert.equal(s.calls(), 4);
        // A degenerate structured answer → the schema nudge is.
        first = textTurn(JSON.stringify({ candidate: "c", version: "v1", summary: "" }));
        await assert.rejects(runSchema(), isRefusal);
        assert.equal(s.calls(), 6);
      } finally {
        s.close();
      }
    }));

  it("a continuation cut by a connection fault still falls through to the next salvage", () =>
    quietly(async () => {
      const s = await serve((call, res) => {
        if (call === 2) return severMidStream(res);
        ok(res, textTurn(call === 1 ? "now let's write it up" : "the answer"));
      });
      process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${s.port}`;
      try {
        const out = await run();
        assert.equal(out.result, "the answer");
        assert.equal(s.calls(), 3, "turn, severed nudge, forced final answer");
      } finally {
        s.close();
      }
    }));

  it("a cancel is a cancel, never a provider error — in the loop and in a continuation", () =>
    quietly(async () => {
      let first = toolUse("toolu_1", "bash", { command: "true" });
      const s = await serve((_call, res) => ok(res, first));
      process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${s.port}`;
      // Cancelled while the first request is in flight: the next checkpoint throws.
      const cancelled = () => {
        let checks = 0;
        const control = {
          state: "running",
          checkpoint: async () => {
            if (++checks > 1) throw new CancelledError("r");
          },
        };
        return agent.run(
          (agent.input as any).parse({
            cwd, system: "sys", prompt: "do the research", model: "claude-sonnet-4-5",
            finalAnswer: "Report what you found.", toolFilter: ["bash"],
          }),
          { runId: "r", path: "p", scope: {}, input: undefined, emit: async () => {}, services: {}, registry: {}, control } as any,
        );
      };
      try {
        await assert.rejects(cancelled(), (e: any) => isCancelledError(e) && !/provider/.test(e.message));
        assert.equal(s.calls(), 1, "a cancelled loop asks nothing more");
        // The loop ended on its own (a tool-less turn); the cancel lands on the nudge.
        first = textTurn("now let's write it up");
        await assert.rejects(cancelled(), (e: any) => isCancelledError(e) && !/provider/.test(e.message));
        assert.equal(s.calls(), 2, "a cancelled nudge must not go on to the forced turn");
      } finally {
        s.close();
      }
    }));

  it("a cancel reaches a RUNNING bash command: its process group dies at once, not at the timeout", () =>
    quietly(async () => {
      const control = {
        state: "running",
        checkpoint: async () => {
          if (control.state === "cancelling") throw new CancelledError("r");
        },
      };
      const s = await serve((call, res) => {
        // The command would run 30s; the run starts cancelling 300ms into it.
        if (call === 1) setTimeout(() => (control.state = "cancelling"), 300);
        ok(res, toolUse("toolu_1", "bash", { command: "sleep 30 & echo $!; wait" }));
      });
      process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${s.port}`;
      const events: any[] = [];
      const t0 = Date.now();
      try {
        await assert.rejects(
          agent.run(
            (agent.input as any).parse({
              cwd, system: "sys", prompt: "go", model: "claude-sonnet-4-5",
              finalAnswer: "Report.", toolFilter: ["bash"],
            }),
            { runId: "r", path: "p", scope: {}, input: undefined, emit: async (e: any) => void events.push(e), services: {}, registry: {}, control } as any,
          ),
          (e: any) => isCancelledError(e),
        );
        assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0}ms — the cancel waited for the command`);
        assert.equal(s.calls(), 1, "a cancelled loop asks nothing more");
        const end = events.find((e) => e.type === "step.end" && e.stepType === "tool:bash");
        const output = String(end?.output);
        assert.match(output, /^Command cancelled/);
        // The shell printed its background child's pid before the kill; the
        // group kill took the child too.
        const background = Number(output.trim().split("\n").pop());
        assert.ok(background > 0, output);
        await new Promise((r) => setTimeout(r, 300));
        assert.throws(() => process.kill(background, 0), /ESRCH/);
      } finally {
        s.close();
      }
    }));

  it("a bash command past bashTimeoutMs is killed with its group, reported, and the loop goes on", () =>
    quietly(async () => {
      const s = await serve((call, res) =>
        ok(
          res,
          call === 1
            ? toolUse("toolu_1", "bash", { command: "sleep 30 & echo $!; wait" })
            : toolUse("toolu_2", "final_answer", { answer: "done" }),
        ),
      );
      process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${s.port}`;
      const events: any[] = [];
      const t0 = Date.now();
      try {
        const out = (await agent.run(
          (agent.input as any).parse({
            cwd, system: "sys", prompt: "go", model: "claude-sonnet-4-5",
            finalAnswer: "Report.", toolFilter: ["bash"], bashTimeoutMs: 300,
          }),
          { runId: "r", path: "p", scope: {}, input: undefined, emit: async (e: any) => void events.push(e), services: {}, registry: {} } as any,
        )) as any;
        assert.equal(out.result, "done");
        assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0}ms`);
        const end = events.find((e) => e.type === "step.end" && e.stepType === "tool:bash");
        const output = String(end?.output);
        assert.match(output, /^Command execution failed: Error: Command timed out after 300ms/);
        const background = Number(output.trim().split("\n").pop());
        assert.ok(background > 0, output);
        await new Promise((r) => setTimeout(r, 300));
        assert.throws(() => process.kill(background, 0), /ESRCH/);
        // The model is told the budget it has.
        assert.ok((s.bodies[0] ?? "").includes("One command may run for 300 ms"), "the tool description names the budget");
      } finally {
        s.close();
      }
    }));

  it("the RUN says so: `error` with the provider's message for a refusal, `cancelled` for a cancel", () =>
    quietly(async () => {
      let cancel: (() => void) | undefined;
      const s = await serve((call, res) => {
        if (call === 2) return refuse(res);
        // Cancelled while the request is in flight: the loop's next checkpoint stops it.
        cancel?.();
        ok(res, toolUse("toolu_1", "bash", { command: "true" }));
      });
      process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${s.port}`;
      const wf = flow("agent-test", {
        input: z.object({}),
        steps: [
          step("a", "agent", {
            cwd, system: "sys", prompt: "do the research", model: "claude-sonnet-4-5",
            finalAnswer: "Report what you found.", toolFilter: ["bash"],
          }),
        ],
      });
      const launch = (controller?: RunController) => {
        const store = new MemoryRunStore();
        return runWorkflow(wf, {}, coreRegistry(), { store, services: {}, ...(controller ? { controller } : {}) }).then(
          async (r) => ({ r, events: await store.getRunEvents("agent-test", r.runId) }),
        );
      };
      try {
        const refused = await launch();
        assert.equal(refused.r.status, "error");
        const failed = refused.events.find((e) => e.type === "step.error" && e.path === "agent-test/a");
        isRefusal(failed?.error);
        assert.equal(s.calls(), 2);

        const controller = new RunController("r-agent", "agent-test");
        cancel = () => controller.cancel();
        const stopped = await launch(controller);
        assert.equal(stopped.r.status, "cancelled", JSON.stringify(stopped.r.error ?? ""));
        assert.equal(s.calls(), 3, "one request, none after the cancel");
      } finally {
        s.close();
      }
    }));
});
