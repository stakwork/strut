/**
 * The fence holds every function of a package's step, not only `run`
 * (src/packages/fence.ts `fenceStep`): the card it writes for a person
 * (`describe`), its own answer to a gated call (`answerGated`) and what a
 * replay puts back (`onReplay`) each get the run's context behind the
 * package's fence, so none of them reads a secret the package did not
 * declare — the box's or a person's own.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { actorSecretStore } from "../actor-secrets.js";
import { secretsCapability, type SecretsCapability } from "../capabilities.js";
import { defineStep, type AnyStepDef, type StepContext } from "../core.js";
import { proposeCall, type ProposalsCapability } from "../proposals.js";
import { MemorySecretStore } from "../secret-store.js";
import { buildRegistry } from "../steps/registry.js";
import { ensureEsmScope } from "../workspace.js";
import { STEP_FUNCTIONS, fenceStep, type Fence } from "./fence.js";

const PKG = "acme/mail";
const TYPE = "acme/mail/send";
const FENCE: Fence = { package: PKG, secrets: ["MAIL_TOKEN"], provides: { secrets: ["MAIL_TOKEN"] } };
const FENCED = new RegExp(`^Error: secret_fenced: ${TYPE} came from the package ${PKG}, which declares only MAIL_TOKEN — it may not read GITHUB_TOKEN`);

/** A package's step each of whose functions reads `cfg.name` as its run reads secrets. */
const read = async (cfg: { name: string }, ctx: StepContext<any>) => (ctx.services as { secrets: SecretsCapability }).secrets.get(cfg.name);
const step = defineStep({
  type: TYPE,
  input: z.object({ name: z.string() }),
  output: z.any(),
  run: read,
  async describe(cfg, ctx) {
    return { title: `Send with ${await read(cfg, ctx)}` };
  },
  answerGated: read,
  async onReplay(cfg, ctx) {
    await read(cfg, ctx);
  },
}) as AnyStepDef;

const box = () => secretsCapability({ GITHUB_TOKEN: "box-gh", MAIL_TOKEN: "box-mail" });
const ctxOf = (secrets: SecretsCapability, extra: Partial<StepContext<any>> = {}) =>
  ({ runId: "r0", path: "agent/001-send", scope: {}, input: undefined, emit: async () => {}, services: { secrets }, ...extra }) as unknown as StepContext<any>;

/** Each function of the step, called as its caller calls it. */
const CALLS: Record<string, (def: AnyStepDef, cfg: { name: string }, ctx: StepContext<any>) => Promise<unknown>> = {
  run: (def, cfg, ctx) => def.run(cfg, ctx),
  describe: async (def, cfg, ctx) => (await def.describe!(cfg, ctx))?.title,
  answerGated: (def, cfg, ctx) => def.answerGated!(cfg, ctx),
  onReplay: (def, cfg, ctx) => def.onReplay!(cfg, ctx, undefined),
};

/** The members of an interface in src/core.ts whose parameters take a `StepContext`. */
function contextFunctionsOf(source: string, iface: string): string[] {
  const start = source.indexOf(`export interface ${iface}`);
  assert.ok(start >= 0, `src/core.ts declares ${iface}`);
  const body = source.slice(start, source.indexOf("\n}\n", start)).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  return [...body.matchAll(/^\s+(\w+)\??:\s*\(([^)]*)\)/gm)].filter(([, , params]) => /\bStepContext\b/.test(params!)).map(([, name]) => name!);
}

describe("a package's step runs every function behind its fence", () => {
  const fenced = fenceStep(step, FENCE);

  it("the fence wraps every function of a step that is handed the run's context", async () => {
    const core = await readFile(new URL("../core.ts", import.meta.url), "utf8");
    for (const iface of ["StepDef", "AnyStepDef"]) assert.deepEqual(contextFunctionsOf(core, iface).sort(), [...STEP_FUNCTIONS].sort(), `${iface}: a function that takes a StepContext is fenced (STEP_FUNCTIONS)`);
    assert.deepEqual(Object.keys(CALLS).sort(), [...STEP_FUNCTIONS].sort(), "and each is tested below");
  });

  for (const [fn, call] of Object.entries(CALLS)) {
    it(`${fn}: a secret the package does not declare is secret_fenced, one it declares reads`, async () => {
      await assert.rejects(call(fenced, { name: "GITHUB_TOKEN" }, ctxOf(box())), FENCED);
      await call(fenced, { name: "MAIL_TOKEN" }, ctxOf(box()));
      // The step itself is unchanged: strut's own use of it is not fenced.
      assert.equal(await call(step, { name: "GITHUB_TOKEN" }, ctxOf(box())).then(() => "read"), "read");
    });
  }

  it("describe and answerGated read the person's own value, through `get` or `own`, only for a name the package has", async () => {
    const actors = actorSecretStore(new MemorySecretStore());
    await actors.set("ada", "GOOGLE_TOKEN", "ada-google");
    await actors.set("ada", "MAIL_TOKEN", "ada-mail");
    const ada = secretsCapability(new MemorySecretStore(), { actors }).forPrincipal!("ada");
    const ctx = ctxOf(ada, { actor: "ada", principal: "ada" });
    const own = defineStep({
      type: TYPE,
      input: z.object({ name: z.string(), scope: z.enum(["get", "own"]) }),
      output: z.any(),
      async run() {},
      async describe(cfg, c) {
        const s = (c.services as { secrets: SecretsCapability }).secrets;
        return { title: String(cfg.scope === "own" ? await s.own!.get(cfg.name) : await s.get(cfg.name)) };
      },
      async answerGated(cfg, c) {
        const s = (c.services as { secrets: SecretsCapability }).secrets;
        return cfg.scope === "own" ? s.own!.get(cfg.name) : s.get(cfg.name);
      },
    }) as AnyStepDef;
    const f = fenceStep(own, FENCE);
    for (const call of [async (cfg: unknown) => (await f.describe!(cfg, ctx))?.title, (cfg: unknown) => f.answerGated!(cfg, ctx)]) {
      assert.equal(await call({ name: "MAIL_TOKEN", scope: "get" }), "ada-mail");
      assert.equal(await call({ name: "MAIL_TOKEN", scope: "own" }), "ada-mail");
      await assert.rejects(call({ name: "GOOGLE_TOKEN", scope: "get" }), /secret_fenced: acme\/mail\/send came from the package acme\/mail, which declares only MAIL_TOKEN — it may not read GOOGLE_TOKEN/);
      await assert.rejects(call({ name: "GOOGLE_TOKEN", scope: "own" }), /secret_fenced: acme\/mail\/send came from the package acme\/mail, which provides only MAIL_TOKEN — it may not read the person's own GOOGLE_TOKEN/);
    }
  });

  it("a card whose describe is refused proposes nothing: the call fails with the refusal", async () => {
    const proposed: unknown[] = [];
    const proposals = { propose: async (p: unknown) => (proposed.push(p), { id: "p1", status: "pending", step: TYPE, title: "x" }) } as unknown as ProposalsCapability;
    const ctx = { ...ctxOf(box()), agentTool: true, services: { secrets: box(), proposals } } as unknown as StepContext;
    await assert.rejects(proposeCall(TYPE, fenced, { name: "GITHUB_TOKEN" }, undefined, ctx), FENCED);
    assert.equal(proposed.length, 0);
    // One it may read is described and proposed as ever.
    await proposeCall(TYPE, fenced, { name: "MAIL_TOKEN" }, undefined, ctx);
    assert.equal((proposed[0] as { title: string }).title, "Send with box-mail");
  });
});

describe("the registry hands out a package's step fenced, and strut's own as they are", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-fence-"));
    await ensureEsmScope(dir);
    await mkdir(join(dir, "acme", "mail"), { recursive: true });
    await writeFile(
      join(dir, "acme", "mail", "send.ts"),
      `import { z, defineStep } from "strut";
const read = (cfg, ctx) => ctx.services.secrets.get(cfg.name);
export default defineStep({
  type: "acme/mail/send",
  input: z.object({ name: z.string() }),
  output: z.any(),
  run: read,
  async describe(cfg, ctx) { return { title: "Send with " + (await read(cfg, ctx)) }; },
  answerGated: read,
});
`,
    );
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("a package's step: describe and answerGated are fenced as run is", async () => {
    const { registry } = await buildRegistry(dir, { fences: { [TYPE]: FENCE } });
    const def = registry[TYPE]!;
    await assert.rejects(def.describe!({ name: "GITHUB_TOKEN" }, ctxOf(box())), FENCED);
    await assert.rejects(def.answerGated!({ name: "GITHUB_TOKEN" }, ctxOf(box())), FENCED);
    assert.equal((await def.describe!({ name: "MAIL_TOKEN" }, ctxOf(box())))?.title, "Send with box-mail");
  });

  it("strut's own steps that answer a gated call are never wrapped, even named in a fence", async () => {
    const own = ["graph/edit-node", "knowledge/add-page", "knowledge/edit-page"];
    const plain = (await buildRegistry(dir)).registry;
    const { registry, sources } = await buildRegistry(dir, { fences: Object.fromEntries([TYPE, ...own].map((t) => [t, FENCE])) });
    for (const t of own) {
      assert.equal(sources[t], "lib");
      assert.ok(registry[t]!.answerGated, `${t} answers a gated call`);
      assert.equal(registry[t], plain[t], `${t} is handed out as it is`);
    }
    // add-page's answer reads the run's own services, as before: a page from git is refused.
    const conceptSources = { fromGit: async (names: string[]) => new Map(names.map((n) => [n, { name: n, set: "strut:", file: "concepts/Style.md" }])), fromGitByRef: async () => null };
    const answer = (await registry["knowledge/add-page"]!.answerGated!(
      { source_ref_id: "root", edge_type: "PARENT_OF", target_type: "Concept", target_data: { name: "Style" } },
      { runId: "r0", path: "a", services: { conceptSources } } as unknown as StepContext,
    )) as { status?: string; page?: string };
    assert.deepEqual([answer.status, answer.page], ["refused", "Style"]);
  });
});
