import * as React from "react"

export type DocumentTheme = "light" | "dark"

/** The document's theme: `data-theme="dark"` (what the MCP Apps bridge sets)
 *  or a `dark` class on `<html>` (a host's own page). */
export function readDocumentTheme(): DocumentTheme {
  if (typeof document === "undefined") return "light"
  const el = document.documentElement
  return el.getAttribute("data-theme") === "dark" || el.classList.contains("dark") ? "dark" : "light"
}

/** The document theme, re-read when `<html>`'s class or data-theme changes. */
export function useTheme(): DocumentTheme {
  const [theme, setTheme] = React.useState<DocumentTheme>(readDocumentTheme)
  React.useEffect(() => {
    const update = () => setTheme(readDocumentTheme())
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] })
    update()
    return () => observer.disconnect()
  }, [])
  return theme
}
