import { teardownDom, useActEnvironment } from "./test-dom.js";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient } from "@tanstack/react-query";
import type { StrutClient } from "./client.js";
import { createStaticHost, type StaticHost } from "./host.js";
import { StrutProvider } from "./provider.js";
import {
  JOB_STEPS, RUN_STEPS, RUN_WAIT_MS, anyInFlight, eventsSettled, fileData, isInFlight,
  useAppLink, useCancel, useHost, useLaunch, useRun, useRunEvents, useRuns, useStep, useToolInput, useTranscript, useUpload, useWorkflow,
  useAssistant, assistantJobs, useJobUpdates, useGraphChanges, FEED_WAIT_MS,
} from "./hooks.js";
import { appLink } from "./links.js";

useActEnvironment();

interface Call { type: string; config?: Record<string, unknown>; input?: unknown }

/** A StrutClient that records every call and answers each step type with a fixture. */
function fakeClient(answers: Record<string, (c: Call) => unknown> = {}) {
  const calls: Call[] = [];
  const client: StrutClient = {
    async run(type, config, input) {
      const call: Call = { type, ...(config !== undefined ? { config } : {}), ...(input !== undefined ? { input } : {}) };
      calls.push(call);
      const answer = answers[type] ?? defaults[type];
      return (answer ? answer(call) : { echo: call }) as never;
    },
  };
  return { client, calls };
}

const defaults: Record<string, (c: Call) => unknown> = {
  [RUN_STEPS.list]: (c) => [{ runId: "1", workflow: c.config?.workflow, status: "success" }],
  [RUN_STEPS.get]: (c) => ({ runId: c.config?.runId, workflow: c.config?.workflow, status: "success", output: { n: 1 } }),
  [RUN_STEPS.events]: () => [{ type: "run.start" }, { type: "run.end" }],
  [RUN_STEPS.transcript]: (c) => ({ path: c.config?.path, messages: [{ role: "user", content: "hi" }] }),
  [RUN_STEPS.launch]: () => ({ runId: "9" }),
  [RUN_STEPS.cancel]: () => ({ cancelled: true }),
  [RUN_STEPS.workflow]: (c) => ({ name: c.config?.workflow, description: "a workflow" }),
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait, inside act, until the predicate holds. */
async function until(pred: () => boolean, what: string, ms = 3000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await act(async () => { await sleep(10); });
  }
}

/** Render a hook under StrutProvider; read its latest value with `result()`. */
async function renderHook<T>(use: () => T, opts: { client: StrutClient; host?: StaticHost }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  let current: T | undefined;
  let renders = 0;
  function Probe() { current = use(); renders++; return null; }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 }, mutations: { retry: false } } });
  await act(async () => {
    root.render(createElement(StrutProvider, { client: opts.client, host: opts.host, queryClient }, createElement(Probe)));
  });
  return {
    result: () => current as T,
    renders: () => renders,
    unmount: () => act(async () => { root.unmount(); container.remove(); }),
  };
}

describe("the run hooks name their step and pass what they were given", () => {
  it("useRuns → run/list with the filter, live and enabled stripped", async () => {
    const { client, calls } = fakeClient();
    const h = await renderHook(() => useRuns("wf", { status: "success", automation: "a1", live: true, limit: 5 }), { client });
    await until(() => h.result().data !== undefined, "run/list data");
    assert.deepEqual(calls, [{ type: "run/list", config: { workflow: "wf", status: "success", automation: "a1", limit: 5 } }]);
    assert.equal(h.result().data![0]!.runId, "1");
    await h.unmount();
  });

  it("useRuns(null, { job }) → a job's runs across its workflows (a job's app); null alone asks for nothing", async () => {
    const { client, calls } = fakeClient();
    const h = await renderHook(() => ({ job: useRuns(null, { job: "j1" }), none: useRuns(null) }), { client });
    await until(() => h.result().job.data !== undefined, "run/list data");
    assert.deepEqual(calls, [{ type: "run/list", config: { job: "j1" } }]);
    assert.equal(h.result().none.fetchStatus, "idle");
    await h.unmount();
  });

  it("useRun → run/get; live adds `wait` once the run it holds is in flight", async () => {
    let status = "running";
    const { client, calls } = fakeClient({ [RUN_STEPS.get]: (c) => ({ runId: c.config?.runId, workflow: "wf", status }) });
    const h = await renderHook(() => useRun("wf", "r1", { live: true }), { client });
    await until(() => h.result().data !== undefined, "run/get data");
    assert.deepEqual(calls, [{ type: "run/get", config: { workflow: "wf", runId: "r1" } }], "the first read never waits");
    status = "success";
    await act(async () => { await h.result().refetch(); });
    assert.deepEqual(calls[1], { type: "run/get", config: { workflow: "wf", runId: "r1", wait: RUN_WAIT_MS } });
    await act(async () => { await h.result().refetch(); });
    assert.deepEqual(calls[2], { type: "run/get", config: { workflow: "wf", runId: "r1" } }, "a settled run is read without waiting");
    await h.unmount();
  });

  it("useRun without a runId calls nothing", async () => {
    const { client, calls } = fakeClient();
    const h = await renderHook(() => useRun("wf", undefined), { client });
    await act(async () => { await sleep(30); });
    assert.deepEqual(calls, []);
    await h.unmount();
  });

  it("useRunEvents → run/events", async () => {
    const { client, calls } = fakeClient();
    const h = await renderHook(() => useRunEvents("wf", "r1"), { client });
    await until(() => h.result().data !== undefined, "events");
    assert.deepEqual(calls, [{ type: "run/events", config: { workflow: "wf", runId: "r1" } }]);
    assert.equal(h.result().data!.length, 2);
    await h.unmount();
  });

  it("useTranscript → run/transcript, `full` only when asked; nothing without a path", async () => {
    const { client, calls } = fakeClient();
    const h = await renderHook(() => useTranscript("wf", "r1", "wf/agent"), { client });
    await until(() => h.result().data !== undefined, "transcript");
    assert.deepEqual(calls, [{ type: "run/transcript", config: { workflow: "wf", runId: "r1", path: "wf/agent" } }]);
    assert.deepEqual(h.result().data, { path: "wf/agent", messages: [{ role: "user", content: "hi" }] });
    await h.unmount();
    const thread = fakeClient();
    const t = await renderHook(() => useTranscript("wf", "r1", "wf/agent", { full: true }), { client: thread.client });
    await until(() => t.result().data !== undefined, "the thread");
    assert.deepEqual(thread.calls, [{ type: "run/transcript", config: { workflow: "wf", runId: "r1", path: "wf/agent", full: true } }]);
    await t.unmount();
    const none = fakeClient();
    const n = await renderHook(() => useTranscript("wf", "r1", undefined), { client: none.client });
    await act(async () => { await sleep(30); });
    assert.deepEqual(none.calls, []);
    await n.unmount();
  });

  it("useWorkflow → run/workflow", async () => {
    const { client, calls } = fakeClient();
    const h = await renderHook(() => useWorkflow("wf"), { client });
    await until(() => h.result().data !== undefined, "workflow");
    assert.deepEqual(calls, [{ type: "run/workflow", config: { workflow: "wf" } }]);
    assert.equal(h.result().data!.description, "a workflow");
    await h.unmount();
  });
});

describe("the mutations", () => {
  it("useLaunch fires nothing until launch() is called, then run/launch with input, params and key", async () => {
    const { client, calls } = fakeClient();
    const h = await renderHook(() => ({ launch: useLaunch("wf"), runs: useRuns("wf") }), { client });
    await until(() => h.result().runs.data !== undefined, "run/list");
    await act(async () => { await sleep(30); });
    assert.deepEqual(calls.map((c) => c.type), ["run/list"], "mounting a launcher launches nothing");
    assert.equal(h.result().launch.pending, false);
    let result: unknown;
    await act(async () => { result = await h.result().launch.launch({ q: 1 }, { temperature: 0 }, "key-1"); });
    assert.deepEqual(result, { runId: "9" });
    assert.deepEqual(calls[1], { type: "run/launch", config: { workflow: "wf", input: { q: 1 }, params: { temperature: 0 }, key: "key-1" } });
    await until(() => calls.filter((c) => c.type === "run/list").length === 2, "the run list invalidated by the launch");
    await until(() => h.result().launch.data !== undefined, "the launch's data");
    assert.deepEqual(h.result().launch.data, { runId: "9" });
    await h.unmount();
  });

  it("useLaunch passes only what was given", async () => {
    const { client, calls } = fakeClient();
    const h = await renderHook(() => useLaunch("wf"), { client });
    await act(async () => { await h.result().launch(); });
    assert.deepEqual(calls, [{ type: "run/launch", config: { workflow: "wf" } }]);
    await h.unmount();
  });

  it("useLaunch(workflow, { job }) launches under the job; files go as the run's attachments, base64", async () => {
    const { client, calls } = fakeClient();
    const h = await renderHook(() => useLaunch("ask", { job: "library", title: "Library" }), { client });
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    await act(async () => { await h.result().launch({ question: "what?" }, undefined, undefined, [file]); });
    assert.deepEqual(calls, [{
      type: "run/launch",
      config: {
        workflow: "ask", input: { question: "what?" }, job: "library", title: "Library",
        attachments: [{ name: "notes.txt", mediaType: "text/plain", data: Buffer.from("hello").toString("base64") }],
      },
    }]);
    await h.unmount();
  });

  it("fileData reads a file to base64 in slices, a file past one slice whole", async () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 251);
    const out = await fileData(new File([bytes], "blob.bin"));
    assert.deepEqual([out.name, out.mediaType], ["blob.bin", undefined]);
    assert.deepEqual(new Uint8Array(Buffer.from(out.data, "base64")), bytes);
  });

  it("useUpload(job) sends nothing until upload(); then job/upload with the file, job/delete-upload by path", async () => {
    const { client, calls } = fakeClient({
      [JOB_STEPS.upload]: (c) => ({ job: `app/x/${c.config?.job}`, path: `uploads/${c.config?.name}`, name: c.config?.name, mediaType: "image/png", size: 3 }),
      [JOB_STEPS.deleteUpload]: (c) => ({ job: `app/x/${c.config?.job}`, path: c.config?.path, removed: true }),
    });
    const h = await renderHook(() => useUpload("library"), { client });
    await act(async () => { await sleep(20); });
    assert.deepEqual(calls, [], "mounting uploads nothing");
    let saved: unknown;
    await act(async () => { saved = await h.result().upload(new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" })); });
    assert.deepEqual(calls[0], { type: "job/upload", config: { job: "library", name: "shot.png", mediaType: "image/png", data: "AQID" } });
    assert.deepEqual(saved, { job: "app/x/library", path: "uploads/shot.png", name: "shot.png", mediaType: "image/png", size: 3 });
    await until(() => h.result().data !== undefined, "the upload's data");
    await act(async () => { await h.result().remove("uploads/shot.png"); });
    assert.deepEqual(calls[1], { type: "job/delete-upload", config: { job: "library", path: "uploads/shot.png" } });
    await h.unmount();
  });

  it("useCancel → run/cancel", async () => {
    const { client, calls } = fakeClient();
    const h = await renderHook(() => useCancel(), { client });
    await act(async () => { await h.result().cancel("wf", "r1"); });
    assert.deepEqual(calls, [{ type: "run/cancel", config: { workflow: "wf", runId: "r1" } }]);
    await h.unmount();
  });

  it("useStep(type) → that step, with config and input, only when run() is called", async () => {
    const { client, calls } = fakeClient();
    const h = await renderHook(() => useStep<{ echo: Call }>("graph/graph-search"), { client });
    await act(async () => { await sleep(20); });
    assert.deepEqual(calls, []);
    let out: { echo: Call } | undefined;
    await act(async () => { out = await h.result().run({ query: "invoices" }, { limit: 3 }); });
    assert.deepEqual(calls, [{ type: "graph/graph-search", config: { query: "invoices" }, input: { limit: 3 } }]);
    assert.deepEqual(out, { echo: calls[0] });
    await until(() => h.result().data !== undefined, "the mutation's data");
    assert.deepEqual(h.result().data, out);
    await h.unmount();
  });

  it("a refused step surfaces as the mutation's error", async () => {
    const client: StrutClient = { run: async () => { throw new Error("not granted: exec"); } };
    const h = await renderHook(() => useStep("exec"), { client });
    await act(async () => { await h.result().run({ cmd: "ls" }).catch(() => undefined); });
    await until(() => h.result().error !== null, "the mutation's error");
    assert.equal(h.result().error?.message, "not granted: exec");
    await h.unmount();
  });
});

describe("the host hooks", () => {
  it("useToolInput follows the host's tool-input; useHost reads theme and display mode and sends through the host", async () => {
    const sent: string[] = [];
    const opened: string[] = [];
    const host = createStaticHost(
      { theme: "dark", displayMode: "fullscreen", locale: "fr-FR", timeZone: "Europe/Paris" },
      { sendMessage: async (t) => { sent.push(t); }, openLink: async (u) => { opened.push(u); } },
    );
    const { client } = fakeClient();
    const h = await renderHook(() => ({ input: useToolInput<{ view?: string }>(), host: useHost() }), { client, host });
    assert.equal(h.result().input, undefined);
    assert.equal(h.result().host.theme, "dark");
    assert.equal(h.result().host.displayMode, "fullscreen");
    assert.equal(h.result().host.locale, "fr-FR");
    assert.equal(h.result().host.timeZone, "Europe/Paris");
    await act(async () => { host.setToolInput({ view: "runs", runId: "r1" }); });
    assert.deepEqual(h.result().input, { view: "runs", runId: "r1" });
    await act(async () => { host.update({ context: { theme: "light" } }); });
    assert.equal(h.result().host.theme, "light");
    await h.result().host.sendMessage("change the chart to a bar chart");
    await h.result().host.openLink("https://example.com/run/1");
    assert.deepEqual(sent, ["change the chart to a bar chart"]);
    assert.deepEqual(opened, ["https://example.com/run/1"]);
    await h.unmount();
  });

  it("appLink names the app and carries its input as one param; useAppLink is this app's", async () => {
    assert.equal(appLink("bench"), "?app=bench");
    assert.equal(appLink("bench", {}), "?app=bench", "no input, a plain open");
    const link = appLink("acme/bench", { view: "/runs", run: 12, live: true, gone: undefined, none: null });
    const q = new URLSearchParams(link.slice(1));
    assert.equal(q.get("app"), "acme/bench");
    assert.deepEqual(Object.fromEntries(new URLSearchParams(q.get("input")!)), { view: "/runs", run: "12", live: "true" });
    assert.deepEqual([...q.keys()], ["app", "input"], "the input stays inside its one param");

    const { client } = fakeClient();
    const h = await renderHook(() => useAppLink(), { client: { ...client, app: { name: "bench", version: "v3" } } });
    assert.equal(h.result()({ view: "/settings" }), appLink("bench", { view: "/settings" }), "the live app, never its version");
    await h.unmount();
    const bare = await renderHook(() => useAppLink(), { client });
    assert.throws(() => bare.result()(), /no app identity/);
    await bare.unmount();
  });
});

describe("useAssistant: a chat with the person's assistant", () => {
  const RUNS: Record<string, { status: string; input: unknown; output?: unknown; error?: { message: string } }> = {
    "3": { status: "success", input: { prompt: "draw a plan", session: "assistant" }, output: { text: "Started it.", artifacts: [] } },
    "2": { status: "success", input: { prompt: "elsewhere", session: "side" }, output: { text: "other thread" } },
    "1": { status: "error", input: { prompt: "hi", session: "assistant" }, error: { message: "boom" } },
  };
  const answers = {
    // Newest first, as run/list answers.
    [RUN_STEPS.list]: () => ["3", "2", "1"].map((runId) => ({ runId, workflow: "orchestrator", status: RUNS[runId]!.status })),
    [RUN_STEPS.get]: (c: Call) => ({ runId: c.config?.runId, workflow: "orchestrator", ...RUNS[c.config?.runId as string]! }),
    [RUN_STEPS.events]: () => [
      { type: "run.start" },
      // As the run log keeps an agent's tool call: the tool is `job_start`,
      // its output the JSON text the model was handed.
      { type: "step.start", path: "orchestrator/turn/001-job_start", stepType: "tool:job_start", input: { prompt: "p", title: "Plan", workflow: "builder" } },
      { type: "step.end", path: "orchestrator/turn/001-job_start", stepType: "tool:job_start", output: JSON.stringify({ job: "app/canvas/j1", runId: "77", callback: false }) },
      { type: "step.end", path: "orchestrator/turn/002-job_list", stepType: "tool:job_list", output: JSON.stringify({ jobs: [] }) },
      { type: "run.end" },
    ],
  };

  it("reads the thread's turns back oldest first, the reply's text and a failed turn's error; the latest turn's jobs; send launches one turn on the thread", async () => {
    const { client, calls } = fakeClient(answers);
    const h = await renderHook(() => useAssistant(), { client });
    await until(() => h.result().messages.length === 4 && h.result().jobs.length === 1, "the thread and its jobs");
    assert.deepEqual(
      h.result().messages.map((m) => [m.role, m.runId, m.text, m.status]),
      [["user", "1", "hi", "done"], ["assistant", "1", "boom", "error"], ["user", "3", "draw a plan", "done"], ["assistant", "3", "Started it.", "done"]],
      "the other thread is left out",
    );
    assert.deepEqual(h.result().jobs, [{ job: "app/canvas/j1", runId: "77", workflow: "builder" }]);
    assert.deepEqual(calls[0], { type: "run/list", config: { workflow: "orchestrator", limit: 10 } });
    assert.equal(calls.filter((c) => c.type === "run/launch").length, 0, "nothing launches on its own");
    await act(async () => { await h.result().send("and now?"); });
    assert.deepEqual(calls.find((c) => c.type === "run/launch"), { type: "run/launch", config: { workflow: "orchestrator", input: { prompt: "and now?", session: "assistant" } } });
    await h.unmount();
  });

  it("assistantJobs reads job/start and job/continue calls that came back with a job; a continue names no workflow", () => {
    assert.deepEqual(assistantJobs(undefined), []);
    assert.deepEqual(
      assistantJobs([
        { type: "step.end", path: "o/t/001-job_continue", stepType: "tool:job_continue", output: JSON.stringify({ job: "app/c/j", runId: "5" }) },
        { type: "step.end", path: "o/t/002-job_start", stepType: "tool:job_start", output: "Error: job_busy: job \"x\" has a run in flight" },
        { type: "step.end", path: "o/t/003-job_start", stepType: "tool:job_start", output: JSON.stringify({ job: "app/c/k", runId: "6", callback: false }) },
      ]),
      [{ job: "app/c/j", runId: "5" }, { job: "app/c/k", runId: "6", workflow: "job" }],
    );
  });

  it("assistantJobs still reads a log from before the tool names lost their slash, with object outputs", () => {
    assert.deepEqual(
      assistantJobs([{ type: "step.end", path: "o/t/001-job_start", stepType: "tool:job/start", output: { job: "app/c/k", runId: "6" } }]),
      [{ job: "app/c/k", runId: "6", workflow: "job" }],
    );
  });
});

describe("the live feeds (plans/live-feeds.md)", () => {
  it("useJobUpdates reads the job's history, then waits on the cursor; the newest state of each thing, latest(kind)", async () => {
    const answers: Array<Record<string, unknown>> = [
      { job: "j", cursor: "e.2", updates: [
        { event: "job.update", job: "j", at: "t1", kind: "status", id: "r1", title: "Drafting round 1" },
        { event: "job.update", job: "j", at: "t2", kind: "image", url: "/jobs/j/files/shots/001.png", state: "done" },
      ] },
      { job: "j", cursor: "e.3", updates: [{ event: "job.update", job: "j", at: "t3", kind: "status", id: "r1", title: "Drafting round 2" }] },
    ];
    let n = 0;
    const { client, calls } = fakeClient({
      "job/updates": () => answers[n++] ?? new Promise(() => {}), // then hold, as the server would
    });
    const h = await renderHook(() => useJobUpdates("j"), { client });
    await until(() => h.result().latest("status")?.title === "Drafting round 2", "the second answer");
    assert.deepEqual(h.result().updates.map((u) => [u.kind, u.title ?? u.url]), [["image", "/jobs/j/files/shots/001.png"], ["status", "Drafting round 2"]]);
    assert.deepEqual(calls[0], { type: "job/updates", config: { job: "j" } }, "the first read takes the history at once");
    assert.deepEqual(calls[1], { type: "job/updates", config: { job: "j", since: "e.2", wait: FEED_WAIT_MS } });
    assert.deepEqual(calls[2], { type: "job/updates", config: { job: "j", since: "e.3", wait: FEED_WAIT_MS } });
    await h.unmount();
  });

  it("useJobUpdates on a reset starts over from what the answer holds", async () => {
    const answers: Array<Record<string, unknown>> = [
      { job: "j", cursor: "e.1", updates: [{ event: "job.update", job: "j", at: "t1", kind: "image", url: "/a.png" }] },
      { job: "j", cursor: "f.1", reset: true, updates: [{ event: "job.update", job: "j", at: "t2", kind: "image", url: "/b.png" }] },
    ];
    let n = 0;
    const { client } = fakeClient({ "job/updates": () => answers[n++] ?? new Promise(() => {}) });
    const h = await renderHook(() => useJobUpdates("j"), { client });
    await until(() => h.result().updates[0]?.url === "/b.png", "the reset");
    assert.equal(h.result().updates.length, 1);
    await h.unmount();
  });

  it("useGraphChanges starts from now and bumps rev for each answer with writes", async () => {
    const answers: Array<Record<string, unknown>> = [
      { cursor: "e.9", changes: [] },
      { cursor: "e.11", changes: [{ kind: "node", op: "created", ref_id: "o1", node_type: "Option", at: "t" }] },
    ];
    let n = 0;
    const { client, calls } = fakeClient({ "graph/changes": () => answers[n++] ?? new Promise(() => {}) });
    const h = await renderHook(() => useGraphChanges(["Option", "Question"]), { client });
    await until(() => h.result().rev === 1, "the first write");
    assert.deepEqual(h.result().changes.map((c) => c.ref_id), ["o1"]);
    assert.deepEqual(calls[0], { type: "graph/changes", config: { types: ["Option", "Question"], since: "now" } });
    assert.deepEqual(calls[1], { type: "graph/changes", config: { types: ["Option", "Question"], since: "e.9", wait: FEED_WAIT_MS } });
    await h.unmount();
  });
});

describe("the live helpers", () => {
  it("know a terminal status and a terminal event", () => {
    assert.equal(isInFlight({ status: "running" }), true);
    assert.equal(isInFlight({ status: "paused" }), true);
    assert.equal(isInFlight({ status: "success" }), false);
    assert.equal(isInFlight({ status: "error" }), false);
    assert.equal(isInFlight({ status: "cancelled" }), false);
    assert.equal(isInFlight(undefined), false);
    assert.equal(anyInFlight([{ status: "success" }, { status: "running" }]), true);
    assert.equal(anyInFlight([{ status: "success" }]), false);
    assert.equal(eventsSettled([{ type: "run.start" }]), false);
    assert.equal(eventsSettled([{ type: "run.start" }, { type: "run.error" }]), true);
    assert.equal(eventsSettled(undefined), false);
  });
});


after(() => teardownDom());
