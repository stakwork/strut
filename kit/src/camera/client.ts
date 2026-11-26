/** The app's side of the host's camera (./protocol): `available` when the
 *  host offers `experimental["strut/camera"]`; `capture` asks it for a photo
 *  and answers it as a `File`, or null when the person cancelled. No React. */
import { CAMERA_CAPTURE_METHOD, CAMERA_CAPTURE_TIMEOUT_MS, CAMERA_PASS_THROUGH, cameraActionsOf, cameraCapabilityOf, cameraChecksOf, cameraTitle,type CameraCheckReport, type CameraCaptureParams } from "./protocol.js";

/** What of the MCP Apps `App` the client uses. */
export interface CameraBridgeApp {
  getHostCapabilities(): unknown;
  request(r: { method: string; params?: Record<string, unknown> }, schema: unknown, options?: { timeout?: number }): Promise<unknown>;
}

/** What `captureOrAction` answers: the photo, or the id of the action the
 *  person tapped; null when they cancelled. */
export type CameraOutcome = { photo: File; checks?: CameraCheckReport } | { action: string } | null;

export interface CameraClient {
  available(): boolean;
  /** The photo, or null when cancelled (or an action was tapped: use `captureOrAction` to tell). */
  capture(params?: CameraCaptureParams): Promise<File | null>;
  /** Like `capture`, and tells an action's tap from a cancel. A host that
   *  draws no actions gets none sent: the answer is then a photo or null. */
  captureOrAction(params?: CameraCaptureParams): Promise<CameraOutcome>;
}

const NO_CAMERA_ERROR = "this page's host draws no camera (declare camera in app.yaml's permissions:)";

export function createBridgeCamera(app: CameraBridgeApp): CameraClient {
  const available = () => cameraCapabilityOf(app.getHostCapabilities());
  const captureOrAction = async (params: CameraCaptureParams = {}): Promise<CameraOutcome> => {
    if (!available()) throw new Error(NO_CAMERA_ERROR);
    // A long title is cut to the camera's one line here, as the host would.
    const { actions, checks, ...rest } = params;
    const sent: Record<string, unknown> = typeof rest.title === "string" ? { ...rest, title: cameraTitle(rest.title) } : { ...rest };
    // Actions only to a host that draws them; an older one would refuse the field.
    if (actions?.length && cameraActionsOf(app.getHostCapabilities())) sent["actions"] = actions;
    // Checks only to a host that runs them (an object: only the ones it lists);
    // their knobs go with them, and an older host never sees any of the fields.
    const runs = cameraChecksOf(app.getHostCapabilities());
    const asked = !checks ? [] : checks === true ? runs : runs.filter((n) => n in checks);
    delete sent["checkBudgetMs"];
    delete sent["onFail"];
    if (asked.length) {
      sent["checks"] = checks === true ? true : Object.fromEntries(asked.map((n) => [n, checks![n]]));
      for (const k of ["checkBudgetMs", "onFail"] as const) if (rest[k] !== undefined) sent[k] = rest[k];
    }
    const r = (await app.request({ method: CAMERA_CAPTURE_METHOD, params: sent }, CAMERA_PASS_THROUGH, { timeout: CAMERA_CAPTURE_TIMEOUT_MS })) as {
      cancelled?: unknown; action?: unknown; name?: unknown; mediaType?: unknown; data?: unknown;
    } | undefined;
    if (r && typeof r.action === "string") return { action: r.action };
    if (!r || r.cancelled === true || typeof r.data !== "string") return null;
    const bin = atob(r.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const type = typeof r.mediaType === "string" ? r.mediaType : "image/jpeg";
    const report = (r as { checks?: CameraCheckReport }).checks;
    return { photo: new File([bytes], typeof r.name === "string" && r.name ? r.name : "photo.jpg", { type }), ...(report ? { checks: report } : {}) };
  };
  return {
    available,
    captureOrAction,
    async capture(params = {}) {
      const o = await captureOrAction(params);
      return o && "photo" in o ? o.photo : null;
    },
  };
}

export const NO_CAMERA: CameraClient = {
  available: () => false,
  capture: async () => {
    throw new Error(NO_CAMERA_ERROR);
  },
  captureOrAction: async () => {
    throw new Error(NO_CAMERA_ERROR);
  },
};
