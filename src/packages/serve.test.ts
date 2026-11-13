/**
 * SERVE MODE (src/packages/serve.ts; plans/app-repos.md §4, work item 1):
 * `serve.yaml` read and checked, and a strut booted with a `file:` ref and
 * a `pk:` ref serving the package's app at `/` — the "Serve, offline"
 * validation of the plan, over the refs that exist today.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStrut, type Strut } from "../createStrut.js";
import { MemoryRunStore } from "../store.js";
import { WorkspaceManager } from "../workspace.js";
import { STEP_RUN_TOOL } from "../apps/tools.js";
import type { KitLocation } from "../apps/kit.js";
import { kitForTests } from "../test-util/app-kit.js";
import { lucideIconSvg, parseServeFile, planServe, serveRefOf, servedHtml, type ServeStatus } from "./serve.js";
import { signInOf } from "../public-surface.js";
import type { StepContext } from "../core.js";
import type { Proposal } from "../proposals.js";
import { buildRegistryTools } from "../steps/core/agent.js";

const HELLO = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "__fixtures__", "hello");
const KEY = "serve-api-key";
const auth = { authorization: `Bearer ${KEY}` };
const INDEX_HTML = `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <link rel="icon" href="./favicon.ico" />\n    <title>strut</title>\n  </head>\n  <body><div id="app"></div></body>\n</html>\n`;

const PEEK = `import { z, defineStep } from "strut";
export default defineStep({ type: "acme/hello/peek", effect: "read", input: z.object({}), output: z.any(), async run(_cfg, ctx) { return { app: ctx.app ?? null }; } });
`;
const GREET = "name: acme/hello/greet\ninput:\n  who: { type: string, required: false, default: world }\nsteps:\n  - { id: say, type: log, config: { message: \"hi {{ input.who }}\" } }\n";
const SERVE = "app: hello\ntitle: Hello, served\ndescription: The fixture app, at /.\nimage: apps/hello/public/logo.svg\nreads: [peek]\nrunnable:\n  - { kind: workflow, name: greet }\nconcepts: [Hello]\n";

const saved: Record<string, string | undefined> = {};
before(() => {
  for (const k of ["STRUT_API_KEY", "STRUT_SECRET_KEY", "STRUT_PACKAGE_INDEXES"]) saved[k] = process.env[k];
  process.env["STRUT_API_KEY"] = KEY;
  process.env["STRUT_SECRET_KEY"] = "serve-secret";
  process.env["STRUT_PACKAGE_INDEXES"] = "[]";
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const boot = (dir: string, kit: KitLocation, extra: Record<string, unknown> = {}) =>
  createStrut({
    workspace: new WorkspaceManager(join(dir, "ws")),
    store: new MemoryRunStore(),
    kit,
    webDist: join(dir, "web"),
    scheduler: false,
    enableChat: false,
    // A visitor's page calls its app on `/public/mcp`.
    enableMcp: true,
    systemWorkflows: false,
    browserWorkflows: false,
    privacyWorkflows: false, mediaWorkflows: false,
    job: false,
    orchestrator: false,
    builder: false,
    views: false,
    concepts: false,
    stt: false,
    subscriptionPoll: false,
    autoResume: false,
    ...extra,
  });

describe("serve.yaml", () => {
  const info = {
    manifest: { package: "acme/moon", version: "1.0.0" },
    files: ["serve.yaml", "strut.yaml", "apps/game/app.yaml", "apps/game/public/og.png", "workflows/ghost.yaml", "steps/board.ts"],
    items: [
      { kind: "app" as const, name: "acme/moon/game", path: "apps/game" },
      { kind: "workflow" as const, name: "acme/moon/ghost", path: "workflows/ghost.yaml" },
      { kind: "step" as const, name: "acme/moon/board", path: "steps/board.ts" },
    ],
  };

  it("names resolve package-first and are written whole into the public view record", () => {
    const plan = planServe(
      parseServeFile("app: game\ntitle: Moon Lander\nimage: apps/game/public/og.png\nreads: [board, graph/find]\nrunnable:\n  - { kind: workflow, name: ghost, base: 0.002, markup: 1.3, capUsd: 0.05, dailyCapUsd: 5 }\n  - { kind: workflow, name: elsewhere }\nconcepts: [Moon Lander]\n"),
      info,
    );
    assert.equal(plan.app, "acme/moon/game");
    assert.equal(plan.title, "Moon Lander");
    assert.equal(plan.image, "apps/game/public/og.png");
    assert.deepEqual(plan.surface, {
      concepts: ["Moon Lander"],
      workflows: [],
      steps: [],
      types: [],
      apps: [{ name: "acme/moon/game", reads: ["acme/moon/board", "graph/find"] }],
      runnable: [
        { kind: "workflow", name: "acme/moon/ghost", base: 0.002, markup: 1.3, capUsd: 0.05, dailyCapUsd: 5 },
        { kind: "workflow", name: "elsewhere" },
      ],
    });
  });

  it("signIn, visitorKey and limits become the record's visitors (plans/app-repos.md §5)", () => {
    const plan = planServe(parseServeFile("app: game\nsignIn: [key, nostr]\nvisitorKey: domain\nlimits: { writesPerDay: 500 }\n"), info);
    assert.deepEqual(plan.surface.visitors, { signIn: ["key", "nostr"], visitorKey: "domain", limits: { writesPerDay: 500 } });
    const quiet = planServe(parseServeFile("app: game\nvisitorKey: root\n"), info).surface;
    assert.equal(quiet.visitors, undefined, "no signIn: strut's default, unwritten");
    assert.deepEqual(signInOf(quiet), ["sphinx"], "the default: a visitor's Sphinx account");
    assert.deepEqual(planServe(parseServeFile("app: game\nvisitorKey: domain\n"), info).surface.visitors, { signIn: ["sphinx"], visitorKey: "domain" });
    assert.deepEqual(planServe(parseServeFile("app: game\nsignIn: []\n"), info).surface.visitors, { signIn: [] }, "signIn: [] is no sign-in");
    assert.deepEqual(signInOf(planServe(parseServeFile("app: game\nsignIn: []\n"), info).surface), []);
    assert.deepEqual(planServe(parseServeFile("app: game\nsignIn: [key]\nvisitorKey: root\n"), info).surface.visitors, { signIn: ["key"] });
  });

  it("refuses what it cannot apply whole, naming it", () => {
    assert.throws(() => parseServeFile("title: x\n"), /serve_invalid: serve.yaml: app: /);
    assert.throws(() => parseServeFile("app: game\nwidth: 3\n"), /unknown field width/);
    assert.throws(() => parseServeFile("app: game\nsignIn: [passkey]\n"), /signIn lists sign-ins strut knows: key, ticket, lnurl, nostr/);
    assert.throws(() => parseServeFile("app: game\nvisitorKey: child\n"), /visitorKey is root or domain/);
    assert.throws(() => parseServeFile("app: game\nlimits: { writesPerDay: -1 }\n"), /writesPerDay is 0 or more/);
    assert.throws(() => parseServeFile("app: game\nlimits: { readsPerDay: 5 }\n"), /readsPerDay/);
    assert.throws(() => parseServeFile("app: game\nimage: og.txt\n"), /image is an image file/);
    assert.throws(() => parseServeFile("app: game\nrunnable:\n  - { kind: workflow, name: ghost, dailyCapUsd: 0 }\n"), /runnable: workflow "ghost": a daily cap of 0 refuses every run/);
    assert.throws(() => parseServeFile("app: [\n"), /not valid YAML/);
    assert.throws(() => planServe(parseServeFile("app: nope\n"), info), /app: "nope" is not an app of acme\/moon \(it holds game/);
    assert.throws(() => planServe(parseServeFile("app: game\nimage: apps/game/og.png\n"), info), /image: apps\/game\/og.png is not a file in the package/);
  });

  it("the ref: from the options, else STRUT_SERVE (+ STRUT_SERVE_URL, STRUT_SERVE_TOKEN_SECRET)", () => {
    assert.equal(serveRefOf(undefined, {}), undefined);
    assert.equal(serveRefOf(false, { STRUT_SERVE: "file:/x" }), undefined);
    assert.deepEqual(serveRefOf(undefined, { STRUT_SERVE: " acme/moon " }), { ref: "acme/moon" });
    assert.deepEqual(serveRefOf({ ref: "file:/x" }, { STRUT_SERVE: "acme/moon" }), { ref: "file:/x" });
    const pk = `pk:${"y".repeat(52)}/acme/moon`;
    assert.deepEqual(serveRefOf(undefined, { STRUT_SERVE: pk, STRUT_SERVE_URL: "https://a.example/packages/catalog?public=1" }), { ref: pk, url: "https://a.example/packages/catalog?public=1" });
    assert.throws(() => serveRefOf(undefined, { STRUT_SERVE: pk }), /STRUT_SERVE: .*needs STRUT_SERVE_URL/);
    assert.deepEqual(serveRefOf(undefined, { STRUT_SERVE: "git+https://github.com/acme/moon@main#strut", STRUT_SERVE_TOKEN_SECRET: "MOON_GH" }), { ref: "git+https://github.com/acme/moon@main#strut", tokenSecret: "MOON_GH" });
    assert.deepEqual(serveRefOf({ ref: "git+https://github.com/acme/moon" }, {}), { ref: "git+https://github.com/acme/moon" });
    assert.throws(() => serveRefOf(undefined, { STRUT_SERVE: "git+https://github.com/acme/moon@main", STRUT_SERVE_TOKEN_SECRET: "ghp-x" }), /STRUT_SERVE: .*STRUT_SERVE_TOKEN_SECRET is the NAME of a secret/);
    assert.throws(() => serveRefOf(undefined, { STRUT_SERVE: "acme/moon", STRUT_SERVE_TOKEN_SECRET: "GH" }), /STRUT_SERVE_TOKEN_SECRET goes with a git\+ ref/);
    assert.throws(() => serveRefOf(undefined, { STRUT_SERVE: "git+https://github.com/acme/moon@" }), /STRUT_SERVE: .*nothing after @/);
    assert.throws(() => serveRefOf(undefined, { STRUT_SERVE: "moon" }), /a ref is publisher\/name/);
  });

  it("the page / is: the meta, the title, the icon and the link preview, escaped", () => {
    const html = servedHtml(INDEX_HTML, { app: "acme/moon/game", title: "Moon <Lander>", description: 'Land "softly"', image: true, icon: "<svg/>" }, "https://moon.example");
    assert.match(html, /<head>\n    <meta name="strut-serve" content="acme\/moon\/game" \/>/);
    assert.match(html, /<title>Moon &lt;Lander&gt;<\/title>/);
    assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,%3Csvg%2F%3E" \/>/);
    assert.match(html, /<meta property="og:description" content="Land &quot;softly&quot;" \/>/);
    assert.match(html, /<meta property="og:image" content="https:\/\/moon.example\/serve\/image" \/>/);
    assert.match(html, /<meta property="og:url" content="https:\/\/moon.example\/" \/>/);
    const before = servedHtml(INDEX_HTML, null, "https://moon.example");
    assert.match(before, /<meta name="strut-serve" content="" \/>/, "nothing deployed yet: the page says so");
    assert.match(before, /<title>strut<\/title>/);
  });

  it("the app's lucide icon from the kit, as a favicon", async () => {
    const svg = lucideIconSvg(await kitForTests(), "hand");
    assert.match(svg ?? "", /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"[^>]*viewBox="0 0 24 24".*<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"\/>/);
    assert.equal(lucideIconSvg(await kitForTests(), "no-such-icon-anywhere"), undefined);
    assert.equal(lucideIconSvg(await kitForTests(), "../../etc/passwd"), undefined);
  });
});

describe("a served box over a file: ref", () => {
  let root: string;
  let pkg: string;
  let kit: KitLocation;
  let strut: Strut;

  const rpc = async (method: string, params: unknown) => {
    const res = await strut.app.request("/public/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    return line ? JSON.parse(line.slice(6)) : JSON.parse(text);
  };
  const status = async () => (await (await strut.app.request("/serve", { headers: auth })).json()) as ServeStatus;
  const page = async (q = "") => {
    const res = await strut.app.request(`/${q}`);
    assert.equal(res.status, 200);
    return res.text();
  };
  const write = async (rel: string, text: string) => {
    await mkdir(dirname(join(pkg, rel)), { recursive: true });
    await writeFile(join(pkg, rel), text);
  };

  before(async () => {
    kit = await kitForTests();
    root = await mkdtemp(join(tmpdir(), "strut-serve-"));
    await mkdir(join(root, "web"), { recursive: true });
    await writeFile(join(root, "web", "index.html"), INDEX_HTML);
    pkg = join(root, "moon");
    await cp(HELLO, join(pkg, "apps", "hello"), { recursive: true });
    await write("apps/hello/app.yaml", "title: Hello\ndescription: The fixture app.\nicon: hand\ngrants:\n  workflows: [greet]\n  steps: [acme/hello/peek]\n");
    await write("strut.yaml", "package: acme/hello\nversion: 1.0.0\n");
    await write("steps/peek.ts", PEEK);
    await write("workflows/greet.yaml", GREET);
    await write("serve.yaml", SERVE);
    strut = await boot(root, kit, { serve: { ref: `file:${pkg}` } });
  });
  after(async () => {
    await strut?.close();
    await rm(root, { recursive: true, force: true });
  });

  it("boots, installs the package through the distro's door and serves its app at /", async () => {
    // The boot's own deploy, or this sync joining it.
    const first = await strut.serve!.sync();
    assert.notEqual(first.status, "error", first.error);
    assert.equal((await strut.serve!.sync()).status, "current", "nothing moved since");
    const s = await status();
    assert.equal(s.error, undefined, s.error);
    assert.equal(s.ref, `file:${pkg}`);
    assert.equal(s.serving?.package, "acme/hello");
    assert.equal(s.serving?.app, "acme/hello/hello");
    assert.equal(s.serving?.appVersion, "v1");
    assert.ok(s.fetchedAt && s.serving?.at);
    assert.equal((await strut.workspace.getWorkflowMetadata("acme/hello/greet"))?.versions["v1"]?.source, "distro");

    const html = await page();
    assert.match(html, /<meta name="strut-serve" content="acme\/hello\/hello" \/>/);
    assert.match(html, /<title>Hello, served<\/title>/);
    assert.match(html, /<meta property="og:description" content="The fixture app, at \/." \/>/);
    assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,%3Csvg/, "the app's icon");
    assert.match(await page("index.html"), /<meta name="strut-serve" content="acme\/hello\/hello" \/>/);
    const image = await strut.app.request("/serve/image");
    assert.equal(image.status, 200, "the link preview's image is open to anyone");
    assert.match(image.headers.get("content-type") ?? "", /image\/svg\+xml/);
    assert.equal(image.headers.get("content-security-policy"), "sandbox");
  });

  it("the public view is serve.yaml's: the app held at the version installed, the reads and runnable written whole", async () => {
    const view = (await (await strut.app.request("/public-view", { headers: auth })).json()) as { surface: Record<string, unknown> };
    assert.deepEqual(view.surface["apps"], [{ name: "acme/hello/hello", reads: ["acme/hello/peek"] }]);
    assert.deepEqual(view.surface["runnable"], [{ kind: "workflow", name: "acme/hello/greet" }]);
    assert.deepEqual(view.surface["concepts"], ["Hello"]);
    const rel = await strut.apps.releases("acme/hello/hello");
    assert.equal(rel?.releases.find((r) => r.id === rel.live)?.version, "v1", "held, as a person's public view holds an app");
  });

  it("the app's document opens as a visitor, and an anonymous read answers", async () => {
    const info = await strut.app.request("/public/apps/acme%2Fhello%2Fhello");
    assert.equal(info.status, 200);
    assert.equal(((await info.json()) as { version: string }).version, "v1");
    const doc = await strut.app.request("/public/apps/acme%2Fhello%2Fhello/document");
    assert.equal(doc.status, 200);
    const identity = (await doc.text()).match(/<meta name="strut-app-token" content="([^"]+)">/)![1]!.replace(/&amp;/g, "&");
    const r = await rpc("tools/call", { name: STEP_RUN_TOOL, arguments: { type: "acme/hello/peek", config: {}, app: identity } });
    assert.ok(!r.result.isError, r.result.content[0].text);
    assert.deepEqual(JSON.parse(r.result.content[0].text), { app: { name: "acme/hello/hello", version: "v1" } });
    const listed = await strut.app.request("/public");
    assert.equal(listed.status, 200);
    assert.ok(JSON.stringify(await listed.json()).includes("acme/hello/greet"), "anyone may run greet");
  });

  it("everything else stays behind the key: GET /serve is the operator's, PUT /public-view is refused", async () => {
    assert.equal((await strut.app.request("/serve")).status, 401);
    assert.equal((await strut.app.request("/workflows")).status, 401);
    const put = await strut.app.request("/public-view", { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ apps: [] }) });
    assert.equal(put.status, 409);
    assert.match(((await put.json()) as { error: string }).error, /serve_owned: .*serve\.yaml writes the public view at every deploy/);
  });

  it("an agent's app/make-public is refused as the route is: the card says so, and an admin's yes changes nothing (serve_owned:)", async () => {
    const before = await (await strut.app.request("/public-view", { headers: auth })).json();
    const ctx = { runId: "r1", path: "builder/turn", scope: {}, input: undefined, emit: async () => {}, services: strut.services, registry: strut.getRegistry(), actor: "ann" } as StepContext;
    const tool = buildRegistryTools(["app/make-public"], strut.getRegistry(), ctx, (d: unknown) => d, { approve: new Set(["app/make-public"]) })["app_make_public"] as { execute(i: unknown, o: unknown): Promise<{ proposal: string }> };
    const { proposal } = await tool.execute({ name: "acme/hello/hello" }, { strutToolPath: "builder/turn/001-app_make_public" });
    const rec = (await (strut.services as { proposals: { get(id: string): Promise<Proposal | null> } }).proposals.get(proposal))!;
    assert.match(rec.summary!, /Accepting it fails: this strut server serves file:.*, whose serve\.yaml writes the public view at every deploy/);
    const res = await strut.app.request(`/proposals/${proposal}/decide`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ action: "accept" }) });
    const body = (await res.json()) as Proposal;
    assert.equal(body.status, "failed");
    assert.match(body.result!.error!, /^serve_owned: .*serve\.yaml writes the public view at every deploy/);
    assert.deepEqual(await (await strut.app.request("/public-view", { headers: auth })).json(), before, "nothing changed");
  });

  it("/?shell=1 with the key is strut's own page; without it, still the app", async () => {
    assert.match(await page(`?shell=1&key=${KEY}`), /<title>strut<\/title>/);
    assert.doesNotMatch(await page(`?shell=1&key=${KEY}`), /strut-serve/);
    assert.match(await page("?shell=1"), /<meta name="strut-serve" content="acme\/hello\/hello" \/>/);
  });

  it("a changed package is served after a redeploy", async () => {
    await write("serve.yaml", SERVE.replace("Hello, served", "Hello again"));
    await write("apps/hello/src/lib/greet.ts", "export const greet = (who: string) => `Hi again, ${who}!`;\n");
    const out = await strut.serve!.sync();
    assert.equal(out.status, "deployed", out.error);
    assert.match(await page(), /<title>Hello again<\/title>/);
    const s = await status();
    assert.equal(s.serving?.appVersion, "v2");
    assert.equal(((await (await strut.app.request("/public/apps/acme%2Fhello%2Fhello")).json()) as { version: string }).version, "v2", "the public view holds the version just installed");
    assert.equal((await strut.serve!.sync()).status, "current");
  });

  it("a bad serve.yaml keeps the previous deploy serving, and GET /serve says why", async () => {
    const before = await status();
    await write("serve.yaml", "app: nope\n");
    const out = await strut.serve!.sync();
    assert.equal(out.status, "error");
    const s = await status();
    assert.match(s.error ?? "", /serve_invalid: serve.yaml: app: "nope" is not an app of acme\/hello/);
    assert.ok(s.errorAt && s.errorDigest && s.errorDigest !== before.serving?.digest);
    assert.deepEqual(s.serving, before.serving);
    assert.match(await page(), /<title>Hello again<\/title>/);

    // Past the install: a runnable item the server refuses. The app stays
    // held where it was, and so does the public view.
    await write("serve.yaml", SERVE.replace("name: greet", "name: plain").replace("Hello, served", "Never shown"));
    await write("workflows/plain.yaml", "name: acme/hello/plain\nsteps:\n  - { id: say, type: log, config: { message: hi } }\n");
    const refused = await strut.serve!.sync();
    assert.equal(refused.status, "error");
    assert.match(refused.error ?? "", /workflow "acme\/hello\/plain" declares no input: block/);
    assert.deepEqual((await status()).serving, before.serving);
    assert.match(await page(), /<title>Hello again<\/title>/);
    assert.equal(((await (await strut.app.request("/public/apps/acme%2Fhello%2Fhello")).json()) as { version: string }).version, "v2");

    // Fixed: the next deploy serves and clears the error.
    await write("serve.yaml", SERVE.replace("Hello, served", "Fixed"));
    assert.equal((await strut.serve!.sync()).status, "deployed");
    const fixed = await status();
    assert.equal(fixed.error, undefined);
    assert.match(await page(), /<title>Fixed<\/title>/);
  });

  it("a restart whose ref no longer resolves keeps serving what it served", async () => {
    const before = await status();
    await strut.close();
    await rm(join(pkg, "strut.yaml"));
    strut = await boot(root, kit, { serve: { ref: `file:${pkg}` } });
    await strut.close(); // waits for the boot's deploy
    strut = await boot(root, kit, { serve: { ref: `file:${pkg}` } });
    const s = await status();
    assert.deepEqual(s.serving, before.serving);
    assert.match(s.error ?? "", /bad_package: no strut\.yaml/);
    assert.match(await page(), /<title>Fixed<\/title>/);
    assert.equal((await strut.app.request("/public/apps/acme%2Fhello%2Fhello/document")).status, 200);
  });
});

describe("a served box over a pk: ref, followed as a subscription is", () => {
  let root: string;
  let kit: KitLocation;
  let publisher: Strut;
  let served: Strut | undefined;
  let publisherWs: WorkspaceManager;
  let base: string;
  const json = (body: unknown, method = "POST") => ({ method, headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });

  before(async () => {
    kit = await kitForTests();
    root = await mkdtemp(join(tmpdir(), "strut-serve-pk-"));
    await mkdir(join(root, "web"), { recursive: true });
    await writeFile(join(root, "web", "index.html"), INDEX_HTML);
    publisherWs = new WorkspaceManager(join(root, "publisher", "ws"));
    publisher = await createStrut({
      workspace: publisherWs, store: new MemoryRunStore(), kit, serveUi: false, scheduler: false, enableChat: false, systemWorkflows: false,
      browserWorkflows: false, privacyWorkflows: false, mediaWorkflows: false, job: false, orchestrator: false, builder: false, views: false, jamie: false,
      knowledge: false, concepts: false, stt: false, subscriptionPoll: false, autoResume: false,
    });
    base = `http://127.0.0.1:${await publisher.listen(0, "127.0.0.1")}`;
    await publisherWs.publishWorkflow("greet", "v1", "name: greet\ninput:\n  who: { type: string, required: false, default: world }\nsteps:\n  - { id: say, type: log, config: { message: \"hi {{ input.who }}\" } }\n");
    const app = join(root, "app");
    await cp(HELLO, app, { recursive: true });
    await writeFile(join(app, "app.yaml"), "title: Hello\nicon: hand\ngrants:\n  workflows: [greet]\n  steps: []\n");
    const r = await publisher.apps.publish(app, "hello", { surface: "person" });
    assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
  });
  after(async () => {
    await served?.close();
    await publisher?.close();
    await rm(root, { recursive: true, force: true });
  });

  const release = async (version: string, title: string) => {
    const res = await publisher.app.request("/packages/publish", json({
      package: "acme/hello", version, apps: ["hello"], workflows: ["greet"], channel: "stable", public: true,
      serve: { app: "hello", title, runnable: [{ kind: "workflow", name: "greet" }] },
    }));
    const body = (await res.json()) as { digest: string; files: string[]; error?: string };
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.ok(body.files.includes("serve.yaml"), "the build carries serve.yaml");
    return body;
  };

  it("a build refuses a serve.yaml that names what it does not carry", async () => {
    const res = await publisher.app.request("/packages/build", json({ package: "acme/hello", version: "0.0.1", apps: ["hello"], dryRun: true, serve: { app: "other" } }));
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /package_build_refused: serve.yaml: app: "other" is not an app of acme\/hello/);
  });

  it("installs the public release, and the publisher's ping deploys the next one", async () => {
    const v1 = await release("1.0.0", "Hello v1");
    const pub = (await (await publisher.app.request("/publisher", { headers: auth })).json()) as { public?: string };
    assert.ok(pub.public, "the public key, minted by Make public");
    const ref = `pk:${pub.public}/acme/hello`;
    served = await boot(join(root, "served"), kit, { serve: { ref, url: `${base}/packages/catalog?public=1` }, webDist: join(root, "web") });
    const first = await served.serve!.sync();
    assert.notEqual(first.status, "error", first.error);
    let s = (await (await served.app.request("/serve", { headers: auth })).json()) as ServeStatus;
    assert.equal(s.error, undefined, s.error);
    assert.equal(s.serving?.digest, v1.digest);
    assert.equal(s.serving?.app, "acme/hello/hello");
    assert.match(await (await served.app.request("/")).text(), /<title>Hello v1<\/title>/);
    const view = (await (await served.app.request("/public-view", { headers: auth })).json()) as { surface: { runnable: unknown } };
    assert.deepEqual(view.surface.runnable, [{ kind: "workflow", name: "acme/hello/greet" }]);

    // A new public release, and the ping a publisher sends with its public key.
    const v2 = await release("1.1.0", "Hello v2");
    const other = await served.app.request("/packages/subscriptions/sync", json({ key: "z".repeat(52) }));
    assert.equal(other.status, 202);
    const ping = await served.app.request("/packages/subscriptions/sync", json({ key: pub.public }));
    assert.equal(ping.status, 202);
    for (let i = 0; i < 100; i++) {
      s = (await (await served.app.request("/serve", { headers: auth })).json()) as ServeStatus;
      if (s.serving?.digest === v2.digest && !s.deploying) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(s.serving?.digest, v2.digest, JSON.stringify(s));
    assert.match(await (await served.app.request("/")).text(), /<title>Hello v2<\/title>/);
  });
});
