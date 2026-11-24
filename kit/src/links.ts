/** Links to an app (plans/apps.md §7.1). A deep link names the app and what
 *  it is opened with: `?app=<name>&input=<the input as a query string>`.
 *  The host follows it — in place when the page opens it (`ui/open-link`),
 *  its address bar when a person does — and hands `input` back to the page
 *  as `ui/notifications/tool-input`, as flat strings, so `useToolInput()`
 *  reads `{ view: "/runs", run: "12" }` whichever way the app was opened.
 *  What the keys mean is the app's: a host copies the value, never reads
 *  it. */

/** What a link may carry: flat values, sent back as strings; a `null` or
 *  `undefined` one is left out. */
export type AppLinkInput = Record<string, string | number | boolean | null | undefined>;

/** How a link to ANOTHER app opens. By default strut's UI shows it in a
 *  side panel beside this page, which stays on screen; `"page"` makes it
 *  the page in place of this one (`&open=page`), and a host that frames
 *  the page shows it as its own page. */
export type AppLinkOptions = { open?: "page" };

/** The link to app `name` opened with `input`, relative to the host's page
 *  (`?app=bench&input=view%3D%252Fruns`): `useHost().openLink(link)` opens it
 *  in place. Without `input`, a plain open. `{ open: "page" }`: as the page,
 *  not beside it (`AppLinkOptions`). */
export function appLink(name: string, input?: AppLinkInput, options?: AppLinkOptions): string {
  const q = new URLSearchParams({ app: name });
  const args = new URLSearchParams();
  for (const [k, v] of Object.entries(input ?? {})) if (v != null) args.set(k, String(v));
  const inner = args.toString();
  if (inner) q.set("input", inner);
  if (options?.open === "page") q.set("open", "page");
  return `?${q}`;
}

/** The host context key a host puts its PAGE's address under: where a
 *  person opens this app on that host (Stadeum's `https://box/`, strut's own
 *  `https://strut/?app=<name>`), without the app's `input`. A host with no
 *  address to give (a native app's web view) leaves it out. Strut's UI puts
 *  a framing host's page here only on the origin of a host that signed the
 *  person in (strut `specs/API.md` §14.3), so an app may take it as it is. */
export const PAGE_CONTEXT = "strut/page";

/** The address a person can paste to open the app at `input`: the host's
 *  `page` with `input` as its one query param, in place of any it had.
 *  Without `input`, the page itself. */
export function shareLink(page: string, input?: AppLinkInput): string {
  const url = new URL(page);
  const args = new URLSearchParams();
  for (const [k, v] of Object.entries(input ?? {})) if (v != null) args.set(k, String(v));
  const inner = args.toString();
  if (inner) url.searchParams.set("input", inner);
  else url.searchParams.delete("input");
  return url.href;
}

/** A host's page address out of its context: an http(s) URL, else none. */
export function pageOf(context: Record<string, unknown> | undefined): string | undefined {
  const page = context?.[PAGE_CONTEXT];
  if (typeof page !== "string") return undefined;
  try {
    const url = new URL(page);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}
