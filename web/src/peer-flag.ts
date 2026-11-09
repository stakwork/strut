// A workflow's top-level `peer:` flag: `true`, `"person"` or absent. The
// server reads `peer: false` as closed too; the editor writes "off" as the
// key removed, so the YAML says nothing it does not mean.
export type PeerValue = true | "person" | undefined;

/** The flag as a parsed YAML object / flow says it; anything else is off. */
export function readPeer(doc: { peer?: unknown } | null | undefined): PeerValue {
  const p = doc?.peer;
  return p === true || p === "person" ? p : undefined;
}

/** The toggle: on → off (removed); off → the PUBLISHED value when it was
 *  `"person"`, else `true`. So turning a `peer: person` workflow (the
 *  orchestrator) off and on again never widens it to every peer. */
export function togglePeer(value: PeerValue, published?: PeerValue): PeerValue {
  if (value) return undefined;
  return published === "person" ? "person" : true;
}

/** Apply `value` to a top-level object, removing the key when off. */
export function applyPeer<T extends Record<string, unknown>>(doc: T, value: PeerValue): T {
  const { peer: _drop, ...rest } = doc;
  return (value ? { ...rest, peer: value } : rest) as T;
}
