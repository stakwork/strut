import { useCallback, useRef, useState } from "preact/hooks";
import { formatJson, humanize } from "../helpers";
import { CopyButton } from "./CopyButton";
import { ArtifactViewer } from "./ArtifactViewer";
import { artifactKind, artifactLabel, findArtifacts, isArtifactPath } from "../artifact-view";
import { EyeIcon } from "../icons";
import { useDismiss } from "../use-dismiss";
import { useArtifactUrl } from "../use-artifact-url";

// ── Copyable value rendering ────────────────────────────────────────────────
//
// Renders a value with per-field copy buttons. A plain object becomes one row
// per top-level field (so e.g. eval/optimize's `bestPrompt` copies on its own,
// as clean unescaped text); anything else is a single copyable block.
// `formatJson` returns strings RAW and pretty-prints everything else, and the
// copy button writes that same text — so copying never yields JSON escapes.
// A string field holding an artifact path (`/artifacts/<runId>/…`) renders
// as a link to the served file, opened in a new tab, plus — for a file type
// the viewer can render (`artifact-view.ts`) — an eye that opens it in a
// modal (`ArtifactViewer`); copy still yields the path. A block with paths
// INSIDE it (`{ report_md: … }`, an array of paths, `[{ link }]`) gets an eye
// in its head: one file opens at once, several open a pop-down to pick from.

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function CopyBlock(props: { value: unknown; label?: string; blockClass?: string }) {
  const text = formatJson(props.value);
  const artifact = isArtifactPath(props.value) ? props.value : null;
  const href = useArtifactUrl(artifact) ?? undefined; // plain text until the token is in
  const viewable = findArtifacts(props.value).filter((p) => artifactKind(p) != null);
  const [viewing, setViewing] = useState<string | null>(null);
  return (
    <div class="flyout-field">
      <div class="flyout-field-head">
        {props.label ? <span class="flyout-field-key">{humanize(props.label)}</span> : <span />}
        <span class="flyout-field-actions">
          {!artifact && viewable.length > 0 && <ViewEye paths={viewable} onPick={setViewing} />}
          <CopyButton value={text} label={props.label ? `Copy ${props.label}` : "Copy"} />
        </span>
      </div>
      <pre class={props.blockClass ?? "flyout-json"}>
        {artifact
          ? <>
              <a class="artifact-link" href={href} target="_blank" rel="noopener">{text}</a>
              {viewable.length > 0 && (
                <button class="artifact-view-btn" onClick={() => setViewing(artifact)} aria-label="View" title="View">
                  <EyeIcon />
                </button>
              )}
            </>
          : text}
      </pre>
      {viewing && <ArtifactViewer path={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

/** The eye for a block with artifact paths inside it: one path opens the
 *  viewer directly; several open a pop-down listing them by their path
 *  within the run (`artifactLabel`). */
function ViewEye(props: { paths: string[]; onPick: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(anchor, open, close);
  const one = props.paths.length === 1 ? props.paths[0] : null;
  const title = one ? `View ${artifactLabel(one)}` : `View one of ${props.paths.length} files`;
  return (
    <span class="popover-anchor" ref={anchor}>
      <button class="copy-btn" onClick={() => (one ? props.onPick(one) : setOpen((o) => !o))} aria-label={title} title={title}>
        <EyeIcon />
      </button>
      {open && (
        <div class="artifact-menu" role="menu">
          {props.paths.map((p) => (
            <button key={p} class="artifact-menu-item" role="menuitem" title={p} onClick={() => { close(); props.onPick(p); }}>
              {artifactLabel(p)}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

export function ValueFields(props: { value: unknown; blockClass?: string }) {
  if (isPlainObject(props.value)) {
    return (
      <div class="flyout-fields">
        {Object.entries(props.value).map(([k, v]) => (
          <CopyBlock key={k} label={k} value={v} blockClass={props.blockClass} />
        ))}
      </div>
    );
  }
  return <CopyBlock value={props.value} blockClass={props.blockClass} />;
}
