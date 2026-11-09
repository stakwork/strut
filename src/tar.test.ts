import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { tar, untar } from "./tar.js";

/** The 132-byte Concept page that made openlaw/legal-desk unservable (2026-11-09). */
const CONCEPT = "concepts/concept-ratingtaxonomycomplianceunauthorizedseveritytiersdisplaceclientmandatedratingsevenwhennegotiatingprioritylabelsarecorrect.md";

/** Names no ustar split holds: a base name past 100 bytes, a folder part
 *  past 155, a long name cut mid-character in its fallback header. */
const LONG = [CONCEPT, "x".repeat(200), `${"p".repeat(156)}/name`, `${"folder/".repeat(40)}leaf.txt`, `${"é".repeat(60)}.md`];

const scratch = <T>(fn: (dir: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), "strut-tar-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** bsdtar (macOS) or GNU tar (Linux), and its two ways to write a long name. */
const systemTar = (): { formats: string[] } => {
  const version = execFileSync("tar", ["--version"], { encoding: "utf8" });
  return { formats: /bsdtar/.test(version) ? ["--format=pax", "--format=gnutar"] : ["--format=posix", "--format=gnu"] };
};

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

  it("the same files make the same bytes — and a name ustar holds, the bytes it always made", () => {
    const files: [string, Buffer][] = [["a", Buffer.from("x")]];
    assert.deepEqual(tar(files), tar(files));
    // Written by the writer before PAX headers (strut#577's tar.ts): an
    // archive with no long name is unchanged, so no published digest's bytes move.
    const before: [string, Buffer][] = [
      ["strut.yaml", Buffer.from("package: a/b\n")],
      [`apps/issues/src/${"components/".repeat(8)}Card.tsx`, Buffer.from("export {}\n")],
      ["empty", Buffer.alloc(0)],
      ["concepts/concept-law.md", Buffer.from("x".repeat(700))],
    ];
    assert.equal(createHash("sha256").update(tar(before)).digest("hex"), "9667dad83f8338b10830c495b0cee2956d7bcbe745da92337a50b5500f9cd536");
  });

  it("round-trips a name no ustar header holds, in a PAX extended header", () => {
    for (const name of LONG) assert.ok(Buffer.byteLength(name) > 100);
    const files: [string, Buffer][] = [["strut.yaml", Buffer.from("package: a/b\n")], ...LONG.map((n, i): [string, Buffer] => [n, Buffer.from(`file ${i}\n`)]), ["after", Buffer.from("last")]];
    const archive = tar(files);
    const out = untar(archive);
    assert.deepEqual([...out.keys()], files.map(([n]) => n));
    for (const [name, bytes] of files) assert.deepEqual(out.get(name), bytes, name);
    assert.deepEqual(tar(files), archive, "deterministic");
    // The fallback name in the file's own header is cut between characters.
    assert.equal(untar(tar([[LONG[4]!, Buffer.alloc(0)]])).has(LONG[4]!), true);
  });

  it("is readable by the system's tar, long names included", () => {
    scratch((dir) => {
      const long = `${"deep/".repeat(25)}file.txt`;
      const names = [long, ...LONG];
      writeFileSync(join(dir, "a.tar"), tar(names.map((n, i): [string, Buffer] => [n, Buffer.from(`hello ${i}`)])));
      mkdirSync(join(dir, "out"));
      execFileSync("tar", ["xf", join(dir, "a.tar"), "-C", join(dir, "out")]);
      names.forEach((n, i) => assert.equal(readFileSync(join(dir, "out", n), "utf8"), `hello ${i}`, n));
      // Nothing beside the files: the PAX header is read as one, not extracted.
      // (bsdtar's listing escapes a name that is not ASCII: those are compared by count.)
      const ascii = (n: string) => /^[\x20-\x5b\x5d-\x7e]*$/.test(n);
      const listed = execFileSync("tar", ["tf", join(dir, "a.tar")], { encoding: "utf8" }).trim().split("\n");
      assert.equal(listed.length, names.length);
      assert.deepEqual(listed.filter(ascii), names.filter(ascii));
    });
  });

  it("reads what the system's tar wrote with a long name, PAX and GNU alike", () => {
    for (const format of systemTar().formats) {
      scratch((dir) => {
        const names = [`long/${"n".repeat(200)}.md`, CONCEPT, `${"folder/".repeat(30)}leaf.txt`, "short.txt"];
        for (const [i, n] of names.entries()) {
          mkdirSync(join(dir, "in", dirname(n)), { recursive: true });
          writeFileSync(join(dir, "in", n), `from tar ${i}`);
        }
        // COPYFILE_DISABLE: no AppleDouble `._` entries from macOS's tar.
        execFileSync("tar", [format, "-cf", join(dir, "a.tar"), "-C", join(dir, "in"), ...names], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
        const out = untar(readFileSync(join(dir, "a.tar")));
        assert.deepEqual([...out.keys()], names, format);
        names.forEach((n, i) => assert.equal(out.get(n)!.toString(), `from tar ${i}`, `${format} ${n}`));
      });
    }
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

  it("holds every refusal to the whole name a PAX header gives", () => {
    const long = LONG[0]!;
    const entry = tar([[long, Buffer.from("1")]]);
    const body = entry.subarray(0, entry.length - 1024);
    // Twice, by the whole name: the cut names in the file headers are the same either way.
    assert.throws(() => untar(Buffer.concat([body, body, Buffer.alloc(1024)])), new RegExp(`holds ${long} twice`));
    const other = tar([[`${long.slice(0, -3)}.mdx`, Buffer.from("2")]]);
    assert.equal(untar(Buffer.concat([body, other])).size, 2, "two names that share a 100-byte start are two files");
    // A non-file entry, named in full.
    const asDir = Buffer.from(entry);
    asDir.write("5", 1024 + 156);
    assert.throws(() => untar(asDir), new RegExp(`non-file entry \\(${long.replace(/\./g, "\\.")}\\)`));
    // Cut inside the extended header, after it, and inside the entry.
    assert.throws(() => untar(entry.subarray(0, 600)), /truncated/);
    assert.throws(() => untar(Buffer.concat([entry.subarray(0, 1024), Buffer.alloc(1024)])), /ends after an extended header/);
    assert.throws(() => untar(entry.subarray(0, 1536)), /truncated|no end/);
    // A record whose length does not match what follows.
    const bad = Buffer.from(entry);
    bad.write("9", 512);
    assert.throws(() => untar(bad), /bad extended header/);
  });

  it("reads past a PAX global header, and takes a PAX size", () => {
    const record = (key: string, value: string) => {
      const rest = Buffer.byteLength(` ${key}=${value}\n`);
      let len = rest + 1;
      while (String(len).length + rest !== len) len = String(len).length + rest;
      return Buffer.from(`${len} ${key}=${value}\n`);
    };
    const header = (name: string, type: string, size: number) => {
      const h = Buffer.from(tar([[name, Buffer.alloc(size)]]).subarray(0, 512));
      h.write(type, 156);
      return h;
    };
    const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
    const global = record("comment", "made elsewhere");
    const local = Buffer.concat([record("path", "real/name.txt"), record("size", "3"), record("mtime", "1700000000.5")]);
    const archive = Buffer.concat([
      header("pax_global_header", "g", global.length),
      pad(global),
      header("PaxHeader/x", "x", local.length),
      pad(local),
      header("cut-name", "0", 0), // the header's own size, which `size` replaces
      pad(Buffer.from("abc")),
      Buffer.alloc(1024),
    ]);
    const out = untar(archive);
    assert.deepEqual([...out.keys()], ["real/name.txt"]);
    assert.equal(out.get("real/name.txt")!.toString(), "abc");
  });
});
