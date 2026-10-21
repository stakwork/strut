import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { buildVendor, entries, type VendorBuild } from "../scripts/build-vendor.js";
import { ALIASES, PACKAGES } from "../scripts/manifest.js";
import { compileStyles, kitDir, readCandidates, readImportMap, readManifest } from "./node.js";

/** A module the page must not have twice: the tree holds exactly one file at
 *  a path ending so — every import of it, from anywhere, is that file. */
const SINGLETONS: Record<string, string> = {
  react: "/react/cjs/react.production.js",
  "react-dom": "/react-dom/cjs/react-dom-client.production.js",
  "react-query": "/@tanstack/query-core/build/modern/queryClient.mjs",
  zod: "/zod/v4/classic/schemas.mjs",
  "radix dismissable layer": "/react-dismissable-layer/dist/index.mjs",
  "react-router": "/react-router/dist/production/index.mjs",
};

/** Every file under a directory, relative to it. */
function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p));
  }
  return out;
}

describe("the vendor build — a frozen module tree", () => {
  const outdir = mkdtempSync(join(tmpdir(), "strut-kit-vendor-"));
  let built: VendorBuild;
  let tree: string[];
  before(async () => {
    built = await buildVendor({ outdir });
    tree = walk(join(outdir, "files")).map((f) => `files/${f}`);
  });

  it("names every entry in the import map, each a module of the tree or a stylesheet", () => {
    const map = readImportMap(outdir);
    for (const e of entries()) assert.ok(map[e.id], `import map lacks ${e.id}`);
    for (const [id, file] of Object.entries(map)) {
      assert.ok(existsSync(file), `${id} → ${file} missing`);
      assert.ok(file.startsWith(outdir), `${id} resolves outside the vendor dir`);
      const rel = relative(outdir, file);
      assert.ok(rel.endsWith(".css") || built.modules[rel], `${id} → ${rel} is not in modules.json`);
    }
    for (const [alias, target] of Object.entries(ALIASES)) assert.equal(map[alias], map[target], `${alias} → ${target}`);
    assert.equal(relative(outdir, map["@/components/ui/button"]!), "files/src/components/ui/button.mjs");
    assert.equal(relative(outdir, map["@/lib/utils"]!), "files/src/lib/utils.mjs");
    assert.equal(relative(outdir, map["react"]!), "files/_m/react/index.js");
    assert.ok(map["@xyflow/react/dist/style.css"]?.endsWith(".css"));
    assert.equal(built.warnings.length, 0, built.warnings.map((w) => w.text).join("\n"));
  });

  it("records every module and every import: each link is a module of the tree, or null for one the browser field disables", () => {
    const files = new Set(tree);
    assert.deepEqual(Object.keys(built.modules).sort(), [...files].sort(), "modules.json lists the tree, file for file");
    let links = 0;
    for (const [file, m] of Object.entries(built.modules)) {
      for (const [spec, to] of Object.entries(m.links)) {
        links++;
        if (to !== null) assert.ok(files.has(to), `${file}: ${spec} → ${to} is not in the tree`);
      }
    }
    assert.ok(links > 5000, `${links} links`);
    assert.ok(!tree.some((f) => f.split("/").includes("node_modules")), "no node_modules segment (npm never packs one)");
    assert.ok(!tree.some((f) => /\.development\./.test(f)), "production modules only (react's dev build is never reached)");
  });

  it("holds one copy of every shared module", () => {
    for (const [what, needle] of Object.entries(SINGLETONS)) {
      const where = tree.filter((f) => f.endsWith(needle));
      assert.equal(where.length, 1, `${what} (${needle}) is in the tree ${where.length} times: ${where.join(", ")}`);
    }
  });

  it("keeps how each module is read: a CommonJS module as it is, a `type: module` package's .js as .mjs, the kit's TypeScript compiled", () => {
    assert.deepEqual(built.modules["files/_m/react/index.js"]!.links, { "./cjs/react.production.js": "files/_m/react/cjs/react.production.js" });
    assert.ok(tree.includes("files/_m/zod/v4/classic/schemas.mjs"), "zod is type: module");
    assert.ok(tree.includes("files/_m/@xyflow/react/dist/esm/index.js"), "@xyflow/react is not");
    const kit = readFileSync(join(outdir, "files/src/hooks.mjs"), "utf8");
    assert.match(kit, /export\s*\{[^}]*useRuns/);
    assert.doesNotMatch(kit, /:\s*StrutClient\b/, "no type annotations left");
    assert.equal(built.modules["files/src/components/ui/button.mjs"]!.links["@/lib/utils"], "files/src/lib/utils.mjs", "the kit's own @/ resolved to the kit");
  });

  it("carries each package's sideEffects declaration, which esbuild does not read for a plugin's path", () => {
    assert.equal(built.modules["files/_m/lucide-react/dist/esm/icons/alarm-clock.mjs"]?.pure, true, "lucide: sideEffects false");
    assert.equal(built.modules["files/_m/zod/v4/classic/schemas.mjs"]?.pure, true, "zod: an array that names only compile");
    assert.equal(built.modules["files/_m/@modelcontextprotocol/ext-apps/dist/src/app.mjs"]?.pure, undefined, "ext-apps declares nothing");
    assert.equal(built.modules["files/src/hooks.mjs"]?.pure, true, "the kit: only its stylesheets have side effects");
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

  it("precomputes the components' Tailwind candidates, which the base stylesheet compiles", async () => {
    const candidates = readCandidates(outdir);
    for (const c of ["inline-flex", "bg-primary", "text-primary-foreground", "rounded-md", "bg-destructive/5", "data-[state=open]:bg-accent"]) {
      assert.ok(candidates.includes(c), `candidates lack ${c}`);
    }
    assert.ok(!candidates.includes("React") && !candidates.includes("className"), "code tokens are not candidates");
    const css = await compileStyles({ candidates: [], kitCandidates: candidates });
    assert.match(css, /\.inline-flex\s*\{/);
    assert.match(css, /\.bg-primary\s*\{/);
  });

  it("cleans up", () => {
    rmSync(outdir, { recursive: true, force: true });
  });
});
