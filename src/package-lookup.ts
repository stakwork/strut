/**
 * Package-first lookup (plans/packages-ux.md §2). Inside a package, a bare
 * name means the package's OWN item when the package holds one, else the
 * name as it is — node's lookup, a package's own files before anything
 * outside. Nothing in a package is rewritten when it is published or
 * installed (the build writes each item's own name under the prefix and
 * nothing else), so every place strut finds a workflow or a step by name
 * asks here, with the package of the CALLER: the runner (a step's type, a
 * subflow's target), an agent's grants, the steps that launch or read a
 * run by name, an app's build and its single-step door, the closure walk,
 * and the install's check.
 *
 * An item's package is its name's prefix (`acme/tools` for
 * `acme/tools/summarize`): the same rule wherever the name came from, so a
 * workflow behaves the same on the strut that installed it and on one
 * where it was named so by hand. A name with fewer than three segments is
 * in no package, and its lookups are what they always were. A full name
 * (`bob/util/fmt`, a core or lib step) is found as it is.
 */
import { parseStepRef } from "./step-ref.js";

/** The package prefix a name sits under (`acme/linear` for
 *  `acme/linear/sync`): an item of a package has three segments or more. */
export function packagePrefixOf(name: string): string | undefined {
  const segments = name.split("/");
  return segments.length >= 3 ? `${segments[0]}/${segments[1]}` : undefined;
}

/** `name` as a caller in `pkg` means it: `<pkg>/<name>` when `has` says the
 *  package holds that, else `name`. */
export function nameInPackage(pkg: string | undefined, name: string, has: (candidate: string) => boolean): string {
  if (!pkg || !name || name.startsWith(`${pkg}/`)) return name;
  const candidate = `${pkg}/${name}`;
  return has(candidate) ? candidate : name;
}

/** {@link nameInPackage} for a lookup that has to ask a store. */
export async function nameInPackageAsync(pkg: string | undefined, name: string, has: (candidate: string) => Promise<boolean>): Promise<string> {
  if (!pkg || !name || name.startsWith(`${pkg}/`)) return name;
  const candidate = `${pkg}/${name}`;
  return (await has(candidate)) ? candidate : name;
}

/** A step reference — `type`, or a pinned `type@vN` — as a caller in `pkg`
 *  means it, the pin kept. */
export function stepInPackage(pkg: string | undefined, ref: string, has: (type: string) => boolean): string {
  if (!pkg) return ref;
  const { type, version } = parseStepRef(ref);
  const found = nameInPackage(pkg, type, has);
  return found === type ? ref : version ? `${found}@${version}` : found;
}

/** A grant's name inside its package, for what a model is shown: the tool
 *  for `acme/tools/clip/shout` granted from `acme/tools` is `clip/shout`, as
 *  it was on the strut that published it. */
export function nameInsidePackage(pkg: string | undefined, name: string): string {
  return pkg && name.startsWith(`${pkg}/`) ? name.slice(pkg.length + 1) : name;
}
