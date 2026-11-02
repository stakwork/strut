// A ZIP archive, read and written over node:zlib — what a .docx is. The
// subset a word processor writes: stored or deflated entries, no
// encryption, no ZIP64 (a .docx past 4 GB is not one we read). Like
// src/tar.ts, nothing from npm: the format is a few headers.

import * as zlib from "node:zlib";

/** One file of the archive, uncompressed. */
export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** What a read may expand to, all entries together — a small archive can
 *  inflate to gigabytes. */
export const ZIP_MAX_BYTES = 256 * 1024 * 1024;

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;

let table: Uint32Array | undefined;
/** CRC-32 — `zlib.crc32` where Node has it (22.2+), else a table. */
function crc32(data: Buffer): number {
  const native = (zlib as { crc32?: (d: Buffer) => number }).crc32;
  if (native) return native(data) >>> 0;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of data) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Every file entry, in the archive's order. Throws on what is not a ZIP
 *  this reads, or one that expands past `maxBytes`. */
export function readZip(buf: Buffer, maxBytes = ZIP_MAX_BYTES): ZipEntry[] {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === END) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip archive (no end of central directory)");
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff) throw new Error("zip64 archives are not supported");
  const out: ZipEntry[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL) throw new Error("corrupt zip central directory");
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const compressed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const next = at + 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    at = next;
    if (name.endsWith("/")) continue;
    if (flags & 1) throw new Error(`zip entry ${name} is encrypted`);
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL) throw new Error(`corrupt zip entry ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compressed);
    total += size;
    if (total > maxBytes) throw new Error(`zip expands past ${maxBytes} bytes`);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
    else throw new Error(`zip entry ${name} uses compression method ${method}`);
    if (data.length !== size || crc32(data) !== crc) throw new Error(`zip entry ${name} is corrupt (size or CRC)`);
    out.push({ name, data });
  }
  return out;
}

/** The entries as one archive, deflated, in the order given. Every entry
 *  carries the same time (1980-01-01), so the same files make the same bytes. */
export function writeZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const packed = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(LOCAL, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // names are UTF-8
    head.writeUInt16LE(8, 8);
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(33, 12); // 1980-01-01
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    head.writeUInt16LE(0, 28);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(CENTRAL, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(33, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    parts.push(head, nameBuf, packed);
    central.push(dir, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dirBuf, end]);
}
