import { useMemo } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { parser } from "@lezer/javascript";
import { classHighlighter, highlightCode } from "@lezer/highlight";

// ── SourceCode ──────────────────────────────────────────────────────────────
//
// A step's TypeScript source, read-only and syntax-highlighted. Lezer's TS
// parser (the one CodeMirror uses) tags the tokens and classHighlighter names
// them `tok-*`, colored in components.css. Static spans in a <pre>, no editor.

const tsParser = parser.configure({ dialect: "ts" });

export function SourceCode(props: { code: string }) {
  const nodes = useMemo(() => {
    const out: ComponentChildren[] = [];
    highlightCode(
      props.code,
      tsParser.parse(props.code),
      classHighlighter,
      (text, classes) => out.push(classes ? <span class={classes}>{text}</span> : text),
      () => out.push("\n"),
    );
    return out;
  }, [props.code]);
  return <pre class="flyout-source-code">{nodes}</pre>;
}
