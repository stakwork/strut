import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { itemLabel, roundItems, roundProblem } from "./round.js";
import { createStrut, type Strut } from "../createStrut.js";
import { flowFromYaml, WorkspaceManager } from "../workspace.js";
import { MemoryRunStore } from "../store.js";

/**
 * Round types (Workers' Send a round): a type saved with
 * `round: { workflow }` names the workflow whose run makes one task of it
 * for each item, and staff send a round of it — all its items, or the ones
 * they tick — with no need to ask the assistant.
 */

const ROUND = `name: shop-visits
input:
  shops:
    type: json
    default:
      - { name: Bean There, address: 412 Main St }
      - { name: Daily Grind, address: 88 Oak Ave }
      - { name: Harbor Coffee, address: 3 Pier Rd }
params:
  task: shop-visit
steps:
  - id: visits
    type: foreach
    config:
      items: "{{ input.shops }}"
      body:
        id: visit
        type: human
        config:
          task: "{{ params.task }}"
          show:
            ask: "Visit {{ $current.name }} at {{ $current.address }}"
`;

const OTHER = `name: other-visits
steps:
  - id: visit
    type: human
    config:
      task: something-else
      show: { ask: "Do something else" }
`;

const NONE = `name: no-people
steps:
  - id: say
    type: pack
    config: { hi: true }
`;

/** A workflow as the workspace reads one. */
const parse = (yaml: string) => flowFromYaml(/^name: (\S+)/.exec(yaml)![1]!, "v1", yaml);

describe("a round's workflow, read before any run", () => {
  it("makes tasks of a type through a human step at any depth, its task resolved from params; any other names what it asks for", () => {
    const round = parse(ROUND);
    assert.equal(roundProblem(round, "shop-visit"), undefined, "a human step in a foreach's body, its task a template over params");
    assert.match(roundProblem(round, "other")!, /human steps ask for "shop-visit", not other/);
    assert.match(roundProblem(parse(NONE), "shop-visit")!, /has no human step/);
  });

  it("its items: the first json input whose default is a list, each labelled by its text", () => {
    const read = roundItems(parse(ROUND));
    assert.equal(read.input, "shops");
    assert.deepEqual(read.items.map((i) => i.label), ["Bean There – 412 Main St", "Daily Grind – 88 Oak Ave", "Harbor Coffee – 3 Pier Rd"]);
    assert.deepEqual(read.items[0]!.value, { name: "Bean There", address: "412 Main St" });
    assert.deepEqual(roundItems(parse(OTHER)), { items: [] }, "no list: nothing to tick");
    assert.equal(itemLabel("La Cocina", 0), "La Cocina");
    assert.equal(itemLabel({ n: 3, nested: { x: 1 } }, 4), "3");
    assert.equal(itemLabel({ nested: { x: 1 } }, 4), "Item 5");
  });
});

// ── on a strut ──────────────────────────────────────────────────────────────

const KEY = "round-key";
const ANSWER = { type: "object", properties: { ok: { type: "boolean" } } };

describe("Send a round on a strut: the save's checks, the items, a round of all or some", () => {
  let root: string;
  let strut: Strut;
  const saved: Record<string, string | undefined> = {};
  before(() => {
    saved["STRUT_API_KEY"] = process.env["STRUT_API_KEY"];
    process.env["STRUT_API_KEY"] = KEY;
  });
  after(() => {
    if (saved["STRUT_API_KEY"] === undefined) delete process.env["STRUT_API_KEY"];
    else process.env["STRUT_API_KEY"] = saved["STRUT_API_KEY"];
  });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "strut-round-"));
    strut = await createStrut({
      workspace: new WorkspaceManager(join(root, "ws")),
      store: new MemoryRunStore(),
      serveUi: false,
      enableChat: false,
      scheduler: false,
      autoResume: false,
      stt: false,
      job: false,
      orchestrator: false,
      builder: false,
      views: false,
      workersApp: false,
      jamie: false,
      knowledge: false,
      earnings: false,
      concepts: false,
      systemWorkflows: false,
      browserWorkflows: false,
      privacyWorkflows: false,
      mediaWorkflows: false,
    });
    await strut.workspace.publishWorkflowByContent("shop-visits", ROUND);
    await strut.workspace.publishWorkflowByContent("other-visits", OTHER);
    await strut.workspace.publishWorkflowByContent("label-flow", "name: label-flow\nsteps:\n  - id: photo\n    type: human\n    config:\n      task: shop-visit\n      show: { ask: Photograph }\n");
  });
  afterEach(async () => {
    await strut.close();
    await rm(root, { recursive: true, force: true });
  });

  const auth = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
  const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = auth) =>
    strut.app.request(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const putType = (body: Record<string, unknown>) => req("PUT", "/tasks/types/shop-visit", { app: "strut/tasks", answer: ANSWER, ...body });
  const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;
  /** The open tasks of the type, waiting until the round's run made `n`. */
  const tasksOf = async (n: number) => {
    const deadline = Date.now() + 8000;
    for (;;) {
      const open = await strut.tasks.capability.list({ type: "shop-visit", status: "open" });
      if (open.length >= n || Date.now() > deadline) return open;
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it("saves a round type only over a workflow with a human step of it, never standing too; null turns it off", async () => {
    const missing = await putType({ round: { workflow: "nope" } });
    assert.equal(missing.status, 400);
    assert.match(await errorOf(missing), /round: no workflow nope here/);
    const other = await putType({ round: { workflow: "other-visits" } });
    assert.equal(other.status, 400);
    assert.match(await errorOf(other), /round: workflow other-visits's human steps ask for "something-else", not shop-visit/);
    const both = await putType({ round: { workflow: "shop-visits" }, standing: { workflow: "label-flow" } });
    assert.equal(both.status, 400);
    assert.match(await errorOf(both), /standing .* or sent in rounds .* never both/);
    const bad = await putType({ round: { workflow: "shop-visits", extra: 1 } });
    assert.equal(bad.status, 400);
    const put = await putType({ round: { workflow: "shop-visits" } });
    assert.equal(put.status, 200, await put.clone().text());
    assert.deepEqual(((await put.json()) as { type: { round?: unknown } }).type.round, { workflow: "shop-visits" });
    assert.deepEqual((await strut.tasks.capability.types()).find((t) => t.name === "shop-visit")!.round, { workflow: "shop-visits" }, "kept on file");
    const off = await putType({ round: null });
    assert.equal(((await off.json()) as { type: { round?: unknown } }).type.round, undefined);
    // A type with no round has no round to send.
    const none = await req("GET", "/tasks/types/shop-visit/round");
    assert.equal(none.status, 400);
    assert.match(await errorOf(none), /is not sent in rounds/);
  });

  it("lists the round's items and sends a round of the ones ticked, then of all; the last round is the newest", async () => {
    assert.equal((await putType({ round: { workflow: "shop-visits" } })).status, 200);
    const read = (await (await req("GET", "/tasks/types/shop-visit/round")).json()) as { workflow: string; input: string; items: Array<{ label: string; value: unknown }>; last?: unknown };
    assert.equal(read.workflow, "shop-visits");
    assert.equal(read.input, "shops");
    assert.deepEqual(read.items.map((i) => i.label), ["Bean There – 412 Main St", "Daily Grind – 88 Oak Ave", "Harbor Coffee – 3 Pier Rd"]);
    assert.equal(read.last, undefined, "none sent yet");

    // "Send Bean There only": one item ticked.
    const one = await req("POST", "/tasks/types/shop-visit/round", { input: { shops: [read.items[0]!.value] } });
    assert.equal(one.status, 200, await one.clone().text());
    const first = ((await one.json()) as { runId: string }).runId;
    const made = await tasksOf(1);
    assert.deepEqual(made.map((t) => (t.show as { ask: string }).ask), ["Visit Bean There at 412 Main St"]);
    assert.equal(made[0]!.runId, first);
    // The run is the admin's: launched in their name.
    assert.equal((await strut.store.getRunStart("shop-visits", first))?.actor, undefined, "the deployment key names no one");

    // A whole round: the workflow's defaults.
    const all = await req("POST", "/tasks/types/shop-visit/round", {});
    assert.equal(all.status, 200);
    const second = ((await all.json()) as { runId: string }).runId;
    assert.equal((await tasksOf(4)).filter((t) => t.runId === second).length, 3);
    const last = ((await (await req("GET", "/tasks/types/shop-visit/round")).json()) as { last: { runId: string; tasks: number } }).last;
    assert.deepEqual([last.runId, last.tasks], [second, 3]);

    // An input that is not the workflow's is refused before anything runs.
    const wrong = await req("POST", "/tasks/types/shop-visit/round", { input: ["Bean There"] });
    assert.equal(wrong.status, 400);
    assert.match(await errorOf(wrong), /input is an object/);
  });

  it("lists the workflows that can feed a type for the editor's picker: a round's any human step of it, standing only a first one", async () => {
    const res = await req("GET", "/tasks/workflows?type=shop-visit");
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(((await res.json()) as { workflows: unknown }).workflows, [
      { name: "label-flow", standing: true },
      { name: "shop-visits", standing: false },
    ]);
    assert.equal((await req("GET", "/tasks/workflows")).status, 400, "names the type");
    assert.equal((await req("GET", "/tasks/workflows?type=shop-visit", undefined, { "content-type": "application/json" })).status, 401, "an admin's");
  });

  it("is an admin's: no key, no round", async () => {
    assert.equal((await putType({ round: { workflow: "shop-visits" } })).status, 200);
    for (const [method, body] of [["GET", undefined], ["POST", {}]] as const) {
      const res = await req(method, "/tasks/types/shop-visit/round", body, { "content-type": "application/json" });
      assert.equal(res.status, 401, `${method} with no credential`);
    }
    assert.equal((await strut.tasks.capability.list({ type: "shop-visit" })).length, 0, "nothing sent");
  });
});
