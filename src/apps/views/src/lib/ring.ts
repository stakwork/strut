// Where NodeGraph puts the neighbours an opening adds: evenly round the node
// they open from, on a ring that widens until no box sits on another. Past
// what one ring holds they alternate between two, which keeps it tighter.

/** A node box as NodeGraph draws it, with the gap kept between two. */
export const NODE_WIDTH = 168;
export const NODE_HEIGHT = 56;
const GAP = 12;
/** The ring's radius when it holds few, and how far out the second ring is. */
export const RING = 230;
const STAGGER = 90;

type Point = { x: number; y: number };

/** No two boxes at these places share space. */
export function apart(places: readonly Point[]): boolean {
  for (let i = 0; i < places.length; i++) {
    for (let j = i + 1; j < places.length; j++) {
      if (Math.abs(places[i]!.x - places[j]!.x) < NODE_WIDTH + GAP && Math.abs(places[i]!.y - places[j]!.y) < NODE_HEIGHT + GAP) return false;
    }
  }
  return true;
}

/** `count` places round `at`: a whole ring round the first node, else an arc on the side away from `parent`, the node it was opened from. */
export function ringPlaces(count: number, at: Point, parent?: Point): Point[] {
  const spread = parent ? Math.PI : 2 * Math.PI;
  const outward = parent ? Math.atan2(at.y - parent.y, at.x - parent.x) : 0;
  const on = (radius: number, stagger: number) =>
    Array.from({ length: count }, (_, i) => {
      const a = parent ? outward - spread / 2 + ((i + 0.5) / count) * spread : (i / Math.max(1, count)) * spread;
      const r = radius + (i % 2 ? stagger : 0);
      return { x: at.x + Math.cos(a) * r, y: at.y + Math.sin(a) * r };
    });
  const one = on(RING, 0);
  if (apart(one)) return one;
  let places = one;
  for (let radius = RING; radius < RING * 200; radius *= 1.1) {
    places = on(radius, STAGGER);
    if (apart(places)) break;
  }
  return places;
}
