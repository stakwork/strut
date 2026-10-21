import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildVendor, entries, type VendorBuild } from "../scripts/build-vendor.js";
import { ALIASES, PACKAGES } from "../scripts/manifest.js";
import { compileStyles, kitDir, readCandidates, readImportMap, readManifest } from "./node.js";

/** One module path that must be in exactly ONE output — the shared state the page must not have twice. */
const SINGLETONS: Record<string, string> = {
  react: "node_modules/react/cjs/react.production.js",
  "react-dom": "node_modules/react-dom/cjs/react-dom-client.production.js",
  "react-query": "node_modules/@tanstack/query-core/build/modern/queryClient.js",
  zod: "node_modules/zod/v4/classic/schemas.js",
  "radix dismissable layer": "react-dismissable-layer/dist/index.mjs",
  "react-router": "node_modules/react-router/dist/production/index.js",
};

describe("the vendor build", () => {
  const outdir = mkdtempSync(join(tmpdir(), "strut-kit-vendor-"));
  let built: VendorBuild;
  before(async () => {
    built = await buildVendor({ outdir });
  });

  it("writes every bundle the import map names, and the map names every entry", () => {
    const map = readImportMap(outdir);
    for (const e of entries()) assert.ok(map[e.id], `import map lacks ${e.id}`);
    for (const [id, file] of Object.entries(map)) {
      assert.ok(existsSync(file), `${id} → ${file} missing`);
      assert.ok(statSync(file).size > 0, `${id} → ${file} empty`);
      assert.ok(file.startsWith(outdir), `${id} resolves outside the vendor dir`);
    }
    for (const [alias, target] of Object.entries(ALIASES)) assert.equal(map[alias], map[target], `${alias} → ${target}`);
    assert.ok(map["@/components/ui/button"]?.endsWith("/ui/button.js"));
    assert.ok(map["@/lib/utils"]?.endsWith("/lib/utils.js"));
    assert.ok(map["@xyflow/react/dist/style.css"]?.endsWith(".css"));
    assert.equal(built.warnings.length, 0, built.warnings.map((w) => w.text).join("\n"));
  });

  it("holds one copy of every shared module", () => {
    for (const [what, needle] of Object.entries(SINGLETONS)) {
      const where = Object.entries(built.metafile.outputs)
        .filter(([, o]) => Object.keys(o.inputs).some((i) => i.endsWith(needle)))
        .map(([f]) => f);
      assert.equal(where.length, 1, `${what} (${needle}) is in ${where.length} outputs: ${where.join(", ")}`);
    }
  });

  it("records the versions it built from, which are package.json's exact pins", () => {
    const manifest = readManifest(outdir);
    const pkg = JSON.parse(readFileSync(join(kitDir, "package.json"), "utf8"));
    const pinned = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
    assert.equal(manifest.version, pkg.version);
    assert.deepEqual(Object.keys(manifest.packages).sort(), [...PACKAGES].sort());
    for (const [name, version] of Object.entries(manifest.packages)) {
      assert.equal(pinned[name], version, `${name}: package.json pins ${pinned[name]}, the build used ${version}`);
      assert.match(version, /^\d+\.\d+\.\d+/, `${name} is pinned exactly`);
    }
  });

  it("bundles the kit itself: the hooks, the provider and the bootstrap", async () => {
    const map = readImportMap(outdir);
    const kit = await import(pathToFileURL(map["@strut/kit"]!).href);
    for (const name of ["StrutProvider", "useRuns", "useRun", "useRunEvents", "useLaunch", "useCancel", "useWorkflow", "useStep", "useToolInput", "useHost", "createBridgeClient"]) {
      assert.equal(typeof kit[name], "function", `@strut/kit exports ${name}`);
    }
    const boot = await import(pathToFileURL(map["@strut/kit/bootstrap"]!).href);
    assert.equal(typeof boot.bootstrap, "function");
    assert.equal(boot.TOKEN_META, "strut-app-token");
    const button = await import(pathToFileURL(map["@/components/ui/button"]!).href);
    assert.equal(typeof button.Button, "function");
  });

  it("precomputes the components' Tailwind candidates, which the base stylesheet compiles", async () => {
    const candidates = readCandidates(outdir);
    for (const c of ["inline-flex", "bg-primary", "text-primary-foreground", "rounded-md", "bg-destructive/5", "data-[state=open]:bg-accent"]) {
      assert.ok(candidates.includes(c), `candidates lack ${c}`);
    }
    assert.ok(!candidates.includes("React") && !candidates.includes("className"), "code tokens are not candidates");
    const css = await compileStyles({ candidates: [], kitCandidates: candidates });
    assert.match(css, /\.inline-flex\s*\{/);
    assert.match(css, /\.bg-primary\s*\{/);
    assert.ok(resolve(outdir, "candidates.json"));
  });

  it("cleans up", () => {
    rmSync(outdir, { recursive: true, force: true });
  });
});
