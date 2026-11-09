// A workflow's top-level `peer:` flag. Valid values: `true`, `"person"` or
// absent — "off" is the key REMOVED, never `peer: false` (invalid).
export type PeerValue = true | "person" | undefined;

/** The flag as a parsed YAML object / flow says it; anything else is off. */
export function readPeer(doc: { peer?: unknown } | null | undefined): PeerValue {
  const p = doc?.peer;
  return p === true || p === "person" ? p : undefined;
}

/** The toggle: on → `true`; off → removed. */
export function togglePeer(value: PeerValue): PeerValue {
  return value ? undefined : true;
}

/** Apply `value` to a top-level object, removing the key when off. */
export function applyPeer<T extends Record<string, unknown>>(doc: T, value: PeerValue): T {
  const { peer: _drop, ...rest } = doc;
  return (value ? { ...rest, peer: value } : rest) as T;
}
