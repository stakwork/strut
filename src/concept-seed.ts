import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import type { GraphBackend } from "./graph/backend.js";
import type { RawNode } from "./graph/engine.js";
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
  /** A REPO's set (app-repos.md §3.1): a live node under a page's name that
   *  no seeder stamped — a page made here — is taken as that page and
   *  stamped, so a page put in a repo by Create repo stays the same node. */
  adopt?: boolean;
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
  adopt = false,
): SeedAction {
  if (!existing) return "create";
  const usid = typeof existing.unique_source_id === "string" && existing.unique_source_id ? existing.unique_source_id : undefined;
  const at = stamp.lastIndexOf("@") + 1;
  const samePath = usid !== undefined && [stamp.slice(0, at), ...legacy].some((path) => usid.startsWith(path));
  const ours = samePath || (usid !== undefined && anyFileOf !== undefined && usid.startsWith(anyFileOf)) || (adopt && usid === undefined);
  if (existing.deleted) return ours || keepEdited ? "update" : "skip"; // an upsert restores a deleted node
  if (!ours) return "skip";
  if (!samePath || usid!.slice(usid!.lastIndexOf("@") + 1) !== stamp.slice(at)) return "update";
  return file && conceptEdited(existing, file) && !keepEdited ? "update" : "keep";
}

const pathsOf = (set: ConceptSet, file: string): string[] => [set.prefix, ...(set.legacyPrefixes ?? [])].map((p) => `${p}${file}@`);

/** Nodes or edges per write, and keys per read: a package's tree is
 *  hundreds of pages (openlaw/legal-desk: 752), and one statement per page
 *  was most of an install. */
const CHUNK = 250;

/** How far a seed is, for a caller that shows it (a package install). */
export interface ConceptSeedProgress {
  /** `pages`: reading and writing the nodes; `edges`: the `PARENT_OF` tree. */
  phase: "pages" | "edges";
  done: number;
  total: number;
}

export interface ConceptSeedOptions {
  /** Told after each batch. */
  progress?: (p: ConceptSeedProgress) => void;
}

/** One page of the call, in file order. */
interface SeedPage {
  file: string;
  set: ConceptSet;
  /** The name, or the file's basename when it did not parse. */
  name: string;
  c?: ConceptFile;
  outcome?: ConceptSeedOutcome;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A few names for a log line. */
const someOf = (names: readonly string[], n = 5) => (names.length <= n ? names.join(", ") : `${names.slice(0, n).join(", ")} and ${names.length - n} more`);

/**
 * The module comment's reconcile, with every read and write batched: the
 * pages are read in one pass, the graph's nodes under their names in one
 * read, the creates and the updates written `CHUNK` at a time (their
 * vectors left to the backend's background embedder, `embed: "later"`),
 * the parents read in one more, the edges written `CHUNK` at a time, and
 * the undeclared ones found in one read. A batch that fails is written
 * again one page (or edge) at a time, so a failure is that page's outcome
 * alone, as it always was. A name two pages of the call share is seeded
 * after the batch, in file order, each reading what the one before wrote.
 * One log line says what was written.
 */
export async function seedConcepts(graph: GraphBackend | undefined, sets: ConceptSet[], opts: ConceptSeedOptions = {}): Promise<ConceptSeedOutcome[]> {
  if (!graph) {
    console.log("[concepts] no graph: Concept files not seeded");
    return [];
  }
  const schema = await graph.schemas.schema(TYPE);
  if (!schema) {
    console.log(`[concepts] no "${TYPE}" schema in the graph: Concept files not seeded`);
    return [];
  }
  const refs = new Map<string, string>(); // every live node under a seeded name, for parenting
  const owned = new Map<string, string>(); // name → ref_id: the ones the seed wrote or keeps
  const parsed: ConceptFile[] = [];
  const pages: SeedPage[] = [];
  const leftOut = new Map<string, string[]>(); // the attributes left out → the pages
  for (const set of sets) {
    let files: string[];
    try {
      files = (await readdir(set.dir)).filter((f) => f.endsWith(".md")).sort();
    } catch (err) {
      console.warn(`[concepts] could not read ${set.dir}:`, errorText(err));
      continue;
    }
    for (const file of files) {
      const page: SeedPage = { file, set, name: file.replace(/\.md$/i, "") };
      pages.push(page);
      try {
        const read = parseConceptFile(file, await readFile(join(set.dir, file), "utf-8"), set.prefix);
        page.name = read.name;
        // What this graph's Concept does not declare is not written, and not compared.
        const { kept, left } = declaredAttributes(schema, read.attributes);
        if (left.length) leftOut.set(left.join(", "), [...(leftOut.get(left.join(", ")) ?? []), read.name]);
        const c = { ...read, attributes: kept };
        composeNodeKey(schema, { name: c.name }); // a name with no key is this page's error, before any read
        parsed.push(c);
        page.c = c;
      } catch (err) {
        page.outcome = { name: page.name, file, action: "error", error: errorText(err) };
      }
    }
  }
  for (const [left, names] of leftOut) {
    console.warn(`[concepts] left out ${left} on ${names.length === 1 ? names[0] : `${names.length} pages (${someOf(names)})`} — this graph's ${TYPE} does not declare ${left.includes(",") ? "them" : "it"}`);
  }
  const total = pages.length;
  let settled = pages.filter((p) => p.outcome).length;
  const tell = () => opts.progress?.({ phase: "pages", done: settled, total });

  /** The rule for one page against what the graph holds under its name. */
  const plan = (page: SeedPage, existing: ExistingConcept | null): SeedAction => {
    const set = page.set;
    return planConceptSeed(existing, page.c!.stamp, pathsOf(set, page.file).slice(1), page.c!, set.keepEdited, set.keepEdited ? set.prefix : undefined, set.adopt);
  };
  /** A page kept or skipped: nothing written. */
  const leave = (page: SeedPage, existing: ExistingConcept, action: "keep" | "skip") => {
    const c = page.c!;
    if (!existing.deleted) refs.set(c.name, existing.ref_id); // a deleted node is nobody's parent
    if (action === "keep") owned.set(c.name, existing.ref_id);
    const edited = action === "keep" && conceptEdited(existing, c);
    page.outcome = { name: c.name, file: page.file, action, ref_id: existing.ref_id, ...(edited ? { edited: true as const } : {}) };
  };
  const nodeOf = (c: ConceptFile) => ({ type: TYPE, data: { name: c.name, ...c.attributes, ...(c.docs ? { docs: c.docs } : {}), unique_source_id: c.stamp } });
  const wrote = (page: SeedPage, action: "create" | "update", ref_id: string) => {
    refs.set(page.c!.name, ref_id);
    owned.set(page.c!.name, ref_id);
    page.outcome = { name: page.c!.name, file: page.file, action, ref_id };
  };
  /** One page, read and written on its own: a name another page of the
   *  call has, or a page whose batch failed. */
  const one = async (page: SeedPage, existing?: ExistingConcept | null) => {
    try {
      const found = existing !== undefined ? existing : await findConcept(graph, schema, page.c!.name);
      const action = plan(page, found);
      if (action === "keep" || action === "skip") return leave(page, found!, action);
      const r = await graph.nodes.write(nodeOf(page.c!), action === "create" ? "create" : "upsert", { embed: "later" });
      wrote(page, action, r.ref_id);
    } catch (err) {
      page.outcome = { name: page.name, file: page.file, action: "error", error: errorText(err) };
      console.warn(`[concepts] could not seed Concept from "${page.file}":`, page.outcome.error);
    }
  };

  // The first page of each name in one pass; a page whose name an earlier
  // page of the call has waits for it (`one`, after the batch).
  const seen = new Set<string>();
  const first: SeedPage[] = [];
  const again: SeedPage[] = [];
  for (const page of pages) {
    if (!page.c) continue;
    (seen.has(page.c.name) ? again : first).push(page);
    seen.add(page.c.name);
  }
  let found: Map<string, ExistingConcept> | undefined;
  try {
    found = await findConcepts(graph, schema, first.map((p) => p.c!.name));
  } catch (err) {
    // As a read per page would have: each page's error.
    for (const page of [...first, ...again]) page.outcome = { name: page.name, file: page.file, action: "error", error: errorText(err) };
    console.warn(`[concepts] could not read the Concepts under ${first.length} name(s):`, errorText(err));
  }
  if (found) {
    const writes: Record<"create" | "update", SeedPage[]> = { create: [], update: [] };
    for (const page of first) {
      const existing = found.get(page.c!.name) ?? null;
      const action = plan(page, existing);
      if (action === "keep" || action === "skip") {
        leave(page, existing!, action);
        settled++;
      } else writes[action].push(page);
    }
    tell();
    for (const action of ["create", "update"] as const) {
      const list = writes[action];
      for (let i = 0; i < list.length; i += CHUNK) {
        const chunk = list.slice(i, i + CHUNK);
        try {
          const out = await graph.nodes.writeMany(chunk.map((p) => nodeOf(p.c!)), action === "create" ? "create" : "upsert", { embed: "later" });
          chunk.forEach((p, k) => wrote(p, action, out[k]!.ref_id));
        } catch {
          // The batch is all or nothing: each page again on its own, so a
          // failure is that page's.
          for (const p of chunk) await one(p, found.get(p.c!.name) ?? null);
        }
        settled += chunk.length;
        tell();
      }
    }
    for (const page of again) {
      await one(page);
      settled++;
    }
    if (again.length) tell();
  }
  const outcomes = pages.map((p) => p.outcome!);
  for (const set of sets) await retireConcepts(graph, schema, set);

  // The tree: each owned page under each of its parents.
  const declared = new Set<string>(); // `<parent ref_id>><child ref_id>`, as the files have it
  const missing = new Set<string>();
  for (const c of parsed) if (owned.has(c.name)) for (const p of c.parents) if (!refs.has(p)) missing.add(p);
  const parentsFound = new Map<string, string>();
  if (missing.size) {
    try {
      for (const [name, node] of await findConcepts(graph, schema, missing)) if (!node.deleted) parentsFound.set(name, node.ref_id);
    } catch (err) {
      console.warn(`[concepts] could not read the parents ${someOf([...missing])}:`, errorText(err));
    }
  }
  const edges: Array<{ parentName: string; childName: string; source_ref_id: string; target_ref_id: string }> = [];
  for (const c of parsed) {
    const child = owned.get(c.name);
    if (!child) continue;
    for (const parentName of c.parents) {
      const parent = refs.get(parentName) ?? parentsFound.get(parentName);
      if (!parent) {
        console.warn(`[concepts] no live Concept "${parentName}" to parent "${c.name}" under`);
        continue;
      }
      declared.add(`${parent}>${child}`); // before the write: a failed write must not read as "undeclared"
      edges.push({ parentName, childName: c.name, source_ref_id: parent, target_ref_id: child });
    }
  }
  // What is there already, from every parent the files name (one read per
  // CHUNK): a live edge the files declare is not written again — a MERGE
  // on it would change nothing — and, between two pages we own, one no
  // file declares goes.
  const names = new Map([...owned].map(([name, ref]) => [ref, name]));
  const parentRefs = [...new Set([...owned.values(), ...edges.map((e) => e.source_ref_id)])];
  const present = new Map<string, Array<{ other: string; edge_ref_id: string }>>();
  const unread = new Set<string>();
  for (let i = 0; i < parentRefs.length; i += CHUNK) {
    const chunk = parentRefs.slice(i, i + CHUNK);
    try {
      const out = await graph.tx((tx) => graph.edgeEngine.liveEdgesOfMany(tx, chunk, EDGE, true));
      for (const ref of chunk) present.set(ref, out.get(ref)?.edges ?? []);
    } catch (err) {
      for (const ref of chunk) unread.add(ref);
      const owners = chunk.filter((r) => names.has(r)).map((r) => names.get(r)!);
      if (owners.length) console.warn(`[concepts] could not reconcile ${EDGE} edges under ${someOf(owners)}:`, errorText(err));
    }
  }
  const isThere = (e: (typeof edges)[number]) => present.get(e.source_ref_id)?.some((x) => x.other === e.target_ref_id) ?? false;
  const toWrite = edges.filter((e) => !isThere(e));
  const linked: string[] = [];
  for (let i = 0; i < toWrite.length; i += CHUNK) {
    const chunk = toWrite.slice(i, i + CHUNK);
    const input = (e: (typeof edges)[number]) => ({ edge: EDGE, source_ref_id: e.source_ref_id, target_ref_id: e.target_ref_id });
    try {
      const out = await graph.edges.writeMany(chunk.map(input));
      chunk.forEach((e, k) => out[k]!.created && linked.push(`${e.parentName} → ${e.childName}`));
    } catch {
      for (const e of chunk) {
        try {
          if ((await graph.edges.write(input(e))).created) linked.push(`${e.parentName} → ${e.childName}`);
        } catch (err) {
          console.warn(`[concepts] could not parent "${e.childName}" under "${e.parentName}":`, errorText(err));
        }
      }
    }
    opts.progress?.({ phase: "edges", done: Math.min(i + CHUNK, toWrite.length), total: toWrite.length });
  }

  // Between two Concepts we own, the files are the whole truth.
  const unlinked: string[] = [];
  for (const parent of owned.values()) {
    if (unread.has(parent)) continue;
    for (const e of present.get(parent) ?? []) {
      if (!names.has(e.other) || declared.has(`${parent}>${e.other}`)) continue;
      try {
        await graph.edges.delete({ ref_id: e.edge_ref_id, edge: EDGE });
        unlinked.push(`${names.get(parent)} → ${names.get(e.other)}`);
      } catch (err) {
        console.warn(`[concepts] could not unlink ${names.get(parent)} -${EDGE}-> ${names.get(e.other)}:`, errorText(err));
      }
    }
  }

  const of = (action: SeedAction) => outcomes.filter((o) => o.action === action).map((o) => o.name);
  const said = [
    ...(of("create").length ? [`seeded ${of("create").length} (${someOf(of("create"))})`] : []),
    ...(of("update").length ? [`updated ${of("update").length} (${someOf(of("update"))})`] : []),
    ...(linked.length ? [`linked ${linked.length} ${EDGE} (${someOf(linked, 3)})`] : []),
    ...(unlinked.length ? [`unlinked ${unlinked.length} ${EDGE} no file declares (${someOf(unlinked, 3)})`] : []),
  ];
  if (said.length) console.log(`[concepts] ${said.join("; ")}${of("keep").length ? `; ${of("keep").length} kept` : ""}`);
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
  if (!pages.length) return out;
  let found: Map<string, ExistingConcept>;
  try {
    found = await findConcepts(graph, schema, pages.map((p) => p.name));
  } catch (err) {
    console.warn(`[concepts] could not read the Concepts to retire (${someOf(pages.map((p) => p.name))}):`, errorText(err));
    return out;
  }
  for (const { name, file } of pages) {
    try {
      const existing = found.get(name);
      const usid = existing?.unique_source_id;
      if (!existing || existing.deleted || typeof usid !== "string" || !pathsOf(set, file).some((p) => usid.startsWith(p))) continue;
      // Guarded on the stamp: a node taken over since it was read is left alone.
      if (await graph.nodeEngine.softDelete(existing.ref_id, graph.namespace, { type: schema.type, props: { unique_source_id: usid } })) out.push(name);
    } catch (err) {
      console.warn(`[concepts] could not retire Concept "${name}":`, errorText(err));
    }
  }
  if (out.length) console.log(`[concepts] retired ${out.length} Concept(s): ${someOf(out)}`);
  return out;
}

/** The nodes under these names in the backend's namespace, deleted or not,
 *  by name: one read for every `CHUNK` names (`NodeEngine.readByKeys`). A
 *  name no node holds is absent. */
export async function findConcepts(graph: GraphBackend, schema: NodeSchema, names: Iterable<string>): Promise<Map<string, ExistingConcept>> {
  const keyOf = new Map<string, string>();
  for (const name of names) if (!keyOf.has(name)) keyOf.set(name, composeNodeKey(schema, { name }));
  const keys = [...new Set(keyOf.values())];
  const raws = new Map<string, RawNode>();
  for (let i = 0; i < keys.length; i += CHUNK) {
    const part = await graph.tx((tx) => graph.nodeEngine.readByKeys(tx, schema.type, keys.slice(i, i + CHUNK), graph.namespace));
    for (const [k, raw] of part) raws.set(k, raw);
  }
  const out = new Map<string, ExistingConcept>();
  for (const [name, key] of keyOf) {
    const raw = raws.get(key);
    if (!raw) continue;
    const p = raw.props;
    out.set(name, { ...p, ref_id: raw.ref_id, unique_source_id: p["unique_source_id"], deleted: p["deleted_at"] != null || p["is_deleted"] === true });
  }
  return out;
}

/** The node under this name in the backend's namespace, deleted or not. */
export async function findConcept(graph: GraphBackend, schema: NodeSchema, name: string): Promise<ExistingConcept | null> {
  return (await findConcepts(graph, schema, [name])).get(name) ?? null;
}
