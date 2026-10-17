/**
 * The browser workflows strut ships (seed.ts) and the browser service
 * createStrut builds: what boot seeds, what each workflow may name, who
 * owns the service and when a run's contexts close.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createRegistry } from "../steps/registry.js";
import { validateWorkflowYaml } from "../validate.js";
import { WorkspaceManager, flowFromYaml } from "../workspace.js";
import { walkSteps } from "../closure.js";
import { createStrut } from "../createStrut.js";
import { MemoryRunStore } from "../store.js";
import { BrowserService } from "./service.js";
import { BROWSER_CATEGORY, BROWSER_WORKFLOWS } from "./seed.js";

const quiet = { serveUi: false, enableChat: false, scheduler: false, stt: false as const, store: new MemoryRunStore() };

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "strut-browser-seed-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Run `fn` with `BROWSER_*` set as given, every other BROWSER_* unset. */
async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(process.env).filter((k) => k.startsWith("BROWSER_")).map((k) => [k, process.env[k]]));
  for (const k of Object.keys(saved)) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

const NAMES = Object.keys(BROWSER_WORKFLOWS);

describe("the browser workflows strut ships", () => {
  it("each is a valid workflow over strut's own registry, and every step it names is a strut step", async () => {
    const registry = await createRegistry([]);
    assert.deepEqual(NAMES, ["browser-capture", "browser-explore", "browser-captcha", "browser-watch"]);
    for (const name of NAMES) {
      const text = await readFile(new URL(`../workflows/${name}.yaml`, import.meta.url), "utf-8");
      const v = validateWorkflowYaml(text, { registry });
      assert.equal(v.ok, true, `${name}: ${JSON.stringify(v.errors, null, 2)}`);
      const flow = flowFromYaml(name, "v1", text);
      assert.equal(flow.name, name);
      const types = new Set<string>();
      walkSteps(flow.steps, (s) => void types.add(s.type));
      for (const t of types) assert.ok(registry[t], `${name} names ${t}, which strut lacks`);
    }
  });

  it("createStrut seeds them in the browser category, once; a reboot is a no-op, a workspace edit stays active; `browserWorkflows: false` seeds none", async () => {
    await withDir(async (dir) => {
      const ws = () => new WorkspaceManager(dir);
      const a = await createStrut({ workspace: ws(), ...quiet });
      for (const name of NAMES) {
        const meta = await a.workspace.getWorkflowMetadata(name);
        assert.ok(meta, `${name} seeded`);
        assert.equal(meta.active, "v1");
        assert.equal(meta.category, BROWSER_CATEGORY);
        assert.equal(meta.versions["v1"]?.description, BROWSER_WORKFLOWS[name]);
      }
      const capture = await a.workspace.getWorkflowSource("browser-capture", "v1");
      await a.workspace.publishWorkflow("browser-capture", "v2", capture.replace("wait: \"{{ input.wait }}\"", "wait: 500"));

      const b = await createStrut({ workspace: ws(), ...quiet });
      const meta = await b.workspace.getWorkflowMetadata("browser-capture");
      assert.deepEqual(Object.keys(meta!.versions).sort(), ["v1", "v2"], "nothing new published");
      assert.equal(meta!.active, "v2", "the workspace's edit stays active");
    });
    await withDir(async (dir) => {
      const off = await createStrut({ workspace: new WorkspaceManager(dir), ...quiet, browserWorkflows: false });
      for (const name of NAMES) assert.equal(await off.workspace.getWorkflowMetadata(name), null, "`browserWorkflows: false` seeds nothing");
    });
  });
});

describe("the browser service createStrut builds", () => {
  it("is built from BROWSER_* and closes a run's contexts when the run ends; close() drops the connection", async () => {
    await withDir(async (dir) => {
      const strut = await withEnv({ BROWSER_WS_URL: "ws://browser:3000", BROWSER_WS_PATH: "p", BROWSER_VIEWPORT: "800x600" }, () =>
        createStrut({ workspace: new WorkspaceManager(dir), ...quiet }),
      );
      const browser = strut.services.browser;
      assert.ok(browser instanceof BrowserService);
      assert.deepEqual(browser.viewport, { width: 800, height: 600 });
      const disposed: string[] = [];
      browser.dispose = async (runId: string) => void disposed.push(runId);
      let closed = 0;
      browser.close = async () => void closed++;

      const r = await strut.run({ name: "hello", input: z.any(), steps: [{ id: "p", type: "pack", config: { a: 1 } }] }, {});
      assert.equal(r.status, "success");
      assert.deepEqual(disposed, [r.runId], "the run's browser is disposed by the run-end teardown");
      await strut.close();
      assert.equal(closed, 1);
    });
  });

  it("a host's own browser wins, its teardown its own; a bad BROWSER_* value is a warning, never a failed boot", async () => {
    await withDir(async (dir) => {
      const own = new BrowserService();
      const mine = await createStrut({ workspace: new WorkspaceManager(dir), ...quiet, services: { browser: own } });
      assert.equal(mine.services.browser, own);
      const disposed: string[] = [];
      own.dispose = async (runId: string) => void disposed.push(runId);
      await mine.run({ name: "hello", input: z.any(), steps: [{ id: "p", type: "pack", config: {} }] }, {});
      assert.deepEqual(disposed, [], "strut never tears down a browser it did not build");

      const warned: unknown[] = [];
      const warn = console.warn;
      console.warn = (...args: unknown[]) => void warned.push(args.join(" "));
      try {
        const bad = await withEnv({ BROWSER_VIEWPORT: "wide" }, () => createStrut({ workspace: new WorkspaceManager(dir), ...quiet }));
        assert.equal(bad.services.browser, undefined);
        assert.ok(warned.some((w) => /no browser service.*WIDTHxHEIGHT/.test(String(w))), JSON.stringify(warned));
      } finally {
        console.warn = warn;
      }
    });
  });
});
