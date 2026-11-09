import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import type { GraphBackend } from "./graph/backend.js";
import type { NodeSchema } from "./graph/schema-resolver.js";
import { composeNodeKey } from "./graph/node-writer.js";
import { GENERIC_NODE_PROPERTIES } from "./graph/strut-schemas.js";
import { dumpYaml } from "./yaml.js";

/**
 * Concept files → `Concept` nodes: graph DATA shipped in git, on either
 * engine (Neo4j, or a LadybugDB file).
 *
 * A SET is one directory of `.md` pages and the source prefix its nodes are
 * stamped with (`strut/concepts/`). A page is one Concept, in one of two
 * forms (plans/concept-history.md §2.1), told apart by `name` in the front
 * matter:
 *   - the OLD form, `<Name>.md`: the file's basename is the Concept's name,
 *     front matter `description` (one line) and an optional `parent`. Strut's
 *     own pages (`src/concepts/`) and every package published before the
 *     new form are written this way, and read as they always were;
 *   - the NEW form, any file name (a build writes `<key>.md`, the node key
 *     `composeNodeKey` makes of the name): front matter `name` — the
 *     Concept's identity, `/` and all — then every attribute the page sets,
 *     then `parents`, the names of every parent. Strut's stamps and what the
 *     graph derives (`ref_id`, the key, search text, vectors, times) are
 *     never attributes (`NOT_ATTRIBUTES`).
 * Either way the body is `docs`, and a parent is another Concept's name — a
 * page of any set in the same call, or a node already in the graph. Strut
 * seeds its own set (`STRUT_CONCEPTS`: the `Workflow Builder` page the
 * builder's prompt reads, the `Job` page the job workflow puts in its
 * agent's prompt) at boot; a host seeds its own sets with the same call once
 * `createStrut` returned, so a page of its own can hang under one of
 * strut's. An attribute the graph's `Concept` does not declare is left out,
 * one log line naming it.
 *
 * Reconciled like the workflow seeders, on the node instead of a version,
 * and like them a seed always matches git: every seeded Concept carries
 * `unique_source_id = <prefix><file>@<sha256[0..12]>` of the file it came
 * from.
 *   - no node under that name → create;
 *   - the same stamp, node live, its text the file's → keep: nothing
 *     written;
 *   - the same stamp, its text edited in the graph → upsert the page's
 *     attributes + docs: every boot puts the file's text back (a field the
 *     file does not set is not the seed's, and is left as it is);
 *   - our path, node DELETED → upsert, which restores it: a Concept the
 *     files ship is in the graph, whoever deleted it there. To be rid of one
 *     for good, retire the file, or take the node over (clear its stamp);
 *   - our path with an older hash → upsert (a changed template wins, as for
 *     workflows);
 *   - no stamp, or someone else's → skip, never touched: a Concept a person
 *     made under that name, or took over by clearing the stamp, is theirs.
 * "Our path" is `<prefix><file>@`, or the same file under one of the set's
 * `legacyPrefixes` — the stamp another seeder wrote before this one shipped
 * the file. A legacy stamp with the same hash is the same text: kept, the
 * stamp left as it is until the file changes. In a PACKAGE's set
 * (`keepEdited`) any file of the set is our path: a page is its name there,
 * so one a release moved to another file (the old form's `Name.md` rebuilt
 * as the new form's key) is the same page, written again.
 *
 * The edges, over the Concepts a call OWNS (create / update / keep):
 *   - `PARENT_OF`: one from each of an owned Concept's parents, merged after
 *     the nodes (idempotent). A `PARENT_OF` between two owned Concepts that
 *     no page declares is REMOVED. An edge with anyone else's Concept at
 *     either end is never touched — a package's page under strut's `Job`
 *     keeps its edge through strut's every boot.
 *   - nothing else: anchoring a page to whatever the host keeps (hive's
 *     workspace node) is the host's, from the outcomes this returns.
 *
 * RETIRED files: a set lists the files it USED to ship. A node under that
 * name still carrying that file's stamp is soft-deleted (`deleted_at`, its
 * edges removed); one whose stamp was cleared or replaced is left alone.
 *
 * No graph, or one with no `Concept` schema (both engines seed it,
 * `graph/seed-types.ts`; a backend opened with `skipBoot` may not have it):
 * nothing seeded, one log line.
 */

const TYPE = "Concept";
const EDGE = "PARENT_OF";

export interface ConceptSet {
  /** A directory of `.md` pages, in either form. */
  dir: string;
  /** What `unique_source_id` starts with, e.g. `strut/concepts/`. */
  prefix: string;
  /** Prefixes this set's files were stamped with by an earlier seeder: a
   *  node under one counts as this set's own. */
  legacyPrefixes?: string[];
  /** Files this set used to ship (`<Name>.md`): their nodes are retired. */
  retired?: string[];
  /** A PACKAGE's set (plans/marketplace.md §3), where a boot seed's rules
   *  bend two ways: a page of ours whose text was edited in the graph is
   *  KEPT and reported (`edited` on its outcome) — the person's edit, never
   *  overwritten — and a deleted node under a page's name is taken whoever
   *  stamped it, since the install checked every live name first. */
  keepEdited?: boolean;
}

export interface ConceptFile {
  /** The Concept's `name`, its identity: the front matter's `name` (the new
   *  form), else the file's basename without `.md` (the old form). */
  name: string;
  /** `attributes.description`, when it is a string: what every reader shows. */
  description?: string;
  /** What the page sets besides its name, parents and docs: the new form's
   *  every attribute, the old form's `description`. */
  attributes: Record<string, unknown>;
  /** Every parent, by name: the new form's `parents`, the old form's one `parent`. */
  parents: string[];
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
  /** The node's attributes (`description`, `docs`, …), as the graph holds them now. */
  [attribute: string]: unknown;
}

/** One seeded file: what was done, and the node (absent when it failed). */
export interface ConceptSeedOutcome {
  name: string;
  /** The page's file in its set. */
  file: string;
  action: SeedAction | "error";
  ref_id?: string;
  error?: string;
  /** Kept although its text is not the file's (`keepEdited`). */
  edited?: true;
}

/** The pages strut ships (`src/concepts/`). Before strut shipped them the
 *  stakgraph lab seeded the same two files, under its own prefixes.
 *  `Workflow Build` was the builder's entry under `Job`, there only because
 *  the orchestrator read `Job` alone; it reads both roots now, and the job
 *  agent's way to the builder is in `Job`'s own docs. `Job App` (an app a
 *  job wrote in its own directory, plans/apps.md §6) was a third way to an
 *  app, retired 2026-10-22: a page over a job's results is an HTML file in
 *  its directory, and an app is the builder's, published and handed over
 *  by name (`{ kind: "app", app }`, artifact-refs.ts). */
export const STRUT_CONCEPTS: ConceptSet = {
  dir: fileURLToPath(new URL("./concepts/", import.meta.url)),
  prefix: "strut/concepts/",
  legacyPrefixes: ["lab/builder/concepts/", "lab/job/concepts/"],
  retired: ["Workflow Build.md", "Job App.md"],
};

/** The root page's name (src/concepts/personal/Personal.md). */
export const PERSONAL_ROOT = "Personal";

/** The root of a PERSON's own knowledge (`Personal`,
 *  src/concepts/personal/): the page a personal graph's assistant starts
 *  from, with every page they teach it under it. A host with a personal
 *  graph seeds it (`createStrut`'s `concepts: { personal: true }`); a
 *  company graph's roots are its own. Like strut's pages it always
 *  matches git: what the person teaches lives in the pages under it. */
export const PERSONAL_CONCEPTS: ConceptSet = {
  dir: fileURLToPath(new URL("./concepts/personal/", import.meta.url)),
  prefix: "strut/concepts/personal/",
};

export function stampOf(file: string, text: string, prefix: string): string {
  return `${prefix}${file}@${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
}

/** What a page never carries as an attribute: its name, parents and docs
 *  (the front matter's own fields and the body), and what the graph or a
 *  seeder stamps or derives (`GENERIC_NODE_PROPERTIES`: the ref_id, the key,
 *  the namespace, search text, vectors, times; the title; the source stamp;
 *  the delete markers). */
export const NOT_ATTRIBUTES: ReadonlySet<string> = new Set(["name", "parents", "docs", "title", "unique_source_id", "deleted_at", "node_type", ...GENERIC_NODE_PROPERTIES]);

/** Pure: one page, in either form (optional YAML front matter, body =
 *  docs) → its Concept. Throws on a new-form page whose `name` or `parents`
 *  are not names. */
export function parseConceptFile(file: string, text: string, prefix: string): ConceptFile {
  let body = text;
  let meta: Record<string, unknown> = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (m) {
    body = text.slice(m[0].length);
    const loaded = yaml.load(m[1]!);
    if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) meta = loaded as Record<string, unknown>;
  }
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const docs = body.trim() || undefined;
  const stamp = stampOf(file, text, prefix);
  if (!("name" in meta)) {
    // The old form: the file names the page; a description and one parent.
    const description = str(meta["description"]);
    const parent = str(meta["parent"]);
    return {
      name: file.replace(/\.md$/i, ""),
      ...(description ? { description } : {}),
      attributes: description ? { description } : {},
      parents: parent ? [parent] : [],
      ...(docs ? { docs } : {}),
      stamp,
    };
  }
  const name = meta["name"];
  if (typeof name !== "string" || !name.trim()) throw new Error(`a page's name is a string (quote one that YAML would read as a number or a date)`);
  const listed = meta["parents"] === undefined || meta["parents"] === null ? [] : Array.isArray(meta["parents"]) ? meta["parents"] : [meta["parents"]];
  if (listed.some((p) => typeof p !== "string" || !p.trim())) throw new Error("parents is a list of Concept names");
  const attributes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) if (!NOT_ATTRIBUTES.has(k) && v !== null && v !== undefined && v !== "") attributes[k] = v;
  const description = typeof attributes["description"] === "string" ? (attributes["description"] as string) : undefined;
  return {
    name,
    ...(description ? { description } : {}),
    attributes,
    parents: [...new Set(listed as string[])],
    ...(docs ? { docs } : {}),
    stamp,
  };
}

/** Pure: a Concept as a new-form page — front matter `name`, the
 *  attributes by name, `parents` sorted; the body `docs`. What a package
 *  build writes, and what `parseConceptFile` reads back as it was. */
export function renderConceptPage(page: { name: string; attributes: Record<string, unknown>; parents: readonly string[]; docs?: string }): string {
  const front: Record<string, unknown> = { name: page.name };
  for (const k of Object.keys(page.attributes).sort()) if (!NOT_ATTRIBUTES.has(k)) front[k] = page.attributes[k];
  if (page.parents.length) front["parents"] = [...new Set(page.parents)].sort();
  return `---\n${dumpYaml(front)}---\n${page.docs ? `${page.docs}\n` : ""}`;
}

/** The page's attributes the graph's `Concept` declares, and the names of
 *  those it does not (left out of the write). */
export function declaredAttributes(schema: Pick<NodeSchema, "attributes">, attributes: Record<string, unknown>): { kept: Record<string, unknown>; left: string[] } {
  const kept: Record<string, unknown> = {};
  const left: string[] = [];
  for (const [k, v] of Object.entries(attributes)) {
    if (k in schema.attributes) kept[k] = v;
    else left.push(k);
  }
  return { kept, left: left.sort() };
}

const sameValue = (a: unknown, b: unknown): boolean => a === b || (typeof a === "object" && typeof b === "object" && JSON.stringify(a) === JSON.stringify(b));

/** Is the node's text not the file's? Every attribute the file carries and
 *  its docs are compared; a field the file does not set is not the file's
 *  to compare. */
export function conceptEdited(existing: Record<string, unknown>, file: Pick<ConceptFile, "attributes" | "docs">): boolean {
  if (file.docs !== undefined && existing["docs"] !== file.docs) return true;
  return Object.entries(file.attributes).some(([k, v]) => !sameValue(existing[k], v));
}

/** Pure: the reconcile rule in the module comment. `legacy` are the file's
 *  earlier paths, `<prefix><file>@`; `file` is the file's text — when given,
 *  a page of ours whose text was edited in the graph is put back, or with
 *  `keepEdited` kept (see `ConceptSet.keepEdited`). `anyFileOf`, a package
 *  set's prefix: a stamp of any of its files is ours, and one of another
 *  file is written again. */
export function planConceptSeed(
  existing: ExistingConcept | null,
  stamp: string,
  legacy: readonly string[] = [],
  file?: Pick<ConceptFile, "attributes" | "docs">,
  keepEdited = false,
  anyFileOf?: string,
): SeedAction {
  if (!existing) return "create";
  const usid = typeof existing.unique_source_id === "string" ? existing.unique_source_id : undefined;
  const at = stamp.lastIndexOf("@") + 1;
  const samePath = usid !== undefined && [stamp.slice(0, at), ...legacy].some((path) => usid.startsWith(path));
  const ours = samePath || (usid !== undefined && anyFileOf !== undefined && usid.startsWith(anyFileOf));
  if (existing.deleted) return ours || keepEdited ? "update" : "skip"; // an upsert restores a deleted node
  if (!ours) return "skip";
  if (!samePath || usid!.slice(usid!.lastIndexOf("@") + 1) !== stamp.slice(at)) return "update";
  return file && conceptEdited(existing, file) && !keepEdited ? "update" : "keep";
}

const pathsOf = (set: ConceptSet, file: string): string[] => [set.prefix, ...(set.legacyPrefixes ?? [])].map((p) => `${p}${file}@`);

export async function seedConcepts(graph: GraphBackend | undefined, sets: ConceptSet[]): Promise<ConceptSeedOutcome[]> {
  if (!graph) {
    console.log("[concepts] no graph: Concept files not seeded");
    return [];
  }
  const schema = await graph.schemas.schema(TYPE);
  if (!schema) {
    console.log(`[concepts] no "${TYPE}" schema in the graph: Concept files not seeded`);
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
        const read = parseConceptFile(file, await readFile(join(set.dir, file), "utf-8"), set.prefix);
        name = read.name;
        // What this graph's Concept does not declare is not written, and not compared.
        const { kept, left } = declaredAttributes(schema, read.attributes);
        if (left.length) console.warn(`[concepts] ${name}: left out ${left.join(", ")} — this graph's ${TYPE} does not declare ${left.length === 1 ? "it" : "them"}`);
        const c = { ...read, attributes: kept };
        parsed.push(c);
        const existing = await findConcept(graph, schema, c.name);
        const action = planConceptSeed(existing, c.stamp, pathsOf(set, file).slice(1), c, set.keepEdited, set.keepEdited ? set.prefix : undefined);
        if (action === "keep" || action === "skip") {
          if (!existing!.deleted) refs.set(c.name, existing!.ref_id); // a deleted node is nobody's parent
          if (action === "keep") owned.set(c.name, existing!.ref_id);
          const edited = action === "keep" && conceptEdited(existing!, c);
          outcomes.push({ name: c.name, file, action, ref_id: existing!.ref_id, ...(edited ? { edited: true as const } : {}) });
          continue;
        }
        const data = {
          name: c.name,
          ...c.attributes,
          ...(c.docs ? { docs: c.docs } : {}),
          unique_source_id: c.stamp,
        };
        const r = await graph.nodes.write({ type: TYPE, data }, action === "create" ? "create" : "upsert");
        refs.set(c.name, r.ref_id);
        owned.set(c.name, r.ref_id);
        outcomes.push({ name: c.name, file, action, ref_id: r.ref_id });
        console.log(`[concepts] ${action === "create" ? "seeded" : "updated"} Concept: ${c.name} (${r.outcome})`);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        outcomes.push({ name, file, action: "error", error });
        console.warn(`[concepts] could not seed Concept from "${file}":`, error);
      }
    }
  }
  for (const set of sets) await retireConcepts(graph, schema, set);
  const declared = new Set<string>(); // `<parent ref_id>><child ref_id>`, as the files have it
  for (const c of parsed) {
    const child = owned.get(c.name);
    if (!child) continue;
    for (const parentName of c.parents) {
      try {
        let parent = refs.get(parentName);
        if (!parent) {
          const found = await findConcept(graph, schema, parentName);
          if (found && !found.deleted) parent = found.ref_id;
        }
        if (!parent) {
          console.warn(`[concepts] no live Concept "${parentName}" to parent "${c.name}" under`);
          continue;
        }
        declared.add(`${parent}>${child}`); // before the write: a failed write must not read as "undeclared"
        const e = await graph.edges.write({ edge: EDGE, source_ref_id: parent, target_ref_id: child });
        if (e.created) console.log(`[concepts] linked ${parentName} -${EDGE}-> ${c.name}`);
      } catch (err) {
        console.warn(`[concepts] could not parent "${c.name}" under "${parentName}":`, err instanceof Error ? err.message : err);
      }
    }
  }
  // Between two Concepts we own, the files are the whole truth.
  const names = new Map([...owned].map(([name, ref]) => [ref, name]));
  for (const [parentName, parent] of owned) {
    try {
      const out = await graph.tx((tx) => graph.edgeEngine.liveEdgesOf(tx, parent, EDGE, true));
      for (const e of out?.edges ?? []) {
        if (!names.has(e.other) || declared.has(`${parent}>${e.other}`)) continue;
        await graph.edges.delete({ ref_id: e.edge_ref_id, edge: EDGE });
        console.log(`[concepts] unlinked ${parentName} -${EDGE}-> ${names.get(e.other)} (no file declares it)`);
      }
    } catch (err) {
      console.warn(`[concepts] could not reconcile ${EDGE} edges under "${parentName}":`, err instanceof Error ? err.message : err);
    }
  }
  return outcomes;
}

/** Soft-delete the node of each retired page that still carries its
 *  file's stamp (one taken over since — its stamp cleared or replaced — is
 *  left alone): the set's `retired` files, each named by its file (the old
 *  form), or `pages`, each page's name with its file. Returns the names
 *  retired. */
export async function retireConcepts(
  graph: GraphBackend,
  schema: NodeSchema,
  set: ConceptSet,
  pages: ReadonlyArray<{ name: string; file: string }> = (set.retired ?? []).map((file) => ({ name: file.replace(/\.md$/i, ""), file })),
): Promise<string[]> {
  const out: string[] = [];
  for (const { name, file } of pages) {
    try {
      const existing = await findConcept(graph, schema, name);
      const usid = existing?.unique_source_id;
      if (!existing || existing.deleted || typeof usid !== "string" || !pathsOf(set, file).some((p) => usid.startsWith(p))) continue;
      // Guarded on the stamp: a node taken over since it was read is left alone.
      if (await graph.nodeEngine.softDelete(existing.ref_id, graph.namespace, { type: schema.type, props: { unique_source_id: usid } })) {
        console.log(`[concepts] retired Concept: ${name}`);
        out.push(name);
      }
    } catch (err) {
      console.warn(`[concepts] could not retire Concept "${name}":`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}

/** The node under this name in the backend's namespace, deleted or not. */
export async function findConcept(graph: GraphBackend, schema: NodeSchema, name: string): Promise<ExistingConcept | null> {
  const key = composeNodeKey(schema, { name });
  return graph.tx(async (tx) => {
    const ref = await graph.nodeEngine.refByKey(tx, schema.type, key, graph.namespace);
    const raw = ref ? await graph.nodeEngine.readRaw(tx, ref) : null;
    if (!raw) return null;
    const p = raw.props;
    return {
      ...p,
      ref_id: raw.ref_id,
      unique_source_id: p["unique_source_id"],
      deleted: p["deleted_at"] != null || p["is_deleted"] === true,
    };
  });
}
