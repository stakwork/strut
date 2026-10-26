// What a strut that keeps a read copy of its home's memory remembers between
// syncs (home/sync): what the last sync read its changes up to (the next `since`) and the content_hash
// of the copy it holds, in `<dataDir>/home-sync.json`. Leading underscore:
// imported by the home/* steps, skipped by registry discovery.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StepContext } from "../../../core.js";
import type { ChangeT } from "../dictation/_shared.js";

export interface SyncState {
  /** What the last sync read its changes up to: the push's `until`, or,
   *  when it pulled, the `until` of its read inside the import's lock. */
  since?: string;
  /** The content_hash of the memory copy held. */
  hash?: string;
  /** When the last sync finished. */
  at?: string;
  /** Dictation changes made here during a sync that replaced the memory,
   *  kept until they are replayed onto the new one (home/sync). */
  pending?: ChangeT[];
}

function file(ctx: StepContext<unknown>): string {
  const dataDir = (ctx.services as { dataDir?: string } | undefined)?.dataDir;
  if (!dataDir) throw new Error("home sync needs the server's dataDir (ctx.services.dataDir)");
  return join(dataDir, "home-sync.json");
}

export function readState(ctx: StepContext<unknown>): SyncState {
  try {
    return JSON.parse(readFileSync(file(ctx), "utf-8")) as SyncState;
  } catch {
    return {};
  }
}

export function writeState(ctx: StepContext<unknown>, state: SyncState): void {
  const path = file(ctx);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
