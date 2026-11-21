// The SVG Mermaid drew, made an image a view draws (diagram.ts): the
// settings for the page's theme, the image, the error in a line. The DOM is
// happy-dom's; Mermaid itself is checked in a browser (it measures text).
import "../test-dom.js";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { teardownDom } from "../test-dom.js";
import { diagramImage, errorLine, mermaidConfig } from "./diagram.js";

after(teardownDom);

/** Mermaid's output, in its shape: sized to its container by a max-width. */
const MERMAID_SVG =
  '<svg id="mermaid-r1" width="100%" xmlns="http://www.w3.org/2000/svg" class="flowchart" style="max-width: 615.5px;" viewBox="-8 -8 615.5 182" role="graphics-document document" aria-roledescription="flowchart-v2">' +
  '<style>#mermaid-r1{font-size:16px;}</style><g><text>API</text><text>Neo4j</text></g></svg>';

describe("folds/diagram — a ```mermaid block as an image", () => {
  it("Mermaid's look follows the page: neutral on light, dark on dark; labels as SVG text, nothing it runs, no error picture", () => {
    assert.equal(mermaidConfig("light").theme, "neutral");
    assert.equal(mermaidConfig("dark").theme, "dark");
    const c = mermaidConfig("light");
    assert.deepEqual([c.startOnLoad, c.securityLevel, c.htmlLabels, c.flowchart.htmlLabels, c.suppressErrorRendering], [false, "strict", false, false, true]);
  });

  it("the SVG as an image: sized by its viewBox, its max-width gone, the rest as Mermaid drew it, as XML", () => {
    const img = diagramImage(MERMAID_SVG)!;
    assert.deepEqual([img.width, img.height], [616, 182]);
    assert.ok(img.src.startsWith("data:image/svg+xml;charset=utf-8,"));
    const xml = decodeURIComponent(img.src.slice(img.src.indexOf(",") + 1));
    assert.match(xml, /^<svg [^>]*width="615\.5"/);
    assert.match(xml, /^<svg [^>]*height="182"/);
    assert.doesNotMatch(xml, /max-width/);
    assert.match(xml, /aria-roledescription="flowchart-v2"/);
    assert.match(xml, /<style>#mermaid-r1\{font-size:16px;\}<\/style><g><text>API<\/text><text>Neo4j<\/text><\/g>/);
    const parsed = new DOMParser().parseFromString(xml, "image/svg+xml");
    assert.equal(parsed.getElementsByTagName("parsererror").length, 0, "well-formed");
  });

  it("markup that is not XML (an HTML <br> in a label) is read as HTML and still made an image", () => {
    const img = diagramImage(MERMAID_SVG.replace("<text>API</text>", '<foreignObject width="9" height="9"><div xmlns="http://www.w3.org/1999/xhtml">a<br>b</div></foreignObject>'));
    assert.ok(img, "an image");
    const xml = decodeURIComponent(img.src.slice(img.src.indexOf(",") + 1));
    assert.equal(new DOMParser().parseFromString(xml, "image/svg+xml").getElementsByTagName("parsererror").length, 0, "well-formed");
  });

  it("no SVG, or one with no size, is no image", () => {
    assert.equal(diagramImage("<p>not a diagram</p>"), null);
    assert.equal(diagramImage('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), null);
    assert.equal(diagramImage('<svg viewBox="0 0 0 10"></svg>'), null);
  });

  it("what went wrong in a line: the first of Mermaid's message; for a parse error, where it stopped (its line number counts Mermaid's own lines)", () => {
    assert.equal(
      errorLine("Parse error on line 4:\n... a -->|missing end\n---------------------^\nExpecting 'SQE', 'PIPE', got '1'"),
      "Parse error at a -->|missing end",
    );
    assert.equal(errorLine("Parse error on line 2:"), "Parse error on line 2:", "nothing quoted, the line as it is");
    assert.equal(errorLine("\n  No diagram type detected matching given configuration for text: hello\n"), "No diagram type detected matching given configuration for text: hello");
    assert.equal(errorLine(""), "Mermaid could not read it.");
    const long = errorLine("x".repeat(500));
    assert.equal(long.length, 160);
    assert.ok(long.endsWith("…"));
  });
});
