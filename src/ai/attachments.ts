import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

/**
 * Files a person attaches to a builder chat message (`POST /chat {
 * attachments }`). Each one is saved under `<dataDir>/uploads/<chatId>/` —
 * where the builder's bash and a test run can read it — and becomes parts of
 * the user message, in `messages.jsonl` like any other content:
 *
 *   - an image (png, jpeg, gif, webp) or a PDF: a `file` part, so the model
 *     SEES it (every aieo provider takes images; PDFs natively on anthropic,
 *     google, openai);
 *   - text (md, txt, csv, json, code — anything that decodes as UTF-8): its
 *     text, inline;
 *   - a Word document (.docx, .doc): its extracted text, inline;
 *   - anything else: saved only — the model reads it with bash.
 *
 * Each file is announced by one text part whose first line is
 * `[attachment] <name> (<media type>, <size>) — saved at <path>`; text and
 * Word content follow it in the same part, an image or a PDF comes as the
 * next part. The UI folds those parts into chips (`kit/src/folds/transcript.ts`).
 * The bytes ride in the history the chat replays every turn, so the caps
 * below keep a message well under a provider's request limit (Anthropic:
 * 32 MB); the web UI downscales a large image before it sends it.
 */

export const ATTACHMENT_PREFIX = "[attachment]";
export const MAX_ATTACHMENTS = 10;
/** One file, decoded. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** One image — Anthropic refuses a larger one. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Every file of one message together. */
export const MAX_ATTACHMENTS_TOTAL_BYTES = 15 * 1024 * 1024;
/** Text inlined per file; the rest is in the saved file. */
export const ATTACHMENT_TEXT_MAX_CHARS = 200_000;

/** One attachment as `POST /chat` takes it. `data` is base64, or a data URL
 *  (its media type is used when `mediaType` is absent). */
export interface AttachmentInput {
  name: string;
  mediaType?: string;
  data: string;
}

/** A validated attachment, decoded. */
export interface Attachment {
  name: string;
  mediaType: string;
  bytes: Buffer;
}

type Kind = "image" | "pdf" | "word" | "text" | "file";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const WORD_TYPES = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".html": "text/html",
};

/** Validate and decode `POST /chat`'s `attachments`. Throws with the message
 *  a 400 carries; nothing has been written yet. */
export function parseAttachments(raw: unknown): Attachment[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("attachments must be an array");
  if (raw.length > MAX_ATTACHMENTS) throw new Error(`at most ${MAX_ATTACHMENTS} attachments per message`);
  let total = 0;
  return raw.map((item, i) => {
    const a = item as Partial<AttachmentInput> | null;
    if (!a || typeof a.name !== "string" || !a.name.trim()) throw new Error(`attachments[${i}].name (string) is required`);
    if (typeof a.data !== "string") throw new Error(`attachments[${i}].data (base64 string) is required`);
    const name = a.name.trim();
    let data = a.data;
    let fromUrl: string | undefined;
    const m = /^data:([^;,]*)(?:;[^,]*)?;base64,/.exec(data);
    if (m) {
      fromUrl = m[1] || undefined;
      data = data.slice(m[0].length);
    }
    if (!/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(data)) throw new Error(`attachments[${i}] (${name}): data is not base64`);
    const bytes = Buffer.from(data, "base64");
    const mediaType = normalizeType(a.mediaType ?? fromUrl, name);
    const cap = IMAGE_TYPES.has(mediaType) ? MAX_IMAGE_BYTES : MAX_ATTACHMENT_BYTES;
    if (bytes.length > cap) throw new Error(`${name} is ${formatBytes(bytes.length)}; the limit is ${formatBytes(cap)}`);
    total += bytes.length;
    if (total > MAX_ATTACHMENTS_TOTAL_BYTES) {
      throw new Error(`attachments total more than ${formatBytes(MAX_ATTACHMENTS_TOTAL_BYTES)} in one message`);
    }
    return { name, mediaType, bytes };
  });
}

/** The given media type, else the extension's; a browser sends "" or
 *  `application/octet-stream` for anything it does not know. */
function normalizeType(given: string | undefined, name: string): string {
  const t = given?.trim().toLowerCase();
  if (t && t !== "application/octet-stream") return t === "image/jpg" ? "image/jpeg" : t;
  return BY_EXTENSION[extname(name).toLowerCase()] ?? "application/octet-stream";
}

function kindOf(a: Attachment): Kind {
  const ext = extname(a.name).toLowerCase();
  if (IMAGE_TYPES.has(a.mediaType)) return "image";
  if (a.mediaType === "application/pdf") return "pdf";
  if (WORD_TYPES.has(a.mediaType) || ext === ".docx" || ext === ".doc") return "word";
  return utf8(a.bytes) !== null ? "text" : "file";
}

/** The bytes as text when they are UTF-8 with no NUL — what "a text file"
 *  means here, whatever the browser called its type. */
function utf8(bytes: Buffer): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

/** Write each attachment under `<dataDir>/uploads/<chatId>/`, never over an
 *  earlier one of the same name (an earlier message's path stays true).
 *  Returns the absolute paths, in order. */
export async function saveAttachments(dataDir: string, chatId: string, list: Attachment[]): Promise<string[]> {
  const dir = resolve(dataDir, "uploads", chatId);
  await mkdir(dir, { recursive: true });
  const paths: string[] = [];
  for (const a of list) {
    const safe = safeName(a.name);
    const ext = extname(safe);
    const stem = safe.slice(0, safe.length - ext.length);
    for (let n = 1; ; n++) {
      const path = join(dir, n === 1 ? safe : `${stem}-${n}${ext}`);
      try {
        await writeFile(path, a.bytes, { flag: "wx" });
        paths.push(path);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
  }
  return paths;
}

function safeName(name: string): string {
  const s = basename(name.replace(/\\/g, "/"))
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/^[.\s]+/, "")
    .slice(-120)
    .trim();
  return s || "attachment";
}

/** The user-message parts for one saved attachment (see the module doc). */
export async function attachmentParts(a: Attachment, savedAt: string): Promise<unknown[]> {
  const header = `${ATTACHMENT_PREFIX} ${a.name} (${a.mediaType}, ${formatBytes(a.bytes.length)}) — saved at ${savedAt}`;
  const kind = kindOf(a);
  if (kind === "image" || kind === "pdf") {
    return [
      { type: "text", text: header },
      { type: "file", data: a.bytes.toString("base64"), mediaType: a.mediaType, filename: a.name },
    ];
  }
  if (kind === "text") return [{ type: "text", text: `${header}\n\n${capText(utf8(a.bytes)!)}` }];
  if (kind === "word") {
    try {
      return [{ type: "text", text: `${header}\n\n${capText(await wordText(a.bytes))}` }];
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      return [{ type: "text", text: `${header}\n\nCould not read it as a Word document (${why}); inspect the file with bash.` }];
    }
  }
  return [{ type: "text", text: `${header}\n\nNot shown inline (not text, an image or a PDF); inspect the file with bash.` }];
}

/** A .docx's or a .doc's text: body, then headers / footnotes when present. */
async function wordText(bytes: Buffer): Promise<string> {
  // Lazy, like a lib step's SDK: only a message with a Word file loads it.
  const { default: WordExtractor } = await import("word-extractor");
  const doc = await new WordExtractor().extract(bytes);
  return [doc.getBody(), doc.getFootnotes(), doc.getEndnotes()]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n\n");
}

function capText(text: string): string {
  if (text.length <= ATTACHMENT_TEXT_MAX_CHARS) return text;
  return `${text.slice(0, ATTACHMENT_TEXT_MAX_CHARS)}\n\n[… cut at ${ATTACHMENT_TEXT_MAX_CHARS.toLocaleString("en")} of ${text.length.toLocaleString("en")} chars; the whole file is at the path above]`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
