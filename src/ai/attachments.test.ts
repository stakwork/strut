import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ATTACHMENT_TEXT_MAX_CHARS,
  MAX_ATTACHMENTS,
  attachmentParts,
  loadRunAttachments,
  parseAttachments,
  saveAttachments,
  saveRunAttachments,
} from "./attachments.js";
import { fileArtifactsCapability } from "../capabilities.js";

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
const one = (input: object) => parseAttachments([input])[0]!;

describe("chat attachments", () => {
  it("parse: the media type comes from the field, else the data URL, else the extension", () => {
    assert.deepEqual(parseAttachments(undefined), []);
    assert.equal(one({ name: "a.png", mediaType: "image/jpg", data: b64("x") }).mediaType, "image/jpeg");
    assert.equal(one({ name: "a", data: `data:image/webp;base64,${b64("x")}` }).mediaType, "image/webp");
    assert.equal(one({ name: "spec.DOCX", mediaType: "application/octet-stream", data: b64("x") }).mediaType,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    assert.equal(one({ name: "blob", data: b64("x") }).mediaType, "application/octet-stream");
    assert.throws(() => parseAttachments(Array.from({ length: MAX_ATTACHMENTS + 1 }, () => ({ name: "a", data: "" }))), /at most 10/);
    assert.throws(() => parseAttachments([{ name: " ", data: "" }]), /name \(string\) is required/);
    assert.throws(
      () => parseAttachments(Array.from({ length: 2 }, (_, i) => ({ name: `${i}.bin`, data: b64(Buffer.alloc(8 * 1024 * 1024)) }))),
      /total more than 15\.0 MB/,
    );
  });

  it("save: under uploads/<chat>/, never outside it, never over an earlier file of the same name", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "strut-attach-"));
    try {
      const list = parseAttachments([
        { name: "../../etc/passwd", data: b64("a") },
        { name: "notes.md", data: b64("first") },
        { name: "notes.md", data: b64("second") },
        { name: ".env", data: b64("b") },
        { name: "a/b\\c?.txt", data: b64("c") },
      ]);
      const paths = await saveAttachments(dataDir, "chat1", list);
      const dir = join(dataDir, "uploads", "chat1");
      assert.deepEqual(paths, ["passwd", "notes.md", "notes-2.md", "env", "c_.txt"].map((n) => join(dir, n)));
      assert.deepEqual((await readdir(dir)).sort(), ["c_.txt", "env", "notes-2.md", "notes.md", "passwd"]);
      assert.equal(await readFile(join(dir, "notes.md"), "utf8"), "first");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("a run's: under its artifacts' attachments/, a repeated name numbered; recorded without the bytes, read back with them", async () => {
    const root = await mkdtemp(join(tmpdir(), "strut-attach-"));
    try {
      const artifacts = fileArtifactsCapability(root);
      const list = parseAttachments([
        { name: "../../etc/passwd", data: b64("a") },
        { name: "shot.png", data: b64("first") },
        { name: "shot.png", data: b64("second") },
      ]);
      const saved = await saveRunAttachments(artifacts, "1000", list);
      assert.deepEqual(saved, [
        { name: "../../etc/passwd", mediaType: "application/octet-stream", size: 1, path: "attachments/passwd" },
        { name: "shot.png", mediaType: "image/png", size: 5, path: "attachments/shot.png" },
        { name: "shot.png", mediaType: "image/png", size: 6, path: "attachments/shot-2.png" },
      ]);
      assert.deepEqual(await artifacts.list("1000"), ["attachments/passwd", "attachments/shot-2.png", "attachments/shot.png"]);
      const loaded = await loadRunAttachments(artifacts, "1000", saved.slice(2));
      assert.equal(loaded[0]!.bytes.toString(), "second");
      assert.equal(loaded[0]!.savedAt, join(root, "1000", "attachments", "shot-2.png"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parts: an image is a file part after its line; text inline, cut past the cap; a binary file is announced only", async () => {
    const png = one({ name: "a.png", data: b64("\x89PNG") });
    assert.deepEqual(await attachmentParts(png, "/u/a.png"), [
      { type: "text", text: "[attachment] a.png (image/png, 5 B) — saved at /u/a.png" },
      { type: "file", data: b64("\x89PNG"), mediaType: "image/png", filename: "a.png" },
    ]);

    // Any UTF-8, whatever the browser called it (a .ts file arrives as video/mp2t).
    const [code] = (await attachmentParts(one({ name: "x.ts", mediaType: "video/mp2t", data: b64("const x = 1;") }), "/u/x.ts")) as any[];
    assert.equal(code.text, "[attachment] x.ts (video/mp2t, 12 B) — saved at /u/x.ts\n\nconst x = 1;");

    const long = "y".repeat(ATTACHMENT_TEXT_MAX_CHARS + 5);
    const [cut] = (await attachmentParts(one({ name: "big.txt", data: b64(long) }), "/u/big.txt")) as any[];
    assert.match(cut.text, /\n\n\[… cut at 200,000 of 200,005 chars; the whole file is at the path above\]$/);

    const [bin] = (await attachmentParts(one({ name: "x.xlsx", data: b64(Buffer.from([0x50, 0x4b, 0, 0xff])) }), "/u/x.xlsx")) as any[];
    assert.match(bin.text, /^\[attachment\] x\.xlsx \(application\/octet-stream, 4 B\) — saved at \/u\/x\.xlsx\n\nNot shown inline/);
  });

  it("parts: a .docx and a .doc become their text; a broken one says so", async () => {
    for (const name of ["spec.docx", "spec.doc"]) {
      const bytes = await readFile(new URL(`./fixtures/${name}`, import.meta.url));
      const [part] = (await attachmentParts(one({ name, data: b64(bytes) }), `/u/${name}`)) as any[];
      assert.match(part.text, /\n\nClip Spec\nCut the video at every chapter marker\.\nOutput one MP4 per chapter\.$/, name);
    }
    const [bad] = (await attachmentParts(one({ name: "bad.docx", data: b64("not a zip") }), "/u/bad.docx")) as any[];
    assert.match(bad.text, /\n\nCould not read it as a Word document \(.+\); inspect the file with bash\.$/);
  });
});
