// An app's files under a RELATIVE data dir (STRUT_WORKSPACE's default,
// `./workspace`): every path inside it must read as inside it. Before the
// root was resolved, each app file was a 400 and a look at an app showed
// "The app could not be loaded" (found by sphinx-voice#48's live check).
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { resolveAppPath } from "../steps/lib/app/_shared.js";
import { appFilePath, readAppFile } from "./files.js";

let dir: string;
/** `dir` as a path relative to the process's cwd, as `./workspace` is. */
let rel: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "strut-app-files-"));
  rel = relative(process.cwd(), dir);
  await writeFile(join(dir, "index.html"), "<p>hi</p>");
});
after(() => rm(dir, { recursive: true, force: true }));

describe("appFilePath", () => {
  it("takes a relative root: a file inside it is inside it", () => {
    assert.ok(!rel.startsWith("/"), "the root under test is relative");
    assert.equal(appFilePath(rel, "dist/index.html"), resolve(dir, "dist/index.html"));
    assert.equal(appFilePath(rel, "."), resolve(dir));
  });

  it("still refuses a path that leaves the root, relative or absolute", () => {
    for (const root of [rel, dir]) {
      assert.throws(() => appFilePath(root, "../outside.txt"), /escapes the app directory/);
      assert.throws(() => appFilePath(root, "/etc/passwd"), /escapes the app directory/);
    }
  });
});

describe("readAppFile", () => {
  it("reads a file under a relative root", async () => {
    const bytes = await readAppFile(rel, "index.html");
    assert.equal(new TextDecoder().decode(bytes!), "<p>hi</p>");
    assert.equal(await readAppFile(rel, "missing.html"), null);
  });
});

describe("resolveAppPath", () => {
  it("takes a relative data dir: an app folder inside it is inside it", async () => {
    const ctx = { services: { dataDir: rel } } as unknown as Parameters<typeof resolveAppPath>[0];
    assert.equal(await resolveAppPath(ctx, "app"), resolve(dir, "app"));
    await assert.rejects(() => resolveAppPath(ctx, "../elsewhere"), /leaves the data directory/);
  });
});
