/**
 * Which dictation models a user picked, and getting them onto disk
 * (plans/dictation-models.md, "Models and where they run"). The steps
 * `dictation/models`, `dictation/use` and `dictation/remove-model` are thin
 * over this; `/audio/transcribe` asks it for the speech model to use.
 *
 * Picking a model that is not installed starts its download in the
 * background (verify, extract, `.ok`); the pick is used once it is
 * installed, and until then transcription keeps to the default. The picks
 * live in `<dataDir>/audio/dictation.json`; with none, speech is the default
 * model (Kroko) and there is no fixer.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isInstalled, type DownloadProgress, type Installer, type ModelAsset } from "./download.js";
import {
  DICTATION_MODELS,
  findFixer,
  fixerModelPath,
  requireModel,
  sttModelPath,
  type DictationModel,
  type DictationModelKind,
} from "./models.js";

export type DictationModelState = "available" | "downloading" | "installed";

export interface DictationModelStatus {
  id: string;
  kind: DictationModelKind;
  bytes: number;
  description: string;
  state: DictationModelState;
  /** 0..1 while downloading. */
  progress?: number;
  selected: boolean;
  /** Why the last download failed; cleared by the next attempt. */
  error?: string;
}

export interface DictationPicks {
  speech: string;
  fixer: string | null;
}

export interface DictationModelsOptions {
  dataDir: string;
  modelDir: string;
  install: Installer;
  /** The speech model when none was picked (env `STRUT_STT_MODEL` or the catalog default). */
  defaultSpeech: string;
  /** Throws when a speech model cannot be downloaded here (no sherpa addon). */
  requireSpeechEngine?: () => Promise<void>;
  log?: (msg: string) => void;
}

export class DictationModels {
  private readonly downloads = new Map<string, { promise: Promise<void>; progress?: number }>();
  private readonly errors = new Map<string, string>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: DictationModelsOptions) {}

  private get file(): string {
    return join(this.o.dataDir, "audio", "dictation.json");
  }

  /** The stored picks, or null when the user never picked. */
  private async stored(): Promise<Partial<DictationPicks> | null> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as Partial<DictationPicks>;
    } catch {
      return null;
    }
  }

  async picks(): Promise<DictationPicks> {
    const s = await this.stored();
    const speech = s?.speech && find(s.speech, "speech") ? s.speech : this.o.defaultSpeech;
    const fixer = s?.fixer && find(s.fixer, "fixer") ? s.fixer : null;
    return { speech, fixer };
  }

  dir(id: string): string {
    const m = requireDictationModel(id);
    return m.kind === "speech" ? sttModelPath(this.o.modelDir, id) : fixerModelPath(this.o.modelDir, id);
  }

  async list(): Promise<DictationModelStatus[]> {
    const picks = await this.picks();
    return Promise.all(
      DICTATION_MODELS.map(async (m): Promise<DictationModelStatus> => {
        const dl = this.downloads.get(m.id);
        const state: DictationModelState = dl ? "downloading" : (await isInstalled(this.dir(m.id))) ? "installed" : "available";
        const error = this.errors.get(m.id);
        return {
          id: m.id,
          kind: m.kind,
          bytes: m.bytes,
          description: m.description,
          state,
          ...(dl?.progress !== undefined ? { progress: dl.progress } : {}),
          selected: m.kind === "speech" ? picks.speech === m.id : picks.fixer === m.id,
          ...(error && !dl ? { error } : {}),
        };
      }),
    );
  }

  /** Pick a speech model and/or a fixer (`null`: none). A pick that is not
   *  installed starts downloading; it is used once installed. */
  async use(pick: { speech?: string; fixer?: string | null }): Promise<DictationModelStatus[]> {
    if (pick.speech !== undefined) requireDictationModel(pick.speech, "speech");
    if (pick.fixer != null) requireDictationModel(pick.fixer, "fixer");
    if (pick.speech !== undefined && !(await isInstalled(this.dir(pick.speech)))) await this.o.requireSpeechEngine?.();
    await this.save((p) => ({
      speech: pick.speech ?? p.speech,
      fixer: pick.fixer === undefined ? p.fixer : pick.fixer,
    }));
    for (const id of [pick.speech, pick.fixer]) if (id) await this.download(id);
    return this.list();
  }

  /** Delete a model's files. A removed pick goes back to the default (speech) or none (fixer). */
  async remove(id: string): Promise<DictationModelStatus[]> {
    const m = requireDictationModel(id);
    if (this.downloads.has(id)) throw new Error(`dictation model "${id}" is downloading; remove it once it is done`);
    await rm(this.dir(id), { recursive: true, force: true });
    this.errors.delete(id);
    const picks = await this.picks();
    if (m.kind === "speech" && picks.speech === id) await this.save((p) => ({ ...p, speech: this.o.defaultSpeech }));
    if (m.kind === "fixer" && picks.fixer === id) await this.save((p) => ({ ...p, fixer: null }));
    return this.list();
  }

  /** The picked speech model when it is installed; null otherwise (the caller keeps its default). */
  async speechModel(): Promise<string | null> {
    const s = await this.stored();
    if (!s?.speech || !find(s.speech, "speech")) return null;
    return (await isInstalled(this.dir(s.speech))) ? s.speech : null;
  }

  /** The picked fixer's file when it is installed; null when none is picked or it is not on disk yet. */
  async fixerModel(): Promise<{ id: string; path: string } | null> {
    const { fixer } = await this.picks();
    if (!fixer || !(await isInstalled(this.dir(fixer)))) return null;
    return { id: fixer, path: join(this.dir(fixer), findFixer(fixer)!.file) };
  }

  /** Resolves when every download started so far has finished (tests). */
  async idle(): Promise<void> {
    while (this.downloads.size) await Promise.allSettled([...this.downloads.values()].map((d) => d.promise));
  }

  private save(f: (p: DictationPicks) => DictationPicks): Promise<void> {
    const next = this.writes.then(async () => {
      const picks = f(await this.picks());
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file, JSON.stringify(picks, null, 2) + "\n");
    });
    this.writes = next.catch(() => {});
    return next;
  }

  /** Start installing `id` in the background unless it is installed or already coming. */
  private async download(id: string): Promise<void> {
    if (this.downloads.has(id) || (await isInstalled(this.dir(id)))) return;
    this.errors.delete(id);
    const entry: { promise: Promise<void>; progress?: number } = { promise: Promise.resolve() };
    const onProgress = (p: DownloadProgress) => {
      if (p.phase === "download" && p.total > 0) entry.progress = Math.min(1, p.received / p.total);
      if (p.phase === "extract") entry.progress = 1;
    };
    entry.promise = this.o
      .install(asset(id), this.dir(id), onProgress)
      .catch((e: Error) => {
        this.errors.set(id, e.message);
        (this.o.log ?? console.warn)(`[dictation] download of ${id} failed: ${e.message}`);
      })
      .finally(() => this.downloads.delete(id));
    this.downloads.set(id, entry);
  }
}

function find(id: string, kind?: DictationModelKind): DictationModel | undefined {
  return DICTATION_MODELS.find((m) => m.id === id && (!kind || m.kind === kind));
}

export function requireDictationModel(id: string, kind?: DictationModelKind): DictationModel {
  const m = find(id, kind);
  if (!m) {
    const known = DICTATION_MODELS.filter((x) => !kind || x.kind === kind).map((x) => x.id);
    throw new Error(`unknown ${kind ?? "dictation"} model "${id}" (known: ${known.join(", ")})`);
  }
  return m;
}

/** What the installer fetches for a dictation model. */
function asset(id: string): ModelAsset {
  const m = requireDictationModel(id);
  if (m.kind === "speech") return requireModel(id);
  return findFixer(id)!;
}
