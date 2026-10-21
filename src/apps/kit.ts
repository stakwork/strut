/**
 * Where the app KIT is (plans/apps.md §3), from the server's side: the
 * vendor layer every app build resolves bare specifiers against — one frozen
 * browser bundle per specifier, `import-map.json` naming them, the kit's
 * own components' Tailwind candidates (`candidates.json`) and the versions
 * it was built from (`manifest.json`) — and the base stylesheet the Tailwind
 * compile starts from. The kit lives in `kit/` in this repo; its vendor
 * layer is built by strut's `npm run build` (`build:kit`, with the kit's
 * dependencies in kit/node_modules, so strut's own carries no React) — the
 * Docker image and the desktop package carry it at the same <strut>/kit; a
 * strut that one day pins `@strut/kit` as a package finds it through
 * `require.resolve` first. Nothing here loads a browser library: these are
 * paths and JSON.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where to find the kit: its package root, and (for a layer built
 *  elsewhere — a test's temp dir) the vendor directory. */
export interface KitLocation {
  dir?: string;
  vendorDir?: string;
}

export interface KitManifest {
  name: string;
  version: string;
  /** Each package's exact version. */
  packages: Record<string, string>;
  /** A specifier models write by reflex → the one it means (`framer-motion` → `motion/react`). */
  aliases: Record<string, string>;
  entries: string[];
  candidates: number;
}

export interface Kit {
  dir: string;
  vendorDir: string;
  /** Bare specifier → the vendor file, as an ABSOLUTE path. */
  imports: Record<string, string>;
  /** The kit's own components' Tailwind candidates. */
  candidates: string[];
  manifest: KitManifest;
  /** The base stylesheet's text (`src/styles/base.css`). */
  baseCss: string;
  baseCssPath: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** The kit's package root: `@strut/kit` when a strut pins it, else the repo's `kit/`. */
export function defaultKitDir(): string {
  try {
    return dirname(createRequire(import.meta.url).resolve("@strut/kit/package.json"));
  } catch {
    // `src/apps/` and `build/apps/` both sit two levels under the repo root.
    return resolve(HERE, "../../kit");
  }
}

export const KIT_NOT_BUILT = "the app kit's vendor layer is not built — from the strut checkout: npm run build:kit";

/** Read the kit (sync: three JSON files and a stylesheet). Throws
 *  `KIT_NOT_BUILT` when the vendor layer is missing. */
export function loadKit(where: KitLocation = {}): Kit {
  const dir = where.dir ?? defaultKitDir();
  const vendorDir = where.vendorDir ?? join(dir, "vendor");
  const mapFile = join(vendorDir, "import-map.json");
  if (!existsSync(mapFile)) throw new Error(`${KIT_NOT_BUILT} (looked in ${vendorDir})`);
  const { imports } = JSON.parse(readFileSync(mapFile, "utf8")) as { imports: Record<string, string> };
  const abs: Record<string, string> = {};
  for (const [k, v] of Object.entries(imports)) abs[k] = resolve(vendorDir, v);
  const baseCssPath = join(dir, "src", "styles", "base.css");
  return {
    dir,
    vendorDir,
    imports: abs,
    candidates: JSON.parse(readFileSync(join(vendorDir, "candidates.json"), "utf8")) as string[],
    manifest: JSON.parse(readFileSync(join(vendorDir, "manifest.json"), "utf8")) as KitManifest,
    baseCss: readFileSync(baseCssPath, "utf8"),
    baseCssPath,
  };
}

/** `Kit` when already loaded, else load it from a location. */
export function kitOf(k: Kit | KitLocation | undefined): Kit {
  return k && "imports" in k ? k : loadKit(k);
}
