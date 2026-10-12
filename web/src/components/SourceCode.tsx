import { useMemo } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { parser } from "@lezer/javascript";
import { yamlLanguage } from "@codemirror/lang-yaml";
import { classHighlighter, highlightCode } from "@lezer/highlight";

// ── SourceCode ──────────────────────────────────────────────────────────────
//
// Read-only, syntax-highlighted source: a step's TypeScript, or a workflow
// version's YAML. Lezer's parsers (the ones CodeMirror uses) tag the tokens
// and classHighlighter names them `tok-*`, colored in components.css. Static
// spans in a <pre>, no editor.

const PARSERS = {
  ts: parser.configure({ dialect: "ts" }),
  yaml: yamlLanguage.parser,
};

export function SourceCode(props: { code: string; language?: keyof typeof PARSERS }) {
  const language = props.language ?? "ts";
  const nodes = useMemo(() => {
    const out: ComponentChildren[] = [];
    highlightCode(
      props.code,
      PARSERS[language].parse(props.code),
      classHighlighter,
      (text, classes) => out.push(classes ? <span class={classes}>{text}</span> : text),
      () => out.push("\n"),
    );
    return out;
  }, [props.code, language]);
  return <pre class="flyout-source-code">{nodes}</pre>;
}
