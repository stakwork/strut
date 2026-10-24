import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tar, untar } from "./tar.js";

describe("tar", () => {
  it("round-trips regular files, a name past 100 bytes through ustar's prefix", () => {
    const long = `apps/issues/src/${"components/".repeat(8)}Card.tsx`;
    assert.ok(Buffer.byteLength(long) > 100);
    const files: [string, Buffer][] = [["strut.yaml", Buffer.from("package: a/b\n")], [long, Buffer.from("export {}\n")], ["empty", Buffer.alloc(0)]];
    const out = untar(tar(files));
    assert.deepEqual([...out.keys()], files.map(([n]) => n));
    assert.equal(out.get(long)!.toString(), "export {}\n");
    assert.equal(out.get("empty")!.length, 0);
  });

  it("the same files make the same bytes", () => {
    const files: [string, Buffer][] = [["a", Buffer.from("x")]];
    assert.deepEqual(tar(files), tar(files));
  });

  it("is readable by the system's tar, long names included", () => {
    const dir = mkdtempSync(join(tmpdir(), "strut-tar-"));
    try {
      const long = `${"deep/".repeat(25)}file.txt`;
      writeFileSync(join(dir, "a.tar"), tar([[long, Buffer.from("hello")]]));
      execFileSync("tar", ["xf", join(dir, "a.tar"), "-C", dir]);
      assert.equal(readFileSync(join(dir, long), "utf8"), "hello");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a name no ustar split can hold, never cutting it", () => {
    assert.throws(() => tar([["x".repeat(101), Buffer.alloc(0)]]), /longer than a tar header holds/);
    assert.throws(() => tar([[`${"p".repeat(156)}/name`, Buffer.alloc(0)]]), /longer than a tar header holds/);
  });

  it("refuses a name twice, a non-file entry, and an archive cut short", () => {
    const one = tar([["a", Buffer.from("1")]]).subarray(0, 1024);
    assert.throws(() => untar(Buffer.concat([one, one, Buffer.alloc(1024)])), /holds a twice/);
    const dir = Buffer.from(tar([["d", Buffer.alloc(0)]]));
    dir.write("5", 156);
    assert.throws(() => untar(dir), /non-file entry \(d\)/);
    assert.throws(() => untar(tar([["a", Buffer.alloc(600)]]).subarray(0, 700)), /truncated/);
    assert.throws(() => untar(tar([["a", Buffer.from("1")]]).subarray(0, 1024)), /no end/);
  });
});
