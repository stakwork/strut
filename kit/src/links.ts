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

/** The link to app `name` opened with `input`, relative to the host's page
 *  (`?app=bench&input=view%3D%252Fruns`): `useHost().openLink(link)` opens it
 *  in place. Without `input`, a plain open. */
export function appLink(name: string, input?: AppLinkInput): string {
  const q = new URLSearchParams({ app: name });
  const args = new URLSearchParams();
  for (const [k, v] of Object.entries(input ?? {})) if (v != null) args.set(k, String(v));
  const inner = args.toString();
  if (inner) q.set("input", inner);
  return `?${q}`;
}
