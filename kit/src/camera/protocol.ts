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
/** Page → host: take a photo. `{ facing?, maxSide?, title? }` → a
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
}

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

/** A page's capture params, checked: `{ facing?, maxSide?, title? }` and nothing else. */
export function parseCaptureParams(params: unknown): { ok: true; params: Required<Pick<CameraCaptureParams, "facing" | "maxSide">> & Pick<CameraCaptureParams, "title"> } | { ok: false; error: string } {
  const p = (params ?? {}) as Record<string, unknown>;
  if (typeof p !== "object" || Array.isArray(p)) return { ok: false, error: "capture: params must be an object { facing?, maxSide?, title? }" };
  for (const k of Object.keys(p)) if (k !== "facing" && k !== "maxSide" && k !== "title") return { ok: false, error: `capture: unknown field "${k}" (only facing, maxSide and title)` };
  if (p["facing"] !== undefined && p["facing"] !== "environment" && p["facing"] !== "user") return { ok: false, error: 'capture: facing is "environment" or "user"' };
  const side = p["maxSide"];
  if (side !== undefined && (typeof side !== "number" || !Number.isInteger(side) || side < 64 || side > CAMERA_MAX_SIDE)) return { ok: false, error: `capture: maxSide is a whole number of pixels, 64 to ${CAMERA_MAX_SIDE}` };
  if (p["title"] !== undefined && (typeof p["title"] !== "string" || p["title"].length > 120)) return { ok: false, error: "capture: title is a line of at most 120 characters" };
  return {
    ok: true,
    params: {
      facing: (p["facing"] as "environment" | "user" | undefined) ?? "environment",
      maxSide: (side as number | undefined) ?? CAMERA_DEFAULT_SIDE,
      ...(typeof p["title"] === "string" && p["title"] ? { title: p["title"] } : {}),
    },
  };
}

/** The bridge's own schema stand-in: params pass through, checked by each side. */
export const CAMERA_PASS_THROUGH = {
  "~standard": { version: 1 as const, vendor: "strut", validate: (value: unknown) => ({ value }) },
};
