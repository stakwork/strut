import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import type { GraphBackend } from "./graph/backend.js";
import type { NodeSchema } from "./graph/schema-resolver.js";
import { composeNodeKey } from "./graph/node-writer.js";

/**
 * Concept files → `Concept` nodes: graph DATA shipped in git, on either
 * engine (Neo4j, or a LadybugDB file).
 *
 * A SET is one directory of `<Name>.md` files and the source prefix its
 * nodes are stamped with (`strut/concepts/`). A file is one Concept: front
 * matter `description` (one line) and optional `parent` (another Concept's
 * name — a file of any set in the same call, or a node already in the
 * graph), body = `docs`. Strut seeds its own set (`STRUT_CONCEPTS`: the
 * `Workflow Builder` page the builder's prompt reads, the `Job` page the job
 * agent opens first) at boot; a host seeds its own sets with the same call
 * once `createStrut` returned, so a page of its own can hang under one of
 * strut's.
 *
 * Reconciled like the workflow seeders, on the node instead of a version:
 * every seeded Concept carries `unique_source_id =
 * <prefix><file>@<sha256[0..12]>` of the file it came from.
 *   - no node under that name → create;
 *   - the same stamp, node live → keep: nothing written, so an edit made in
 *     the graph stays until the committed file changes;
 *   - our path, node DELETED → upsert, which restores it: a Concept the
 *     files ship is in the graph, whoever deleted it there. To be rid of one
 *     for good, retire the file, or take the node over (clear its stamp);
 *   - our path with an older hash → upsert description + docs (a changed
 *     template wins, as for workflows);
 *   - no stamp, or someone else's → skip, never touched: a Concept a person
 *     made under that name, or took over by clearing the stamp, is theirs.
 * "Our path" is `<prefix><file>@`, or the same file under one of the set's
 * `legacyPrefixes` — the stamp another seeder wrote before this one shipped
 * the file. A legacy stamp with the same hash is the same text: kept, the
 * stamp left as it is until the file changes.
 *
 * The edges, over the Concepts a call OWNS (create / update / keep):
 *   - `PARENT_OF`: each owned Concept's `parent` is merged after the nodes
 *     (idempotent). A `PARENT_OF` between two owned Concepts that no file
 *     declares is REMOVED. An edge with anyone else's Concept at either end
 *     is never touched.
 *   - nothing else: anchoring a page to whatever the host keeps (hive's
 *     workspace node) is the host's, from the outcomes this returns.
 *
 * RETIRED files: a set lists the files it USED to ship. A node under that
 * name still carrying that file's stamp is soft-deleted (`deleted_at`, its
 * edges removed); one whose stamp was cleared or replaced is left alone.
 *
 * No graph, or a Neo4j with no `Concept` schema (seed the ontology:
 * `STRUT_GRAPH_SEED_ONTOLOGY=1`): nothing seeded, one log line.
 */

const TYPE = "Concept";
const EDGE = "PARENT_OF";

export interface ConceptSet {
  /** A directory of `<Name>.md` files. */
  dir: string;
  /** What `unique_source_id` starts with, e.g. `strut/concepts/`. */
  prefix: string;
  /** Prefixes this set's files were stamped with by an earlier seeder: a
   *  node under one counts as this set's own. */
  legacyPrefixes?: string[];
  /** Files this set used to ship (`<Name>.md`): their nodes are retired. */
  retired?: string[];
}

export interface ConceptFile {
  /** The file's basename without `.md` — the Concept's `name` (its identity). */
  name: string;
  description?: string;
  parent?: string;
  docs?: string;
  /** What `unique_source_id` carries: `<prefix><file>@<hash>`. */
  stamp: string;
}

/** create / update write the node; keep is ours and unchanged; skip is not ours to touch. */
export type SeedAction = "create" | "update" | "keep" | "skip";

export interface ExistingConcept {
  ref_id: string;
  unique_source_id?: unknown;
  /** `deleted_at` set or `is_deleted` true. */
  deleted?: boolean;
}

/** One seeded file: what was done, and the node (absent when it failed). */
export interface ConceptSeedOutcome {
  name: string;
  action: SeedAction | "error";
  ref_id?: string;
  error?: string;
}

/** The pages strut ships (`src/concepts/`). Before strut shipped them the
 *  stakgraph lab seeded the same two files, under its own prefixes. */
export const STRUT_CONCEPTS: ConceptSet = {
  dir: fileURLToPath(new URL("./concepts/", import.meta.url)),
  prefix: "strut/concepts/",
  legacyPrefixes: ["lab/builder/concepts/", "lab/job/concepts/"],
};

export function stampOf(file: string, text: string, prefix: string): string {
  return `${prefix}${file}@${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
}

/** Pure: one `<Name>.md` (optional YAML front matter, body = docs) → its Concept. */
export function parseConceptFile(file: string, text: string, prefix: string): ConceptFile {
  const name = file.replace(/\.md$/i, "");
  let body = text;
  let meta: Record<string, unknown> = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (m) {
    body = text.slice(m[0].length);
    const loaded = yaml.load(m[1]!);
    if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) meta = loaded as Record<string, unknown>;
  }
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const description = str(meta["description"]);
  const parent = str(meta["parent"]);
  const docs = body.trim() || undefined;
  return {
    name,
    ...(description ? { description } : {}),
    ...(parent ? { parent } : {}),
    ...(docs ? { docs } : {}),
    stamp: stampOf(file, text, prefix),
  };
}

/** Pure: the reconcile rule in the module comment. `legacy` are the file's
 *  earlier paths, `<prefix><file>@`. */
export function planConceptSeed(existing: ExistingConcept | null, stamp: string, legacy: readonly string[] = []): SeedAction {
  if (!existing) return "create";
  const usid = typeof existing.unique_source_id === "string" ? existing.unique_source_id : undefined;
  const at = stamp.lastIndexOf("@") + 1;
  const ours = usid !== undefined && [stamp.slice(0, at), ...legacy].some((path) => usid.startsWith(path));
  if (existing.deleted) return ours ? "update" : "skip"; // an upsert restores a deleted node
  if (!ours) return "skip";
  return usid!.slice(usid!.lastIndexOf("@") + 1) === stamp.slice(at) ? "keep" : "update";
}

const pathsOf = (set: ConceptSet, file: string): string[] => [set.prefix, ...(set.legacyPrefixes ?? [])].map((p) => `${p}${file}@`);

export async function seedConcepts(graph: GraphBackend | undefined, sets: ConceptSet[]): Promise<ConceptSeedOutcome[]> {
  if (!graph) {
    console.log("[concepts] no graph: Concept files not seeded");
    return [];
  }
  const schema = await graph.schemas.schema(TYPE);
  if (!schema) {
    console.log(`[concepts] no "${TYPE}" schema in the graph (seed the ontology: STRUT_GRAPH_SEED_ONTOLOGY=1): Concept files not seeded`);
    return [];
  }
  const outcomes: ConceptSeedOutcome[] = [];
  const refs = new Map<string, string>(); // every live node under a seeded name, for parenting
  const owned = new Map<string, string>(); // name → ref_id: the ones the seed wrote or keeps
  const parsed: ConceptFile[] = [];
  for (const set of sets) {
    let files: string[];
    try {
      files = (await readdir(set.dir)).filter((f) => f.endsWith(".md")).sort();
    } catch (err) {
      console.warn(`[concepts] could not read ${set.dir}:`, err instanceof Error ? err.message : err);
      continue;
    }
    for (const file of files) {
      let name = file.replace(/\.md$/i, "");
      try {
        const c = parseConceptFile(file, await readFile(join(set.dir, file), "utf-8"), set.prefix);
        name = c.name;
        parsed.push(c);
        const existing = await findConcept(graph, schema, c.name);
        const action = planConceptSeed(existing, c.stamp, pathsOf(set, file).slice(1));
        if (action === "keep" || action === "skip") {
          if (!existing!.deleted) refs.set(c.name, existing!.ref_id); // a deleted node is nobody's parent
          if (action === "keep") owned.set(c.name, existing!.ref_id);
          outcomes.push({ name: c.name, action, ref_id: existing!.ref_id });
          continue;
        }
        const data = {
          name: c.name,
          ...(c.description ? { description: c.description } : {}),
          ...(c.docs ? { docs: c.docs } : {}),
          unique_source_id: c.stamp,
        };
        const r = await graph.nodes.write({ type: TYPE, data }, action === "create" ? "create" : "upsert");
        refs.set(c.name, r.ref_id);
        owned.set(c.name, r.ref_id);
        outcomes.push({ name: c.name, action, ref_id: r.ref_id });
        console.log(`[concepts] ${action === "create" ? "seeded" : "updated"} Concept: ${c.name} (${r.outcome})`);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        outcomes.push({ name, action: "error", error });
        console.warn(`[concepts] could not seed Concept from "${file}":`, error);
      }
    }
  }
  for (const set of sets) {
    for (const file of set.retired ?? []) {
      const name = file.replace(/\.md$/i, "");
      try {
        const existing = await findConcept(graph, schema, name);
        const usid = existing?.unique_source_id;
        if (!existing || existing.deleted || typeof usid !== "string" || !pathsOf(set, file).some((p) => usid.startsWith(p))) continue;
        // Guarded on the stamp: a node taken over since it was read is left alone.
        if (await graph.nodeEngine.softDelete(existing.ref_id, graph.namespace, { type: schema.type, props: { unique_source_id: usid } })) {
          console.log(`[concepts] retired Concept: ${name}`);
        }
      } catch (err) {
        console.warn(`[concepts] could not retire Concept "${name}":`, err instanceof Error ? err.message : err);
      }
    }
  }
  const declared = new Set<string>(); // `<parent ref_id>><child ref_id>`, as the files have it
  for (const c of parsed) {
    if (!c.parent || !owned.has(c.name)) continue;
    try {
      const child = owned.get(c.name)!;
      let parent = refs.get(c.parent);
      if (!parent) {
        const found = await findConcept(graph, schema, c.parent);
        if (found && !found.deleted) parent = found.ref_id;
      }
      if (!parent) {
        console.warn(`[concepts] no live Concept "${c.parent}" to parent "${c.name}" under`);
        continue;
      }
      declared.add(`${parent}>${child}`); // before the write: a failed write must not read as "undeclared"
      const e = await graph.edges.write({ edge: EDGE, source_ref_id: parent, target_ref_id: child });
      if (e.created) console.log(`[concepts] linked ${c.parent} -${EDGE}-> ${c.name}`);
    } catch (err) {
      console.warn(`[concepts] could not parent "${c.name}" under "${c.parent}":`, err instanceof Error ? err.message : err);
    }
  }
  // Between two Concepts we own, the files are the whole truth.
  const names = new Map([...owned].map(([name, ref]) => [ref, name]));
  for (const [parentName, parent] of owned) {
    try {
      const out = await graph.tx((tx) => graph.edgeEngine.liveEdgesOf(tx, parent, EDGE, true));
      for (const e of out?.edges ?? []) {
        if (!names.has(e.other) || declared.has(`${parent}>${e.other}`)) continue;
        await graph.edges.delete(e.edge_ref_id);
        console.log(`[concepts] unlinked ${parentName} -${EDGE}-> ${names.get(e.other)} (no file declares it)`);
      }
    } catch (err) {
      console.warn(`[concepts] could not reconcile ${EDGE} edges under "${parentName}":`, err instanceof Error ? err.message : err);
    }
  }
  return outcomes;
}

/** The node under this name in the backend's namespace, deleted or not. */
async function findConcept(graph: GraphBackend, schema: NodeSchema, name: string): Promise<ExistingConcept | null> {
  const key = composeNodeKey(schema, { name });
  return graph.tx(async (tx) => {
    const ref = await graph.nodeEngine.refByKey(tx, schema.type, key, graph.namespace);
    const raw = ref ? await graph.nodeEngine.readRaw(tx, ref) : null;
    if (!raw) return null;
    const p = raw.props;
    return { ref_id: raw.ref_id, unique_source_id: p["unique_source_id"], deleted: p["deleted_at"] != null || p["is_deleted"] === true };
  });
}
