import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appFileUrl, installAppFiles, installFileFetch, setAppFiles } from "./files.js";

/**
 * An app's files by path (plans/app-files-by-path.md): the table the build
 * makes of `public/`, `appFileUrl` over it, and the `fetch` that answers its
 * paths and hands everything else to the real one.
 */

const TABLE = {
  "/models/fox.vox": "data:application/octet-stream;base64,Zm94",
  "/docs/my file.txt": "data:text/plain,spaced",
};

/** A window whose `fetch` records what it was asked. */
function fakeWindow() {
  const calls: Array<{ input: unknown; init?: RequestInit }> = [];
  const real = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, ...(init ? { init } : {}) });
    return new Response("real");
  };
  return { win: { fetch: real as typeof fetch }, real, calls };
}

afterEach(() => setAppFiles({}));

describe("appFileUrl", () => {
  it("names a file of public/ with or without a leading / or ./, a query or hash ignored; anything else is undefined", () => {
    setAppFiles(TABLE);
    for (const p of ["/models/fox.vox", "models/fox.vox", "./models/fox.vox", "/models/fox.vox?v=2", "models/fox.vox#top"]) {
      assert.equal(appFileUrl(p), TABLE["/models/fox.vox"], p);
    }
    for (const p of ["/models/wolf.vox", "https://cdn.test/models/fox.vox", "/models", "toString", "/__proto__"]) assert.equal(appFileUrl(p), undefined, p);
  });
});

describe("the fetch of a path", () => {
  it("a GET of a path in the table — a string as written, a Request or URL by its pathname, encoded or not — fetches its data URL", async () => {
    setAppFiles(TABLE);
    const { win, calls } = fakeWindow();
    installFileFetch(win);
    await win.fetch("/models/fox.vox");
    await win.fetch("models/fox.vox?cache=1");
    await win.fetch(new Request("https://host.test/models/fox.vox"));
    await win.fetch(new URL("https://host.test/docs/my%20file.txt"));
    await win.fetch("/models/fox.vox", { method: "HEAD" });
    assert.deepEqual(calls.map((c) => c.input), [TABLE["/models/fox.vox"], TABLE["/models/fox.vox"], TABLE["/models/fox.vox"], TABLE["/docs/my file.txt"], TABLE["/models/fox.vox"]]);
    assert.equal(calls[4]!.init?.method, "HEAD");
  });

  it("anything else goes to the real fetch as it was asked: another path, a URL with a scheme, a data: URL, a write", async () => {
    setAppFiles(TABLE);
    const { win, calls } = fakeWindow();
    installFileFetch(win);
    const post = { method: "POST", body: "x" };
    await win.fetch("/nope.json");
    await win.fetch("https://cdn.test/models/fox.vox");
    await win.fetch("data:text/plain,hi");
    await win.fetch("/models/fox.vox", post);
    const req = new Request("https://host.test/models/fox.vox", { method: "PUT", body: "x" });
    await win.fetch(req);
    assert.deepEqual(calls.map((c) => c.input), ["/nope.json", "https://cdn.test/models/fox.vox", "data:text/plain,hi", "/models/fox.vox", req]);
    assert.equal(calls[3]!.init, post);
  });

  it("an empty table wraps nothing; the uninstall puts the real fetch back", () => {
    const { win, real } = fakeWindow();
    installFileFetch(win)();
    assert.equal(win.fetch, real, "no table, no wrapper");
    setAppFiles(TABLE);
    const uninstall = installFileFetch(win);
    assert.notEqual(win.fetch, real);
    uninstall();
    assert.equal(win.fetch, real);
  });

  it("installAppFiles keeps the table and answers its paths with the platform's own fetch of the data URL", async () => {
    const win = { fetch: globalThis.fetch.bind(globalThis) };
    const uninstall = installAppFiles({ "/hello.txt": "data:text/plain,hello%20there" }, win);
    try {
      assert.equal(appFileUrl("/hello.txt"), "data:text/plain,hello%20there");
      const res = await win.fetch("/hello.txt");
      assert.ok(res.ok);
      assert.equal(await res.text(), "hello there");
    } finally {
      uninstall();
    }
  });
});
