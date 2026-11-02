// The XML of a .docx part as a plain tree that serializes back to what it
// read: text and attribute values are kept as they were written (escaped),
// and decoded only when read. So a redline that changes three runs leaves
// the rest of `document.xml` as Word wrote it. Not a general XML parser —
// no DTDs, no entity declarations: what OOXML parts hold.

export interface XAttr {
  name: string;
  /** As written between the quotes, still escaped. */
  raw: string;
  q: '"' | "'";
}

export interface XEl {
  name: string;
  attrs: XAttr[];
  kids: XNode[];
}

/** Character data, as written (escaped), or a CDATA section's content. */
export interface XText {
  text: string;
  cdata?: true;
}

/** A declaration, processing instruction, comment or doctype, verbatim. */
export interface XRaw {
  raw: string;
}

export type XNode = XEl | XText | XRaw;

export const isEl = (n: XNode | undefined): n is XEl => !!n && "name" in n;
const isText = (n: XNode): n is XText => "text" in n;

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeXml(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

export function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The nodes of a document, in order (the declaration first, then the root). */
export function parseXml(xml: string): XNode[] {
  const top: XNode[] = [];
  const stack: XEl[] = [];
  const add = (n: XNode) => (stack.length ? stack[stack.length - 1]!.kids : top).push(n);
  let i = 0;
  if (xml.charCodeAt(0) === 0xfeff) i = 1;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      if (xml.slice(i).trim()) add({ text: xml.slice(i) });
      break;
    }
    if (lt > i) add({ text: xml.slice(i, lt) });
    if (xml.startsWith("<!--", lt)) {
      const e = xml.indexOf("-->", lt);
      if (e < 0) throw new Error("unclosed XML comment");
      add({ raw: xml.slice(lt, e + 3) });
      i = e + 3;
    } else if (xml.startsWith("<![CDATA[", lt)) {
      const e = xml.indexOf("]]>", lt);
      if (e < 0) throw new Error("unclosed CDATA section");
      add({ text: xml.slice(lt + 9, e), cdata: true });
      i = e + 3;
    } else if (xml[lt + 1] === "?" || xml[lt + 1] === "!") {
      const e = xml.indexOf(">", lt);
      if (e < 0) throw new Error("unclosed XML declaration");
      add({ raw: xml.slice(lt, e + 1) });
      i = e + 1;
    } else if (xml[lt + 1] === "/") {
      const e = xml.indexOf(">", lt);
      const name = xml.slice(lt + 2, e).trim();
      const open = stack.pop();
      if (!open || open.name !== name) throw new Error(`mismatched XML close tag </${name}>`);
      i = e + 1;
    } else {
      // A start tag: its name, then attributes up to `>` or `/>`.
      let j = lt + 1;
      while (j < xml.length && !/[\s/>]/.test(xml[j]!)) j++;
      const el: XEl = { name: xml.slice(lt + 1, j), attrs: [], kids: [] };
      for (;;) {
        while (j < xml.length && /\s/.test(xml[j]!)) j++;
        if (j >= xml.length) throw new Error(`unclosed XML tag <${el.name}`);
        if (xml[j] === ">" || xml.startsWith("/>", j)) break;
        const eq = xml.indexOf("=", j);
        if (eq < 0) throw new Error(`malformed XML attribute in <${el.name}`);
        const name = xml.slice(j, eq).trim();
        let k = eq + 1;
        while (/\s/.test(xml[k]!)) k++;
        const q = xml[k] as '"' | "'";
        if (q !== '"' && q !== "'") throw new Error(`unquoted XML attribute ${name}`);
        const close = xml.indexOf(q, k + 1);
        el.attrs.push({ name, raw: xml.slice(k + 1, close), q });
        j = close + 1;
      }
      add(el);
      if (xml[j] === ">") {
        stack.push(el);
        i = j + 1;
      } else {
        i = j + 2;
      }
    }
  }
  if (stack.length) throw new Error(`unclosed XML element <${stack[stack.length - 1]!.name}>`);
  return top;
}

export function serializeXml(nodes: XNode[]): string {
  let out = "";
  const write = (n: XNode) => {
    if (isEl(n)) {
      out += `<${n.name}`;
      for (const a of n.attrs) out += ` ${a.name}=${a.q}${a.raw}${a.q}`;
      if (!n.kids.length) {
        out += "/>";
        return;
      }
      out += ">";
      for (const k of n.kids) write(k);
      out += `</${n.name}>`;
    } else if (isText(n)) {
      out += n.cdata ? `<![CDATA[${n.text}]]>` : n.text;
    } else {
      out += n.raw;
    }
  };
  for (const n of nodes) write(n);
  return out;
}

/** The document's root element. */
export function rootOf(nodes: XNode[]): XEl {
  const root = nodes.find(isEl);
  if (!root) throw new Error("XML part has no root element");
  return root;
}

export function attr(el: XEl | undefined, name: string): string | undefined {
  const a = el?.attrs.find((x) => x.name === name);
  return a ? decodeXml(a.raw) : undefined;
}

export function setAttr(el: XEl, name: string, value: string): void {
  const raw = escapeXml(value);
  const a = el.attrs.find((x) => x.name === name);
  if (a) Object.assign(a, { raw, q: '"' });
  else el.attrs.push({ name, raw, q: '"' });
}

export function child(el: XEl | undefined, name: string): XEl | undefined {
  return el?.kids.find((k): k is XEl => isEl(k) && k.name === name);
}

export function children(el: XEl | undefined, name?: string): XEl[] {
  return (el?.kids ?? []).filter((k): k is XEl => isEl(k) && (name === undefined || k.name === name));
}

/** The decoded character data directly under `el` (a `w:t`'s text). */
export function textOf(el: XEl): string {
  return el.kids.map((k) => (isText(k) ? (k.cdata ? k.text : decodeXml(k.text)) : "")).join("");
}

/** A new element; attribute values and text are given decoded. */
export function el(name: string, attrs: Record<string, string> = {}, kids: (XNode | string)[] = []): XEl {
  return {
    name,
    attrs: Object.entries(attrs).map(([n, v]) => ({ name: n, raw: escapeXml(v), q: '"' as const })),
    kids: kids.map((k) => (typeof k === "string" ? { text: escapeXml(k) } : k)),
  };
}

export function clone<T extends XNode>(n: T): T {
  if (isEl(n)) return { name: n.name, attrs: n.attrs.map((a) => ({ ...a })), kids: n.kids.map(clone) } as T;
  return { ...n };
}
