import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createStrut, type Strut } from "./createStrut.js";
import { createRegistry } from "./steps/registry.js";
import type { RunEvent, StepRegistry } from "./core.js";
import { MemoryRunStore } from "./store.js";
import { MemorySecretStore, secretBlanks } from "./secret-store.js";
import { WorkspaceManager } from "./workspace.js";
import { appIdentity } from "./auth.js";
import { kitForTests } from "./test-util/app-kit.js";
import { STEP_RUN_TOOL, buildAppTools } from "./apps/tools.js";
import { JOB_TOOLS, builderRules } from "./ai/prompts.js";
import addStep from "./steps/lib/secret/add.js";

/**
 * A secret from Jamie (plans/member-rights.md "Adding a secret"): a person
 * fills a blank — a name with no value in the store or the environment —
 * from strut's own app, never overwrites one, and the value is in no run,
 * event or answer.
 */

describe("secretBlanks: fill a blank, never overwrite", () => {
  it("stores a new name and answers with the name alone", async () => {
    const store = new MemorySecretStore();
    const blanks = secretBlanks(store, () => ({}));
    assert.deepEqual(await blanks.fill("ACME_TOKEN", "s3cret"), { name: "ACME_TOKEN" });
    assert.equal(await store.get("ACME_TOKEN"), "s3cret");
  });

  it("refuses a name the store or the environment has, and names no value", async () => {
    const store = new MemorySecretStore();
    await store.set("GITHUB_TOKEN", "the-team's");
    const blanks = secretBlanks(store, () => ({ ANTHROPIC_API_KEY: "from-env", EMPTY_ONE: "" }));
    for (const name of ["GITHUB_TOKEN", "ANTHROPIC_API_KEY"]) {
      await assert.rejects(blanks.fill(name, "mine"), (err: Error) => {
        assert.match(err.message, new RegExp(`^secret_set: ${name} already has a value here`));
        assert.ok(!err.message.includes("mine") && !err.message.includes("the-team's") && !err.message.includes("from-env"));
        return true;
      });
    }
    assert.equal(await store.get("GITHUB_TOKEN"), "the-team's");
    // An empty variable in the environment is a blank.
    assert.deepEqual(await blanks.fill("EMPTY_ONE", "v"), { name: "EMPTY_ONE" });
  });

  it("refuses a bad name and an empty value", async () => {
    const blanks = secretBlanks(new MemorySecretStore(), () => ({}));
    for (const name of ["", "1ABC", "A-B", "A B", "a/b"]) await assert.rejects(blanks.fill(name, "v"), /^Error: secret_name:/);
    await assert.rejects(blanks.fill("OK_NAME", "   "), /^Error: secret_empty:/);
  });

  it("one fill at a time: two at once never both find the name blank", async () => {
    const store = new MemorySecretStore();
    const blanks = secretBlanks(store, () => ({}));
    const results = await Promise.allSettled([blanks.fill("RACE", "a"), blanks.fill("RACE", "b")]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
    assert.equal(await store.get("RACE"), "a");
  });
});

describe("secret/add refuses anything but strut's own app's call", () => {
  const services = { secretBlanks: { fill: async (name: string) => ({ name }) } };
  const fp = { name: "strut/jamie", version: "v1", firstParty: true as const };
  const cfg = { name: "ACME_TOKEN", value: "v" };
  it("an agent's tool call, a model-written page, no person — and no store of strut's", async () => {
    await assert.rejects(() => addStep.run(cfg, { app: fp, actor: "alice", workflow: "builder", services } as never), /a person's/);
    await assert.rejects(() => addStep.run(cfg, { app: { name: "plain", version: "v1" }, actor: "alice", workflow: "__run_step__", services } as never), /a person's/);
    await assert.rejects(() => addStep.run(cfg, { app: fp, workflow: "__run_step__", services } as never), /a person's/);
    await assert.rejects(() => addStep.run(cfg, { actor: "alice", workflow: "__run_step__", services } as never), /a person's/);
    await assert.rejects(() => addStep.run(cfg, { app: fp, actor: "alice", workflow: "__run_step__", services: {} } as never), /secretBlanks/);
    assert.deepEqual(await addStep.run(cfg, { app: fp, actor: "alice", workflow: "__run_step__", services } as never), { name: "ACME_TOKEN" });
  });
});

describe("the builder names the secret it needs in ask.secret", () => {
  it("its rules say how, and never to ask for a value", () => {
    const rules = builderRules(JOB_TOOLS);
    assert.match(rules, /`ask\.secret` \(the NAME alone\)/);
    assert.match(rules, /\[secret\] NAME stored/);
    assert.ok(!rules.includes("under Secrets"), "the job never sends a person to the console");
  });
});

describe("a secret from strut's own app, through a whole strut", () => {
  const KEY = "secret-add-key";
  const VALUE = "sk-live-SENTINEL-7f3a91c2e8";
  const saved: Record<string, string | undefined> = {};
  let root = "";
  let strut: Strut;
  let registry: StepRegistry;
  let sink: http.Server;
  const store = new MemoryRunStore();
  const secretStore = new MemorySecretStore();
  const events: RunEvent[] = [];
  const posted: string[] = [];

  const writeApp = async (dir: string, steps: string[]) => {
    const files = {
      "app.yaml": ["title: Assistant", "grants:", "  workflows: []", `  steps: [${steps.join(", ")}]`, ""].join("\n"),
      "src/App.tsx": "export default function App() { return <p>hi</p>; }\n",
    };
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(join(dir, dirname(rel)), { recursive: true });
      await writeFile(join(dir, rel), text, "utf8");
    }
    return dir;
  };
  /** A page's `step_run`, as `actor`. */
  const page = (name: string, actor?: string) => {
    const tools = buildAppTools({ apps: strut.apps, registry, services: strut.services, ...(actor ? { actor } : {}), runStepDeps: { store, workspace: strut.workspace } });
    return async (type: string, config: Record<string, unknown>) =>
      (await (tools[STEP_RUN_TOOL] as any).execute({ type, config, app: appIdentity(name, "v1") }, { toolCallId: "t", messages: [] })) as { error?: string; result?: any };
  };

  before(async () => {
    for (const k of ["STRUT_API_KEY", "PRESET_FROM_ENV"]) saved[k] = process.env[k];
    process.env["STRUT_API_KEY"] = KEY;
    process.env["PRESET_FROM_ENV"] = "set-by-the-box";
    root = await mkdtemp(join(tmpdir(), "strut-secret-add-"));
    sink = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        posted.push(raw);
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
    registry = await createRegistry([]);
    strut = await createStrut({
      workspace: new WorkspaceManager(join(root, "ws")),
      store,
      secretStore,
      registry,
      kit: await kitForTests(),
      services: { onRunEvent: (_wf: string, e: RunEvent) => void events.push(e) },
      eventsSink: { url: `http://127.0.0.1:${(sink.address() as any).port}/events` },
      serveUi: false,
      enableChat: false,
      scheduler: false,
      job: false,
      builder: false,
      orchestrator: false,
      autoResume: false,
      browserWorkflows: false,
      privacyWorkflows: false, mediaWorkflows: false,
      jamie: false,
    });
    // strut's own app, as the seed publishes it, granted secret/add as Jamie is.
    assert.ok((await strut.apps.publish(await writeApp(join(root, "apps", "jamie"), ["secret/add"]), "strut/jamie", { surface: "person", source: "seed" })).ok);
    // A model-written app a person granted it anyway, for contrast.
    assert.ok((await strut.apps.publish(await writeApp(join(root, "apps", "plain"), ["secret/add"]), "plain", { surface: "person" })).ok);
  });
  after(async () => {
    await strut?.close?.().catch(() => {});
    sink?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("stores a blank from Jamie's page and answers with the name; the value is in no run, event, sink post or answer", async () => {
    const call = page("strut/jamie", "ada-member");
    const added = await call("secret/add", { name: "ACME_TOKEN", value: VALUE });
    assert.equal(added.error, undefined, added.error);
    assert.deepEqual(added.result, { name: "ACME_TOKEN" });
    assert.equal(await secretStore.get("ACME_TOKEN"), VALUE);
    // Read back through the capability every step reads.
    assert.equal(await (strut.services as { secrets: { get(n: string): Promise<string | undefined> } }).secrets.get("ACME_TOKEN"), VALUE);

    // Overwrite: refused, from the store and from the environment; the value stays.
    const again = await call("secret/add", { name: "ACME_TOKEN", value: "another" });
    assert.match(again.error ?? "", /secret_set: ACME_TOKEN already has a value here/);
    assert.equal(await secretStore.get("ACME_TOKEN"), VALUE);
    const env = await call("secret/add", { name: "PRESET_FROM_ENV", value: VALUE });
    assert.match(env.error ?? "", /secret_set: PRESET_FROM_ENV/);
    assert.equal(await secretStore.get("PRESET_FROM_ENV"), undefined);

    // A model-written page, granted or not, adds nothing.
    const plain = await page("plain", "ada-member")("secret/add", { name: "PLAIN_TOKEN", value: VALUE });
    assert.match(plain.error ?? "", /a person's/);
    assert.equal(await secretStore.get("PLAIN_TOKEN"), undefined);

    // The value is nowhere: every event the runs emitted (the host's
    // listener sees them whole), what the events sink was sent, every run
    // the store holds, and every answer.
    const started = events.filter((e) => e.type === "step.start" && e.stepType === "secret/add");
    assert.equal(started.length, 4);
    for (const e of started) assert.equal((e.input as { value?: unknown }).value, "[redacted]");
    assert.equal((started[0]!.input as { name?: unknown }).name, "ACME_TOKEN", "the name is kept");
    await strut.close(); // flushes the sink
    const everywhere = [JSON.stringify(events), posted.join("\n"), JSON.stringify([added, again, env, plain])];
    for (const wf of ["__run_step__", "step:secret/add"]) {
      for (const id of await store.listRuns(wf)) everywhere.push(JSON.stringify(store.getEvents(wf, id)), JSON.stringify(store.getSummary(wf, id)));
    }
    assert.deepEqual(await store.listRuns("step:secret/add"), [], "never kept");
    assert.ok(posted.length > 0, "the sink was sent the runs");
    for (const text of everywhere) assert.ok(!text.includes(VALUE), "the value leaked");
  });
});
