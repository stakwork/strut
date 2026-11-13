/**
 * CONCEPT BRANCHES (plans/concept-evals.md item b; rulings 2, 3 and 10): a
 * named copy of the Concept pages, held in a graph namespace of its own, that
 * a run can be pointed at and that can be dropped. A branch is, per ruling 2,
 * a git branch in the history plus a graph namespace holding the same pages;
 * this is the namespace half (the git half is item c).
 *
 *   - CREATE copies every live Concept of the graph's own namespace and the
 *     `PARENT_OF` edges among them into `branch-<name>` (`from: "main"`), or
 *     nothing (`from: "empty"`). A copy is the page's attributes and docs
 *     with no source stamp (`unique_source_id`): nothing reads it as a
 *     seeded or a package's page. Its identity is its key in the branch's
 *     namespace, the same key as the page it was copied from.
 *   - A RUN on a branch (`RunOptions.branch`, the launch's `branch`) reads and
 *     writes Concepts there and nowhere else; the rest of the graph is live
 *     (`bindBranch`, src/graph/branch.ts). A run it starts is on it too, and
 *     cannot leave it; a conversation stays on the branch its first turn ran
 *     on. It never crosses to another strut.
 *   - DROP removes the branch's pages and its record; refused while a run on
 *     it is in flight. A run that waits on a dropped branch fails when woken.
 *
 * The record of which branches exist is a file per branch,
 * `<dataDir>/branches/<name>.json`: name, namespace, when, who, from what.
 * Claims are not on branches (ruling 4: shared; item d): a run on a branch
 * opens the branch's pages, which no claim is about, so the verify pass
 * records nothing about them.
 */
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GraphBackend } from "./graph/backend.js";
import { onBranch } from "./graph/branch.js";
import { branchOf } from "./graph/scope.js";
import { BRANCH_NAMESPACE_PREFIX } from "./graph/search.js";
import { withLock } from "./jobs.js";
import type { KnowledgeCapability } from "./knowledge.js";
import type { SessionsCapability } from "./session-store.js";

/** A branch's name: what its namespace is made of, and (item c) a git
 *  branch's. Lowercase letters, digits, `-` and `_`, a letter first. */
export const BRANCH_NAME = /^[a-z][a-z0-9_-]{0,55}$/;

export interface ConceptBranch {
  name: string;
  /** The graph namespace its pages are in: `branch-<name>`. */
  namespace: string;
  createdAt: string;
  /** Who made it (the request's actor), when known. */
  createdBy?: string;
  /** What it was made from: the live tree, or nothing. */
  from: "main" | "empty";
  /** What the copy wrote: pages and `PARENT_OF` links. */
  pages: number;
  links: number;
}

/** `ctx.services.branches`, which `createStrut` sets on a graph workspace. */
export interface BranchesCapability {
  /** Read the records at boot: what tells a read on main to leave the
   *  branches out (`GraphBackendBase.branches`). */
  load(): Promise<void>;
  list(): Promise<ConceptBranch[]>;
  get(name: string): Promise<ConceptBranch | null>;
  create(input: { name: string; from?: "main" | "empty"; by?: string }): Promise<ConceptBranch>;
  /** The pages it removed. */
  drop(name: string): Promise<{ name: string; pages: number }>;
}

/** A refusal a route answers with its status. */
export class BranchError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "BranchError";
  }
}

export const branchNamespace = (name: string): string => `${BRANCH_NAMESPACE_PREFIX}${name}`;
export const branchNameOf = (namespace: string): string => namespace.slice(BRANCH_NAMESPACE_PREFIX.length);

/** Why `name` is not a branch name, or null. */
export function branchNameProblem(name: unknown): string | null {
  return typeof name === "string" && BRANCH_NAME.test(name) ? null : `a branch name is ${BRANCH_NAME.source}: lowercase letters, digits, - and _, a letter first`;
}

const CONCEPT = "Concept";
const PARENT_OF = "PARENT_OF";
/** Pages and links written per statement. */
const CHUNK = 200;

export interface BranchesDeps {
  dataDir: string;
  graph: GraphBackend;
  /** Whether a run on the branch is in flight in this process. */
  inFlight(name: string): boolean;
  now?: () => Date;
}

export function createBranches(deps: BranchesDeps): BranchesCapability {
  const { graph } = deps;
  const dir = join(deps.dataDir, "branches");
  const fileOf = (name: string) => join(dir, `${name}.json`);

  const read = async (name: string): Promise<ConceptBranch | null> => {
    if (branchNameProblem(name)) return null;
    try {
      return JSON.parse(await readFile(fileOf(name), "utf-8")) as ConceptBranch;
    } catch {
      return null;
    }
  };

  /** Every node in the namespace, gone: its pages and whatever rows hang off them. */
  const purge = async (ns: string): Promise<number> => {
    const at = graph.kind === "neo4j" ? "(n:Data_Bank {namespace: $ns})" : "(n:Node {namespace: $ns})";
    const [row] = await graph.query(`MATCH ${at} RETURN count(n) AS c`, { ns });
    const count = Number(row?.["c"] ?? 0);
    if (count) await graph.tx((tx) => tx.run(`MATCH ${at} DETACH DELETE n`, { ns }));
    return count;
  };

  /** The live tree, copied into `ns`. */
  const copy = async (ns: string): Promise<{ pages: number; links: number }> => {
    const schema = await graph.schemas.schema(CONCEPT);
    if (!schema) throw new BranchError(409, "this graph has no Concept type to copy");
    const d = graph.dialect;
    // Every attribute of the page but its source stamp: a copy is nobody's seed or package.
    const fields = [...new Set(["ref_id", "name", ...Object.keys(schema.attributes)])].filter((f) => f !== "unique_source_id");
    const rows = await graph.query(`MATCH ${d.node("c", CONCEPT, { namespace: "$ns" })} WHERE ${d.live("c")} RETURN ${d.project("c", fields)} AS p`, { ns: graph.namespace });
    const pages = rows
      .map((r) => r["p"] as Record<string, unknown>)
      .filter((p) => typeof p["name"] === "string" && p["name"])
      .map((p) => {
        const data: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(p)) if (k !== "ref_id" && v !== null && v !== undefined) data[k] = v;
        return { from: String(p["ref_id"]), data };
      });
    const to = new Map<string, string>();
    for (let i = 0; i < pages.length; i += CHUNK) {
      const chunk = pages.slice(i, i + CHUNK);
      const out = await graph.nodes.writeMany(chunk.map((p) => ({ type: CONCEPT, data: p.data })), "upsert", { namespace: ns, embed: "later" });
      chunk.forEach((p, k) => to.set(p.from, out[k]!.ref_id));
    }
    const ups = await graph.query(
      `MATCH ${d.node("p", CONCEPT, { namespace: "$ns" })}-[r:\`${PARENT_OF}\`]->${d.node("c", CONCEPT, { namespace: "$ns" })}
       WHERE ${d.edgeLive("r")} AND ${d.live("p")} AND ${d.live("c")} RETURN p.ref_id AS p, c.ref_id AS c`,
      { ns: graph.namespace },
    );
    const links = ups
      .map((r) => ({ source_ref_id: to.get(String(r["p"])), target_ref_id: to.get(String(r["c"])) }))
      .filter((l): l is { source_ref_id: string; target_ref_id: string } => !!l.source_ref_id && !!l.target_ref_id);
    for (let i = 0; i < links.length; i += CHUNK) {
      await graph.edges.writeMany(links.slice(i, i + CHUNK).map((l) => ({ edge: PARENT_OF, ...l })));
    }
    return { pages: pages.length, links: links.length };
  };

  /** Whether the graph holds a branch: set before a create writes a page,
   *  read again from the records once a drop or a failed create is done. */
  const mark = async (held?: boolean) => {
    if (graph.branches) graph.branches.held = held ?? (await cap.list()).length > 0;
  };

  const cap: BranchesCapability = {
    load: () => mark(),

    async list() {
      let names: string[];
      try {
        names = (await readdir(dir)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
      } catch {
        return [];
      }
      const out = (await Promise.all(names.map(read))).filter((b): b is ConceptBranch => b !== null);
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },

    get: read,

    async create({ name, from = "main", by }) {
      const problem = branchNameProblem(name);
      if (problem) throw new BranchError(400, problem);
      if (from !== "main" && from !== "empty") throw new BranchError(400, `from is "main" (a copy of the live tree) or "empty"`);
      return withLock(`branch:${name}`, async () => {
        if (await read(name)) throw new BranchError(409, `branch "${name}" exists — drop it first, or pick another name`);
        const namespace = branchNamespace(name);
        // A Neo4j graph searches a registered namespace only.
        await graph.reader.registerNamespace(namespace);
        // What a create cut off before its record left behind.
        await purge(namespace);
        await mark(true);
        let made: { pages: number; links: number };
        try {
          made = from === "main" ? await copy(namespace) : { pages: 0, links: 0 };
        } catch (err) {
          await purge(namespace).catch(() => {});
          await mark().catch(() => {});
          throw err;
        }
        const branch: ConceptBranch = {
          name,
          namespace,
          createdAt: (deps.now?.() ?? new Date()).toISOString(),
          ...(by ? { createdBy: by } : {}),
          from,
          ...made,
        };
        await mkdir(dir, { recursive: true });
        await writeFile(`${fileOf(name)}.tmp`, JSON.stringify(branch, null, 2) + "\n", "utf-8");
        await rename(`${fileOf(name)}.tmp`, fileOf(name));
        return branch;
      });
    },

    async drop(name) {
      return withLock(`branch:${name}`, async () => {
        const branch = await read(name);
        if (!branch) throw new BranchError(404, `no branch "${name}"`);
        if (deps.inFlight(name)) throw new BranchError(409, `branch "${name}" has a run in flight — drop it once the run ends (or cancel it)`);
        // The record first: a run that starts from here on finds no branch.
        await unlink(fileOf(name));
        const pages = await purge(branch.namespace);
        if (graph.kind === "neo4j") {
          await graph.tx((tx) => tx.run(`MATCH (s:NameSpace) SET s.data = [x IN coalesce(s.data, []) WHERE x <> $ns]`, { ns: branch.namespace }));
        }
        await mark();
        return { name, pages };
      });
    },
  };
  return cap;
}

// ── a run's view ──────────────────────────────────────────────────────────

/** The branch a services bag is already bound to (`bindBranch`), by name:
 *  what a run launched with a bound bag (a step's `ctx.services`) is on. */
export function branchOfServices(services: unknown): string | undefined {
  const ns = branchOf((services as { graph?: unknown } | null | undefined)?.graph);
  return ns ? branchNameOf(ns) : undefined;
}

/**
 * The run's view of the bag on `branch` (one seam, beside `bindPrincipal`
 * and `bindGraph` in the runner): the graph's Concepts are the branch's
 * (src/graph/branch.ts), so are the Knowledge door's pages, and the
 * automation steps schedule nothing (a fire is a run of its own, on the live
 * tree). On every run, on a branch or not, a conversation stays on the
 * branch its first turn ran on (`sessions`). The consumer's bag is never
 * mutated.
 */
export function bindBranch<TServices>(services: TServices, branch: string | undefined): TServices {
  if (services == null || typeof services !== "object") return services;
  const bag = services as Record<string, unknown>;
  const out: Record<string, unknown> = { ...bag };
  const sessions = bag["sessions"] as SessionsCapability | undefined;
  if (typeof sessions?.open === "function") out["sessions"] = sessionsOn(sessions, branch);
  if (branch) {
    const ns = branchNamespace(branch);
    if (bag["graph"]) out["graph"] = onBranch(bag["graph"] as GraphBackend, ns);
    const knowledge = bag["knowledge"] as KnowledgeCapability | undefined;
    if (knowledge) out["knowledge"] = knowledge.onBranch ? knowledge.onBranch(ns) : undefined;
    const automations = bag["automations"] as { api?: Record<string, unknown> } | undefined;
    if (automations?.api) {
      const refuse = async () => {
        throw new Error(`this run is on Concept branch "${branch}": it does not schedule — an automation's fires are runs of their own, on the live tree`);
      };
      out["automations"] = { ...automations, api: { ...automations.api, create: refuse, update: refuse, fire: refuse } };
    }
  }
  return out as TServices;
}

/** The sessions a run on `branch` (none: main) opens: one whose first turn
 *  ran on another is refused, and each turn it commits says its branch. */
function sessionsOn(sessions: SessionsCapability, branch: string | undefined): SessionsCapability {
  const where = (b: string | undefined) => (b ? `branch "${b}"` : "main");
  return {
    holder: (id) => sessions.holder(id),
    async open(id, holder) {
      const s = await sessions.open(id, holder);
      const first = s.turns[0];
      if (first && first.branch !== branch) {
        s.release();
        throw new Error(`session_branch: conversation "${id}" is on ${where(first.branch)}, where its first turn ran; this run is on ${where(branch)} — a conversation stays on its first turn's branch`);
      }
      return branch ? { ...s, commit: (turn) => s.commit({ ...turn, record: { ...turn.record, branch } }) } : s;
    },
  };
}
