// ── Package releases in the UI ──────────────────────────────────────────────
//
// What the Publish tab fills in before a person releases a workflow's package
// (plans/marketplace.md §12.1): the package a workflow belongs to, read off
// its name, and the version after the newest release.

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

/** The version to suggest after `newest`: its last number up by one
 *  (`1.4.0` → `1.4.1`, `v3` → `v4`); `1.0.0` for a first release, and the
 *  label unchanged when it has no number to raise. */
export function nextVersion(newest?: string): string {
  if (!newest) return "1.0.0";
  return newest.replace(/(\d+)(\D*)$/, (_, n: string, rest: string) => `${Number(n) + 1}${rest}`);
}
