/** `useCamera` (./camera): a photo the person takes in the HOST's camera
 *  sheet — an app's frame gets no camera of its own. */
import { useStrutCamera } from "./provider.js";
import type { CameraCaptureParams } from "./camera/protocol.js";

export interface UseCamera {
  /** The host draws a camera for this page (its app declares `camera`). */
  available: boolean;
  /** Open the host's camera; the photo the person took as a JPEG `File`, or
   *  null when they cancelled. Call it on a click. */
  capture(params?: CameraCaptureParams): Promise<File | null>;
}

export function useCamera(): UseCamera {
  const camera = useStrutCamera();
  return { available: camera.available(), capture: camera.capture };
}
