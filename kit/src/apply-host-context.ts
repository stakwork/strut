import type { HostContext } from "./host.js";

const FONTS_STYLE_ID = "strut-host-fonts";

/** Apply what the host sent to the document (plans/apps.md §2.4): the theme
 *  as `data-theme` + `color-scheme` (and the `dark` class, so both of the
 *  stylesheet's conventions hold), the display mode as `data-display-mode`,
 *  the style variables as inline custom properties on `<html>` — where the
 *  base stylesheet's `var(--color-…, fallback)` reads them — and the host's
 *  `@font-face` CSS once. Idempotent; called at initialize and on every
 *  `host-context-changed`. */
export function applyHostContext(ctx: HostContext | undefined, doc: Document = document): void {
  if (!ctx) return;
  const root = doc.documentElement;
  if (ctx.theme) {
    root.setAttribute("data-theme", ctx.theme);
    root.classList.toggle("dark", ctx.theme === "dark");
    root.style.colorScheme = ctx.theme;
  }
  if (ctx.displayMode) root.setAttribute("data-display-mode", ctx.displayMode);
  const vars = ctx.styles?.variables;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      if (!name.startsWith("--")) continue;
      if (value === undefined || value === null || value === "") root.style.removeProperty(name);
      else root.style.setProperty(name, value);
    }
  }
  const fonts = ctx.styles?.css?.fonts;
  if (fonts && !doc.getElementById(FONTS_STYLE_ID)) {
    const style = doc.createElement("style");
    style.id = FONTS_STYLE_ID;
    style.textContent = fonts;
    doc.head.appendChild(style);
  }
}
