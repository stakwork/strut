import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { artifactKind, artifactLabel, findArtifacts, isArtifactPath } from "./artifact-view";

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

describe("isArtifactPath", () => {
  it("accepts a run's artifact path and a job's file path, nothing else", () => {
    assert.equal(isArtifactPath("/artifacts/1790/report.md"), true);
    assert.equal(isArtifactPath("/jobs/job-1/files/plan.md"), true);
    assert.equal(isArtifactPath("artifacts/1790/report.md"), false);
    assert.equal(isArtifactPath("https://x/artifacts/1/a.md"), false);
    assert.equal(isArtifactPath(42), false);
    assert.equal(isArtifactPath(null), false);
  });
});

describe("artifactLabel", () => {
  it("drops the serving prefix, keeping the path within the run or job", () => {
    assert.equal(artifactLabel("/artifacts/1790883384481/systemmap/report.json"), "systemmap/report.json");
    assert.equal(artifactLabel("/artifacts/1/one.png"), "one.png");
    assert.equal(artifactLabel("/jobs/job-1/files/notes/plan.md"), "notes/plan.md");
  });

  it("keeps the whole path when nothing follows the prefix", () => {
    assert.equal(artifactLabel("/artifacts/1/"), "/artifacts/1/");
    assert.equal(artifactLabel("/jobs/job-1"), "/jobs/job-1");
  });
});

describe("findArtifacts", () => {
  it("finds the paths in an object's fields", () => {
    assert.deepEqual(
      findArtifacts({
        report_json: "/artifacts/1790883384481/systemmap/report.json",
        report_md: "/artifacts/1790883384481/systemmap/report.md",
      }),
      ["/artifacts/1790883384481/systemmap/report.json", "/artifacts/1790883384481/systemmap/report.md"],
    );
  });

  it("finds the paths in an array, and in objects inside an array", () => {
    assert.deepEqual(findArtifacts(["/artifacts/1/one.png", "/artifacts/1/two.jpg"]), ["/artifacts/1/one.png", "/artifacts/1/two.jpg"]);
    assert.deepEqual(findArtifacts([{ link: "/artifacts/1/a.md" }, { link: "/jobs/j/files/b.md" }]), ["/artifacts/1/a.md", "/jobs/j/files/b.md"]);
  });

  it("walks nested values, a bare string included, and ignores everything else", () => {
    assert.deepEqual(findArtifacts("/artifacts/1/a.md"), ["/artifacts/1/a.md"]);
    assert.deepEqual(
      findArtifacts({ ok: true, n: 3, note: "see the report", inner: { deep: { file: "/artifacts/1/a.md" } }, none: null }),
      ["/artifacts/1/a.md"],
    );
    assert.deepEqual(findArtifacts({ a: 1, b: ["x", { c: "y" }] }), []);
    assert.deepEqual(findArtifacts(null), []);
    assert.deepEqual(findArtifacts("plain text"), []);
  });

  it("dedupes a path named twice, keeping first-seen order", () => {
    assert.deepEqual(
      findArtifacts({ first: "/artifacts/1/b.md", second: "/artifacts/1/a.md", again: "/artifacts/1/b.md" }),
      ["/artifacts/1/b.md", "/artifacts/1/a.md"],
    );
  });

  it("is bounded: stops below a deep nest and caps the count", () => {
    let deep: unknown = "/artifacts/1/deep.md";
    for (let i = 0; i < 12; i++) deep = { deep };
    assert.deepEqual(findArtifacts(deep), []);
    const many = Array.from({ length: 100 }, (_, i) => `/artifacts/1/${i}.png`);
    assert.equal(findArtifacts(many).length, 40);
  });
});
