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
  RUN_STEPS, RUN_WAIT_MS, anyInFlight, eventsSettled, isInFlight,
  useAppLink, useCancel, useHost, useLaunch, useRun, useRunEvents, useRuns, useStep, useToolInput, useTranscript, useWorkflow,
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
