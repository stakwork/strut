/**
 * The page a worker invite's SHORT link answers (`GET /public/i/<code>`,
 * src/public-routes.ts): the link preview chat apps draw for it (WhatsApp,
 * iMessage, Telegram read Open Graph / Twitter card tags and run no script),
 * which sends a browser on to the full join link with its `#…` kept. The page
 * holds nothing the link does not: the copy below, the server's name and the
 * Peel icon. Chat apps cache a preview, so a change to the copy or the icon
 * shows on links sent after it.
 */

/** One language of the preview. `title`, `description` and `continue` are the page's words; `locale` is og:locale; `share` is the message a share button sends before the link. */
export interface InviteLanguage {
  code: string;
  label: string;
  locale: string;
  title: string;
  description: string;
  continue: string;
  share: string;
}

/** The languages an invite may be sent in, and what each says: the one place to edit the copy, and a language is one more entry. The first is the default. */
export const INVITE_LANGUAGES: InviteLanguage[] = [
  {
    code: "en",
    label: "English",
    locale: "en_US",
    title: "Complete Tasks, Earn Bitcoin",
    description: "You're invited to Peel. Do simple tasks on your phone and get paid in bitcoin.",
    continue: "Continue",
    share: "You're invited to work with us. Open this on your phone to sign up with Peel:",
  },
  {
    code: "es",
    label: "Español",
    locale: "es_ES",
    title: "Completa tareas, gana Bitcoin",
    description: "Te invitaron a Peel. Haz tareas sencillas en tu teléfono y recibe pagos en bitcoin.",
    continue: "Continuar",
    share: "Te invitamos a trabajar con nosotros. Ábrelo en tu teléfono para registrarte en Peel:",
  },
];

/** A language by its code; an unknown or missing one is the default (English). */
export function inviteLanguage(code?: string | undefined): InviteLanguage {
  return INVITE_LANGUAGES.find((l) => l.code === code) ?? INVITE_LANGUAGES[0]!;
}

/** Peel's icon (stakwork/peel-android, design/peel.svg) as a 512 × 512 PNG: chat apps do not draw an SVG. Served at `/public/join/peel.png`. */
export const PEEL_ICON_PATH = "/public/join/peel.png";
const PEEL_ICON_BASE64 =
  "" +
  "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAMAAADDpiTIAAADAFBMVEVMaXH1p2PbaSHbaCDbaiLxoV/0o17pjUb2pmHbaiLpkE30o1/tl1b1pmPbaSLbaiLc" +
  "aiL1o2DbaiL0pGD2q2r2qmjaaCDbaSLbaiLdbSXaZyDbaiHum1v1pWH1p2XcayP1p2Xcbibzn1rxnVf2qGXyn1vniEL/8+TdbSXcbCTri0LgcyraaCHzoV7c" +
  "ayPkejDhdSzbaiLbaSLngDXmfjPjeS/2qWfynlnzoFv0o1/idi3sj0faZyDqhz30pGLmfzT1pmThdCvdbibogjj1p2XulEzlfTLxm1blfDLwl1HfcSjriUDe" +
  "byfynVjidy32q2nxmVTkezHecCfzoV3jeC7tkEnsjUT0o2DtkkrbaiP1pmLogzjohDr3rGvfcinZZh/ulU/2qWnsjUXxmlTtkEfnfzTngTbgdCrynFjynlve" +
  "byblfDHqiD/0pGDcayTphTvqhj3ukkz1pWLxnFfulE7idy7gcin1qGXaaSH2qGbxmlXaaCDsjkXdbiXngDbhdSvmfjTwmVPZZyD3q2nmfTPwmVLhdizrikHv" +
  "l1DvllDphTzjeC/fcCjkezDFYCDfcSnynljynlrynFfyn1vzn1vzoFzzoF3bayP1pmXbaSH2qmntj0flfTPtkUr3q2vZZx/ebibtkkvlezHvlU/ieC7ecCjG" +
  "YiHIZCPJaCbUgEDKaSfSfj7MbCrSfDvOcjD/8eHIZyXLaij+7t3Tf0DOczL86NT/8uP969jSeTj75M764cr428H11rvRdjTot5HuxaX63sXmsIf0vpPVaSTQ" +
  "ZyP507PQbCjXiVLwzK3sv5voi0XWcizOby30uozztobYjVjdmWf4z6zbcivzsoDTbiryrXb1w5rYayXMZCLjqX7hpHbVhErehkPenm72yqX2xp/acCjlhD3T" +
  "gEfurX3blF7ZkmHy0bXoklXjikbYezjOdjzroGnyqGzefDXpmmDwombYdzHdgDvddzDupG/mhkPjgDvdcyvnjU7qp3bgeTHpjUngdi7skEvifjfiezTifDar" +
  "jVFRAAAAJ3RSTlMAjn7wx/2ABSQdDbX9oJZuqz1aa/Pa24dE5/ox/lTn+vf+0ubMmq+mAtTjAAAACXBIWXMAAAsTAAALEwEAmpwYAAAgAElEQVR42u2deXxU" +
  "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" +
  "RU5ErkJggg==";
export const PEEL_ICON = new Uint8Array(Buffer.from(PEEL_ICON_BASE64, "base64"));

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The headers the page is sent with: never kept, no referrer, and nothing may run or load but its own style. */
export const INVITE_PREVIEW_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'",
};

/** The preview page: `link` the full join link (what it sends on to, by its path), `url` the short link as shared, `base` this server's base (the icon is on it). */
export function invitePreviewPage(o: { link: string; url: string; base: string; siteName?: string | undefined; lang?: string | undefined }): string {
  const words = inviteLanguage(o.lang);
  // On to the join link by its path (origin-relative), so it resolves on the origin the page came from, whatever front sits before this server.
  const to = (() => {
    try {
      const u = new URL(o.link);
      // An invite sent in a language opens the join page in it (its `?lang=`).
      if (o.lang) u.searchParams.set("lang", words.code);
      return `${u.pathname}${u.search}${u.hash}`;
    } catch {
      return o.link;
    }
  })();
  const image = `${o.base.replace(/\/+$/, "")}${PEEL_ICON_PATH}`;
  const { title, description } = words;
  const meta = [
    ["og:type", "website"],
    ["og:locale", words.locale],
    ...(o.siteName ? [["og:site_name", o.siteName]] : []),
    ["og:title", title],
    ["og:description", description],
    ["og:url", o.url],
    ["og:image", image],
    ["og:image:width", "512"],
    ["og:image:height", "512"],
    ["og:image:alt", "Peel"],
  ]
    .map(([p, c]) => `<meta property="${p}" content="${esc(c!)}">`)
    .join("\n");
  return `<!doctype html>
<html lang="${esc(words.code)}">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${esc(description)}">
${meta}
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">
<meta http-equiv="refresh" content="0;url=${esc(to)}">
<meta name="robots" content="noindex">
<style>body{font:16px system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;text-align:center}a{color:#d9661f}</style>
</head>
<body><p><a href="${esc(to)}">${esc(words.continue)}</a></p></body>
</html>
`;
}
