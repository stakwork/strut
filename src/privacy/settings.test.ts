import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { defineStep } from "../core.js";
import { runWorkflow } from "../runner.js";
import { createRegistry } from "../steps/registry.js";
import { MemoryRunStore } from "../store.js";
import { validateWorkflowYaml } from "../validate.js";
import { flowFromYaml } from "../workspace.js";
import { hostConfigFromEnv } from "../server.js";
import "./register.js";

let seen: any;
const probe = defineStep({ type: "t/probe", description: "p", input: z.object({}).passthrough(), output: z.any(), async run(_c, ctx) { seen = ctx.settings; return {}; } } as any);
const registry = createRegistry([probe as any]);

const yamlOf = (settings: string, stepOpts = "") => `name: wf
${settings}
steps:
  - id: a
    type: t/probe
    config: {}
${stepOpts}`;

async function run(yaml: string, o: { deployment?: unknown; run?: unknown } = {}) {
  const flow = flowFromYaml("wf", "v1", yaml);
  const r = await runWorkflow(flow, {}, await registry, { store: new MemoryRunStore(), services: { settings: o.deployment }, settings: o.run as any });
  assert.equal(r.status, "success", r.error?.message);
  return seen;
}

describe("settings levels", () => {
  it("deployment < workflow < run < step, per key and whole", async () => {
    assert.deepEqual(await run(yamlOf(""), { deployment: { privacy: "hosted" } }), { privacy: { mode: "hosted", mask: seen.privacy.mask, detect: { llm: false } } });
    assert.equal((await run(yamlOf("settings:\n  privacy: strict"), { deployment: { privacy: "hosted" } })).privacy.mode, "strict");
    assert.equal((await run(yamlOf("settings:\n  privacy: strict"), { deployment: { privacy: "hosted" }, run: { privacy: "off" } })).privacy.mode, "off");
    const step = yamlOf("settings:\n  privacy: strict", "    options:\n      settings:\n        privacy:\n          mode: hosted\n          mask: [PERSON]");
    const s = await run(step, { deployment: { privacy: "off" }, run: { privacy: "off" } });
    assert.deepEqual(s.privacy, { mode: "hosted", mask: ["PERSON"], detect: { llm: false } }, "the step wins, and whole: no deep merge");
  });

  it("a subflow inherits its caller's settings, which win over its own; a container's options reach its body", async () => {
    const all: any[] = [];
    const rec = defineStep({ type: "t/rec", description: "r", input: z.object({}).passthrough(), output: z.any(), async run(_c, ctx) { all.push(ctx.settings?.["privacy"]); return {}; } } as any);
    const reg = createRegistry([rec as any]);
    const leaf = "  - id: r\n    type: t/rec\n    config: {}\n";
    const flows: Record<string, string> = {
      plain: `name: plain\nsteps:\n${leaf}`,
      own: `name: own\nsettings:\n  privacy: hosted\nsteps:\n${leaf}`,
    };
    const workspace = { getWorkflow: async (n: string) => flowFromYaml(n, "v1", flows[n]!) } as any;
    const go = async (yaml: string) => {
      all.length = 0;
      const r = await runWorkflow(flowFromYaml("wf", "v1", yaml), {}, await reg, { store: new MemoryRunStore(), workspace });
      assert.equal(r.status, "success", r.error?.message);
      return all.map((p) => p?.mode);
    };
    const sub = (wf: string, opts = "") => `  - id: s_${wf}\n    type: subflow\n    config: { workflow: ${wf} }\n${opts}`;
    assert.deepEqual(await go(`name: wf\nsettings:\n  privacy: strict\nsteps:\n${sub("plain")}${sub("own")}`), ["strict", "strict"], "the caller's workflow level wins");
    assert.deepEqual(await go(`name: wf\nsteps:\n${sub("own")}`), ["hosted"], "nothing set by the caller: the child's own");
    assert.deepEqual(await go(`name: wf\nsteps:\n${sub("plain", "    options:\n      settings:\n        privacy: strict\n")}`), ["strict"], "a subflow step's options");
    const each = `  - id: e\n    type: foreach\n    config:\n      items: [1, 2]\n      body: { id: r, type: t/rec, config: {} }\n    options:\n      settings:\n        privacy: hosted\n`;
    assert.deepEqual(await go(`name: wf\nsteps:\n${each}`), ["hosted", "hosted"], "a foreach's options reach its body");
  });

  it("validate.ts rejects a bad settings.privacy and an unknown setting in workflow YAML", async () => {
    const v = async (settings: string) => validateWorkflowYaml(yamlOf(settings), { registry: await registry });
    assert.equal((await v("settings:\n  privacy: strict")).ok, true);
    assert.equal((await v("settings:\n  privacy: { mode: hosted, mask: [PERSON] }")).ok, true);
    const bad = await v("settings:\n  privacy: sometimes");
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((e) => e.path === "settings" && /settings\.privacy/.test(e.message)));
    assert.equal((await v("settings:\n  nonsense: 1")).ok, false);
  });

  it("the deployment level comes from the STRUT_HOST_CONFIG file's `settings` key", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const file = join(mkdtempSync(join(tmpdir(), "strut-hc-")), "host.json");
    writeFileSync(file, JSON.stringify({ settings: { privacy: "hosted" } }));
    assert.deepEqual(hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), { settings: { privacy: "hosted" } });
    writeFileSync(file, JSON.stringify({ settings: ["x"] }));
    assert.throws(() => hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), /"settings" must be an object/);
  });
});
