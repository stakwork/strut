// ── The host's camera ──────────────────────────────────────────────────────
// An app's frame is a sandboxed document with an opaque origin, and a browser
// gives such a document no camera (Chrome: `getUserMedia` → "Invalid security
// origin", whatever the frame's `allow`). So the HOST draws the camera, in its
// own page, as it draws the payment and sign-in sheets: the page asks for a
// photo, the person takes it (or cancels), and the page gets that one photo —
// never the stream. Offered to a page whose app declares `camera` in its
// `permissions:`.

/** What a host puts in `ui/initialize`'s `hostCapabilities.experimental`
 *  when it draws the camera: `{ v: 1 }`, plus `actions: true` when it draws
 *  a page's `actions` (a host without it refuses the field, so a client sends
 *  `actions` only when `cameraActionsOf` says so). */
export const CAMERA_CAPABILITY = "strut/camera";
/** Page → host: take a photo. `{ facing?, maxSide?, title?, review? }` → a
 *  `CameraPhoto`, or `{ cancelled: true }` when the person closed the sheet. */
export const CAMERA_CAPTURE_METHOD = "strut/camera/capture";
/** How long a page waits for the person: they frame the shot. */
export const CAMERA_CAPTURE_TIMEOUT_MS = 10 * 60_000;
/** The longest side of a photo when the page names none, and the most it may name. */
export const CAMERA_DEFAULT_SIDE = 1600;
export const CAMERA_MAX_SIDE = 4096;

/** The most actions a page may add, and the longest label (one line, cut). */
export const CAMERA_ACTIONS_MAX = 2;
export const CAMERA_ACTION_LABEL_MAX = 24;

/** A button the page adds beside the shutter ("Finish book"): tapping it
 *  closes the camera and answers `{ action: id }` instead of a photo. */
export interface CameraAction {
  /** What the page gets back: 1 to 32 of a-z, 0-9, `_` and `-`. */
  id: string;
  /** The button's words, in the page's language. */
  label: string;
}

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
  /** Up to `CAMERA_ACTIONS_MAX` buttons beside the shutter on the live
   *  viewfinder (not on the Retake / Use photo screen). Cancel stays. */
  actions?: CameraAction[];
}

/** A page's capture params as the host acts on them (`parseCaptureParams`). */
export type CameraCapture = Required<Pick<CameraCaptureParams, "facing" | "maxSide" | "review">> & Pick<CameraCaptureParams, "title" | "actions">;

/** What the host answers when the person tapped one of the page's actions. */
export interface CameraActionResult {
  action: string;
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

/** Whether the host also draws a page's `actions`. */
export function cameraActionsOf(hostCapabilities: unknown): boolean {
  const c = (hostCapabilities as { experimental?: Record<string, unknown> } | undefined)?.experimental?.[CAMERA_CAPABILITY];
  return cameraCapabilityOf(hostCapabilities) && (c as { actions?: unknown }).actions === true;
}

/** An action's label as the camera shows it: one line, cut with "…". */
export function cameraActionLabel(label: string): string {
  const line = label.replace(/\s+/g, " ").trim();
  return line.length > CAMERA_ACTION_LABEL_MAX ? `${line.slice(0, CAMERA_ACTION_LABEL_MAX - 1).trimEnd()}…` : line;
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

const ACTION_ID = /^[a-z0-9_-]{1,32}$/;

/** A page's capture params, checked: `{ facing?, maxSide?, title?, review?, actions? }` and nothing else. */
export function parseCaptureParams(params: unknown): { ok: true; params: CameraCapture } | { ok: false; error: string } {
  const p = (params ?? {}) as Record<string, unknown>;
  if (typeof p !== "object" || Array.isArray(p)) return { ok: false, error: "capture: params must be an object { facing?, maxSide?, title?, review?, actions? }" };
  for (const k of Object.keys(p)) if (k !== "facing" && k !== "maxSide" && k !== "title" && k !== "review" && k !== "actions") return { ok: false, error: `capture: unknown field "${k}" (only facing, maxSide, title, review and actions)` };
  if (p["facing"] !== undefined && p["facing"] !== "environment" && p["facing"] !== "user") return { ok: false, error: 'capture: facing is "environment" or "user"' };
  const side = p["maxSide"];
  if (side !== undefined && (typeof side !== "number" || !Number.isInteger(side) || side < 64 || side > CAMERA_MAX_SIDE)) return { ok: false, error: `capture: maxSide is a whole number of pixels, 64 to ${CAMERA_MAX_SIDE}` };
  if (p["title"] !== undefined && typeof p["title"] !== "string") return { ok: false, error: "capture: title is text, one line (a longer one is cut)" };
  if (p["review"] !== undefined && typeof p["review"] !== "boolean") return { ok: false, error: "capture: review is true or false" };
  const actions: CameraAction[] = [];
  if (p["actions"] !== undefined) {
    const a = p["actions"];
    if (!Array.isArray(a) || a.length > CAMERA_ACTIONS_MAX) return { ok: false, error: `capture: actions is a list of at most ${CAMERA_ACTIONS_MAX} { id, label }` };
    for (const x of a as Array<Record<string, unknown> | null>) {
      if (typeof x !== "object" || x === null || typeof x["id"] !== "string" || !ACTION_ID.test(x["id"]) || typeof x["label"] !== "string") return { ok: false, error: "capture: each action is { id, label }: id 1 to 32 of a-z, 0-9, _ and -; label text" };
      const label = cameraActionLabel(x["label"]);
      if (!label) return { ok: false, error: "capture: an action's label is not empty" };
      if (actions.some((y) => y.id === x["id"])) return { ok: false, error: `capture: action id "${x["id"]}" is twice` };
      actions.push({ id: x["id"], label });
    }
  }
  return {
    ok: true,
    params: {
      ...(actions.length ? { actions } : {}),
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
