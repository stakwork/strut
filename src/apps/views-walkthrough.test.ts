// strut/views' WalkthroughPlayer: its pure moves (which frame shows, what
// Play does, the step bar, a key's step, the filmstrip's scroll) and the
// gallery's recording as the fixture client serves it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { artifactRel, parseWalkthrough } from "@strut/kit/folds";
import {
  STEP_MS, frameIndex, keyStep, pickFrame, playBeat, playFrom, servedPath, statusText, stepSegments, stripScroll,
} from "./views/src/lib/walkthrough-player.js";
import { createFixtureClient } from "./views/src/fixtures/client.js";

describe("strut/views — WalkthroughPlayer: which frame shows", () => {
  it("follows the newest frame until one is picked, and stays within the frames", () => {
    assert.equal(frameIndex(null, 4), 3);
    assert.equal(frameIndex(null, 6), 5, "a frame more: the newest still");
    assert.equal(frameIndex(1, 6), 1, "picked: it stays");
    assert.equal(frameIndex(9, 3), 2);
    assert.equal(frameIndex(-2, 3), 0);
    assert.equal(frameIndex(null, 0), 0);
    assert.equal(frameIndex(null, 4, false), 0, "a finished recording opens on frame 1");
    assert.equal(frameIndex(2, 4, false), 2);
  });

  it("picking the newest frame of a recording still being made follows again; anything else holds", () => {
    assert.equal(pickFrame(3, 4, true), null);
    assert.equal(pickFrame(2, 4, true), 2);
    assert.equal(pickFrame(3, 4, false), 3, "a finished recording: no newer frame to follow");
  });
});

describe("strut/views — WalkthroughPlayer: play", () => {
  it("plays from where the reader is, and from frame 1 at the end", () => {
    assert.equal(STEP_MS, 800);
    assert.equal(playFrom(1, 5), 1);
    assert.equal(playFrom(4, 5), 0);
    assert.equal(playFrom(0, 1), 0);
  });

  it("each beat shows the next frame and stops on the last", () => {
    assert.deepEqual(playBeat(0, 4), { at: 1, playing: true });
    assert.deepEqual(playBeat(2, 4), { at: 3, playing: false });
    assert.deepEqual(playBeat(3, 4), { at: 3, playing: false });
    let i = playFrom(3, 4);
    const shown = [i];
    for (let playing = true; playing; ) ({ at: i, playing } = playBeat(i, 4)), shown.push(i);
    assert.deepEqual(shown, [0, 1, 2, 3]);
  });
});

describe("strut/views — WalkthroughPlayer: controls", () => {
  it("← and → step one frame, held at the ends; other keys are not the player's", () => {
    assert.equal(keyStep("ArrowRight", 1, 4), 2);
    assert.equal(keyStep("ArrowLeft", 1, 4), 0);
    assert.equal(keyStep("ArrowLeft", 0, 4), 0);
    assert.equal(keyStep("ArrowRight", 3, 4), 3);
    for (const k of ["ArrowUp", " ", "Enter", "a"]) assert.equal(keyStep(k, 1, 4), null, k);
  });

  it("the step bar: a segment between each frame and the next, the blues alternating, the ones ahead faded", () => {
    assert.deepEqual(stepSegments(4, 1), [
      { dark: true, ahead: false },
      { dark: false, ahead: true },
      { dark: true, ahead: true },
    ]);
    assert.ok(stepSegments(4, 3).every((s) => !s.ahead), "at the last frame nothing is ahead");
    assert.deepEqual(stepSegments(1, 0), []);
    assert.deepEqual(stepSegments(0, 0), []);
  });

  it("the filmstrip scrolls only as far as the frame shown needs", () => {
    assert.equal(stripScroll(100, 96, 0, 400), 0, "in view");
    assert.equal(stripScroll(500, 96, 0, 400), 196, "past the right edge: brought in at the right");
    assert.equal(stripScroll(50, 96, 200, 400), 50, "left of the view: brought in at the left");
    assert.equal(stripScroll(0, 600, 100, 400), 0, "wider than the strip: its start");
  });

  it("says a manifest's status in words, an unknown one as written", () => {
    assert.equal(statusText("recording"), "Recording…");
    assert.equal(statusText("stopped"), "Stopped");
    assert.equal(statusText("paused"), "paused");
  });
});

describe("strut/views — WalkthroughPlayer: the gallery's recording", () => {
  it("a run-relative manifest is served under the run; a served one stays", () => {
    assert.equal(servedPath("walkthrough/walkthrough.json", "1790"), "/artifacts/1790/walkthrough/walkthrough.json");
    assert.equal(servedPath("/jobs/j/files/w/walkthrough.json", "1790"), "/jobs/j/files/w/walkthrough.json");
  });

  it("each frame resolves to a file the fixture client serves through run/files", async () => {
    const client = createFixtureClient({ latencyMs: 0 });
    const args = { workflow: "research", runId: "1790000000100" };
    const manifest = await client.run<{ text: string }>("run/files", { ...args, path: "walkthrough/walkthrough.json" });
    const w = parseWalkthrough(manifest.text, servedPath("walkthrough/walkthrough.json", args.runId));
    assert.ok(w);
    assert.equal(w.frames.length, 3);
    for (const f of w.frames) {
      const file = await client.run<{ base64?: string } | null>("run/files", { ...args, path: artifactRel(f.path) });
      assert.ok(file?.base64, f.path);
    }
  });
});

describe("ZoomImage's steps", async () => {
  const { zoomStep } = await import("./views/src/lib/zoom.js");
  it("from fit, in is 100% and out is 50%; then a step at a time, held at 25% and 400%", () => {
    assert.equal(zoomStep(null, 1), 1);
    assert.equal(zoomStep(null, -1), 0.5);
    assert.equal(zoomStep(1, 1), 1.5);
    assert.equal(zoomStep(1, -1), 0.75);
    assert.equal(zoomStep(4, 1), 4);
    assert.equal(zoomStep(0.25, -1), 0.25);
  });
});
