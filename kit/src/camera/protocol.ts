// ── The host's camera ──────────────────────────────────────────────────────
// An app's frame is a sandboxed document with an opaque origin, and a browser
// gives such a document no camera (Chrome: `getUserMedia` → "Invalid security
// origin", whatever the frame's `allow`). So the HOST draws the camera, in its
// own page, as it draws the payment and sign-in sheets: the page asks for a
// photo, the person takes it (or cancels), and the page gets that one photo —
// never the stream. Offered to a page whose app declares `camera` in its
// `permissions:`.

/** What a host puts in `ui/initialize`'s `hostCapabilities.experimental`
 *  when it draws the camera: `{ v: 1 }`. */
export const CAMERA_CAPABILITY = "strut/camera";
/** Page → host: take a photo. `{ facing?, maxSide?, title?, review? }` → a
 *  `CameraPhoto`, or `{ cancelled: true }` when the person closed the sheet. */
export const CAMERA_CAPTURE_METHOD = "strut/camera/capture";
/** How long a page waits for the person: they frame the shot. */
export const CAMERA_CAPTURE_TIMEOUT_MS = 10 * 60_000;
/** The longest side of a photo when the page names none, and the most it may name. */
export const CAMERA_DEFAULT_SIDE = 1600;
export const CAMERA_MAX_SIDE = 4096;

export interface CameraCaptureParams {
  /** Which camera: the one facing away (a document, the default) or the person. */
  facing?: "environment" | "user";
  /** The photo's longest side in pixels, at most `CAMERA_MAX_SIDE`. */
  maxSide?: number;
  /** A line the sheet shows over the viewfinder ("Fit the whole page in the frame"). */
  title?: string;
  /** Whether the person looks at the photo first (Retake / Use photo), the
   *  default. `false`: the shutter hands the photo over at once — one tap a
   *  photo, for many in a row (the pages of a book). */
  review?: boolean;
}

/** A page's capture params as the host acts on them (`parseCaptureParams`). */
export type CameraCapture = Required<Pick<CameraCaptureParams, "facing" | "maxSide" | "review">> & Pick<CameraCaptureParams, "title">;

/** The photo the person took: a JPEG, base64. */
export interface CameraPhoto {
  name: string;
  mediaType: string;
  data: string;
  width: number;
  height: number;
}

/** Whether the host draws a camera for this page. */
export function cameraCapabilityOf(hostCapabilities: unknown): boolean {
  const c = (hostCapabilities as { experimental?: Record<string, unknown> } | undefined)?.experimental?.[CAMERA_CAPABILITY];
  return typeof c === "object" && c !== null && (c as { v?: unknown }).v === 1;
}

/** The longest title the camera shows over its viewfinder. */
export const CAMERA_TITLE_MAX = 120;

/** A title as the camera shows it: one line, at most `CAMERA_TITLE_MAX`
 *  characters, a longer one cut with "…" — a task's whole ask is often
 *  longer, and a photo is never refused for its words. */
export function cameraTitle(title: string): string {
  const line = title.replace(/\s+/g, " ").trim();
  return line.length > CAMERA_TITLE_MAX ? `${line.slice(0, CAMERA_TITLE_MAX - 1).trimEnd()}…` : line;
}

/** A page's capture params, checked: `{ facing?, maxSide?, title?, review? }` and nothing else. */
export function parseCaptureParams(params: unknown): { ok: true; params: CameraCapture } | { ok: false; error: string } {
  const p = (params ?? {}) as Record<string, unknown>;
  if (typeof p !== "object" || Array.isArray(p)) return { ok: false, error: "capture: params must be an object { facing?, maxSide?, title?, review? }" };
  for (const k of Object.keys(p)) if (k !== "facing" && k !== "maxSide" && k !== "title" && k !== "review") return { ok: false, error: `capture: unknown field "${k}" (only facing, maxSide, title and review)` };
  if (p["facing"] !== undefined && p["facing"] !== "environment" && p["facing"] !== "user") return { ok: false, error: 'capture: facing is "environment" or "user"' };
  const side = p["maxSide"];
  if (side !== undefined && (typeof side !== "number" || !Number.isInteger(side) || side < 64 || side > CAMERA_MAX_SIDE)) return { ok: false, error: `capture: maxSide is a whole number of pixels, 64 to ${CAMERA_MAX_SIDE}` };
  if (p["title"] !== undefined && typeof p["title"] !== "string") return { ok: false, error: "capture: title is text, one line (a longer one is cut)" };
  if (p["review"] !== undefined && typeof p["review"] !== "boolean") return { ok: false, error: "capture: review is true or false" };
  return {
    ok: true,
    params: {
      facing: (p["facing"] as "environment" | "user" | undefined) ?? "environment",
      maxSide: (side as number | undefined) ?? CAMERA_DEFAULT_SIDE,
      review: p["review"] !== false,
      ...(typeof p["title"] === "string" && cameraTitle(p["title"]) ? { title: cameraTitle(p["title"]) } : {}),
    },
  };
}

/** The bridge's own schema stand-in: params pass through, checked by each side. */
export const CAMERA_PASS_THROUGH = {
  "~standard": { version: 1 as const, vendor: "strut", validate: (value: unknown) => ({ value }) },
};
