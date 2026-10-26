import type { Span } from "../types.js";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path segment that identifies someone or carries a secret rather than naming a page. */
function segmentType(seg: string): string | null {
  const s = decodeURIComponent_(seg);
  if (EMAIL.test(s)) return "EMAIL";
  if (/^@[\w.-]{2,}$/.test(s)) return "HANDLE";
  if (UUID.test(s) || /^\d{6,}$/.test(s) || /^[0-9a-f]{16,}$/i.test(s)) return "ID";
  if (/^[A-Za-z0-9_-]{20,}$/.test(s) && /\d/.test(s) && /[A-Za-z]/.test(s)) return "ID"; // token-like
  if (/(^|[-_.])(sig|signature|token|key|secret)([-_.]|$)/i.test(s) && s.length >= 12) return "ID"; // signed
  return null;
}
const decodeURIComponent_ = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

/** The URL stays readable (scheme, host, path); what could name or authorise a person does not:
 *  userinfo, query values, a fragment that carries data, emails/handles/ids/tokens in the path. */
export function refineUrl(sp: Span, text: string): Span[] {
  const url = text.slice(sp.s, sp.e);
  const out: Span[] = [];
  const add = (from: number, len: number, type: string) => { if (len > 0) out.push({ s: sp.s + from, e: sp.s + from + len, type, src: "rule" }); };
  const m = /^([a-z][a-z0-9+.-]*:\/\/)?([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(url);
  if (!m) return out;
  const scheme = m[1] ?? "", auth = m[2] ?? "", path = m[3] ?? "", query = m[4] ?? "", frag = m[5] ?? "";
  const at = auth.lastIndexOf("@");
  if (at > 0) add(scheme.length, at, "ID");
  let off = scheme.length + auth.length;
  for (const seg of path.split("/")) {
    const [name, ...params] = seg.split(";"); // ;jsessionid=… path parameters
    const t = segmentType(name!);
    if (t) add(off, name!.length, t);
    let po = off + name!.length;
    for (const p of params) { const eq = p.indexOf("="); if (eq >= 0) add(po + 1 + eq + 1, p.length - eq - 1, "ID"); po += 1 + p.length; }
    off += seg.length + 1;
  }
  off = scheme.length + auth.length + path.length;
  if (query) {
    let q = off + 1;
    for (const pair of query.slice(1).split("&")) {
      const eq = pair.indexOf("=");
      if (eq >= 0) add(q + eq + 1, pair.length - eq - 1, "ID");
      q += pair.length + 1;
    }
    off += query.length;
  }
  if (frag.length > 1 && (frag.includes("=") || /^#[A-Za-z0-9_.~-]{16,}$/.test(frag))) add(off + 1, frag.length - 1, "ID");
  return out;
}
