import { useEffect, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { artifactUrl, fetchArtifactText } from "../api";
import { artifactKind } from "../artifact-view";
import { CloseIcon } from "../icons";
import { Markdown } from "./Markdown";

// ── Artifact viewer ────────────────────────────────────────────────────────
//
// A modal that shows one run artifact rendered by its kind (`artifact-view.ts`):
// markdown through the chat's renderer, images / video / audio as media,
// pdf + html in a frame (html sandboxed — a step wrote it), text in a pre.
// Opened from the eye beside an artifact link (`ValueFields`). Portaled onto
// <body>: the events panel and the flyout are their own stacking contexts, so
// a backdrop rendered inside one would sit under the other.

export function ArtifactViewer(props: { path: string; onClose: () => void }) {
  const kind = artifactKind(props.path);
  const url = artifactUrl(props.path);
  const wantsText = kind === "markdown" || kind === "text";
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") props.onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  useEffect(() => {
    if (!wantsText) return;
    let cancelled = false;
    setText(null);
    setError("");
    fetchArtifactText(props.path).then(
      (t) => { if (!cancelled) setText(t); },
      (e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); },
    );
    return () => { cancelled = true; };
  }, [props.path, wantsText]);

  const body = () => {
    if (error) return <div class="artifact-status tone-error">{error}</div>;
    if (wantsText && text == null) return <div class="artifact-status">Loading…</div>;
    switch (kind) {
      case "markdown": return <Markdown source={text ?? ""} />;
      case "text": return <pre class="artifact-text">{text}</pre>;
      case "image": return <img class="artifact-img" src={url} alt={props.path} />;
      case "video": return <video class="artifact-media" src={url} controls />;
      case "audio": return <audio class="artifact-audio" src={url} controls />;
      case "pdf": return <iframe class="artifact-frame" src={url} title={props.path} />;
      case "html": return <iframe class="artifact-frame" src={url} title={props.path} sandbox="" />;
      default: return <div class="artifact-status">No inline viewer for this file type.</div>;
    }
  };

  return createPortal(
    <div class="dialog-backdrop" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div class="dialog artifact-dialog" role="dialog" aria-label={props.path}>
        <div class="artifact-dialog-head">
          <span class="artifact-dialog-path" title={props.path}>{props.path}</span>
          <a class="artifact-dialog-open" href={url} target="_blank" rel="noopener">Open in new tab ↗</a>
          <button class="copy-btn" onClick={props.onClose} aria-label="Close" title="Close"><CloseIcon /></button>
        </div>
        <div class="artifact-dialog-body">{body()}</div>
      </div>
    </div>,
    document.body,
  );
}
