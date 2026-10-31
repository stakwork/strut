// A view as one HTML file: its markup and the page's stylesheet — an app
// document has one `<style>`, the compiled Tailwind — with the theme as the
// host set it on `<html>`, saved through `<a download>` (both hosts' frames
// allow downloads). Static: what was open stays open, each `title` its
// tooltip. Nothing here but the DOM, so it is tested without a build.

const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** The document for `el`: elements marked `data-snapshot="omit"` (the buttons) left out. */
export function snapshotHtml(el: HTMLElement, title: string, doc: Document = document): string {
  const clone = el.cloneNode(true) as HTMLElement;
  for (const omit of clone.querySelectorAll("[data-snapshot=omit]")) omit.remove();
  const css = [...doc.querySelectorAll("style")].map((s) => s.textContent ?? "").join("\n").replace(/<\/style/gi, "<\\/style");
  const html = doc.documentElement;
  const attrs = ["class", "data-theme", "style"].flatMap((a) => {
    const v = html.getAttribute(a);
    return v ? [` ${a}="${attr(v)}"`] : [];
  });
  return [
    "<!doctype html>",
    `<html lang="en"${attrs.join("")}>`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${attr(title)}</title>`,
    `<style>${css}</style>`,
    "</head>",
    '<body class="bg-background p-6 text-foreground">',
    clone.outerHTML,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** Save `html` as `filename`. */
export function downloadHtml(html: string, filename: string, doc: Document = document): void {
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const a = doc.createElement("a");
  a.href = url;
  a.download = filename;
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A file name from parts: what a file system takes, `-` for the rest. */
export function fileName(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).map((p) => p!.replace(/[^A-Za-z0-9._-]+/g, "-")).join("-") || "snapshot";
}
