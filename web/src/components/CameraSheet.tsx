import { useEffect, useRef, useState } from "preact/hooks";
import type { CameraPhoto } from "@strut/kit/camera";

// ── The host's camera (@strut/kit/camera) ──────────────────────────────────
//
// An app's frame is an opaque-origin document, and the browser gives it no
// camera. So strut draws the camera here, in its own page, over the frame —
// as it draws the payment and sign-in sheets — when the page asks for a photo
// (`useCamera().capture()`). The stream never reaches the page: the person
// takes a shot, looks at it, and only "Use photo" hands that one JPEG over.
// Cancel, or the page going away, answers null.

/** The size a frame of `w` × `h` is drawn at so its longest side is at most `max`. */
export function photoSize(w: number, h: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

const base64Of = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error ?? new Error("could not read the photo"));
    r.readAsDataURL(blob);
  });

export function CameraSheet(props: {
  /** Who asks: the app's title. */
  app: string;
  facing: "environment" | "user";
  maxSide: number;
  title?: string;
  onDone: (photo: CameraPhoto | null) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [shot, setShot] = useState<{ blob: Blob; url: string; width: number; height: number } | null>(null);
  const [busy, setBusy] = useState(false);

  // The camera, while the person frames a shot.
  useEffect(() => {
    if (shot) return;
    let stream: MediaStream | undefined;
    let gone = false;
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: props.facing, width: { ideal: 1920 }, height: { ideal: 1920 } }, audio: false })
      .then((s) => {
        if (gone) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        if (video.current) video.current.srcObject = s;
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    if (!navigator.mediaDevices) setError("This browser offers no camera here.");
    return () => {
      gone = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [shot, props.facing]);
  useEffect(() => () => shot && URL.revokeObjectURL(shot.url), [shot]);

  const take = () => {
    const v = video.current;
    if (!v?.videoWidth) return;
    const size = photoSize(v.videoWidth, v.videoHeight, props.maxSide);
    const c = document.createElement("canvas");
    c.width = size.width;
    c.height = size.height;
    c.getContext("2d")!.drawImage(v, 0, 0, size.width, size.height);
    c.toBlob((blob) => blob && setShot({ blob, url: URL.createObjectURL(blob), ...size }), "image/jpeg", 0.88);
  };
  const use = async () => {
    if (!shot) return;
    setBusy(true);
    try {
      props.onDone({ name: "photo.jpg", mediaType: "image/jpeg", data: await base64Of(shot.blob), width: shot.width, height: shot.height });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div class="camera-sheet" role="dialog" aria-label={`${props.app} asks for a photo`} data-testid="camera-sheet">
      {shot ? <img class="camera-media" src={shot.url} alt="The photo" /> : <video ref={video} class="camera-media" autoPlay playsInline muted />}
      <div class="camera-top">
        <button type="button" class="camera-cancel" onClick={() => props.onDone(null)}>Cancel</button>
        <div class="camera-asks">
          <strong>{props.app}</strong> asks for a photo
          {props.title && !shot && <div class="camera-title">{props.title}</div>}
        </div>
      </div>
      {error && <div class="camera-error">Camera: {error}</div>}
      <div class="camera-bar">
        {shot ? (
          <>
            <button type="button" class="camera-btn" disabled={busy} onClick={() => setShot(null)}>Retake</button>
            <button type="button" class="camera-btn is-primary" disabled={busy} onClick={() => void use()}>Use photo</button>
          </>
        ) : (
          <button type="button" class="camera-shutter" aria-label="Take photo" disabled={!!error} onClick={take} />
        )}
      </div>
    </div>
  );
}
