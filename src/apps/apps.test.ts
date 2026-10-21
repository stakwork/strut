import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StepContext } from "../core.js";
import type { StrutCapabilities } from "../capabilities.js";
import { fileArtifactsCapability } from "../capabilities.js";
import { createStrut } from "../createStrut.js";
import { fileToken } from "../auth.js";
import { MemoryRunStore } from "../store.js";
import { FileWorkspaceStore } from "../workspace.js";
import { treeFiles } from "../version.js";
import { kitForTests } from "../test-util/app-kit.js";
import { createApps, type AppsCapability } from "./apps.js";
import type { KitLocation } from "./kit.js";
import { readBuildInfo } from "./build.js";
import appList from "../steps/lib/app/list.js";
import appGet from "../steps/lib/app/get.js";
import appInit from "../steps/lib/app/init.js";
import appCheckout from "../steps/lib/app/checkout.js";
import appBuild from "../steps/lib/app/build.js";
import appPublish from "../steps/lib/app/publish.js";

/**
 * The apps capability (plans/apps.md §1.2, §1.3, §8, §9), the `app/*` steps
 * over it, and the `/apps` routes (§7.2): a publish builds first and a
 * failing build publishes nothing; `stale` and `missing`; checkout and init;
 * the meta surface's grant rules against a person's door; the file route
 * serving the document with the token in its meta under `?t=` and without
 * the meta or scripts under the key; a token for another app refused.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "__fixtures__", "hello");
const SEALED_WF = "name: grader-run\nsealed: true\nsteps:\n  - id: a\n    type: log\n    config: { message: hi }\n";

let kit: KitLocation;
let root: string;
before(async () => {
  kit = await kitForTests();
  root = await mkdtemp(join(tmpdir(), "strut-apps-"));
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
const app = (manifest: string, body = 'export default function App() { return <p className="p-2">hi</p>; }\n') => ({ "app.yaml": manifest, "src/App.tsx": body });

/** A registry with a sealed grader and the sealed meta namespace, as `isSealedStep` reads them. */
const REGISTRY = { "grader/judge": { type: "grader/judge", sealed: true }, "graph/graph-get": { type: "graph/graph-get" }, "meta/run-workflow": { type: "meta/run-workflow" }, llm: { type: "llm" } } as unknown as Record<string, never>;

function setup(): { ws: FileWorkspaceStore; apps: AppsCapability; dataDir: string } {
  const dataDir = fresh("ws");
  const ws = new FileWorkspaceStore(dataDir);
  return { ws, apps: createApps({ workspace: ws, kit, getRegistry: () => REGISTRY, now: () => new Date(0) }), dataDir };
}

describe("the apps capability", () => {
  it("a publish builds first; a failing build publishes nothing; a good one records the version and copies the directory, dist/ included", async () => {
    const { ws, apps, dataDir } = setup();
    const dir = await writeApp(fresh(), app("title: Broken\n", 'export default function App() { return <p>{eval("1")}</p>; }\n'));
    const broken = await apps.publish(dir, "hello", { surface: "person" });
    assert.equal(broken.ok, false);
    assert.match(broken.ok ? "" : broken.errors[0]!, /calls eval/);
    assert.deepEqual(await ws.listApps(), []);
    assert.ok(!existsSync(join(dataDir, "apps")), "nothing on disk either");

    const good = fresh();
    await cp(FIXTURE, good, { recursive: true });
    const r = await apps.publish(good, "hello", { surface: "person", actor: "alice" });
    assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
    assert.deepEqual([r.name, r.version, r.changed, r.warnings], ["hello", "v1", true, []]);
    const at = (await apps.versionDir("hello"))!;
    assert.equal(at.path, join(dataDir, "apps", "hello", "v1"));
    for (const f of ["app.yaml", "src/App.tsx", "public/logo.svg", "dist/index.html", "dist/build.json"]) assert.ok(existsSync(join(at.path, f)), f);
    const view = (await apps.get("hello"))!;
    assert.deepEqual([view.version, view.hash, view.missing, view.stale, view.owner, view.inertGrants], ["v1", r.hash, false, false, "alice", []]);
    assert.equal(view.publisher, undefined, "a person's publish stamps no publisher");
    assert.ok(view.files.includes("dist/index.html") && view.files.includes("src/components/ui/badge.tsx"));
    assert.equal(view.build?.hash, r.hash);
    assert.equal(view.dir, at.path);

    // An edit is the next version; the same tree again re-activates it and REBUILDS its document.
    await writeFile(join(good, "src", "lib", "greet.ts"), 'export function greet(w: string) { return `Yo, ${w}`; }\n');
    const v2 = await apps.publish(good, "hello", { surface: "person" });
    assert.ok(v2.ok && v2.version === "v2" && v2.changed);
    assert.ok((await readFile(join(dataDir, "apps", "hello", "v2", "dist", "index.html"), "utf8")).includes("Yo, "));
    const again = await apps.publish(good, "hello", { surface: "person" });
    assert.ok(again.ok && again.version === "v2" && !again.changed);
    assert.deepEqual((await ws.listApps()).map((a) => [a.name, a.activeVersion, a.versions]), [["hello", "v2", ["v1", "v2"]]]);
  });

  it("get: stale after the version's sources change or an imported kit moves (unless pinned); missing when the directory is gone", async () => {
    const { apps, dataDir } = setup();
    const kitDir = await writeApp(fresh(), { "app.yaml": "title: UI\n", "src/index.ts": 'export const PILL = "one";\n', "src/App.tsx": "export default () => null;\n" });
    assert.ok((await apps.publish(kitDir, "acme/ui", { surface: "person" })).ok);
    const importer = await writeApp(fresh(), app("title: Importer\n", 'import { PILL } from "acme/ui";\nexport default function App() { return <p>{PILL}</p>; }\n'));
    const pinned = await writeApp(fresh(), app("title: Pinned\n", 'import { PILL } from "acme/ui@v1";\nexport default function App() { return <p>{PILL}</p>; }\n'));
    assert.ok((await apps.publish(importer, "importer", { surface: "person" })).ok);
    assert.ok((await apps.publish(pinned, "pinned", { surface: "person" })).ok);
    assert.equal((await apps.get("importer"))!.stale, false);
    assert.deepEqual((await apps.get("importer"))!.build!.imports, [{ name: "acme/ui", version: "v1", hash: (await apps.get("acme/ui"))!.hash }]);
    assert.deepEqual((await apps.get("pinned"))!.build!.imports[0]!.pinned, true);

    await writeFile(join(kitDir, "src", "index.ts"), 'export const PILL = "two";\n');
    assert.ok((await apps.publish(kitDir, "acme/ui", { surface: "person" })).ok);
    assert.equal((await apps.get("importer"))!.stale, true, "the kit it imports moved");
    assert.equal((await apps.get("pinned"))!.stale, false, "a pinned import did not");

    // A source edited in the version's directory: the document is older than the sources.
    const at = (await apps.versionDir("importer"))!;
    await writeFile(join(at.path, "src", "App.tsx"), 'import { PILL } from "acme/ui";\nexport default function App() { return <b>{PILL}</b>; }\n');
    assert.equal((await apps.get("importer"))!.stale, true);
    assert.equal((await apps.build(at.path, { name: "importer" })).ok, true, "app/build on the version rebuilds it in place");
    assert.equal((await apps.get("importer"))!.stale, false);
    assert.equal((await readBuildInfo(at.path))!.imports[0]!.version, "v2", "built against the kit's active version now");

    await rm(join(dataDir, "apps", "pinned", "v1"), { recursive: true, force: true });
    const gone = (await apps.get("pinned"))!;
    assert.deepEqual([gone.missing, gone.stale, gone.files, gone.build], [true, true, [], null]);
  });

  it("checkout copies a version into an empty directory; init scaffolds the template, or copies an installed app with no upstream", async () => {
    const { ws, apps } = setup();
    const src = fresh();
    await cp(FIXTURE, src, { recursive: true });
    assert.ok((await apps.publish(src, "hello", { surface: "person", upstream: { package: "acme/hello", version: "1.0.0" } })).ok);
    const to = fresh("co");
    const co = await apps.checkout("hello", to);
    assert.deepEqual([co.path, co.version], [to, "v1"]);
    assert.ok(existsSync(join(to, "src", "App.tsx")) && existsSync(join(to, "dist", "index.html")));
    await assert.rejects(apps.checkout("hello", to), /not empty/);
    await assert.rejects(apps.checkout("hello", fresh("co"), "v9"), /no version v9/);
    await assert.rejects(apps.checkout("nope", fresh("co")), /not found/);

    const scaffold = await apps.init(fresh("init"));
    assert.equal(scaffold.template, "default");
    assert.deepEqual(scaffold.files, ["app.yaml", "src/App.tsx", "src/styles.css"]);
    assert.ok(existsSync(join(scaffold.path, "db")), "an empty db/");
    assert.ok((await apps.build(scaffold.path)).ok, "the scaffold builds");
    const copied = await apps.init(fresh("init"), "hello");
    assert.ok(copied.files.includes("src/App.tsx") && !copied.files.some((f) => f.startsWith("dist/")), "a copy of the sources, no dist");
    assert.ok((await apps.publish(copied.path, "hello-copy", { surface: "person" })).ok);
    assert.equal((await ws.getApp("hello-copy"))?.upstream, undefined, "a copy under a new name has no upstream");
    await assert.rejects(apps.init(fresh("init"), "nope"), /no template "nope" — strut's templates: default; or the name of an installed app/);
    assert.deepEqual(await apps.templates(), ["default"]);
  });

  it("the meta surface may not grant llm / agent / exec, a sealed step or a sealed workflow; a person may", async () => {
    const { ws, apps } = setup();
    await ws.publishWorkflowByContent("grader-run", SEALED_WF);
    await ws.publishWorkflow("plain", "v1", { steps: [{ id: "a", type: "log", config: { message: "x" } }] });
    const cases: Array<[string, RegExp]> = [
      ["grants:\n  steps: [llm]\n", /grants\.steps: "llm" is a paid or shell-shaped step \(llm, agent, exec\) — the workflow is the unit of spend/],
      ["grants:\n  steps: [graph/*, exec]\n", /"exec" is a paid or shell-shaped step/],
      ["grants:\n  steps: ['*']\n", /"\*" reaches "llm", a paid or shell-shaped step/],
      ["grants:\n  steps: [meta/*]\n", /"meta\/\*" is sealed — a person may grant it \(POST \/apps\); the meta surface may not/],
      ["grants:\n  steps: [grader/judge]\n", /"grader\/judge" is sealed/],
      ["grants:\n  steps: [grader/*]\n", /"grader\/\*" reaches "grader\/judge", sealed/],
      ["grants:\n  workflows: [plain, grader-run]\n", /grants\.workflows: "grader-run" is a sealed workflow/],
      ["grants:\n  automations: [grader-run]\n", /grants\.automations: "grader-run" is a sealed workflow/],
    ];
    for (const [grants, re] of cases) {
      const dir = await writeApp(fresh(), app(`title: G\n${grants}`));
      const ai = await apps.publish(dir, "g", { surface: "ai", actor: "bot" });
      assert.equal(ai.ok, false, grants);
      assert.match(ai.ok ? "" : ai.errors.join("\n"), re);
      assert.equal(await ws.getApp("g"), null, "nothing published");
      const person = await apps.publish(dir, "g", { surface: "person", actor: "alice" });
      assert.ok(person.ok, person.ok ? "" : `${grants}: ${person.errors.join("\n")}`);
      assert.equal(await ws.deleteApp("g"), true);
    }
    // What the meta surface may grant: deterministic steps and plain workflows — stamped `ai`.
    const dir = await writeApp(fresh(), app("title: OK\ngrants:\n  workflows: [plain]\n  steps: [graph/*]\n"));
    const ok = await apps.publish(dir, "ok", { surface: "ai", actor: "bot", source: "agent" });
    assert.ok(ok.ok);
    const rec = (await ws.getApp("ok"))!;
    assert.deepEqual([rec.publisher, rec.owner, rec.versions["v1"]?.source], ["ai", "bot", "agent"]);
  });
});

describe("the app/* steps", () => {
  const ctxFor = (apps: AppsCapability, dataDir: string, extra: Record<string, unknown> = {}) =>
    ({ runId: "run-1", path: "wf/s", emit: async () => {}, services: { apps, dataDir, artifacts: fileArtifactsCapability(join(dataDir, "artifacts")) }, actor: "bot", ...extra }) as unknown as StepContext<StrutCapabilities>;

  it("resolve paths inside the job's directory (or the run's), scaffold, build, publish stamped ai, list and get", async () => {
    const { ws, apps, dataDir } = setup();
    const ctx = ctxFor(apps, dataDir, { job: "job-1" });
    const made = (await appInit.run({ path: "apps/tracker" }, ctx)) as { path: string };
    assert.equal(made.path, join(dataDir, "jobs", "job-1", "apps", "tracker"));
    await assert.rejects(appInit.run({ path: "../elsewhere" }, ctx), /leaves the job's directory/);
    await assert.rejects(appInit.run({ path: "/tmp/elsewhere" }, ctx), /leaves the job's directory/);
    const built = (await appBuild.run({ path: "apps/tracker" }, ctx)) as { ok: boolean };
    assert.equal(built.ok, true);
    const published = (await appPublish.run({ name: "tracker", path: "apps/tracker" }, ctx)) as { ok: boolean; version: string };
    assert.deepEqual([published.ok, published.version], [true, "v1"]);
    assert.deepEqual([(await ws.getApp("tracker"))?.publisher, (await ws.getApp("tracker"))?.owner], ["ai", "bot"]);
    assert.deepEqual(((await appList.run({}, ctx)) as { apps: Array<{ name: string }> }).apps.map((a) => a.name), ["tracker"]);
    assert.equal(((await appGet.run({ name: "tracker" }, ctx)) as { stale: boolean }).stale, false);
    await assert.rejects(appGet.run({ name: "nope" }, ctx), /not found/);
    const co = (await appCheckout.run({ name: "tracker", path: "apps/tracker-2" }, ctx)) as { path: string };
    assert.ok(existsSync(join(co.path, "app.yaml")));

    // `job` names another job's directory; a paid grant is refused from here.
    const other = ctxFor(apps, dataDir, { job: "job-2" });
    await appInit.run({ path: "proto" }, other);
    await writeFile(join(dataDir, "jobs", "job-2", "proto", "app.yaml"), "title: Proto\ngrants:\n  steps: [llm]\n");
    const refused = (await appPublish.run({ name: "proto", path: "proto", job: "job-2" }, ctx)) as { ok: boolean; errors: string[] };
    assert.equal(refused.ok, false);
    assert.match(refused.errors[0]!, /paid or shell-shaped/);

    // No job: the run's artifact directory; with neither, an absolute path.
    const runCtx = ctxFor(apps, dataDir);
    assert.equal(((await appInit.run({ path: "apps/x" }, runCtx)) as { path: string }).path, join(dataDir, "artifacts", "run-1", "apps", "x"));
    const bare = { services: { apps }, runId: "r" } as unknown as StepContext<StrutCapabilities>;
    await assert.rejects(appInit.run({ path: "relative" }, bare), /must be absolute/);
    assert.equal(((await appInit.run({ path: fresh("abs") }, bare)) as { template: string }).template, "default");
    await assert.rejects(appList.run({}, { services: {} } as unknown as StepContext<StrutCapabilities>), /need the apps capability/);
  });
});

describe("the /apps routes", () => {
  const KEY = "apps-key";
  const auth = { headers: { authorization: `Bearer ${KEY}` } };

  it("publish from a files map, read back, serve the document with its token, roll back, delete", async () => {
    const dataDir = fresh("http");
    const strut = await createStrut({ workspace: new FileWorkspaceStore(dataDir), store: new MemoryRunStore(), kit, scheduler: false, enableChat: false, serveUi: false, views: false });
    const savedKey = process.env["STRUT_API_KEY"];
    try {
      const files: Record<string, string | { base64: string }> = {};
      for (const rel of await treeFiles(FIXTURE)) {
        const bytes = await readFile(join(FIXTURE, rel));
        files[rel] = rel.endsWith(".svg") ? { base64: bytes.toString("base64") } : bytes.toString("utf8");
      }
      // The key rides on every publish; before it is configured the header is ignored (dev mode), as is the actor.
      const post = (body: unknown) => strut.app.request("/apps", { method: "POST", headers: { "content-type": "application/json", "x-strut-actor": "alice", ...auth.headers }, body: JSON.stringify(body) });

      const bad = await post({ name: "hello", files: { ...files, "src/lib/greet.ts": 'export const greet = (w: string) => eval(w);\n' } });
      assert.equal(bad.status, 400);
      const badBody = (await bad.json()) as { error: string; errors: string[] };
      assert.match(badBody.errors[0]!, /src\/lib\/greet\.ts:1: calls eval/);
      assert.equal((await post({ files })).status, 400, "name required");
      assert.equal((await post({ name: "x@v1", files })).status, 400, "a bad name");
      assert.equal((await post({ name: "hello" })).status, 400, "files required");

      const ok = await post({ name: "hello", files });
      const okText = await ok.text();
      assert.equal(ok.status, 201, okText);
      const published = JSON.parse(okText) as { ok: boolean; name: string; version: string; changed: boolean; hash: string };
      assert.deepEqual([published.ok, published.name, published.version, published.changed], [true, "hello", "v1", true]);
      // A person's door: paid grants are accepted (§9).
      const paid = await post({ name: "paid", files: { ...files, "app.yaml": "title: Paid\ngrants:\n  steps: [llm, exec]\n" } });
      assert.equal(paid.status, 201, await paid.text());

      const list = (await (await strut.app.request("/apps")).json()) as { apps: Array<{ name: string; title: string; activeVersion: string }> };
      assert.deepEqual(list.apps.map((a) => [a.name, a.title, a.activeVersion]), [["hello", "Hello", "v1"], ["paid", "Paid", "v1"]]);
      const view = (await (await strut.app.request("/apps/hello")).json()) as { version: string; stale: boolean; files: string[]; build: { kit: { name: string } }; owner: string };
      assert.deepEqual([view.version, view.stale, view.build.kit.name, view.owner], ["v1", false, "@strut/kit", undefined]);
      assert.ok(view.files.includes("dist/index.html"));
      assert.equal((await strut.app.request("/apps/hello?version=v9")).status, 404);
      assert.equal((await strut.app.request("/apps/nope")).status, 404);
      const versions = (await (await strut.app.request("/apps/hello/versions")).json()) as { active: string; versions: Record<string, { hash: string }> };
      assert.equal(versions.active, "v1");
      assert.equal(versions.versions["v1"]?.hash, published.hash);

      // Dev mode: no token is minted — nothing to attenuate.
      const open = (await (await strut.app.request("/apps/hello/v1/files")).json()) as Record<string, unknown>;
      assert.equal("token" in open, false);

      process.env["STRUT_API_KEY"] = KEY;
      const listed = (await (await strut.app.request("/apps/hello/v1/files", auth)).json()) as { files: string[]; token: string; hash: string };
      assert.equal(listed.hash, published.hash);
      assert.equal(listed.token, fileToken({ kind: "app", id: "hello@v1" }));
      const t = encodeURIComponent(listed.token);
      const status = async (path: string) => (await strut.app.request(path)).status;

      // The document, by token: the token in its meta, scripts allowed.
      const page = await strut.app.request(`/apps/hello/v1/files/dist/index.html?t=${t}`);
      assert.equal(page.status, 200);
      assert.equal(page.headers.get("content-security-policy"), "sandbox allow-scripts");
      assert.equal(page.headers.get("x-content-type-options"), "nosniff");
      const html = await page.text();
      // The app's IDENTITY (auth.ts `appIdentity`): the scope, then the token — what step_run reads the app off.
      assert.ok(html.includes(`<meta name="strut-app-token" content="app:hello@v1.${listed.token}">`), "the identity written in as served");
      assert.ok(html.includes('<script type="module">'));
      assert.ok(!(await readFile(join(dataDir, "apps", "hello", "v1", "dist", "index.html"), "utf8")).includes(listed.token), "dist/ holds no credential");
      // By key: no meta, no script.
      const keyed = await strut.app.request(`/apps/hello/v1/files/dist/index.html?key=${KEY}`);
      assert.equal(keyed.status, 200);
      assert.equal(keyed.headers.get("content-security-policy"), "sandbox");
      assert.ok(!(await keyed.text()).includes('<meta name="strut-app-token"'), "no token meta at all (the kit's code names the meta, which is fine)");
      // Another file by token; a token for another app or version, a tampered one, a traversal: refused.
      assert.equal(await status(`/apps/hello/v1/files/src/App.tsx?t=${t}`), 200);
      assert.equal(await status(`/apps/hello/v1/files?t=${t}`), 200);
      assert.equal(await status(`/apps/paid/v1/files/dist/index.html?t=${t}`), 401);
      assert.equal(await status(`/apps/hello/v2/files/dist/index.html?t=${t}`), 401);
      assert.equal(await status(`/apps/hello/v1/files/dist/index.html?t=${t}x`), 401);
      assert.equal(await status(`/apps/hello/v1/files/dist/index.html`), 401);
      assert.equal((await strut.app.request(`/apps/hello/v1/files/..%2F..%2Fpaid%2Fv1%2Fapp.yaml?key=${KEY}`)).status, 400);
      assert.equal((await strut.app.request(`/apps/hello/v1/files/dist/index.html?t=${t}&key=${KEY}`)).status, 200, "a good token beside the key");
      assert.equal((await strut.app.request(`/apps/paid/v1/files/dist/index.html?t=${t}&key=${KEY}`)).status, 401, "a bad token is refused even with the key");
      assert.equal((await strut.app.request(`/apps/hello/v1/files/nope.txt?t=${t}`)).status, 404);

      // A name with a slash, encoded in the URL; its scope is the decoded name.
      const kitPost = await post({ name: "acme/ui", files: { "app.yaml": "title: UI\n", "src/index.ts": 'export const X = 1;\n', "src/App.tsx": "export default () => null;\n" } });
      assert.equal(kitPost.status, 201, await kitPost.text());
      assert.equal((await strut.app.request("/apps/acme%2Fui", auth)).status, 200);
      const kitListed = (await (await strut.app.request("/apps/acme%2Fui/v1/files", auth)).json()) as { token: string };
      assert.equal(kitListed.token, fileToken({ kind: "app", id: "acme/ui@v1" }));
      assert.equal(await status(`/apps/acme%2Fui/v1/files/app.yaml?t=${encodeURIComponent(kitListed.token)}`), 200);

      // A second version, rollback, delete (the files stay).
      const v2 = await strut.app.request("/apps", { method: "POST", headers: { "content-type": "application/json", ...auth.headers }, body: JSON.stringify({ name: "hello", files: { ...files, "app.yaml": "title: Hello two\n" } }) });
      assert.equal(v2.status, 201);
      assert.equal(((await v2.json()) as { version: string }).version, "v2");
      assert.equal(((await (await strut.app.request("/apps/hello", auth)).json()) as { version: string }).version, "v2");
      const back = await strut.app.request("/apps/hello/active", { method: "PUT", headers: { "content-type": "application/json", ...auth.headers }, body: JSON.stringify({ version: "v1" }) });
      assert.equal(back.status, 200);
      assert.equal(((await (await strut.app.request("/apps/hello", auth)).json()) as { version: string }).version, "v1");
      assert.equal((await strut.app.request("/apps/hello/active", { method: "PUT", headers: { "content-type": "application/json", ...auth.headers }, body: JSON.stringify({ version: "v9" }) })).status, 404);
      assert.equal((await strut.app.request("/apps/hello", { method: "DELETE", ...auth })).status, 200);
      assert.equal((await strut.app.request("/apps/hello", auth)).status, 404);
      assert.equal((await strut.app.request("/apps/hello", { method: "DELETE", ...auth })).status, 404);
      assert.ok(existsSync(join(dataDir, "apps", "hello", "v1", "dist", "index.html")), "the files are kept");
      assert.equal(await status(`/apps/hello/v1/files/dist/index.html?t=${t}`), 404, "but nothing points at them");
    } finally {
      if (savedKey === undefined) delete process.env["STRUT_API_KEY"];
      else process.env["STRUT_API_KEY"] = savedKey;
      await strut.close();
    }
  });
});
