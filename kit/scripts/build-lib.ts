// The kit's LIBRARY build (plans/apps.md §3): `dist/` holds the hooks, the
// provider and the bootstrap as ESM with React, react-dom, react-query and
// the MCP Apps SDK EXTERNAL — for a host's own pages (hive imports it) — plus
// the Node-side helpers, and the `.d.ts` files from tsc. `npm run build:lib`.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { kitDir } from "../src/node.js";

export async function buildLib({ outdir = join(kitDir, "dist") } = {}) {
  rmSync(outdir, { recursive: true, force: true });
  await build({
    absWorkingDir: kitDir,
    entryPoints: ["src/index.ts", "src/bootstrap.ts", "src/folds/index.ts", "src/node.ts"],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: ["es2022"],
    outdir,
    packages: "external",
    sourcemap: true,
    logLevel: "warning",
  });
  const tsc = spawnSync(process.execPath, [join(kitDir, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.lib.json", "--outDir", outdir], {
    cwd: kitDir, stdio: "inherit",
  });
  if (tsc.status !== 0) throw new Error(`tsc failed (${tsc.status})`);
  return { outdir };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const t0 = Date.now();
  const r = await buildLib();
  console.log(`lib: → ${r.outdir} in ${Date.now() - t0} ms`);
}
