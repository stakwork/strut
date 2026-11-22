// ── The Peel look, opt-in per app ──────────────────────────────────────────
// An app whose app.yaml says `theme: peel` draws itself in Peel's palette
// (kit/src/styles/base.css "The Peel theme"). The host draws what is around
// it — the loading screen, the account widget, its sheets — to match, so a
// worker moving between Peel and the page sees one look. The page's own
// listing says which apps (`theme`), but the loading screen is on screen
// BEFORE anything is read, so strut's own two are named here too. Pure.

export const PEEL_APPS: ReadonlySet<string> = new Set(["strut/worker", "strut/staff"]);

/** Whether the host draws `app` in Peel's look: the app's own `theme`, once
 *  read, or one of strut's own that is known before. */
export function isPeelApp(name: string, theme?: string | undefined): boolean {
  return theme === "peel" || PEEL_APPS.has(name);
}

/** The theme to hand a Peel app: the one the address named (`&theme=`), else
 *  the browser's own (prefers-color-scheme), dark when it cannot tell. A
 *  non-Peel app gets the explicit one or none (the host's default). */
export function peelTheme(
  explicit: "light" | "dark" | undefined,
  peel: boolean,
  prefersLight: () => boolean = () => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches,
): "light" | "dark" | undefined {
  if (explicit) return explicit;
  return peel ? (prefersLight() ? "light" : "dark") : undefined;
}
