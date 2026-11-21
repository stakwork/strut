/// <reference path="../mermaid-tiny.d.ts" />
// A ```mermaid block as a diagram. Mermaid (the kit's `@mermaid-js/tiny`,
// 2.85 MB) is in the document of an app that draws this and of no other:
// strut/views is tree-shaken, and DocumentView only draws a diagram inside
// MermaidDiagrams. The app build inlines the `import()` below, and esbuild
// runs an inlined module only when its import runs, so a page with no
// diagram pays the parse and nothing more.
import { useEffect, useId, useState, type ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { diagramImage, errorLine, mermaidConfig, type DiagramImage } from "@strut/kit";
import { useTheme } from "@/hooks/use-theme";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { DiagramContext } from "./DocumentView";

type Mermaid = (typeof import("@mermaid-js/tiny"))["default"];

let loading: Promise<Mermaid> | undefined;
const loadMermaid = (): Promise<Mermaid> => (loading ??= import("@mermaid-js/tiny").then((m) => m.default));

export interface MermaidDiagramProps {
  /** The diagram's Mermaid text: a ```mermaid block's. */
  source: string;
  className?: string;
}

/**
 * Mermaid text drawn as a diagram, in the page's light or dark (redrawn when
 * it changes), as an image: nothing in it runs, nothing of it reaches the
 * page. Text Mermaid cannot read stays the code it is, with what went wrong
 * in a line (all of it on hover) — never a blank.
 */
export function MermaidDiagram({ source, className }: MermaidDiagramProps) {
  const theme = useTheme();
  const id = `mermaid-${useId().replace(/[^\w-]/g, "")}`;
  const key = `${theme}\u0000${source}`;
  const [drawn, setDrawn] = useState<{ key: string; image?: DiagramImage; error?: string } | null>(null);
  /** The image the browser could not draw (an SVG that is not XML). */
  const [unreadable, setUnreadable] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadMermaid()
      .then(async (mermaid) => {
        mermaid.initialize(mermaidConfig(theme));
        const { svg } = await mermaid.render(id, source);
        const image = diagramImage(svg);
        return image ? { image } : { error: "Mermaid drew nothing." };
      })
      .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }))
      .then((r) => live && setDrawn({ key, ...r }));
    return () => {
      live = false;
    };
  }, [key]);

  const error = drawn?.error ?? (drawn?.image && unreadable === drawn.image.src ? "The browser could not draw the diagram Mermaid made." : undefined);
  if (error) {
    return (
      <div className={cn("my-2", className)} data-testid="mermaid-error">
        <p className="flex items-center gap-1.5 text-xs text-destructive" title={error}>
          <AlertCircle className="size-3.5 shrink-0" />
          Diagram not drawn: {errorLine(error)}
        </p>
        <pre>
          <code className="language-mermaid">{source}</code>
        </pre>
      </div>
    );
  }
  // A redraw for a new theme keeps the last picture until the next is ready.
  if (!drawn?.image) return <Skeleton className={cn("my-2 h-32 w-full", className)} data-testid="mermaid-loading" />;
  return (
    <figure className={cn("my-3 overflow-x-auto", className)} data-testid="mermaid-diagram">
      <img
        src={drawn.image.src}
        width={drawn.image.width}
        height={drawn.image.height}
        alt="Diagram"
        className="mx-auto h-auto max-w-full"
        onError={() => setUnreadable(drawn.image!.src)}
      />
    </figure>
  );
}

/** Inside, every DocumentView draws a ```mermaid block as a diagram
 *  (MermaidDiagram); outside, the block is code. */
export function MermaidDiagrams({ children }: { children: ReactNode }) {
  return <DiagramContext.Provider value={MermaidDiagram}>{children}</DiagramContext.Provider>;
}
