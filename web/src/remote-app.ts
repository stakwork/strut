// ── Another strut server's public app, hosted here (specs/API.md §17.9) ────
//
// `?app=<name>&public=1&from=<base>`: the public app `<name>` as the strut
// server at `<base>` serves it to anyone, with THIS strut's UI as its host.
// The app's document comes from `<base>/public/apps/<name>/document` and is
// framed here (components/AppHost.tsx), its calls go to
// `<base>/public/mcp`, and a priced launch is paid here — through the
// native wallet of the web view this page runs in (Peel), else a QR code —
// with the credit kept in this page's own storage, one purse per server.
// The stranger's server runs no host code of its own here: its page is a
// sandboxed frame like any app's, and never sees the purse or the wallet.
//
// `from` is the server's base URL — an origin, or an origin and a path
// for a strut mounted under one (`https://acme.example/lab`) — over https,
// or http to this machine alone (a development pair; a LAN box gets a
// certificate). `solo=1` is implied: a remote app is always shown alone.
// Pure, for the root test run (remote-app.test.ts).

import { isSellerUrl } from "@strut/kit/wallet";

/** The base URL a `from` names, normalized as strut names a seller
 *  (src/remote.ts `sellerOf`): the origin and path, no trailing `/` nor
 *  `/public`; or why it is not one this host opens. */
export function remoteBase(raw: string | null | undefined): { base: string } | { error: string } {
  const text = (raw ?? "").trim();
  if (!text) return { error: "the link names no server" };
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { error: `${JSON.stringify(text.slice(0, 200))} is not a URL` };
  }
  if (u.username || u.password) return { error: "a server's address carries no credentials" };
  let path = u.pathname.replace(/\/+$/, "");
  if (path.endsWith("/public")) path = path.slice(0, -"/public".length).replace(/\/+$/, "");
  const base = `${u.origin}${path}`;
  if (!isSellerUrl(base)) {
    return {
      error: u.protocol === "http:"
        ? `${u.origin} is not https: a stranger's app is opened over https only (http only to this machine, for development)`
        : `${u.origin} is not a strut server's address`,
    };
  }
  return { base };
}

/** The link into a strut's UI that opens another server's public app with
 *  that UI as its host. Never a credential: the purse stays in the page. */
export function remoteAppHref(strutUrl: string, o: { from: string; name: string; input?: string }): string {
  const p = new URLSearchParams();
  p.set("app", o.name);
  p.set("public", "1");
  p.set("from", o.from);
  p.set("solo", "1");
  if (o.input) p.set("input", o.input);
  return `${strutUrl.replace(/\/+$/, "")}/?${p.toString()}`;
}

/** Where a remote page's links lead: its own server's UI (./app-links
 *  `strutLink` reads a link against it), so `?app=<other>` is that server's
 *  app, never one of this strut's. */
export function remoteHere(base: string): { origin: string; pathname: string } {
  const u = new URL(`${base}/`);
  return { origin: u.origin, pathname: u.pathname };
}

/** Where a remote page's link to ANOTHER app on its server leads: that app,
 *  hosted by this same strut UI (`thisStrut`: its base URL), never by the
 *  server's own UI — the host this design keeps a stranger's code away from.
 *  Null for anything else (a workflow, a run, a file): that opens on the
 *  server, as a plain page. `params` as ./app-links `strutLink` reads the
 *  link against the server (`remoteHere`). */
export function remoteAppLink(params: Record<string, string>, from: string, thisStrut: string): string | null {
  const app = params["app"];
  if (!app || app.startsWith("@") || /@(v\d+|preview-)/.test(app)) return null;
  return remoteAppHref(thisStrut, { from, name: app, ...(params["input"] ? { input: params["input"] } : {}) });
}

/** The CSP every app's build writes (src/apps/build.ts `cspFor`, with no
 *  resource domains; held equal by remote-app.test.ts). */
export const APP_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src data: blob:",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** A stranger's document as this host frames it: the build's CSP written
 *  FIRST, ahead of anything the server sent. A strut server's own build
 *  carries it already; one that dropped or loosened it is held to it all the
 *  same — the browser enforces every policy a document declares, and the
 *  first is in force before any of the server's markup is parsed — so the
 *  page cannot load a script, fetch, post a form or send an image to a host
 *  of its choosing. It CAN still navigate itself away, a URL carrying
 *  whatever was typed into it: a native host can refuse that navigation, a
 *  browser cannot. So a stranger's page is no place for a secret. */
export function strangerDocument(html: string): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${APP_CSP}">${html}`;
}
