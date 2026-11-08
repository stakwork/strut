/**
 * `app/look` against a REAL browser and strut's real UI. Skipped unless
 * STRUT_TEST_APP_LOOK=1; needs the UI built (`cd web && npm run build`) and
 * a browser: the local Chrome by default, or a Playwright server through
 * BROWSER_WS_URL + BROWSER_WS_PATH as in `npm run test:browser`.
 *
 *   STRUT_TEST_APP_LOOK=1 npm run test:app-look
 *
 * With STRUT_API_KEY set, so the page's every request passes the gate only
 * because strut answered it in process — the browser holds no key.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createStrut, type Strut } from "../createStrut.js";
import { createRegistry } from "../steps/registry.js";
import { defineStep, mediaOf } from "../core.js";
import { runSingleStep } from "../run-step.js";
import { WorkspaceManager } from "../workspace.js";
import { MemoryRunStore } from "../store.js";
import { kitForTests } from "../test-util/app-kit.js";
import { z } from "zod";

const WEB_DIST = join(dirname(new URL(import.meta.url).pathname), "..", "..", "web", "dist");
const skip = process.env["STRUT_TEST_APP_LOOK"] !== "1" ? "STRUT_TEST_APP_LOOK is not 1" : !existsSync(join(WEB_DIST, "index.html")) ? "the UI is not built (cd web && npm run build)" : false;

/** Who the page's calls ran as: what `step_run` handed the step. */
const whoami = defineStep({
  type: "test/whoami",
  description: "the actor the call ran as",
  input: z.object({}),
  async run(_cfg, ctx) {
    return { actor: ctx.actor ?? null };
  },
});

const MANIFEST = "title: Look demo\nicon: eye\ngrants:\n  workflows: [greet-wf]\n  steps: [test/whoami]\n";
const page = (label: string) => `import { useRuns, useStep } from "@strut/kit";
import { useEffect, useState } from "react";
export default function App() {
  const runs = useRuns("greet-wf");
  const who = useStep("test/whoami");
  const [actor, setActor] = useState("?");
  useEffect(() => { who.run({}).then((r: any) => setActor(String(r.actor))); }, []);
  return <main className="p-6"><h1>${label}</h1>
    <p>{runs.data ? runs.data.length + " runs, newest " + runs.data[0]?.status : "loading"}</p>
    <p>viewer: {actor}</p></main>;
}`;

let root: string;
let strut: Strut;
let saved: string | undefined;

before(async () => {
  if (skip) return;
  saved = process.env["STRUT_API_KEY"];
  process.env["STRUT_API_KEY"] = "look-key";
  root = await mkdtemp(join(tmpdir(), "strut-look-live-"));
  const workspace = new WorkspaceManager(join(root, "ws"));
  strut = await createStrut({
    workspace,
    store: new MemoryRunStore(),
    registry: await createRegistry([whoami]),
    kit: await kitForTests(),
    webDist: WEB_DIST,
    scheduler: false,
    enableMcp: true,
    enableChat: false,
    job: false,
    orchestrator: false,
    builder: false,
    browserWorkflows: false,
    privacyWorkflows: false,
  });
  await workspace.publishWorkflowByContent("greet-wf", "name: greet-wf\nsteps:\n  - id: say\n    type: log\n    config:\n      message: hi\n");
  await strut.run("greet-wf", {});
  const publish = async (name: string, files: Record<string, string>) => {
    const dir = await mkdtemp(join(root, "src-"));
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(join(dir, dirname(rel)), { recursive: true });
      await writeFile(join(dir, rel), text);
    }
    const r = await strut.apps.publish(dir, name, { surface: "person" });
    assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
  };
  await publish("look-demo", { "app.yaml": MANIFEST, "src/App.tsx": page("Version one") });
  await publish("look-demo", { "app.yaml": MANIFEST, "src/App.tsx": page("Version two") });
  await publish("look-broken", {
    "app.yaml": "title: Broken\nicon: bug\ngrants:\n  workflows: []\n  steps: []\n",
    "src/App.tsx": 'export default function App() { throw new Error("kaboom on render"); }',
  });
  await publish("look-deep", { "app.yaml": "title: Deep\nicon: link\ngrants:\n  workflows: []\n  steps: []\n", "src/App.tsx": DEEP });
});

/** An app with a page only a link reaches (`{ run }`), tabs only a click
 *  shows, and a filter only typing moves. */
const DEEP = `import { useToolInput } from "@strut/kit";
import { useState } from "react";
const AGENTS = ["drafter", "critic", "aggregator"];
export default function App() {
  const input = useToolInput<{ run?: string }>();
  const [tab, setTab] = useState("documents");
  const [filter, setFilter] = useState("");
  if (!input?.run) return <main className="p-6"><h1>Home page</h1></main>;
  const shown = AGENTS.filter((a) => a.includes(filter));
  return <main className="p-6"><h1>Run {input.run}</h1>
    <button onClick={() => setTab("documents")}>Documents</button>
    <button onClick={() => setTab("agents")}>Agents</button>
    {tab === "agents"
      ? <section><input placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <p>{shown.length} of {AGENTS.length} agents</p><ul>{shown.map((a) => <li key={a}>{a}</li>)}</ul></section>
      : <p>contract.pdf</p>}
  </main>;
}`;

after(async () => {
  if (skip) return;
  await strut?.close?.().catch(() => {});
  if (saved === undefined) delete process.env["STRUT_API_KEY"];
  else process.env["STRUT_API_KEY"] = saved;
  await rm(root, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const look = async (config: Record<string, unknown>): Promise<any> => {
  const res = await runSingleStep("app/look", strut.getRegistry(), strut.services, { config, actor: "evan-1", principal: "evan-1" });
  assert.equal(res.status, "success", res.error?.message);
  return res.output;
};

test("the live version, drawn with its data, as the run's person — and the model sees the shot", { skip }, async () => {
  const out = await look({ name: "look-demo" });
  assert.equal(out.version, "v2");
  assert.equal(out.rendered, true);
  assert.equal(out.hostError, undefined);
  assert.match(out.text, /Version two/);
  assert.match(out.text, /1 runs, newest success/, "a run/* read through the host and step_run");
  assert.match(out.text, /viewer: evan-1/, "the page's calls ran as the look's actor");
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.appErrors, []);
  const png = await readFile(join(out.dir, out.path));
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(mediaOf(out)?.[0]?.mediaType, "image/png");
});

test("a version by name, not the live one — how a held app's draft is seen", { skip }, async () => {
  const out = await look({ name: "look-demo", version: "v1" });
  assert.equal(out.version, "v1");
  assert.match(out.text, /Version one/);
});

test("a page that throws: the error boundary's report comes back", { skip }, async () => {
  const out = await look({ name: "look-broken" });
  assert.equal(out.rendered, true, "the boundary draws its fallback");
  assert.equal(out.appErrors[0]?.message, "kaboom on render");
  assert.ok(out.errors.some((e: string) => e.includes("kaboom on render")), out.errors.join("\n"));
});

test("an app or a version that is not there fails the step before a page opens", { skip }, async () => {
  for (const config of [{ name: "nope" }, { name: "look-demo", version: "v9" }]) {
    const res = await runSingleStep("app/look", strut.getRegistry(), strut.services, { config });
    assert.equal(res.status, "error");
    assert.match(res.error?.message ?? "", /not found|has no version v9/);
  }
});

/** An app directory in a job's folder, where a builder works on one. */
const jobApp = async (job: string, path: string, files: Record<string, string>): Promise<void> => {
  const dir = join(root, "ws", "jobs", job, path);
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, dirname(rel)), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
};

test("a directory, never published: built and looked at as a preview, its calls under its grants, no version recorded", { skip }, async () => {
  await jobApp("look-job", "apps/fresh", { "app.yaml": MANIFEST, "src/App.tsx": page("Not published yet") });
  const out = await look({ name: "look-fresh", path: "apps/fresh", job: "look-job" });
  assert.match(out.version, /^preview-[0-9a-f]{12}$/);
  assert.equal(out.rendered, true, out.hostError);
  assert.match(out.text, /Not published yet/);
  assert.match(out.text, /1 runs, newest success/, "a run/* read on the preview's own grants");
  assert.match(out.text, /viewer: evan-1/);
  assert.deepEqual(out.errors, []);
  assert.equal(await strut.workspace.getApp("look-fresh"), null, "nothing published");
  assert.equal(mediaOf(out)?.[0]?.mediaType, "image/png");
});

test("a directory that throws: the error boundary's report, on the preview's label; one that does not build opens nothing", { skip }, async () => {
  await jobApp("look-job", "apps/throws", {
    "app.yaml": "title: Throws\nicon: bug\ngrants:\n  workflows: []\n  steps: []\n",
    "src/App.tsx": 'export default function App() { throw new Error("kaboom in a draft"); }',
  });
  const out = await look({ name: "look-throws", path: "apps/throws", job: "look-job" });
  assert.equal(out.appErrors[0]?.message, "kaboom in a draft");
  await jobApp("look-job", "apps/broken-build", { "app.yaml": MANIFEST, "src/App.tsx": 'export default function App() { return <p>{eval("1")}</p>; }' });
  const bad = await look({ name: "look-bb", path: "apps/broken-build", job: "look-job" });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /calls eval/);
});

test("a deep link opens the page a person's link would, and the steps click, type and wait inside the app", { skip }, async () => {
  const home = await look({ name: "look-deep" });
  assert.match(home.text, /Home page/, "no link: the app's first page");
  const out = await look({
    name: "look-deep",
    input: { run: 12 },
    steps: [
      { do: "click", selector: "text=Agents" },
      { do: "fill", selector: "input[placeholder=Filter]", value: "agg" },
      { do: "scroll", y: 200 },
      { do: "wait", text: "1 of 3 agents" },
    ],
  });
  assert.equal(out.stopped, undefined, JSON.stringify(out.stopped));
  assert.match(out.text, /Run 12/, "the link's input reached the app, as a string");
  assert.match(out.text, /aggregator/);
  assert.doesNotMatch(out.text, /drafter|contract\.pdf/, "the click and the typing happened in the app's frame");
  assert.deepEqual(out.errors, []);
  assert.equal(mediaOf(out)?.[0]?.mediaType, "image/png");
});

test("a step that matches nothing is a result: stopped, named, and shot where the page got to", { skip }, async () => {
  const out = await look({
    name: "look-deep",
    input: { run: "7" },
    steps: [
      { do: "click", selector: "text=Agents" },
      { do: "click", selector: "text=Timeline", timeoutMs: 1_000 },
      { do: "click", selector: "text=Documents" },
    ],
  });
  assert.equal(out.stopped?.step, 2);
  assert.equal(out.stopped?.verb, "click");
  assert.match(out.stopped?.message ?? "", /Timeline/);
  assert.match(out.text, /drafter/, "the page as step 1 left it; step 3 never ran");
  const png = await readFile(join(out.dir, out.path));
  assert.equal(png.subarray(1, 4).toString(), "PNG");
});

test("a list a look cannot run fails the step before a page opens: a verb off the app, a ref", { skip }, async () => {
  for (const [steps, said] of [
    [[{ do: "goto", url: "https://example.com" }], /invalid|goto/i],
    [[{ do: "click", ref: "e3" }], /selector/],
    [[{ do: "click" }], /exactly one of ref or selector/],
  ] as const) {
    const res = await runSingleStep("app/look", strut.getRegistry(), strut.services, { config: { name: "look-deep", steps } });
    assert.equal(res.status, "error", JSON.stringify(steps));
    assert.match(res.error?.message ?? "", said);
  }
});
