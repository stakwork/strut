import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultKitDir, type KitLocation } from "../apps/kit.js";

let located: Promise<KitLocation> | undefined;

/**
 * The kit for a test that builds an app: the repo's `kit/vendor` when it is
 * built (`npm run build:kit`), else the vendor layer built once
 * into a temp dir from the kit's own script (what the kit's vendor test
 * does; needs the kit's install, as CI has). One build per process.
 */
export function kitForTests(): Promise<KitLocation> {
  return (located ??= (async () => {
    const dir = defaultKitDir();
    if (existsSync(join(dir, "vendor", "import-map.json"))) return { dir };
    const outdir = await mkdtemp(join(tmpdir(), "strut-test-kit-vendor-"));
    // A computed specifier: tsc never follows it (the script is outside src/).
    const script = pathToFileURL(join(dir, "scripts", "build-vendor.ts")).href;
    const { buildVendor } = (await import(script)) as { buildVendor: (o: { outdir: string }) => Promise<unknown> };
    await buildVendor({ outdir });
    return { dir, vendorDir: outdir };
  })());
}
