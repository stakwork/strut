import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { artifactKind } from "./artifact-view";

describe("artifactKind", () => {
  it("maps the obvious file types by extension, case-insensitively", () => {
    assert.equal(artifactKind("/artifacts/1790358217624/report.md"), "markdown");
    assert.equal(artifactKind("/artifacts/1/out/shot.PNG"), "image");
    assert.equal(artifactKind("/artifacts/1/a.jpeg"), "image");
    assert.equal(artifactKind("/artifacts/1/clip.mp4"), "video");
    assert.equal(artifactKind("/artifacts/1/voice.wav"), "audio");
    assert.equal(artifactKind("/artifacts/1/paper.pdf"), "pdf");
    assert.equal(artifactKind("/artifacts/1/index.html"), "html");
    assert.equal(artifactKind("/artifacts/1/data.json"), "text");
    assert.equal(artifactKind("/artifacts/1/notes.txt"), "text");
  });

  it("is null for an unknown extension, no extension, or a dotfile", () => {
    assert.equal(artifactKind("/artifacts/1/model.bin"), null);
    assert.equal(artifactKind("/artifacts/1/archive.tar.gz"), null);
    assert.equal(artifactKind("/artifacts/1/README"), null);
    assert.equal(artifactKind("/artifacts/1/.env"), null);
    assert.equal(artifactKind("/artifacts/1/"), null);
  });
});
