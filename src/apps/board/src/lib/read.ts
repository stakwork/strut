// What the page reads, on the app's grants (app.yaml): every node of the
// three plan types with `graph/find`, a page at a time, then the edges
// among them with `graph/graph-edges`. Generic steps only, so the same
// reads work on any graph that holds a plan — and a graph that holds none
// answers an empty board, not an error.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useGraphChanges, useStrutClient, type StrutClient } from "@strut/kit";
import { getEdges } from "strut/views";
import { buildPlan, HIVE_PLAN, newCard, type Card, type Plan, type RawEdge, type RawNode, type Role, type Roles } from "./plan";
import { buildBrainstorms, HIVE_BRAINSTORM, type BrainstormRoles, type Brainstorms } from "./brainstorm";
import { buildWhy, HIVE_WHY, type Why, type WhyRoles } from "./why";

const FIND = "graph/find";
/** graph/find's largest page. */
const PAGE = 500;
/** The most nodes of one type a board reads; past it the board says it was cut. */
export const MAX_PER_TYPE = 3000;
/** graph-edges' `ref_ids` per call. */
const EDGES_IDS = 1000;

interface FindPage {
  nodes?: RawNode[];
  cursor?: string;
}

async function findAll(client: StrutClient, type: string): Promise<{ nodes: RawNode[]; truncated: boolean }> {
  const nodes: RawNode[] = [];
  let cursor: string | undefined;
  do {
    const r = await client.run(FIND, { node_type: type, limit: PAGE, ...(cursor ? { cursor } : {}) });
    // A graph step answers a problem as a string. A type this graph does not hold is an empty board.
    if (typeof r === "string") {
      if (/unknown|no such|not (found|registered|declared)/i.test(r)) return { nodes, truncated: false };
      throw new Error(`${FIND}: ${r}`);
    }
    const page = r as FindPage;
    nodes.push(...(page.nodes ?? []));
    cursor = page.cursor;
    if (cursor && nodes.length >= MAX_PER_TYPE) return { nodes, truncated: true };
  } while (cursor);
  return { nodes, truncated: false };
}

export async function readPlan(client: StrutClient, roles: Roles = HIVE_PLAN): Promise<{ plan: Plan; truncated: boolean }> {
  const [goal, group, work] = await Promise.all([findAll(client, roles.goal), findAll(client, roles.group), findAll(client, roles.work)]);
  const nodes: Record<Role, RawNode[]> = { goal: goal.nodes, group: group.nodes, work: work.nodes };
  let truncated = goal.truncated || group.truncated || work.truncated;
  const ids = [...goal.nodes, ...group.nodes, ...work.nodes].map((n) => n.ref_id);
  const edges: RawEdge[] = [];
  for (let i = 0; i < ids.length; i += EDGES_IDS) {
    const r = await getEdges(client, ids.slice(i, i + EDGES_IDS), { among: ids });
    edges.push(...r.edges);
    if (r.truncated) truncated = true;
  }
  return { plan: buildPlan(nodes, edges, roles), truncated };
}

/** A change counter that moves at most once per `ms`: the first change at once, the rest together
 *  when the interval ends. While jobs are writing, the graph changes many times a second, and each
 *  read here is the whole plan — read on every write, the page spends its time parsing. */
export function useSettled(rev: number, ms: number): number {
  const [settled, setSettled] = useState(rev);
  const last = useRef(0);
  useEffect(() => {
    if (rev === settled) return;
    const wait = Math.max(0, last.current + ms - Date.now());
    const t = setTimeout(() => {
      last.current = Date.now();
      setSettled(rev);
    }, wait);
    return () => clearTimeout(t);
  }, [rev, settled, ms]);
  return settled;
}

/** The plan, re-read when a write to one of its types lands through strut, at most every few seconds. */
export function usePlan(roles: Roles = HIVE_PLAN) {
  const client = useStrutClient();
  const rev = useSettled(useGraphChanges([roles.goal, roles.group, roles.work]).rev, 5_000);
  return useQuery({
    queryKey: ["board", "plan", roles.goal, roles.group, roles.work, rev],
    queryFn: () => readPlan(client, roles),
    staleTime: 60_000,
    // Keep the board on screen while a change is re-read.
    placeholderData: (prev) => prev,
  });
}

export async function readBrainstorms(client: StrutClient, plan: Plan, roles: BrainstormRoles = HIVE_BRAINSTORM): Promise<Brainstorms> {
  const [questions, options] = await Promise.all([findAll(client, roles.question), findAll(client, roles.option)]);
  const own = [...questions.nodes, ...options.nodes].map((n) => n.ref_id);
  // A question's edge to the card it is about leads out of the brainstorm, into the plan.
  const among = [...own, ...Object.keys(plan.cards)];
  const edges: RawEdge[] = [];
  for (let i = 0; i < own.length; i += EDGES_IDS) edges.push(...(await getEdges(client, own.slice(i, i + EDGES_IDS), { among })).edges);
  return buildBrainstorms(questions.nodes, options.nodes, edges, plan, roles);
}

/** The brainstorms about the plan's cards, read once the plan is, and again when one is written. */
export function useBrainstorms(plan: Plan | undefined, roles: BrainstormRoles = HIVE_BRAINSTORM) {
  const client = useStrutClient();
  const rev = useSettled(useGraphChanges([roles.question, roles.option]).rev, 15_000);
  return useQuery({
    queryKey: ["board", "brainstorms", roles.question, roles.option, rev, plan ? Object.keys(plan.cards).length : 0],
    enabled: !!plan,
    queryFn: () => readBrainstorms(client, plan!, roles),
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
}

export async function readWhy(client: StrutClient, plan: Plan, roles: WhyRoles = HIVE_WHY): Promise<Why> {
  const [briefs, stories, requirements] = await Promise.all([findAll(client, roles.brief), findAll(client, roles.story), findAll(client, roles.requirement)]);
  const own = [...briefs.nodes, ...stories.nodes, ...requirements.nodes].map((n) => n.ref_id);
  // A goal's edge to its brief and stories, and work's edge to a requirement, come in from the plan.
  const among = [...own, ...Object.keys(plan.cards)];
  const edges: RawEdge[] = [];
  for (let i = 0; i < own.length; i += EDGES_IDS) edges.push(...(await getEdges(client, own.slice(i, i + EDGES_IDS), { among })).edges);
  return buildWhy({ briefs: briefs.nodes, stories: stories.nodes, requirements: requirements.nodes }, edges, plan, roles);
}

/** Each goal's brief, stories and requirements, and the work that answers them. */
export function useWhy(plan: Plan | undefined, roles: WhyRoles = HIVE_WHY) {
  const client = useStrutClient();
  const rev = useSettled(useGraphChanges([roles.brief, roles.story, roles.requirement]).rev, 15_000);
  return useQuery({
    queryKey: ["board", "why", roles.story, roles.requirement, rev, plan ? Object.keys(plan.cards).length : 0],
    enabled: !!plan,
    queryFn: () => readWhy(client, plan!, roles),
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
}

/** A person's edit to one node (`graph/edit-node`, on the types app.yaml declares): the reason it was
 *  not written, or null. What the board holds is read again once it is. */
export function useEdit() {
  const client = useStrutClient();
  const qc = useQueryClient();
  return async (id: string, set: Record<string, unknown>, remove: string[] = []): Promise<string | null> => {
    try {
      const r = await client.run("graph/edit-node", { ref_id: id, ...(Object.keys(set).length ? { node_data: set } : {}), ...(remove.length ? { properties_to_be_deleted: remove } : {}) });
      // A graph step answers a problem as a string.
      if (typeof r === "string") return r;
      void qc.invalidateQueries({ queryKey: ["board"] });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
}

/** An id for a node a person makes by hand. `crypto.randomUUID` needs a secure context, which a framed page is not always. */
function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A person adds a card by hand: the node (`graph/create-node`), then the edge from the card that
 *  holds it (`graph/create-triplet`). Its ref_id, or why it was not made. */
export function useAdd(roles: Roles = HIVE_PLAN) {
  const client = useStrutClient();
  const qc = useQueryClient();
  return async (plan: Plan, role: Role, title: string, under?: Card): Promise<{ id: string } | { problem: string }> => {
    try {
      const siblings = under ? (plan.kids[under.id] ?? []).map((k) => plan.cards[k]!).filter((c) => c.role === role) : [];
      const made = await client.run("graph/create-node", { node_type: roles[role], node_data: newCard(roles, role, title, newId(), under ? { card: under, siblings } : undefined) });
      if (typeof made === "string") return { problem: made };
      const id = (made as { ref_id?: string }).ref_id;
      if (!id) return { problem: "the graph did not say what it made" };
      const edge = roles.make[role].edge;
      if (under && edge) {
        const joined = await client.run("graph/create-triplet", { source_ref_id: under.id, target_ref_id: id, edge_type: edge });
        if (typeof joined === "string") return { problem: `made, but not joined to "${under.title}": ${joined}` };
      }
      await qc.invalidateQueries({ queryKey: ["board"] });
      return { id };
    } catch (err) {
      return { problem: err instanceof Error ? err.message : String(err) };
    }
  };
}

/** A person puts a sticky note on a card: an open question of their own, about that card
 *  (`graph/create-node`, then the edge to the card). Its ref_id, or why it was not made. */
export function useAddAsk(roles: BrainstormRoles = HIVE_BRAINSTORM) {
  const client = useStrutClient();
  const qc = useQueryClient();
  return async (text: string, about: Card): Promise<{ id: string } | { problem: string }> => {
    try {
      const made = await client.run("graph/create-node", { node_type: roles.question, node_data: { name: text, text, question_id: newId(), state: "open", made_by: "person" } });
      if (typeof made === "string") return { problem: made };
      const id = (made as { ref_id?: string }).ref_id;
      if (!id) return { problem: "the graph did not say what it made" };
      const joined = await client.run("graph/create-triplet", { source_ref_id: id, target_ref_id: about.id, edge_type: roles.about });
      if (typeof joined === "string") return { problem: `made, but not put on "${about.title}": ${joined}` };
      await qc.invalidateQueries({ queryKey: ["board"] });
      return { id };
    } catch (err) {
      return { problem: err instanceof Error ? err.message : String(err) };
    }
  };
}

export interface LiveJob {
  job: string;
  title: string;
}

/** The viewer's jobs that are working right now (`job/list`'s `busy`). None when the step is not answered here. */
export function useLiveJobs() {
  const client = useStrutClient();
  return useQuery({
    queryKey: ["board", "live"],
    refetchInterval: 20_000,
    queryFn: async (): Promise<LiveJob[]> => {
      const r = await client.run("job/list", { limit: 50 }).catch(() => null);
      const jobs = (r && typeof r === "object" ? (r as { jobs?: Array<{ job: string; title?: string; busy?: boolean }> }).jobs : null) ?? [];
      return jobs.filter((j) => j.busy).map((j) => ({ job: j.job, title: j.title?.trim() || "Untitled job" }));
    },
  });
}

export interface Waiting {
  id: string;
  title: string;
  summary: string;
}

/** What waits on the viewer's yes or no (`proposal/list`, which answers each person their own). */
export function useWaiting() {
  const client = useStrutClient();
  return useQuery({
    queryKey: ["board", "waiting"],
    refetchInterval: 60_000,
    queryFn: async (): Promise<Waiting[]> => {
      const r = await client.run("proposal/list", { status: "pending", limit: 50 }).catch(() => null);
      const list = (r && typeof r === "object" ? (r as { proposals?: Array<{ id: string; title?: string; summary?: string }> }).proposals : null) ?? [];
      return list.map((p) => ({ id: p.id, title: p.title?.trim() || "A change to approve", summary: p.summary?.trim() || "" }));
    },
  });
}
