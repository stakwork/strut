/**
 * A node's `title` (plans/graph-memory-plan.md "Core attributes"): the
 * writer fills it from the schema's `title_key` on every write, as it fills
 * `search_text` from `index`, so a reader shows a node without looking up
 * its schema. `title_key` is a field, or a small template (`{first}
 * {last}`). A reader of a node written before titles falls back to the
 * schema's `title_key` (`nodeTitle`).
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

/** A stored node's title for a reader: the `title` the writer stored, else
 *  (a node written before titles) its type's `title_key` over its
 *  properties. "" when neither gives one; callers keep their own fallback. */
export function nodeTitle(props: Record<string, unknown>, titleKey?: string): string {
  const stored = props["title"];
  if (typeof stored === "string" && stored.trim()) return stored.trim();
  return composeTitle(titleKey, props);
}
