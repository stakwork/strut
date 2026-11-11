// Keyboard and touch, read by the frame loop — nothing here re-renders.
// Arrow keys or WASD move and Space jumps. On a touch screen, drag anywhere
// to steer (an invisible joystick) and tap to jump. The page only hears keys
// while its frame has focus: a click or tap gives it focus, so a round starts
// from a button.

const held = new Set<string>();
let jump = false;
const drag = { id: -1, x0: 0, y0: 0, dx: 0, dy: 0, t0: 0 };

/** A key's code → the direction it pushes: x to the right, z toward the viewer. */
const MOVE: Record<string, [number, number]> = {
  ArrowUp: [0, -1], KeyW: [0, -1],
  ArrowDown: [0, 1], KeyS: [0, 1],
  ArrowLeft: [-1, 0], KeyA: [-1, 0],
  ArrowRight: [1, 0], KeyD: [1, 0],
};
/** How far a finger drags for full speed, in CSS pixels. */
const STICK = 60;

/** Start listening; returns the function that stops. `surface` is the
 *  element touches start on (the game's container). */
export function listen(surface: HTMLElement): () => void {
  const keydown = (e: KeyboardEvent) => {
    if (e.code in MOVE || e.code === "Space") e.preventDefault();
    if (e.code === "Space" && !e.repeat) jump = true;
    held.add(e.code);
  };
  const keyup = (e: KeyboardEvent) => void held.delete(e.code);
  const blur = () => held.clear();
  const down = (e: PointerEvent) => {
    if (e.pointerType === "mouse" || drag.id !== -1) return;
    Object.assign(drag, { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, t0: performance.now() });
  };
  const move = (e: PointerEvent) => {
    if (e.pointerId !== drag.id) return;
    drag.dx = e.clientX - drag.x0;
    drag.dy = e.clientY - drag.y0;
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId !== drag.id) return;
    if (performance.now() - drag.t0 < 250 && Math.hypot(drag.dx, drag.dy) < 12) jump = true;
    Object.assign(drag, { id: -1, dx: 0, dy: 0 });
  };
  window.addEventListener("keydown", keydown);
  window.addEventListener("keyup", keyup);
  window.addEventListener("blur", blur);
  surface.addEventListener("pointerdown", down);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
  return () => {
    window.removeEventListener("keydown", keydown);
    window.removeEventListener("keyup", keyup);
    window.removeEventListener("blur", blur);
    surface.removeEventListener("pointerdown", down);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
  };
}

/** Where the player wants to go: x to the right, z toward the viewer, length at most 1. */
export function direction(): { x: number; z: number } {
  let x = 0;
  let z = 0;
  for (const code of held) {
    const m = MOVE[code];
    if (m) {
      x += m[0];
      z += m[1];
    }
  }
  if (drag.id !== -1) {
    x += drag.dx / STICK;
    z += drag.dy / STICK;
  }
  const length = Math.hypot(x, z);
  return length > 1 ? { x: x / length, z: z / length } : { x, z };
}

/** True once per press of Space or tap, then false until the next. */
export function takeJump(): boolean {
  const j = jump;
  jump = false;
  return j;
}
