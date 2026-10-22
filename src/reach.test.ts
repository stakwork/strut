import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { createStrut, type Strut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import type { AuthoringCapability } from "./authoring.js";
import { withinReach, type BuilderReach, type ReachPolicy } from "./reach.js";
import { hostConfigFromEnv } from "./server.js";
import type { StepContext } from "./core.js";

/**
 * Reach (src/reach.ts): what code the AI published may touch, when the host
 * sets `builder.reach`. Publish is refused outside it; at run time a step
 * the AI published reads only reach's secrets, and a workflow the AI
 * published names only reach's secrets in its config. Without a reach
 * nothing changes.
 */

// A custom step that reads the secret its config names (no imports: the
// temp workspace is outside the package tree — authoring.test.ts's note).
const readsSecret = (type: string) => `export default {
  type: ${JSON.stringify(type)},
  description: "reads a secret",
  input: { parse: (v) => v },
  output: { parse: (v) => v },
  run: async (cfg, ctx) => ({ value: await ctx.services.secrets.get(cfg.name) }),
};
`;

const flow = (name: string, steps: string) => `name: ${name}\nsteps:\n${steps}`;
const stepYaml = (id: string, type: string, config: string) => `  - id: ${id}\n    type: ${type}\n    config:\n${config}`;

const REACH: BuilderReach = {
  tools: ["slack/read-channel", "x/*"],
  builtins: ["web_search", "web_fetch"],
  secrets: ["SLACK_BOT_TOKEN", "OK_KEY"],
};

async function strutWith(dir: string, reach?: BuilderReach) {
  const strut = await createStrut({
    workspace: new WorkspaceManager(dir),
    serveUi: false,
    enableChat: false,
    ...(reach ? { builder: { reach } } : {}),
  });
  await strut.secretStore.set("OK_KEY", "ok-value");
  await strut.secretStore.set("PEEL_BRIDGE_TOKEN", "bridge-value");
  return { strut, authoring: (strut.services as { authoring: AuthoringCapability }).authoring };
}

describe("builder.reach", () => {
  let dir: string;
  let strut: Strut<Record<string, unknown>>;
  let authoring: AuthoringCapability;

  before(async () => {
    dir = join(tmpdir(), `strut-reach-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    ({ strut, authoring } = await strutWith(dir, REACH));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const refused = async (name: string, steps: string, why: RegExp) => {
    const r = (await authoring.publishWorkflow(name, flow(name, steps))) as { error?: string };
    assert.ok(r.error, `${name} should be refused`);
    assert.match(r.error!, /builder\.reach/);
    assert.match(r.error!, why);
  };

  it("refuses a publish that names a step, a built-in or a secret outside reach", async () => {
    await refused("r-step", stepYaml("s", "slack/post-message", "      channel: C1\n      text: hi\n"), /the step "slack\/post-message"/);
    await refused("r-exec", stepYaml("s", "exec", "      cmd: \"true\"\n"), /the built-in "exec"/);
    await refused(
      "r-secrets-env",
      stepYaml("a", "agent", "      prompt: hi\n      toolFilter: [web_search]\n      secretsEnv: [PEEL_BRIDGE_TOKEN]\n"),
      /the secret "PEEL_BRIDGE_TOKEN"/,
    );
    await refused("r-templated", stepYaml("a", "agent", "      prompt: hi\n      toolFilter: [web_search]\n      secretsEnv: [\"{{ input.k }}\"]\n"), /a secret named by a template/);
    await refused("r-all-builtins", stepYaml("a", "agent", "      prompt: hi\n"), /every built-in/);
    await refused("r-bash", stepYaml("a", "agent", "      prompt: hi\n      toolFilter: [bash]\n"), /the built-in "bash"/);
    await refused("r-grant", stepYaml("a", "agent", "      prompt: hi\n      toolFilter: [none]\n      agentTools: [slack/*]\n"), /the grant "slack\/\*" \(reaches "slack\/post-message"\)/);
    await refused("r-exec-tool", stepYaml("a", "agent", "      prompt: hi\n      toolFilter: [none]\n      agentTools: [exec]\n"), /the built-in "exec" \(agentTools\)/);
    // A git step's tokenSecret defaults to GITHUB_TOKEN: a secret it names.
    await refused("r-token", stepYaml("g", "git/checkout", "      repo: https://example.com/r.git\n"), /the secret "GITHUB_TOKEN"/);
  });

  it("publishes what is inside: reach's steps and globs, its built-ins, its secrets, control flow, and steps the AI published", async () => {
    assert.ok(!("error" in (await authoring.createStep("cand/reads", readsSecret("cand/reads")))));
    const steps =
      stepYaml("read", "slack/read-channel", "      channel: C1\n") +
      stepYaml("say", "log", "      message: hi\n") +
      stepYaml("mine", "cand/reads", "      name: OK_KEY\n") +
      stepYaml("a", "agent", "      prompt: hi\n      toolFilter: [web_search, web_fetch]\n      agentTools: [x/*, cand/reads]\n      secretsEnv: [OK_KEY]\n");
    const r = (await authoring.publishWorkflow("r-inside", flow("r-inside", steps))) as { ok?: boolean; error?: string };
    assert.equal(r.error, undefined);
    assert.equal(r.ok, true);
  });

  it("a step the AI published reads reach's secrets and fails on any other, whoever runs it", async () => {
    await authoring.createStep("cand/peek", readsSecret("cand/peek"));
    await authoring.publishWorkflow("r-peek-ok", flow("r-peek-ok", stepYaml("p", "cand/peek", "      name: OK_KEY\n")));
    const ok = (await authoring.runWorkflow("r-peek-ok")) as { status: string; output?: unknown };
    assert.equal(ok.status, "success");
    assert.deepEqual(ok.output, { value: "ok-value" });

    // Published by a person (no stamp): still the AI's step, still scoped.
    await strut.workspace.publishWorkflowByContent("r-peek-human", flow("r-peek-human", stepYaml("p", "cand/peek", "      name: PEEL_BRIDGE_TOKEN\n")), undefined, undefined, undefined);
    const bad = (await authoring.runWorkflow("r-peek-human")) as { status: string; error?: { message: string } };
    assert.equal(bad.status, "error");
    assert.match(bad.error!.message, /may not read the secret "PEEL_BRIDGE_TOKEN"/);
  });

  it("a step a person published reads any secret, reach or not", async () => {
    await strut.workspace.publishStep("human/peek", readsSecret("human/peek"), undefined, "harness-seed");
    await strut.workspace.publishWorkflowByContent("r-human", flow("r-human", stepYaml("p", "human/peek", "      name: PEEL_BRIDGE_TOKEN\n")), undefined, undefined, undefined);
    const r = (await authoring.runWorkflow("r-human")) as { status: string; output?: unknown };
    assert.equal(r.status, "success");
    assert.deepEqual(r.output, { value: "bridge-value" });
  });

  it("a workflow the AI published may not name a secret outside reach at run time, a subflow's steps included; a person's may", async () => {
    const execStep = stepYaml("e", "exec", "      cmd: printenv\n      args: [PEEL_BRIDGE_TOKEN]\n      secretsEnv: [PEEL_BRIDGE_TOKEN]\n");
    // Stamped `ai` past the gate (an older publish, or a host's import).
    await strut.workspace.publishWorkflowByContent("r-ai-exec", flow("r-ai-exec", execStep), undefined, undefined, "ai");
    const ai = (await authoring.runWorkflow("r-ai-exec")) as { status: string; error?: { message: string } };
    assert.equal(ai.status, "error");
    assert.match(ai.error!.message, /"exec" may not read the secret "PEEL_BRIDGE_TOKEN".*inside a workflow the AI published/);

    await strut.workspace.publishWorkflowByContent("r-person-exec", flow("r-person-exec", execStep), undefined, undefined, undefined);
    assert.equal(((await authoring.runWorkflow("r-person-exec")) as { status: string }).status, "success");

    // The AI's workflow reaching the person's through a subflow: still the AI's frame.
    await strut.workspace.publishWorkflowByContent(
      "r-ai-sub",
      flow("r-ai-sub", stepYaml("sub", "subflow", "      workflow: r-person-exec\n      input: {}\n")),
      undefined,
      undefined,
      "ai",
    );
    const sub = (await authoring.runWorkflow("r-ai-sub")) as { status: string; error?: { message: string } };
    assert.equal(sub.status, "error");
    assert.match(sub.error!.message, /may not read the secret "PEEL_BRIDGE_TOKEN"/);
  });

  it("the meta surface's test run of one step is held to reach: outside it refused, inside it the AI's frame", async () => {
    const outside = (await authoring.runStep("slack/post-message", { config: { channel: "C1", text: "hi" } })) as { error?: string };
    assert.match(outside.error ?? "", /outside what this strut lets the AI run/);
    assert.match(((await authoring.runStep("exec", { config: { cmd: "true" } })) as { error?: string }).error ?? "", /builder\.reach/);

    const d = join(dir, "exec-reach");
    await mkdir(d, { recursive: true });
    const { authoring: withExec } = await strutWith(d, { builtins: ["exec"], secrets: ["OK_KEY"] });
    const leak = (await withExec.runStep("exec", { config: { cmd: "printenv", args: ["PEEL_BRIDGE_TOKEN"], secretsEnv: ["PEEL_BRIDGE_TOKEN"] } })) as { status: string; error?: { message: string } };
    assert.equal(leak.status, "error");
    assert.match(leak.error!.message, /may not read the secret "PEEL_BRIDGE_TOKEN"/);
    const ok = (await withExec.runStep("exec", { config: { cmd: "printenv", args: ["OK_KEY"], secretsEnv: ["OK_KEY"] } })) as { status: string };
    assert.equal(ok.status, "success");
  });

  it("a step the AI published gets no door to run other steps with the whole bag, and cannot widen reach", async () => {
    await authoring.createStep(
      "cand/doors",
      readsSecret("cand/doors").replace(
        "run: async (cfg, ctx) => ({ value: await ctx.services.secrets.get(cfg.name) }),",
        "run: async (cfg, ctx) => ({ authoring: typeof ctx.services.authoring, jobs: typeof ctx.services.jobs, reach: typeof ctx.services.reach }),",
      ),
    );
    await authoring.publishWorkflow("r-doors", flow("r-doors", stepYaml("d", "cand/doors", "      name: x\n")));
    assert.deepEqual(((await authoring.runWorkflow("r-doors")) as { output?: unknown }).output, { authoring: "undefined", jobs: "undefined", reach: "undefined" });
    const policy = (strut.services as { reach: ReachPolicy }).reach;
    assert.throws(() => (policy.secrets as string[]).push("PEEL_BRIDGE_TOKEN"));
    assert.throws(() => {
      (strut.services as Record<string, unknown>)["reach"] = undefined;
    });
  });

  it("names every way a config names a secret: secretsEnv, tokenSecret, storageStateSecret, http/verify's {NAME} templates", async () => {
    await refused("r-storage", stepYaml("b", "browser/open", "      storageStateSecret: PEEL_BRIDGE_TOKEN\n"), /the secret "PEEL_BRIDGE_TOKEN"/);
    await refused(
      "r-verify",
      stepYaml("v", "http/verify", "      url: https://example.com\n      secrets:\n        Authorization: \"Bearer {PEEL_BRIDGE_TOKEN}\"\n"),
      /the secret "PEEL_BRIDGE_TOKEN"/,
    );
    const policy: ReachPolicy = { secrets: ["OK_KEY"], aiWorkflow: async () => true, aiStep: () => false };
    const ctx = { runId: "r", path: "p", scope: {}, input: {}, emit: async () => {}, services: { reach: policy }, aiAuthored: true } as StepContext<unknown>;
    assert.throws(() => withinReach("http/verify", { secrets: { Authorization: "Bearer {OK_KEY}", "X-Other": "{PEEL_BRIDGE_TOKEN}" } }, ctx), /PEEL_BRIDGE_TOKEN/);
    assert.doesNotThrow(() => withinReach("http/verify", { secrets: { Authorization: "Bearer {OK_KEY}" } }, ctx));
    // The launcher's MCP servers stop at an AI frame.
    const withMcp = withinReach("log", {}, { ...ctx, mcp: [{ name: "linear", url: "https://mcp.example" }] });
    assert.equal(withMcp.mcp, undefined);
  });

  it("a tool call inside the AI's workflow is held to reach too (what the model passes)", () => {
    const policy: ReachPolicy = { secrets: ["OK_KEY"], aiWorkflow: async () => true, aiStep: () => false };
    const ctx = { runId: "r", path: "p", scope: {}, input: {}, emit: async () => {}, services: { reach: policy }, aiAuthored: true } as StepContext<unknown>;
    assert.throws(() => withinReach("git/push", { tokenSecret: "PEEL_BRIDGE_TOKEN" }, ctx), /may not read the secret "PEEL_BRIDGE_TOKEN"/);
    assert.doesNotThrow(() => withinReach("git/push", { tokenSecret: "OK_KEY" }, ctx));
    assert.doesNotThrow(() => withinReach("git/push", { tokenSecret: "PEEL_BRIDGE_TOKEN" }, { ...ctx, aiAuthored: undefined }));
  });
});

describe("without builder.reach (Hive, and every strut until its host sets one)", () => {
  let dir: string;
  before(async () => {
    dir = join(tmpdir(), `strut-noreach-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("publishes and runs as before: no reach check, no secret scope", async () => {
    const { strut, authoring } = await strutWith(dir);
    assert.equal((strut.services as { reach?: unknown }).reach, undefined);
    const exec = stepYaml("e", "exec", "      cmd: \"true\"\n      secretsEnv: [PEEL_BRIDGE_TOKEN]\n");
    assert.equal(((await authoring.publishWorkflow("n-exec", flow("n-exec", exec))) as { ok?: boolean }).ok, true);
    assert.equal(((await authoring.runWorkflow("n-exec")) as { status: string }).status, "success");
    await authoring.createStep("cand/peek", readsSecret("cand/peek"));
    await authoring.publishWorkflow("n-peek", flow("n-peek", stepYaml("p", "cand/peek", "      name: PEEL_BRIDGE_TOKEN\n")));
    assert.deepEqual(((await authoring.runWorkflow("n-peek")) as { output?: unknown }).output, { value: "bridge-value" });
  });
});

describe("STRUT_HOST_CONFIG builder.reach", () => {
  it("reads it, and fails the boot on a malformed one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reach-host-config-"));
    try {
      const file = join(dir, "host.json");
      await writeFile(file, JSON.stringify({ builder: { peer: false, reach: { tools: ["slack/*"], builtins: ["web_search"], secrets: ["SLACK_BOT_TOKEN"] } } }));
      assert.deepEqual(hostConfigFromEnv({ STRUT_HOST_CONFIG: file }).builder, {
        reach: { tools: ["slack/*"], builtins: ["web_search"], secrets: ["SLACK_BOT_TOKEN"] },
        peer: false,
      });
      for (const reach of [["slack/*"], { secrets: "X" }, { tool: ["x"] }, null]) {
        await writeFile(file, JSON.stringify({ builder: { reach } }));
        assert.throws(() => hostConfigFromEnv({ STRUT_HOST_CONFIG: file }), /"builder\.reach" must be/);
      }
      await writeFile(file, JSON.stringify({ job: { reach: { secrets: ["X"] } } }));
      assert.equal(hostConfigFromEnv({ STRUT_HOST_CONFIG: file }).job?.["reach" as never], undefined, "only the builder takes a reach");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
