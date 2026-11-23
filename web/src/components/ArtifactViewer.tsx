import { useEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { artifactUrl, downloadArtifact, fetchArtifactText, fileScopeOf } from "../api";
import { artifactKind, artifactRel, directoryEntries, isPeerPath, parseWalkthrough, resolveArtifactLink, viewerKind, walkthroughManifest } from "@strut/kit/folds";
import { ArrowLeftIcon, CloseIcon, PauseIcon, PlayIcon } from "../icons";
import { useFileBlob, useFileScope } from "../use-artifact-url";
import { Markdown, type MarkdownLink } from "./Markdown";
import { AppHost, type HostedApp } from "./AppHost";

// ── Artifact viewer ────────────────────────────────────────────────────────
//
// A modal that shows one run artifact rendered by its kind (`artifact-view.ts`):
// markdown through the chat's renderer, images / video / audio as media,
// pdf + html in a frame (html sandboxed, scripts allowed — a step wrote it,
// and the one thing its URL holds is the run's file token), text in a pre,
// a DIRECTORY as one level of folders and files, a WALKTHROUGH (a
// `browser/walkthrough` recording's manifest, or the directory holding one:
// `walkthroughManifest`) as frames to play and scrub through.
// Opened from the eye beside
// an artifact link (`ValueFields`) — and it MOVES: a link in a markdown file
// that names a sibling (`resolveArtifactLink`) and a row of a directory open
// in place, with a back arrow over the trail; a link to anything else stays
// a link. Everything it shows is one scope's files — the run's, or the
// job's — whose listing (`useFileScope`) tells a directory from a file and
// carries the token every `src` and link needs, so the body waits for it.
// Portaled onto <body>: the events panel and the flyout are their own
// stacking contexts, so a backdrop rendered inside one would sit under the
// other.
//
// An APP the caller names (`app`: a published app, its document the path)
// renders through the app host, not as an HTML page.
//
// A PEER's file (`/peers/<id>/…`, plans/chained-orchestrators.md §5) is read
// through this strut with its token for the peer: no `?t=` opens it from a
// link, and the key must never ride in a `src`. So it is fetched with the
// UI's own credential and shown from the bytes — an image, video, audio or
// PDF from an object URL, an HTML page as the text of a frame that runs
// nothing (the read-through never serves a peer's page with scripts) — and
// a file nothing renders downloads. `solo`: in normal flow, no backdrop —
// the viewer alone in the window with nothing to close (`?artifact=…&solo=1`),
// or the app host's side panel (./AppWithPanel), which passes `onClose`.

export function ArtifactViewer(props: {
  path: string;
  onClose?: () => void;
  solo?: boolean;
  /** An app to render through the host (the path is its document). */
  app?: HostedApp;
  /** A strut link the app opened (`ui/open-link`). */
  onNavigate?: (params: Record<string, string>) => void;
}) {
  const [path, setPath] = useState(props.path);
  const [trail, setTrail] = useState<string[]>([]);
  useEffect(() => { setPath(props.path); setTrail([]); }, [props.path]);

  const scope = useFileScope(path);
  const files = scope?.files ?? null;
  const kind = viewerKind(path, files);
  // The file shown: the path, or for a recording's directory its manifest.
  const file = (kind === "walkthrough" ? walkthroughManifest(path, files) : null) ?? path;
  const peer = isPeerPath(path);
  const hosted = props.app && path === props.path ? props.app : null;
  const wantsText = !hosted && (kind === "markdown" || kind === "text" || kind === "walkthrough" || (peer && kind === "html"));
  const wantsBlob = !hosted && peer && (kind === "image" || kind === "video" || kind === "audio" || kind === "pdf");
  const blob = useFileBlob(wantsBlob ? path : null, kind === "pdf" ? "application/pdf" : undefined);
  const url = !scope ? undefined : peer ? blob.url ?? undefined : artifactUrl(file, scope.token);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const close = props.onClose;
    if (!close) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  useEffect(() => {
    if (!wantsText) return;
    let cancelled = false;
    setText(null);
    setError("");
    fetchArtifactText(file).then(
      (t) => { if (!cancelled) setText(t); },
      (e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); },
    );
    return () => { cancelled = true; };
  }, [file, wantsText]);

  const go = (to: string) => { setTrail((t) => [...t, path]); setPath(to); };
  const back = () => {
    const prev = trail[trail.length - 1];
    if (prev === undefined) return;
    setTrail((t) => t.slice(0, -1));
    setPath(prev);
  };

  // Where a link in this file leads: a file of the scope opens in place when
  // something renders it, and is a link to the served file when nothing
  // does (a peer's downloads); anything outside the scope is left as written.
  const token = scope?.token ?? "";
  const resolveLink = (href: string): MarkdownLink | null => {
    const to = resolveArtifactLink(path, href);
    if (!to) return null;
    return {
      url: artifactUrl(to, token),
      open: viewerKind(to, files) ? () => go(to) : peer ? () => void downloadArtifact(to).catch(() => {}) : undefined,
      img: (alt) => <FileImg class="md-img" path={to} token={token} alt={alt} />,
    };
  };

  const body = () => {
    if (hosted) return <AppHost app={hosted} {...(props.onNavigate ? { onNavigate: props.onNavigate } : {})} />;
    if (error || blob.error) return <div class="artifact-status tone-error">{error || blob.error}</div>;
    if (!scope || (wantsText && text == null) || (wantsBlob && !url)) return <div class="artifact-status">Loading…</div>;
    switch (kind) {
      case "markdown": return <Markdown source={text ?? ""} resolveLink={resolveLink} />;
      case "text": return <pre class="artifact-text">{text}</pre>;
      case "image": return <img class="artifact-img" src={url} alt={path} />;
      case "video": return <video class="artifact-media" src={url} controls />;
      case "audio": return <audio class="artifact-audio" src={url} controls />;
      case "pdf": return <iframe class="artifact-frame" src={url} title={path} />;
      case "html": return peer
        ? <iframe class="artifact-frame" srcdoc={text ?? ""} title={path} sandbox="" />
        : <iframe class="artifact-frame" src={url} title={path} sandbox="allow-scripts" />;
      case "directory": return <Directory files={scope.files} path={path} token={scope.token} onOpen={go} />;
      case "walkthrough": return <WalkthroughView key={file} text={text ?? ""} manifest={file} token={scope.token} />;
      default: return <div class="artifact-status">No inline viewer for this file type.</div>;
    }
  };

  const view = (
    <>
      <div class="artifact-dialog-head">
        {trail.length > 0 && (
          <button class="copy-btn" onClick={back} aria-label="Back" title="Back"><ArrowLeftIcon /></button>
        )}
        <span class="artifact-dialog-path" title={path}>{path}</span>
        {!peer && url && kind !== "directory" && (
          <a class="artifact-dialog-open" href={url} target="_blank" rel="noopener">Open in new tab ↗</a>
        )}
        {scope && kind !== "directory" && (
          <button class="artifact-dialog-open" onClick={() => void downloadArtifact(file).catch(() => {})}>Download ↓</button>
        )}
        {props.onClose && (
          <button class="copy-btn" onClick={props.onClose} aria-label="Close" title="Close"><CloseIcon /></button>
        )}
      </div>
      <div class="artifact-dialog-body">{body()}</div>
    </>
  );
  if (props.solo) return <div class="artifact-solo" aria-label={path}>{view}</div>;
  return createPortal(
    <div class="dialog-backdrop" onClick={(e) => { if (e.target === e.currentTarget) props.onClose?.(); }}>
      <div class="dialog artifact-dialog" role="dialog" aria-label={path}>{view}</div>
    </div>,
    document.body,
  );
}

/** An image of a served file: by its tokened URL here, from its bytes for a
 *  peer's (`useFileBlob`). */
function FileImg(props: { path: string; token: string; alt: string; class?: string; loading?: "lazy" }) {
  const peer = isPeerPath(props.path);
  const blob = useFileBlob(peer ? props.path : null);
  const src = peer ? blob.url : artifactUrl(props.path, props.token);
  if (!src) return <span class="artifact-status">{blob.error || "Loading…"}</span>;
  return <img class={props.class} src={src} alt={props.alt} {...(props.loading ? { loading: props.loading } : {})} />;
}

/** One level of a directory: folders first, then files. A row the viewer
 *  can render opens in place; one it cannot downloads. */
function Directory(props: { files: string[]; path: string; token: string; onOpen: (path: string) => void }) {
  const scope = fileScopeOf(props.path) ?? "";
  const rel = artifactRel(props.path) ?? "";
  const { dirs, files } = directoryEntries(props.files, rel);
  const at = (name: string) => `${scope}/${rel ? `${rel}/` : ""}${name}`;
  if (!dirs.length && !files.length) return <div class="artifact-status">Empty directory.</div>;
  return (
    <ul class="artifact-dir">
      {dirs.map((d) => (
        <li key={`d:${d}`}>
          <button class="artifact-dir-row is-dir" onClick={() => props.onOpen(`${at(d)}/`)}>{d}/</button>
        </li>
      ))}
      {files.map((f) => {
        const p = at(f);
        return (
          <li key={`f:${f}`}>
            {artifactKind(p)
              ? <button class="artifact-dir-row" onClick={() => props.onOpen(p)}>{f}</button>
              : <button class="artifact-dir-row" onClick={() => void downloadArtifact(p).catch(() => {})}>{f} ↓</button>}
          </li>
        );
      })}
    </ul>
  );
}

/** How long each frame shows while a walkthrough plays. */
const STEP_MS = 800;
/** How often a recording still in progress is read again. */
const RECORDING_POLL_MS = 3000;
const STATUS_WORDS: Record<string, string> = { recording: "Recording…", done: "Done", stopped: "Stopped" };

/** A walkthrough, played like a video: every frame mounted and stacked, all
 *  hidden but the one showing, so the browser has them by the time the
 *  reader plays or scrubs to one; under it the step count, the caption and
 *  where the page was, Play (a frame every STEP_MS; at the end it starts
 *  over), a bar with a segment per step, those still ahead faded, to click
 *  or drag, and a filmstrip. ← → step through while the player has focus.
 *  A recording still in progress (`status: "recording"`) is read again
 *  every few seconds, and the player follows its newest frame until the
 *  reader picks one. A frame where the recording stopped is outlined in
 *  red, with why. The manifest as text when it does not parse — a
 *  half-written one is still worth reading. Keyed by the manifest. */
function WalkthroughView(props: { text: string; manifest: string; token: string }) {
  const [text, setText] = useState(props.text);
  const w = parseWalkthrough(text, props.manifest);
  const recording = w?.status === "recording";
  const count = w?.frames.length ?? 0;
  // Null follows the newest frame: a recording opens on it, a finished one on its first.
  const [at, setAt] = useState<number | null>(() => (recording ? null : 0));
  const [playing, setPlaying] = useState(false);
  const i = Math.max(0, Math.min(at ?? count - 1, count - 1));
  const root = useRef<HTMLDivElement>(null);

  // The arrows are the player's while it has focus, which it takes on opening.
  useEffect(() => { root.current?.focus({ preventScroll: true }); }, []);

  // Read a recording in progress again till it is done. A read that fails,
  // or finds the manifest half-written, keeps what is shown.
  useEffect(() => {
    if (!recording) return;
    let on = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = () => {
      timer = setTimeout(() => {
        fetchArtifactText(props.manifest, { cache: "no-store" })
          .then((t) => { if (on && parseWalkthrough(t, props.manifest)) setText(t); }, () => {})
          .finally(() => { if (on) later(); });
      }, RECORDING_POLL_MS);
    };
    later();
    return () => { on = false; clearTimeout(timer); };
  }, [recording, props.manifest]);

  // Playing: the next frame every STEP_MS from wherever the reader is, until the last.
  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => {
      setAt(Math.min(i + 1, count - 1));
      if (i + 1 >= count - 1) setPlaying(false);
    }, STEP_MS);
    return () => clearTimeout(t);
  }, [playing, i, count]);

  const togglePlay = () => {
    // At the end, Play starts over.
    if (!playing && i >= count - 1) setAt(0);
    setPlaying(!playing);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    // The slider steps on its own arrows.
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); setAt(Math.max(0, i - 1)); }
    if (e.key === "ArrowRight") { e.preventDefault(); setAt(Math.min(count - 1, i + 1)); }
  };

  if (!w) return <pre class="artifact-text">{text}</pre>;
  const frame = w.frames[i];
  const title = w.title ?? "Walkthrough";
  return (
    <div class="walkthrough" ref={root} tabIndex={0} onKeyDown={onKeyDown} aria-label={title}>
      <div class="walkthrough-head">
        <span class="walkthrough-title">{title}</span>
        {w.status && <span class={`walkthrough-status is-${w.status}`}>{STATUS_WORDS[w.status] ?? w.status}</span>}
      </div>
      {!frame ? (
        <div class="artifact-status">{recording ? "Recording — no frames yet." : "No frames."}</div>
      ) : (
        <>
          <div class="walkthrough-stage">
            {w.frames.map((f, n) => (
              <div key={f.path} class={`walkthrough-cell${n === i ? "" : " is-hidden"}`} aria-hidden={n !== i || undefined}>
                <FileImg
                  class={`walkthrough-frame${f.failed ? " is-failed" : ""}`}
                  path={f.path}
                  token={props.token}
                  alt={f.caption}
                  {...(n !== i ? { loading: "lazy" as const } : {})}
                />
              </div>
            ))}
          </div>
          <div class="walkthrough-caption">
            <span class="walkthrough-count">{i + 1} / {count}</span>
            <span class="walkthrough-text">{frame.caption}</span>
            {frame.pageUrl && <span class="walkthrough-page" title={frame.pageUrl}>{frame.pageUrl}</span>}
          </div>
          {frame.failed && <div class="artifact-status tone-error">{frame.failed}</div>}
          {count > 1 && (
            <div class="walkthrough-controls">
              <button type="button" class="walkthrough-play" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause" : "Play"}>
                {playing ? <PauseIcon /> : <PlayIcon />}
              </button>
              <div class="walkthrough-bar">
                {/* A segment per step between two frames; the ones still ahead are faded. */}
                <div class="walkthrough-steps" aria-hidden="true">
                  {Array.from({ length: count - 1 }, (_, n) => <span key={n} class={`walkthrough-step${n >= i ? " is-ahead" : ""}`} />)}
                </div>
                <input
                  class="walkthrough-range"
                  type="range"
                  min={0}
                  max={count - 1}
                  value={i}
                  aria-label="Frame"
                  onInput={(e) => setAt(Number(e.currentTarget.value))}
                />
              </div>
            </div>
          )}
          {count > 1 && (
            <div class="walkthrough-strip">
              {w.frames.map((f, n) => (
                <button
                  key={f.path}
                  type="button"
                  class={`walkthrough-thumb${n === i ? " is-current" : ""}${f.failed ? " is-failed" : ""}`}
                  onClick={() => setAt(n)}
                  title={f.caption}
                >
                  <FileImg path={f.path} token={props.token} alt={f.caption} loading="lazy" />
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {w.failed.length > 0 && !w.frames.some((f) => f.failed) && (
        <div class="artifact-status tone-error">{w.failed.join(" · ")}</div>
      )}
    </div>
  );
}
