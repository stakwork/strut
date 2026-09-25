import { useLayoutEffect } from "preact/hooks";
import { load, remove, save } from "../storage";

// Drag handle between two sidebar sections. Each section's share of the
// sidebar is a flex-grow weight (`--grow`, keyed by `data-section`). Weights
// are normalised so the mean expanded section is 1 — a section that has never
// been sized (or is re-expanded later) falls back to an even share.

const MIN_HEIGHT = 64; // title row + a couple of list items
const STORAGE_KEY = "sidebarSizes";

function sections(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".sidebar-section[data-section]")];
}

function applyGrow(el: HTMLElement, grow: number) {
  el.style.setProperty("--grow", grow.toFixed(4));
}

// Flex hands out only the space left after each section's padding + border,
// so weights are proportional to the height inside that frame.
function innerHeight(el: HTMLElement): number {
  const cs = getComputedStyle(el);
  const frame = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
    + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  return el.getBoundingClientRect().height - frame;
}

// Restore persisted weights once, on first mount (before paint)
let restored = false;
function restoreOnce() {
  if (restored) return;
  restored = true;
  const sizes = load<Record<string, number>>(STORAGE_KEY, {});
  for (const el of sections()) {
    const g = sizes[el.dataset.section!];
    if (typeof g === "number" && g > 0) applyGrow(el, g);
  }
}

function onPointerDown(e: PointerEvent) {
  e.preventDefault();
  const handle = e.currentTarget as HTMLElement;
  const above = handle.previousElementSibling as HTMLElement;
  const below = handle.nextElementSibling as HTMLElement;

  // Snapshot every expanded section's current height as its weight, so the
  // layout doesn't jump when the drag starts.
  const open = sections().filter((el) => !el.classList.contains("is-collapsed"));
  const heights = new Map(open.map((el) => [el, innerHeight(el)]));
  const avg = [...heights.values()].reduce((a, b) => a + b, 0) / open.length;
  for (const [el, h] of heights) applyGrow(el, h / avg);

  const startY = e.clientY;
  const startAbove = heights.get(above)!;
  const pair = startAbove + heights.get(below)!;
  handle.classList.add("is-dragging");
  document.body.classList.add("is-resizing-rows");

  const onMove = (ev: PointerEvent) => {
    const next = Math.min(pair - MIN_HEIGHT, Math.max(MIN_HEIGHT, startAbove + ev.clientY - startY));
    applyGrow(above, next / avg);
    applyGrow(below, (pair - next) / avg);
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    handle.classList.remove("is-dragging");
    document.body.classList.remove("is-resizing-rows");
    const sizes = load<Record<string, number>>(STORAGE_KEY, {});
    for (const el of open) sizes[el.dataset.section!] = parseFloat(el.style.getPropertyValue("--grow"));
    save(STORAGE_KEY, sizes);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function onDoubleClick() {
  for (const el of sections()) el.style.removeProperty("--grow");
  remove(STORAGE_KEY);
}

export function SidebarResizer() {
  useLayoutEffect(restoreOnce, []);

  return (
    <div
      class="row-resizer"
      onPointerDown={onPointerDown}
      onDblClick={onDoubleClick}
      title="Drag to resize · double-click to reset"
      role="separator"
      aria-orientation="horizontal"
    />
  );
}
