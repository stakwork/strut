import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  artifactKind, artifactLabel, artifactRel, directoryEntries, fileScopeOf, findArtifacts, isArtifactPath,
  isDirectory, resolveArtifactLink, viewerKind,
} from "./artifact-view";

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

describe("fileScopeOf / artifactRel", () => {
  it("names the listing a served path reads from, and the path within it", () => {
    assert.equal(fileScopeOf("/artifacts/1790/chapters/README.md"), "/artifacts/1790");
    assert.equal(fileScopeOf("/jobs/job-1/files/notes/plan.md"), "/jobs/job-1/files");
    assert.equal(fileScopeOf("/jobs/job-1"), null);
    assert.equal(fileScopeOf("https://x/artifacts/1/a.md"), null);
    assert.equal(artifactRel("/artifacts/1790/chapters/README.md"), "chapters/README.md");
    assert.equal(artifactRel("/artifacts/1790/book/"), "book");
    assert.equal(artifactRel("/artifacts/1790/"), "");
    assert.equal(artifactRel("/artifacts/1790"), "");
    assert.equal(artifactRel("/jobs/job-1/files/plan.md"), "plan.md");
    assert.equal(artifactRel("plan.md"), null);
  });
});

// The heidelberg run's shape: a zip and a script at the root, a folder with
// two files and volume folders of chapters.
const BOOK = [
  "book.zip",
  "book/corrections.json",
  "book/manifest.json",
  "book/grimm1900bd1_1/01-Titelblatt.md",
  "book/grimm1900bd1_1/README.md",
  "book/grimm1900bd1_2/01-Titelblatt.md",
  "exec-build.py",
];

describe("isDirectory / viewerKind", () => {
  it("is a directory when the listing has files under it, with or without the slash", () => {
    assert.equal(isDirectory(BOOK, "/artifacts/1/book/"), true);
    assert.equal(isDirectory(BOOK, "/artifacts/1/book"), true);
    assert.equal(isDirectory(BOOK, "/artifacts/1/book/grimm1900bd1_1"), true);
    assert.equal(isDirectory(BOOK, "/artifacts/1/"), true);
    assert.equal(isDirectory(BOOK, "/jobs/j/files/book"), true);
  });

  it("is not one for a file, a name that is only a prefix of a folder, or a path outside a scope", () => {
    assert.equal(isDirectory(BOOK, "/artifacts/1/book.zip"), false);
    assert.equal(isDirectory(BOOK, "/artifacts/1/boo"), false);
    assert.equal(isDirectory(BOOK, "/artifacts/1/nope/"), false);
    assert.equal(isDirectory(BOOK, "book"), false);
  });

  it("viewerKind is the extension's kind, else directory from the listing, else null", () => {
    assert.equal(viewerKind("/artifacts/1/book/manifest.json", null), "text");
    assert.equal(viewerKind("/artifacts/1/book/", null), null);
    assert.equal(viewerKind("/artifacts/1/book/", BOOK), "directory");
    assert.equal(viewerKind("/artifacts/1/book.zip", BOOK), null);
    assert.equal(viewerKind("/artifacts/1/README", BOOK), null);
  });
});

describe("directoryEntries", () => {
  it("lists one level: the folders and the files directly inside, sorted", () => {
    assert.deepEqual(directoryEntries(BOOK, ""), { dirs: ["book"], files: ["book.zip", "exec-build.py"] });
    assert.deepEqual(directoryEntries(BOOK, "book"), {
      dirs: ["grimm1900bd1_1", "grimm1900bd1_2"],
      files: ["corrections.json", "manifest.json"],
    });
    assert.deepEqual(directoryEntries(BOOK, "book/"), directoryEntries(BOOK, "book"));
    assert.deepEqual(directoryEntries(BOOK, "book/grimm1900bd1_1"), { dirs: [], files: ["01-Titelblatt.md", "README.md"] });
    assert.deepEqual(directoryEntries(BOOK, "nope"), { dirs: [], files: [] });
  });
});

describe("resolveArtifactLink", () => {
  const readme = "/artifacts/1791913585689/chapters/README.md";

  it("resolves a relative link against the file's directory, within the run", () => {
    assert.equal(resolveArtifactLink(readme, "00-introduction.md"), "/artifacts/1791913585689/chapters/00-introduction.md");
    assert.equal(resolveArtifactLink(readme, "./00-introduction.md"), "/artifacts/1791913585689/chapters/00-introduction.md");
    assert.equal(resolveArtifactLink(readme, "../shannon1948.pdf"), "/artifacts/1791913585689/shannon1948.pdf");
    assert.equal(resolveArtifactLink(readme, "sub/"), "/artifacts/1791913585689/chapters/sub/");
    assert.equal(resolveArtifactLink(readme, ".."), "/artifacts/1791913585689/");
    assert.equal(resolveArtifactLink("/artifacts/1/book/", "grimm/README.md"), "/artifacts/1/book/grimm/README.md");
    assert.equal(resolveArtifactLink("/jobs/j1/files/notes/plan.md", "../shot.png"), "/jobs/j1/files/shot.png");
  });

  it("drops a fragment or query and decodes percent-encoding, as the listing spells names", () => {
    assert.equal(resolveArtifactLink(readme, "01-part-i.md#sec-2"), "/artifacts/1791913585689/chapters/01-part-i.md");
    assert.equal(resolveArtifactLink(readme, "01-part-i.md?x=1"), "/artifacts/1791913585689/chapters/01-part-i.md");
    assert.equal(
      resolveArtifactLink("/artifacts/1/book/v1/README.md", "05-Goethe-aus-n%C3%A4chster-N%C3%A4he.md"),
      "/artifacts/1/book/v1/05-Goethe-aus-nächster-Nähe.md",
    );
  });

  it("keeps an absolute path of the same scope, folded", () => {
    assert.equal(resolveArtifactLink(readme, "/artifacts/1791913585689/check.cjs"), "/artifacts/1791913585689/check.cjs");
    assert.equal(resolveArtifactLink(readme, "/artifacts/1791913585689/a/../b.md"), "/artifacts/1791913585689/b.md");
    assert.equal(resolveArtifactLink("/jobs/j1/files/plan.md", "/jobs/j1/files/x.md"), "/jobs/j1/files/x.md");
  });

  it("is null for anything that leaves the scope: external, another run, a climb out, an anchor", () => {
    assert.equal(resolveArtifactLink(readme, "https://www.cs.yale.edu/x.pdf"), null);
    assert.equal(resolveArtifactLink(readme, "mailto:a@b.c"), null);
    assert.equal(resolveArtifactLink(readme, "//cdn/x.png"), null);
    assert.equal(resolveArtifactLink(readme, "#chapters"), null);
    assert.equal(resolveArtifactLink(readme, ""), null);
    assert.equal(resolveArtifactLink(readme, "../../etc/passwd"), null);
    assert.equal(resolveArtifactLink(readme, "/artifacts/999/x.md"), null);
    assert.equal(resolveArtifactLink(readme, "/artifacts/1791913585689/../2/x.md"), null);
    assert.equal(resolveArtifactLink(readme, "/jobs/j/files/x.md"), null);
    assert.equal(resolveArtifactLink(readme, "%E0%A4%A"), null);
    assert.equal(resolveArtifactLink("plan.md", "x.md"), null);
  });
});
