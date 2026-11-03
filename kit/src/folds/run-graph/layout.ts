/**
 * Where the viewer draws a run's nodes: by the stages of the run that
 * touched them. Pure, and the same for the same input.
 *
 * A stage is a step directly under the run. Stages are lanes, left to right
 * in the order the run reached them; a stage that loops has one cell per
 * iteration. A cell draws every node its own calls touched — a node two
 * stages read is drawn in both — and, above each of them, its lineage: the
 * nodes it descends from along `PARENT_OF`, up to the root of its tree,
 * whether or not the run touched those. A run a call launched (an
 * `explore` from a job's turn) is a lane of its own, wherever in the run the
 * launch was, named for its workflow. A tree is drawn as rings around its
 * root, one ring per level; anything else in the cell settles by the links
 * among it. A cell depends on nothing outside itself, so a finished cell
 * stays as it was while the run goes on.
 *
 * A run can touch thousands of nodes, and a ring of two thousand siblings
 * is tens of thousands of pixels round (hive's force layout once sprawled to
 * ~6,500 px and its fit clamped at 0.1). With `fold`, a cell keeps a
 * parent's `cap` most-touched children and folds the rest into one "+N"
 * node under it; loose nodes past `cap` of one type fold the same way. What
 * folds depends on the run alone — never on a highlight, a selection or the
 * replay's step — so the drawing holds still under all three.
 */

import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3";
import { ancestorsOf } from "./lineage.js";
import { callLabel } from "./replay.js";
import type { RunGraphCall } from "./types.js";

export interface RunGraphBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RunGraphCell extends RunGraphBox {
  /** The loop iteration; null for a stage that does not loop. */
  iteration: number | null;
  /** The cell's segment of the run's paths (`ingest#3`): the branch of the run it is. */
  path: string;
  /** Nodes drawn in the cell. */
  nodes: number;
}

export interface RunGraphLane extends RunGraphBox {
  /** The lane's key: its stage, or the launch's path for a launched run's lane. */
  key: string;
  /** What the lane is called: the stage, or the launched run's workflow. */
  stage: string;
  /** The stage's segment of the run's paths (`003-produce`): the branch of the run it is. Null when it loops: its cells are the branches. */
  path: string | null;
  calls: number;
  /** Nodes drawn in the lane, over its cells. */
  nodes: number;
  cells: RunGraphCell[];
  /** Its iterations drawn in one box, one at a time (`stack`): every cell has the same box. */
  stacked?: true;
}

export interface RunGraphStack {
  /** A loop with more iterations than this draws them in one box, one at a time. */
  after: number;
  /** Lanes (by key) drawn with every iteration side by side all the same. */
  open?: ReadonlySet<string>;
}

export interface RunGraphPoint {
  x: number;
  y: number;
}

/** One drawing of a node: a node is drawn once in each cell whose calls touched it. */
export interface RunGraphPlace extends RunGraphPoint {
  id: string;
  cell: string;
  /** Index of the first call that puts it in the picture: one of the cell's touching it, or a node under it. */
  since: number;
}

/** Nodes of one cell folded into one "+N" node (`fold`): drawn where it is placed, its members hidden. */
export interface RunGraphCluster {
  /** Its id among the cell's nodes: `+<cell>|parent:<ref_id>` or `+<cell>|type:<node type>`. */
  id: string;
  cell: string;
  /** The node its members hang from along PARENT_OF; null for loose nodes folded by type. */
  parent: string | null;
  /** The members' type, for a fold by type. */
  type: string | null;
  /** The members, most touched first, each with the call that first put it in the picture. */
  members: Array<{ id: string; since: number }>;
}

export interface RunGraphFold {
  /** The most children of one parent, or loose nodes of one type, a cell draws before folding the rest. */
  cap: number;
  /** The most a cell draws over all its parents and types (default 4 × `cap`): many parents keep fewer each, never under 3. */
  budget?: number;
  /** Each node's type, for folding loose nodes by type. */
  typeOf: ReadonlyMap<string, string>;
  /** The least arc between two neighbours on a ring (default 80, room for a name): a folded drawing names few nodes, so it can be tighter. */
  arc?: number;
}

export interface RunGraphLayout {
  width: number;
  height: number;
  /** Every drawing of a node, keyed by `placeKey`. */
  places: Map<string, RunGraphPlace>;
  lanes: RunGraphLane[];
  /** The cell each call is in, by its index. */
  callCells: string[];
  /** The "+N" nodes `fold` made, by id. */
  clusters: Map<string, RunGraphCluster>;
}

/** Radius a node is drawn with. */
export const RUN_GRAPH_NODE_RADIUS = 12;

const LINK_DISTANCE = 64;
const CHARGE = -160;
const COLLIDE_RADIUS = 28;
const GRAVITY = 0.12;
const TICKS = 200;

/** The least arc two neighbours on a ring are apart: room for a node and most of its name. */
const MIN_ARC = 80;
/** The widest fan a node's children spread over — the root's spread all the way round. */
const MAX_FAN = (2 * Math.PI) / 3;

const CELL_PAD = 32;
const CELL_HEADER = 28;
const CELL_GAP = 16;
/** Between the separate parts of one cell: a tree, a cluster, the loose nodes. */
const PART_GAP = 48;
const LANE_PAD = 20;
const LANE_HEADER = 56;
const LANE_GAP = 48;
const LANE_MIN_WIDTH = 240;

const ITERATION_RE = /^(.*)#(\d+)$/;

/** `run/002-ingest#3/ingest/005-graph_get` → stage `ingest`, iteration 3. */
export function stageOf(path: string): { stage: string; iteration: number | null } {
  const segment = callLabel(path.split("/")[1] ?? path);
  const match = ITERATION_RE.exec(segment);
  return match ? { stage: match[1], iteration: Number(match[2]) } : { stage: segment, iteration: null };
}

/** The key of a stage's cell: `ingest#3`, `seed#`. */
export function cellKey(stage: string, iteration: number | null): string {
  return `${stage}#${iteration ?? ""}`;
}

/** The cell a call is in. */
export function cellOf(path: string): string {
  const { stage, iteration } = stageOf(path);
  return cellKey(stage, iteration);
}

export function placeKey(cell: string, id: string): string {
  return `${cell}|${id}`;
}

type Link = { source: string; target: string };

/** Nodes placed together, the origin at their top left. */
interface Part {
  width: number;
  height: number;
  points: Map<string, RunGraphPoint>;
}

/** The points moved so the least of them is at the origin, and the box they fill. */
function boxed(points: Map<string, RunGraphPoint>): Part {
  const xs = [...points.values()].map((p) => p.x);
  const ys = [...points.values()].map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const moved = new Map<string, RunGraphPoint>();
  for (const [id, p] of points) moved.set(id, { x: p.x - minX, y: p.y - minY });
  return { width: Math.max(...xs) - minX, height: Math.max(...ys) - minY, points: moved };
}

interface Settling extends SimulationNodeDatum {
  id: string;
}

/** The nodes settled by the links among them; a pinned node stays where it is put. */
function settle(ids: string[], links: Link[], pinned: ReadonlyMap<string, RunGraphPoint>): Part {
  const nodes: Settling[] = ids.map((id) => {
    const pin = pinned.get(id);
    return pin ? { id, x: pin.x, y: pin.y, fx: pin.x, fy: pin.y } : { id };
  });
  forceSimulation(nodes)
    .force(
      "link",
      forceLink<Settling, Link>(links.map((l) => ({ ...l })))
        .id((d) => d.id)
        .distance(LINK_DISTANCE),
    )
    .force("charge", forceManyBody().strength(CHARGE))
    .force("collide", forceCollide(COLLIDE_RADIUS))
    .force("x", forceX(0).strength(GRAVITY))
    .force("y", forceY(0).strength(GRAVITY))
    .stop()
    .tick(TICKS);
  return boxed(new Map(nodes.map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }])));
}

/**
 * A tree as rings around its root: each level one ring out, each subtree
 * within the slice of the circle its leaves earn. Below the root a node's
 * children fan out over no more than `MAX_FAN`, centred on it, so a chain
 * of single children stays on one side. The rings are far enough apart
 * that no two neighbours on one come closer than `MIN_ARC`.
 */
function radialTree(root: string, children: ReadonlyMap<string, string[]>, arc = MIN_ARC): Map<string, RunGraphPoint> {
  const leaves = new Map<string, number>();
  const countLeaves = (id: string): number => {
    const known = leaves.get(id);
    if (known !== undefined) return known;
    const kids = children.get(id) ?? [];
    const count = kids.length === 0 ? 1 : kids.reduce((sum, kid) => sum + countLeaves(kid), 0);
    leaves.set(id, count);
    return count;
  };
  countLeaves(root);

  const angle = new Map<string, number>();
  const depth = new Map<string, number>();
  const fan = new Map<string, number>();
  const assign = (id: string, level: number, start: number, span: number) => {
    const mid = start + span / 2;
    angle.set(id, mid);
    depth.set(id, level);
    const kids = children.get(id) ?? [];
    if (kids.length === 0) return;
    const spread = level === 0 ? span : Math.min(span, MAX_FAN);
    fan.set(id, spread);
    let from = mid - spread / 2;
    for (const kid of kids) {
      const slice = (spread * countLeaves(kid)) / countLeaves(id);
      assign(kid, level + 1, from, slice);
      from += slice;
    }
  };
  assign(root, 0, -Math.PI / 2, 2 * Math.PI);

  let gap = LINK_DISTANCE;
  for (const [id, spread] of fan) {
    gap = Math.max(gap, (countLeaves(id) * arc) / (spread * ((depth.get(id) ?? 0) + 1)));
  }

  const points = new Map<string, RunGraphPoint>();
  for (const [id, a] of angle) {
    const r = (depth.get(id) ?? 0) * gap;
    points.set(id, r === 0 ? { x: 0, y: 0 } : { x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return points;
}

/**
 * One connected part of a cell. The biggest tree in it, by its lineage, is
 * drawn as rings around its root; whatever else is in the part settles
 * around that.
 */
function placePart(ids: string[], links: Link[], parents: ReadonlyMap<string, string[]>, arc?: number): Part {
  const within = new Set(ids);
  const parentOf = new Map<string, string>();
  const children = new Map<string, string[]>();
  for (const id of ids) {
    const parent = (parents.get(id) ?? []).find((p) => within.has(p) && p !== id);
    if (parent === undefined) continue;
    parentOf.set(id, parent);
    const kids = children.get(parent);
    if (kids) kids.push(id);
    else children.set(parent, [id]);
  }
  const roots = ids.filter((id) => !parentOf.has(id) && children.has(id));
  if (roots.length === 0) return settle(ids, links, new Map());

  const sizeOf = (id: string): number => 1 + (children.get(id) ?? []).reduce((sum, kid) => sum + sizeOf(kid), 0);
  const root = roots.reduce((best, id) => (sizeOf(id) > sizeOf(best) ? id : best));
  const tree = radialTree(root, children, arc);
  return tree.size === ids.length ? boxed(tree) : settle(ids, links, tree);
}

/** The nodes of one cell: its connected parts side by side, the loose nodes together at the end. */
function placeCell(ids: string[], links: Link[], parents: ReadonlyMap<string, string[]>, arc?: number): Part {
  const within = new Set(ids);
  const inCell = links.filter((l) => l.source !== l.target && within.has(l.source) && within.has(l.target));

  const leader = new Map<string, string>(ids.map((id) => [id, id]));
  const find = (id: string): string => {
    let top = id;
    while (leader.get(top) !== top) top = leader.get(top) as string;
    return top;
  };
  for (const link of inCell) leader.set(find(link.source), find(link.target));

  const members = new Map<string, string[]>();
  for (const id of ids) {
    const top = find(id);
    const list = members.get(top);
    if (list) list.push(id);
    else members.set(top, [id]);
  }
  const parts: Part[] = [];
  const loose: string[] = [];
  for (const group of members.values()) {
    if (group.length === 1) loose.push(group[0]);
    else {
      const inGroup = new Set(group);
      parts.push(
        placePart(
          group,
          inCell.filter((l) => inGroup.has(l.source)),
          parents,
          arc,
        ),
      );
    }
  }
  if (loose.length > 0) parts.push(settle(loose, [], new Map()));
  parts.sort((a, b) => b.points.size - a.points.size);

  const tallest = Math.max(0, ...parts.map((p) => p.height));
  const points = new Map<string, RunGraphPoint>();
  let x = CELL_PAD;
  for (const part of parts) {
    const top = CELL_PAD + (tallest - part.height) / 2;
    for (const [id, p] of part.points) points.set(id, { x: x + p.x, y: top + p.y });
    x += part.width + PART_GAP;
  }
  return { width: x - PART_GAP + CELL_PAD, height: tallest + 2 * CELL_PAD, points };
}

/**
 * Fold a cell's nodes: a parent's children past `cap` (most touched kept,
 * and any child that is itself a parent), then loose nodes past `cap` of one
 * type. Returns the ids the cell keeps, the "+N" nodes, and what each hidden
 * node folded into.
 */
function foldCell(
  cell: string,
  ids: string[],
  since: ReadonlyMap<string, number>,
  parents: ReadonlyMap<string, string[]>,
  fold: RunGraphFold,
  touches: ReadonlyMap<string, number>,
): { ids: string[]; clusters: RunGraphCluster[]; into: Map<string, string> } {
  const within = new Set(ids);
  const parentOf = new Map<string, string>();
  const children = new Map<string, string[]>();
  for (const id of ids) {
    const parent = (parents.get(id) ?? []).find((p) => within.has(p) && p !== id);
    if (parent === undefined) continue;
    parentOf.set(id, parent);
    const kids = children.get(parent);
    if (kids) kids.push(id);
    else children.set(parent, [id]);
  }
  const rank = (a: string, b: string) => (touches.get(b) ?? 0) - (touches.get(a) ?? 0) || (since.get(a) ?? 0) - (since.get(b) ?? 0);
  const into = new Map<string, string>();
  const clusters: RunGraphCluster[] = [];
  const byType = new Map<string, string[]>();
  for (const id of ids) {
    if (parentOf.has(id) || children.has(id)) continue;
    const type = fold.typeOf.get(id) ?? "";
    const list = byType.get(type);
    if (list) list.push(id);
    else byType.set(type, [id]);
  }
  // A cell with many parents (or types) keeps fewer of each: its budget is shared.
  const groups = children.size + byType.size;
  const cap = Math.max(3, Math.min(fold.cap, Math.floor((fold.budget ?? 4 * fold.cap) / Math.max(1, groups))));
  const foldGroup = (members: string[], key: string, parent: string | null, type: string | null) => {
    if (members.length <= cap + 1) return;
    const structure = members.filter((m) => children.has(m));
    const rest = members.filter((m) => !children.has(m)).sort(rank);
    const out = rest.slice(Math.max(0, cap - structure.length));
    if (out.length < 2) return;
    const id = `+${cell}|${key}`;
    for (const m of out) into.set(m, id);
    clusters.push({ id, cell, parent, type, members: out.map((m) => ({ id: m, since: since.get(m) ?? 0 })) });
  };
  for (const [parent, kids] of children) foldGroup(kids, `parent:${parent}`, parent, null);
  for (const [type, list] of byType) foldGroup(list, `type:${type}`, null, type || null);
  return { ids: [...ids.filter((id) => !into.has(id)), ...clusters.map((c) => c.id)], clusters, into };
}

interface Group {
  iteration: number | null;
  /** The segment of the run's paths the group's calls share. */
  segment: string;
  ids: string[];
  since: Map<string, number>;
}

interface Stage {
  key: string;
  stage: string;
  /** The segment of the first call that reached the stage. */
  segment: string;
  calls: number;
  groups: Map<number | null, Group>;
}

/** The segment of a call's path directly under the run. */
const segmentOf = (path: string): string => path.split("/")[1] ?? path;

/** The launch whose run a call is in, or is — the deepest, for a run launched inside another. */
function sectionOf(path: string, sections: ReadonlyMap<string, string>): string | null {
  let found: string | null = null;
  for (const launch of sections.keys()) {
    if (path !== launch && !path.startsWith(`${launch}/`)) continue;
    if (found === null || launch.length > found.length) found = launch;
  }
  return found;
}

/**
 * Place `nodeIds` for a canvas about `aspect` times as wide as it is tall:
 * in each cell, what its calls touched and the lineage above that, by
 * `parents` (each node's parents along `PARENT_OF`). A node not among
 * `nodeIds` is left out, lineage or not. `sections` names the calls that
 * launched a run of their own, by path, with what to call its lane: the
 * launch and every call under it are drawn there, apart from the rest.
 */
export function layoutRunGraph(
  calls: RunGraphCall[],
  nodeIds: string[],
  links: Link[],
  parents: ReadonlyMap<string, string[]> = new Map(),
  sections: ReadonlyMap<string, string> = new Map(),
  aspect = 1.6,
  fold?: RunGraphFold,
  stack?: RunGraphStack,
): RunGraphLayout {
  const wanted = new Set(nodeIds);
  const stages = new Map<string, Stage>();
  const callCells: string[] = [];
  calls.forEach((call, index) => {
    const launch = sectionOf(call.path, sections);
    const { stage, iteration } = launch === null ? stageOf(call.path) : { stage: launch, iteration: null };
    callCells.push(cellKey(stage, iteration));
    let entry = stages.get(stage);
    if (!entry) {
      const name = launch === null ? stage : (sections.get(launch) as string);
      const segment = launch === null ? segmentOf(call.path) : launch.split("/").slice(1).join("/");
      entry = { key: stage, stage: name, segment, calls: 0, groups: new Map() };
      stages.set(stage, entry);
    }
    entry.calls++;
    const touched = call.nodes.map((n) => n.ref_id);
    for (const id of [...touched, ...ancestorsOf(touched, parents)]) {
      if (!wanted.has(id)) continue;
      let group = entry.groups.get(iteration);
      if (!group) {
        group = {
          iteration,
          segment: launch === null ? segmentOf(call.path) : entry.segment,
          ids: [],
          since: new Map(),
        };
        entry.groups.set(iteration, group);
      }
      if (group.since.has(id)) continue;
      group.ids.push(id);
      group.since.set(id, index);
    }
  });

  // How many calls touched each node: what a fold keeps first.
  const touches = new Map<string, number>();
  if (fold) for (const call of calls) for (const n of call.nodes) touches.set(n.ref_id, (touches.get(n.ref_id) ?? 0) + 1);
  const clusters = new Map<string, RunGraphCluster>();

  const settled = [...stages.values()].map((s) => {
    const looped = [...s.groups.keys()].some((iteration) => iteration !== null);
    const cells = [...s.groups.values()]
      .sort((a, b) => (a.iteration ?? -1) - (b.iteration ?? -1))
      .map((group) => {
        if (!fold) return { group, ...placeCell(group.ids, links, parents), header: looped ? CELL_HEADER : 0 };
        // The cell's nodes with its "+N" nodes for what folded: each placed
        // under its parent, linked where its members were, first seen with
        // the first of them.
        const key = cellKey(s.key, group.iteration);
        const folded = foldCell(key, group.ids, group.since, parents, fold, touches);
        const cellParents = new Map(parents);
        for (const c of folded.clusters) {
          clusters.set(c.id, c);
          if (c.parent !== null) cellParents.set(c.id, [c.parent]);
          group.since.set(c.id, Math.min(...c.members.map((m) => m.since)));
        }
        const seen = new Set<string>();
        const cellLinks: Link[] = [];
        for (const l of links) {
          const source = folded.into.get(l.source) ?? l.source;
          const target = folded.into.get(l.target) ?? l.target;
          const k = `${source}|${target}`;
          if (source === target || seen.has(k)) continue;
          seen.add(k);
          cellLinks.push({ source, target });
        }
        return { group, ...placeCell(folded.ids, cellLinks, cellParents, fold.arc), header: looped ? CELL_HEADER : 0 };
      });
    return { ...s, cells };
  });

  const footprint = (c: { width: number; height: number; header: number }) =>
    (c.width + CELL_GAP) * (c.height + c.header + CELL_GAP);
  const stacks = (s: (typeof settled)[number]) =>
    !!stack && s.cells.length > stack.after && !stack.open?.has(s.key) && s.cells.every((c) => c.group.iteration !== null);
  // A stacked lane takes one box's room.
  const area = settled.reduce((sum, s) => sum + (stacks(s) ? Math.max(0, ...s.cells.map(footprint)) : s.cells.reduce((a, c) => a + footprint(c), 0)), 0);
  const targetHeight = Math.sqrt(area / aspect) || 1;

  const places = new Map<string, RunGraphPlace>();
  const lanes: RunGraphLane[] = [];
  let laneX = 0;
  for (const s of settled) {
    // A loop of many iterations, drawn in one box: each iteration at the same place, shown one at a time.
    if (stacks(s)) {
      const boxWidth = Math.max(0, ...s.cells.map((c) => c.width));
      const boxHeight = Math.max(0, ...s.cells.map((c) => c.height + c.header));
      const left = laneX + LANE_PAD;
      const cells: RunGraphCell[] = s.cells.map((cell) => {
        const key = cellKey(s.key, cell.group.iteration);
        for (const [id, point] of cell.points) {
          places.set(placeKey(key, id), { id, cell: key, since: cell.group.since.get(id) ?? 0, x: left + point.x, y: LANE_HEADER + cell.header + point.y });
        }
        return { iteration: cell.group.iteration, path: cell.group.segment, nodes: cell.group.ids.length, x: left, y: LANE_HEADER, width: boxWidth, height: boxHeight };
      });
      const width = Math.max(LANE_MIN_WIDTH, boxWidth + 2 * LANE_PAD);
      lanes.push({ key: s.key, stage: s.stage, path: null, calls: s.calls, nodes: cells.reduce((sum, c) => sum + c.nodes, 0), cells, x: laneX, y: 0, width, height: LANE_HEADER + boxHeight + LANE_PAD, stacked: true });
      laneX += width + LANE_GAP;
      continue;
    }
    const widest = Math.max(0, ...s.cells.map((c) => c.width));
    const rowWidth = Math.max(widest, s.cells.reduce((a, c) => a + footprint(c), 0) / targetHeight);
    const cells: RunGraphCell[] = [];
    let x = 0;
    let y = 0;
    let rowHeight = 0;
    let right = 0;
    for (const cell of s.cells) {
      const height = cell.height + cell.header;
      if (x > 0 && x + cell.width > rowWidth) {
        x = 0;
        y += rowHeight + CELL_GAP;
        rowHeight = 0;
      }
      const left = laneX + LANE_PAD + x;
      const top = LANE_HEADER + y;
      cells.push({
        iteration: cell.group.iteration,
        path: cell.group.segment,
        nodes: cell.group.ids.length,
        x: left,
        y: top,
        width: cell.width,
        height,
      });
      const key = cellKey(s.key, cell.group.iteration);
      for (const [id, point] of cell.points) {
        places.set(placeKey(key, id), {
          id,
          cell: key,
          since: cell.group.since.get(id) ?? 0,
          x: left + point.x,
          y: top + cell.header + point.y,
        });
      }
      x += cell.width + CELL_GAP;
      right = Math.max(right, x - CELL_GAP);
      rowHeight = Math.max(rowHeight, height);
    }
    const width = Math.max(LANE_MIN_WIDTH, right + 2 * LANE_PAD);
    lanes.push({
      key: s.key,
      stage: s.stage,
      path: s.cells.some((c) => c.group.iteration !== null) ? null : s.segment,
      calls: s.calls,
      nodes: cells.reduce((sum, c) => sum + c.nodes, 0),
      cells,
      x: laneX,
      y: 0,
      width,
      height: LANE_HEADER + y + rowHeight + LANE_PAD,
    });
    laneX += width + LANE_GAP;
  }

  const height = Math.max(0, ...lanes.map((l) => l.height));
  for (const lane of lanes) lane.height = height;
  return { width: Math.max(0, laneX - LANE_GAP), height, places, lanes, callCells, clusters };
}
