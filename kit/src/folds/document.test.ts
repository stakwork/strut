import "../test-dom.js";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { teardownDom } from "../test-dom.js";
import { findHighlightRanges, flattenText, highlightPieces, sanitizeHtml, type SafeNode } from "./document.js";

after(teardownDom);

describe("sanitizeHtml", () => {
  it("keeps a document's text and structure, with only the attributes named for each element", () => {
    const nodes = sanitizeHtml('<h1 class="x" style="color:red" onclick="alert(1)">Memo</h1><p>The <b>cap</b> is <a href="https://example.org/c" target="_blank" onmouseover="x()">$5M</a>.</p>');
    assert.deepEqual(nodes, [
      { t: "h1", c: ["Memo"] },
      { t: "p", c: ["The ", { t: "b", c: ["cap"] }, " is ", { t: "a", a: { href: "https://example.org/c" }, c: ["$5M"] }, "."] },
    ]);
  });

  it("drops what can run or call out, with everything inside it; unwraps an element it does not know", () => {
    // One input each: happy-dom's parser (the test's DOM, not a browser's)
    // stops at a script inside an svg, and loads an iframe's src.
    for (const html of [
      "<script>alert(1)</script><style>p{}</style><iframe></iframe>",
      "<svg><circle r='4'></circle></svg><math><mi>x</mi></math>",
      '<form><input value="a"><button>go</button></form><!-- note -->',
    ]) {
      assert.deepEqual(sanitizeHtml(html), [], html);
    }
    // However a parser reads the noscript, no element of it survives: at most stray text.
    assert.ok(sanitizeHtml('<noscript><p title="</noscript><img src=x onerror=alert(3)>">n</p></noscript>').every((n) => typeof n === "string"));
    assert.deepEqual(sanitizeHtml("<custom-el>kept <u>text</u></custom-el><center>too</center>"), ["kept ", { t: "u", c: ["text"] }, "too"]);
  });

  it("keeps an http(s) or mailto link, an inline image; a javascript: link is its text, an image that would load is nothing", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const nodes = sanitizeHtml(`<a href="javascript:alert(1)">x</a><a href=" mailto:a@b.c">m</a><img src="${png}" alt="chart" onerror="x()"><img src="https://tracker.example/p.gif"><img src="data:text/html;base64,PHNjcmlwdD4=">`);
    assert.deepEqual(nodes, ["x", { t: "a", a: { href: " mailto:a@b.c" }, c: ["m"] }, { t: "img", a: { src: png, alt: "chart" } }]);
  });

  it("keeps a table's spans as React props and leaves out the whitespace between its rows", () => {
    const nodes = sanitizeHtml("<table>\n <tbody>\n  <tr>\n   <td colspan=\"2\" bgcolor=\"red\">a</td>\n  </tr>\n </tbody>\n</table>");
    assert.deepEqual(nodes, [{ t: "table", c: [{ t: "tbody", c: [{ t: "tr", c: [{ t: "td", a: { colSpan: "2" }, c: ["a"] }] }] }] }]);
  });
});

describe("highlighting", () => {
  const nodes: SafeNode[] = [{ t: "p", c: ["The restructuring ", { t: "b", c: ["add"] }, "back exceeds the cap."] }];

  it("finds the terms in the drawn text, any case, overlaps merged, a regex's characters as plain text", () => {
    const text = flattenText(nodes);
    assert.equal(text, "The restructuring addback exceeds the cap.");
    assert.deepEqual(findHighlightRanges(text, ["ADDBACK", "back exceeds", "x", "(.*)+"]), [{ start: 18, end: 33 }]);
    assert.deepEqual(findHighlightRanges("a cap, a CAP", ["cap"]), [{ start: 2, end: 5 }, { start: 9, end: 12 }]);
  });

  it("cuts each text where a range falls, a range across two texts in both", () => {
    const ranges = findHighlightRanges(flattenText(nodes), ["addback"]);
    assert.deepEqual(highlightPieces("The restructuring ", ranges, 0), ["The restructuring "]);
    assert.deepEqual(highlightPieces("add", ranges, 18), [{ mark: "add" }]);
    assert.deepEqual(highlightPieces("back exceeds the cap.", ranges, 21), [{ mark: "back" }, " exceeds the cap."]);
  });
});
