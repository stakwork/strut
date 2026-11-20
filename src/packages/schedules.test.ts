/**
 * Schedules a package ships (`schedules:` in strut.yaml; stadeum
 * plans/software.md §5, item 3). `readPackage` resolves each over the
 * package's OWN workflows and the automations' trigger grammar, and refuses
 * anything else (src/packages/format.ts). createStrut makes them ordinary
 * automations at boot and after every package write
 * (src/packages/schedules.ts, `syncPackageSchedules` in src/scheduler.ts):
 * an install makes one, a release follows it, an uninstall drops it, and a
 * restart, reinstall or restore leaves exactly one. When it runs, its name
 * and its input are the package's; on or off is the admin's, and a release
 * keeps it. It runs as its workflow's owner, or launches nothing.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { packageAutomationId } from "../automations.js";
import { createStrut, type Strut } from "../createStrut.js";
import { createAutomations, type AutomationView } from "../scheduler.js";
import { MemoryRunStore } from "../store.js";
import { WorkspaceManager } from "../workspace.js";
import { derivePackageDetail } from "./detail.js";
import { readPackage } from "./format.js";

const KEY = "schedules-api-key";
const auth = { authorization: `Bearer ${KEY}` };
const PKG = "acme/code";
const CHECK = `${PKG}/check`;
const INGEST = `${PKG}/ingest`;
const CHECK_ID = packageAutomationId(PKG, "check");

/** A step that says whom its run acts as and which secrets it finds — what a
 *  scheduled run's principal and secrets are. */
const REPORT = `import { z, defineStep } from "strut";
export default defineStep({
  type: "${PKG}/report",
  input: z.object({ repo: z.string() }),
  output: z.any(),
  async run(cfg, ctx) {
    const s = ctx.services.secrets;
    return { repo: cfg.repo, principal: ctx.principal ?? null, token: (await s.get("ACME_TOKEN")) ?? null, own: !!s.own, deployment: !!s.deployment };
  },
});
`;

/** The fixture package: two workflows, a step, and the `schedules:` given. */
const CODE = (schedules: string, version = "0.1.0"): Record<string, string> => ({
  "strut.yaml": `package: ${PKG}\nversion: ${version}\nrequires:\n  optional: [ACME_TOKEN]\nprovides:\n  secrets: [ACME_TOKEN]\n${schedules}`,
  "workflows/check.yaml": `name: ${CHECK}\nsteps:\n  - { id: report, type: ${PKG}/report, config: { repo: "{{ input.repo }}" } }\n`,
  "workflows/ingest.yaml": `name: ${INGEST}\nsteps:\n  - { id: say, type: log, config: { message: ingest } }\n`,
  "steps/report.ts": REPORT,
});
const EVERY_15 = "schedules:\n  - workflow: check\n    trigger: { every: interval, minutes: 15 }\n    input: { repo: hive }\n";

let root: string;
async function writeTree(files: Record<string, string>, name = crypto.randomUUID()): Promise<string> {
  const dir = join(root, "src", name);
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

const saved: Record<string, string | undefined> = {};
before(() => {
  for (const k of ["STRUT_API_KEY", "STRUT_SECRET_KEY", "STRUT_PACKAGE_INDEXES"]) saved[k] = process.env[k];
  process.env["STRUT_API_KEY"] = KEY;
  process.env["STRUT_SECRET_KEY"] = "schedules-secret";
  process.env["STRUT_PACKAGE_INDEXES"] = "[]";
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "strut-schedules-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("strut.yaml's schedules: key (readPackage)", () => {
  it("resolves each over the package's own workflows: its name the workflow's unless given, the input {} unless given", async () => {
    const info = await readPackage(
      await writeTree(
        CODE(`${EVERY_15}  - workflow: ingest\n    name: nightly\n    trigger: { every: day, at: ["03:00"], tz: UTC }\n`),
      ),
    );
    assert.deepEqual(info.schedules, [
      { name: "check", workflow: CHECK, trigger: { type: "schedule", every: "interval", minutes: 15 }, input: { repo: "hive" } },
      { name: "nightly", workflow: INGEST, trigger: { type: "schedule", every: "day", at: ["03:00"], tz: "UTC" }, input: {} },
    ]);
  });

  it("the store's detail says when each workflow runs on its own, in the zone it names, else none", async () => {
    const dir = await writeTree(CODE(`${EVERY_15}  - workflow: ingest\n    trigger: { every: day, at: ["03:00"], tz: UTC }\n  - workflow: ingest\n    name: weekly\n    trigger: { every: week, on: [mon], at: ["09:00"] }\n`));
    const d = await derivePackageDetail({ ...(await readPackage(dir)), dir });
    assert.deepEqual(d.workflows.map((w) => [w.name, w.schedules]), [
      ["check", ["Every 15 minutes"]],
      ["ingest", ["Every day at 3:00 AM (UTC)", "Mon at 9:00 AM"]],
    ]);
  });

  it("an older-shaped manifest, with no schedules, still loads", async () => {
    const info = await readPackage(await writeTree(CODE("")));
    assert.equal(info.schedules, undefined);
    assert.equal(info.manifest.package, PKG);
  });

  it("refuses a workflow the package does not carry, a trigger strut does not know, a once, a key no shape has, two of one name and a template outside now/today/last", async () => {
    const refused = async (schedules: string, pattern: RegExp) => {
      await assert.rejects(readPackage(await writeTree(CODE(schedules))), pattern);
    };
    const one = (entry: string) => `schedules:\n  - ${entry}\n`;
    // Only its own workflows, by their names inside the package.
    await refused(one("{ workflow: job, trigger: { every: day, at: ['03:00'] } }"), /^Error: bad_package: strut\.yaml: schedules\[0\]\.workflow: "job" is not a workflow of the package/);
    await refused(one("{ workflow: acme/linear/sync, trigger: { every: day, at: ['03:00'] } }"), /schedules\[0\]\.workflow: "acme\/linear\/sync" is not a workflow of the package/);
    await refused(one("{ workflow: acme/code/check, trigger: { every: day, at: ['03:00'] } }"), /schedules\[0\]\.workflow: "acme\/code\/check" is not a workflow/);
    // The automations' grammar, strict.
    await refused(one("{ workflow: check, trigger: { every: fortnight } }"), /schedules\[0\]\.trigger\.every: Invalid discriminator value/);
    await refused(one("{ workflow: check, trigger: { every: interval } }"), /schedules\[0\]\.trigger\.minutes: Invalid input/);
    await refused(one("{ workflow: check, trigger: '*/15 * * * *' }"), /schedules\[0\]\.trigger: Invalid input: expected object/);
    await refused(one("{ workflow: check, trigger: { every: interval, minutes: 15, betwen: ['09:00', '17:00'] } }"), /schedules\[0\]\.trigger: Unrecognized key: "betwen"/);
    await refused(one("{ workflow: check, trigger: { every: once, at: '2027-01-01T09:00' } }"), /schedules\[0\]\.trigger\.every: a package's schedule recurs/);
    await refused(one("{ workflow: check, trigger: { every: day, at: ['03:00'] }, enabled: false }"), /schedules\[0\]: Unrecognized key: "enabled"/);
    await refused(one("{ workflow: check }"), /schedules\[0\]\.trigger: Invalid input: expected object, received undefined/);
    await refused(`${EVERY_15}  - { workflow: check, trigger: { every: day, at: ['03:00'] } }\n`, /schedules\[1\]\.name: two schedules are named "check"/);
    await refused(one("{ workflow: check, trigger: { every: day, at: ['03:00'] }, input: { repo: '{{ input.repo }}' } }"), /schedules\[0\]\.input: \{\{ input\.repo \}\} reads "input"/);
    // The strict manifest is what makes an older strut refuse the key: one it does not know.
    await refused("cron: '*/15 * * * *'\n", /strut\.yaml: Unrecognized key: "cron"/);
  });
});

describe("a package's schedules are automations, made and kept by the packages' sync", () => {
  let ws: WorkspaceManager;
  let store: MemoryRunStore;
  let strut: Strut;
  const boot = () =>
    createStrut({
      workspace: ws,
      store,
      dataDir: join(root, "data"),
      serveUi: false,
      scheduler: false,
      enableChat: false,
      systemWorkflows: false,
      browserWorkflows: false,
      privacyWorkflows: false,
      mediaWorkflows: false,
      orchestrator: false,
      builder: false,
      views: false,
      concepts: false,
      stt: false,
      subscriptionPoll: false,
    });
  beforeEach(async () => {
    ws = new WorkspaceManager(join(root, "box"));
    store = new MemoryRunStore();
    strut = await boot();
  });
  afterEach(async () => {
    await strut.close();
  });

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await strut.app.request(path, { method, headers: { ...auth, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: (await res.json()) as any };
  };
  const automations = async (): Promise<AutomationView[]> => (await call("GET", "/automations")).json.automations;
  /** Through a person's door, as `actor` — who then owns the new workflows. */
  const install = async (files: Record<string, string>, opts: { actor?: string; door?: "distro" } = {}) => strut.packages.install(`file:${await writeTree(files)}`, opts);
  const finished = async (workflow: string, runId: string) => {
    for (let i = 0; i < 400; i++) {
      const s = await store.getRunSummary(workflow, runId);
      if (s) return s;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`run ${runId} never finished`);
  };

  it("an install makes the schedule, marked the package's; a fire runs the package's workflow with the manifest's input, as the workflow's owner", async () => {
    await install(CODE(EVERY_15), { actor: "alice" });
    const [a, ...rest] = await automations();
    assert.equal(rest.length, 0);
    assert.deepEqual(
      [a!.id, a!.workflow, a!.package, a!.name, a!.enabled, a!.input, a!.trigger.every],
      [CHECK_ID, CHECK, PKG, "check", true, { repo: "hive" }, "interval"],
    );
    assert.match(a!.summary, /^Every 15 minutes/);
    assert.ok(a!.nextRunAt, "on, and due");

    // The owner's own value wins over the deployment's, as for any run of theirs.
    assert.equal((await call("PUT", "/secrets/ACME_TOKEN", { value: "deployment" })).status, 200);
    assert.equal((await call("PUT", "/actors/alice/secrets/ACME_TOKEN", { value: "alice" })).status, 200);
    const fired = await call("POST", `/workflows/${encodeURIComponent(CHECK)}/automations/${CHECK_ID}/fire`);
    assert.equal(fired.status, 202, JSON.stringify(fired.json));
    const s = await finished(CHECK, fired.json.runId);
    assert.equal(s.status, "success", s.error);
    assert.deepEqual(s.output, { repo: "hive", principal: "alice", token: "alice", own: true, deployment: false });
    const start = (await store.getRunEvents(CHECK, fired.json.runId)).find((e) => e.type === "run.start")!;
    assert.deepEqual([start.origin, start.automation, start.principal, start.actor, start.input], ["schedule", { id: CHECK_ID }, "alice", undefined, { repo: "hive" }]);
  });

  it("with nobody behind the install the schedule is made, and a fire launches nothing and says why, until the workflow has an owner", async () => {
    const res = await strut.app.request("/packages/install", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ ref: `file:${await writeTree(CODE(EVERY_15))}` }) });
    assert.equal(res.status, 201, await res.text());
    assert.equal((await ws.getWorkflowMetadata(CHECK))!.owner, undefined);
    assert.equal((await call("PUT", "/secrets/ACME_TOKEN", { value: "deployment" })).status, 200);

    const refused = await call("POST", `/workflows/${encodeURIComponent(CHECK)}/automations/${CHECK_ID}/fire`);
    assert.equal(refused.status, 400);
    assert.match(refused.json.error, /^nobody to run as: "check" is the package acme\/code's schedule, which runs as a person .* "acme\/code\/check" has no owner/);
    assert.deepEqual(await store.listRuns(CHECK), [], "nothing launched, so nothing read the deployment's value");
    assert.match((await automations())[0]!.lastFireError!, /^nobody to run as/);

    await ws.setWorkflowOwner(CHECK, "bob");
    const fired = await call("POST", `/workflows/${encodeURIComponent(CHECK)}/automations/${CHECK_ID}/fire`);
    assert.equal(fired.status, 202);
    assert.deepEqual((await finished(CHECK, fired.json.runId)).output, { repo: "hive", principal: "bob", token: "deployment", own: true, deployment: false });
  });

  it("an uninstall drops it, and so does one that keeps the workflow as a fork; an automation of the admin's own stays", async () => {
    await install(CODE(EVERY_15), { actor: "alice" });
    await strut.packages.uninstall(PKG);
    assert.deepEqual(await automations(), []);
    assert.equal(await ws.getWorkflowMetadata(CHECK), null);

    await install(CODE(EVERY_15), { actor: "alice" });
    await ws.publishWorkflow(CHECK, "mine", { name: CHECK, steps: [{ id: "say", type: "log", config: { message: "mine" } }] } as never);
    const own = await call("POST", `/workflows/${encodeURIComponent(CHECK)}/automations`, { name: "Mine", trigger: { every: "day", at: ["09:00"] } });
    assert.equal(own.status, 201, JSON.stringify(own.json));
    assert.deepEqual((await automations()).map((a) => a.name).sort(), ["Mine", "check"]);

    const out = await strut.packages.uninstall(PKG);
    assert.deepEqual(out.kept.map((k) => k.name), [CHECK], "the fork is the admin's");
    assert.deepEqual((await automations()).map((a) => [a.name, a.package]), [["Mine", undefined]], "the package's schedule went with it");
  });

  it("a reinstall, a restart and a restored duplicate leave exactly one, paused as the admin left it", async () => {
    await install(CODE(EVERY_15), { actor: "alice" });
    assert.equal((await call("PATCH", `/workflows/${encodeURIComponent(CHECK)}/automations/${CHECK_ID}`, { enabled: false })).status, 200);
    const anchor = ((await automations())[0]!.trigger as { anchor: string }).anchor;

    const again = await install(CODE(EVERY_15), { actor: "alice" });
    assert.equal(again.packages[0]!.status, "present");
    const one = async () => {
      const list = await automations();
      assert.deepEqual(list.map((a) => [a.id, a.enabled, (a.trigger as { anchor: string }).anchor]), [[CHECK_ID, false, anchor]]);
    };
    await one();

    await strut.close();
    strut = await boot();
    await one();

    // A backup restored over a box that had made it again: the same id twice.
    const [a] = (await ws.getWorkflowMetadata(CHECK))!.automations!;
    await ws.setWorkflowAutomations(CHECK, [a!, { ...a!, enabled: true }]);
    await strut.close();
    strut = await boot();
    await one();
  });

  it("a release that changes it is followed and one that drops it removes it; the admin's pause stays through both", async () => {
    await install(CODE(EVERY_15), { actor: "alice", door: "distro" });
    assert.equal((await call("PATCH", `/workflows/${encodeURIComponent(CHECK)}/automations/${CHECK_ID}`, { enabled: false })).status, 200);
    const anchor = ((await automations())[0]!.trigger as { anchor: string }).anchor;

    const v2 = "schedules:\n  - workflow: check\n    trigger: { every: interval, minutes: 30 }\n    input: { repo: mcp }\n  - workflow: ingest\n    trigger: { every: day, at: ['03:00'], tz: UTC }\n";
    assert.equal((await install(CODE(v2, "0.2.0"), { actor: "alice", door: "distro" })).packages[0]!.status, "updated");
    const byName = new Map((await automations()).map((a) => [a.name, a]));
    const check = byName.get("check")!;
    assert.deepEqual(
      [check.id, check.enabled, (check.trigger as { minutes: number }).minutes, (check.trigger as { anchor: string }).anchor, check.input],
      [CHECK_ID, false, 30, anchor, { repo: "mcp" }],
      "followed, still paused, on the same rhythm",
    );
    const ingest = byName.get("ingest")!;
    assert.deepEqual([ingest.id, ingest.workflow, ingest.enabled, ingest.summary], [packageAutomationId(PKG, "ingest"), INGEST, true, "Every day at 3:00 AM (UTC)"]);

    const v3 = "schedules:\n  - workflow: ingest\n    trigger: { every: day, at: ['03:00'], tz: UTC }\n";
    await install(CODE(v3, "0.3.0"), { actor: "alice", door: "distro" });
    assert.deepEqual((await automations()).map((a) => a.name), ["ingest"], "check's schedule is dropped; the workflow stays");
    assert.ok(await ws.getWorkflowMetadata(CHECK));

    await install(CODE("", "0.4.0"), { actor: "alice", door: "distro" });
    assert.deepEqual(await automations(), []);
  });

  it("an admin pauses or resumes it and nothing else: an edit or a delete is refused, by either door", async () => {
    await install(CODE(EVERY_15), { actor: "alice" });
    const path = `/workflows/${encodeURIComponent(CHECK)}/automations/${CHECK_ID}`;
    const owns = /^"check" is the package acme\/code's schedule: when it runs, its name and its input follow the package's releases/;
    for (const patch of [{ trigger: { every: "interval", minutes: 5 } }, { name: "Often" }, { input: { repo: "other" } }, { callback: { url: "https://example.com/hook" } }]) {
      const r = await call("PATCH", path, patch);
      assert.equal(r.status, 400, JSON.stringify(patch));
      assert.match(r.json.error, owns);
    }
    // Saying what it is already changes nothing, so it is not refused.
    assert.equal((await call("PATCH", path, { name: "check", enabled: false, trigger: { every: "interval", minutes: 15 } })).status, 200);
    assert.equal((await automations())[0]!.enabled, false);
    assert.equal((await call("PATCH", path, { enabled: true })).status, 200);

    const del = await call("DELETE", path);
    assert.equal(del.status, 400);
    assert.match(del.json.error, /is the package acme\/code's schedule, made again at each release: pause it, or uninstall the package/);
    // The chat tools' and the automation/* steps' door is the same layer.
    assert.match(String((await strut.automations.update(CHECK, CHECK_ID, { trigger: { every: "day", at: ["09:00"] } }) as { error: string }).error), owns);
    assert.match(String((await strut.automations.remove(CHECK, CHECK_ID) as { error: string }).error), /made again at each release/);
    assert.equal((await automations()).length, 1);
  });
});

describe("the tick fires a package's schedule", () => {
  it("at its time, with the manifest's input, as its workflow's owner — and with no owner launches nothing", async () => {
    const ws = new WorkspaceManager(join(root, "box"));
    const store = new MemoryRunStore();
    let now = new Date("2026-11-20T12:00:00Z");
    const launched: Array<{ workflow: string; input: unknown; id: string; principal?: string }> = [];
    const autos = createAutomations({
      workspace: ws,
      store,
      now: () => now,
      launch: (flow, input, automation, _callback, principal) => {
        launched.push({ workflow: flow.name, input, id: automation.id, ...(principal ? { principal } : {}) });
        return `r${launched.length}`;
      },
      isInFlight: () => false,
    });
    await ws.publishWorkflow(CHECK, "v1", { name: CHECK, steps: [{ id: "say", type: "log", config: { message: "hi" } }] } as never);
    const sync = await autos.syncPackageSchedules([{ package: PKG, name: "check", workflow: CHECK, trigger: { type: "schedule", every: "interval", minutes: 15 }, input: { repo: "hive", at: "{{ now }}" } }]);
    assert.deepEqual(sync, { made: [`${CHECK}: check`], changed: [], dropped: [], warnings: [] });
    assert.deepEqual(await autos.syncPackageSchedules([{ package: PKG, name: "check", workflow: CHECK, trigger: { type: "schedule", every: "interval", minutes: 15 }, input: { repo: "hive", at: "{{ now }}" } }]), { made: [], changed: [], dropped: [], warnings: [] }, "a second sync changes nothing");

    now = new Date("2026-11-20T12:15:00Z");
    await autos.tick();
    assert.deepEqual(launched, [], "no owner: nothing launched");
    assert.match((await autos.list(CHECK))[0]!.lastFireError!, /^nobody to run as/);

    await ws.setWorkflowOwner(CHECK, "alice");
    now = new Date("2026-11-20T12:30:00Z");
    await autos.tick();
    assert.deepEqual(launched, [{ workflow: CHECK, input: { repo: "hive", at: "2026-11-20T12:30:00.000Z" }, id: CHECK_ID, principal: "alice" }]);

    // A workflow the box does not have is said, not made.
    const missing = await autos.syncPackageSchedules([{ package: PKG, name: "gone", workflow: `${PKG}/gone`, trigger: { type: "schedule", every: "day", at: ["03:00"] }, input: {} }]);
    assert.deepEqual(missing.warnings, [`${PKG}'s schedule "gone" is not made: its workflow ${PKG}/gone is not here`]);
    assert.deepEqual(missing.dropped, [`${CHECK}: check`], "and what is no longer shipped goes");
  });
});
