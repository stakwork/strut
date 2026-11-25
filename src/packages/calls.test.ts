/**
 * `calls:` in strut.yaml (stadeum plans/call-canvas.md §8): what a group
 * call on the box records onto — the scribe's job kind, a Concept page the
 * package ships, and the app Jamie's screen shows, one of its apps. The
 * manifest key, the install's refusal of a kind or an app the package does
 * not ship, and `GET /packages` listing it with the app's full name.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { KitLocation } from "../apps/kit.js";
import { createStrut, type Strut } from "../createStrut.js";
import { MemoryRunStore } from "../store.js";
import { kitForTests } from "../test-util/app-kit.js";
import { WorkspaceManager } from "../workspace.js";
import { readPackage } from "./format.js";
import type { InstalledPackage } from "./installed.js";

const PKG = "acme/notes";

const files = (calls: string): Record<string, string> => ({
  "strut.yaml": `package: ${PKG}\nversion: 0.1.0\n${calls}`,
  "concepts/Call Notes.md": "---\ndescription: How the scribe writes a call down\n---\nOne note per decision.\n",
  "apps/board/app.yaml": "title: Board\n",
  "apps/board/src/App.tsx": "export default () => null;\n",
  "workflows/tidy.yaml": `name: ${PKG}/tidy\nsteps:\n  - { id: say, type: log, config: { message: tidy } }\n`,
});
const CALLS = "calls:\n  kind: Call Notes\n  app: board\n";

let root: string;
async function writeTree(tree: Record<string, string>): Promise<string> {
  const dir = join(root, "src", crypto.randomUUID());
  for (const [rel, text] of Object.entries(tree)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "strut-calls-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const refusal = async (tree: Record<string, string>): Promise<string> => {
  try {
    await readPackage(await writeTree(tree));
  } catch (e) {
    return (e as Error).message;
  }
  assert.fail("read");
};

describe("strut.yaml's calls: key (readPackage)", () => {
  it("resolves the app to its full name and keeps the kind; absent when the package has none", async () => {
    assert.deepEqual((await readPackage(await writeTree(files(CALLS)))).calls, { kind: "Call Notes", app: `${PKG}/board` });
    assert.equal((await readPackage(await writeTree(files("")))).calls, undefined);
  });

  it("refuses a kind that is not a page of the package, an app that is not one of its apps, a key it does not know, a part left out", async () => {
    assert.match(await refusal(files("calls:\n  kind: Meeting Notes\n  app: board\n")), /^bad_package: strut\.yaml: calls\.kind: "Meeting Notes" is not a Concept page of the package/);
    assert.match(await refusal(files("calls:\n  kind: Call Notes\n  app: canvas\n")), /^bad_package: strut\.yaml: calls\.app: "canvas" is not an app of the package/);
    assert.match(await refusal(files(`calls:\n  kind: Call Notes\n  app: ${PKG}/board\n`)), /calls\.app: "acme\/notes\/board" is not an app of the package — name one of its apps by its folder/);
    assert.match(await refusal(files("calls:\n  kind: Call Notes\n  app: board\n  screen: true\n")), /calls: Unrecognized key/);
    assert.match(await refusal(files("calls:\n  kind: Call Notes\n")), /calls\.app: /);
  });

  it("is not a bundle's", async () => {
    const bundle = { "strut.yaml": `package: acme/all\nversion: '1'\nbundle:\n  - git+https://github.com/acme/notes@main\n${CALLS}` };
    assert.match(await refusal(bundle), /calls: a bundle lists packages and has no calls of its own/);
  });
});

describe("a package's calls on GET /packages", () => {
  let kit: KitLocation;
  let strut: Strut;
  let saved: string | undefined;
  before(async () => {
    kit = await kitForTests();
    saved = process.env["STRUT_API_KEY"];
    delete process.env["STRUT_API_KEY"];
  });
  after(() => {
    if (saved !== undefined) process.env["STRUT_API_KEY"] = saved;
  });
  beforeEach(async () => {
    strut = await createStrut({
      workspace: new WorkspaceManager(join(root, "workspace")),
      store: new MemoryRunStore(),
      dataDir: join(root, "data"),
      kit,
      serveUi: false,
      scheduler: false,
      enableChat: false,
      systemWorkflows: false,
      browserWorkflows: false,
      privacyWorkflows: false,
      mediaWorkflows: false,
      job: false,
      orchestrator: false,
      builder: false,
      views: false,
      concepts: false,
      stt: false,
    });
  });
  afterEach(async () => {
    await strut.close?.();
  });
  const install = async (tree: Record<string, string>) => {
    const res = await strut.app.request("/packages/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref: `file:${await writeTree(tree)}` }) });
    return { status: res.status, body: (await res.json()) as { error?: string } };
  };
  const listed = async () => ((await (await strut.app.request("/packages")).json()) as { packages: InstalledPackage[] }).packages.find((p) => p.package === PKG);

  it("lists the kind and the app by its full name; an install whose kind the package does not ship fails and writes nothing", async () => {
    const bad = await install(files("calls:\n  kind: Meeting Notes\n  app: board\n"));
    assert.equal(bad.status, 400);
    assert.match(bad.body.error!, /^bad_package: strut\.yaml: calls\.kind: "Meeting Notes"/);
    assert.equal(await listed(), undefined);

    const ok = await install(files(CALLS));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual((await listed())!.calls, { kind: "Call Notes", app: `${PKG}/board` });
  });

  it("has none for a package that declares none", async () => {
    assert.equal((await install(files(""))).status, 201);
    const p = (await listed())!;
    assert.ok(p.digest);
    assert.equal("calls" in p, false);
  });

  it("has none once the package is uninstalled and only a fork of its app is left: it records nothing", async () => {
    assert.equal((await install(files(CALLS))).status, 201);
    const draft = join(root, "draft");
    await mkdir(join(draft, "src"), { recursive: true });
    await writeFile(join(draft, "app.yaml"), "title: Our board\n");
    await writeFile(join(draft, "src", "App.tsx"), "export default () => null; // ours\n");
    const forked = await strut.apps.publish(draft, `${PKG}/board`, { surface: "person" });
    assert.ok(forked.ok, forked.ok ? "" : forked.errors.join("\n"));
    assert.deepEqual((await listed())!.calls, { kind: "Call Notes", app: `${PKG}/board` }, "installed, with a fork of its app");

    assert.equal((await strut.app.request(`/packages/${PKG}`, { method: "DELETE" })).status, 200);
    const left = (await listed())!;
    assert.deepEqual(left.items.map((i) => [i.name, i.modified]), [[`${PKG}/board`, true]], "the fork stays");
    assert.equal("calls" in left, false);
  });
});
