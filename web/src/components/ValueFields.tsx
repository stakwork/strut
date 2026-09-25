import { useState } from "preact/hooks";
import { formatJson, humanize } from "../helpers";
import { CopyButton } from "./CopyButton";
import { ArtifactViewer } from "./ArtifactViewer";
import { artifactUrl, isArtifactPath } from "../api";
import { artifactKind } from "../artifact-view";
import { EyeIcon } from "../icons";

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
// modal (`ArtifactViewer`); copy still yields the path.

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function CopyBlock(props: { value: unknown; label?: string; blockClass?: string }) {
  const text = formatJson(props.value);
  const artifact = isArtifactPath(props.value) ? props.value : null;
  const viewable = artifact != null && artifactKind(artifact) != null;
  const [viewing, setViewing] = useState(false);
  return (
    <div class="flyout-field">
      <div class="flyout-field-head">
        {props.label ? <span class="flyout-field-key">{humanize(props.label)}</span> : <span />}
        <CopyButton value={text} label={props.label ? `Copy ${props.label}` : "Copy"} />
      </div>
      <pre class={props.blockClass ?? "flyout-json"}>
        {artifact
          ? <>
              <a class="artifact-link" href={artifactUrl(artifact)} target="_blank" rel="noopener">{text}</a>
              {viewable && (
                <button class="artifact-view-btn" onClick={() => setViewing(true)} aria-label="View" title="View">
                  <EyeIcon />
                </button>
              )}
            </>
          : text}
      </pre>
      {viewing && artifact && <ArtifactViewer path={artifact} onClose={() => setViewing(false)} />}
    </div>
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
