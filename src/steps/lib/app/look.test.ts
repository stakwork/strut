/**
 * app/look's `saveAs` (./look.ts): the shot written into the app directory
 * for app.yaml's `screenshots`, never when the look shows nothing worth
 * keeping. The look itself needs a browser (src/apps/look.live.test.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import look, { saveShot } from "./look.js";
import { SCREENSHOT_MAX_BYTES } from "../../../apps/manifest.js";

describe("app/look saveAs", () => {
  it("takes a .png path inside the app, and only with a directory", () => {
    const ok = look.input.safeParse({ name: "desk", path: "app", saveAs: "public/screenshots/home.png" });
    assert.ok(ok.success);
    const message = (cfg: object) => {
      const r = look.input.safeParse({ name: "desk", ...cfg });
      return r.success ? "" : r.error.issues.map((i) => i.message).join("\n");
    };
    assert.match(message({ saveAs: "public/a.png" }), /needs `path`/);
    assert.match(message({ path: "app", saveAs: "../a.png" }), /inside the app directory/);
    assert.match(message({ path: "app", saveAs: "public/a.jpg" }), /\.png path/);
  });

  it("copies the shot into the app directory, or says why it saved nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "strut-look-save-"));
    try {
      const shot = join(root, "001.png");
      await writeFile(shot, "PNG");
      const app = join(root, "app");
      const drew = { rendered: true };
      assert.deepEqual(await saveShot(shot, app, "public/screenshots/home.png", drew), { saved: "public/screenshots/home.png" });
      assert.equal(await readFile(join(app, "public/screenshots/home.png"), "utf8"), "PNG");

      assert.deepEqual(await saveShot(shot, app, "public/b.png", { rendered: false }), { saveError: "not saved: the page drew nothing" });
      assert.match(JSON.stringify(await saveShot(shot, app, "public/b.png", { rendered: true, hostError: "no such app" })), /the host could not show the app \(no such app\)/);
      assert.match(JSON.stringify(await saveShot(shot, app, "public/b.png", { rendered: true, stopped: { message: "no element" } })), /stopped on a step \(no element\)/);
      await assert.rejects(readFile(join(app, "public/b.png")), "nothing written for a look that showed nothing");

      await writeFile(shot, Buffer.alloc(SCREENSHOT_MAX_BYTES + 1));
      const big = await saveShot(shot, app, "public/big.png", drew);
      assert.equal((big as { saved: string }).saved, "public/big.png");
      assert.match((big as { warning: string }).warning, /at most 2 MB/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
