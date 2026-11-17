// A photo shrunk in the page before it goes (plans/support-chat.md §3, item
// 2): drawn on a canvas at most `side` px on its longer side, as a JPEG, so a
// phone's 12 MP photo fits the page's 4 MB call. A file as base64.
import { fitWithin } from "./view";

/** `blob` as a JPEG at most `side` px on its longer side; a transparent PNG
 *  on white, not black. Throws when the browser cannot read it (a HEIC in
 *  Chrome): the caller sends it as it is. */
export async function shrinkImage(blob: Blob, side: number): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, side);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext("2d");
    if (!g) throw new Error("this browser cannot draw the photo");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, width, height);
    g.drawImage(bitmap, 0, 0, width, height);
    const out = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", 0.85));
    if (!out) throw new Error("the photo could not be drawn");
    return out;
  } finally {
    bitmap.close();
  }
}

/** A blob's bytes as base64, in pieces (a long spread overflows the stack). */
export async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** A name with its extension made `.jpg`, for a photo shrunk to a JPEG. */
export function jpgName(name: string): string {
  const base = name.replace(/\.[^./\\]*$/, "") || "photo";
  return `${base}.jpg`;
}
