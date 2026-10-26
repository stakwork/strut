// A move sealed with its pairing code (AGENTS.md, "Moving strut to another
// host"): a 29-byte header, then AES-256-GCM chunks under a key derived from
// the code by HKDF-SHA256. The construction is peel's first draft's
// (home/README.md on its `home-bundle` branch); the constants are strut's,
// and the test vector in move.test.ts is what any client that seals or
// opens a move (Peel's CryptoKit) checks itself against.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const MAGIC = Buffer.from("STRUTMOV");
export const SEAL_VERSION = 1;
export const SALT_SIZE = 16;
export const HEADER_SIZE = MAGIC.length + 1 + SALT_SIZE + 4;
const TAG_SIZE = 16;
export const DEFAULT_CHUNK = 1 << 20;
const MIN_CHUNK = 1 << 16;
const MAX_CHUNK = 1 << 24;

const INFO_KEY = "strut move v1";
const INFO_CHECK = "strut move v1 check";
const INFO_RECEIVED = "strut move v1 received";

/** The first chunk did not open: another code, or not a move. */
export class WrongCode extends Error {
  constructor() {
    super("the move does not open with this code");
  }
}

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 20 characters of Crockford's base32: 100 bits. */
export function newCode(): string {
  return [...randomBytes(20)].map((b) => ALPHABET[b & 31]).join("");
}

/** A code as typed: dashes and spaces dropped, upper case. */
export function normalizeCode(code: string): string {
  return code.replace(/[-\s]/g, "").toUpperCase();
}

/** A code as it is shown: XXXX-XXXX-XXXX-XXXX-XXXX. */
export function groupCode(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

/** RFC 5869 HKDF-SHA256 for 32 bytes (one expand block), CryptoKit's
 *  `HKDF<SHA256>`. */
export function hkdf(code: string, salt: Buffer, info: string): Buffer {
  const prk = createHmac("sha256", salt).update(code).digest();
  return createHmac("sha256", prk).update(info).update(Buffer.from([1])).digest();
}

function nonce(counter: number, final: boolean): Buffer {
  const n = Buffer.alloc(12);
  n[0] = final ? 1 : 0;
  n.writeBigUInt64BE(BigInt(counter), 4);
  return n;
}

function sealChunk(key: Buffer, header: Buffer, counter: number, final: boolean, plain: Buffer): Buffer {
  const c = createCipheriv("aes-256-gcm", key, nonce(counter, final));
  c.setAAD(header);
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}

function openChunk(key: Buffer, header: Buffer, counter: number, final: boolean, record: Buffer): Buffer | null {
  try {
    const d = createDecipheriv("aes-256-gcm", key, nonce(counter, final));
    d.setAAD(header);
    d.setAuthTag(record.subarray(record.length - TAG_SIZE));
    return Buffer.concat([d.update(record.subarray(0, record.length - TAG_SIZE)), d.final()]);
  } catch {
    return null;
  }
}

/** The header that opens a sealed move. */
export function sealHeader(salt: Buffer, chunk = DEFAULT_CHUNK): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(chunk);
  return Buffer.concat([MAGIC, Buffer.from([SEAL_VERSION]), salt, size]);
}

/** `source` sealed with `code`: the header, then chunks of exactly `chunk`
 *  bytes but the last (0 to `chunk` bytes), which carries the final flag. */
export async function* seal(source: AsyncIterable<Buffer>, code: string, opts: { salt?: Buffer; chunk?: number } = {}): AsyncGenerator<Buffer> {
  const salt = opts.salt ?? randomBytes(SALT_SIZE);
  const chunk = opts.chunk ?? DEFAULT_CHUNK;
  const header = sealHeader(salt, chunk);
  const key = hkdf(code, salt, INFO_KEY);
  yield header;
  let counter = 0;
  let buf = Buffer.alloc(0);
  for await (const piece of source) {
    buf = buf.length ? Buffer.concat([buf, piece]) : Buffer.from(piece);
    // A full chunk goes out only once more follows: the last one is final.
    while (buf.length > chunk) {
      yield sealChunk(key, header, counter++, false, buf.subarray(0, chunk));
      buf = buf.subarray(chunk);
    }
  }
  yield sealChunk(key, header, counter, true, buf);
}

/** The salt in a sealed move's header (what `received` is proven over). */
export function saltOf(header: Buffer): Buffer {
  return header.subarray(MAGIC.length + 1, MAGIC.length + 1 + SALT_SIZE);
}

/** A sealed move's plaintext. Throws `WrongCode` when the first chunk does
 *  not open, before yielding anything; a damaged, reordered, cut-short or
 *  over-long move throws too. `onHeader` sees the header once read. */
export async function* open(source: AsyncIterable<Buffer>, code: string, onHeader?: (header: Buffer) => void): AsyncGenerator<Buffer> {
  const it = source[Symbol.asyncIterator]();
  let buf = Buffer.alloc(0);
  let ended = false;
  // Read until `n` bytes are buffered or the stream ends.
  const fill = async (n: number) => {
    while (buf.length < n && !ended) {
      const r = await it.next();
      if (r.done) ended = true;
      else buf = buf.length ? Buffer.concat([buf, r.value]) : Buffer.from(r.value);
    }
  };
  await fill(HEADER_SIZE);
  if (buf.length < HEADER_SIZE || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not a move");
  const header = Buffer.from(buf.subarray(0, HEADER_SIZE));
  buf = buf.subarray(HEADER_SIZE);
  if (header[MAGIC.length] !== SEAL_VERSION) throw new Error(`move format version ${header[MAGIC.length]} is not supported`);
  const chunk = header.readUInt32BE(HEADER_SIZE - 4);
  if (chunk < MIN_CHUNK || chunk > MAX_CHUNK) throw new Error(`move chunk size ${chunk} is out of range`);
  onHeader?.(header);
  const key = hkdf(code, saltOf(header), INFO_KEY);
  const record = chunk + TAG_SIZE;
  for (let counter = 0; ; counter++) {
    // One byte past a whole record says whether this one is the last.
    await fill(record + 1);
    const final = buf.length <= record;
    const take = final ? buf.length : record;
    if (take < TAG_SIZE) throw new Error("the move is cut short");
    const plain = openChunk(key, header, counter, final, buf.subarray(0, take));
    if (!plain) {
      if (counter === 0) throw new WrongCode();
      throw new Error("the move is damaged or cut short");
    }
    buf = buf.subarray(take);
    if (plain.length) yield plain;
    if (final) return;
  }
}

/** A proof of the code over `salt`: `check` before a move is sent,
 *  `received` once one is unpacked. */
export function proof(code: string, salt: Buffer, what: "check" | "received"): Buffer {
  return hkdf(code, salt, what === "check" ? INFO_CHECK : INFO_RECEIVED);
}

/** Whether `tokenHex` is the proof of `code` over `saltHex`. */
export function verifyProof(code: string, saltHex: unknown, tokenHex: unknown, what: "check" | "received"): boolean {
  if (typeof saltHex !== "string" || typeof tokenHex !== "string" || !/^[0-9a-f]{32}$/i.test(saltHex) || !/^[0-9a-f]{64}$/i.test(tokenHex)) return false;
  return timingSafeEqual(Buffer.from(tokenHex, "hex"), proof(code, Buffer.from(saltHex, "hex"), what));
}
