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
/** The quality checks a host can run on a photo (./checks), as it lists them
 *  in its capability's `checks`. */
export const CAMERA_CHECK_NAMES = ["blur", "brightness", "resolution"] as const;
export type CameraCheckName = (typeof CAMERA_CHECK_NAMES)[number];
/** The longest side of the downsampled grayscale copy the checks look at. */
export const CAMERA_CHECK_SIDE = 320;
/** What a page's checks may take before the rest are skipped, in ms. */
export const CAMERA_CHECK_BUDGET_MS = 60;
/** What a check that names no threshold uses. */
export const CAMERA_CHECK_DEFAULTS = {
  blur: { min: 35 },
  brightness: { min: 50, max: 235 },
  resolution: { minSide: 800 },
} as const;
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
  /** Quality checks run on the photo once it is taken. `true`: every check at
   *  its default; an object: just the named ones, each `true` (defaults) or
   *  with thresholds. The photo is always handed over: its `checks` says
   *  whether it passed and why not (the page decides about a retake). A host
   *  that runs no checks ignores the field and the photo has no `checks`. */
  checks?: true | { [K in CameraCheckName]?: true | Partial<CameraChecks[K]> };
  /** What a failed check does. Only `"warn"` (the default) so far: the photo
   *  is handed over with `checks.ok: false`. */
  onFail?: "warn";
  /** The most the checks may take in all, in ms (default `CAMERA_CHECK_BUDGET_MS`);
   *  a check that would start past it is skipped, never failed. */
  checkBudgetMs?: number;
}

/** The thresholds of each check, as the host runs them. */
export interface CameraChecks {
  /** Sharpness score 0 to 100 (higher is sharper); fails below `min`. */
  blur: { min: number };
  /** Mean brightness 0 to 255; fails below `min` (dark) or above `max` (bright). */
  brightness: { min: number; max: number };
  /** The photo's longest side in pixels; fails below `minSide`. */
  resolution: { minSide: number };
}

/** One check's outcome: its measurement and whether it held, or why it did not run. */
export type CameraCheckResult =
  | ({ ok: boolean; value: number; ms: number } & Record<string, number | boolean>)
  | { skipped: "budget" | "error" };

/** Why a photo failed: one code for the page to put in its own words. */
export type CameraCheckReason = "blur" | "dark" | "bright" | "small";

/** What the checks found. A skipped check is never a failure. */
export interface CameraCheckReport {
  ok: boolean;
  reasons: CameraCheckReason[];
  results: { [K in CameraCheckName]?: CameraCheckResult };
  totalMs: number;
}

/** A page's capture params as the host acts on them (`parseCaptureParams`). */
export type CameraCapture = Required<Pick<CameraCaptureParams, "facing" | "maxSide" | "review">> &
  Pick<CameraCaptureParams, "title" | "actions"> & {
    /** The checks to run, every threshold filled in. */
    checks?: CameraChecks;
    checkBudgetMs?: number;
  };

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
  /** Present when the page asked for `checks` and the host ran them. */
  checks?: CameraCheckReport;
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

/** The checks the host runs, from its capability: none for a host that lists none. */
export function cameraChecksOf(hostCapabilities: unknown): CameraCheckName[] {
  if (!cameraCapabilityOf(hostCapabilities)) return [];
  const c = (hostCapabilities as { experimental: Record<string, { checks?: unknown }> }).experimental[CAMERA_CAPABILITY]!.checks;
  return Array.isArray(c) ? CAMERA_CHECK_NAMES.filter((n) => c.includes(n)) : [];
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

/** A page's `checks`, every threshold filled from the defaults; an error as text. */
function parseChecks(c: unknown): CameraChecks | string | undefined {
  if (c === undefined || c === false) return undefined;
  const asked: Record<string, unknown> = c === true ? Object.fromEntries(CAMERA_CHECK_NAMES.map((n) => [n, true])) : (c as Record<string, unknown>);
  if (typeof asked !== "object" || asked === null || Array.isArray(asked)) return "capture: checks is true or an object { blur?, brightness?, resolution? }";
  const out: Record<string, Record<string, number>> = {};
  for (const [name, v] of Object.entries(asked)) {
    if (!(CAMERA_CHECK_NAMES as readonly string[]).includes(name)) return `capture: unknown check "${name}" (only ${CAMERA_CHECK_NAMES.join(", ")})`;
    const defaults = CAMERA_CHECK_DEFAULTS[name as CameraCheckName] as Record<string, number>;
    if (v !== true && (typeof v !== "object" || v === null || Array.isArray(v))) return `capture: check ${name} is true or { ${Object.keys(defaults).join("?, ")}? }`;
    const given = v === true ? {} : (v as Record<string, unknown>);
    for (const [k, x] of Object.entries(given)) {
      if (!(k in defaults)) return `capture: check ${name} has no field "${k}" (only ${Object.keys(defaults).join(", ")})`;
      if (typeof x !== "number" || !Number.isFinite(x)) return `capture: check ${name}.${k} is a number`;
    }
    out[name] = { ...defaults, ...(given as Record<string, number>) };
  }
  const b = out["brightness"];
  if (b && b["min"]! > b["max"]!) return "capture: check brightness has min above max";
  return Object.keys(out).length ? (out as unknown as CameraChecks) : undefined;
}

const ACTION_ID = /^[a-z0-9_-]{1,32}$/;

/** A page's capture params, checked: `{ facing?, maxSide?, title?, review?, actions? }` and nothing else. */
export function parseCaptureParams(params: unknown): { ok: true; params: CameraCapture } | { ok: false; error: string } {
  const p = (params ?? {}) as Record<string, unknown>;
  if (typeof p !== "object" || Array.isArray(p)) return { ok: false, error: "capture: params must be an object { facing?, maxSide?, title?, review?, actions?, checks?, onFail?, checkBudgetMs? }" };
  for (const k of Object.keys(p)) if (k !== "facing" && k !== "maxSide" && k !== "title" && k !== "review" && k !== "actions" && k !== "checks" && k !== "onFail" && k !== "checkBudgetMs") return { ok: false, error: `capture: unknown field "${k}" (only facing, maxSide, title, review, actions, checks, onFail and checkBudgetMs)` };
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
  if (p["onFail"] !== undefined && p["onFail"] !== "warn") return { ok: false, error: 'capture: onFail is "warn" (the photo is handed over with its checks)' };
  const budget = p["checkBudgetMs"];
  if (budget !== undefined && (typeof budget !== "number" || !Number.isFinite(budget) || budget < 1)) return { ok: false, error: "capture: checkBudgetMs is a number of milliseconds, at least 1" };
  const checks = parseChecks(p["checks"]);
  if (typeof checks === "string") return { ok: false, error: checks };
  return {
    ok: true,
    params: {
      ...(actions.length ? { actions } : {}),
      ...(checks ? { checks, ...(budget !== undefined ? { checkBudgetMs: budget as number } : {}) } : {}),
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
