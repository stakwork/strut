import "../../../../kit/src/test-dom.js";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { teardownDom } from "../../../../kit/src/test-dom.js";
import { flattenText, sanitizeHtml, type SafeElement, type SafeNode } from "../../../../kit/src/folds/document.js";
import { fileArtifactsCapability } from "../../../capabilities.js";
import { jobRoot } from "../../../jobs.js";
import { buildRegistry } from "../../registry.js";
import { lintStepSource } from "../../../step-lint.js";
import toHtml from "./to-html.js";
import redline from "./redline.js";
import { readZip, writeZip } from "./_zip.js";
import { parseXml, serializeXml } from "./_xml.js";
import { docxToHtml } from "./_html.js";
import { normalize, wordChanges } from "./_redline.js";

after(teardownDom);

// ── fixtures: a .docx built from its parts ──────────────────────────────────

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

interface Parts {
  styles?: string;
  numbering?: string;
  comments?: string;
  footnotes?: string;
  links?: Record<string, string>;
  title?: string;
}

/** A .docx whose body is `body` (the XML inside w:body). */
function docx(body: string, parts: Parts = {}): Buffer {
  const rels: string[] = [];
  const types: string[] = [];
  const files: [string, string][] = [];
  const part = (name: string, type: string, rel: string, xml: string) => {
    files.push([`word/${name}`, DECL + xml]);
    types.push(`<Override PartName="/word/${name}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${type}+xml"/>`);
    rels.push(`<Relationship Id="rId${rels.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${rel}" Target="${name}"/>`);
  };
  if (parts.styles) part("styles.xml", "styles", "styles", `<w:styles ${NS}>${parts.styles}</w:styles>`);
  if (parts.numbering) part("numbering.xml", "numbering", "numbering", `<w:numbering ${NS}>${parts.numbering}</w:numbering>`);
  if (parts.comments) part("comments.xml", "comments", "comments", `<w:comments ${NS}>${parts.comments}</w:comments>`);
  if (parts.footnotes) part("footnotes.xml", "footnotes", "footnotes", `<w:footnotes ${NS}>${parts.footnotes}</w:footnotes>`);
  for (const [id, url] of Object.entries(parts.links ?? {})) {
    rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${url}" TargetMode="External"/>`);
  }
  const rootRels = ['<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'];
  const entries: [string, string][] = [
    [
      "[Content_Types].xml",
      `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${types.join("")}${parts.title ? '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' : ""}</Types>`,
    ],
  ];
  if (parts.title) {
    rootRels.push('<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>');
    files.push(["docProps/core.xml", `${DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${parts.title}</dc:title></cp:coreProperties>`]);
  }
  entries.push(["_rels/.rels", `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rootRels.join("")}</Relationships>`]);
  entries.push(["word/document.xml", `${DECL}<w:document ${NS}><w:body>${body}<w:sectPr/></w:body></w:document>`]);
  entries.push(["word/_rels/document.xml.rels", `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`]);
  entries.push(...files);
  return writeZip(entries.map(([name, xml]) => ({ name, data: Buffer.from(xml, "utf8") })));
}

const r = (text: string, rPr = "") => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const p = (...runs: string[]) => `<w:p>${runs.join("")}</w:p>`;
const styled = (style: string, ...runs: string[]) => `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${runs.join("")}</w:p>`;

const STYLES = `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Berschrift2"><w:name w:val="heading 2"/></w:style><w:style w:type="paragraph" w:styleId="Clause"><w:name w:val="Clause"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style>`;

// ── a step's run context: a job run, or a plain run ─────────────────────────

function ctxFor(opts: { job?: string } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "strut-docx-"));
  const ctx = {
    runId: "run1",
    path: "wf/step",
    scope: {},
    input: {},
    emit: async () => {},
    ...(opts.job ? { job: opts.job } : {}),
    services: { dataDir, artifacts: fileArtifactsCapability(join(dataDir, "artifacts")) },
  } as never;
  const root = opts.job ? jobRoot(dataDir, opts.job) : join(dataDir, "artifacts", "run1");
  return { ctx, dataDir, root };
}

async function put(root: string, rel: string, bytes: Buffer) {
  await mkdir(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), bytes);
}

/** The document.xml of a .docx file. */
const documentXml = (bytes: Buffer) => readZip(bytes).find((e) => e.name === "word/document.xml")!.data.toString("utf8");
const part = (bytes: Buffer, name: string) => readZip(bytes).find((e) => e.name === name)?.data.toString("utf8");

/** The elements of a safe tree named `t`, depth first. */
function elementsOf(nodes: SafeNode[], t: string): SafeElement[] {
  const out: SafeElement[] = [];
  const visit = (list: SafeNode[]) => {
    for (const n of list) {
      if (typeof n === "string") continue;
      if (n.t === t) out.push(n);
      if (n.c) visit(n.c);
    }
  };
  visit(nodes);
  return out;
}

// ── the containers ──────────────────────────────────────────────────────────

describe("docx zip and xml", () => {
  it("round-trips a zip, deflated, and refuses what is not one", () => {
    const entries = [
      { name: "a.txt", data: Buffer.from("hello ".repeat(100)) },
      { name: "dir/b.bin", data: Buffer.from([0, 1, 2, 255]) },
      { name: "empty", data: Buffer.alloc(0) },
    ];
    const zip = writeZip(entries);
    assert.ok(zip.length < 400, "deflated");
    assert.deepEqual(readZip(zip), entries);
    assert.throws(() => readZip(Buffer.from("not a zip at all, just some text bytes")), /not a zip/);
    assert.throws(() => readZip(zip, 100), /expands past/);
  });

  it("serializes XML back as it was written: entities, attributes, declarations", () => {
    const xml = `${DECL}<w:document ${NS}><!-- c --><w:body><w:p w:rsidR='00A1'><w:r><w:t xml:space="preserve">a &amp; b &lt;c&gt; &#x2019;</w:t></w:r><w:r><w:tab/></w:r></w:p></w:body></w:document>`;
    assert.equal(serializeXml(parseXml(xml)), xml);
  });
});

// ── docx/to-html ────────────────────────────────────────────────────────────

describe("docx/to-html", () => {
  it("keeps headings, paragraphs, inline marks and links, every text escaped", () => {
    const bytes = docx(
      styled("Heading1", r("Master Services Agreement")) +
        styled("Berschrift2", r("Definitions")) +
        styled("Clause", r("Fees")) +
        p(r("The "), r("Supplier", "<w:b/>"), r(" shall "), r("not", '<w:i/><w:u w:val="single"/>'), r(" &lt;script&gt;alert(1)&lt;/script&gt; &amp;amp; "), r("bold off", '<w:b w:val="0"/>')) +
        `<w:p><w:hyperlink r:id="rIdL">${r("our site")}</w:hyperlink>${r(" and ")}<w:hyperlink r:id="rIdJ">${r("this")}</w:hyperlink></w:p>` +
        p(r("x", '<w:vertAlign w:val="superscript"/>'), r("2"), `<w:r><w:tab/><w:t>tabbed</w:t><w:br/><w:t>next line</w:t></w:r>`) +
        p(),
      { styles: STYLES, links: { rIdL: "https://example.org/terms", rIdJ: "javascript:alert(1)" } },
    );
    const out = docxToHtml(bytes);
    assert.equal(out.title, "Master Services Agreement");
    assert.match(out.html, /^<h1>Master Services Agreement<\/h1>\n<h2>Definitions<\/h2>\n<h3>Fees<\/h3>/);
    assert.match(out.html, /<p>The <strong>Supplier<\/strong> shall <u><em>not<\/em><\/u> &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp;amp; bold off<\/p>/);
    assert.match(out.html, /<a href="https:\/\/example.org\/terms">our site<\/a> and this<\/p>/);
    assert.match(out.html, /<sup>x<\/sup>2 tabbed<br>next line/);
    assert.equal(out.text, "Master Services Agreement\nDefinitions\nFees\nThe Supplier shall not <script>alert(1)</script> &amp; bold off\nour site and this\nx2\ttabbed\nnext line");
    assert.deepEqual(out.changes, []);
    assert.deepEqual(out.notes, []);
  });

  it("writes tracked changes as <ins>/<del> with author and date, and reads the text with them accepted", () => {
    const bytes = docx(
      p(
        r("Payment is due within "),
        `<w:del w:id="1" w:author="Opposing Counsel" w:date="2026-10-30T09:15:00Z"><w:r><w:delText>thirty (30)</w:delText></w:r></w:del>`,
        `<w:ins w:id="2" w:author="Opposing Counsel" w:date="2026-10-30T09:15:00Z"><w:r><w:t>ninety (90)</w:t></w:r></w:ins>`,
        r(" days."),
      ) + p(`<w:moveFrom w:id="3" w:author="A"><w:r><w:delText>moved</w:delText></w:r></w:moveFrom>`, r(" text"), `<w:moveTo w:id="4" w:author="A"><w:r><w:t> moved</w:t></w:r></w:moveTo>`),
    );
    const out = docxToHtml(bytes);
    assert.match(out.html, /within <del datetime="2026-10-30T09:15:00Z" title="Deleted by Opposing Counsel, 2026-10-30" data-author="Opposing Counsel">thirty \(30\)<\/del><ins datetime="2026-10-30T09:15:00Z" title="Inserted by Opposing Counsel, 2026-10-30" data-author="Opposing Counsel">ninety \(90\)<\/ins> days\./);
    assert.equal(out.text, "Payment is due within ninety (90) days.\n text moved");
    assert.deepEqual(out.changes, [
      { kind: "delete", text: "thirty (30)", author: "Opposing Counsel", date: "2026-10-30T09:15:00Z" },
      { kind: "insert", text: "ninety (90)", author: "Opposing Counsel", date: "2026-10-30T09:15:00Z" },
      { kind: "delete", text: "moved", author: "A", move: true },
      { kind: "insert", text: " moved", author: "A", move: true },
    ]);
  });

  it("lists comments and footnotes as numbered notes, a comment with the text it is on", () => {
    const bytes = docx(
      p(
        r("The cap is "),
        '<w:commentRangeStart w:id="7"/>',
        r("one million dollars"),
        '<w:commentRangeEnd w:id="7"/>',
        '<w:r><w:commentReference w:id="7"/></w:r>',
        r(" in aggregate."),
        '<w:r><w:footnoteReference w:id="2"/></w:r>',
      ),
      {
        comments: '<w:comment w:id="7" w:author="Jane Partner" w:date="2026-10-31T00:00:00Z" w:initials="JP"><w:p><w:r><w:annotationRef/></w:r><w:r><w:t>Too low for this deal.</w:t></w:r></w:p></w:comment>',
        footnotes: '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="2"><w:p><w:r><w:t>Excluding indemnity.</w:t></w:r></w:p></w:footnote>',
      },
    );
    const out = docxToHtml(bytes);
    assert.match(out.html, /one million dollars<sup>\[1\]<\/sup> in aggregate\.<sup>\[2\]<\/sup><\/p>/);
    assert.match(out.html, /<section><h2>Notes<\/h2><ol><li><strong>Jane Partner<\/strong> \(2026-10-31\): Too low for this deal\. — on “one million dollars”<\/li><li>Excluding indemnity\. — after “The cap is one million dollars in aggregate\.”<\/li><\/ol><\/section>$/);
    assert.deepEqual(out.notes, [
      { n: 1, kind: "comment", text: "Too low for this deal.", author: "Jane Partner", date: "2026-10-31T00:00:00Z", anchor: "one million dollars" },
      { n: 2, kind: "footnote", text: "Excluding indemnity.", anchor: "The cap is one million dollars in aggregate." },
    ]);
    assert.match(out.text, /^The cap is one million dollars in aggregate\.\n\nNotes\n\[1\] Jane Partner \(2026-10-31\): Too low for this deal\. — on “one million dollars”\n\[2\] Footnote: Excluding indemnity\./);
  });

  it("keeps tables with their merged cells and header rows", () => {
    const tc = (text: string, tcPr = "") => `<w:tc>${tcPr ? `<w:tcPr>${tcPr}</w:tcPr>` : ""}${p(r(text))}</w:tc>`;
    const bytes = docx(
      `<w:tbl><w:tr><w:trPr><w:tblHeader/></w:trPr>${tc("Party")}${tc("Obligation", '<w:gridSpan w:val="2"/>')}</w:tr>` +
        `<w:tr>${tc("Seller", '<w:vMerge w:val="restart"/>')}${tc("Deliver")}${tc("Day 1")}</w:tr>` +
        `<w:tr>${tc("", "<w:vMerge/>")}${tc("Invoice")}${tc("Day 30")}</w:tr></w:tbl>`,
    );
    const out = docxToHtml(bytes);
    assert.equal(
      out.html,
      '<table><tbody><tr><th><p>Party</p></th><th colspan="2"><p>Obligation</p></th></tr><tr><td rowspan="2"><p>Seller</p></td><td><p>Deliver</p></td><td><p>Day 1</p></td></tr><tr><td><p>Invoice</p></td><td><p>Day 30</p></td></tr></tbody></table>',
    );
    assert.equal(out.text, "Party | Obligation\nSeller | Deliver | Day 1\nInvoice | Day 30");
  });

  it("numbers a list as Word does, and groups bullets into nested lists", () => {
    const lvl = (ilvl: number, fmt: string, text: string) => `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/></w:lvl>`;
    const numbering =
      `<w:abstractNum w:abstractNumId="0">${lvl(0, "decimal", "%1.")}${lvl(1, "decimal", "%1.%2")}${lvl(2, "lowerLetter", "(%3)")}</w:abstractNum>` +
      `<w:abstractNum w:abstractNumId="1">${lvl(0, "bullet", "")}${lvl(1, "bullet", "o")}</w:abstractNum>` +
      '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
      '<w:num w:numId="3"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride></w:num>';
    const item = (numId: number, ilvl: number, text: string) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${r(text)}</w:p>`;
    const bytes = docx(
      item(1, 0, "Definitions") + item(1, 1, "Agreement") + item(1, 2, "includes schedules") + item(1, 2, "and exhibits") + item(1, 1, "Party") + item(1, 0, "Term") +
        item(2, 0, "first") + item(2, 1, "nested") + item(2, 0, "second") + p(r("after")) + item(3, 0, "restarted"),
      { numbering },
    );
    const out = docxToHtml(bytes);
    assert.equal(
      out.html,
      "<p>1. Definitions</p>\n<p>1.1 Agreement</p>\n<p>(a) includes schedules</p>\n<p>(b) and exhibits</p>\n<p>1.2 Party</p>\n<p>2. Term</p>\n" +
        "<ul><li>first<ul><li>nested</li></ul></li><li>second</li></ul>\n<p>after</p>\n<p>5. restarted</p>",
    );
    assert.equal(out.text, "1.\tDefinitions\n1.1\tAgreement\n(a)\tincludes schedules\n(b)\tand exhibits\n1.2\tParty\n2.\tTerm\n• first\n  • nested\n• second\nafter\n5.\trestarted");
  });

  it("draws in DocumentView: the sanitizer keeps every element, a change's author and date with it", () => {
    const bytes = docx(
      styled("Heading1", r("Memo")) +
        p(r("Keep "), `<w:del w:id="1" w:author="Strut" w:date="2026-11-02T00:00:00Z"><w:r><w:delText>old</w:delText></w:r></w:del>`, `<w:ins w:id="2" w:author="Strut" w:date="2026-11-02T00:00:00Z"><w:r><w:t>new</w:t></w:r></w:ins>`, '<w:r><w:commentReference w:id="0"/></w:r>') +
        `<w:tbl><w:tr><w:tc>${p(r("cell"))}</w:tc></w:tr></w:tbl>`,
      { styles: STYLES, comments: '<w:comment w:id="0" w:author="Strut"><w:p><w:r><w:t>why</w:t></w:r></w:p></w:comment>' },
    );
    const out = docxToHtml(bytes);
    const safe = sanitizeHtml(out.html);
    for (const t of ["h1", "p", "del", "ins", "sup", "table", "td", "section", "h2", "ol", "li", "strong"]) assert.ok(elementsOf(safe, t).length, `kept <${t}>`);
    assert.deepEqual(elementsOf(safe, "del")[0]!.a, { dateTime: "2026-11-02T00:00:00Z", title: "Deleted by Strut, 2026-11-02" });
    assert.equal(flattenText(safe).replace(/\s+/g, " ").trim(), "Memo Keep oldnew[1] cell NotesStrut: why");
  });

  it("reads a run's file and a job's, by path or served link, and writes the page into this run's files", async () => {
    const plain = ctxFor();
    await put(plain.root, "in/a.docx", docx(p(r("Plain run file."))));
    const a = await toHtml.run(toHtml.input.parse({ path: "in/a.docx", out: "a.html" }), plain.ctx);
    assert.equal(a.text, "Plain run file.");
    assert.deepEqual(a.source, { path: "in/a.docx", url: "/artifacts/run1/in/a.docx" });
    assert.deepEqual(a.out, { path: "a.html", url: "/artifacts/run1/a.html" });
    const page = readFileSync(join(plain.root, "a.html"), "utf8");
    assert.match(page, /^<!doctype html>/);
    assert.match(page, /<p>Plain run file\.<\/p>/);

    const job = ctxFor({ job: "matter-7" });
    await put(job.root, "uploads/b.docx", docx(p(r("Job file."))));
    const b = await toHtml.run(toHtml.input.parse({ path: "/jobs/matter-7/files/uploads/b.docx?t=abc" }), job.ctx);
    assert.equal(b.text, "Job file.");
    assert.equal(b.source.url, "/jobs/matter-7/files/uploads/b.docx");
    const abs = await toHtml.run(toHtml.input.parse({ path: join(job.root, "uploads/b.docx") }), job.ctx);
    assert.equal(abs.source.path, "uploads/b.docx");

    await assert.rejects(toHtml.run(toHtml.input.parse({ path: "../../secrets.json" }), job.ctx), /escapes the job directory/);
    await assert.rejects(toHtml.run(toHtml.input.parse({ path: "/etc/passwd" }), job.ctx), /outside this run's files/);
    await assert.rejects(toHtml.run(toHtml.input.parse({ path: "missing.docx" }), job.ctx), /no file missing\.docx in job matter-7/);
    await put(job.root, "notes.txt", Buffer.from("plain text"));
    await assert.rejects(toHtml.run(toHtml.input.parse({ path: "notes.txt" }), job.ctx), /not a \.docx/);
    await assert.rejects(toHtml.run(toHtml.input.parse({ path: "uploads/b.docx", out: "/artifacts/other/x.html" }), job.ctx), /not this run's file/);
  });
});

// ── docx/redline ────────────────────────────────────────────────────────────

const CONTRACT = docx(
  styled("Heading1", r("Master Services Agreement")) +
    // "thirty (30) days" split across runs with different formatting.
    p(r("4.1 Customer shall pay each invoice within "), r("thir", "<w:b/>"), r("ty (30) da"), r("ys of receipt.")) +
    p(r("The Supplier shall deliver the Services. The Supplier warrants the Services.")) +
    p(r("12.3 Supplier"), r(" shall indemnify Customer.")) +
    p(r("Notices go to the Supplier at its address.")) +
    `<w:p><w:hyperlink r:id="rIdL">${r("Schedule A")}</w:hyperlink>${r(" sets the Supplier’s fees.")}</w:p>` +
    p(r("Existing "), `<w:ins w:id="40" w:author="Opposing Counsel" w:date="2026-10-30T00:00:00Z"><w:r><w:t>negotiated</w:t></w:r></w:ins>`, r(" language.")),
  { styles: STYLES, links: { rIdL: "https://example.org/schedule-a" } },
);

async function redlined(edits: unknown[], extra: Record<string, unknown> = {}) {
  const { ctx, root } = ctxFor({ job: "matter-1" });
  await put(root, "uploads/msa.docx", CONTRACT);
  const out = await redline.run(redline.input.parse({ path: "uploads/msa.docx", edits, date: "2026-11-02T12:00:00Z", ...extra }), ctx);
  const bytes = readFileSync(join(root, out.path));
  return { out, bytes, root, ctx, html: docxToHtml(bytes) };
}

describe("docx/redline", () => {
  it("marks only the words that change, across runs, keeping each run's formatting, with the reason as a comment", async () => {
    const { out, bytes, html, root } = await redlined([
      { find: "within thirty (30) days", replace: "within sixty (60) days", reason: "Our standard payment term is net 60.", sources: ["Playbook § 4.2", { title: "Payment Terms", ref_id: "c-17", url: "https://kb.example/payment" }] },
    ]);
    assert.deepEqual(out.edits, [{ index: 0, find: "within thirty (30) days", status: "applied", count: 1, matched: "exact", comment: true }]);
    assert.equal(out.applied, 1);
    assert.deepEqual(out.unplaced, []);
    assert.equal(out.path, "uploads/msa.redline.docx");
    assert.equal(out.url, "/jobs/matter-1/files/uploads/msa.redline.docx");
    assert.deepEqual(readFileSync(join(root, "uploads/msa.docx")), CONTRACT, "the original is untouched");

    const xml = documentXml(bytes);
    // The deleted words keep their runs' formatting; the insertion takes the first one's.
    assert.match(xml, /<w:del w:id="\d+" w:author="Strut" w:date="2026-11-02T12:00:00Z"><w:r><w:rPr><w:b\/><\/w:rPr><w:delText xml:space="preserve">thir<\/w:delText><\/w:r><\/w:del>/);
    assert.match(xml, /<w:delText xml:space="preserve">ty \(30\)<\/w:delText><\/w:r><\/w:del><w:ins w:id="\d+" w:author="Strut" w:date="2026-11-02T12:00:00Z"><w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">sixty \(60\)<\/w:t><\/w:r><\/w:ins>/);
    const ids = [...xml.matchAll(/<w:(?:ins|del) w:id="(\d+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, "every change has its own id");

    // The comment part, related and typed.
    assert.match(part(bytes, "word/comments.xml")!, /<w:comment w:id="(\d+)" w:author="Strut" w:date="2026-11-02T12:00:00Z" w:initials="S"><w:p><w:r><w:annotationRef\/><\/w:r><w:r><w:t xml:space="preserve">Our standard payment term is net 60\.<\/w:t><\/w:r><\/w:p>/);
    assert.match(part(bytes, "word/_rels/document.xml.rels")!, /Type="http:\/\/schemas.openxmlformats.org\/officeDocument\/2006\/relationships\/comments" Target="comments.xml"/);
    assert.match(part(bytes, "[Content_Types].xml")!, /<Override PartName="\/word\/comments.xml" ContentType="application\/vnd.openxmlformats-officedocument.wordprocessingml.comments\+xml"\/>/);

    // Round trip: docx/to-html reads the redline back.
    assert.match(html.html, /within <del[^>]*data-author="Strut"><strong>thir<\/strong><\/del><del[^>]*>ty \(30\)<\/del><ins datetime="2026-11-02T12:00:00Z" title="Inserted by Strut, 2026-11-02" data-author="Strut"><strong>sixty \(60\)<\/strong><\/ins> days<sup>\[1\]<\/sup> of receipt\./);
    assert.match(html.text, /^Master Services Agreement\n4\.1 Customer shall pay each invoice within sixty \(60\) days of receipt\./);
    assert.deepEqual(html.notes[0], {
      n: 1,
      kind: "comment",
      text: "Our standard payment term is net 60.\nSources:\n– Playbook § 4.2\n– Payment Terms — https://kb.example/payment — ref c-17",
      author: "Strut",
      date: "2026-11-02T12:00:00Z",
      anchor: "within sixty (60) days",
    });
    assert.deepEqual(
      html.changes.filter((c) => c.author === "Strut").map((c) => [c.kind, c.text]),
      [["delete", "thir"], ["delete", "ty (30)"], ["insert", "sixty (60)"]],
    );
  });

  it("reports what it cannot place, and writes nothing of it", async () => {
    const { out, html } = await redlined([
      { find: "Supplier", replace: "Vendor" },
      { find: "force majeure", replace: "acts of God" },
      { find: "the supplier shall  deliver", replace: "x" },
      { find: "negotiated language", replace: "agreed language" },
      { find: "Supplier", paragraph: "nowhere", replace: "x" },
      { find: "within thirty (30) days\nof receipt", replace: "x" },
      { find: "Notices go", replace: "Notices go" },
    ]);
    assert.equal(out.applied, 0);
    const [ambiguous, missing, near, tracked, hint, split, same] = out.unplaced;
    assert.match(ambiguous!.reason!, /^ambiguous: 5 matches/);
    assert.equal(ambiguous!.candidates!.length, 5);
    assert.match(ambiguous!.candidates![0]!, /The Supplier shall deliver/);
    assert.equal(missing!.reason, "not found");
    assert.match(near!.reason!, /differs in case or spacing/);
    assert.match(near!.candidates![0]!, /The Supplier shall deliver the Services/);
    assert.match(tracked!.reason!, /inside a tracked change already in the document/);
    assert.match(hint!.reason!, /no paragraph contains the hint "nowhere"/);
    assert.match(split!.reason!, /spans more than one paragraph/);
    assert.match(same!.reason!, /nothing to do/);
    assert.ok(!html.changes.some((c) => c.author === "Strut"));
  });

  it("picks a match by its paragraph, changes every one with all: true, matches curly quotes, and inserts or deletes alone", async () => {
    const { out, html, bytes } = await redlined([
      { find: "Supplier shall indemnify", paragraph: "12.3", replace: "Supplier shall indemnify, defend and hold harmless" },
      { find: "Supplier", replace: "Vendor", all: true, reason: "Defined term renamed." },
      { find: "Vendor's fees", replace: "Vendor's charges" },
      { find: "each ", replace: "" },
      { find: "deliver the Services", replace: "deliver the Services on time" },
      { find: "Schedule A sets", replace: "Schedule A, attached, sets" },
    ]);
    assert.deepEqual(
      out.edits.map((e) => [e.status, e.count, e.matched ?? null]),
      [["applied", 1, "exact"], ["applied", 5, "exact"], ["applied", 1, "normalized"], ["applied", 1, "exact"], ["applied", 1, "exact"], ["applied", 1, "exact"]],
    );
    // "Vendor" is the rename's insertion, but only "fees" changes: that is plain text.
    assert.match(html.text, /12\.3 Vendor shall indemnify, defend and hold harmless Customer\./);
    assert.match(html.text, /The Vendor shall deliver the Services on time\. The Vendor warrants the Services\./);
    assert.match(html.text, /Schedule A, attached, sets the Vendor’s charges\./);
    assert.match(html.text, /shall pay invoice within/);
    // One comment for the rename, on its first occurrence.
    assert.equal(html.notes.length, 1);
    assert.equal(html.notes[0]!.anchor, "Vendor");
    // The insertion alone, after "indemnify"; the hyperlink kept its run inside it.
    assert.match(html.html, /indemnify<ins[^>]*>, defend and hold harmless<\/ins> Customer/);
    // Text added right after a link stays out of it.
    assert.match(html.html, /<a href="https:\/\/example.org\/schedule-a">Schedule A<\/a><ins[^>]*>, attached,<\/ins> sets/);
    assert.match(documentXml(bytes), /<w:hyperlink r:id="rIdL"><w:r><w:t xml:space="preserve">Schedule A<\/w:t><\/w:r><\/w:hyperlink><w:ins [^>]*><w:r><w:t xml:space="preserve">, attached,<\/w:t><\/w:r><\/w:ins>/);

    const curly = await redlined([{ find: "Supplier's fees", replace: "Supplier's charges" }]);
    assert.deepEqual(curly.out.edits[0], { index: 0, find: "Supplier's fees", status: "applied", count: 1, matched: "normalized" });
    // The apostrophe was the same once read plainly: only "fees" changed.
    assert.match(curly.html.html, /Supplier’s <del[^>]*>fees<\/del><ins[^>]*>charges<\/ins>\./);
  });

  it("comments on text without changing it", async () => {
    const { out, bytes, html } = await redlined([{ find: "shall indemnify Customer", reason: "Uncapped — flag for the partner." }]);
    assert.deepEqual(out.edits[0], { index: 0, find: "shall indemnify Customer", status: "applied", count: 1, matched: "exact", comment: true });
    const xml = documentXml(bytes);
    assert.doesNotMatch(xml, /w:author="Strut"/);
    assert.match(xml, /<w:commentRangeStart w:id="(\d+)"\/><w:r><w:t xml:space="preserve">shall indemnify Customer<\/w:t><\/w:r><w:commentRangeEnd w:id="\1"\/><w:r><w:commentReference w:id="\1"\/><\/w:r>/);
    assert.deepEqual(html.notes.map((n) => [n.text, n.anchor]), [["Uncapped — flag for the partner.", "shall indemnify Customer"]]);

    // On someone else's tracked insertion: the marks go around it, never into it.
    const theirs = await redlined([{ find: "negotiated", reason: "We never agreed to this." }]);
    assert.equal(theirs.out.applied, 1);
    assert.match(documentXml(theirs.bytes), /<w:commentRangeStart w:id="(\d+)"\/><w:ins w:id="40" w:author="Opposing Counsel"[^>]*><w:r><w:t xml:space="preserve">negotiated<\/w:t><\/w:r><\/w:ins><w:commentRangeEnd w:id="\1"\/>/);
    assert.equal(theirs.html.notes[0]!.anchor, "negotiated");
  });

  it("leaves a field's result alone", async () => {
    const field = docx(
      p(
        r("See "),
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> REF clause_12 \\h </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>',
        r("Section 12"),
        '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
        r(" for remedies."),
      ),
    );
    const { ctx, root } = ctxFor();
    await put(root, "f.docx", field);
    const out = await redline.run(redline.input.parse({ path: "f.docx", edits: [{ find: "Section 12", replace: "Section 14" }, { find: "for remedies", replace: "for all remedies" }] }), ctx);
    assert.match(out.unplaced[0]!.reason!, /inside a field/);
    assert.equal(out.edits[1]!.status, "applied");
    assert.equal(docxToHtml(readFileSync(join(root, out.path))).text, "See Section 12 for all remedies.");
  });

  it("writes into a plain run's artifacts, beside the original or where it is told", async () => {
    const { ctx, root } = ctxFor();
    await put(root, "draft.docx", CONTRACT);
    const out = await redline.run(redline.input.parse({ path: "draft.docx", edits: [{ find: "Notices", replace: "All notices" }] }), ctx);
    assert.equal(out.url, "/artifacts/run1/draft.redline.docx");
    const named = await redline.run(redline.input.parse({ path: "/artifacts/run1/draft.docx", out: "out/v2.docx", author: "Jane Partner", edits: [{ find: "Notices", replace: "All notices" }] }), ctx);
    assert.equal(named.path, "out/v2.docx");
    const changes = docxToHtml(readFileSync(join(root, "out/v2.docx"))).changes.filter((c) => c.author === "Jane Partner");
    assert.deepEqual(changes.map((c) => [c.kind, c.text]), [["delete", "Notices"], ["insert", "All notices"]]);
    await assert.rejects(redline.run(redline.input.parse({ path: "draft.docx", date: "yesterday", edits: [{ find: "x", replace: "y" }] }), ctx), /not an ISO time/);
  });

  it("produces a .docx another reader takes: pandoc sees the changes and the comment", async (t) => {
    try {
      execFileSync("pandoc", ["--version"], { stdio: "ignore" });
    } catch {
      t.skip("pandoc is not installed");
      return;
    }
    const { bytes } = await redlined([{ find: "within thirty (30) days", replace: "within sixty (60) days", reason: "Net 60." }]);
    const dir = mkdtempSync(join(tmpdir(), "strut-docx-pandoc-"));
    writeFileSync(join(dir, "r.docx"), bytes);
    const md = execFileSync("pandoc", ["--track-changes=all", "--wrap=none", "-t", "html", join(dir, "r.docx")], { encoding: "utf8" });
    assert.match(md, /class="deletion" data-author="Strut" data-date="2026-11-02T12:00:00Z"><strong>thir<\/strong>ty \(30\)</);
    assert.match(md, /class="insertion" data-author="Strut" data-date="2026-11-02T12:00:00Z"><strong>sixty \(60\)<\/strong>/);
    assert.match(md, /class="comment-start"[^>]*data-author="Strut"[^>]*>Net 60\./);
    const accepted = execFileSync("pandoc", ["--track-changes=accept", "-t", "plain", join(dir, "r.docx")], { encoding: "utf8" });
    assert.match(accepted.replace(/\s+/g, " "), /within sixty \(60\) days of receipt/);
  });
});

describe("docx word changes", () => {
  it("diffs by whole words, joins changes a space apart, and reads curly quotes as plain", () => {
    assert.deepEqual(wordChanges("within thirty (30) days", "within sixty (60) days"), [{ start: 7, end: 18, insert: "sixty (60)" }]);
    assert.deepEqual(wordChanges("30 days", "30 business days"), [{ start: 3, end: 3, insert: "business " }]);
    assert.deepEqual(wordChanges("the very big dog", "the big dog"), [{ start: 4, end: 9, insert: "" }]);
    assert.deepEqual(wordChanges("Seller’s rights", "Seller's duties"), [{ start: 9, end: 15, insert: "duties" }]);
    assert.deepEqual(wordChanges("a b c", "a b c"), []);
    // A number is one word, and the marks stuck to it go with it.
    assert.deepEqual(wordChanges("at 1.5% per month", "at 1% per month"), [{ start: 3, end: 7, insert: "1%" }]);
    assert.deepEqual(wordChanges("Delivery: $40,000.", "Delivery: $35,000."), [{ start: 10, end: 17, insert: "$35,000" }]);
    assert.equal(normalize("“It’s” —"), '"It\'s" -');
  });
});

describe("docx steps in the registry", () => {
  it("are lib steps, each with an example; neither reaches outside the run", async () => {
    const { registry, sources } = await buildRegistry();
    for (const type of ["docx/to-html", "docx/redline"]) {
      assert.equal(sources[type], "lib");
      assert.match(registry[type]!.description ?? "", /- id: \w+\n {2}type: /);
    }
    assert.equal(registry["docx/to-html"]!.effect, "read");
    assert.equal(registry["docx/redline"]!.effect, undefined);
  });

  it("step files reach nothing past ctx.services", () => {
    for (const f of ["to-html.ts", "redline.ts"]) {
      assert.deepEqual(lintStepSource(readFileSync(new URL(f, import.meta.url), "utf8")), [], f);
    }
  });
});
