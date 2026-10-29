/**
 * The `vector` + `fts` extensions the graph backend requires
 * (plans/ladybug-backend.md ruling 4), PINNED: the bytes strut checked
 * against the core it ships, by sha256.
 *
 * Why not Ladybug's own `INSTALL`: extension.ladybugdb.com serves them at
 * `v<extension version>/<platform>/<name>/`, a path Ladybug's CI rewrites
 * with every build of its main branch. On 2026-10-20 the `v0.21.0` files
 * became builds that need symbols the 0.21.2 addon does not export
 * (`ValueVector::setAllNull`, `Transaction::isUnCommitted`), and
 * Cloudflare's edges served the old file or the new one depending on the
 * machine — so the same install opened its graph on one machine and failed
 * on the next (a desktop package that could not boot, CI skipping every
 * Ladybug suite on some runs).
 *
 * So where there is a pin for the loaded core on this platform, strut
 * downloads those bytes, verifies them (src/audio/download.ts) and loads
 * them by path from `<STRUT_MODEL_DIR>/ladybug/`, named by their hash. The
 * copy lives on the stakwork/strut release named in `baseUrl`
 * (`STRUT_LADYBUG_EXTENSION_URL` names a mirror). They are Ladybug's builds,
 * never rebuilt here: taken from Ladybug's extension repository image at the
 * immutable digest in `source` (deployed 2026-10-11), and each checked
 * against the 0.21.2 addon of its platform — every `lbug::` symbol the
 * extension imports is one the addon exports (`nm`) — then loaded and
 * queried (an FTS and a vector index) on darwin-arm64, linux-arm64 and
 * linux-x64.
 *
 * Another core (a host that resolved a newer @ladybugdb/core) or a platform
 * without a pin falls back to `INSTALL`, with a warning. Bumping the core
 * means new pins: the extension version from `SHOW_LOADED_EXTENSIONS()`,
 * the files for each platform from an extension-repo image built for that
 * core, the symbol check against each platform's addon, a release with the
 * files, and this table.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInstaller, type Installer } from "../../audio/download.js";
import { bootEnv } from "../../env.js";
import { modelDirFromEnv } from "../../model-dir.js";

export const EXTENSION_NAMES = ["vector", "fts"] as const;
export type ExtensionName = (typeof EXTENSION_NAMES)[number];

export interface ExtensionPin {
  sha256: string;
  bytes: number;
}

export interface ExtensionPins {
  /** The @ladybugdb/core these were checked against (`Database.getVersion()`). */
  core: string;
  /** Ladybug's extension version for that core: the path segment
   *  extension.ladybugdb.com files them under. */
  version: string;
  /** Where the bytes came from. */
  source: string;
  /** The release holding them, `<platform>-lib<name>.lbug_extension` each. */
  baseUrl: string;
  /** Ladybug's platform names (`osx_arm64`, `linux_amd64`, …). */
  platforms: Readonly<Record<string, Readonly<Record<ExtensionName, ExtensionPin>>>>;
}

export const LADYBUG_EXTENSION_PINS: ExtensionPins = {
  core: "0.21.2",
  version: "0.21.0",
  source: "ghcr.io/ladybugdb/extension-repo@sha256:79c0a2f5315bc222154bfe9496ad0845f9d1e5d17bd11662865cb4c781509365 (2026-10-11)",
  baseUrl: "https://github.com/stakwork/strut/releases/download/ladybug-extensions-0.21.0",
  platforms: {
    osx_arm64: {
      vector: { sha256: "6f878f3c0a2320a34967ff568fcf6bbe9065666e95035f0eddfe28bbc73b53f4", bytes: 803_064 },
      fts: { sha256: "777d9b606514d3c45c6196e7a44300b583af6513a34178bf1a7d030f4c888f03", bytes: 1_588_664 },
    },
    osx_amd64: {
      vector: { sha256: "7c0cea65d68c341453ce567e0d12897d0691b5f9ff01cff0fdf0db5756ab7851", bytes: 820_304 },
      fts: { sha256: "4c6a1dbfe6d4f150f291723137e10f0d8a4410bdc20c930b9bcf0936ed70d0dc", bytes: 1_583_168 },
    },
    linux_amd64: {
      vector: { sha256: "571726cc2ea0d202df1909ae5a3b0528c9dea3ea8d40be6c16b310ec14aa8821", bytes: 1_168_352 },
      fts: { sha256: "399c8d883fbe836c4b60bbe9440180cbc0c7fe27ef350a4e1570dccdb93695a7", bytes: 2_242_712 },
    },
    linux_arm64: {
      vector: { sha256: "583101f5bf2d0e5d40de2ee8966018a3bdf0fb8ad8951ef51ef46cd59169445f", bytes: 1_142_720 },
      fts: { sha256: "59669d011d485667b7b884f40aa408da0b8f117819eb83ccfa4d935556f16ba5", bytes: 2_269_560 },
    },
  },
};

/** Ladybug's name for a Node platform, or undefined where it builds none. */
export function extensionPlatform(platform: string = process.platform, arch: string = process.arch): string | undefined {
  const os = platform === "darwin" ? "osx" : platform === "linux" ? "linux" : undefined;
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "amd64" : undefined;
  return os && cpu ? `${os}_${cpu}` : undefined;
}

/** The release asset's name for one extension. */
export function extensionAsset(platform: string, name: ExtensionName): string {
  return `${platform}-lib${name}.lbug_extension`;
}

export interface PinnedOptions {
  pins?: ExtensionPins;
  /** Ladybug's platform name; default this machine's. */
  platform?: string;
  /** Default `STRUT_MODEL_DIR` (src/model-dir.ts). */
  modelDir?: string;
  /** Default `STRUT_LADYBUG_EXTENSION_URL`, else `pins.baseUrl`. */
  baseUrl?: string;
  install?: Installer;
}

export type PinnedExtensions = { files: Record<ExtensionName, string> } | { none: string };

// One installer for the process: two opens at once share each download.
const installer = createInstaller({ log: (msg) => console.log(`[graph] ${msg}`) });

/** The pinned files for `core` on this platform, downloaded and verified on
 *  first use: `{ files }`, each a path to LOAD. `{ none }` says why there
 *  is no pin; a download that fails (the network, the hash) throws. */
export async function pinnedExtensions(core: string, o: PinnedOptions = {}): Promise<PinnedExtensions> {
  const pins = o.pins ?? LADYBUG_EXTENSION_PINS;
  if (core !== pins.core) return { none: `strut's pinned extensions are for ladybug ${pins.core}, and ${core} is loaded` };
  const platform = o.platform ?? extensionPlatform();
  const forPlatform = platform ? pins.platforms[platform] : undefined;
  if (!platform || !forPlatform) return { none: `strut has no pinned ladybug extensions for ${platform ?? `${process.platform}-${process.arch}`}` };
  const root = join(o.modelDir ?? modelDirFromEnv(), "ladybug");
  const base = (o.baseUrl ?? bootEnv()["STRUT_LADYBUG_EXTENSION_URL"] ?? pins.baseUrl).replace(/\/+$/, "");
  const install = o.install ?? installer;
  const files = {} as Record<ExtensionName, string>;
  for (const name of EXTENSION_NAMES) {
    const pin = forPlatform[name];
    const file = `lib${name}.lbug_extension`;
    // Named by the hash: a new pin is a new folder, never a stale file reused.
    const dir = join(root, `${name}-${pin.sha256.slice(0, 16)}`);
    await install({ id: `ladybug ${name} ${pins.version} ${platform}`, url: `${base}/${extensionAsset(platform, name)}`, sha256: pin.sha256, bytes: pin.bytes, file }, dir);
    files[name] = join(dir, file);
  }
  return { files };
}

/** The extensions in `from` (the desktop package's native/, signed with its
 *  app), copied to `<STRUT_MODEL_DIR>/ladybug/bundled/<core>/` for strut to
 *  load from there: a path that stays put across builds sharing a data
 *  folder. A graph a process could not close leaves a WAL naming the
 *  extension paths it loaded, and replaying it fails once that path is gone
 *  (a deleted dev build, a moved app). One folder per core, so a build on
 *  another core never rewrites the files one on this core loads; within it
 *  a file whose bytes differ (another build's signature) is replaced by a
 *  rename, so a strut still holding the old one keeps it. */
export async function stableExtensionDir(from: string, core: string, modelDir: string = modelDirFromEnv()): Promise<string> {
  const dir = join(modelDir, "ladybug", "bundled", core);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const name of EXTENSION_NAMES) {
    const file = `lib${name}.lbug_extension`;
    const want = await readFile(join(from, file));
    const have = await readFile(join(dir, file)).catch(() => null);
    if (have?.equals(want)) continue;
    const temp = join(dir, `.${file}.${process.pid}`);
    try {
      await writeFile(temp, want, { mode: 0o755 });
      await rename(temp, join(dir, file));
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
  }
  return dir;
}
