import { createHash } from "node:crypto";
import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { resolveStep } from "../../registry.js";
import graphGet from "../graph/graph-get.js";

/**
 * Recent Work (plans/recent-work.md): what the person most likely means, put
 * in front of an agent's turn. A root Concept (`Recent Work`, strut seeds it)
 * whose pages each name a READ step (`step`, an attribute of the page): the
 * step runs as this run's person and lists the top few things, theirs first,
 * then what else the server has (strut's Apps, Workflows and Jobs; a
 * package's workspaces or repositories). The page's docs say how to find the
 * rest. The renderer names no package, type or domain: a package adds a page.
 *
 * The section goes in the TURN's prompt (the thread froze its system prompt
 * at its first turn), and only when it changed since that thread last saw
 * it: the agent step keeps `tags: { recent: <hash> }` on each turn's line,
 * and this step answers `text: ""` while the thread's last line carries the
 * same hash and the turn that sent it is still replayed (no compaction since).
 *
 * Never fails a run: no root, a page whose step fails, is slow or is not a
 * read, each leaves that part out (one log line) and the rest renders.
 */
export const RECENT = {
  /** The tag the agent step keeps the section's hash under. */
  tag: "recent",
  pageItems: 8,
  allItems: 20,
  docsMax: 600,
  fieldMax: 160,
  stepMs: 2000,
  keepMs: 5 * 60_000,
} as const;

export interface RecentItem {
  name: string;
  what?: string;
  at?: string;
  link?: string;
}

/** What a page's step answers: the person's own first, newest first, then
 *  what else the server has. `what` says whose it is. */
export const recentOutput = z.object({
  items: z.array(
    z.object({
      name: z.string().describe("What the person would call it"),
      what: z.string().optional().describe("A few words, saying whose it is (you opened it, on this server)"),
      at: z.string().optional().describe("When, ISO"),
      link: z.string().optional().describe("Where to open it"),
    }),
  ),
});

export interface RecentPage {
  name: string;
  docs?: string;
  items: RecentItem[];
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Pure: a step's output → its items, each field cut, one without a name dropped. */
export function recentItems(output: unknown): RecentItem[] {
  const raw = (output as { items?: unknown } | null | undefined)?.items;
  if (!Array.isArray(raw)) return [];
  const out: RecentItem[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const str = (k: string) => (typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim() : undefined);
    const name = str("name");
    if (!name) continue;
    const what = str("what"), at = str("at"), link = str("link");
    out.push({
      name: cut(name, RECENT.fieldMax),
      ...(what ? { what: cut(what, RECENT.fieldMax) } : {}),
      ...(at ? { at } : {}),
      ...(link ? { link: cut(link, 2 * RECENT.fieldMax) } : {}),
    });
  }
  return out;
}

/** Pure: at most `pageItems` a page and `allItems` in all. A page keeps its
 *  step's order (the person's own first), so past the cap the last item of
 *  the longest page goes first: a page's fill before anyone's own. */
export function capRecent(pages: RecentPage[]): RecentPage[] {
  const out = pages.map((p) => ({ ...p, items: p.items.slice(0, RECENT.pageItems) }));
  let total = out.reduce((n, p) => n + p.items.length, 0);
  while (total > RECENT.allItems) {
    const longest = out.reduce((a, b) => (b.items.length > a.items.length ? b : a));
    longest.items = longest.items.slice(0, -1);
    total--;
  }
  return out;
}

/** An ISO time as its date alone: absolute, so the text does not change by itself from turn to turn. */
const dayOf = (at: string) => (Number.isNaN(Date.parse(at)) ? undefined : new Date(at).toISOString().slice(0, 10));

/** A page step's order within a group: the newer DAY first, as the section
 *  shows it, and 0 for the same day, so the step breaks the tie by name.
 *  Then its list changes only when what the section shows does, and the
 *  section is not sent again because a time moved within a day. A step still
 *  picks WHICH items by the exact time; this orders the ones it shows. None
 *  sorts last. */
export const newerDay = (a: string | undefined, b: string | undefined): number => ((b && dayOf(b)) || "").localeCompare((a && dayOf(a)) || "");

/** Pure: the root and its pages → the section. "" with no page. */
export function renderRecent(root: { name: string; docs?: string }, pages: RecentPage[]): string {
  if (!pages.length) return "";
  const docs = (d: string | undefined) => cut((d ?? "").trim(), RECENT.docsMax);
  const lines = [`[${root.name}: this server's notes on what the person most likely means, not their words]`];
  if (docs(root.docs)) lines.push(docs(root.docs));
  for (const page of capRecent(pages)) {
    lines.push("", `${page.name}:`);
    if (docs(page.docs)) lines.push(docs(page.docs));
    for (const i of page.items) {
      const day = i.at ? dayOf(i.at) : undefined;
      lines.push(`- ${i.name}${i.what ? `: ${i.what}` : ""}${day ? ` (${day})` : ""}${i.link ? ` ${i.link}` : ""}`);
    }
  }
  lines.push(`[end of ${root.name}]`);
  return lines.join("\n");
}

export const recentHash = (text: string) => (text ? createHash("sha256").update(text).digest("hex").slice(0, 16) : "");

/** Pure: whether a thread already has this section in what it replays: its
 *  last line carries `hash`, and the first of the trailing lines that do (the
 *  turn that sent it) starts at or after where the replay begins. */
export function alreadySent(turns: Array<{ offset: number; replayFrom?: number; tags?: Record<string, string> }>, hash: string): boolean {
  let i = turns.length - 1;
  if (!hash || i < 0 || turns[i]!.tags?.[RECENT.tag] !== hash) return false;
  const from = turns[i]!.replayFrom ?? 0;
  while (i > 0 && turns[i - 1]!.tags?.[RECENT.tag] === hash) i--;
  return turns[i]!.offset >= from;
}

/** What each person's steps answered lately, per server (its registry). */
const kept = new WeakMap<object, Map<string, { at: number; items: RecentItem[] }>>();
/** The runs of those steps still going, per server, by the same key: a turn
 *  that comes while one runs waits on it, and starts no other. */
const going = new WeakMap<object, Map<string, Promise<RecentItem[] | undefined>>>();

const perServer = <V>(m: WeakMap<object, Map<string, V>>, registry: object): Map<string, V> => {
  const found = m.get(registry);
  if (found) return found;
  const made = new Map<string, V>();
  m.set(registry, made);
  return made;
};

/** One page's step, run as this run's person: its items, or undefined
 *  (not a read step, failed, or slower than `stepMs`). */
async function itemsOf(page: string, step: string, ctx: StepContext<StrutCapabilities>): Promise<RecentItem[] | undefined> {
  const registry = ctx.registry;
  if (!registry) return undefined;
  const memo = perServer(kept, registry);
  const runs = perServer(going, registry);
  const key = `${ctx.actor ?? ""}\n${step}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < RECENT.keepMs) return hit.items;
  let running = runs.get(key);
  if (!running) {
    const def = (await resolveStep(registry, step).catch(() => null))?.def as { effect?: string } | undefined;
    if (def?.effect !== "read") {
      console.warn(`[context/recent] "${page}" names ${def ? `"${step}", which is not a read step` : `no step "${step}"`}: its items are left out`);
      return undefined;
    }
    const { runSingleStep } = await import("../../../run-step.js");
    // A failure is kept as no items for as long as an answer, so a page whose
    // step cannot run here (a host without its capability) is one log line,
    // not one a turn.
    const failed = (why: unknown) => {
      console.warn(`[context/recent] "${page}": ${step} failed:`, why instanceof Error ? why.message : why);
      memo.set(key, { at: Date.now(), items: [] });
      return undefined;
    };
    // ctx.services is this run's view already (its branch, its app or host):
    // the step reads through it, as this run's person. A run past `stepMs`
    // goes on, and what it answers is kept for the next turn. Another turn
    // may have started one during the awaits above: that one is waited on.
    running =
      runs.get(key) ??
      runSingleStep(step, registry, ctx.services, {
        config: {},
        ...(ctx.actor ? { actor: ctx.actor } : {}),
        ...(ctx.principal ? { principal: ctx.principal } : {}),
      })
        .then((run) => {
          if (run.status !== "success") return failed(run.error?.message ?? run.status);
          const items = recentItems(run.output);
          memo.set(key, { at: Date.now(), items });
          return items;
        }, failed)
        .finally(() => runs.delete(key));
    runs.set(key, running);
  }
  let timer: NodeJS.Timeout | undefined;
  const slow = new Promise<"slow">((resolve) => {
    timer = setTimeout(() => resolve("slow"), RECENT.stepMs);
  });
  const out = await Promise.race([running, slow]).finally(() => clearTimeout(timer));
  if (out !== "slow") return out;
  console.warn(`[context/recent] "${page}": ${step} took over ${RECENT.stepMs} ms: its items are left out of this turn`);
  return undefined;
}

type Read = { name?: string; ref_id?: string; properties?: Record<string, unknown>; children?: Array<{ ref_id: string; name: string }> } | string | undefined;

async function read(lookup: Record<string, unknown>, ctx: StepContext<StrutCapabilities>): Promise<Exclude<Read, string> | undefined> {
  const out = (await graphGet.run(graphGet.input.parse(lookup), ctx).catch(() => undefined)) as Read;
  return out && typeof out !== "string" && out.ref_id ? out : undefined;
}

export default defineStep({
  type: "context/recent",
  description:
    "Render the person's Recent Work for an agent's turn: the pages under a root Concept (\"Recent Work\"), each with its docs and the items its `step` lists as this run's person (theirs first, then what else the server has). " +
    "`{ text, hash }`: put `text` at the head of the turn's prompt (it ends with a blank line) and keep `hash` on the turn (the agent step's `tags: { recent }`). With `session`, `text` is \"\" while that thread already has this section. Never fails the run.",
  input: z.object({
    name: z.string().optional().describe('The root Concept, by name ("Recent Work"). None renders nothing.'),
    session: z.string().optional().describe("The thread the agent continues: text is \"\" when its last turn kept the same hash and that copy is still replayed."),
  }),
  output: z.object({ text: z.string(), hash: z.string() }),
  async run(cfg, ctx: StepContext<StrutCapabilities>) {
    const none = { text: "", hash: "" };
    if (!cfg.name) return none;
    // No wired graph: only a page strut ships, from its file (as context/concept).
    if (!ctx?.services?.graph && !(await ctx?.services?.conceptFiles?.get(cfg.name).catch(() => undefined))) return none;
    const root = await read({ node_type: "Concept", name: cfg.name, children: "PARENT_OF" }, ctx);
    if (!root) return none;
    const pages = (
      await Promise.all(
        (root.children ?? []).map(async (c): Promise<RecentPage | undefined> => {
          const page = await read({ ref_id: c.ref_id }, ctx);
          if (!page) return undefined;
          const step = typeof page.properties?.["step"] === "string" ? (page.properties["step"] as string).trim() : "";
          const docs = typeof page.properties?.["docs"] === "string" ? (page.properties["docs"] as string) : undefined;
          const items = step ? ((await itemsOf(c.name, step, ctx)) ?? []) : [];
          return { name: page.name ?? c.name, ...(docs ? { docs } : {}), items };
        }),
      )
    ).filter((p): p is RecentPage => !!p);
    const docs = typeof root.properties?.["docs"] === "string" ? (root.properties["docs"] as string) : undefined;
    // A prompt's head: a blank line after it, so the template puts it first as it is.
    const section = renderRecent({ name: root.name ?? cfg.name, ...(docs ? { docs } : {}) }, pages);
    const text = section ? `${section}\n\n` : "";
    const hash = recentHash(text);
    if (cfg.session && hash) {
      const turns = await ctx.services?.sessions?.turns(cfg.session).catch(() => []);
      if (turns && alreadySent(turns, hash)) return { text: "", hash };
    }
    return { text, hash };
  },
});
