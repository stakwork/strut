// Why a goal exists, and what answers it: the goal's brief, the stories of
// who it is for, each story's requirements, and the work that satisfies
// each requirement. Built from typed nodes and the edges among them, like
// the plan (./plan.ts); which types and edges those are is data. Pure.
import { isLive, type Plan, type RawEdge, type RawNode } from "./plan";

export interface WhyRoles {
  brief: string;
  story: string;
  requirement: string;
  /** goal → its brief, goal → a story, story → a requirement. */
  hasBrief: string;
  hasStory: string;
  hasRequirement: string;
  /** work → a requirement it answers. */
  satisfies: string;
}

/** What Hive and the canvas write. */
export const HIVE_WHY: WhyRoles = { brief: "Brief", story: "UserStory", requirement: "Requirement", hasBrief: "HAS_BRIEF", hasStory: "HAS_STORY", hasRequirement: "HAS_REQUIREMENT", satisfies: "SATISFIES" };

export interface Story {
  id: string;
  text: string;
  /** Agreed by a person; otherwise it is still a proposal. */
  accepted: boolean;
  requirements: string[];
}
export interface Requirement {
  id: string;
  text: string;
  accepted: boolean;
  story: string | null;
}
export interface Why {
  /** A goal's brief, as written. */
  brief: Record<string, string>;
  stories: Record<string, Story>;
  requirements: Record<string, Requirement>;
  /** A goal's stories, in the order they were written. */
  byGoal: Record<string, string[]>;
  /** The work that answers a requirement, and the requirements a piece of work answers. */
  answers: Record<string, string[]>;
  serves: Record<string, string[]>;
}

const textOf = (n: RawNode): string => {
  const t = n.properties?.["text"];
  return ((typeof t === "string" && t) || n.name || "").trim();
};
const at = (n: RawNode): number => (typeof n.properties?.["date_added_to_graph"] === "number" ? (n.properties["date_added_to_graph"] as number) : 0);

export function buildWhy(nodes: { briefs: RawNode[]; stories: RawNode[]; requirements: RawNode[] }, edges: RawEdge[], plan: Plan, roles: WhyRoles = HIVE_WHY): Why {
  const out: Why = { brief: {}, stories: {}, requirements: {}, byGoal: {}, answers: {}, serves: {} };
  const briefs = new Map(nodes.briefs.filter((n) => isLive(n.properties)).map((n) => [n.ref_id, textOf(n)]));
  const written = new Map<string, number>();
  for (const n of nodes.stories) {
    if (!isLive(n.properties) || out.stories[n.ref_id]) continue;
    out.stories[n.ref_id] = { id: n.ref_id, text: textOf(n), accepted: n.properties?.["status"] === "accepted", requirements: [] };
    written.set(n.ref_id, at(n));
  }
  for (const n of nodes.requirements) {
    if (!isLive(n.properties) || out.requirements[n.ref_id]) continue;
    out.requirements[n.ref_id] = { id: n.ref_id, text: textOf(n), accepted: n.properties?.["status"] === "accepted", story: null };
    written.set(n.ref_id, at(n));
  }
  for (const e of edges) {
    const goal = plan.cards[e.source]?.role === "goal" ? e.source : null;
    if (goal && e.edge_type === roles.hasBrief && briefs.has(e.target)) out.brief[goal] ??= briefs.get(e.target)!;
    else if (goal && e.edge_type === roles.hasStory && out.stories[e.target]) {
      const list = (out.byGoal[goal] ??= []);
      if (!list.includes(e.target)) list.push(e.target);
    } else if (e.edge_type === roles.hasRequirement && out.stories[e.source] && out.requirements[e.target] && !out.requirements[e.target]!.story) {
      out.requirements[e.target]!.story = e.source;
      out.stories[e.source]!.requirements.push(e.target);
    } else if (e.edge_type === roles.satisfies && plan.cards[e.source] && out.requirements[e.target]) {
      const a = (out.answers[e.target] ??= []);
      if (!a.includes(e.source)) a.push(e.source);
      const s = (out.serves[e.source] ??= []);
      if (!s.includes(e.target)) s.push(e.target);
    }
  }
  const oldestFirst = (x: string, y: string) => (written.get(x) ?? 0) - (written.get(y) ?? 0) || x.localeCompare(y);
  for (const g of Object.keys(out.byGoal)) out.byGoal[g]!.sort(oldestFirst);
  for (const s of Object.values(out.stories)) s.requirements.sort(oldestFirst);
  return out;
}

/** Every piece of work that answers any of a story's requirements. */
export function workFor(why: Why, story: string): string[] {
  const out = new Set<string>();
  for (const r of why.stories[story]?.requirements ?? []) for (const w of why.answers[r] ?? []) out.add(w);
  return [...out];
}

/** "As a builder, I want X, so that Y." in its three parts: who it is for, what they want (without
 *  "I want (to)"), and why (after the last "so that" or ", so"). Null when it does not open "As a …,". */
export function parseStory(text: string): { who: string; want: string; why: string | null } | null {
  const m = /^As an? ([^,]{1,80}),\s*(.+?)\.?$/is.exec(text.replace(/\s+/g, " ").trim());
  if (!m) return null;
  let want = m[2]!.replace(/^I (?:want|need)(?: to)? /i, "");
  let why: string | null = null;
  const so = [...want.matchAll(/,?\s+so that\s+|,\s+so\s+/gi)].pop();
  if (so && so.index > 0) {
    why = want.slice(so.index + so[0].length);
    want = want.slice(0, so.index);
  }
  return { who: m[1]!, want: want.charAt(0).toUpperCase() + want.slice(1), why };
}
