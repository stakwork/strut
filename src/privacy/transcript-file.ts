import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { indexSession, newSession, type SessionPrivacy, type StoredMasked } from "./session.js";
import type { TranscriptStore } from "./transcript.js";
import type { TokenMap } from "./types.js";

/** The token map is real data: it lives in the encrypted vault, the file holds its handle. */
export interface MapVault {
  put(map: TokenMap): Promise<string>;
  get(handle: string): Promise<TokenMap | null>;
  destroy(handle: string): Promise<unknown>;
}

type Line =
  | { t: "head"; epoch: number; policy: string; map: string }
  | { t: "e"; k: string; v: StoredMasked };

/** `<dataDir>/privacy/transcripts/<session>.jsonl`: privacy's own record, append-only, apart from the
 *  agent session store. A head line (epoch, policy, the map's vault handle) and one line per stored
 *  entry; the last head wins. Raw assistant entries are found by stamp id, so lines of a turn that
 *  never committed are never referenced. Files older than `ttlMs` are swept. */
export class FileTranscriptStore implements TranscriptStore {
  private swept = 0;
  private handles = new Map<string, { handle: string; size: number }>();
  constructor(private dir: string, private vault: MapVault, private ttlMs = 24 * 3_600_000, private now: () => number = Date.now) {}

  private file(key: string) { return join(this.dir, encodeURIComponent(key).replace(/%/g, "_") + ".jsonl"); }

  private async sweep() {
    if (this.now() - this.swept < 3_600_000) return;
    this.swept = this.now();
    let names: string[] = [];
    try { names = await readdir(this.dir); } catch { return; }
    for (const n of names.slice(0, 200)) {
      const p = join(this.dir, n);
      try { if (this.now() - (await stat(p)).mtimeMs > this.ttlMs) await rm(p, { force: true }); } catch { /* raced */ }
    }
  }

  async load(key: string): Promise<SessionPrivacy | undefined> {
    await this.sweep();
    let text: string;
    try { text = await readFile(this.file(key), "utf-8"); } catch (e) { if ((e as { code?: string }).code === "ENOENT") return undefined; throw e; }
    let head: Extract<Line, { t: "head" }> | undefined;
    const byId: Record<string, StoredMasked> = {};
    for (const l of text.split("\n")) {
      if (!l) continue;
      let line: Line;
      try { line = JSON.parse(l) as Line; } catch { continue; } // a torn last line
      if (line.t === "head") head = line;
      else byId[line.k] = line.v;
    }
    if (!head) return undefined;
    const map = await this.vault.get(head.map);
    if (!map) return undefined; // vault entry expired: the transcript is lost, the caller starts fresh
    this.handles.set(key, { handle: head.map, size: Object.keys(map).length });
    return indexSession({ ...newSession(head.policy, head.epoch, map), byId });
  }

  async save(key: string, s: SessionPrivacy, added: Record<string, StoredMasked>, reset = false) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const size = Object.keys(s.map).length;
    const had = this.handles.get(key);
    let handle = had?.handle;
    if (!handle || had!.size !== size || reset) {
      handle = await this.vault.put(s.map);
      if (had) await this.vault.destroy(had.handle).catch(() => {});
      this.handles.set(key, { handle, size });
    }
    const lines: Line[] = [{ t: "head", epoch: s.epoch, policy: s.policy, map: handle }];
    for (const [k, v] of Object.entries(added)) lines.push({ t: "e", k, v });
    const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    if (reset) await writeFile(this.file(key), body, { mode: 0o600 });
    else await appendFile(this.file(key), body, { mode: 0o600 });
  }

  async drop(key: string) {
    const had = this.handles.get(key);
    if (had) await this.vault.destroy(had.handle).catch(() => {});
    this.handles.delete(key);
    await rm(this.file(key), { force: true });
  }
}
