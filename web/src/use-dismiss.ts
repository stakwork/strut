import type { RefObject } from "preact";
import { useLayoutEffect } from "preact/hooks";

/** While `open`, close on a pointerdown outside `ref` or on Escape. Capture
 *  phase: the canvas (d3-zoom) stops mousedown from reaching the document. A
 *  layout effect, so the listeners are live the moment the popover renders —
 *  effects wait for a frame, which a hidden pane delays. */
export function useDismiss(ref: RefObject<HTMLElement>, open: boolean, onClose: () => void) {
  useLayoutEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
}
