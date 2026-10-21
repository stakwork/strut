import { useEffect, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { artifactUrl, fetchArtifactText, fileScopeOf } from "../api";
import { artifactKind, artifactRel, directoryEntries, parseWalkthrough, resolveArtifactLink, viewerKind } from "@strut/kit/folds";
import { ArrowLeftIcon, CloseIcon } from "../icons";
import { useFileScope } from "../use-artifact-url";
import { Markdown, type MarkdownLink } from "./Markdown";

// ── Artifact viewer ────────────────────────────────────────────────────────
//
// A modal that shows one run artifact rendered by its kind (`artifact-view.ts`):
// markdown through the chat's renderer, images / video / audio as media,
// pdf + html in a frame (html sandboxed, scripts allowed — a step wrote it,
// and the one thing its URL holds is the run's file token), text in a pre,
// a DIRECTORY as one level of folders and files, a WALKTHROUGH (a
// `browser/walkthrough` recording's manifest) as frames to scrub through.
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

export function ArtifactViewer(props: { path: string; onClose: () => void }) {
  const [path, setPath] = useState(props.path);
  const [trail, setTrail] = useState<string[]>([]);
  useEffect(() => { setPath(props.path); setTrail([]); }, [props.path]);

  const scope = useFileScope(path);
  const files = scope?.files ?? null;
  const kind = viewerKind(path, files);
  const url = scope ? artifactUrl(path, scope.token) : undefined;
  const wantsText = kind === "markdown" || kind === "text" || kind === "walkthrough";
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
    fetchArtifactText(path).then(
      (t) => { if (!cancelled) setText(t); },
      (e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); },
    );
    return () => { cancelled = true; };
  }, [path, wantsText]);

  const go = (to: string) => { setTrail((t) => [...t, path]); setPath(to); };
  const back = () => {
    const prev = trail[trail.length - 1];
    if (prev === undefined) return;
    setTrail((t) => t.slice(0, -1));
    setPath(prev);
  };

  // Where a link in this file leads: a file of the scope opens in place when
  // something renders it, and is a link to the served file when nothing
  // does; anything outside the scope is left as written.
  const resolveLink = (href: string): MarkdownLink | null => {
    const to = resolveArtifactLink(path, href);
    if (!to) return null;
    return { url: artifactUrl(to, scope?.token ?? ""), open: viewerKind(to, files) ? () => go(to) : undefined };
  };

  const body = () => {
    if (error) return <div class="artifact-status tone-error">{error}</div>;
    if (!scope || (wantsText && text == null)) return <div class="artifact-status">Loading…</div>;
    switch (kind) {
      case "markdown": return <Markdown source={text ?? ""} resolveLink={resolveLink} />;
      case "text": return <pre class="artifact-text">{text}</pre>;
      case "image": return <img class="artifact-img" src={url} alt={path} />;
      case "video": return <video class="artifact-media" src={url} controls />;
      case "audio": return <audio class="artifact-audio" src={url} controls />;
      case "pdf": return <iframe class="artifact-frame" src={url} title={path} />;
      case "html": return <iframe class="artifact-frame" src={url} title={path} sandbox="allow-scripts" />;
      case "directory": return <Directory files={scope.files} path={path} token={scope.token} onOpen={go} />;
      case "walkthrough": return <WalkthroughView text={text ?? ""} path={path} token={scope.token} />;
      default: return <div class="artifact-status">No inline viewer for this file type.</div>;
    }
  };

  return createPortal(
    <div class="dialog-backdrop" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div class="dialog artifact-dialog" role="dialog" aria-label={path}>
        <div class="artifact-dialog-head">
          {trail.length > 0 && (
            <button class="copy-btn" onClick={back} aria-label="Back" title="Back"><ArrowLeftIcon /></button>
          )}
          <span class="artifact-dialog-path" title={path}>{path}</span>
          {url && kind !== "directory" && (
            <a class="artifact-dialog-open" href={url} target="_blank" rel="noopener">Open in new tab ↗</a>
          )}
          <button class="copy-btn" onClick={props.onClose} aria-label="Close" title="Close"><CloseIcon /></button>
        </div>
        <div class="artifact-dialog-body">{body()}</div>
      </div>
    </div>,
    document.body,
  );
}

/** One level of a directory: folders first, then files. A row the viewer
 *  can render opens in place; one it cannot is a link to the served file. */
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
              : <a class="artifact-dir-row" href={artifactUrl(p, props.token)} target="_blank" rel="noopener">{f} ↗</a>}
          </li>
        );
      })}
    </ul>
  );
}

/** A walkthrough: the frame large, its caption and where the page was, a
 *  slider and a filmstrip to scrub with (← → step through). A recording that
 *  stopped says why under the frame it stopped on. The manifest as text when
 *  it does not parse — a half-written one is still worth reading. */
function WalkthroughView(props: { text: string; path: string; token: string }) {
  const w = parseWalkthrough(props.text, props.path);
  const count = w?.frames.length ?? 0;
  const [at, setAt] = useState(0);
  useEffect(() => { setAt(0); }, [props.path]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") setAt((i) => Math.max(0, i - 1));
      if (e.key === "ArrowRight") setAt((i) => Math.min(count - 1, i + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count]);
  if (!w) return <pre class="artifact-text">{props.text}</pre>;
  if (!count) return <div class="artifact-status">{w.status === "recording" ? "Recording — no frames yet." : "No frames."}</div>;
  const i = Math.min(at, count - 1);
  const frame = w.frames[i]!;
  return (
    <div class="walkthrough">
      {(w.title || w.status) && (
        <div class="walkthrough-head">
          {w.title && <span class="walkthrough-title">{w.title}</span>}
          {w.status && <span class={`walkthrough-status is-${w.status}`}>{w.status}</span>}
        </div>
      )}
      <img class={`walkthrough-frame${frame.failed ? " is-failed" : ""}`} src={artifactUrl(frame.path, props.token)} alt={frame.caption} />
      <div class="walkthrough-caption">
        <span class="walkthrough-count">{i + 1} / {count}</span>
        <span class="walkthrough-text">{frame.caption}</span>
        {frame.pageUrl && <span class="walkthrough-page" title={frame.pageUrl}>{frame.pageUrl}</span>}
      </div>
      {frame.failed && <div class="artifact-status tone-error">{frame.failed}</div>}
      {i === count - 1 && !frame.failed && w.failed.length > 0 && (
        <div class="artifact-status tone-error">{w.failed.join(" · ")}</div>
      )}
      <input
        class="walkthrough-slider"
        type="range"
        min={0}
        max={count - 1}
        value={i}
        aria-label="Frame"
        onInput={(e) => setAt(Number((e.target as HTMLInputElement).value))}
      />
      <div class="walkthrough-strip">
        {w.frames.map((f, n) => (
          <button
            key={f.path}
            class={`walkthrough-thumb${n === i ? " is-current" : ""}${f.failed ? " is-failed" : ""}`}
            onClick={() => setAt(n)}
            title={f.caption}
          >
            <img src={artifactUrl(f.path, props.token)} alt={f.caption} loading="lazy" />
          </button>
        ))}
      </div>
    </div>
  );
}
