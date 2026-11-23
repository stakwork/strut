// An image to look at closely (Hive's ImagePanel): it fits its box at
// first; − and + zoom in steps from 25% to 400% of its own pixels, Fit goes
// back, and a double-click switches between 100% and fit. Its size in
// pixels shows beside the controls, so a screenshot reads as what it is.
import { useState } from "react";
import { Minus, Plus, Scan } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { zoomStep } from "../lib/zoom";

export interface ZoomImageProps {
  src: string;
  alt: string;
  className?: string;
}

export function ZoomImage({ src, alt, className }: ZoomImageProps) {
  /** null: fit the box; else a share of the image's own pixels. */
  const [zoom, setZoom] = useState<number | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  return (
    <div className={cn("flex flex-col gap-1", className)} data-testid="zoom-image">
      <div className="max-h-[70vh] overflow-auto rounded-md border bg-muted/30">
        <img
          src={src}
          alt={alt}
          onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onDoubleClick={() => setZoom((z) => (z === null ? 1 : null))}
          style={zoom !== null && size ? { width: Math.round(size.w * zoom), maxWidth: "none" } : undefined}
          className={cn("block", zoom === null ? "mx-auto max-h-[70vh] max-w-full object-contain" : "cursor-zoom-out")}
        />
      </div>
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <Button variant="ghost" size="icon" className="size-6" aria-label="Zoom out" disabled={zoom !== null && zoom <= 0.25} onClick={() => setZoom((z) => zoomStep(z, -1))}>
          <Minus />
        </Button>
        <span className="w-10 text-center tabular-nums">{zoom === null ? "Fit" : `${Math.round(zoom * 100)}%`}</span>
        <Button variant="ghost" size="icon" className="size-6" aria-label="Zoom in" disabled={zoom !== null && zoom >= 4} onClick={() => setZoom((z) => zoomStep(z, 1))}>
          <Plus />
        </Button>
        <Button variant="ghost" size="icon" className="size-6" aria-label="Fit" disabled={zoom === null} onClick={() => setZoom(null)}>
          <Scan />
        </Button>
        {size && <span className="ml-auto tabular-nums">{size.w} × {size.h}</span>}
      </div>
    </div>
  );
}
