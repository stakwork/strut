import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import { createStrut } from "../createStrut.js";
import { MemoryRunStore } from "../store.js";
import { FileWorkspaceStore } from "../workspace.js";
import { kitForTests } from "../test-util/app-kit.js";
import type { KitLocation } from "./kit.js";
import { applyScreenshots, screenshotsProblem, withScreenshots } from "./screenshots.js";

/** A 1×1 PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

let root: string;
let kit: KitLocation;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "strut-shots-"));
  kit = await kitForTests();
});
let n = 0;
async function appDir(files: Record<string, string | Buffer>): Promise<string> {
  const dir = join(root, `app-${++n}`);
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(join(dir, dirname(rel)), { recursive: true });
    await writeFile(join(dir, rel), body);
  }
  return dir;
}

describe("withScreenshots", () => {
  it("replaces only the screenshots key, comments and order kept", () => {
    const text = "# My app\ntitle: Desk # the name\nscreenshots:\n  - old.png\n  - file: b.png\n    caption: B\n\n# grants below\ngrants:\n  workflows: [a]\n";
    const out = withScreenshots(text, [{ file: "screenshots/1.png", caption: 'Say "hi"' }]);
    assert.equal(out, '# My app\ntitle: Desk # the name\nscreenshots:\n  - file: "screenshots/1.png"\n    caption: "Say \\"hi\\""\n\n# grants below\ngrants:\n  workflows: [a]\n');
  });

  it("adds the key at the end, and takes it out for an empty list", () => {
    assert.equal(withScreenshots("title: X\n", [{ file: "a.png" }]), 'title: X\nscreenshots:\n  - file: "a.png"\n');
    assert.equal(withScreenshots("title: X", [{ file: "a.png" }]), 'title: X\nscreenshots:\n  - file: "a.png"\n');
    assert.equal(withScreenshots("title: X\nscreenshots:\n- a.png\nicon: box\n", []), "title: X\nicon: box\n");
    assert.equal(withScreenshots("title: X\n", []), "title: X\n");
  });

  it("rewrites a manifest laid out some other way", () => {
    const out = withScreenshots("{ title: X, screenshots: [a.png] }\n", [{ file: "b.png" }]);
    assert.deepEqual(yaml.load(out), { title: "X", screenshots: [{ file: "b.png" }] });
  });
});

describe("screenshotsProblem", () => {
  it("checks the list's shape", () => {
    assert.equal(screenshotsProblem([{ file: "a.png" }, { data: PNG, type: "image/png", caption: "x" }]), undefined);
    assert.match(screenshotsProblem(undefined)!, /required/);
    assert.match(screenshotsProblem([{ file: "../a.png" }])!, /screenshots\[0\]/);
    assert.match(screenshotsProblem([{ data: PNG, type: "image/svg+xml" }])!, /type/);
    assert.match(screenshotsProblem([{ data: "A".repeat(3 * 1024 * 1024), type: "image/png" }])!, /over 2 MB/);
    assert.match(screenshotsProblem(Array.from({ length: 9 }, () => ({ file: "a.png" })))!, /at most 8/);
    assert.match(screenshotsProblem([{ file: "a.png", caption: "x".repeat(201) }])!, /caption/);
  });
});

describe("applyScreenshots", () => {
  it("writes new images into screenshots/, deletes dropped ones from there only, and names them in app.yaml", async () => {
    const dir = await appDir({
      "app.yaml": "title: Desk\nscreenshots:\n  - screenshots/1.png\n  - public/logo.png\n  - screenshots/2.png\n",
      "screenshots/1.png": Buffer.from(PNG, "base64"),
      "screenshots/2.png": Buffer.from(PNG, "base64"),
      "public/logo.png": Buffer.from(PNG, "base64"),
    });
    const list = await applyScreenshots(dir, [
      { data: PNG, type: "image/png", caption: " New " },
      { file: "screenshots/2.png", caption: "Kept" },
    ]);
    // 1.png is still on disk while the list is written, so the new one is 3.png.
    assert.deepEqual(list, [{ file: "screenshots/3.png", caption: "New" }, { file: "screenshots/2.png", caption: "Kept" }]);
    assert.ok(existsSync(join(dir, "screenshots/3.png")));
    assert.ok(!existsSync(join(dir, "screenshots/1.png")), "dropped from screenshots/");
    assert.ok(existsSync(join(dir, "public/logo.png")), "never deleted outside screenshots/");
    assert.deepEqual((yaml.load(await readFile(join(dir, "app.yaml"), "utf8")) as { screenshots: unknown }).screenshots, list);
  });
});

describe("the /apps/:name/screenshots routes", () => {
  it("read the list, save a new one as a version, and refuse a bad one", async () => {
    const dataDir = join(root, `strut-${++n}`);
    const strut = await createStrut({ workspace: new FileWorkspaceStore(dataDir), store: new MemoryRunStore(), kit, scheduler: false, enableChat: false, serveUi: false, views: false, earnings: false });
    const json = { "content-type": "application/json" };
    const post = await strut.app.request("/apps", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        name: "desk",
        files: {
          "app.yaml": "title: Desk # keep me\n",
          "src/App.tsx": 'export default function App() { return <p className="p-2">hi</p>; }\n',
        },
      }),
    });
    assert.equal(post.status, 201, await post.text());

    const read = async (version?: string) =>
      (await (await strut.app.request(`/apps/desk/screenshots${version ? `?version=${version}` : ""}`)).json()) as { version: string; screenshots: unknown[] };
    assert.deepEqual(await read(), { name: "desk", version: "v1", screenshots: [] });

    const put = (body: unknown) => strut.app.request("/apps/desk/screenshots", { method: "PUT", headers: json, body: JSON.stringify(body) });
    const saved = await put({ screenshots: [{ data: PNG, type: "image/png", caption: "Home" }] });
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.equal(((await saved.json()) as { version: string }).version, "v2");
    assert.deepEqual(await read(), { name: "desk", version: "v2", screenshots: [{ file: "screenshots/1.png", caption: "Home" }] });
    const yamlText = await (await strut.app.request("/apps/desk/v2/files/app.yaml")).text();
    assert.match(yamlText, /^title: Desk # keep me\n/);
    assert.equal((await strut.app.request("/apps/desk/v2/files/screenshots/1.png")).status, 200);

    // Taken off: the app is v1's files again, so v1 is live again.
    const cleared = await put({ screenshots: [] });
    assert.equal(((await cleared.json()) as { version: string }).version, "v1");
    assert.deepEqual((await read()).screenshots, []);
    assert.equal((await strut.app.request("/apps/desk/v1/files/screenshots/1.png")).status, 404);

    assert.equal((await put({ screenshots: [{ file: "nope.png" }] })).status, 400, "a file the app does not have fails the build");
    assert.equal((await put({})).status, 400);
    assert.equal((await strut.app.request("/apps/other/screenshots", { method: "PUT", headers: json, body: JSON.stringify({ screenshots: [] }) })).status, 404);
    assert.equal((await strut.app.request("/apps/strut%2Fviews/screenshots", { method: "PUT", headers: json, body: JSON.stringify({ screenshots: [] }) })).status, 400);
    await strut.close();
  });
});
