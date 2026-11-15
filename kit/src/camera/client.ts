/** The app's side of the host's camera (./protocol): `available` when the
 *  host offers `experimental["strut/camera"]`; `capture` asks it for a photo
 *  and answers it as a `File`, or null when the person cancelled. No React. */
import { CAMERA_CAPTURE_METHOD, CAMERA_CAPTURE_TIMEOUT_MS, CAMERA_PASS_THROUGH, cameraCapabilityOf, type CameraCaptureParams } from "./protocol.js";

/** What of the MCP Apps `App` the client uses. */
export interface CameraBridgeApp {
  getHostCapabilities(): unknown;
  request(r: { method: string; params?: Record<string, unknown> }, schema: unknown, options?: { timeout?: number }): Promise<unknown>;
}

export interface CameraClient {
  available(): boolean;
  capture(params?: CameraCaptureParams): Promise<File | null>;
}

const NO_CAMERA_ERROR = "this page's host draws no camera (declare camera in app.yaml's permissions:)";

export function createBridgeCamera(app: CameraBridgeApp): CameraClient {
  const available = () => cameraCapabilityOf(app.getHostCapabilities());
  return {
    available,
    async capture(params = {}) {
      if (!available()) throw new Error(NO_CAMERA_ERROR);
      const r = (await app.request({ method: CAMERA_CAPTURE_METHOD, params: { ...params } }, CAMERA_PASS_THROUGH, { timeout: CAMERA_CAPTURE_TIMEOUT_MS })) as {
        cancelled?: unknown; name?: unknown; mediaType?: unknown; data?: unknown;
      } | undefined;
      if (!r || r.cancelled === true || typeof r.data !== "string") return null;
      const bin = atob(r.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const type = typeof r.mediaType === "string" ? r.mediaType : "image/jpeg";
      return new File([bytes], typeof r.name === "string" && r.name ? r.name : "photo.jpg", { type });
    },
  };
}

export const NO_CAMERA: CameraClient = {
  available: () => false,
  capture: async () => {
    throw new Error(NO_CAMERA_ERROR);
  },
};
