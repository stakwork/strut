/**
 * A node's `title` (plans/graph-memory-plan.md "Core attributes"): the
 * writer fills it from the schema's `title_key` on every write to a
 * Ladybug file, as it fills `search_text` from `index`, so a reader shows a
 * node without looking up its schema. `title_key` is a field, or a small
 * template (`{first} {last}`). A Neo4j graph stores no core title (a stored
 * `title` there is a field of the type's, Person's job title); its readers
 * compose one from `title_key` (`nodeTitle`).
 *
 * No runtime imports: the step readers load it without the Neo4j driver.
 */
import type { NodeSchema } from "./schema-resolver.js";

/** The longest title the writer stores. */
export const TITLE_MAX = 200;

const bounded = (t: string) => (t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t);

/** A title from a schema's `title_key` over a node's values: the field's
 *  value, or a template's `{field}`s filled in (`"{first} {last}"`), trimmed
 *  and bounded. "" when nothing is there. */
export function composeTitle(titleKey: string | undefined, values: Record<string, unknown>): string {
  const key = titleKey || "name";
  const text = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v).trim() : "");
  const t = key.includes("{") ? key.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, f: string) => text(values[f])).replace(/\s+/g, " ").trim() : text(values[key]);
  return bounded(t);
}

/** The fields a `title_key` reads: one name, or a template's `{field}`s. */
export function titleFields(titleKey: string): string[] {
  return titleKey.includes("{") ? [...titleKey.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!) : [titleKey];
}

/** The title the writer stores for a node: its `title_key`, else the first
 *  line of its `text`, else of its search text. */
export function nodeTitleFor(schema: Pick<NodeSchema, "title_key">, values: Record<string, unknown>, searchText: string | null): string {
  const own = composeTitle(schema.title_key, values);
  if (own) return own;
  const source = typeof values["text"] === "string" && values["text"].trim() ? values["text"] : (searchText ?? "");
  return bounded(source.trim().split("\n")[0]!.trim());
}

/** A stored node's title for a reader: its type's `title_key` (default
 *  `name`) over its properties, else the `title` the writer stored (its
 *  first-line fallback, on Ladybug). A stored `title` is the node's title
 *  only where `title_key` reads it, or where the key gives nothing: on
 *  Neo4j a jarvis Person's `title` is a job title, not its name. "" when
 *  neither gives one; callers keep their own fallback. */
export function nodeTitle(props: Record<string, unknown>, titleKey?: string): string {
  const own = composeTitle(titleKey || "name", props);
  if (own) return own;
  const stored = props["title"];
  return typeof stored === "string" ? stored.trim() : "";
}
