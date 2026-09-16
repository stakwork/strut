import { formatJson, humanize } from "../helpers";
import { CopyButton } from "./CopyButton";
import { artifactUrl, isArtifactPath } from "../api";

// ── Copyable value rendering ────────────────────────────────────────────────
//
// Renders a value with per-field copy buttons. A plain object becomes one row
// per top-level field (so e.g. eval/optimize's `bestPrompt` copies on its own,
// as clean unescaped text); anything else is a single copyable block.
// `formatJson` returns strings RAW and pretty-prints everything else, and the
// copy button writes that same text — so copying never yields JSON escapes.
// A string field holding an artifact path (`/artifacts/<runId>/…`) renders
// as a link to the served file, opened in a new tab; copy still yields the path.

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function CopyBlock(props: { value: unknown; label?: string; blockClass?: string }) {
  const text = formatJson(props.value);
  return (
    <div class="flyout-field">
      <div class="flyout-field-head">
        {props.label ? <span class="flyout-field-key">{humanize(props.label)}</span> : <span />}
        <CopyButton value={text} label={props.label ? `Copy ${props.label}` : "Copy"} />
      </div>
      <pre class={props.blockClass ?? "flyout-json"}>
        {isArtifactPath(props.value)
          ? <a class="artifact-link" href={artifactUrl(props.value)} target="_blank" rel="noopener">{text}</a>
          : text}
      </pre>
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
