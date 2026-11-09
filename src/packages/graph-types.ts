/**
 * A package's GRAPH TYPES: `graph/<Type>.yaml`, one file per node type,
 * in `graph/create-schema`'s grammar, with the edges whose source it is.
 * The ontology a package's workflows and apps write, carried with them so a
 * fresh graph has it before the first run.
 *
 *   parent: Legal                  # default Thing
 *   domain: Legal
 *   type_description: A party to an agreement
 *   attributes: { name: string, role: "?string" }
 *   key_spec: name                 # default name
 *   index: [name, role]            # default the key
 *   edges:
 *     - [PARTY_TO, Agreement]      # [EDGE, target type], `*` for any
 *
 * BUILD (`exportTypes`): a person or the builder NAMES types; each is read
 * off this graph's ontology as it is, with its parents up to a type every
 * strut has (Thing, the seed's) or a required package carries, and the
 * edges among them: the ontology's edge rules, and every edge the graph
 * HOLDS between two of them — so an edge a Jarvis graph let through on its
 * allowlist, with no rule, travels as a rule. The same graph and the same
 * names give the same bytes. Edge rules carry no `temporal`, `cardinality`
 * or aliases yet. An edge between a named type and a type the package does
 * not carry is a warning: the package's runs may need it.
 *
 * INSTALL (`checkPackageTypes`, then `registerPackageTypes`): every type is
 * checked before the install's first write — the grammar, a type strut
 * keeps, a parent and edge ends that exist, and the graph as it is (the
 * checks an app's `data.graph` gets: `checkAgainstGraph`). Registered first,
 * parents before children, add-only, and never removed: not by an
 * uninstall, not by a take-back. A type is the graph's, not the package's.
 */
import { z } from "zod";
import { checkAgainstGraph, registerTypes, reservedAppType } from "../apps/graph-types.js";
import type { GraphBackend } from "../graph/backend.js";
import type { NodeSchemaInput } from "../graph/schema-crud.js";
import { SEED_TYPES } from "../graph/seed-types.js";
import { THING_TYPE, isStrutType, typeValue } from "../graph/strut-schemas.js";
import { dumpYaml, loadYaml } from "../yaml.js";
import { GRAPH_TYPE_NAME, type PackageItem } from "./format.js";

const EDGE_NAME = /^[A-Z][A-Z0-9_]*$/;
const ATTRIBUTE_TYPE = /^\??(string|boolean|int|float|complex|datetime|list)$/;
const NODE_ROLES = ["entity", "concept", "claim", "source", "record"];

const typeFileSchema = z
  .object({
    parent: z.string().regex(GRAPH_TYPE_NAME).optional(),
    domain: z.string().min(1).optional(),
    type_description: z.string().optional(),
    attributes: z.record(z.string(), z.string().regex(ATTRIBUTE_TYPE, "an attribute type is string | boolean | int | float | complex | datetime | list, ?-prefixed when optional")).default({}),
    key_spec: z.string().min(1).optional(),
    index: z.array(z.string().min(1)).optional(),
    title_key: z.string().min(1).optional(),
    description_key: z.string().min(1).optional(),
    role: z.enum(NODE_ROLES as [string, ...string[]]).optional(),
    identifiers: z.array(z.string().min(1)).optional(),
    embed: z.boolean().optional(),
    edges: z
      .array(z.tuple([z.string().regex(EDGE_NAME, "an edge type is UPPER_SNAKE"), z.string().regex(/^(\*|[A-Za-z][A-Za-z0-9_]*)$/, "an edge's target is a type, or * for any")]))
      .default([]),
  })
  .strict();

/** One `graph/<Type>.yaml`, read. */
export interface PackageType {
  type: string;
  file: string;
  input: NodeSchemaInput;
  /** `[EDGE, target]`, the type the source. */
  edges: Array<[string, string]>;
}

/** Read one type file. Throws naming the file and what is wrong. */
export function parseTypeFile(type: string, file: string, text: string): PackageType {
  let raw: unknown;
  try {
    raw = loadYaml(text);
  } catch (err) {
    throw new Error(`${file}: not valid YAML — ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = typeFileSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${file}${i.path.length ? `: ${i.path.join(".")}` : ""}: ${i.message}`).join("; "));
  }
  const { edges, ...rest } = parsed.data;
  const input: NodeSchemaInput = { type, ...rest, attributes: rest.attributes };
  return { type, file, input, edges: edges.map(([e, t]) => [e, t]) };
}

/** The file for a type: its fields in a fixed order, attributes and edges sorted. */
export function typeFileText(t: Omit<PackageType, "file">): string {
  const i = t.input;
  const doc: Record<string, unknown> = {};
  if (i.parent && i.parent !== THING_TYPE) doc["parent"] = i.parent;
  if (i.domain) doc["domain"] = i.domain;
  if (i.type_description) doc["type_description"] = i.type_description;
  doc["attributes"] = Object.fromEntries(Object.entries(i.attributes).sort(([a], [b]) => a.localeCompare(b)));
  if (i.key_spec) doc["key_spec"] = i.key_spec;
  if (i.index?.length) doc["index"] = i.index;
  if (i.title_key) doc["title_key"] = i.title_key;
  if (i.description_key) doc["description_key"] = i.description_key;
  if (i.role) doc["role"] = i.role;
  if (i.identifiers?.length) doc["identifiers"] = i.identifiers;
  if (i.embed !== undefined) doc["embed"] = i.embed;
  if (t.edges.length) doc["edges"] = [...t.edges].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  return dumpYaml(doc);
}

/** A Schema's own settings: never an attribute, whatever their value. */
const SETTINGS = new Set(["type", "parent", "domain", "type_description", "title_key", "description_key", "key_spec", "node_key", "key", "index", "vector_index", "attributes", "inherited_attributes", "ref_id"]);

/** Every strut has these: the root, strut's own, and the seed's. */
const SEED_NAMES = new Set(SEED_TYPES.map((s) => s.type));
const everywhere = (type: string) => type === THING_TYPE || isStrutType(type) || SEED_NAMES.has(type);

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const strList = (v: unknown): string[] | undefined => {
  const list = Array.isArray(v) ? v : typeof v === "string" && v ? [v] : [];
  const out = list.filter((x): x is string => typeof x === "string" && !!x);
  return out.length ? out : undefined;
};

/**
 * BUILD: the named types as `graph/<Type>.yaml` files (file → text), with
 * their parents and the edges among them. `required` holds the types the
 * required packages carry: a parent or an edge end there stops the walk.
 * Refusals go to `problems`, the rest to `warnings`.
 */
export async function exportTypes(
  graph: GraphBackend | undefined,
  names: string[],
  required: ReadonlySet<string>,
  problems: string[],
  warnings: Set<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!graph) {
    problems.push("there are no graph types to package: this workspace has no graph");
    return out;
  }
  const { checkAttribute, planNodeSchema } = await import("../graph/schema-crud.js");
  const { schemas, edges: ruled } = await graph.reader.listSchemas();
  const byLower = new Map(schemas.map((s) => [s.type.toLowerCase(), s]));
  const stops = (type: string) => everywhere(type) || required.has(type);

  // The named types, then each one's parents up to a type every strut has.
  const carried = new Map<string, (typeof schemas)[number]>();
  for (const name of names) {
    const env = byLower.get(name.toLowerCase());
    if (!env) {
      problems.push(`no graph type ${name} in this graph's ontology`);
      continue;
    }
    if (required.has(env.type)) {
      problems.push(`the graph type ${env.type} is carried by a package this one requires`);
      continue;
    }
    const reserved = reservedAppType(env.type);
    if (reserved) {
      problems.push(`the graph type ${env.type} ${reserved}: every strut has it, so no package carries it`);
      continue;
    }
    let at: (typeof schemas)[number] | undefined = env;
    while (at && !carried.has(at.type)) {
      carried.set(at.type, at);
      const parent = str(at["parent"]);
      if (!parent || stops(parent)) break;
      const next = byLower.get(parent.toLowerCase());
      if (!next) problems.push(`the graph type ${at.type} hangs under ${parent}, which this graph's ontology does not hold`);
      else if (reservedAppType(next.type)) problems.push(`the graph type ${at.type} hangs under ${next.type}, which no package carries`);
      at = next;
    }
  }
  if (!carried.size) return out;

  // The edges: the ontology's rules among them, and what the graph holds.
  const ends = new Set([...carried.keys(), ...required, ...SEED_NAMES]);
  const edges = new Map<string, Set<string>>(); // source → "EDGE target"
  const add = (s: string, e: string, t: string) => {
    if (!carried.has(s) || (t !== "*" && !ends.has(t))) return;
    edges.set(s, (edges.get(s) ?? new Set()).add(`${e} ${t}`));
  };
  for (const r of ruled) if (r.edge_type !== "CHILD_OF") add(r.source_type, r.edge_type, r.target_type);
  const d = graph.dialect;
  const types = [...carried.keys()];
  const held = await graph.query(
    `MATCH (a)-[r]->(b) WHERE ${d.isType("a", types)} AND ${d.isType("b", [...ends])} AND ${d.live("a")} AND ${d.live("b")} AND ${d.edgeLive("r")}
     RETURN DISTINCT ${d.typeOf("a")} AS s, ${d.edgeType("r")} AS e, ${d.typeOf("b")} AS t`,
  );
  for (const row of held) {
    const s = typeValue(row["s"]);
    const t = typeValue(row["t"]);
    if (s && t && typeof row["e"] === "string") add(s, row["e"], t);
  }

  // What the package leaves out: an edge between a carried type and one it does not carry.
  for (const [dir, cypher] of [
    ["out", `MATCH (a)-[r]->(b) WHERE ${d.isType("a", types)} AND NOT ${d.isType("b", [...ends])}`],
    ["in", `MATCH (b)-[r]->(a) WHERE ${d.isType("a", types)} AND NOT ${d.isType("b", [...ends])}`],
  ] as const) {
    const rows = await graph.query(`${cypher} AND ${d.live("a")} AND ${d.live("b")} AND ${d.edgeLive("r")} RETURN DISTINCT ${d.typeOf("a")} AS a, ${d.edgeType("r")} AS e, ${d.typeOf("b")} AS b`);
    for (const row of rows) {
      const a = typeValue(row["a"]);
      const b = typeValue(row["b"]);
      if (!a || !b || isStrutType(b)) continue;
      const edge = dir === "out" ? `${a} -[${String(row["e"])}]-> ${b}` : `${b} -[${String(row["e"])}]-> ${a}`;
      warnings.add(`the graph holds ${edge}, and ${b} is not in the package: name it among the types, or the package's runs cannot write that edge on a graph without it`);
    }
  }

  // Each type as its file.
  for (const [type, env] of [...carried].sort(([a], [b]) => a.localeCompare(b))) {
    const file = `graph/${type}.yaml`;
    const live = await graph.schemas.schema(type);
    const attributes: Record<string, string> = {};
    // An attribute named as a Schema setting (`description`, a jarvis type's
    // `role`) is read as that setting; its value, an attribute type, says it
    // is the type's attribute. One its parent holds the same is inherited.
    const fromParent = (await graph.schemas.schema(str(env["parent"]) ?? THING_TYPE))?.attributes ?? {};
    const settings = Object.entries(env).filter(([k, v]) => !SETTINGS.has(k) && typeof v === "string" && ATTRIBUTE_TYPE.test(v) && !(k in fromParent));
    for (const [k, v] of [...Object.entries(env.attributes), ...settings]) {
      if (typeof v !== "string" || !ATTRIBUTE_TYPE.test(v)) continue; // a stamp jarvis keeps on the Schema, not an attribute
      try {
        checkAttribute(type, k, v);
        attributes[k] = v;
      } catch {
        warnings.add(`${file}: ${type}.${k} is left out — the writer keeps that name for itself`);
      }
    }
    // A key spec's first token is the type prefix, which the writer replaces
    // with the node's own type (`composeNodeKey`) whoever declared it: a type
    // with no key of its own inherits its parent's (jarvis's `Content` and
    // `Legal` hold Thing's `thing-name`), so only the tokens after it are
    // attributes. `ref_id` is no key at all.
    const key = !live ? undefined : live.key_spec === "ref_id" ? "ref_id" : live.key_spec.split("-").slice(1).join("-") || undefined;
    const index = live?.index.filter((f) => f !== "node_key");
    const role = str(env["role"]) && NODE_ROLES.includes(str(env["role"])!) ? str(env["role"]) : undefined;
    const embed = env["embed"];
    const input: NodeSchemaInput = {
      type,
      ...(str(env["parent"]) ? { parent: str(env["parent"])! } : {}),
      ...(str(env["domain"]) ? { domain: str(env["domain"])! } : {}),
      ...(str(env["type_description"]) ? { type_description: str(env["type_description"])! } : {}),
      attributes,
      ...(key && key !== "name" ? { key_spec: key } : {}),
      ...(index?.length && index.join("-") !== (key ?? "name") ? { index } : {}),
      ...(live?.title_key && live.title_key !== "name" ? { title_key: live.title_key } : {}),
      ...(live?.description_key && live.description_key !== "description" ? { description_key: live.description_key } : {}),
      ...(role && NODE_ROLES.includes(role) ? { role } : {}),
      ...(strList(env["identifiers"]) ? { identifiers: strList(env["identifiers"])! } : {}),
      ...(typeof embed === "boolean" ? { embed } : {}),
    };
    try {
      planNodeSchema(input, undefined, live?.attributes ?? {});
    } catch (e) {
      if (!(e instanceof Error) || e.name !== "GraphValidationError") throw e;
      problems.push(`${file}: ${e.message}`);
      continue;
    }
    const typeEdges = [...(edges.get(type) ?? [])].map((x) => x.split(" ") as [string, string]);
    out.set(file, typeFileText({ type, input, edges: typeEdges }));
  }
  return out;
}

/** A set's types, read and ordered for the install: parents before children. */
export interface CheckedTypes {
  types: PackageType[];
  /** By package: the types it ships, for the report. */
  byPackage: Map<string, string[]>;
}

/**
 * INSTALL, before the first write: every type file of every package in the
 * set, read and checked against each other and against the graph. Refusals
 * go to `problems`; nothing is written.
 */
export async function checkPackageTypes(
  graph: GraphBackend | undefined,
  members: Array<{ pkg: string; dir: string; items: PackageItem[]; read(path: string): Promise<string> }>,
  problems: string[],
  warnings: string[],
): Promise<CheckedTypes> {
  const out: CheckedTypes = { types: [], byPackage: new Map() };
  const all = new Map<string, { t: PackageType; text: string; pkg: string }>();
  for (const m of members) {
    const items = m.items.filter((i) => i.kind === "type");
    if (!items.length) continue;
    out.byPackage.set(m.pkg, items.map((i) => i.name));
    for (const item of items) {
      const text = await m.read(item.path);
      let t: PackageType;
      try {
        t = parseTypeFile(item.name, `${m.pkg}: ${item.path}`, text);
      } catch (e) {
        problems.push(e instanceof Error ? e.message : String(e));
        continue;
      }
      const other = all.get(item.name);
      if (other && other.text !== text) problems.push(`the graph type ${item.name} is in both ${other.pkg} and ${m.pkg}, declared differently`);
      if (!other) all.set(item.name, { t, text, pkg: m.pkg });
      const reserved = reservedAppType(item.name);
      if (reserved) problems.push(`${t.file}: ${item.name} ${reserved}: a package declares types of its own`);
    }
  }
  if (!all.size) return out;
  if (!graph) {
    problems.push(`the graph types (${[...all.keys()].join(", ")}) need a graph, and this strut server's workspace is on the filesystem`);
    return out;
  }

  // Parents before children; a parent outside the set must be in the graph.
  const ordered: PackageType[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = async (type: string, from: string): Promise<void> => {
    const at = all.get(type)!;
    if (state.get(type) === "done") return;
    if (state.get(type) === "visiting") {
      problems.push(`${at.t.file}: its parents make a cycle through ${from}`);
      return;
    }
    state.set(type, "visiting");
    const parent = at.t.input.parent ?? THING_TYPE;
    if (all.has(parent)) await visit(parent, type);
    else if (!(await graph.schemas.resolveType(parent))) problems.push(`${at.t.file}: its parent ${parent} is neither in the packages nor in this graph`);
    state.set(type, "done");
    ordered.push(at.t);
  };
  for (const type of [...all.keys()].sort()) await visit(type, type);

  // Each type's grammar, with what it inherits; then the edges' ends.
  const { planNodeSchema } = await import("../graph/schema-crud.js");
  const inheritedOf = new Map<string, Record<string, string>>();
  const inherited = async (t: PackageType): Promise<Record<string, string>> => {
    const parent = t.input.parent ?? THING_TYPE;
    const up = all.get(parent);
    const attrs = up ? { ...(await inherited(up.t)), ...up.t.input.attributes } : { ...((await graph.schemas.schema(parent).catch(() => null))?.attributes ?? {}) };
    inheritedOf.set(t.type, attrs);
    return attrs;
  };
  for (const t of ordered) {
    try {
      planNodeSchema(t.input, graph.kind, await inherited(t));
    } catch (e) {
      if (!(e instanceof Error) || e.name !== "GraphValidationError") throw e;
      problems.push(`${t.file}: ${e.message}`);
    }
    for (const [edge, target] of t.edges) {
      if (target !== "*" && !all.has(target) && !(await graph.schemas.resolveType(target))) {
        problems.push(`${t.file}: the edge ${edge} goes to ${target}, which is neither in the packages nor in this graph`);
      }
    }
  }
  if (problems.length) return out;

  // The graph as it is: a type it holds keeps its key and attribute types.
  const errors: string[] = [];
  const file = new Map(ordered.map((t) => [t.type, t.file]));
  const at = (type: string, attr?: string) => `${file.get(type) ?? type}${attr ? `: ${attr === "key" ? "key_spec" : attr === "search" ? "index" : attr}` : ""}`;
  await checkAgainstGraph(
    ordered.map((t) => t.input),
    graph,
    { at, noun: "package", inherited: (type) => inheritedOf.get(type) ?? {} },
    errors,
    warnings,
  );
  problems.push(...errors);
  out.types = ordered;
  return out;
}

/** INSTALL: register the checked types, parents first, then their edges.
 *  Each type's status for the report: `installed` new here, `updated`
 *  extended with attributes, `present` as it was. */
export async function registerPackageTypes(graph: GraphBackend, checked: CheckedTypes): Promise<Map<string, "installed" | "updated" | "present">> {
  const status = new Map<string, "installed" | "updated" | "present">();
  if (!checked.types.length) return status;
  const edges = checked.types.flatMap((t) => t.edges.map(([e, target]) => [t.type, e, target] as const));
  const r = await registerTypes(graph, checked.types.map((t) => t.input), edges);
  checked.types.forEach((t, i) => {
    const one = r.types[i]!;
    status.set(t.type, one.created ? "installed" : one.added.length ? "updated" : "present");
  });
  return status;
}
