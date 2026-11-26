import { useEffect, useRef, useState } from "preact/hooks";
import { CAMERA_CHECK_SIDE, runChecks, type CameraAction, type CameraActionResult, type CameraCheckReport, type CameraChecks, type CameraPhoto } from "@strut/kit/camera";
import { words } from "../words";

// ── The host's camera (@strut/kit/camera) ──────────────────────────────────
//
// An app's frame is an opaque-origin document, and the browser gives it no
// camera. So strut draws the camera here, in its own page, over the frame —
// as it draws the payment and sign-in sheets — when the page asks for a photo
// (`useCamera().capture()`). The stream never reaches the page: the person
// takes a shot, looks at it, and only "Use photo" hands that one JPEG over —
// or, when the page asked with `review: false`, the shutter hands it over at
// once (one tap a photo: the pages of a book). An app may add `actions`
// beside the shutter (a book's "Finish book"): a tap closes the sheet and
// answers { action: id }, not on the Retake / Use photo screen. Every shot flashes, and the
// shutter waits for the camera's first frame. Cancel, or the page going away,
// answers null. In the page's language (../words).
//
// The shot shows the moment it is taken: the video stops on that frame while
// the JPEG is made behind it (a phone's web view takes seconds to encode one,
// and the live picture kept moving meanwhile, as if nothing was taken), and
// Use photo waits for it only if it is not done yet. The camera stays on
// while the person looks, so Retake is the live picture again at once.

/** The size a frame of `w` × `h` is drawn at so its longest side is at most `max`. */
export function photoSize(w: number, h: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/**
 * What the viewfinder asks the camera for: no more than a shot can use. The
 * shot is drawn at most `maxSide` on its longest side, so a stream bigger than
 * that is decoded, composited and scaled for nothing — and on Android, where
 * the web view is far slower at it than iOS, it is what makes the live picture
 * stutter. Capped at 1920, the most a viewfinder needs; 30 fps likewise.
 */
export function streamSize(maxSide: number): { width: { ideal: number }; height: { ideal: number } } {
  const side = Math.max(640, Math.min(1920, Math.round(maxSide)));
  return { width: { ideal: side }, height: { ideal: side } };
}

/**
 * The page's quality checks on the photo just drawn (`canvas`): a small
 * grayscale-sized copy is looked at, never the full photo, and it is made
 * after the shot shows (a timeout), so the shutter never waits on it. A
 * failure to check answers no report: the photo goes over as it is.
 */
function checkPhoto(canvas: HTMLCanvasElement, size: Size, checks: CameraChecks, budgetMs: number | undefined): Promise<CameraCheckReport | undefined> {
  return new Promise((resolve) =>
    setTimeout(() => {
      try {
        const { width, height } = photoSize(size.width, size.height, CAMERA_CHECK_SIDE);
        const small = document.createElement("canvas");
        small.width = width;
        small.height = height;
        const ctx = small.getContext("2d", { alpha: false, willReadFrequently: true })!;
        ctx.drawImage(canvas, 0, 0, width, height);
        resolve(runChecks(checks, ctx.getImageData(0, 0, width, height), size, budgetMs === undefined ? {} : { budgetMs }));
      } catch {
        resolve(undefined);
      }
    }, 0),
  );
}

const base64Of = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error ?? new Error("could not read the photo"));
    r.readAsDataURL(blob);
  });

type Size = { width: number; height: number };

export function CameraSheet(props: {
  /** Who asks: the app's title. */
  app: string;
  facing: "environment" | "user";
  maxSide: number;
  title?: string;
  /** Retake / Use photo before the page gets it; false: the shutter hands it over. */
  review: boolean;
  /** Buttons the page adds beside the shutter, on the live viewfinder only. */
  actions?: CameraAction[];
  /** Quality checks to run on each shot; the report goes with the photo. */
  checks?: CameraChecks;
  checkBudgetMs?: number;
  onDone: (photo: CameraPhoto | CameraActionResult | null) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  /** The shot being looked at: its JPEG, made in the background. */
  const [shot, setShot] = useState<({ jpeg: Promise<Blob | null>; report?: Promise<CameraCheckReport | undefined> } & Size) | null>(null);
  const [busy, setBusy] = useState(false);
  // The camera has a frame to take: until then a tap would take nothing.
  const [ready, setReady] = useState(false);
  // Each shot's flash, so the person sees it was taken.
  const [flash, setFlash] = useState(0);

  // The camera, while the sheet is open.
  useEffect(() => {
    setReady(false);
    let stream: MediaStream | undefined;
    let gone = false;
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: props.facing, ...streamSize(props.maxSide), frameRate: { ideal: 30, max: 30 } }, audio: false })
      .then((s) => {
        if (gone) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        if (video.current) video.current.srcObject = s;
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    if (!navigator.mediaDevices) setError(words.noCamera);
    return () => {
      gone = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [props.facing]);

  // Set at the press, before any state renders, so a second tap is refused
  // even in the frame before the buttons disable.
  const handing = useRef(false);
  const hand = async (jpeg: Promise<Blob | null>, size: Size, report?: Promise<CameraCheckReport | undefined>) => {
    if (handing.current) return;
    handing.current = true;
    setBusy(true);
    try {
      // Let the loading state paint before the heavy part (waiting on the
      // JPEG, reading it to base64) can keep the main thread.
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      const blob = await jpeg;
      if (!blob) throw new Error("could not make the photo");
      const checks = await report;
      props.onDone({ name: "photo.jpg", mediaType: "image/jpeg", data: await base64Of(blob), width: size.width, height: size.height, ...(checks ? { checks } : {}) });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      handing.current = false;
      setBusy(false);
    }
  };
  const take = () => {
    const v = video.current;
    if (!v?.videoWidth || busy || shot) return;
    setFlash((n) => n + 1);
    const size = photoSize(v.videoWidth, v.videoHeight, props.maxSide);
    const c = document.createElement("canvas");
    c.width = size.width;
    c.height = size.height;
    c.getContext("2d", { alpha: false })!.drawImage(v, 0, 0, size.width, size.height);
    const jpeg = new Promise<Blob | null>((resolve) => c.toBlob(resolve, "image/jpeg", 0.88));
    const report = props.checks ? checkPhoto(c, size, props.checks, props.checkBudgetMs) : undefined;
    if (!props.review) return void hand(jpeg, size, report);
    // The picture stops on the shot at once; the JPEG is made behind it.
    v.pause();
    setShot({ jpeg, ...(report ? { report } : {}), ...size });
  };
  const retake = () => {
    setShot(null);
    void video.current?.play().catch(() => undefined);
  };

  return (
    <div class="camera-sheet" role="dialog" aria-label={`${props.app} ${words.asksForPhoto}`} data-testid="camera-sheet">
      <video ref={video} class="camera-media" autoPlay playsInline muted onLoadedData={() => setReady(true)} />
      {flash > 0 && <div key={flash} class="camera-flash" />}
      <div class="camera-top">
        <button type="button" class="camera-cancel" onClick={() => props.onDone(null)}>{words.cancel}</button>
        <div class="camera-asks">
          <strong>{props.app}</strong> {words.asksForPhoto}
          {props.title && !shot && <div class="camera-title">{props.title}</div>}
        </div>
      </div>
      {error && <div class="camera-error">{words.camera}: {error}</div>}
      <div class="camera-bar">
        {shot ? (
          <>
            <button type="button" class="camera-btn" disabled={busy} onClick={retake}>{words.retake}</button>
            <button type="button" class={`camera-btn is-primary${busy ? " is-busy" : ""}`} disabled={busy} aria-busy={busy} onClick={() => void hand(shot.jpeg, shot, shot.report)}>
              {busy && <span class="camera-spinner" aria-hidden="true" />}
              {words.usePhoto}
            </button>
          </>
        ) : (
          <>
            <div class="camera-actions">
              {props.actions?.map((a) => (
                <button type="button" key={a.id} class="camera-action" data-testid={`camera-action-${a.id}`} disabled={busy} onClick={() => props.onDone({ action: a.id })}>{a.label}</button>
              ))}
            </div>
            <button type="button" class="camera-shutter" aria-label={words.takePhoto} disabled={!!error || !ready || busy} onClick={take} />
            <div class="camera-actions-balance" aria-hidden="true" />
          </>
        )}
      </div>
    </div>
  );
}
