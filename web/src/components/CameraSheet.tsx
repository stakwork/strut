import { useEffect, useRef, useState } from "preact/hooks";
import type { CameraAction, CameraActionResult, CameraPhoto } from "@strut/kit/camera";
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
  onDone: (photo: CameraPhoto | CameraActionResult | null) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  /** The shot being looked at: its JPEG, made in the background. */
  const [shot, setShot] = useState<({ jpeg: Promise<Blob | null> } & Size) | null>(null);
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
      ?.getUserMedia({ video: { facingMode: props.facing, width: { ideal: 1920 }, height: { ideal: 1920 } }, audio: false })
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

  const hand = async (jpeg: Promise<Blob | null>, size: Size) => {
    setBusy(true);
    try {
      const blob = await jpeg;
      if (!blob) throw new Error("could not make the photo");
      props.onDone({ name: "photo.jpg", mediaType: "image/jpeg", data: await base64Of(blob), width: size.width, height: size.height });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
    c.getContext("2d")!.drawImage(v, 0, 0, size.width, size.height);
    const jpeg = new Promise<Blob | null>((resolve) => c.toBlob(resolve, "image/jpeg", 0.88));
    if (!props.review) return void hand(jpeg, size);
    // The picture stops on the shot at once; the JPEG is made behind it.
    v.pause();
    setShot({ jpeg, ...size });
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
            <button type="button" class="camera-btn is-primary" disabled={busy} onClick={() => void hand(shot.jpeg, shot)}>{words.usePhoto}</button>
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
