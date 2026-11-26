/**
 * Posts in linked places (plans/place-posts.md): a WORKFLOW's `place/post`
 * hands a post to the place's host on the hook the host named
 * (`PUT /hosts/me`), `{ event: "post", … }`, once per id. Anyone linked to
 * the box may post in any place linked there (ruling 1); only a step of a
 * workflow may, never an agent's tool (ruling 2).
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStrut } from "./createStrut.js";
import { MemoryRunStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";
import { personToken } from "./auth.js";
import { setEnv } from "./test-util/public-door.js";
import { createPeople, PEOPLE_IN_MEMORY, placesCapability, type PlacePost, type PlacesCapability } from "./people.js";
import { RUN_STEP_FLOW } from "./run-step.js";
import { buildRegistryTools } from "./steps/core/agent.js";
import type { StepContext, StepRegistry } from "./core.js";
import postStep from "./steps/lib/place/post.js";

const KEY = "place-posts-key";
const HOST_TOKEN = "place-posts-host-token";
const BOX = `03${"0b".repeat(32)}`;
const ADA = `02${"aa".repeat(32)}`;
const BOB = `02${"bb".repeat(32)}`;
const TRIBE = `02${"77".repeat(32)}`;
const OTHER = `02${"88".repeat(32)}`;
const LINK = `sphinx.chat://?action=tribeV2&pubkey=${TRIBE}&host=tribes.example`;
const HEX32 = /^[0-9a-f]{32}$/;

describe("place posts (plans/place-posts.md)", () => {
  let dir: string;
  let restoreEnv: () => void;
  let strut: Awaited<ReturnType<typeof createStrut>>;
  let hook: Server;
  let hookUrl: string;
  /** What the stand-in host was handed, nudges aside. */
  const posts: Array<Record<string, unknown>> = [];
  /** The stand-in host posts one id once, as the daemon does. */
  const sent = new Map<string, string>();
  const json = { "content-type": "application/json" };
  const call = async (method: string, path: string, headers: Record<string, string>, body?: unknown) => {
    const res = await strut.app.request(path, { method, headers: { ...json, ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  const key = { authorization: `Bearer ${KEY}` };
  const launch = async (wf: string, input: Record<string, unknown>, actor: string) => {
    const res = await call("POST", `/workflows/${wf}/run`, { ...key, "x-strut-actor": actor }, { input });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    const runId = res.body["runId"] as string;
    for (let i = 0; i < 400; i++) {
      const s = await strut.store.getRunSummary(wf, runId);
      if (s) return { runId, summary: s };
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`run ${wf}/${runId} did not settle`);
  };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-place-posts-"));
    restoreEnv = setEnv({ STRUT_API_KEY: KEY, STRUT_HOST_KEYS: `sphinx:${HOST_TOKEN}` });
    hook = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        res.setHeader("content-type", "application/json");
        if (body["event"] !== "post") return res.end(JSON.stringify({ ok: true }));
        posts.push(body);
        const id = body["id"] as string;
        const was = sent.get(id);
        if (was) return res.end(JSON.stringify({ id: was, again: true }));
        const message = `m-${sent.size + 1}`;
        sent.set(id, message);
        res.end(JSON.stringify({ id: message, sats: 3 }));
      });
    });
    await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
    hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/strut/places?token=t1`;
    strut = await createStrut({
      workspace: new WorkspaceManager(join(dir, "ws")),
      store: new MemoryRunStore(),
      serveUi: false,
      scheduler: false,
      autoResume: false,
      views: false, jamie: false, knowledge: false, job: false, orchestrator: false, builder: false,
      browserWorkflows: false, privacyWorkflows: false, mediaWorkflows: false,
    });
    await strut.people.link({ kind: "sphinx", key: ADA }, "ada");
    await strut.people.link({ kind: "sphinx", key: BOB }, "bob");
    assert.equal((await call("PUT", "/hosts/me", { authorization: `Bearer ${HOST_TOKEN}` }, { account: BOX, hook: hookUrl })).status, 200);
    const peel = { authorization: `Bearer ${personToken("ada", 60_000, { account: `sphinx:${ADA}` })!.token}` };
    assert.equal((await call("POST", "/people/places", peel, { host: "sphinx", key: TRIBE, link: LINK, name: "Builders" })).status, 200);
    const post = (config: Record<string, unknown>) => ({ steps: [{ id: "post", type: "place/post", config: { host: "sphinx", key: "{{ input.tribe }}", text: "{{ input.text }}", ...config } }] });
    await strut.workspace.publishWorkflow("digest", "v1", post({ reply: "{{ input.reply }}" }));
    await strut.workspace.publishWorkflow("daily", "v1", post({ id: "{{ input.day }}" }));
    await strut.workspace.publishWorkflow("daily-too", "v1", post({ id: "{{ input.day }}" }));
    await strut.workspace.publishWorkflow("where", "v1", { steps: [{ id: "list", type: "place/list" }] });
  });
  after(async () => {
    await strut?.close?.().catch(() => {});
    await new Promise((r) => hook?.close(r));
    restoreEnv?.();
    await rm(dir, { recursive: true, force: true });
  });

  it("a linked person's workflow posts in a place, handed to its host's hook", async () => {
    const { runId, summary } = await launch("digest", { tribe: TRIBE, text: "Today: three merges.", reply: "" }, "ada");
    assert.equal(summary.status, "success", JSON.stringify(summary.error));
    assert.deepEqual(summary.output, { id: "m-1", sats: 3 }, "the run answers its last step");
    assert.equal(posts.length, 1);
    const { id, ...rest } = posts[0]!;
    assert.match(id as string, HEX32);
    assert.deepEqual(rest, { event: "post", key: TRIBE, text: "Today: three merges.", run: runId, workflow: "digest" }, "an empty reply is none");
    // Under an earlier post.
    const threaded = await launch("digest", { tribe: TRIBE, text: "And one more.", reply: "m-1" }, "ada");
    assert.equal(threaded.summary.status, "success", JSON.stringify(threaded.summary.error));
    assert.equal(posts[1]!["reply"], "m-1");
    assert.notEqual(posts[1]!["id"], posts[0]!["id"], "each run posts under an id of its own");
  });

  it("a given id is once per workflow: a repeat posts nothing, another workflow's is its own", async () => {
    const before = posts.length;
    const first = await launch("daily", { tribe: TRIBE, text: "Digest", day: "2026-11-26" }, "ada");
    const again = await launch("daily", { tribe: TRIBE, text: "Digest", day: "2026-11-26" }, "ada");
    const other = await launch("daily-too", { tribe: TRIBE, text: "Digest", day: "2026-11-26" }, "ada");
    for (const r of [first, again, other]) assert.equal(r.summary.status, "success", JSON.stringify(r.summary.error));
    const handed = posts.slice(before).map((p) => p["id"]);
    assert.equal(handed[0], handed[1], "the same workflow and id: the same post id");
    assert.notEqual(handed[0], handed[2], "another workflow's id never meets this one's");
    assert.equal((again.summary.output as Record<string, any>)["again"], true);
    assert.equal((again.summary.output as Record<string, any>)["id"], (first.summary.output as Record<string, any>)["id"]);
  });

  it("anyone linked may post, not only the place's linker (ruling 1); nobody else, nowhere else", async () => {
    const bob = await launch("digest", { tribe: TRIBE, text: "From Bob's workflow", reply: "" }, "bob");
    assert.equal(bob.summary.status, "success", JSON.stringify(bob.summary.error));
    const before = posts.length;
    const cara = await launch("digest", { tribe: TRIBE, text: "x", reply: "" }, "cara");
    assert.equal(cara.summary.status, "error");
    assert.match(cara.summary.error?.message ?? "", /not_linked: /);
    const elsewhere = await launch("digest", { tribe: OTHER, text: "x", reply: "" }, "ada");
    assert.equal(elsewhere.summary.status, "error");
    assert.match(elsewhere.summary.error?.message ?? "", /no_place: /);
    assert.equal(posts.length, before, "nothing reached the host");
  });

  it("place/list names the places a linked person may post in, never their link", async () => {
    const ada = await launch("where", {}, "ada");
    assert.equal(ada.summary.status, "success", JSON.stringify(ada.summary.error));
    assert.deepEqual(ada.summary.output, { places: [{ host: "sphinx", key: TRIBE, name: "Builders" }] });
    const cara = await launch("where", {}, "cara");
    assert.match(cara.summary.error?.message ?? "", /not_linked: /);
  });

  it("only a workflow's step posts (ruling 2): a single-step run is refused", async () => {
    const before = posts.length;
    const res = await call("POST", "/steps/place/post/run", { ...key, "x-strut-actor": "ada" }, { config: { host: "sphinx", key: TRIBE, text: "x" } });
    assert.match(JSON.stringify(res.body), /workflow_only: /);
    assert.equal(posts.length, before);
  });
});

describe("place/post refuses all but a workflow's step (ruling 2)", () => {
  const handed: PlacePost[] = [];
  const places: PlacesCapability = {
    list: async () => [],
    post: async (p) => {
      handed.push(p);
      return { id: "m" };
    },
  };
  const ctx = (extra: Partial<StepContext>): StepContext =>
    ({ runId: "r1", path: "wf/post", workflow: "wf", scope: {}, input: undefined, emit: async () => {}, services: { places }, principal: "ada", ...extra }) as StepContext;
  const cfg = { host: "sphinx", key: TRIBE, text: "hi" };

  it("as a step of a workflow, it posts", async () => {
    assert.deepEqual(await postStep.run(cfg, ctx({})), { id: "m" });
    assert.equal(handed.length, 1);
  });

  it("as an agent's tool, through the agent step's own tool building, it is refused", async () => {
    const registry = { "place/post": postStep } as unknown as StepRegistry;
    const tools = buildRegistryTools(["place/*"], registry, ctx({ path: "wf/agent" }), (def: unknown) => def) as Record<string, { execute: (input: unknown) => Promise<unknown> }>;
    const tool = Object.values(tools)[0]!;
    await assert.rejects(Promise.resolve().then(() => tool.execute(cfg)), /workflow_only: /);
    assert.equal(handed.length, 1, "nothing was handed on");
  });

  it("as a single-step run (step_run, meta/run-step) or a proposal's apply, it is refused", async () => {
    await assert.rejects(postStep.run(cfg, ctx({ workflow: RUN_STEP_FLOW, path: `${RUN_STEP_FLOW}/place.post` })), /workflow_only: /);
    await assert.rejects(postStep.run(cfg, ctx({ workflow: undefined, path: `${RUN_STEP_FLOW}/place.post`, nested: true })), /workflow_only: /);
    await assert.rejects(postStep.run(cfg, ctx({ proposal: { id: "p1", by: { workflow: "wf", runId: "r0" } } })), /workflow_only: /);
    assert.equal(handed.length, 1);
  });

  it("the id is the run and step's, or the workflow and the id given's", async () => {
    await postStep.run(cfg, ctx({ runId: "r2" }));
    await postStep.run(cfg, ctx({ runId: "r2" }));
    await postStep.run(cfg, ctx({ runId: "r3" }));
    await postStep.run({ ...cfg, id: "day-1" }, ctx({ runId: "r4" }));
    await postStep.run({ ...cfg, id: "day-1" }, ctx({ runId: "r5" }));
    const ids = handed.slice(1).map((p) => p.id);
    for (const id of ids) assert.match(id, HEX32);
    assert.equal(ids[0], ids[1], "a retry of the same run and step");
    assert.notEqual(ids[0], ids[2], "another run");
    assert.equal(ids[3], ids[4], "the same given id in the same workflow, across runs");
    assert.notEqual(ids[3], ids[0]);
    assert.deepEqual([handed[1]!.run, handed[1]!.workflow], ["r2", "wf"]);
  });
});

describe("placesCapability: what the host answers", () => {
  let restoreEnv: () => void;
  const people = createPeople(PEOPLE_IN_MEMORY);
  const hookAt = "http://host.test/strut/places?token=secret";
  const post: PlacePost = { host: "sphinx", key: TRIBE, text: "hi", id: "a".repeat(32), run: "r1", workflow: "wf" };
  /** A capability whose host answers each try with the next of `answers`. */
  const over = (answers: Array<Response | Error>) => {
    const tries: string[] = [];
    const cap = placesCapability(people, {
      retryMs: [0, 0],
      fetch: (async (url: string) => {
        tries.push(url);
        const a = answers.shift();
        if (!a) throw new Error("no more answers");
        if (a instanceof Error) throw a;
        return a;
      }) as unknown as typeof fetch,
    });
    return { cap, tries };
  };
  const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  before(async () => {
    restoreEnv = setEnv({ STRUT_HOST_KEYS: `sphinx:${HOST_TOKEN}` });
    await people.link({ kind: "sphinx", key: ADA }, "ada");
    await people.setHost("sphinx", { kind: "sphinx", key: BOX }, hookAt);
    await people.linkPlace({ host: "sphinx", key: TRIBE, link: LINK }, { kind: "sphinx", key: ADA }, "ada");
  });
  after(async () => {
    restoreEnv?.();
    await people.close();
  });

  it("a refusal fails with the host's code, at once; a 502 is the medium's refusal, not retried", async () => {
    const joined = over([answer(409, { code: "not_joined", error: "not a member of that tribe yet" })]);
    await assert.rejects(joined.cap.post(post, "ada"), /^Error: not_joined: the sphinx host \(http:\/\/host\.test\) refused the post: not a member/);
    assert.equal(joined.tries.length, 1);
    const medium = over([answer(502, { code: "send_failed", error: "send_failed: INSUFFICIENT_BALANCE" })]);
    await assert.rejects(medium.cap.post(post, "ada"), /^Error: send_failed: .*: INSUFFICIENT_BALANCE/);
    assert.equal(medium.tries.length, 1);
  });

  it("no answer, a 429 or another 5xx is tried again, then host_unreachable; the URL's token is never in an error", async () => {
    const later = over([new Error("ECONNREFUSED"), answer(503, {}), answer(200, { id: "m-9", sats: 1 })]);
    assert.deepEqual(await later.cap.post(post, "ada"), { id: "m-9", sats: 1 });
    assert.equal(later.tries.length, 3);
    const down = over([answer(429, {}), answer(500, {}), new Error("timeout")]);
    await assert.rejects(down.cap.post(post, "ada"), (err: Error) => /^host_unreachable: .*3 tries \(timeout\)/.test(err.message) && !err.message.includes("secret"));
  });

  it("a 2xx with no message id is a host from before posts: host_cannot_post, nothing posted", async () => {
    const old = over([answer(200, { ok: true })]);
    await assert.rejects(old.cap.post(post, "ada"), /^Error: host_cannot_post: /);
    assert.equal(old.tries.length, 1);
  });

  it("a person posts only through a host whose kind of account they hold, and only to a host with a key here", async () => {
    const none = over([]);
    await assert.rejects(none.cap.post({ ...post, host: "slack" }, "ada"), /not_linked: .*linked slack account/);
    const restore = setEnv({ STRUT_HOST_KEYS: undefined });
    try {
      await assert.rejects(none.cap.post(post, "ada"), /^Error: no_host: /);
    } finally {
      restore();
    }
    assert.equal(none.tries.length, 0);
  });
});
