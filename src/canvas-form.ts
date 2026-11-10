/**
 * The CANVAS FORM of a workflow: the top-level key order the web editor's
 * Publish writes — `name`, `input`, `steps`, `params` (when it has any),
 * then every other key of the version being edited in its own order, and
 * `peer` last. The editor models steps, input and params, so it rebuilds
 * the file from them and dumps it whole on every publish: one edit there
 * also drops comments, rewrites quotes and inline maps, and moves
 * `description:` below the steps.
 *
 * Two callers, one function, so they cannot drift: the editor
 * (web/src/app.tsx `handlePublish`), and a package update carrying such a
 * version onto a release (src/packages/replay.ts), which puts the release
 * through the same order and dump first — the merge then sees the edit,
 * not the re-dump. Both dump with strut's options (`dumpYaml`: lineWidth
 * 120, no anchors).
 *
 * No imports: the web UI bundles this file, like search.ts.
 */
export function canvasOrder(doc: Record<string, unknown>, name: string): Record<string, unknown> {
  const { name: _own, input, steps, params, peer, ...rest } = doc;
  const hasParams = params != null && typeof params === "object" && Object.keys(params).length > 0;
  return {
    name,
    ...(input ? { input } : {}),
    steps,
    ...(hasParams ? { params } : {}),
    ...rest,
    ...(peer ? { peer } : {}),
  };
}
