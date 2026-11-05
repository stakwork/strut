// ── A host's sign-in ticket ────────────────────────────────────────────────
// A host that frames the UI for one person (stadeum) mints a ticket with
// the key, `POST /auth/ticket { actor }`, and loads `<strut>/?ticket=…`.
// The page trades it at `POST /auth/session { ticket }` before anything
// else (./api `ticketSignIn`) and takes it off the address bar: it is good
// once, and a URL is copied, logged and read. Pure, so the root test run
// covers it.

export const TICKET_PARAM = "ticket";

/** The ticket `href` carries as `?ticket=`, and the same URL (path, query,
 *  hash) without it — every other param exactly as it was written. Null
 *  when there is none. */
export function takeTicket(href: string): { ticket: string; url: string } | null {
  const url = new URL(href);
  const ticket = url.searchParams.get(TICKET_PARAM);
  if (ticket === null) return null;
  const kept = url.search.slice(1).split("&").filter((part) => part && paramName(part) !== TICKET_PARAM);
  return { ticket, url: url.pathname + (kept.length ? `?${kept.join("&")}` : "") + url.hash };
}

/** A query part's name, decoded as URLSearchParams decodes it. */
function paramName(part: string): string {
  const raw = part.split("=", 1)[0]!.replace(/\+/g, " ");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
