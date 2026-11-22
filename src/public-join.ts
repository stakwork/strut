/**
 * `GET /public/join` (plans/human-steps.md §5.8): the page a worker invite's
 * link opens, `https://<public view>/public/join#action=i&d=…&c=…&a=…`. One
 * static page, answered without the key like the rest of `/public/*`. The
 * invite rides after `#`, which a browser never sends, so no server — this
 * one included — sees it; the page's script reads it from `location.hash`.
 *
 * - **On Android** it shows "Open in Peel": the invite as Chrome's
 *   `intent://` form of `sphinx.chat://?action=i&…` for Peel's package. With
 *   Peel installed, Peel opens it (a new user signs up with the invite, then
 *   Peel opens the worker app named by `a=`; an existing user goes straight
 *   to it). Without, Chrome goes to `S.browser_fallback_url`: the newest APK
 *   on stakwork/peel-android's GitHub releases, which the page looks up
 *   (falling back to the releases page). Nothing carries an intent across an
 *   install, so each tap also COPIES the invite link (`sphinx.chat://?…`):
 *   a Peel opened with no account and no invite reads it off the clipboard
 *   (peel-android's onboarding), and a new worker goes from install to
 *   signup to the worker app without coming back here. There is one
 *   button: a Peel that missed the invite (too old to read the clipboard) is
 *   sent it by tapping the same button again. It is a link the person taps:
 *   Chrome opens an app from a page only on a gesture, and writes the
 *   clipboard only on one.
 * - **On an iPhone or iPad** (iPadOS reports as a Mac with touch points) it
 *   shows two links in the dock: "Get Peel" (Peel iOS is on TestFlight only,
 *   `PEEL_IOS_TESTFLIGHT`, with a hint that Apple's TestFlight app comes
 *   first) and "Open in Peel" (`peel://join?<q>`, the same query as Android's
 *   `sphinx.chat://?<q>`; Peel iOS does not use `sphinx.chat://` because the
 *   Sphinx iOS app registers it too). Both taps copy `sphinx.chat://?<q>`,
 *   exactly as Android's does, for a Peel with no account to read on first
 *   launch. Neither navigation is prevented.
 * - **Anywhere else** it says to open the link on a phone and draws
 *   a QR code of its own URL, invite included, with qrcode-generator's
 *   browser build served beside it (`/public/join/qrcode.js`).
 * - **In the worker's language** (plans/i18n.md): English or Spanish, the
 *   link's `?lang=`, else the `join_lang` cookie, else the browser's first
 *   `Accept-Language` — what `navigator.language` says, so the page speaks
 *   as the Worker app Peel opens next will. A two-button switcher
 *   ("English · Español", top right) sets that cookie (Path=/public/join, a
 *   year) and reloads the page with `?lang=`, the invite's `#…` kept. The
 *   words are the page's HTML alone; the script holds none, so one hash pins
 *   it in every language.
 * - **An invitation card**: the employer's initial (the server name's), "Invite",
 *   "‹name› invites you", and on Android a dock pinned to the bottom with
 *   "Open in Peel" (on an iPhone, "Get Peel" and "Open in Peel"); elsewhere the QR code in
 *   the card.
 *
 * Chrome's `intent://` form (developer.chrome.com, "Android Intents with
 * Chrome"): `intent://<what follows the scheme's ://>#Intent;scheme=<the
 * scheme>;package=<app id>;S.browser_fallback_url=<URL, percent-encoded>;end`.
 * Android rebuilds the data URI as `<scheme>:` + everything between
 * `intent:` and `#Intent;`, so the invite's query goes in as it is (its
 * `a=` already percent-encoded, no `#` in it) and only the fallback URL,
 * a value inside the fragment's `;`-separated extras, is encoded. A fallback
 * is followed only when it is http(s).
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

/** Peel Android's application id. */
export const PEEL_ANDROID_PACKAGE = "com.sphinx.peel";
/** Where Peel Android ships: its GitHub releases, newest first. */
export const PEEL_ANDROID_RELEASES = "https://github.com/stakwork/peel-android/releases/latest";
/** The newest release's assets, read by the page (GitHub's API answers any origin). */
export const PEEL_ANDROID_LATEST_API = "https://api.github.com/repos/stakwork/peel-android/releases/latest";

/** Peel iPhone's public TestFlight link (needs Apple's TestFlight app first). */
export const PEEL_IOS_TESTFLIGHT = "https://testflight.apple.com/join/mFsg7Gkb";

/** The page's script: plain JS, run as it is in the browser (and in
 *  public-join.test.ts against a stand-in `document`). */
export const JOIN_SCRIPT = `(function () {
  var PKG = ${JSON.stringify(PEEL_ANDROID_PACKAGE)};
  var RELEASES = ${JSON.stringify(PEEL_ANDROID_RELEASES)};
  var TESTFLIGHT = ${JSON.stringify(PEEL_IOS_TESTFLIGHT)};
  var LATEST = ${JSON.stringify(PEEL_ANDROID_LATEST_API)};
  var show = function (id) { document.getElementById(id).hidden = false; };
  // The language switcher: remember the choice, then reload with it, the hash kept.
  var langs = document.querySelectorAll("[data-lang]");
  var pick = function (b) {
    b.onclick = function () {
      var l = b.getAttribute("data-lang");
      if (l !== "en" && l !== "es") return;
      document.cookie = "join_lang=" + l + "; Path=/public/join; Max-Age=31536000; SameSite=Lax";
      var keep = location.search.slice(1).split("&").filter(function (p) { return p && !/^lang=/.test(p); });
      keep.push("lang=" + l);
      location.replace(location.pathname + "?" + keep.join("&") + location.hash);
    };
  };
  for (var k = 0; k < langs.length; k++) pick(langs[k]);
  // The invite, as the app takes it after "sphinx.chat://?".
  var q = location.hash.slice(1).replace(/^sphinx\\.chat:\\/\\/\\?/i, "");
  if (!/^action=i&/.test(q) || !/(^|&)d=[^&]+/.test(q) || /[#\\s]/.test(q)) { document.getElementById("card").hidden = true; show("bad"); return; }
  // A tap that gets or opens the app also hands it the invite, through the clipboard.
  var copy = function () {
    try { navigator.clipboard.writeText("sphinx.chat://?" + q).catch(function () {}); } catch (e) {}
  };
  if (/Android/i.test(navigator.userAgent)) {
    var point = function (fallback) {
      var href = "intent://?" + q + "#Intent;scheme=sphinx.chat;package=" + PKG + ";S.browser_fallback_url=" + encodeURIComponent(fallback) + ";end";
      document.getElementById("open").href = href;
    };
    point(RELEASES);
    document.getElementById("open").onclick = copy;
    show("android");
    // The newest APK itself, so no app yet is one tap to download.
    fetch(LATEST, { headers: { accept: "application/vnd.github+json" }, credentials: "omit", referrerPolicy: "no-referrer" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rel) {
        var assets = (rel && rel.assets) || [];
        for (var i = 0; i < assets.length; i++) {
          var url = assets[i] && assets[i].browser_download_url;
          if (typeof url === "string" && /^https:\\/\\/github\\.com\\/stakwork\\/peel-android\\/releases\\/download\\/[^?#]+\\.apk$/.test(url)) { point(url); return; }
        }
      })
      .catch(function () {});
  } else if (/iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) {
    document.getElementById("testflight").href = TESTFLIGHT;
    document.getElementById("open-ios").href = "peel://join?" + q;
    document.getElementById("testflight").onclick = copy;
    document.getElementById("open-ios").onclick = copy;
    show("ios");
  } else {
    show("elsewhere");
    var s = document.createElement("script");
    s.src = "join/qrcode.js";
    s.onload = function () {
      var qr = qrcode(0, "M");
      qr.addData(location.href);
      qr.make();
      document.getElementById("qr").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
    };
    document.head.appendChild(s);
  }
})();`;

const STYLE = `
:root { color-scheme: light dark; --fg: #1c1917; --bg: #fafaf9; --muted: #78716c; --accent: #ea580c; --line: #e7e5e4; --card: #fff; }
@media (prefers-color-scheme: dark) { :root { --fg: #fafaf9; --bg: #0c0a09; --muted: #a8a29e; --accent: #fb923c; --line: #292524; --card: #1c1917; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 24rem; min-height: 100vh; margin: 0 auto; padding: 3.5rem 1rem 0; display: flex; flex-direction: column; gap: 1rem; }
.lang { position: absolute; top: 0.75rem; right: 0.75rem; display: flex; gap: 0.25rem; font-size: 0.8rem; }
.lang button { font: inherit; color: var(--muted); background: none; border: 0; padding: 0.2rem 0.4rem; border-radius: 0.4rem; cursor: pointer; }
.lang button[aria-pressed="true"] { color: var(--fg); font-weight: 700; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 20px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08); text-align: center; padding: 28px 22px 22px; overflow: hidden; }
.avatar { width: 64px; height: 64px; margin: 0 auto 14px; border-radius: 50%; background: linear-gradient(135deg, var(--accent), #be123c); color: #fff; font-size: 1.7rem; font-weight: 700; line-height: 64px; }
.eyebrow { font-size: 0.7rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); }
h1 { font-size: 1.6rem; line-height: 1.2; margin: 0.25rem 0; }
p { margin: 0; }
.muted { color: var(--muted); font-size: 0.9rem; }
#elsewhere { margin-top: 1.25rem; }
#qr { width: 170px; margin: 0 auto 0.75rem; }
#qr svg { width: 100%; height: auto; background: #fff; border-radius: 0.5rem; }
.perf { border-top: 2px dashed var(--line); margin: 1.25rem -22px 1rem; }
.meta { display: flex; justify-content: space-between; gap: 1rem; font-size: 0.8rem; color: var(--muted); }
#bad { text-align: center; }
#android, #ios { position: sticky; bottom: 0; margin-top: auto; padding: 2rem 0 1.25rem; text-align: center; background: linear-gradient(to bottom, transparent, var(--bg) 40%); display: flex; flex-direction: column; gap: 0.6rem; }
.button { display: block; padding: 17px; border-radius: 999px; background: var(--accent); color: #fff; font-weight: 700; text-decoration: none; }
[hidden] { display: none !important; }
`;

/** TestFlight's App Store page, linked from the hint. */
const IOS_TESTFLIGHT_APP = "https://apps.apple.com/app/testflight/id899247664";

/** The page's words, per language: English the type, so a missing or
 *  misshaped Spanish message fails tsc. Plain text, put in as it is. */
const en = {
  invite: "Invite",
  invited: "You're invited",
  invites: (name: string) => `${name} invites you`,
  withThem: "to join their team on Peel.",
  generic: "to join a team on Peel.",
  from: "From",
  app: "Peel",
  open: "Open in Peel",
  installs: "No Peel yet? This button downloads it and keeps your invite.",
  getPeel: "Get Peel",
  tfHint: "Peel for iPhone needs Apple's TestFlight app first:",
  tfApp: "get TestFlight",
  haveIt: "Already have Peel? Open it with your invite.",
  scan: "Scan with your phone",
  qr: "A QR code of this invite's link",
  bad: "This link has no invite in it. Ask whoever sent it for a new one.",
  language: "Language",
};
type JoinWords = typeof en;
/** Neutral Latin American Spanish, `tú` (plans/i18n.md). */
const es: JoinWords = {
  invite: "Invitación",
  invited: "Tienes una invitación",
  invites: (name) => `${name} te invita`,
  withThem: "a unirte a su equipo en Peel.",
  generic: "para unirte a un equipo en Peel.",
  from: "De",
  app: "Peel",
  open: "Abrir en Peel",
  installs: "¿Aún no tienes Peel? Este botón lo descarga y guarda tu invitación.",
  getPeel: "Obtener Peel",
  tfHint: "Peel para iPhone necesita primero la app TestFlight de Apple:",
  tfApp: "obtener TestFlight",
  haveIt: "¿Ya tienes Peel? Ábrelo con tu invitación.",
  scan: "Escanea el código con tu teléfono",
  qr: "Un código QR del enlace de esta invitación",
  bad: "Este enlace no tiene ninguna invitación. Pídele uno nuevo a quien te lo envió.",
  language: "Idioma",
};
const JOIN_WORDS = { en, es };
export type JoinLang = keyof typeof JOIN_WORDS;

/** The page's language: the link's `?lang=`, else the `join_lang` cookie
 *  (the switcher's), else the browser's first choice in `Accept-Language`
 *  (its `navigator.language`); English when none is one the page speaks.
 *  `es-MX` → `es`. A bad `lang=` falls to English, a bad cookie is ignored. */
export function joinLang(lang?: string | null, acceptLanguage?: string | null, cookie?: string | null): JoinLang {
  const pick = (tag: string | undefined): JoinLang | undefined => {
    const l = (tag ?? "").trim().toLowerCase().split(/[-_]/)[0] ?? "";
    return Object.hasOwn(JOIN_WORDS, l) ? (l as JoinLang) : undefined;
  };
  if (lang?.trim()) return pick(lang) ?? "en";
  const saved = /(?:^|;\s*)join_lang=([^;]*)/.exec(cookie ?? "")?.[1]?.trim();
  const fromCookie = saved === "en" || saved === "es" ? saved : undefined;
  return fromCookie ?? pick(acceptLanguage?.split(",")[0]?.split(";")[0]) ?? "en";
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The page for a server with a name (its brand's, src/brand.ts): "Acme
 *  invites you", HTML-escaped, in its title and heading; without one,
 *  "You're invited". In `lang`'s words, its three faces hidden until the
 *  script picks one. The script is the same in each, so is its hash. */
export function joinPage(name?: string, lang: JoinLang = "en"): string {
  const w = JOIN_WORDS[lang];
  const n = name?.trim();
  const heading = n ? w.invites(escape(n)) : w.invited;
  const initial = n ? escape([...n][0]!.toUpperCase()) : "✉";
  const btn = (l: JoinLang, label: string) => `<button type="button" data-lang="${l}" aria-pressed="${l === lang}">${label}</button>`;
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${heading}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="lang" role="group" aria-label="${w.language}">${btn("en", "English")} · ${btn("es", "Español")}</div>
<main>
<div id="card" class="card">
<div class="avatar" aria-hidden="true">${initial}</div>
<div class="eyebrow">${w.invite}</div>
<h1>${heading}</h1>
<p class="muted">${n ? w.withThem : w.generic}</p>
<div id="elsewhere" hidden>
<div id="qr" role="img" aria-label="${w.qr}"></div>
<p><b>${w.scan}</b></p>
</div>
<div class="perf"></div>
<div class="meta"><span>${n ? `${w.from} <b>${escape(n)}</b>` : ""}</span><span>${w.app}</span></div>
</div>
<p id="bad" hidden>${w.bad}</p>
<div id="android" hidden>
<a id="open" class="button" href="#">${w.open}</a>
<p class="muted">${w.installs}</p>
</div>
<div id="ios" hidden>
<a id="testflight" class="button" href="#">${w.getPeel}</a>
<p class="muted">${w.tfHint} <a href="${IOS_TESTFLIGHT_APP}">${w.tfApp}</a></p>
<a id="open-ios" class="button" href="#">${w.open}</a>
<p class="muted">${w.haveIt}</p>
</div>
</main>
<script>${JOIN_SCRIPT}</script>
</body>
</html>
`;
}

/** The page in English, for a server with no name. */
export const JOIN_PAGE = joinPage();

/** The page's headers: its own inline script alone (by hash) and the QR
 *  library beside it; the one request it makes, GitHub's release lookup.
 *  Its language follows the cookie and `Accept-Language`, so a cache keys on both. */
export const JOIN_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-cache",
  vary: "accept-language, cookie",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy": [
    "default-src 'none'",
    `script-src 'self' 'sha256-${createHash("sha256").update(JOIN_SCRIPT).digest("base64")}'`,
    "style-src 'unsafe-inline'",
    `connect-src ${new URL(PEEL_ANDROID_LATEST_API).origin}`,
    "img-src data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
});

let qrScript: Promise<string> | undefined;
/** qrcode-generator's browser build (a global `qrcode`), read once. */
export function joinQrScript(): Promise<string> {
  qrScript ??= readFile(createRequire(import.meta.url).resolve("qrcode-generator"), "utf8");
  return qrScript;
}
