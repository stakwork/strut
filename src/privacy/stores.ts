import { join } from "node:path";
import { depsFrom, type PrivacyServices } from "./index.js";
import { bootEnv, type StepContext } from "./host.js";
import { secretKeyProvider } from "./keys.js";
import { destroyVault, getVault, putVault } from "./vault.js";
import { MemoryTranscriptStore, type TranscriptStore } from "./transcript.js";
import { FileTranscriptStore } from "./transcript-file.js";

const ttlHours = () => Number(bootEnv()["STRUT_PRIVACY_TRANSCRIPT_TTL_HOURS"]) || 24;
const files = new Map<string, TranscriptStore>();

/** Memory by default. `STRUT_PRIVACY_TRANSCRIPTS=file` keeps the masked history across a restart in
 *  `<dataDir>/privacy/transcripts`, its token map in the encrypted vault — which needs the vault key;
 *  without one the transcript stays in memory (a restart starts it over). A host may inject its own. */
export async function transcriptStoreFor(ctx: StepContext): Promise<TranscriptStore> {
  const injected = ((ctx.services ?? {}) as { privacy?: PrivacyServices & { transcripts?: TranscriptStore } }).privacy?.transcripts;
  if (injected) return injected;
  const ttlMs = ttlHours() * 3_600_000;
  if (bootEnv()["STRUT_PRIVACY_TRANSCRIPTS"] !== "file") return new MemoryTranscriptStore(ttlMs);
  const { vault, services } = depsFrom(ctx);
  if (!(await (services.keys ?? secretKeyProvider).get(ctx, { vault: "file" }))) {
    console.warn("[privacy] STRUT_PRIVACY_TRANSCRIPTS=file needs the vault key; keeping transcripts in memory");
    return new MemoryTranscriptStore(ttlMs);
  }
  const dir = join(vault.dir, "..", "transcripts");
  let s = files.get(dir);
  if (!s) {
    const ttlMin = ttlHours() * 60;
    s = new FileTranscriptStore(dir, {
      put: (map) => putVault("file", map, ttlMin, ctx, vault),
      get: (h) => getVault(h, ctx, vault),
      destroy: (h) => destroyVault(h, vault),
    }, ttlMs);
    files.set(dir, s);
  }
  return s;
}
