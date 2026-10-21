// Files the person attaches to a builder chat message, read in the browser
// for `POST /chat { attachments }` (the server half: src/ai/attachments.ts,
// which owns the limits; the ones here only fail early).
import type { AttachmentView } from "@strut/kit/folds";

/** A file waiting in the composer: its chip, plus the bytes as a data URL. */
export type PendingAttachment = AttachmentView & { data: string; bytes: number };

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Anthropic scales an image down to this long edge anyway; sending it at
 *  that size keeps the chat's replayed history small. */
const MAX_IMAGE_EDGE = 1568;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Read one file for sending. A large PNG or JPEG is scaled down first; a
 *  file over the server's limit is refused here with the same reason. */
export async function readAttachment(file: File): Promise<PendingAttachment> {
  const blob = await downscale(file);
  const image = blob.type.startsWith("image/");
  const cap = image ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
  if (blob.size > cap) throw new Error(`${file.name} is ${formatBytes(blob.size)}; the limit is ${formatBytes(cap)}`);
  const data = await dataUrl(blob);
  const mediaType = blob.type || "application/octet-stream";
  return {
    name: file.name || "attachment",
    mediaType,
    size: formatBytes(blob.size),
    bytes: blob.size,
    data,
    ...(image ? { src: data } : {}),
  };
}

async function downscale(file: File): Promise<Blob> {
  if (file.type !== "image/png" && file.type !== "image/jpeg") return file;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return file; // not decodable here — let the server judge it
  }
  const scale = MAX_IMAGE_EDGE / Math.max(bmp.width, bmp.height);
  if (scale >= 1) {
    bmp.close();
    return file;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? file), file.type, 0.9));
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error ?? new Error("could not read the file"));
    r.readAsDataURL(blob);
  });
}
