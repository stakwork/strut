import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CAMERA_CAPABILITY, CAMERA_CAPTURE_METHOD, CAMERA_DEFAULT_SIDE, NO_CAMERA, cameraTitle, createBridgeCamera, parseCaptureParams } from "./index.js";

describe("the host's camera contract", () => {
  it("is available only when the host offers it; capture asks the host and answers a File, null when cancelled", async () => {
    const asked: Array<{ method: string; params?: Record<string, unknown> }> = [];
    let answer: unknown = { name: "doc.jpg", mediaType: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff]).toString("base64"), width: 3, height: 1 };
    const mk = (cap: unknown) =>
      createBridgeCamera({
        getHostCapabilities: () => (cap === undefined ? {} : { experimental: { [CAMERA_CAPABILITY]: cap } }),
        request: async (r) => (asked.push(r), answer),
      });
    const on = mk({ v: 1 });
    assert.equal(on.available(), true);
    const file = await on.capture({ title: "Fit the page" });
    assert.deepEqual(asked, [{ method: CAMERA_CAPTURE_METHOD, params: { title: "Fit the page" } }]);
    assert.equal(file?.name, "doc.jpg");
    assert.equal(file?.type, "image/jpeg");
    assert.deepEqual([...new Uint8Array(await file!.arrayBuffer())], [0xff, 0xd8, 0xff]);
    answer = { cancelled: true };
    assert.equal(await on.capture(), null);
    assert.equal(mk(undefined).available(), false);
    await assert.rejects(mk(undefined).capture(), /draws no camera/);
    assert.equal(NO_CAMERA.available(), false);
  });

  it("checks a page's params: facing, maxSide, title and nothing else", () => {
    assert.deepEqual(parseCaptureParams(undefined), { ok: true, params: { facing: "environment", maxSide: CAMERA_DEFAULT_SIDE } });
    assert.deepEqual(parseCaptureParams({ facing: "user", maxSide: 800, title: "Smile" }), { ok: true, params: { facing: "user", maxSide: 800, title: "Smile" } });
    assert.match((parseCaptureParams({ zoom: 2 }) as { error: string }).error, /unknown field "zoom"/);
    assert.match((parseCaptureParams({ facing: "back" }) as { error: string }).error, /facing/);
    assert.match((parseCaptureParams({ maxSide: 10_000 }) as { error: string }).error, /maxSide/);
    // A task's whole ask is often longer than the camera's line: cut, never refused.
    const long = parseCaptureParams({ title: `Visit Bean There at 412 Main St.\nTake 3 photos: ${"the counter and seating area, ".repeat(6)}` }) as { ok: true; params: { title: string } };
    assert.equal(long.ok, true);
    assert.equal(long.params.title.length, 120);
    assert.ok(long.params.title.startsWith("Visit Bean There at 412 Main St. Take 3 photos:") && long.params.title.endsWith("…"), long.params.title);
    assert.equal(cameraTitle("Fit the page"), "Fit the page");
    assert.match((parseCaptureParams({ title: 7 }) as { error: string }).error, /title is text/);
  });
});
