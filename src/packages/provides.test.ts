/**
 * Secrets a package PROVIDES (`provides.secrets` in its `strut.yaml`) and an
 * admin's call from the package's own app — src/packages/format.ts,
 * src/packages/fence.ts, src/capabilities.ts (`own`, `deployment`,
 * `adminSecrets`) and the app door (src/apps/tools.ts `packageAdminOf`).
 *
 * A package's step reads the run's person's own value apart from the
 * deployment's and sets or deletes it; on a call from the package's own
 * `admin: true` app shown to an admin it reads, sets and deletes the
 * deployment's — for the names the package provides, and no other. A
 * member's call, a workflow run, a non-admin app and another package's
 * admin app get no deployment scope. The manifest stays strict.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { actorSecretStore } from "../actor-secrets.js";
import { adminSecrets, secretScopesOf, secretsCapability, type SecretsCapability } from "../capabilities.js";
import { STEP_RUN_TOOL, buildAppTools } from "../apps/tools.js";
import { appIdentity } from "../auth.js";
import type { RunEvent } from "../core.js";
import { createStrut, type Strut } from "../createStrut.js";
import { MemorySecretStore } from "../secret-store.js";
import { MemoryRunStore } from "../store.js";
import { kitForTests } from "../test-util/app-kit.js";
import { WorkspaceManager } from "../workspace.js";
import { readPackage } from "./format.js";
import type { InstallResult } from "./install.js";
import type { InstalledPackage } from "./installed.js";

/** One step that does what its config says to one scope: `merged` is the
 *  ordinary `secrets.get`; a scope the call does not have is an error. */
const MANAGE = (type: string) => `import { z, defineStep } from "strut";
export default defineStep({
  type: ${JSON.stringify(type)},
  redact: ["value"],
  input: z.object({ scope: z.enum(["merged", "own", "deployment"]), op: z.enum(["get", "set", "delete"]).default("get"), name: z.string(), value: z.string().optional() }),
  output: z.any(),
  async run(cfg, ctx) {
    const secrets = ctx.services.secrets;
    if (cfg.scope === "merged") return { value: (await secrets.get(cfg.name)) ?? null };
    const scope = secrets[cfg.scope];
    if (!scope) throw new Error("no " + cfg.scope + " scope on this call");
    if (cfg.op === "get") return { value: (await scope.get(cfg.name)) ?? null };
    if (cfg.op === "set") { await scope.set(cfg.name, cfg.value); return { set: cfg.name }; }
    return { deleted: await scope.delete(cfg.name) };
  },
});
`;
/** Does the step's bag still carry the blank-filler? */
const BLANKS = (type: string) => `import { z, defineStep } from "strut";
export default defineStep({ type: ${JSON.stringify(type)}, input: z.object({}), output: z.any(), async run(_cfg, ctx) { return { blanks: !!ctx.services.secretBlanks }; } });
`;
/** Re-binds its secrets to another person (`as`) and tries their own value
 *  — or, with `read`, the merged lookup as them. */
const REBIND = (type: string) => `import { z, defineStep } from "strut";
export default defineStep({
  type: ${JSON.stringify(type)},
  input: z.object({ as: z.string(), op: z.enum(["get", "set", "delete", "read"]), name: z.string() }),
  output: z.any(),
  async run(cfg, ctx) {
    const secrets = ctx.services.secrets;
    if (typeof secrets.forPrincipal !== "function") return { rebound: false };
    const other = secrets.forPrincipal(cfg.as);
    if (cfg.op === "read") return { rebound: true, value: (await other.get(cfg.name)) ?? null };
    if (!other.own) return { rebound: true, own: false };
    if (cfg.op === "set") { await other.own.set(cfg.name, "planted"); return { rebound: true, own: true }; }
    if (cfg.op === "delete") return { rebound: true, own: true, deleted: await other.own.delete(cfg.name) };
    return { rebound: true, own: true, value: (await other.own.get(cfg.name)) ?? null };
  },
});
`;
const APP = (title: string, admin: boolean, steps: string) => ({
  [`apps/${title.toLowerCase()}/app.yaml`]: [`title: ${title}`, ...(admin ? ["admin: true"] : []), "grants:", "  workflows: [acme/hooks/manage]", `  steps: [${steps}, run/launch, run/get]`, ""].join("\n"),
  [`apps/${title.toLowerCase()}/src/App.tsx`]: "export default function App() { return <p>hi</p>; }\n",
});

const MANIFEST = "package: acme/hooks\nversion: 0.1.0\nrequires:\n  optional: [HOOK_TOKEN, HOOK_SECRET, OTHER_KEY]\nprovides:\n  secrets: [HOOK_TOKEN, HOOK_SECRET]\n";
const HOOKS: Record<string, string> = {
  "strut.yaml": MANIFEST,
  "steps/manage.ts": MANAGE("acme/hooks/manage"),
  "steps/blanks.ts": BLANKS("acme/hooks/blanks"),
  "steps/rebind.ts": REBIND("acme/hooks/rebind"),
  "workflows/rebind.yaml":
    'name: acme/hooks/rebind\ninput:\n  as: { type: string }\n  op: { type: string }\n  name: { type: string }\nsteps:\n  - id: r\n    type: acme/hooks/rebind\n    config: { as: "{{ input.as }}", op: "{{ input.op }}", name: "{{ input.name }}" }\n',
  // A workflow that runs the other as a subflow: a nested run of the same person.
  "workflows/nested.yaml":
    'name: acme/hooks/nested\ninput:\n  name: { type: string }\nsteps:\n  - id: inner\n    type: subflow\n    config: { workflow: acme/hooks/manage, input: { scope: own, name: "{{ input.name }}" } }\n',
  "workflows/manage.yaml":
    'name: acme/hooks/manage\ninput:\n  scope: { type: string }\n  name: { type: string }\nsteps:\n  - id: m\n    type: acme/hooks/manage\n    config: { scope: "{{ input.scope }}", name: "{{ input.name }}" }\n',
  ...APP("Admin", true, "acme/hooks/manage, acme/hooks/blanks"),
  ...APP("People", false, "acme/hooks/manage, acme/hooks/rebind"),
};
/** Another package, whose admin app is granted acme/hooks' step. */
const OTHER: Record<string, string> = {
  "strut.yaml": "package: acme/other\nversion: 0.1.0\n",
  ...APP("Console", true, "acme/hooks/manage"),
};

describe("provides in strut.yaml", () => {
  let root = "";
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-provides-format-"));
  });
  after(() => rm(root, { recursive: true, force: true }));
  const read = async (manifest: string) => {
    const dir = await mkdtemp(join(root, "p-"));
    await mkdir(join(dir, "steps"));
    await writeFile(join(dir, "strut.yaml"), manifest);
    await writeFile(join(dir, "steps", "manage.ts"), MANAGE("acme/hooks/manage"));
    return readPackage(dir);
  };

  it("loads a manifest from before provides, and one that provides what it reads", async () => {
    const older = await read("package: acme/hooks\nversion: 0.1.0\nrequires:\n  optional: [HOOK_TOKEN]\n");
    assert.equal(older.manifest.provides, undefined);
    const now = await read(MANIFEST);
    assert.deepEqual(now.manifest.provides, { secrets: ["HOOK_TOKEN", "HOOK_SECRET"] });
  });

  it("refuses an unknown key under provides, and a provided secret its steps may not read", async () => {
    await assert.rejects(read(`${MANIFEST}  git:\n    - { host: example.com, secret: HOOK_TOKEN }\n`), /bad_package: strut\.yaml: provides: Unrecognized key/);
    await assert.rejects(
      read("package: acme/hooks\nversion: 0.1.0\nrequires:\n  secrets: [HOOK_TOKEN]\nprovides:\n  secrets: [HOOK_TOKEN, HOOK_SECRET]\n"),
      /bad_package: strut\.yaml: provides\.secrets: HOOK_SECRET is not in requires\.secrets or requires\.optional/,
    );
  });
});

describe("the scopes behind strut's own secrets capability", () => {
  const stores = () => {
    const deployment = new MemorySecretStore();
    const actors = actorSecretStore(new MemorySecretStore());
    return { deployment, actors, cap: secretsCapability(deployment, { envFallback: { FROM_ENV: "env-value" }, actors }) };
  };

  it("are on no object a step reads, and bind as the capability does", async () => {
    const { cap, actors } = stores();
    assert.equal(cap.own, undefined);
    assert.equal(cap.deployment, undefined);
    assert.deepEqual(Object.keys(cap.forPrincipal!("ada")).sort(), ["forPrincipal", "get"]);
    const base = secretScopesOf(cap)!;
    assert.ok(base.deployment && !base.own && !base.admin, "unbound: the deployment's, for no package");
    const bound = secretScopesOf(cap.forPrincipal!("ada"))!;
    await bound.own!.set("HOOK_TOKEN", "ada's");
    assert.equal(await actors.get("ada", "HOOK_TOKEN"), "ada's");
    assert.equal(secretScopesOf(adminSecrets(cap, "acme/hooks").forPrincipal!("ada"))?.admin, "acme/hooks", "binding to the viewer keeps an admin's call");
    assert.equal(secretScopesOf({ get: async () => undefined }), undefined, "a host's own capability has none");
  });

  it("read the deployment's as a run with no value of its own does, and hold names and values to the routes' rules", async () => {
    const { cap, deployment } = stores();
    const d = secretScopesOf(cap)!.deployment!;
    assert.equal(await d.get("FROM_ENV"), "env-value");
    assert.equal(await d.delete("FROM_ENV"), false, "the environment's is not the store's to delete");
    await d.set("HOOK_SECRET", "s3cret");
    assert.equal(await deployment.get("HOOK_SECRET"), "s3cret");
    await assert.rejects(d.set("HOOK_SECRET", ""), /^Error: secret_empty: no value for HOOK_SECRET/);
    await assert.rejects(d.get("not a name"), /^Error: secret_name:/);
    await assert.rejects(d.set("LIGHTNING_KEY", "x"), /^Error: secret_name: LIGHTNING_KEY is read by the server alone/);
  });
});

describe("a package's steps manage the secrets it provides", () => {
  const VALUE = "hook-SENTINEL-4b9e1d";
  const saved = process.env["STRUT_API_KEY"];
  let root = "";
  let strut: Strut;
  const store = new MemoryRunStore();
  const secretStore = new MemorySecretStore();
  const actorStore = new MemorySecretStore();
  const actors = actorSecretStore(actorStore);
  const events: RunEvent[] = [];

  /** A page's `step_run` on `app` as `actor`; `admin` when the connection holds full scope. */
  const page = (app: string, actor: string | undefined, admin: boolean) => {
    const tools = buildAppTools({ apps: strut.apps, registry: strut.getRegistry(), services: strut.services, ...(actor ? { actor } : {}), admin, runStepDeps: { store, workspace: strut.workspace } });
    return async (type: string, config: Record<string, unknown>) =>
      (await (tools[STEP_RUN_TOOL] as any).execute({ type, config, app: appIdentity(app, "v1") }, { toolCallId: "t", messages: [] })) as { error?: string; result?: any };
  };
  const manage = (app: string, actor: string | undefined, admin: boolean, config: Record<string, unknown>) => page(app, actor, admin)("acme/hooks/manage", config);
  const writeTree = async (files: Record<string, string>, name: string) => {
    const dir = join(root, "src", name);
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), text);
    }
    return dir;
  };
  const install = async (files: Record<string, string>, name: string) => {
    const res = await strut.app.request("/packages/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref: `file:${await writeTree(files, name)}` }) });
    const body = (await res.json()) as InstallResult & { error?: string };
    assert.equal(res.status, 201, body.error);
    return body;
  };

  before(async () => {
    delete process.env["STRUT_API_KEY"];
    root = await mkdtemp(join(tmpdir(), "strut-provides-"));
    strut = await createStrut({
      workspace: new WorkspaceManager(join(root, "ws")),
      store,
      secretStore,
      actorSecretStore: actorStore,
      kit: await kitForTests(),
      services: { onRunEvent: (_wf: string, e: RunEvent) => void events.push(e) },
      serveUi: false,
      enableChat: false,
      scheduler: false,
      job: false,
      builder: false,
      orchestrator: false,
      autoResume: false,
      systemWorkflows: false,
      browserWorkflows: false,
      privacyWorkflows: false,
      mediaWorkflows: false,
      views: false,
      concepts: false,
      stt: false,
      jamie: false,
      earnings: false,
      staff: false,
      worker: false,
    });
    await install(HOOKS, "hooks");
    await install(OTHER, "other");
  });
  after(async () => {
    await strut?.close?.().catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
    if (saved !== undefined) process.env["STRUT_API_KEY"] = saved;
  });

  it("says what it provides on GET /packages", async () => {
    const { packages } = (await (await strut.app.request("/packages")).json()) as { packages: InstalledPackage[] };
    const hooks = packages.find((p) => p.package === "acme/hooks")!;
    assert.deepEqual(hooks.provides, { secrets: ["HOOK_TOKEN", "HOOK_SECRET"] });
    assert.equal(packages.find((p) => p.package === "acme/other")!.provides, undefined);
  });

  it("reads the person's own value apart from the deployment's, and deletes it", async () => {
    // strut's lookup is unchanged (the person's, then the deployment's), so a
    // deployment value would stand in for hers in a merged read; `own` never.
    await secretStore.set("HOOK_TOKEN", "deployment's");
    const ada = (config: Record<string, unknown>) => manage("acme/hooks/people", "ada", false, config);
    assert.deepEqual((await ada({ scope: "merged", name: "HOOK_TOKEN" })).result, { value: "deployment's" });
    assert.deepEqual((await ada({ scope: "own", name: "HOOK_TOKEN" })).result, { value: null });
    await actors.set("ada", "HOOK_TOKEN", "ada's");
    assert.deepEqual((await ada({ scope: "own", name: "HOOK_TOKEN" })).result, { value: "ada's" });
    assert.deepEqual((await ada({ scope: "merged", name: "HOOK_TOKEN" })).result, { value: "ada's" });
    // Another person's own is theirs: bob has none.
    assert.deepEqual((await manage("acme/hooks/people", "bob", false, { scope: "own", name: "HOOK_TOKEN" })).result, { value: null });
    // Disconnect.
    assert.deepEqual((await ada({ scope: "own", op: "delete", name: "HOOK_TOKEN" })).result, { deleted: true });
    assert.equal(await actors.get("ada", "HOOK_TOKEN"), undefined);
    assert.deepEqual((await ada({ scope: "own", op: "delete", name: "HOOK_TOKEN" })).result, { deleted: false });
    assert.deepEqual((await ada({ scope: "own", name: "HOOK_TOKEN" })).result, { value: null });
    // She pastes a token of her own; with no person there is no `own`.
    assert.deepEqual((await ada({ scope: "own", op: "set", name: "HOOK_TOKEN", value: VALUE })).result, { set: "HOOK_TOKEN" });
    assert.equal(await actors.get("ada", "HOOK_TOKEN"), VALUE);
    assert.equal(await secretStore.get("HOOK_TOKEN"), "deployment's", "hers, not the deployment's");
    await secretStore.delete("HOOK_TOKEN");
    assert.match((await manage("acme/hooks/people", undefined, true, { scope: "own", name: "HOOK_TOKEN" })).error ?? "", /no own scope on this call/);
  });

  it("sets, reads and deletes the deployment's from an admin's call in the package's own admin app", async () => {
    // A webhook's signing secret: the deployment's and nobody's, made once.
    const admin = (config: Record<string, unknown>) => manage("acme/hooks/admin", "root", true, config);
    assert.deepEqual((await admin({ scope: "deployment", name: "HOOK_SECRET" })).result, { value: null });
    assert.deepEqual((await admin({ scope: "deployment", op: "set", name: "HOOK_SECRET", value: VALUE })).result, { set: "HOOK_SECRET" });
    assert.equal(await secretStore.get("HOOK_SECRET"), VALUE);
    assert.deepEqual((await admin({ scope: "deployment", name: "HOOK_SECRET" })).result, { value: VALUE });
    // The admin's own value and the deployment's stay apart.
    await actors.set("root", "HOOK_SECRET", "root's");
    assert.deepEqual((await admin({ scope: "deployment", name: "HOOK_SECRET" })).result, { value: VALUE });
    assert.deepEqual((await admin({ scope: "own", name: "HOOK_SECRET" })).result, { value: "root's" });
    // The deployment key with no person is an admin too.
    assert.deepEqual((await manage("acme/hooks/admin", undefined, true, { scope: "deployment", name: "HOOK_SECRET" })).result, { value: VALUE });
    assert.deepEqual((await admin({ scope: "deployment", op: "delete", name: "HOOK_SECRET" })).result, { deleted: true });
    assert.equal(await secretStore.get("HOOK_SECRET"), undefined);
    assert.equal(await actors.get("root", "HOOK_SECRET"), "root's", "deleting the deployment's leaves the admin's own");
  });

  it("never gives a member's call, a non-admin app or another package's admin app the deployment's", async () => {
    await secretStore.set("HOOK_SECRET", "kept");
    const refused = /no deployment scope on this call/;
    for (const op of ["get", "set", "delete"]) {
      const config = { scope: "deployment", op, name: "HOOK_SECRET", value: "member's" };
      // A member's session on the admin app (its files are refused to them; a call with a leaked token has no `admin`).
      assert.match((await manage("acme/hooks/admin", "ada", false, config)).error ?? "", refused);
      // An admin on the package's app that is not `admin: true`.
      assert.match((await manage("acme/hooks/people", "root", true, config)).error ?? "", refused);
      // An admin on another package's admin app, granted this package's step.
      assert.match((await manage("acme/other/console", "root", true, config)).error ?? "", refused);
    }
    assert.equal(await secretStore.get("HOOK_SECRET"), "kept");
    // And no package step fills a blank of the deployment's around its scopes.
    assert.deepEqual((await page("acme/hooks/admin", "ada", false)("acme/hooks/blanks", {})).result, { blanks: false });
  });

  it("never in a workflow run: one launched from the admin page, or run as a person", async () => {
    const call = page("acme/hooks/admin", "root", true);
    const launched = await call("run/launch", { workflow: "acme/hooks/manage", input: { scope: "deployment", name: "HOOK_SECRET" } });
    assert.equal(launched.error, undefined, launched.error);
    const run = await call("run/get", { workflow: "acme/hooks/manage", runId: launched.result.runId, wait: 10_000 });
    assert.equal(run.result.status, "error");
    assert.match(JSON.stringify(run.result), /no deployment scope on this call/);
    // It is the viewer's run: it has their own.
    await actors.set("root", "HOOK_TOKEN", "root's");
    const own = await call("run/launch", { workflow: "acme/hooks/manage", input: { scope: "own", name: "HOOK_TOKEN" } });
    const ownRun = await call("run/get", { workflow: "acme/hooks/manage", runId: own.result.runId, wait: 10_000 });
    assert.equal(ownRun.result.status, "success", JSON.stringify(ownRun.result));
    assert.match(JSON.stringify(ownRun.result), /root's/);
    // A run as a person has their own scope, and only that.
    await actors.set("ada", "HOOK_TOKEN", "ada's");
    assert.deepEqual((await strut.run("acme/hooks/manage", { scope: "own", name: "HOOK_TOKEN" }, { actor: "ada", principal: "ada" })).output, { value: "ada's" });
    assert.match((await strut.run("acme/hooks/manage", { scope: "deployment", name: "HOOK_SECRET" }, { actor: "ada", principal: "ada" })).error?.message ?? "", /no deployment scope/);
  });

  it("reaches no other person's own value by re-binding: in an app's call and in a workflow run", async () => {
    await actors.set("bob", "HOOK_TOKEN", "bob's");
    await actors.set("ada", "HOOK_TOKEN", "ada's");
    const asAda = {
      app: async (cfg: Record<string, unknown>) => {
        const out = await page("acme/hooks/people", "ada", false)("acme/hooks/rebind", cfg);
        assert.equal(out.error, undefined, out.error);
        return out.result;
      },
      run: async (cfg: Record<string, unknown>) => {
        const r = await strut.run("acme/hooks/rebind", cfg, { actor: "ada", principal: "ada" });
        assert.equal(r.status, "success", r.error?.message);
        return r.output;
      },
    };
    for (const [where, call] of Object.entries(asAda)) {
      for (const op of ["get", "set", "delete", "read"]) {
        const out = await call({ as: "bob", op, name: "HOOK_TOKEN" });
        // A package's step works for the run's person alone: it cannot re-bind.
        assert.deepEqual(out, { rebound: false }, `${where} ${op}`);
        assert.equal(await actors.get("bob", "HOOK_TOKEN"), "bob's", `${where} ${op}: bob's own is untouched`);
      }
    }
    assert.equal(await actors.get("ada", "HOOK_TOKEN"), "ada's");
    // A nested run of the same person still has her own.
    const nested = await strut.run("acme/hooks/nested", { name: "HOOK_TOKEN" }, { actor: "ada", principal: "ada" });
    assert.equal(nested.status, "success", nested.error?.message);
    assert.match(JSON.stringify(nested.output), /ada's/);
  });

  it("refuses a name the package does not provide, whatever the scope", async () => {
    await secretStore.set("OTHER_KEY", "readable");
    const admin = (config: Record<string, unknown>) => manage("acme/hooks/admin", "root", true, config);
    assert.deepEqual((await admin({ scope: "merged", name: "OTHER_KEY" })).result, { value: "readable" }, "it may read it");
    for (const [scope, op] of [["own", "get"], ["own", "set"], ["own", "delete"], ["deployment", "get"], ["deployment", "set"], ["deployment", "delete"]] as const) {
      const out = await admin({ scope, op, name: "OTHER_KEY", value: "x" });
      assert.match(out.error ?? "", /secret_fenced: acme\/hooks\/manage came from the package acme\/hooks, which provides only HOOK_TOKEN, HOOK_SECRET — it may not \w+ the (person's own|deployment's) OTHER_KEY/);
    }
    assert.equal(await secretStore.get("OTHER_KEY"), "readable");
  });

  it("keeps a value it set out of every event and answer", async () => {
    events.length = 0;
    const out = await manage("acme/hooks/admin", "root", true, { scope: "deployment", op: "set", name: "HOOK_SECRET", value: VALUE });
    assert.deepEqual(out.result, { set: "HOOK_SECRET" });
    const started = events.filter((e) => e.type === "step.start" && e.stepType === "acme/hooks/manage");
    assert.equal(started.length, 1);
    assert.equal((started[0]!.input as { value?: unknown }).value, "[redacted]");
    assert.ok(!JSON.stringify([events, out]).includes(VALUE));
  });

  it("leaves the values when the package is uninstalled: they are the people's and the deployment's", async () => {
    await secretStore.set("HOOK_SECRET", "signing");
    await actors.set("ada", "HOOK_TOKEN", "ada's");
    const res = await strut.app.request("/packages/acme/other", { method: "DELETE" });
    assert.equal(res.status, 200);
    assert.equal((await strut.app.request("/packages/acme/hooks", { method: "DELETE" })).status, 200);
    assert.equal(await secretStore.get("HOOK_SECRET"), "signing");
    assert.equal(await actors.get("ada", "HOOK_TOKEN"), "ada's");
  });
});

describe("adminSecrets on a capability with nothing to write", () => {
  it("is the capability as it is", () => {
    const cap: SecretsCapability = secretsCapability({ A: "1" });
    assert.equal(adminSecrets(cap, "acme/hooks"), cap);
  });
});
