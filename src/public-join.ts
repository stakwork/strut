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
 *   signup to the worker app without coming back here. "Opened Peel without
 *   the invite?" fires the same intent again, for a Peel too old to read the
 *   clipboard. Each is a link the person taps: Chrome opens an app from a
 *   page only on a gesture, and writes the clipboard only on one.
 * - **Anywhere else** it says to open the link on an Android phone and draws
 *   a QR code of its own URL, invite included, with qrcode-generator's
 *   browser build served beside it (`/public/join/qrcode.js`).
 * - **In the worker's language** (plans/i18n.md): English or Spanish, the
 *   link's `?lang=` else the browser's first `Accept-Language` — what
 *   `navigator.language` says, so the page speaks as the Worker app Peel
 *   opens next will. The words are the page's HTML alone; the script holds
 *   none, so one hash pins it in every language.
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

/** The page's script: plain JS, run as it is in the browser (and in
 *  public-join.test.ts against a stand-in `document`). */
export const JOIN_SCRIPT = `(function () {
  var PKG = ${JSON.stringify(PEEL_ANDROID_PACKAGE)};
  var RELEASES = ${JSON.stringify(PEEL_ANDROID_RELEASES)};
  var LATEST = ${JSON.stringify(PEEL_ANDROID_LATEST_API)};
  var show = function (id) { document.getElementById(id).hidden = false; };
  // The invite, as Peel takes it after "sphinx.chat://?".
  var q = location.hash.slice(1).replace(/^sphinx\\.chat:\\/\\/\\?/i, "");
  if (!/^action=i&/.test(q) || !/(^|&)d=[^&]+/.test(q) || /[#\\s]/.test(q)) { show("bad"); return; }
  if (/Android/i.test(navigator.userAgent)) {
    var point = function (fallback) {
      var href = "intent://?" + q + "#Intent;scheme=sphinx.chat;package=" + PKG + ";S.browser_fallback_url=" + encodeURIComponent(fallback) + ";end";
      document.getElementById("open").href = href;
      document.getElementById("again").href = href;
    };
    point(RELEASES);
    // The tap that downloads Peel also hands it the invite, through the clipboard.
    var copy = function () {
      try { navigator.clipboard.writeText("sphinx.chat://?" + q).catch(function () {}); } catch (e) {}
    };
    document.getElementById("open").onclick = copy;
    document.getElementById("again").onclick = copy;
    show("android");
    // The newest APK itself, so no Peel yet is one tap to download.
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
:root { color-scheme: light dark; --fg: #111; --bg: #fff; --muted: #666; --accent: #4f46e5; --line: #ddd; }
@media (prefers-color-scheme: dark) { :root { --fg: #eee; --bg: #111; --muted: #999; --accent: #818cf8; --line: #333; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 26rem; margin: 0 auto; padding: 3rem 1rem; display: flex; flex-direction: column; gap: 1rem; }
h1 { font-size: 1.6rem; margin: 0; }
p { margin: 0; }
.muted { color: var(--muted); font-size: 0.9rem; }
section { display: flex; flex-direction: column; gap: 1rem; }
.button { display: block; text-align: center; padding: 0.9rem 1rem; border-radius: 0.6rem; background: var(--accent); color: #fff; font-weight: 600; text-decoration: none; }
.button.secondary { background: transparent; color: var(--accent); border: 1px solid var(--line); }
#qr svg { width: 100%; max-width: 18rem; height: auto; background: #fff; border-radius: 0.5rem; }
[hidden] { display: none !important; }
`;

/** The page's words, per language: English the type, so a missing or
 *  misshaped Spanish message fails tsc. Plain text, put in as it is. */
const en = {
  invited: "You're invited",
  invites: (name: string) => `${name} invites you`,
  android: "Peel signs you up with this invite, then opens the work.",
  open: "Open in Peel",
  noPeel: "No Peel yet? The button downloads it and copies your invite. Install Peel and open it: it finds the invite and signs you up.",
  again: "Opened Peel without the invite? Tap here",
  elsewhere: "Open this link on an Android phone: scan the code with its camera.",
  qr: "A QR code of this invite's link",
  peelAndroid: "You sign up with Peel, which runs on Android.",
  bad: "This link has no invite in it. Ask whoever sent it for a new one.",
};
type JoinWords = typeof en;
/** Neutral Latin American Spanish, `tú` (plans/i18n.md). */
const es: JoinWords = {
  invited: "Tienes una invitación",
  invites: (name) => `${name} te invita`,
  android: "Peel te registra con esta invitación y luego abre el trabajo.",
  open: "Abrir en Peel",
  noPeel: "¿Aún no tienes Peel? El botón lo descarga y copia tu invitación. Instala Peel y ábrelo: encuentra la invitación y te registra.",
  again: "¿Abriste Peel sin la invitación? Toca aquí",
  elsewhere: "Abre este enlace en un teléfono Android: escanea el código con su cámara.",
  qr: "Un código QR del enlace de esta invitación",
  peelAndroid: "Te registras con Peel, que funciona en Android.",
  bad: "Este enlace no tiene ninguna invitación. Pídele uno nuevo a quien te lo envió.",
};
const JOIN_WORDS = { en, es };
export type JoinLang = keyof typeof JOIN_WORDS;

/** The page's language: the link's `?lang=` when it has one, else the
 *  browser's first choice in `Accept-Language` (its `navigator.language`);
 *  English when that is not one the page speaks. `es-MX` → `es`. */
export function joinLang(lang?: string | null, acceptLanguage?: string | null): JoinLang {
  const tag = lang?.trim() || acceptLanguage?.split(",")[0]?.split(";")[0] || "";
  const l = tag.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return Object.hasOwn(JOIN_WORDS, l) ? (l as JoinLang) : "en";
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
<main>
<h1>${heading}</h1>
<section id="android" hidden>
<p>${w.android}</p>
<a id="open" class="button" href="#">${w.open}</a>
<p class="muted">${w.noPeel}</p>
<a id="again" class="button secondary" href="#">${w.again}</a>
</section>
<section id="elsewhere" hidden>
<p>${w.elsewhere}</p>
<div id="qr" role="img" aria-label="${w.qr}"></div>
<p class="muted">${w.peelAndroid}</p>
</section>
<section id="bad" hidden>
<p>${w.bad}</p>
</section>
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
 *  Its language follows `Accept-Language`, so a cache keys on it. */
export const JOIN_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-cache",
  vary: "accept-language",
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
