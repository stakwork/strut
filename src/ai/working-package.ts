/**
 * The WORKING PACKAGE (plans/packages-ux.md §3): the package a builder chat
 * turn works in — the sidebar group the person had selected when they
 * asked, sent as `POST /chat { package }`. Pure: the line the turn's user
 * message opens with, and how the builder's create_workflow / create_step
 * compose a stored name from the path the model gave, so the model names a
 * workflow by its path inside the package and never sees the publisher.
 */
import * as yaml from "js-yaml";

/** One package segment: `tools` in `acme/tools`. */
export const PACKAGE_SEGMENT = /^[a-z][a-z0-9-]{0,63}$/;

export const PACKAGE_LINE_PREFIX = "[package]";

/** The text part a turn's user message opens with when a package is
 *  selected: the segment, and the one rule the model needs. The transcript
 *  fold (kit/src/folds/transcript.ts) reads the segment back off it. */
export function packageLine(segment: string): string {
  return `${PACKAGE_LINE_PREFIX} ${segment} — name new workflows and steps by their path in this package; a slash makes a folder`;
}

/** The segment a `[package]` line names, or null for any other text. */
export function packageOfLine(text: string): string | null {
  const m = /^\[package\] (\S+)(?: —|$)/.exec(text);
  return m ? m[1]! : null;
}

/** The stored name for `name` in the package `prefix` (`acme/tools`): the
 *  path the model gave, under the prefix — or as given when it already
 *  carries it, so a model that repeats a full name does not nest it. */
export function nameInPackage(prefix: string | undefined, name: string): string {
  if (!prefix) return name;
  return name === prefix || name.startsWith(`${prefix}/`) ? name : `${prefix}/${name}`;
}

/** The YAML with its top-level `name:` set to `name` — the runner keys run
 *  storage off `workflow.name`, so the file must say the stored name.
 *  Unchanged when it already does, or when it is not a mapping (the publish
 *  then refuses it as it would have). */
export function stampWorkflowName(source: string, name: string): string {
  let parsed: unknown;
  try {
    parsed = yaml.load(source);
  } catch {
    return source;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return source;
  if ((parsed as { name?: unknown }).name === name) return source;
  return yaml.dump({ ...(parsed as object), name }, { lineWidth: 120, noRefs: true });
}

/** A step's source with its `defineStep({ type: "<from>" })` literal moved
 *  to `to` — the registry and a package install both want the type to be
 *  the path. Only the literal that says exactly `from` is touched. */
export function stampStepType(code: string, from: string, to: string): string {
  if (from === to) return code;
  const re = new RegExp(`(type\\s*:\\s*)(["'\`])${from.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\2`);
  return code.replace(re, (_m, head: string, q: string) => `${head}${q}${to}${q}`);
}
