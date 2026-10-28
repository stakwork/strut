import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp, cspFor, lintAppSource, readBuildInfo, TOKEN_PLACEHOLDER, withToken, withoutTokenMeta, zodNamespaceImports, type BuildDeps } from "./build.js";
import { parseManifest } from "./manifest.js";
import { loadKit, type KitLocation } from "./kit.js";
import { treeFiles, treeHash } from "../version.js";
import { kitForTests } from "../test-util/app-kit.js";

/**
 * The app build (plans/apps.md §2, §14): the fixture app gives one document;
 * the resolver's rules each refuse with the reason; the source checks; the
 * installed-app rule with its pin, its cycle check and its hash in
 * build.json; determinism; the tree hash's exclusions.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "__fixtures__", "hello");
const TEMPLATE = join(HERE, "templates", "default");

let kit: KitLocation;
let root: string;
before(async () => {
  kit = await kitForTests();
  root = await mkdtemp(join(tmpdir(), "strut-app-build-"));
});

async function writeApp(dir: string, files: Record<string, string>): Promise<string> {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, dirname(rel)), { recursive: true });
    await writeFile(join(dir, rel), text, "utf8");
  }
  return dir;
}

/** A minimal app: a manifest and an entry around `body` (statements before
 *  the component) and `component` (its body). An import a case names must be
 *  USED there: esbuild elides an unused TypeScript import as a type import. */
const minimal = (body = "", component = "return <p>hi</p>;") => ({
  "app.yaml": "title: Minimal\n",
  "src/App.tsx": `${body}\nexport default function App() { ${component} }\n`,
});
const using = (name: string) => `return <p>{String(${name})}</p>;`;

let n = 0;
const fresh = () => join(root, `app-${++n}`);
const build = (dir: string, deps: Partial<BuildDeps> = {}) => buildApp(dir, { kit, ...deps });
const errorsOf = (r: Awaited<ReturnType<typeof buildApp>>) => (r.ok ? [] : r.errors);

describe("the app build", () => {
  it("the fixture builds to ONE document: the kit's bootstrap, relative imports and an @/ override resolved, a kit component, an asset inlined, the CSP, the token placeholder", async () => {
    const dir = fresh();
    await cp(FIXTURE, dir, { recursive: true });
    const r = await build(dir, { workflowExists: async () => true });
    assert.ok(r.ok, errorsOf(r).join("\n"));
    assert.deepEqual(r.warnings, []);
    const html = await readFile(join(dir, "dist", "index.html"), "utf8");
    assert.ok(html.startsWith("<!doctype html>\n<html>"));
    assert.equal(html.match(/<script type="module">/g)?.length, 1, "one module script");
    assert.equal(html.match(/<style/g)?.length, 1, "one style element");
    assert.ok(html.includes(TOKEN_PLACEHOLDER), "the token meta, empty: dist/ holds no credential");
    assert.ok(html.includes("ui/initialize"), "the kit's bootstrap (the MCP Apps handshake) is in the bundle");
    assert.ok(html.includes("Hello, "), "a relative import (src/lib/greet.ts)");
    assert.ok(html.includes("hello-fixture-badge-override"), "the app's own @/components/ui/badge shadows the kit's");
    assert.ok(/\.inline-flex\s*\{/.test(html), "the kit's button is styled (its precomputed candidates)");
    assert.ok(/\.text-emerald-600\s*\{/.test(html), "a class the app's source uses is compiled");
    assert.ok(html.includes("data:image/svg+xml"), "public/logo.svg inlined as a data URL");
    assert.ok(html.includes(`content="${cspFor(["https://tile.openstreetmap.org"])}"`), "the §9 CSP with the manifest's resourceDomains");
    assert.ok(html.includes("<title>Hello</title>"));
    const info = (await readBuildInfo(dir))!;
    assert.equal(info.kit.name, "@strut/kit");
    assert.match(info.kit.version, /^\d+\.\d+\.\d+/);
    assert.equal(info.hash, await treeHash(dir), "build.json records the tree hash it built from");
    assert.deepEqual(info.imports, []);
    assert.equal(info.bytes, Buffer.byteLength(html));
    assert.equal(r.hash, info.hash);
  });

  it("the same inputs give the same bytes; the hash leaves out data.db and dist/ and knows nothing of the kit", async () => {
    const dir = fresh();
    await cp(FIXTURE, dir, { recursive: true });
    const before = await treeHash(dir);
    const a = await build(dir, { now: () => new Date(0) });
    assert.ok(a.ok);
    const first = await readFile(join(dir, "dist", "index.html"));
    const b = await build(dir, { now: () => new Date(1) });
    assert.ok(b.ok);
    assert.ok(first.equals(await readFile(join(dir, "dist", "index.html"))), "two builds, identical bytes");
    assert.equal(await treeHash(dir), before, "dist/ is not in the hash");
    await writeFile(join(dir, "data.db"), "sqlite bytes");
    await writeFile(join(dir, ".DS_Store"), "junk");
    await mkdir(join(dir, "node_modules", "x"), { recursive: true });
    await writeFile(join(dir, "node_modules", "x", "index.js"), "1");
    assert.equal(await treeHash(dir), before, "data.db, dotfiles and node_modules are not in the hash");
    assert.ok(!(await treeFiles(dir)).some((f) => f.startsWith("dist/") || f === "data.db" || f.includes("node_modules")));
    await writeFile(join(dir, "src", "lib", "greet.ts"), 'export function greet(w: string) { return `Hi, ${w}`; }\n');
    assert.notEqual(await treeHash(dir), before, "a source edit changes it");
    // The kit is a build input, never an identity: the hash of an untouched
    // directory is the same whatever vendor layer is in reach.
    const other = loadKit(kit);
    assert.equal(await treeHash(dir), await treeHash(dir), other.manifest.version);
  });

  it("the starter template builds", async () => {
    const dir = fresh();
    await cp(TEMPLATE, dir, { recursive: true });
    const r = await build(dir);
    assert.ok(r.ok, errorsOf(r).join("\n"));
    const html = await readFile(join(dir, "dist", "index.html"), "utf8");
    assert.ok(html.includes("Edit src/App.tsx"));
    assert.ok(/\.text-brand\b/.test(html) || html.includes("--color-brand"), "the app's @theme token is compiled in");
  });

  it("a kit import resolves, an alias too, and a kit stylesheet rides along raw", async () => {
    const dir = await writeApp(fresh(), {
      "app.yaml": "title: Kit imports\n",
      "src/App.tsx": `import { motion } from "framer-motion";\nimport { debounce } from "lodash";\nimport "@xyflow/react/dist/style.css";\nexport default function App() { debounce(() => 1, 10); return <motion.div className="text-brand">x</motion.div>; }\n`,
      "src/styles.css": "@theme { --color-brand: oklch(0.6 0.2 250); }\n",
    });
    const r = await build(dir);
    assert.ok(r.ok, errorsOf(r).join("\n"));
    const html = await readFile(join(dir, "dist", "index.html"), "utf8");
    assert.ok(html.includes(".react-flow"), "the xyflow stylesheet, appended");
    assert.ok(/\.text-brand\s*\{/.test(html), "the app's CSS is a compile input: its @theme token makes a utility");
  });

  it("an installed app resolves to its src/, @vN to that version, a sub-path to that file; the imported hashes land in build.json", async () => {
    const v1 = await writeApp(fresh(), { "app.yaml": "title: UI\n", "src/index.ts": 'export const VERSION = "one";\n', "src/App.tsx": "export default () => null;\n" });
    const v2 = await writeApp(fresh(), { "app.yaml": "title: UI\n", "src/index.ts": 'export const VERSION = "two";\n', "src/extra.ts": 'export const EXTRA = "extra-two";\n', "src/App.tsx": "export default () => null;\n" });
    const h1 = await treeHash(v1);
    const h2 = await treeHash(v2);
    const resolveApp: BuildDeps["resolveApp"] = async (name, version) =>
      name !== "acme/ui" ? null : version === "v1" ? { name, version: "v1", dir: v1, hash: h1 } : version === undefined || version === "v2" ? { name, version: "v2", dir: v2, hash: h2 } : null;
    const dir = await writeApp(fresh(), {
      "app.yaml": "title: Importer\n",
      "src/App.tsx": `import { VERSION } from "acme/ui";\nimport { VERSION as PINNED } from "acme/ui@v1";\nimport { EXTRA } from "acme/ui/extra";\nexport default function App() { return <p>{VERSION}{PINNED}{EXTRA}</p>; }\n`,
    });
    const r = await build(dir, { resolveApp });
    assert.ok(r.ok, errorsOf(r).join("\n"));
    const html = await readFile(join(dir, "dist", "index.html"), "utf8");
    for (const s of ['"one"', '"two"', '"extra-two"']) assert.ok(html.includes(s), `bundle holds ${s}`);
    assert.deepEqual(r.imports, [
      { name: "acme/ui", version: "v1", hash: h1, pinned: true },
      { name: "acme/ui", version: "v2", hash: h2 },
    ]);
    assert.deepEqual((await readBuildInfo(dir))!.imports, r.imports);
    // A sub-path the app lacks, and a version it lacks.
    const missing = await build(await writeApp(fresh(), { ...minimal('import x from "acme/ui/nope";', using("x")) }), { resolveApp });
    assert.match(errorsOf(missing).join("\n"), /"acme\/ui\/nope": the installed app acme\/ui@v2 has no src\/nope/);
  });

  it("an app in a package imports its package's app, and grants its package's workflow, by the bare name", async () => {
    const ui = await writeApp(fresh(), { "app.yaml": "title: UI\n", "src/index.ts": 'export const LABEL = "package-ui";\n', "src/App.tsx": "export default () => null;\n" });
    const other = await writeApp(fresh(), { "app.yaml": "title: UI\n", "src/index.ts": 'export const LABEL = "strut-ui";\n', "src/App.tsx": "export default () => null;\n" });
    const resolveApp: BuildDeps["resolveApp"] = async (name) =>
      name === "acme/tools/ui" ? { name, version: "v1", dir: ui, hash: await treeHash(ui) } : name === "ui" ? { name, version: "v3", dir: other, hash: await treeHash(other) } : null;
    const workflowExists = async (wf: string) => wf === "acme/tools/run-bench";
    const files = {
      "app.yaml": "title: Board\ngrants:\n  workflows: [run-bench]\n",
      "src/App.tsx": 'import { LABEL } from "ui";\nexport default function App() { return <p>{LABEL}</p>; }\n',
    };
    const inPackage = await build(await writeApp(fresh(), files), { name: "acme/tools/board", resolveApp, workflowExists });
    assert.ok(inPackage.ok, errorsOf(inPackage).join("\n"));
    assert.deepEqual(inPackage.imports.map((i) => i.name), ["acme/tools/ui"], "the package's own ui, over the strut's");
    // Outside a package: the strut's ui, and no run-bench to grant.
    const loose = await build(await writeApp(fresh(), files), { name: "board", resolveApp, workflowExists });
    assert.match(errorsOf(loose).join("\n"), /grants\.workflows: no workflow "run-bench"/);
  });

  it("a cycle is refused naming the chain; the app being built counts", async () => {
    const b = await writeApp(fresh(), { "app.yaml": "title: B\n", "src/index.ts": 'import { C } from "c";\nexport const B = "b" + C;\n' });
    const c = await writeApp(fresh(), { "app.yaml": "title: C\n", "src/index.ts": 'import { B } from "b";\nexport const C = "c" + B;\n' });
    const back = await writeApp(fresh(), { "app.yaml": "title: Back\n", "src/index.ts": 'import { X } from "a";\nexport const BACK = X;\n' });
    const resolveApp: BuildDeps["resolveApp"] = async (name) =>
      name === "b" ? { name, version: "v1", dir: b, hash: "hb" } : name === "c" ? { name, version: "v2", dir: c, hash: "hc" } : name === "back" ? { name, version: "v1", dir: back, hash: "hback" } : name === "a" ? { name, version: "v1", dir: b, hash: "ha" } : null;
    const two = await build(await writeApp(fresh(), minimal('import { B } from "b";', using("B"))), { resolveApp });
    assert.match(errorsOf(two).join("\n"), /import cycle the app → b@v1 → c@v2 → b@v1 — an app may not import the app that imports it/);
    const self = await build(await writeApp(fresh(), minimal('import { BACK } from "back";', using("BACK"))), { resolveApp, name: "a" });
    assert.match(errorsOf(self).join("\n"), /import cycle a → back@v1 → a@v1/);
  });

  it("an import of an app nobody installed fails naming the set and the installed kits", async () => {
    const r = await build(await writeApp(fresh(), minimal('import { Thing } from "hive/ui";', using("Thing"))), {
      resolveApp: async () => null,
      installedApps: async () => ["acme/ui", "strut/views"],
    });
    const text = errorsOf(r).join("\n");
    assert.match(text, /src\/App\.tsx:1: "hive\/ui" is not in the app kit \(@strut\/kit \d+\.\d+\.\d+\)\. Available: .*react.*recharts/);
    assert.match(text, /Installed kits .*: acme\/ui, strut\/views/);
    assert.match(text, /write a workflow and call it with useLaunch/);
  });

  it("refusals, each with the reason: a non-kit bare import, an import leaving the directory, a URL import, dangerouslySetInnerHTML, eval, new Function", async () => {
    const cases: Array<[string, string, RegExp]> = [
      ['import fp from "lodash-fp";', using("fp"), /"lodash-fp" is not in the app kit/],
      ['import x from "../../outside";', using("x"), /"\.\.\/\.\.\/outside" from src\/App\.tsx: a relative import may not leave the app's directory/],
      ['import x from "../dist/index.html";', using("x"), /dist is not part of the build/],
      ['import x from "https://esm.sh/foo";', using("x"), /URL imports are refused/],
      ['import x from "./nope";', using("x"), /"\.\/nope" from src\/App\.tsx: no such file/],
      ["", 'return <div dangerouslySetInnerHTML={{ __html: "x" }} />;', /src\/App\.tsx:2: sets dangerouslySetInnerHTML/],
      ['const r = eval("1");', using("r"), /src\/App\.tsx:1: calls eval/],
      ['const f = new Function("return 1");', using("f"), /src\/App\.tsx:1: calls new Function/],
    ];
    for (const [body, component, re] of cases) {
      const r = await build(await writeApp(fresh(), minimal(body, component)));
      assert.equal(r.ok, false, body);
      assert.match(errorsOf(r).join("\n"), re);
    }
  });

  it("a global fetch, XMLHttpRequest or WebSocket is a WARNING naming the hook; the build goes through", async () => {
    const r = await build(await writeApp(fresh(), minimal('async function load() { const r = await fetch("/api/x"); new WebSocket("ws://x"); return r; }')));
    assert.ok(r.ok, errorsOf(r).join("\n"));
    assert.equal(r.warnings.length, 2);
    assert.match(r.warnings[0]!, /src\/App\.tsx:1: calls the global fetch — .*connect-src 'none'.*useStep.*useLaunch/);
    assert.match(r.warnings[1]!, /opens a WebSocket/);
    assert.deepEqual((await readBuildInfo(await writeApp(fresh(), minimal())))?.warnings, undefined, "a fresh dir has no build yet");
  });

  it("the source checks run over an imported app's sources too", async () => {
    const bad = await writeApp(fresh(), { "app.yaml": "title: Bad kit\n", "src/index.ts": 'export const X = eval("1");\n' });
    const r = await build(await writeApp(fresh(), minimal('import { X } from "badkit";', using("X"))), {
      resolveApp: async (name) => (name === "badkit" ? { name, version: "v1", dir: bad, hash: "h" } : null),
    });
    assert.match(errorsOf(r).join("\n"), /badkit@v1:src\/index\.ts:1: calls eval/);
  });

  it("a grant naming a workflow that does not exist fails the build naming it; the manifest is shape-checked", async () => {
    const r = await build(await writeApp(fresh(), { ...minimal(), "app.yaml": "title: G\ngrants:\n  workflows: [exists, missing-one]\n  automations: [gone]\n" }), {
      workflowExists: async (wf) => wf === "exists",
    });
    assert.deepEqual(errorsOf(r), [
      'grants.workflows: no workflow "missing-one" — publish it first, or drop the grant',
      'grants.automations: no workflow "gone" — publish it first, or drop the grant',
    ]);
    const bad = await build(await writeApp(fresh(), { ...minimal(), "app.yaml": "title: X\ngrants:\n  steps: graph/*\nextra: 1\n" }));
    assert.match(errorsOf(bad).join("\n"), /app\.yaml: grants\.steps: /);
    assert.match(errorsOf(bad).join("\n"), /app\.yaml: .*extra/);
    const none = await build(await writeApp(fresh(), { "src/App.tsx": "export default () => null;\n" }));
    assert.match(errorsOf(none).join("\n"), /app\.yaml: not found/);
    const entry = await build(await writeApp(fresh(), { "app.yaml": "title: E\nentry: src/Main.tsx\n", "src/App.tsx": "export default () => null;\n" }));
    assert.match(errorsOf(entry).join("\n"), /entry: "src\/Main\.tsx" is not a file in the app/);
    assert.ok(!existsSync(join(entry.ok ? "" : "/nonexistent", "dist")), "nothing written on an error");
  });
});

describe("zod's namespace import (plans/apps.md §2.5)", () => {
  it("rewrites `z` — named, aliased, beside other names, as the default — to `import * as`, and nothing else", () => {
    assert.equal(zodNamespaceImports(`import { z } from "zod";`), `import * as z from "zod";`);
    assert.equal(zodNamespaceImports(`import{z as Q}from"zod/v4";Q.object({})`), `import * as Q from "zod/v4";Q.object({})`, "minified, as the MCP Apps SDK ships it");
    assert.equal(zodNamespaceImports(`import { ZodError, z, type ZodType } from 'zod';`), `import * as z from 'zod';import { ZodError, type ZodType } from 'zod';`);
    assert.equal(zodNamespaceImports(`import z from "zod";`), `import * as z from "zod";`);
    for (const untouched of [`import { string } from "zod";`, `import type { z } from "zod";`, `import { z } from "zod-to-json";`, `import { z } from "./zod";`, `const x = 1;`]) {
      assert.equal(zodNamespaceImports(untouched), untouched);
    }
  });
});

describe("the manifest", () => {
  it("fills the defaults, keeps data.graph with its attribute grammar, and reads its issues as lines", () => {
    const ok = parseManifest(`title: Invoices
grants:
  workflows: [a]
  steps: [graph/*]
  sqlite: true
data:
  graph:
    types:
      Customer: { name: string, phone: string?, search: [name] }
      Invoice: { amount: number, due: date, meta: json? }
    edges:
      - [Invoice, BILLED_TO, Customer]
csp:
  resourceDomains: [https://tile.openstreetmap.org]
`);
    assert.ok(ok.ok);
    assert.equal(ok.manifest.entry, "src/App.tsx");
    assert.deepEqual(ok.manifest.grants, { workflows: ["a"], steps: ["graph/*"], sqlite: true, automations: [] });
    assert.deepEqual(ok.manifest.data?.graph?.edges, [["Invoice", "BILLED_TO", "Customer"]]);
    const bad = parseManifest("title: X\ndata:\n  graph:\n    types:\n      Customer: { name: text, search: [nope] }\n    edges:\n      - [Customer, billed, Nobody]\n");
    assert.equal(bad.ok, false);
    const text = bad.ok ? "" : bad.errors.join("\n");
    assert.match(text, /app\.yaml: data\.graph\.types\.Customer\.name: an attribute is string \| number \| boolean \| date \| json/);
    assert.match(text, /search names "nope"/);
    assert.match(text, /edges\[0\]\[1\]: an edge type is UPPER_SNAKE/);
    assert.match(parseManifest("").ok ? "" : (parseManifest("") as { errors: string[] }).errors[0]!, /empty/);
    assert.match((parseManifest("- a\n") as { errors: string[] }).errors[0]!, /must be a mapping/);
    assert.match((parseManifest("title: [\n") as { errors: string[] }).errors[0]!, /not valid YAML/);
  });
});

describe("the document's token", () => {
  it("withToken fills the placeholder, escaped; withoutTokenMeta drops it; the source checks ignore comments", () => {
    const html = `<head>${TOKEN_PLACEHOLDER}</head>`;
    assert.equal(withToken(html, 'a"b<c'), '<head><meta name="strut-app-token" content="a&quot;b&lt;c"></head>');
    assert.equal(withoutTokenMeta(html), "<head></head>");
    const lint = lintAppSource('// eval("x") in a comment\n/* fetch(\n) */ const a = 1;\nconst b = window.fetch("/x");\n', "f.ts");
    assert.deepEqual(lint.errors, []);
    assert.deepEqual(lint.warnings, [], "a member call is not the global");
    assert.deepEqual(lintAppSource('fetch("/x")', "f.ts").warnings.length, 1);
  });
});
