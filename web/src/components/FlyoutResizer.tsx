import { useCallback, useEffect, useRef, useState } from "preact/hooks";

// ── A drag handle on a panel's left edge ───────────────────────────────────
//
// Drag left to widen the panel, double-click to reset. The width is a CSS
// custom property on a holder element, which the panel's own CSS reads, and
// is kept in localStorage. `FlyoutResizer` is the flyout's (`--flyout-width`
// on `.shell`); the app host's side panel has its own (`AppWithPanel`).

export interface WidthResizerProps {
  /** The element that holds the width property. */
  holder: () => HTMLElement | null;
  /** The panel the handle sits on (its width is where a drag starts). */
  panel: string;
  /** The custom property, `--…`. */
  property: string;
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  /** The width the panel may take at most: what is left beside it. */
  maxWidth: () => number;
}

function applyWidth(holder: HTMLElement | null, property: string, px: number) {
  holder?.style.setProperty(property, `${px}px`);
}

export function WidthResizer(props: WidthResizerProps) {
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);
  const startWidth = useRef(0);
  const cfg = useRef(props);
  cfg.current = props;

  // The width this browser was left at, on the holder.
  useEffect(() => {
    try {
      const n = parseInt(localStorage.getItem(props.storageKey) ?? "", 10);
      if (!isNaN(n)) applyWidth(props.holder(), props.property, n);
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.storageKey, props.property]);

  const onPointerDown = useCallback((e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const c = cfg.current;
    const panel = (e.currentTarget as HTMLElement).closest(c.panel);
    startX.current = e.clientX;
    startWidth.current = panel ? panel.getBoundingClientRect().width : c.defaultWidth;
    setDragging(true);
    document.body.classList.add("is-resizing-flyout");

    const onMove = (ev: PointerEvent) => {
      const delta = startX.current - ev.clientX; // drag left = wider
      const maxW = Math.max(c.minWidth, c.maxWidth());
      applyWidth(c.holder(), c.property, Math.min(maxW, Math.max(c.minWidth, startWidth.current + delta)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("is-resizing-flyout");
      setDragging(false);
      const holder = c.holder();
      if (holder) {
        const n = parseInt(holder.style.getPropertyValue(c.property).trim(), 10);
        if (!isNaN(n)) {
          try { localStorage.setItem(c.storageKey, n.toString()); } catch { /* ignore */ }
        }
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  const onDoubleClick = useCallback(() => {
    const c = cfg.current;
    applyWidth(c.holder(), c.property, c.defaultWidth);
    try { localStorage.removeItem(c.storageKey); } catch { /* ignore */ }
  }, []);

  return (
    <div
      class={`flyout-resizer ${dragging ? "is-dragging" : ""}`}
      onPointerDown={onPointerDown}
      onDblClick={onDoubleClick}
      title="Drag to resize · double-click to reset"
      role="separator"
      aria-orientation="vertical"
    />
  );
}

const MIN_CANVAS = 360; // keep at least this much room to the left of the flyout

export function FlyoutResizer() {
  return (
    <WidthResizer
      holder={() => document.querySelector<HTMLElement>(".shell")}
      panel=".flyout"
      property="--flyout-width"
      storageKey="strut.flyoutWidth"
      defaultWidth={420}
      minWidth={320}
      maxWidth={() => window.innerWidth - MIN_CANVAS}
    />
  );
}
