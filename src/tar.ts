// A plain ustar archive of regular files: what a memory snapshot
// (steps/lib/memory/_snapshot.ts) and a package archive (packages/archive.ts)
// are. Readable with `tar xzf`, and read back here with nothing but regular
// files, each named once. The reader checks the format only: which names are
// allowed, and where they may land, is the caller's.

/** Where ustar splits a name too long for its 100-byte field: a prefix of up
 *  to 155 bytes, then the rest, at a `/`. A name with no such split is
 *  refused, never cut — the content hash would be cut with it. */
function splitName(name: string): [prefix: string, rest: string] {
  if (Buffer.byteLength(name) <= 100) return ["", name];
  for (let i = name.indexOf("/"); i > 0; i = name.indexOf("/", i + 1)) {
    const prefix = name.slice(0, i);
    const rest = name.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100 && rest) return [prefix, rest];
  }
  throw new Error(`the file name ${JSON.stringify(name)} is longer than a tar header holds`);
}

/** `files` as one ustar archive, in the order given. Every entry is a
 *  regular file, mode 0600, time 0, so the same files make the same bytes. */
export function tar(files: [string, Buffer][]): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, bytes] of files) {
    const [prefix, rest] = splitName(name);
    const h = Buffer.alloc(512);
    h.write(rest, 0, 100, "utf8");
    h.write("0000600\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write("0", 156);
    h.write("ustar\0" + "00", 257);
    h.write(prefix, 345, 155, "utf8");
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** The files of an archive `tar` wrote, by name. Throws on anything but a
 *  regular file, on a name seen twice, and on an archive cut short. */
export function untar(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const text = (from: number, len: number) => buf.subarray(from, from + len).toString("utf8").replace(/\0.*$/s, "");
  for (let at = 0; at + 512 <= buf.length; ) {
    if (buf.subarray(at, at + 512).every((b) => b === 0)) return files;
    const prefix = text(at + 257, 5) === "ustar" ? text(at + 345, 155) : "";
    const name = prefix ? `${prefix}/${text(at, 100)}` : text(at, 100);
    const size = parseInt(text(at + 124, 12).trim() || "0", 8);
    const type = text(at + 156, 1) || "0";
    if (type !== "0") throw new Error(`the archive holds a non-file entry (${name})`);
    if (!Number.isFinite(size) || at + 512 + size > buf.length) throw new Error("the archive holds a truncated entry");
    if (files.has(name)) throw new Error(`the archive holds ${name} twice`);
    files.set(name, buf.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("the archive has no end");
}
