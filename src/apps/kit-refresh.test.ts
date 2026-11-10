import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StepContext } from "../core.js";
import type { StrutCapabilities } from "../capabilities.js";
import { createStrut } from "../createStrut.js";
import { MemoryRunStore } from "../store.js";
import { FileWorkspaceStore } from "../workspace.js";
import { treeFiles } from "../version.js";
import { kitForTests } from "../test-util/app-kit.js";
import { createApps, type AppsCapability, type AppListing, type AppView } from "./apps.js";
import { readBuildInfo, type BuildInfo } from "./build.js";
import { kitDigestOf, loadKit, type Kit, type KitLocation } from "./kit.js";
import appGet from "../steps/lib/app/get.js";

/**
 * The kit rebuild (plans/managed-packages.md §6): an app's libraries are the
 * kit's, compiled into its document, so a version whose document was built
 * on another kit — `dist/build.json` names another digest, or none — is
 * rebuilt in place on this one: the active versions at boot, any other when
 * it is next read. Same version, same label, same tree hash; a held app
 * gets no draft; a rebuild that fails keeps the old document and marks the
 * app `kitBehind`; the served document's `ETag` moves with its bytes.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "__fixtures__", "hello");

let where: KitLocation;
/** The kit as it is. */
let kitA: Kit;
/** Another kit: another digest, and a base stylesheet with one more rule, so a document built on it differs. */
let kitB: Kit;
/** A kit the fixture does not build on: it has no react-router. */
let kitC: Kit;
let root: string;
before(async () => {
  where = await kitForTests();
  kitA = loadKit(where);
  kitB = { ...kitA, digest: "b".repeat(64), baseCss: `${kitA.baseCss}\n.kit-b-only { color: red; }\n` };
  const { "react-router": _gone, ...imports } = kitA.imports;
  kitC = { ...kitA, digest: "c".repeat(64), imports };
  root = await mkdtemp(join(tmpdir(), "strut-kit-refresh-"));
});

let n = 0;
const fresh = (name = "d") => join(root, `${name}-${++n}`);

async function writeApp(dir: string, files: Record<string, string>): Promise<string> {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, dirname(rel)), { recursive: true });
    await writeFile(join(dir, rel), text, "utf8");
  }
  return dir;
}

/** The apps capability over `dataDir` on `kit`: a strut booted on that kit. */
const on = (dataDir: string, kit: Kit, now = 0): AppsCapability => createApps({ workspace: new FileWorkspaceStore(dataDir), kit, now: () => new Date(now) });

/** The fixture, copied to a directory of its own to publish from. */
async function fixture(): Promise<string> {
  const dir = fresh();
  await cp(FIXTURE, dir, { recursive: true });
  return dir;
}

const versionPath = (dataDir: string, name: string, version: string) => join(dataDir, "apps", ...name.split("/"), version);
const documentOf = (dataDir: string, name: string, version: string) => readFile(join(versionPath(dataDir, name, version), "dist", "index.html"), "utf8");
const buildOf = async (dataDir: string, name: string, version: string) => (await readBuildInfo(versionPath(dataDir, name, version)))!;

/** `fn` with console.warn collected instead of printed. */
async function quiet<T>(fn: () => Promise<T>): Promise<{ result: T; warned: string[] }> {
  const warned: string[] = [];
  const real = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
  try {
    return { result: await fn(), warned };
  } finally {
    console.warn = real;
  }
}

describe("the kit rebuild", () => {
  it("build.json records the kit's digest: the sha256 of its vendor/manifest.json", async () => {
    const dataDir = fresh("ws");
    const r = await on(dataDir, kitA).publish(await fixture(), "hello", { surface: "person" });
    assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
    const build = await buildOf(dataDir, "hello", "v1");
    assert.deepEqual(build.kit, { name: kitA.manifest.name, version: kitA.manifest.version, digest: kitA.digest });
    assert.match(kitA.digest, /^[0-9a-f]{64}$/);
    assert.equal(kitDigestOf(where), kitA.digest, "read without loading the kit");
    assert.equal(kitDigestOf(kitB), kitB.digest);
    assert.equal(kitDigestOf({ vendorDir: join(root, "no-such-vendor") }), null, "no vendor layer, no digest");
  });

  it("at boot a document built on another kit is rebuilt in place: the same version, label and tree hash, nothing new recorded", async () => {
    const dataDir = fresh("ws");
    const published = await on(dataDir, kitA).publish(await fixture(), "hello", { surface: "person", actor: "alice" });
    assert.ok(published.ok);
    const before = await documentOf(dataDir, "hello", "v1");
    assert.ok(!before.includes(".kit-b-only"));
    const record = JSON.stringify(await new FileWorkspaceStore(dataDir).getApp("hello"));

    // The same kit: nothing to do, nothing rewritten.
    assert.deepEqual(await on(dataDir, kitA, 5000).refreshKit(), { rebuilt: [], failed: [] });
    assert.equal((await buildOf(dataDir, "hello", "v1")).builtAt, new Date(0).toISOString());

    // A strut on another kit.
    const apps = on(dataDir, kitB, 5000);
    assert.deepEqual(await apps.refreshKit(), { rebuilt: ["hello@v1"], failed: [] });
    const build = await buildOf(dataDir, "hello", "v1");
    assert.deepEqual([build.kit.digest, build.hash, build.builtAt], [kitB.digest, published.hash, new Date(5000).toISOString()]);
    const after = await documentOf(dataDir, "hello", "v1");
    assert.ok(after.includes(".kit-b-only"), "the document is this kit's");
    assert.ok(after.includes("About this fixture."), "of the same sources");
    assert.equal(JSON.stringify(await new FileWorkspaceStore(dataDir).getApp("hello")), record, "the record is as it was: no version, no pointer moved");
    const view = (await apps.get("hello"))!;
    assert.deepEqual([view.version, view.hash, view.stale, view.kitBehind, Object.keys(view.versions)], ["v1", published.hash, false, undefined, ["v1"]]);
    assert.deepEqual((await apps.list()).map((a) => [a.name, a.activeVersion, a.kitBehind]), [["hello", "v1", undefined]]);
    // Once: the next pass, and the next strut on that kit, find it current.
    assert.deepEqual(await apps.refreshKit(), { rebuilt: [], failed: [] });
    assert.deepEqual(await on(dataDir, kitB, 9000).refreshKit(), { rebuilt: [], failed: [] });
    assert.equal((await buildOf(dataDir, "hello", "v1")).builtAt, new Date(5000).toISOString());
  });

  it("a build.json with no digest is behind, and rebuilt once; a version that is not active is rebuilt when it is next read, never by a read of its sources", async () => {
    const dataDir = fresh("ws");
    const dir = await fixture();
    const first = on(dataDir, kitA);
    assert.ok((await first.publish(dir, "hello", { surface: "person" })).ok);
    await writeFile(join(dir, "src", "lib", "greet.ts"), 'export function greet(w: string) { return `Yo, ${w}`; }\n');
    assert.ok((await first.publish(dir, "hello", { surface: "person" })).ok);
    // Both as a strut from before the digest built them.
    for (const v of ["v1", "v2"]) {
      const file = join(versionPath(dataDir, "hello", v), "dist", "build.json");
      const { kit, ...rest } = JSON.parse(await readFile(file, "utf8")) as BuildInfo;
      await writeFile(file, JSON.stringify({ kit: { name: kit.name, version: kit.version }, ...rest }, null, 2) + "\n");
    }

    const apps = on(dataDir, kitA, 5000);
    assert.deepEqual(await apps.refreshKit(), { rebuilt: ["hello@v2"], failed: [] }, "the active version, at boot");
    assert.deepEqual([(await buildOf(dataDir, "hello", "v2")).kit.digest, (await buildOf(dataDir, "hello", "v1")).kit.digest], [kitA.digest, undefined]);
    // The sources alone (a package build, the history): the document is left.
    assert.equal((await apps.versionDir("hello", "v1", { sources: true }))?.version, "v1");
    assert.equal((await buildOf(dataDir, "hello", "v1")).kit.digest, undefined);
    // Read: rebuilt, on the same sources.
    assert.equal((await apps.versionDir("hello", "v1"))?.version, "v1");
    const v1 = await buildOf(dataDir, "hello", "v1");
    assert.deepEqual([v1.kit.digest, v1.builtAt], [kitA.digest, new Date(5000).toISOString()]);
    assert.ok((await documentOf(dataDir, "hello", "v1")).includes("Hello, "), "v1's own sources");
    assert.equal((await new FileWorkspaceStore(dataDir).getApp("hello"))!.active, "v2");

    // Once: later reads, here and by the next strut, rebuild nothing.
    const later = on(dataDir, kitA, 9000);
    await apps.get("hello", "v1");
    await later.get("hello", "v1");
    await later.get("hello");
    assert.deepEqual(await later.refreshKit(), { rebuilt: [], failed: [] });
    for (const v of ["v1", "v2"]) assert.equal((await buildOf(dataDir, "hello", v)).builtAt, new Date(5000).toISOString(), v);
  });

  it("a rebuild that fails keeps the old document and marks the app kitBehind, with the build's errors, until its sources are fixed", async () => {
    const dataDir = fresh("ws");
    const dir = await fixture();
    assert.ok((await on(dataDir, kitA).publish(dir, "hello", { surface: "person" })).ok);
    const before = await documentOf(dataDir, "hello", "v1");
    const buildBefore = await readFile(join(versionPath(dataDir, "hello", "v1"), "dist", "build.json"), "utf8");

    const apps = on(dataDir, kitC);
    const { result, warned } = await quiet(async () => {
      const first = await apps.refreshKit();
      // Tried once by this strut: a read, and another pass, do not build again.
      await apps.versionDir("hello");
      return [first, await apps.refreshKit()];
    });
    assert.deepEqual(result, [{ rebuilt: [], failed: ["hello@v1"] }, { rebuilt: [], failed: ["hello@v1"] }]);
    assert.equal(warned.length, 1, warned.join("\n"));
    assert.match(warned[0]!, /hello@v1 does not build on this strut server's kit; it keeps the document it has/);
    assert.equal(await documentOf(dataDir, "hello", "v1"), before, "the old document, byte for byte");
    assert.equal(await readFile(join(versionPath(dataDir, "hello", "v1"), "dist", "build.json"), "utf8"), buildBefore);

    const listed = (await apps.list()) as AppListing[];
    assert.deepEqual(listed.map((a) => [a.name, a.activeVersion]), [["hello", "v1"]]);
    assert.match(listed[0]!.kitBehind!.errors.join("\n"), /"react-router" is not in the app kit/);
    const view = (await apps.get("hello"))!;
    assert.deepEqual(view.kitBehind, listed[0]!.kitBehind);
    assert.deepEqual([view.version, view.stale, view.build?.kit.digest, Object.keys(view.versions)], ["v1", false, kitA.digest, ["v1"]], "nothing else changes for the app");
    // The step reads the same view.
    const stepView = (await appGet.run({ name: "hello" }, { services: { apps } } as unknown as StepContext<StrutCapabilities>)) as AppView;
    assert.deepEqual(stepView.kitBehind, view.kitBehind);

    // The fix is a source change: the next version builds on this kit, and the app is no longer behind.
    await writeFile(join(dir, "src", "App.tsx"), 'export default function App() { return <p className="p-2">no router</p>; }\n');
    const fixed = await apps.publish(dir, "hello", { surface: "person" });
    assert.ok(fixed.ok && fixed.version === "v2", fixed.ok ? "" : fixed.errors.join("\n"));
    assert.equal((await apps.list())[0]!.kitBehind, undefined);
    assert.equal((await apps.get("hello"))!.kitBehind, undefined);
    assert.ok((await apps.get("hello", "v1"))!.kitBehind, "v1 is still what it was");
  });

  it("a held app's live version is rebuilt in place: no draft, no release, the hold as it was; its draft when that is read", async () => {
    const dataDir = fresh("ws");
    const dir = await fixture();
    const first = on(dataDir, kitA);
    assert.ok((await first.publish(dir, "hello", { surface: "person" })).ok);
    const release = await first.promote("hello", "v1", { by: "alice" });
    await writeFile(join(dir, "src", "lib", "greet.ts"), 'export function greet(w: string) { return `Yo, ${w}`; }\n');
    const draft = await first.publish(dir, "hello", { surface: "person" });
    assert.ok(draft.ok && draft.version === "v2" && !draft.live, "held: a publish is a draft");
    const record = JSON.stringify(await new FileWorkspaceStore(dataDir).getApp("hello"));

    const apps = on(dataDir, kitB, 5000);
    assert.deepEqual(await apps.refreshKit(), { rebuilt: ["hello@v1"], failed: [] }, "what is live, not the draft");
    assert.ok((await documentOf(dataDir, "hello", "v1")).includes(".kit-b-only"));
    assert.equal((await buildOf(dataDir, "hello", "v2")).kit.digest, kitA.digest, "the draft is as built until it is read");
    const rec = (await new FileWorkspaceStore(dataDir).getApp("hello"))!;
    assert.equal(JSON.stringify(rec), record, "the record is as it was");
    assert.deepEqual([rec.active, rec.live, Object.keys(rec.versions), rec.releases?.map((r) => [r.id, r.version])], ["v1", release.id, ["v1", "v2"], [[release.id, "v1"]]]);
    assert.deepEqual((await apps.releases("hello"))!.live, release.id);

    // The draft, read: rebuilt in place too, still a draft.
    assert.equal((await apps.get("hello", "v2"))!.build?.kit.digest, kitB.digest);
    assert.ok((await documentOf(dataDir, "hello", "v2")).includes("Yo, "));
    assert.equal(JSON.stringify(await new FileWorkspaceStore(dataDir).getApp("hello")), record);
  });

  it("only the kit moves: an imported app stays at the version the document carries, and a granted workflow that is gone does not stop the rebuild", async () => {
    const dataDir = fresh("ws");
    const ws = new FileWorkspaceStore(dataDir);
    await ws.publishWorkflow("report", "v1", "name: report\nsteps:\n  - id: a\n    type: log\n    config: { message: hi }\n");
    const first = createApps({ workspace: ws, kit: kitA, now: () => new Date(0) });
    const ui = await writeApp(fresh(), { "app.yaml": "title: UI\n", "src/index.ts": 'export const PILL = "pill-one";\n', "src/App.tsx": "export default () => null;\n" });
    assert.ok((await first.publish(ui, "acme/ui", { surface: "person" })).ok);
    const importer = await writeApp(fresh(), {
      "app.yaml": "title: Importer\ngrants:\n  workflows: [report]\n",
      "src/App.tsx": 'import { PILL } from "acme/ui";\nexport default function App() { return <p>{PILL}</p>; }\n',
    });
    const r = await first.publish(importer, "importer", { surface: "person" });
    assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
    // Since then: the imported app moved on, and the granted workflow went.
    await writeFile(join(ui, "src", "index.ts"), 'export const PILL = "pill-two";\n');
    assert.ok((await first.publish(ui, "acme/ui", { surface: "person" })).ok);
    await ws.deleteWorkflow("report");

    const apps = on(dataDir, kitB);
    assert.deepEqual(await apps.refreshKit(), { rebuilt: ["acme/ui@v2", "importer@v1"], failed: [] });
    const doc = await documentOf(dataDir, "importer", "v1");
    assert.ok(doc.includes(".kit-b-only") && doc.includes("pill-one") && !doc.includes("pill-two"), "acme/ui@v1, as it was built");
    const build = await buildOf(dataDir, "importer", "v1");
    assert.deepEqual(build.imports.map((i) => [i.name, i.version, i.pinned]), [["acme/ui", "v1", undefined]]);
    const view = (await apps.get("importer"))!;
    assert.deepEqual([view.stale, view.inertGrants, view.kitBehind], [true, ["report"], undefined], "stale and inert as before: the import moved, the grant is gone");
  });
});

describe("the kit rebuild, over HTTP", () => {
  /** Poll until `fn` answers something truthy. */
  async function until<T>(fn: () => Promise<T | undefined | null | false>, what: string, ms = 30_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const got = await fn();
      if (got) return got;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it("a strut booted on another kit rebuilds the active version in the background and serves it under a new ETag; one it cannot build keeps serving, and GET /apps says kitBehind", async () => {
    const dataDir = fresh("http");
    const boot = (kit: Kit | KitLocation) =>
      createStrut({ workspace: new FileWorkspaceStore(dataDir), store: new MemoryRunStore(), kit, scheduler: false, enableChat: false, serveUi: false, views: false });
    const doc = "/apps/hello/v1/files/dist/index.html";
    const digestOnDisk = async () => (await buildOf(dataDir, "hello", "v1")).kit.digest;

    // The kit as it is: publish, and the document's tag.
    let strut = await boot(where);
    let etagA: string;
    try {
      const files: Record<string, string | { base64: string }> = {};
      for (const rel of await treeFiles(FIXTURE)) {
        const bytes = await readFile(join(FIXTURE, rel));
        files[rel] = rel.endsWith(".svg") ? { base64: bytes.toString("base64") } : bytes.toString("utf8");
      }
      const posted = await strut.app.request("/apps", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "hello", files }) });
      assert.equal(posted.status, 201, await posted.text());
      const page = await strut.app.request(doc);
      assert.equal(page.status, 200);
      etagA = page.headers.get("etag")!;
      assert.equal(await digestOnDisk(), kitA.digest);
    } finally {
      await strut.close();
    }

    // Another kit: the boot pass rebuilds it with no read of the version.
    strut = await boot(kitB);
    let etagB: string;
    try {
      await until(async () => (await digestOnDisk()) === kitB.digest, "the boot pass to rebuild hello@v1");
      const page = await strut.app.request(doc, { headers: { "if-none-match": etagA } });
      assert.equal(page.status, 200, "the host's copy is of another document");
      etagB = page.headers.get("etag")!;
      assert.notEqual(etagB, etagA);
      assert.ok((await page.text()).includes(".kit-b-only"));
      assert.equal((await strut.app.request(doc, { headers: { "if-none-match": etagB } })).status, 304);
      const versions = (await (await strut.app.request("/apps/hello/versions")).json()) as { active: string; versions: Record<string, unknown>; live: string };
      assert.deepEqual([versions.active, Object.keys(versions.versions), versions.live], ["v1", ["v1"], "latest"], "the same version, nothing new");
      const list = (await (await strut.app.request("/apps")).json()) as { apps: AppListing[] };
      assert.deepEqual(list.apps.map((a) => [a.name, a.activeVersion, a.kitBehind]), [["hello", "v1", undefined]]);
    } finally {
      await strut.close();
    }

    // A kit it does not build on: the document it has keeps serving, and the app says so.
    const { warned } = await quiet(async () => {
      strut = await boot(kitC);
      try {
        const listed = await until(async () => {
          const { apps } = (await (await strut.app.request("/apps")).json()) as { apps: AppListing[] };
          return apps[0]?.kitBehind ? apps : undefined;
        }, "GET /apps to say kitBehind");
        assert.match(listed[0]!.kitBehind!.errors.join("\n"), /"react-router" is not in the app kit/);
        const page = await strut.app.request(doc, { headers: { "if-none-match": etagB } });
        assert.equal(page.status, 304, "the same document as before");
        assert.equal(page.headers.get("etag"), etagB);
        const view = (await (await strut.app.request("/apps/hello")).json()) as AppView;
        assert.deepEqual([view.version, view.build?.kit.digest, view.kitBehind], ["v1", kitB.digest, listed[0]!.kitBehind]);
      } finally {
        await strut.close();
      }
    });
    assert.equal(warned.filter((w) => w.includes("does not build on this strut server's kit")).length, 1, warned.join("\n"));
  });
});
