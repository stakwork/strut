// A ustar archive of regular files: what a package archive
// (packages/archive.ts) and a move (move/archive.ts) are. Readable with
// `tar xzf`, and read back here with nothing but regular files, each named
// once. A name ustar's header cannot hold travels in a POSIX PAX extended
// header before its entry (`path=`); every name that fits is plain ustar, so
// an archive with no long name is the same bytes it always was. The reader
// checks the format only: which names are allowed, and where they may land,
// is the caller's.

/** Where ustar splits a name too long for its 100-byte field: a prefix of up
 *  to 155 bytes, then the rest, at a `/`. Undefined when no split fits. */
function splitName(name: string): [prefix: string, rest: string] | undefined {
  if (Buffer.byteLength(name) <= 100) return ["", name];
  for (let i = name.indexOf("/"); i > 0; i = name.indexOf("/", i + 1)) {
    const prefix = name.slice(0, i);
    const rest = name.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100 && rest) return [prefix, rest];
  }
  return undefined;
}

/** The longest start of `s` that is at most `max` bytes, cut between
 *  characters. */
function cutUtf8(s: string, max: number): string {
  const bytes = Buffer.from(s);
  if (bytes.length <= max) return s;
  let end = max;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

/** One 512-byte ustar header block: mode 0600, owner 0, time 0. */
function headerBlock(prefix: string, rest: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(rest, 0, 100, "utf8");
  h.write("0000600\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write("ustar\0" + "00", 257);
  h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

/** One PAX record, `<len> <key>=<value>\n`, its length counting itself. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const rest = Buffer.byteLength(body);
  let len = rest + 1;
  while (String(len).length + rest !== len) len = String(len).length + rest;
  return `${len}${body}`;
}

/** The name a PAX extended header is stored under (Python's tarfile's): a
 *  reader that does not know PAX extracts it as a stray file, nothing more. */
const PAX_HEADER_NAME = "././@PaxHeader";

/** One entry's header: a regular file, mode 0600, time 0 — one 512-byte
 *  block, or, for a name ustar cannot hold, a PAX extended header carrying
 *  `path` and then the file's own block (its name cut, which a PAX reader
 *  never reads). A writer that streams (src/move/archive.ts) sends it, the
 *  bytes, then `tarPadding(size)`, and `TAR_END` after the last entry. */
export function tarHeader(name: string, size: number): Buffer {
  const split = splitName(name);
  if (split) return headerBlock(split[0], split[1], size, "0");
  const pax = Buffer.from(paxRecord("path", name));
  return Buffer.concat([headerBlock("", PAX_HEADER_NAME, pax.length, "x"), pax, tarPadding(pax.length), headerBlock("", cutUtf8(name, 100), size, "0")]);
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

/** What a header block is: a regular `file`; an extended header whose body
 *  names the next entry — a PAX one (`pax`, typeflag `x`) or a GNU long name
 *  (`longname`, `L`); a PAX `global` one (`g`), whose body is skipped; or
 *  anything else (`other`: a directory, a link, a device), which no reader
 *  here takes. */
type HeaderKind = "file" | "pax" | "global" | "longname" | "other";

/** The most an extended header's body may be: a path, and whatever else a
 *  system tar puts beside it (times, extended attributes). */
export const TAR_EXTENDED_MAX = 1024 * 1024;

/** A header block read back, as its own fields say: null for an end block. */
function readHeader(block: Buffer): { kind: HeaderKind; name: string; size: number } | null {
  if (block.every((b) => b === 0)) return null;
  const text = (from: number, len: number) => block.subarray(from, from + len).toString("utf8").replace(/\0.*$/s, "");
  // POSIX ustar's magic is `ustar\0`: a GNU header (`ustar  \0`) keeps other
  // fields where POSIX keeps the prefix.
  const prefix = text(257, 5) === "ustar" && block[262] === 0 ? text(345, 155) : "";
  const name = prefix ? `${prefix}/${text(0, 100)}` : text(0, 100);
  const size = parseInt(text(124, 12).trim() || "0", 8);
  const type = text(156, 1) || "0";
  const kind: HeaderKind = type === "0" ? "file" : type === "x" ? "pax" : type === "g" ? "global" : type === "L" ? "longname" : "other";
  return { kind, name, size };
}

/** A PAX extended header's records: `<len> <key>=<value>\n`, the length
 *  counting the whole record. */
function paxRecords(body: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  for (let at = 0; at < body.length && body[at] !== 0; ) {
    const space = body.indexOf(0x20, at);
    const len = space > at ? Number(body.subarray(at, space).toString("latin1")) : NaN;
    if (!Number.isInteger(len) || len <= space - at || at + len > body.length || body[at + len - 1] !== 0x0a) {
      throw new Error("the archive holds a bad extended header");
    }
    const record = body.subarray(space + 1, at + len - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq <= 0) throw new Error("the archive holds a bad extended header");
    records.set(record.slice(0, eq), record.slice(eq + 1));
    at += len;
  }
  return records;
}

/** The kinds of extended header `TarNames` announces. */
export type TarExtendedKind = "pax" | "global" | "longname";

/**
 * The entries of an archive, header by header, under their whole names:
 * hand it each header block (`header`) and the body of each extended header
 * it announces (`extended`). A PAX `path` (and `size`) or a GNU long name
 * applies to the entry after it; a PAX global header is read past. Throws
 * on anything but a regular file or an extended header, on a bad extended
 * header, and on one with no entry after it.
 */
export class TarNames {
  private path: string | undefined;
  private size: number | undefined;
  private pending = false;

  /** A header block: null at the end, `{ extended }` for an extended header
   *  whose body (`size` bytes, then padding) goes to `extended`, else the
   *  file with its whole name and size. */
  header(block: Buffer): { extended: TarExtendedKind; size: number } | { extended?: undefined; name: string; size: number } | null {
    const entry = readHeader(block);
    if (!entry) {
      if (this.pending) throw new Error("the archive ends after an extended header, with no entry for it");
      return null;
    }
    const name = this.path ?? entry.name;
    const size = entry.kind === "file" ? (this.size ?? entry.size) : entry.size;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`the archive holds a bad size for ${name}`);
    if (entry.kind === "other") throw new Error(`the archive holds a non-file entry (${name})`);
    if (entry.kind !== "file") {
      if (size > TAR_EXTENDED_MAX) throw new Error(`the archive holds an extended header of ${size} bytes, more than ${TAR_EXTENDED_MAX}`);
      return { extended: entry.kind, size };
    }
    this.path = this.size = undefined;
    this.pending = false;
    return { name, size };
  }

  /** The body of the extended header `header` last announced. */
  extended(kind: TarExtendedKind, body: Buffer): void {
    if (kind === "global") return;
    this.pending = true;
    if (kind === "longname") {
      this.path = body.toString("utf8").replace(/\0.*$/s, "") || undefined;
      return;
    }
    const records = paxRecords(body);
    // An empty value takes the keyword back (POSIX): the header's own field.
    if (records.has("path")) this.path = records.get("path") || undefined;
    if (records.has("size")) {
      const size = records.get("size")!;
      if (size && !/^\d+$/.test(size)) throw new Error("the archive holds a bad size in an extended header");
      this.size = size ? Number(size) : undefined;
    }
  }
}

/** The files of an archive `tar` wrote, by name. Throws on anything but a
 *  regular file, on a name seen twice, and on an archive cut short. */
export function untar(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const names = new TarNames();
  for (let at = 0; at + 512 <= buf.length; ) {
    const entry = names.header(buf.subarray(at, at + 512));
    if (!entry) return files;
    const { size } = entry;
    if (at + 512 + size > buf.length) throw new Error("the archive holds a truncated entry");
    const body = buf.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (entry.extended) {
      names.extended(entry.extended, body);
      continue;
    }
    if (files.has(entry.name)) throw new Error(`the archive holds ${entry.name} twice`);
    files.set(entry.name, body);
  }
  throw new Error("the archive has no end");
}
