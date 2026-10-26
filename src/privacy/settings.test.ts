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
