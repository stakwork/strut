// Where the run graph's names go: beside their node, inside its cell, over
// no other name and no node. Pure — the canvas measures the text and hands
// in the boxes, in the layout's units.

export type LabelAnchor = "start" | "middle" | "end";

export interface LabelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface LabelRequest {
  /** The drawing's key (`placeKey`). */
  key: string;
  cell: string;
  x: number;
  y: number;
  text: string;
  /** Shorter forms of `text`, tried in order where it fits nowhere. */
  variants?: string[];
  /** A second line under the name (a peer's badge). */
  sub?: string;
  /** Higher places first. */
  rank: number;
  /** Drawn even where it collides, at its best position: the hovered node's. */
  forced?: boolean;
  /** Its whole name, listed by a "+N" label when it does not fit. Without one it is just left out. */
  fold?: string;
}

/** Where a name is drawn from its node: its first line's baseline and how it is anchored there, and the form that fit. */
export interface LabelPlacement {
  text: string;
  dx: number;
  dy: number;
  anchor: LabelAnchor;
}

/** Names that did not fit near one another, said as one "+N" label that lists them. */
export interface FoldedLabel extends LabelPlacement {
  key: string;
  cell: string;
  /** The node it is drawn beside. */
  x: number;
  y: number;
  text: string;
  names: string[];
}

export interface LabelInput {
  requests: LabelRequest[];
  /** Every node drawn, by its drawing's key. */
  nodes: ReadonlyArray<{ key: string; x: number; y: number }>;
  /** What a cell's names must stay inside, by cell. A cell without one has no edge. */
  bounds: ReadonlyMap<string, LabelBox>;
  radius: number;
  /** The font size, in the layout's units. */
  font: number;
  /** Clear room kept around a name: its outline and a little air. */
  pad: number;
  /** A text's width at `font`, in the layout's units. */
  width: (text: string) => number;
  /** The forms of a "+N" label for n names, the longest first: the first that fits is drawn. */
  foldText: (n: number) => string[];
}

export interface LabelOutput {
  placed: Map<string, LabelPlacement>;
  folded: FoldedLabel[];
}

const GAP = 4;
/** A line's height, in fonts: a name's second line is drawn this far under its first. */
export const LABEL_LINE = 1.15;
const LINE = LABEL_LINE;
/** How far above and below its baseline a line of text reaches, in fonts. */
const ASCENT = 0.95;
const DESCENT = 0.3;
/** Names that did not fit this close together (in fonts) fold into one label. */
const FOLD_REACH = 8;
/** The most names a "+N" label lists. */
const FOLD_LISTED = 25;
/** How many lines away from its group a "+N" label may go to find room. */
const FOLD_FARTHEST = 12;

/**
 * Places names in rank order, each at the first of eight positions round its
 * node — above (centred, then leaning left, then right), below (the same),
 * right, left — where it stays in its cell and covers no name placed before
 * it and no node. So a name by a cell's right edge leans left. One that fits
 * nowhere is left out; the left-out ones that asked to be listed (`fold`)
 * become one "+N" label per group close together, placed round the group or
 * one of its nodes the same way — and when even that fits nowhere, the
 * group's nearby names last placed give their room back, one at a time, and
 * join its list.
 */
export function placeLabels(input: LabelInput): LabelOutput {
  const { requests, nodes, bounds, radius, font, pad, width, foldText } = input;
  const nodeBoxes = nodes.map((n) => ({ key: n.key, box: { x0: n.x - radius - 1, y0: n.y - radius - 1, x1: n.x + radius + 1, y1: n.y + radius + 1 } }));
  const taken = new Map<string, LabelBox>();
  const placed = new Map<string, LabelPlacement>();
  const folded: FoldedLabel[] = [];
  const dropped: LabelRequest[] = [];
  /** The names placed that a fold may take back, in the order they were placed. */
  const foldable: LabelRequest[] = [];

  const free = (box: LabelBox, cell: string, own: ReadonlySet<string>) => {
    const edge = bounds.get(cell);
    if (edge && (box.x0 < edge.x0 || box.y0 < edge.y0 || box.x1 > edge.x1 || box.y1 > edge.y1)) return false;
    for (const t of taken.values()) if (overlaps(t, box)) return false;
    return !nodeBoxes.some((n) => !own.has(n.key) && overlaps(n.box, box));
  };
  const around = (x: number, y: number, half: number, halfY: number, w: number, lines: number) => spots(x, y, half, halfY, w, lines, font, pad);

  const order = [...requests].sort((a, b) => b.rank - a.rank || Number(!!b.forced) - Number(!!a.forced));
  // The fold comes once every name that may be folded has had its turn, so
  // the "+N" labels go before the names below them in rank.
  let lastFolding = -1;
  order.forEach((r, i) => {
    if (r.fold !== undefined) lastFolding = i;
  });

  const place = (r: LabelRequest) => {
    const lines = r.sub ? 2 : 1;
    const own = new Set([r.key]);
    const sub = r.sub ? width(r.sub) : 0;
    for (const text of [r.text, ...(r.variants ?? [])]) {
      const spot = around(r.x, r.y, radius, radius, Math.max(width(text), sub), lines).find((s) => free(s.box, r.cell, own));
      if (!spot) continue;
      taken.set(r.key, spot.box);
      placed.set(r.key, { text, dx: spot.dx, dy: spot.dy, anchor: spot.anchor });
      if (r.fold !== undefined && !r.forced) foldable.push(r);
      return;
    }
    if (r.forced) {
      const spotsHere = around(r.x, r.y, radius, radius, Math.max(width(r.text), sub), lines);
      const spot = spotsHere.find((s) => inside(s.box, bounds.get(r.cell))) ?? spotsHere[0]!;
      taken.set(r.key, spot.box);
      placed.set(r.key, { text: r.text, dx: spot.dx, dy: spot.dy, anchor: spot.anchor });
      return;
    }
    if (r.fold !== undefined) dropped.push(r);
  };

  /** The "+N" label's spot for a group: round the group's box, else beside the member nearest its middle. */
  const foldSpot = (group: LabelRequest[], w: number) => {
    // Its group's nodes are obstacles like any other: it is said beside them, never over one.
    const own = new Set<string>();
    const x0 = Math.min(...group.map((r) => r.x));
    const x1 = Math.max(...group.map((r) => r.x));
    const y0 = Math.min(...group.map((r) => r.y));
    const y1 = Math.max(...group.map((r) => r.y));
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const cell = group[0]!.cell;
    if (group.length > 1) {
      const spot = around(cx, cy, (x1 - x0) / 2 + radius, (y1 - y0) / 2 + radius, w, 1).find((s) => free(s.box, cell, own));
      if (spot) return { x: cx, y: cy, spot };
    }
    const byMiddle = [...group].sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
    for (const at of byMiddle) {
      const spot = around(at.x, at.y, radius, radius, w, 1).find((s) => free(s.box, cell, own));
      if (spot) return { x: at.x, y: at.y, spot };
    }
    // Packed in among other nodes: further from the group, a line at a time,
    // below it then above, shifted sideways to stay in the cell.
    const edge = bounds.get(cell);
    const step = LINE * font;
    for (let i = 1; i <= FOLD_FARTHEST; i++) {
      for (const dir of [1, -1]) {
        const dy = dir > 0 ? (y1 - cy) + radius + GAP + pad + ASCENT * font + (i - 1) * step : -(cy - y0) - radius - GAP - pad - DESCENT * font - (i - 1) * step;
        let dx = 0;
        if (edge) dx = Math.min(Math.max(dx, edge.x0 + pad + w / 2 - cx), edge.x1 - pad - w / 2 - cx);
        const box = { x0: cx + dx - w / 2 - pad, y0: cy + dy - ASCENT * font - pad, x1: cx + dx + w / 2 + pad, y1: cy + dy + DESCENT * font + pad };
        if (free(box, cell, own)) return { x: cx, y: cy, spot: { dx, dy, anchor: "middle" as const, box } };
      }
    }
    return null;
  };

  const fold = () => {
    const reach = FOLD_REACH * font;
    for (const group of groups(dropped, reach)) {
      for (;;) {
        let text = "";
        let found: ReturnType<typeof foldSpot> = null;
        for (const form of foldText(group.length)) {
          found = foldSpot(group, width(form));
          text = form;
          if (found) break;
        }
        if (found) {
          taken.set(`fold:${group[0]!.key}`, found.spot.box);
          const names = group.map((r) => r.fold!);
          folded.push({
            key: `fold:${group[0]!.key}`,
            cell: group[0]!.cell,
            x: found.x,
            y: found.y,
            dx: found.spot.dx,
            dy: found.spot.dy,
            anchor: found.spot.anchor,
            text,
            names: names.length > FOLD_LISTED ? [...names.slice(0, FOLD_LISTED), `… and ${names.length - FOLD_LISTED} more`] : names,
          });
          break;
        }
        // No room: the nearby name placed last gives its room back and is listed instead.
        let near = foldable.length - 1;
        while (near >= 0) {
          const r = foldable[near]!;
          if (r.cell === group[0]!.cell && group.some((g) => Math.hypot(g.x - r.x, g.y - r.y) <= reach)) break;
          near--;
        }
        if (near < 0) break;
        const [back] = foldable.splice(near, 1);
        placed.delete(back!.key);
        taken.delete(back!.key);
        group.push(back!);
      }
    }
  };

  order.forEach((r, i) => {
    place(r);
    if (i === lastFolding) fold();
  });
  return { placed, folded };
}

function overlaps(a: LabelBox, b: LabelBox): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

function inside(box: LabelBox, edge: LabelBox | undefined): boolean {
  return !edge || (box.x0 >= edge.x0 && box.y0 >= edge.y0 && box.x1 <= edge.x1 && box.y1 <= edge.y1);
}

/** The eight positions round a node (or a group's box, `half` × `halfY` either side of its middle), in the order they are tried. */
function spots(x: number, y: number, half: number, halfY: number, w: number, lines: number, font: number, pad: number) {
  const tall = (lines - 1) * LINE * font;
  // The gap is kept outside the name's padding, so a name never touches its own node.
  const gap = GAP + pad;
  const above = -halfY - gap - DESCENT * font - tall;
  const below = halfY + gap + ASCENT * font;
  const side = (ASCENT - (ASCENT + DESCENT) / 2) * font - tall / 2;
  const span = (dx: number, anchor: LabelAnchor): [number, number] =>
    anchor === "middle" ? [dx - w / 2, dx + w / 2] : anchor === "start" ? [dx, dx + w] : [dx - w, dx];
  const at = (dx: number, dy: number, anchor: LabelAnchor) => {
    const [l, r] = span(dx, anchor);
    return {
      dx,
      dy,
      anchor,
      box: { x0: x + l - pad, y0: y + dy - ASCENT * font - pad, x1: x + r + pad, y1: y + dy + tall + DESCENT * font + pad },
    };
  };
  return [
    at(0, above, "middle"),
    at(half, above, "end"),
    at(-half, above, "start"),
    at(0, below, "middle"),
    at(half, below, "end"),
    at(-half, below, "start"),
    at(half + gap, side, "start"),
    at(-half - gap, side, "end"),
  ];
}

/** The requests of each cell in groups: one within `reach` of another is in its group. */
function groups(requests: LabelRequest[], reach: number): LabelRequest[][] {
  const out: LabelRequest[][] = [];
  const byCell = new Map<string, LabelRequest[]>();
  for (const r of requests) byCell.set(r.cell, [...(byCell.get(r.cell) ?? []), r]);
  for (const cell of byCell.values()) {
    const left = [...cell];
    while (left.length) {
      const group = [left.shift()!];
      for (let i = 0; i < group.length; i++) {
        for (let j = left.length - 1; j >= 0; j--) {
          if (Math.hypot(left[j]!.x - group[i]!.x, left[j]!.y - group[i]!.y) <= reach) group.push(...left.splice(j, 1));
        }
      }
      out.push(group);
    }
  }
  return out;
}
