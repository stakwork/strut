// ── Packages in the UI, the pure parts ──────────────────────────────────────
//
// What the Packages dialog works out before a person releases one
// (plans/packages-ux.md): which packages this strut can publish, read off
// its workflow names — a workflow's name carries its package,
// `publisher/package/path` (plans/marketplace.md §1) — how a package is
// shown, and the version to suggest next.

/** A package name: `publisher/name`, two lowercase segments — the server's
 *  PACKAGE_NAME (src/packages/format.ts). */
export const PACKAGE_NAME = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

/** The package a workflow is published in: its name's first two segments,
 *  when a third names the workflow (`stakwork/tools/summarize` →
 *  `stakwork/tools`); null for a name with no package prefix. */
export function packageOf(workflow: string): string | null {
  const parts = workflow.split("/");
  return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : null;
}

/** The packages this strut can publish: every `publisher/package` prefix a
 *  workflow here is named under — under this strut's own publisher alone
 *  when it has a name — less the installed ones, which are published where
 *  they were made. Sorted. */
export function localPackages(workflows: string[], opts: { publisher?: string; installed?: string[] } = {}): string[] {
  const skip = new Set(opts.installed ?? []);
  const out = new Set<string>();
  for (const name of workflows) {
    const pkg = packageOf(name);
    if (!pkg || !PACKAGE_NAME.test(pkg) || skip.has(pkg)) continue;
    if (opts.publisher && pkg.split("/")[0] !== opts.publisher) continue;
    out.add(pkg);
  }
  return [...out].sort();
}

/** How the UI names a package: the package segment alone when it is this
 *  strut's publisher's (`stakwork/tools` → `tools`), the whole name
 *  otherwise — the publisher is the server's, never typed. */
export function packageLabel(pkg: string, publisher?: string): string {
  return publisher && pkg.startsWith(`${publisher}/`) ? pkg.slice(publisher.length + 1) : pkg;
}

/** The version to suggest after `newest`: its last number up by one
 *  (`1.4.0` → `1.4.1`, `v3` → `v4`); `1.0.0` for a first release, and the
 *  label unchanged when it has no number to raise. */
export function nextVersion(newest?: string): string {
  if (!newest) return "1.0.0";
  return newest.replace(/(\d+)(\D*)$/, (_, n: string, rest: string) => `${Number(n) + 1}${rest}`);
}
