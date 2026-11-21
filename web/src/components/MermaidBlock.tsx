import { useEffect, useState } from "preact/hooks";
import { diagramImage, errorLine, mermaidConfig, type DiagramImage } from "@strut/kit/folds";

// A ```mermaid block of markdown drawn as a diagram (Markdown.tsx): a
// Concept page's map of its systems, or any page's. Mermaid is a chunk of
// its own, loaded the first time a page has one. The UI is dark, so the
// diagram is; it is drawn as an image (`diagramImage`, the kit's, as
// strut/views draws it), so nothing in it runs or reaches the page. Text
// Mermaid cannot read stays the code it is, with what went wrong in a line.

type Mermaid = (typeof import("mermaid"))["default"];

let loading: Promise<Mermaid> | undefined;
const loadMermaid = (): Promise<Mermaid> => (loading ??= import("mermaid").then((m) => m.default));
let drawings = 0;

export function MermaidBlock({ source }: { source: string }) {
  const [drawn, setDrawn] = useState<{ image?: DiagramImage; error?: string } | null>(null);
  const [unreadable, setUnreadable] = useState(false);

  useEffect(() => {
    let live = true;
    setUnreadable(false);
    const id = `mermaid-${++drawings}`;
    loadMermaid()
      .then(async (mermaid) => {
        mermaid.initialize(mermaidConfig("dark"));
        const { svg } = await mermaid.render(id, source);
        const image = diagramImage(svg);
        return image ? { image } : { error: "Mermaid drew nothing." };
      })
      .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }))
      .then((r) => {
        if (live) setDrawn(r);
      });
    return () => {
      live = false;
    };
  }, [source]);

  const error = drawn?.error ?? (unreadable ? "The browser could not draw the diagram Mermaid made." : undefined);
  if (error) {
    return (
      <div class="md-diagram-failed">
        <div class="md-diagram-note" title={error}>Diagram not drawn: {errorLine(error)}</div>
        <pre class="md-code-block" data-lang="mermaid">
          <code>{source}</code>
        </pre>
      </div>
    );
  }
  if (!drawn?.image) return <div class="md-diagram md-diagram-loading">Drawing the diagram…</div>;
  return (
    <figure class="md-diagram">
      <img src={drawn.image.src} width={drawn.image.width} height={drawn.image.height} alt="Diagram" onError={() => setUnreadable(true)} />
    </figure>
  );
}
