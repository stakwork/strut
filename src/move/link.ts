// The pairing link: where the serving strut is, and the code. Plain by
// default, `http://<host>/?code=<code>` (the page itself); a client with a
// scheme of its own passes its prefix (Peel: `peel://home-setup`), and the
// link is `<prefix>?host=<host>&code=<code>`. Either parses.
import qrcode from "qrcode-generator";
import { normalizeCode } from "./seal.js";

export function makeLink(host: string, code: string, prefix?: string): string {
  if (!prefix) return `http://${host}/?code=${code}`;
  const q = new URLSearchParams();
  if (host) q.set("host", host);
  q.set("code", code);
  return `${prefix}?${q}`;
}

/** The serving strut's base URL and the code in a link. */
export function parseLink(link: string): { base: string; code: string } {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new Error(`not a move link: ${link}`);
  }
  const code = normalizeCode(url.searchParams.get("code") ?? "");
  const host = url.searchParams.get("host") ?? (/^https?:$/.test(url.protocol) ? url.host : "");
  if (!code) throw new Error("the move link has no code");
  if (!host) throw new Error("the move link names no host: open it from the page on the box's address");
  return { base: `${url.protocol === "https:" ? "https" : "http"}://${host}`, code };
}

function matrix(text: string): boolean[][] {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, y) => Array.from({ length: n }, (_, x) => qr.isDark(y, x)));
}

/** `text` as a QR code: an inline SVG with a four-module quiet zone. */
export function qrSvg(text: string): string {
  const m = matrix(text);
  const n = m.length + 8;
  let d = "";
  m.forEach((row, y) => row.forEach((dark, x) => (d += dark ? `M${x + 4} ${y + 4}h1v1h-1z` : "")));
  return `<svg class="qr" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="QR code of the link"><rect width="${n}" height="${n}" fill="#fff"/><path fill="#000" d="${d}"/></svg>`;
}

/** `text` as a QR code for a terminal, two columns a module. */
export function qrTerminal(text: string): string {
  const m = matrix(text);
  const light = "\x1b[47m  ";
  const dark = "\x1b[40m  ";
  const lines: string[] = [];
  for (let y = -2; y < m.length + 2; y++) {
    let line = "";
    for (let x = -2; x < m.length + 2; x++) line += m[y]?.[x] ? dark : light;
    lines.push(`${line}\x1b[0m`);
  }
  return lines.join("\n");
}
