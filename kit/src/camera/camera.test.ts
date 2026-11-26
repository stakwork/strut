import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CAMERA_ACTIONS_MAX, CAMERA_CAPABILITY, CAMERA_CAPTURE_METHOD, CAMERA_DEFAULT_SIDE, NO_CAMERA, cameraTitle, createBridgeCamera, parseCaptureParams } from "./index.js";

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

  it("checks a page's params: facing, maxSide, title, review and nothing else", () => {
    assert.deepEqual(parseCaptureParams(undefined), { ok: true, params: { facing: "environment", maxSide: CAMERA_DEFAULT_SIDE, review: true } });
    assert.deepEqual(parseCaptureParams({ facing: "user", maxSide: 800, title: "Smile" }), { ok: true, params: { facing: "user", maxSide: 800, review: true, title: "Smile" } });
    // One tap a photo: the shutter hands it over, no Retake / Use photo.
    assert.deepEqual(parseCaptureParams({ title: "Page 12", review: false }), { ok: true, params: { facing: "environment", maxSide: CAMERA_DEFAULT_SIDE, review: false, title: "Page 12" } });
    assert.match((parseCaptureParams({ review: "no" }) as { error: string }).error, /review is true or false/);
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

  it("checks a page's actions: at most two { id, label }, label cut to one line, ids safe and unique", () => {
    const ok = parseCaptureParams({ actions: [{ id: "finish", label: "  Finish\nbook " }] }) as { ok: true; params: { actions: Array<{ id: string; label: string }> } };
    assert.deepEqual(ok.params.actions, [{ id: "finish", label: "Finish book" }]);
    assert.equal((parseCaptureParams({ actions: [] }) as { ok: true; params: object }).params.hasOwnProperty("actions"), false);
    assert.equal((parseCaptureParams({ actions: [{ id: "a", label: "x".repeat(60) }] }) as { ok: true; params: { actions: Array<{ label: string }> } }).params.actions[0]!.label.length, 24);
    const bad = (a: unknown) => (parseCaptureParams({ actions: a }) as { error?: string }).error;
    assert.match(bad(Array.from({ length: CAMERA_ACTIONS_MAX + 1 }, (_, n) => ({ id: `a${n}`, label: "x" })))!, /at most 2/);
    assert.match(bad("finish")!, /at most 2/);
    assert.match(bad([{ id: "Finish!", label: "x" }])!, /each action/);
    assert.match(bad([{ id: "a" }])!, /each action/);
    assert.match(bad([{ id: "a", label: "  " }])!, /not empty/);
    assert.match(bad([{ id: "a", label: "x" }, { id: "a", label: "y" }])!, /twice/);
  });

  it("captureOrAction tells an action from a cancel, and sends actions only to a host that draws them", async () => {
    const asked: Array<{ params?: Record<string, unknown> }> = [];
    let answer: unknown = { action: "finish" };
    const mk = (cap: unknown) => createBridgeCamera({ getHostCapabilities: () => ({ experimental: { [CAMERA_CAPABILITY]: cap } }), request: async (r) => (asked.push(r), answer) });
    const actions = [{ id: "finish", label: "Finish book" }];
    const withActions = mk({ v: 1, actions: true });
    assert.deepEqual(await withActions.captureOrAction({ title: "p.3", actions }), { action: "finish" });
    assert.deepEqual(asked[0]!.params, { title: "p.3", actions });
    // capture() keeps its File | null shape: an action's tap is no photo.
    assert.equal(await withActions.capture({ actions }), null);
    answer = { cancelled: true };
    assert.equal(await withActions.captureOrAction({ actions }), null);
    answer = { name: "p.jpg", mediaType: "image/jpeg", data: Buffer.from([1, 2]).toString("base64"), width: 1, height: 1 };
    const got = (await withActions.captureOrAction()) as { photo: File };
    assert.equal(got.photo.name, "p.jpg");
    // An older host (no `actions` in its capability) never sees the field.
    asked.length = 0;
    await mk({ v: 1 }).captureOrAction({ title: "t", actions });
    assert.deepEqual(asked[0]!.params, { title: "t" });
  });
});
