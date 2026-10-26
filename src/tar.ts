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

/** One entry's 512-byte ustar header: a regular file, mode 0600, time 0.
 *  A writer that streams (src/move/archive.ts) sends it, the bytes, then
 *  `tarPadding(size)`, and `TAR_END` after the last entry. */
export function tarHeader(name: string, size: number): Buffer {
  const [prefix, rest] = splitName(name);
  const h = Buffer.alloc(512);
  h.write(rest, 0, 100, "utf8");
  h.write("0000600\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write("0", 156);
  h.write("ustar\0" + "00", 257);
  h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

/** The zeros that round an entry of `size` bytes up to a whole block. */
export function tarPadding(size: number): Buffer {
  return Buffer.alloc((512 - (size % 512)) % 512);
}

/** The two zero blocks that end an archive. */
export const TAR_END = Buffer.alloc(1024);

/** `files` as one ustar archive, in the order given. Every entry is a
 *  regular file, mode 0600, time 0, so the same files make the same bytes. */
export function tar(files: [string, Buffer][]): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, bytes] of files) blocks.push(tarHeader(name, bytes.length), bytes, tarPadding(bytes.length));
  blocks.push(TAR_END);
  return Buffer.concat(blocks);
}

/** A header block read back: null for an end block. Throws on anything but
 *  a regular file. */
export function parseTarHeader(block: Buffer): { name: string; size: number } | null {
  if (block.every((b) => b === 0)) return null;
  const text = (from: number, len: number) => block.subarray(from, from + len).toString("utf8").replace(/\0.*$/s, "");
  const prefix = text(257, 5) === "ustar" ? text(345, 155) : "";
  const name = prefix ? `${prefix}/${text(0, 100)}` : text(0, 100);
  const size = parseInt(text(124, 12).trim() || "0", 8);
  const type = text(156, 1) || "0";
  if (type !== "0") throw new Error(`the archive holds a non-file entry (${name})`);
  if (!Number.isFinite(size)) throw new Error(`the archive holds a bad size for ${name}`);
  return { name, size };
}

/** The files of an archive `tar` wrote, by name. Throws on anything but a
 *  regular file, on a name seen twice, and on an archive cut short. */
export function untar(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (let at = 0; at + 512 <= buf.length; ) {
    const entry = parseTarHeader(buf.subarray(at, at + 512));
    if (!entry) return files;
    const { name, size } = entry;
    if (at + 512 + size > buf.length) throw new Error("the archive holds a truncated entry");
    if (files.has(name)) throw new Error(`the archive holds ${name} twice`);
    files.set(name, buf.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("the archive has no end");
}
