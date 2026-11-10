/**
 * Where the app KIT is (plans/apps.md §3), from the server's side: the
 * vendor layer every app build resolves against — a frozen module tree,
 * every module the dependency set reaches as its package ships it
 * (`files/`), each import's resolution and side-effect flag recorded once by
 * the kit's own build (`modules.json`), `import-map.json` naming the module
 * each bare specifier starts from and the versions it was built from
 * (`manifest.json`) — and the base stylesheet the Tailwind compile starts
 * from. The app build scans the kit modules it bundles for their classes
 * (`candidates.json`, every component's, is `@strut/kit/node`'s). The kit
 * lives in `kit/` in this repo; its vendor layer is built by strut's `npm
 * run build` (`build:kit`, with the kit's dependencies in kit/node_modules,
 * so strut's own carries no React) — the Docker image and the desktop
 * package carry it at the same <strut>/kit; a strut that one day pins
 * `@strut/kit` as a package finds it through `require.resolve` first.
 * Nothing here loads a browser library: these are paths and JSON.
 */
import { createHash } from "node:crypto";
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
  /** How many modules the tree holds. */
  modules: number;
  candidates: number;
  /** The sha256 over every file an app is compiled from — the modules, the
   *  bundled stylesheets, the base stylesheet — so the manifest's own hash
   *  moves with any of them. Absent on a layer built before it. */
  tree?: string;
}

/** One module of the frozen tree (`modules.json`): each import as the kit's
 *  build resolved it — an ABSOLUTE path, or null for a module the package
 *  disables in the browser — and whether its package declares it free of side
 *  effects. */
export interface KitModule {
  links: Record<string, string | null>;
  pure?: true;
}

export interface Kit {
  dir: string;
  vendorDir: string;
  /** Bare specifier → the vendor file, as an ABSOLUTE path. */
  imports: Record<string, string>;
  /** Every module of the tree by ABSOLUTE path. */
  modules: Record<string, KitModule>;
  manifest: KitManifest;
  /** Which kit this is: the sha256 of `vendor/manifest.json` as it is on
   *  disk. What a built document records (`dist/build.json`'s `kit.digest`);
   *  a document that names another, or none, was built on another kit
   *  (plans/managed-packages.md §6). */
  digest: string;
  /** The base stylesheet's text (`src/styles/base.css`). */
  baseCss: string;
  baseCssPath: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

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
  // A layer of pre-bundled chunks (kit 0.1) has no module table.
  if (!existsSync(join(vendorDir, "modules.json"))) throw new Error(`the app kit's vendor layer in ${vendorDir} predates the module tree (kit 0.2) — rebuild it: cd kit && yarn build:vendor`);
  const { imports } = JSON.parse(readFileSync(mapFile, "utf8")) as { imports: Record<string, string> };
  const abs: Record<string, string> = {};
  for (const [k, v] of Object.entries(imports)) abs[k] = resolve(vendorDir, v);
  const table = JSON.parse(readFileSync(join(vendorDir, "modules.json"), "utf8")) as Record<string, KitModule>;
  const modules: Record<string, KitModule> = {};
  for (const [file, m] of Object.entries(table)) {
    const links: Record<string, string | null> = {};
    for (const [spec, to] of Object.entries(m.links)) links[spec] = to === null ? null : resolve(vendorDir, to);
    modules[resolve(vendorDir, file)] = m.pure ? { links, pure: true } : { links };
  }
  const baseCssPath = join(dir, "src", "styles", "base.css");
  const manifest = readFileSync(join(vendorDir, "manifest.json"));
  return {
    dir,
    vendorDir,
    imports: abs,
    modules,
    manifest: JSON.parse(manifest.toString("utf8")) as KitManifest,
    digest: sha256(manifest),
    baseCss: readFileSync(baseCssPath, "utf8"),
    baseCssPath,
  };
}

/** A kit's digest without loading it (one small file), or null when its
 *  vendor layer is not built. */
export function kitDigestOf(k: Kit | KitLocation | undefined): string | null {
  if (k && "imports" in k) return k.digest;
  try {
    return sha256(readFileSync(join(k?.vendorDir ?? join(k?.dir ?? defaultKitDir(), "vendor"), "manifest.json")));
  } catch {
    return null;
  }
}

/** `Kit` when already loaded, else load it from a location. */
export function kitOf(k: Kit | KitLocation | undefined): Kit {
  return k && "imports" in k ? k : loadKit(k);
}
