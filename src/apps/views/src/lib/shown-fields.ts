// What of a task's `show` a worker sees: pure, so it is tested without React.

/** Names a workflow keeps for its own bookkeeping, never for the worker:
 *  compared after lower-casing and dropping `_`, `-` (so `isCover`-style keys
 *  match by their plain name too). `flag` is not here: it names what to fix. */
export const INTERNAL_KEYS: ReadonlySet<string> = new Set(["id", "ok", "idem", "replay", "hash", "key", "index", "pos"]);

/** Whether a `show` entry is bookkeeping, not something to show a worker:
 *  its key is one of `INTERNAL_KEYS` (case, `_` and `-` ignored), starts with
 *  `_` or `$`, or ends in `_id`/`Id`; or its value is an opaque token (a
 *  string of 32+ characters, no spaces, all digits or hex). */
export function isInternalKey(key: string, value?: unknown): boolean {
  if (/^[_$]/.test(key) || /(_id|[a-z0-9]Id)$/.test(key)) return true;
  if (INTERNAL_KEYS.has(key.toLowerCase().replace(/[_-]+/g, ""))) return true;
  return typeof value === "string" && /^(\d{32,}|[0-9a-f]{32,})$/i.test(value);
}

/** The rest of what a task shows, as label and value: `show`'s other plain
 *  fields (text, numbers, yes or no), in order, without bookkeeping
 *  (`isInternalKey`). A `show.fields` (or `show.display`) array of key names
 *  is an opt-in: only those keys, in that order, whatever their names. Nested
 *  values are left to an app's own view. */
export function shownFields(show: unknown): Array<[string, string]> {
  if (!show || typeof show !== "object" || Array.isArray(show)) return [];
  const o = show as Record<string, unknown>;
  const plain = (v: unknown) => (typeof v === "string" && v.trim() ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined);
  const pick = Array.isArray(o.fields) ? o.fields : Array.isArray(o.display) ? o.display : undefined;
  const out: Array<[string, string]> = [];
  if (pick) {
    for (const k of pick) {
      const v = typeof k === "string" && k !== "ask" && k !== "title" ? plain(o[k]) : undefined;
      if (v !== undefined) out.push([k as string, v]);
    }
    return out;
  }
  for (const [k, v] of Object.entries(o)) {
    if (k === "ask" || k === "title" || isInternalKey(k, v)) continue;
    const t = plain(v);
    if (t !== undefined) out.push([k, t]);
  }
  return out;
}

