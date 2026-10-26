import type { SessionPrivacy, StoredMasked } from "./session.js";

/** Where a session's masked history lives between calls. */
export interface TranscriptStore {
  load(key: string): Promise<SessionPrivacy | undefined>;
  /** Persist `s` after a call: `added` are the entries new since the last save; `reset` starts the transcript over. */
  save(key: string, s: SessionPrivacy, added: Record<string, StoredMasked>, reset?: boolean): Promise<void>;
  drop(key: string): Promise<void>;
}

const HOURS = 24;
const G = globalThis as unknown as { __strutPrivacyTranscripts?: Map<string, { s: SessionPrivacy; exp: number }> };

/** In this process, for `ttlMs` after the last use. A restart is a fresh transcript. */
export class MemoryTranscriptStore implements TranscriptStore {
  private m: Map<string, { s: SessionPrivacy; exp: number }>;
  constructor(private ttlMs = HOURS * 3_600_000, private now: () => number = Date.now, shared = true) {
    this.m = shared ? (G.__strutPrivacyTranscripts ??= new Map()) : new Map();
  }
  private sweep() { const t = this.now(); for (const [k, v] of this.m) if (v.exp <= t) this.m.delete(k); }
  async load(key: string) {
    this.sweep();
    const v = this.m.get(key);
    if (v) v.exp = this.now() + this.ttlMs;
    return v?.s;
  }
  async save(key: string, s: SessionPrivacy) { this.m.set(key, { s, exp: this.now() + this.ttlMs }); }
  async drop(key: string) { this.m.delete(key); }
}
