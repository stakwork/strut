// Custom domains at the origin (plans/public-surface.md §9): a host a public
// app lists gets that app alone at `/`; any other host gets what it did.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStrut } from "./createStrut.js";
import { WorkspaceManager } from "./workspace.js";
import { MemoryRunStore } from "./store.js";
import { createRegistry } from "./steps/registry.js";
import { kitForTests } from "./test-util/app-kit.js";
import { appOfDomain, normalizeSurface } from "./public-surface.js";

const PAGE = `<!doctype html><html><head><title>strut</title></head><body></body></html>`;

describe("appOfDomain", () => {
  it("finds the app that lists the host, and none for another", () => {
    const s = normalizeSurface({ apps: [{ name: "a", domains: ["a.example.com"] }, { name: "b", domains: ["b.example.com", "www.b.example.com"] }] });
    assert.equal(appOfDomain(s, "b.example.com"), "b");
    assert.equal(appOfDomain(s, "www.b.example.com"), "b");
    assert.equal(appOfDomain(s, "c.example.com"), undefined);
    assert.equal(appOfDomain(s, ""), undefined);
  });
});

describe("a custom domain at /", () => {
  let root: string;
  let strut: Awaited<ReturnType<typeof createStrut>>;
  let saved: string | undefined;
  const KEY = "domain-test-key";

  before(async () => {
    saved = process.env["STRUT_API_KEY"];
    process.env["STRUT_API_KEY"] = KEY;
    const kit = await kitForTests();
    root = await mkdtemp(join(tmpdir(), "strut-domain-"));
    await mkdir(join(root, "web"), { recursive: true });
    await writeFile(join(root, "web", "index.html"), PAGE);
    const workspace = new WorkspaceManager(join(root, "ws"));
    strut = await createStrut({
      // As a Stadeum box sets STRUT_PUBLIC_URL: a domain's links still name the domain.
      publicUrl: "https://strut.box.example",
      workspace, store: new MemoryRunStore(), registry: await createRegistry([]), kit, webDist: join(root, "web"), scheduler: false, views: false,
      job: false, orchestrator: false, builder: false, browserWorkflows: false, privacyWorkflows: false, mediaWorkflows: false,
    });
    const dir = join(root, "apps", "bench");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "app.yaml"), "title: Bench\ndescription: A bench.\n");
    await writeFile(join(dir, "src", "App.tsx"), "export default function App() { return <p>hi</p>; }\n");
    const r = await strut.apps.publish(dir, "bench", { surface: "person" });
    assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
    const put = await strut.app.request("/public-view", {
      method: "PUT",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ apps: [{ name: "bench", domains: ["bench.example.com"] }, { name: "gone", domains: ["gone.example.com"] }] }),
    });
    assert.equal(put.status, 200, await put.clone().text());
  });
  after(async () => {
    await strut?.close?.().catch(() => {});
    if (saved === undefined) delete process.env["STRUT_API_KEY"];
    else process.env["STRUT_API_KEY"] = saved;
    await rm(root, { recursive: true, force: true });
  });

  it("a listed host gets the app alone, with its title, its links on the domain; a forwarded host counts", async () => {
    for (const headers of [{ host: "bench.example.com", "x-forwarded-proto": "https" }, { host: "edge.internal", "x-forwarded-host": "Bench.Example.com:443", "x-forwarded-proto": "https" }]) {
      const html = await (await strut.app.request("/", { headers })).text();
      assert.match(html, /<meta name="strut-serve" content="bench" \/>/);
      assert.match(html, /<title>Bench<\/title>/);
      assert.match(html, /<meta name="description" content="A bench\." \/>/);
      assert.match(html, /<meta property="og:url" content="https:\/\/bench\.example\.com\/" \/>/);
    }
  });

  it("a listed app that cannot be read is nothing served, never strut's own UI", async () => {
    const html = await (await strut.app.request("/", { headers: { host: "gone.example.com" } })).text();
    assert.match(html, /<meta name="strut-serve" content="" \/>/);
    assert.match(html, /<title>strut<\/title>/);
  });

  it("another host gets the page as before; ?shell=1 with the key is strut's own UI", async () => {
    assert.doesNotMatch(await (await strut.app.request("/", { headers: { host: "other.example.com" } })).text(), /strut-serve/);
    const shell = await (await strut.app.request("/?shell=1", { headers: { host: "bench.example.com", authorization: `Bearer ${KEY}` } })).text();
    assert.doesNotMatch(shell, /strut-serve/);
  });
});
