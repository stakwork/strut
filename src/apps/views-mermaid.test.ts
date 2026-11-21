// strut/views' MermaidDiagram: which block of markdown DocumentView draws
// as a diagram (lib/fence.ts). The image it makes of Mermaid's SVG is the
// kit's (kit/src/folds/diagram.test.ts); which documents carry Mermaid,
// views.test.ts and knowledge.test.ts; Mermaid itself is checked in a browser.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fencedSource, type HastNode } from "./views/src/lib/fence.js";

const pre = (lang: string | null, text: string): HastNode => ({
  type: "element",
  tagName: "pre",
  children: [{ type: "element", tagName: "code", properties: lang ? { className: [`language-${lang}`] } : {}, children: [{ type: "text", value: text }] }],
});

describe("strut/views — MermaidDiagram", () => {
  it("a <pre> is a diagram only when its code is a ```mermaid block; its text whole", () => {
    assert.equal(fencedSource(pre("mermaid", "flowchart LR\n  a --> b\n"), "mermaid"), "flowchart LR\n  a --> b\n");
    assert.equal(fencedSource(pre("ts", "const a = 1;"), "mermaid"), null);
    assert.equal(fencedSource(pre(null, "flowchart LR"), "mermaid"), null, "an unmarked block is code");
    assert.equal(fencedSource(undefined, "mermaid"), null);
    assert.equal(fencedSource({ type: "element", tagName: "pre", children: [{ type: "text", value: "x" }] }, "mermaid"), null);
  });
});
