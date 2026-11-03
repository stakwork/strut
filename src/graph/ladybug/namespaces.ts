/**
 * A Ladybug file's namespaces (plans/graph-memory-plan.md step 2): whose
 * data a node or edge is. Every data node and edge is in exactly one, held
 * in its `namespace` column:
 *
 *   - `private`, where a write that names no namespace goes. An older
 *     file's `default` rows are moved here once (`db.ts`
 *     `moveToNamespaces`), and `default` still resolves to it for the
 *     callers and configs that name it;
 *   - any other well-formed name (`shared`, …), made by writing into it:
 *     there is nothing to register.
 *
 * Strut's own records (workflows, runs, jobs, …) live in their writer's
 * namespace like anything else; what kind of thing a record is, is its
 * domain (`strut`), not its namespace. The Schema rows are the file's type
 * definitions: they hold no namespace, and a type resolves file-wide
 * whatever namespace a read or write names.
 *
 * Neo4j keeps jarvis's namespaces (`default` plus the registered ones) and
 * none of this.
 */
import { DEFAULT_NAMESPACE } from "../bolt.js";
import { GraphValidationError } from "../node-writer.js";

export const PRIVATE_NAMESPACE = "private";
/** A namespace name: lowercase, as jarvis registers them. */
export const NAMESPACE_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

/** A namespace as given, lowercased and checked; `default` (or none) is
 *  `fallback`, the backend's own. Null when the name is not well-formed. */
export function namespaceName(asked: string | undefined, fallback: string): string | null {
  const ns = (asked ?? fallback).trim().toLowerCase();
  if (ns === DEFAULT_NAMESPACE) return fallback;
  return NAMESPACE_NAME.test(ns) ? ns : null;
}

/** `namespaceName` for a write of `type`: throws on a malformed name. */
export function writeNamespace(type: string, asked: string | undefined, fallback: string): string {
  const ns = namespaceName(asked, fallback);
  if (ns === null) throw new GraphValidationError("UNKNOWN_ATTRIBUTE", type, `namespace ${String(asked)} is not a namespace name (${NAMESPACE_NAME.source})`, "namespace");
  return ns;
}
