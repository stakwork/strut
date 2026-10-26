import { createHash } from "node:crypto";
import { restore } from "./restore.js";
import type { TokenMap } from "./types.js";

/** One stored form. `assistant`: the provider's RAW output, part for part, exactly as returned
 *  (pseudonyms in it, signatures and provider metadata on it, tool input as the JSON the model
 *  wrote). `text`: the masked form of something we sent, as one string (a tool result's is JSON). */
export type StoredMasked =
  | { kind: "assistant"; parts: Array<Record<string, any>> }
  | { kind: "text"; masked: string };

/** Everything a transcript remembers about one session. The map only grows within an epoch. */
export interface SessionPrivacy {
  map: TokenMap;
  /** Bumped when the transcript starts over (strict late entity, a changed `mask` list). */
  epoch: number;
  policy: string;
  /** `a:<stamp id>` → the raw assistant output; `m:<sha256>` → a masked message part. */
  byId: Record<string, StoredMasked>;
  /** Lookups for an assistant part that lost its stamp. Derived; never stored. */
  ix?: { text: Map<string, { id: string; i: number }>; call: Map<string, { id: string; i: number }> };
}

export const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

export const newSession = (policy: string, epoch = 1, map: TokenMap = {}): SessionPrivacy => ({ map, epoch, policy, byId: {} });

/** Index one stored assistant output for the stamp-less lookups. */
export function indexAssistant(s: SessionPrivacy, id: string, parts: Array<Record<string, any>>): void {
  const ix = (s.ix ??= { text: new Map(), call: new Map() });
  parts.forEach((p, i) => {
    if ((p.type === "text" || p.type === "reasoning") && typeof p._h === "string") ix.text.set(p.type + ":" + p._h, { id, i });
    else if (p.type === "tool-call" && typeof p.toolCallId === "string") ix.call.set(p.toolCallId, { id, i });
  });
}

export function indexSession(s: SessionPrivacy): SessionPrivacy {
  s.ix = { text: new Map(), call: new Map() };
  for (const [k, v] of Object.entries(s.byId)) if (v.kind === "assistant") indexAssistant(s, k.slice(2), v.parts);
  return s;
}

/** The fresh part of a stored raw part, for hashing what we handed the caller. */
export const restoredHash = (rawText: string, map: TokenMap, escape?: (s: string) => string): string => sha(restore(rawText, map, escape).text);

/** Entities found only now whose value was already sent as plain text in an earlier stored message. */
export function lateEntities(s: SessionPrivacy, before: Set<string>): number {
  const fresh = Object.entries(s.map).filter(([k, e]) => !before.has(k) && e.value.length >= 3);
  if (!fresh.length) return 0;
  const hay: string[] = [];
  for (const v of Object.values(s.byId)) {
    if (v.kind === "text") hay.push(v.masked.toLowerCase());
    else for (const p of v.parts) { if (typeof p.text === "string") hay.push(p.text.toLowerCase()); if (typeof p.input === "string") hay.push(p.input.toLowerCase()); }
  }
  const seen = new Set<string>();
  for (const [, e] of fresh) {
    const v = e.value.toLowerCase();
    if (hay.some((h) => h.includes(v))) seen.add(e.type + ":" + v);
  }
  return seen.size;
}
