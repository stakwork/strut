/**
 * `app/make-public` (plans/public-surface.md §2 "The door", ruled
 * 2026-11-13): an agent ASKS to put an app in the public view, an ADMIN says
 * yes. The step runs only as a proposal an admin accepted, and the door
 * behind it (`publicView.addApp`) opens only for that accepted record on disk
 * for the app and version; the yes adds the app as the Public view tab does
 * when nobody unticks anything — held at the version the card showed, with
 * the cascade `GET /public-view/needs` pre-checks — through the route's own
 * save, removing nothing; the card lists those lines and who can sign in;
 * the builder and the assistant grant and gate it, the builder chat never
 * gets it.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import type { z } from "zod";

import { createStrut, type Strut } from "../../../createStrut.js";
import { WorkspaceManager } from "../../../workspace.js";
import { MemoryRunStore } from "../../../store.js";
import type { StepContext } from "../../../core.js";
import type { Proposal } from "../../../proposals.js";
import { personToken, signInTicket } from "../../../auth.js";
import { buildRegistryTools } from "../../core/agent.js";
import { RUN_STEP_FLOW } from "../../../run-step.js";
import { builderWorkflowYaml } from "../../../builder-seed.js";
import { jobWorkflowYaml } from "../../../job-seed.js";
import { orchestratorWorkflowYaml } from "../../../orchestrator-seed.js";
import { globToRegExp } from "../../../closure.js";
import { kitForTests } from "../../../test-util/app-kit.js";
import { emptySurface, signInOf, type PublicSurface } from "../../../public-surface.js";
import { makePublicCard, needLine, withNeeds, type PublicViewCapability, type PublicViewNeeds } from "../../../public-view.js";
import { buildTools } from "../../../ai/tools.js";

const KEY = "make-public-key";
const auth = { authorization: `Bearer ${KEY}` };

// ── the pure parts ──────────────────────────────────────────────────────────

const NEEDS: PublicViewNeeds = {
  app: { name: "workers", version: "v2", title: "Workers" },
  workflows: [
    { name: "pets", runs: true, checked: true, note: "its definition and versions, and every run, whole" },
    { name: "gone", runs: true, checked: false, note: "not a workflow on this strut server" },
  ],
  steps: [{ name: "demo/score", checked: true, note: "its schema, its source and the helpers it imports" }],
  reads: [
    { name: "demo/read", checked: true, note: "a read of this server" },
    { name: "demo/write", checked: false, note: "a read of this server" },
  ],
  concepts: [{ name: "Law", checked: false, pages: 0, from: ["pets"], note: "no Concept of that name in this server's graph", missing: true }],
  perRun: ["pets: a Concept named per run ({{ input.kind }})"],
};

describe("app/make-public: the merge and the card", () => {
  it("withNeeds adds the pre-checked lines and nothing else, and takes nothing out", () => {
    const before: PublicSurface = {
      ...emptySurface(),
      concepts: ["Codebase"],
      workflows: [{ name: "pets" }, { name: "other", runs: true }],
      steps: ["acme/x"],
      types: ["Document"],
      apps: [{ name: "store", reads: ["acme/x"] }],
      runnable: [{ kind: "workflow", name: "other", dailyCapUsd: 1 }],
      visitors: { signIn: ["lnurl"] },
    };
    const next = withNeeds(before, NEEDS);
    assert.deepEqual(next, {
      ...before,
      workflows: [{ name: "pets", runs: true }, { name: "other", runs: true }],
      steps: ["acme/x", "demo/score"],
      apps: [{ name: "store", reads: ["acme/x"] }, { name: "workers", reads: ["demo/read"] }],
    });
    assert.deepEqual(before.workflows, [{ name: "pets" }, { name: "other", runs: true }], "the record it was given is untouched");
    // Listed already: its reads grow, nothing is dropped.
    const again = withNeeds({ ...emptySurface(), apps: [{ name: "workers", reads: ["acme/y"] }] }, NEEDS);
    assert.deepEqual(again.apps, [{ name: "workers", reads: ["acme/y", "demo/read"] }]);
  });

  it("the card: the app and version, each cascade line with what it exposes, who can sign in, the hold; the version pinned", () => {
    const card = makePublicCard({ name: "workers" }, { needs: NEEDS, version: "v2", live: { version: "v2", held: false }, listed: false, visitors: { signIn: ["sphinx"], set: false } });
    assert.equal(card.title, "Make the app Workers public");
    assert.deepEqual(card.actions, { accept: "Make public", reject: "Don't" });
    assert.deepEqual(card.input, { name: "workers", version: "v2" }, "the version live when asked, kept on the record");
    const f = (label: string) => card.fields!.find((x) => x.label === label);
    assert.deepEqual(f("App"), { label: "App", value: "Workers — workers v2" });
    assert.deepEqual(f("Held at"), { label: "Held at", value: "v2: a later publish is a draft until someone makes it live" });
    assert.deepEqual(f("Workflows"), {
      label: "Workflows",
      value: "pets — its definition and versions, and every run, whole\ngone — not added: not a workflow on this strut server",
      danger: true,
    });
    assert.equal(f("Reads the page may call")!.value, "demo/read — a read of this server\ndemo/write — not added: a read of this server");
    assert.equal(f("Reads the page may call")!.danger, undefined, "no outside service");
    assert.equal(f("Steps")!.value, "demo/score — its schema, its source and the helpers it imports");
    assert.equal(f("Concept trees")!.value, "Law — not added: no Concept of that name in this server's graph (read by pets)");
    assert.equal(f("Decided per run, not added")!.value, "pets: a Concept named per run ({{ input.kind }})");
    assert.match(f("Who can sign in")!.value, /^their Sphinx account, through the wallet that holds it \(Peel\), with the root key, so a visitor is one person on every app here\. The default/);
    assert.match(card.summary!, /held at v2: later edits are drafts until someone makes them live/);
    assert.match(card.summary!, /nothing is taken out of it/);
    assert.doesNotMatch(card.summary!, /fails/);
  });

  it("the card's dangers: an outside read, a live version that moves, no sign-in, a served box, a seed, no app", () => {
    const needs: PublicViewNeeds = { ...NEEDS, workflows: [], reads: [{ name: "sheets/get-values", checked: true, note: "calls Google Sheets with this server's credentials: anything that account can open, by id, a visitor's page can read" }] };
    const card = makePublicCard({ name: "workers", version: "v1" }, { needs, version: "v1", live: { version: "v2", held: true }, listed: true, visitors: { signIn: [], set: true }, served: "acme/x" });
    const f = (label: string) => card.fields!.find((x) => x.label === label);
    assert.equal(f("Reads the page may call")!.danger, true);
    assert.deepEqual(f("Held at"), { label: "Held at", value: "v1: a later publish is a draft until someone makes it live. Its live version moves from v2 to v1, for everyone who opens it", danger: true });
    assert.equal(f("Who can sign in")!.danger, true);
    assert.match(f("Who can sign in")!.value, /^nobody: the public view offers no sign-in/);
    assert.match(card.summary!, /in the public view already/);
    assert.match(card.summary!, /Accepting it fails: this strut server serves acme\/x, whose serve\.yaml writes the public view/);
    const seeded = makePublicCard({ name: "strut/views" }, { needs, version: "v1", live: { version: "v1", held: false }, seeded: true, listed: false, visitors: { signIn: ["sphinx"], set: false } });
    assert.match(seeded.summary!, /Accepting it fails: strut seeds strut\/views/);
    const none = makePublicCard({ name: "nope" }, { needs: { error: 'no app "nope" on this strut server' }, listed: false, visitors: { signIn: ["sphinx"], set: false } });
    assert.deepEqual(none.fields, [{ label: "App", value: 'nope — no app "nope" on this strut server', danger: true }]);
    assert.equal(none.input, undefined, "nothing to pin");
  });
});

// ── on a strut ──────────────────────────────────────────────────────────────

describe("app/make-public on a strut: an agent asks, an admin says yes", () => {
  let root: string;
  let strut: Strut;
  const saved: Record<string, string | undefined> = {};

  before(async () => {
    for (const k of ["STRUT_API_KEY", "STRUT_SECRET_KEY"]) saved[k] = process.env[k];
    process.env["STRUT_API_KEY"] = KEY;
    process.env["STRUT_SECRET_KEY"] = "make-public-secret";
    root = await mkdtemp(join(tmpdir(), "strut-make-public-"));
    strut = await createStrut({
      workspace: new WorkspaceManager(join(root, "ws")),
      store: new MemoryRunStore(),
      kit: await kitForTests(),
      serveUi: false,
      enableChat: false,
      scheduler: false,
      autoResume: false,
      stt: false,
      job: false,
      orchestrator: false,
      builder: false,
      views: false,
      staff: false,
      jamie: false,
      knowledge: false,
      earnings: false,
      concepts: false,
      systemWorkflows: false,
      browserWorkflows: false,
      privacyWorkflows: false,
      mediaWorkflows: false,
    });
    // A custom step the granted workflow runs, a read the app grants, a
    // worker's steps, and a workflow that reads a Concept root.
    await strut.workspace.publishStep("demo/score", `import { z, defineStep } from "strut";\nexport default defineStep({ type: "demo/score", input: z.object({}), output: z.any(), async run() { return 1; } });\n`);
    await strut.workspace.publishStep("demo/read", `import { z, defineStep } from "strut";\nexport default defineStep({ type: "demo/read", effect: "read", input: z.object({}), output: z.any(), async run() { return 1; } });\n`);
    await strut.rebuildRegistry();
    await strut.workspace.publishWorkflowByContent("pets", `name: pets\nparams:\n  concept: Law\nsteps:\n  - id: s\n    type: demo/score\n  - id: c\n    type: context/concept\n    config: { name: "{{ params.concept }}", tool: "" }\n`);
    await strut.workspace.publishWorkflowByContent("other", `name: other\ninput:\n  who: { type: string, required: false, default: world }\nsteps:\n  - { id: say, type: log, config: { message: hi } }\n`);
    for (const v of [1, 2]) await publishApp(v);
  });
  after(async () => {
    await strut?.close?.().catch(() => {});
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(root, { recursive: true, force: true });
  });

  /** The worker app, version `n` (each publish a new version). */
  const publishApp = async (n: number) => {
    const dir = join(root, "apps", "workers");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "app.yaml"), "title: Workers\ngrants:\n  workflows: [pets]\n  steps: [demo/read, task/next, task/submit, task/skip, task/me]\n");
    await writeFile(join(dir, "src", "App.tsx"), `export default function App() { return <p>workers ${n}</p>; }\n`);
    const r = await strut.apps.publish(dir, "workers", { surface: "person" });
    assert.ok(r.ok, r.ok ? "" : r.errors.join("\n"));
  };
  const door = () => (strut.services as { publicView: PublicViewCapability }).publicView;
  const step = (type: string) => strut.getRegistry()[type]!;
  const ctx = (extra: Partial<StepContext> = {}): StepContext => ({
    runId: "r1",
    path: "builder/turn",
    scope: {},
    input: undefined,
    emit: async () => {},
    services: strut.services,
    registry: strut.getRegistry(),
    job: "j1",
    actor: "ann",
    principal: "ann",
    ...extra,
  });
  type Tool = { inputSchema: z.ZodTypeAny; execute: (input: unknown, o?: { strutToolPath?: string }) => Promise<unknown> };
  let calls = 0;
  /** The builder's gated tool call: a proposal, or the error the model reads. */
  const ask = async (input: Record<string, unknown>) => {
    const tool = buildRegistryTools(["app/make-public"], strut.getRegistry(), ctx(), (d: unknown) => d, { approve: new Set(["app/make-public"]), session: "s1" })["app_make_public"] as Tool;
    return tool.execute(input, { strutToolPath: `builder/turn/${String(++calls).padStart(3, "0")}-app_make_public` }) as Promise<{ proposal: string; status: string; title: string } | string>;
  };
  const record = async (id: string): Promise<Proposal> => (await (strut.services as { proposals: { get(id: string): Promise<Proposal | null> } }).proposals.get(id))!;
  const signIn = async (actor: string, role: "admin" | "member") => {
    const res = await strut.app.request("/auth/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket: signInTicket(actor, role)!.ticket }) });
    assert.equal(res.status, 200, await res.clone().text());
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  };
  const decide = async (id: string, headers: Record<string, string>, body: Record<string, unknown> = { action: "accept" }) => {
    const res = await strut.app.request(`/proposals/${id}/decide`, { method: "POST", headers: { "content-type": "application/json", "x-strut-ui": "1", ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Proposal & { error?: string } };
  };
  const view = async () => ((await (await strut.app.request("/public-view", { headers: auth })).json()) as { surface: PublicSurface }).surface;
  const putView = async (body: unknown) => {
    const res = await strut.app.request("/public-view", { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(res.status, 200, await res.clone().text());
  };
  const liveOf = async (name: string) => {
    const rel = (await strut.apps.releases(name))!;
    return rel.live === "latest" ? "latest" : rel.releases.find((r) => r.id === rel.live)!.version;
  };

  it("runs only as an accepted proposal: a direct call, a workflow's step, meta/run-step, a subflow and a custom step's call of the door are refused", async () => {
    const cfg = { name: "workers", version: "v2" };
    await assert.rejects(step("app/make-public").run(cfg, ctx()), /runs only as a proposal an admin accepted/);
    await assert.rejects(step("app/make-public").run(cfg, ctx({ agentTool: true })), /runs only as a proposal an admin accepted/);
    const authoring = (strut.services as unknown as { authoring: { runStep(t: string, a: unknown): Promise<{ error?: string }> } }).authoring;
    assert.ok((await authoring.runStep("app/make-public", { config: cfg })).error, "meta/run-step may not run it");
    await strut.workspace.publishWorkflow("direct", "v1", { steps: [{ id: "s", type: "app/make-public", config: cfg }] });
    await strut.workspace.publishWorkflow("wrap", "v1", { steps: [{ id: "sub", type: "subflow", config: { workflow: "direct", input: {} } }] });
    for (const wf of ["direct", "wrap"]) {
      const res = await strut.run(wf, {});
      assert.equal(res.status, "error", wf);
      assert.match(JSON.stringify(res.error), /runs only as a proposal an admin accepted/, wf);
    }
    // Any step reaches the shared bag, a custom step the builder wrote included: its add opens nothing.
    await strut.workspace.publishStep(
      "test/sneak",
      `import { z, defineStep } from "strut";
export default defineStep({ type: "test/sneak", input: z.object({}), output: z.any(), async run(_cfg, ctx) {
  return ctx.services.publicView.addApp("workers", "v2", { proposal: "AAAAAAAAAAAA", actor: "ann" });
} });`,
    );
    await strut.rebuildRegistry();
    await strut.workspace.publishWorkflow("sneak", "v1", { steps: [{ id: "s", type: "test/sneak", config: {} }] });
    const sneak = await strut.run("sneak", {});
    assert.equal(sneak.status, "error");
    assert.match(JSON.stringify(sneak.error), /make_public_needs_admin: adding the app workers to the public view runs only as the apply of a proposal an admin accepted for it/);
    assert.deepEqual((await view()).apps, [], "nothing added");
  });

  it("a forged ctx.proposal adds nothing: no record, a pending one, or another app's or version's", async () => {
    const forged = (id: string) => ctx({ proposal: { id, by: { workflow: "builder", runId: "r0" } } });
    await assert.rejects(step("app/make-public").run({ name: "workers", version: "v2" }, forged("nope-nope-nope")), /^Error: make_public_needs_admin: /);
    const asked = (await ask({ name: "workers" })) as { proposal: string };
    await assert.rejects(step("app/make-public").run({ name: "workers", version: "v2" }, forged(asked.proposal)), /make_public_needs_admin: .*proposal \S+ is pending, for app\/make-public workers v2/);
    await assert.rejects(door().addApp("workers", "v1", { proposal: asked.proposal }), /make_public_needs_admin/);
    await assert.rejects(door().addApp("other-app", "v2", { proposal: asked.proposal }), /make_public_needs_admin/);
    assert.deepEqual((await view()).apps, []);
    await decide(asked.proposal, auth, { action: "reject" });
  });

  it("the call is a proposal whose card lists what GET /public-view/needs lists; a member's accept is admin_required; an admin's adds the app held at that version with the cascade, signed in with Sphinx", async () => {
    // The cascade, as the dialog asks for it: a worker's steps are not lines (a signed-in worker calls them whatever is ticked).
    const res = await strut.app.request("/public-view/needs?app=workers", { headers: auth });
    assert.equal(res.status, 200);
    const needs = (await res.json()) as PublicViewNeeds;
    assert.deepEqual(needs.reads.map((r) => [r.name, r.checked]), [["demo/read", true]], "no task/* line");
    assert.deepEqual(needs.workflows.map((w) => [w.name, w.runs, w.checked]), [["pets", true, true]]);
    assert.deepEqual(needs.steps.map((s) => [s.name, s.checked]), [["demo/score", true]]);
    assert.deepEqual(needs.concepts.map((c) => [c.name, c.checked]), [["Law", false]]);

    const out = (await ask({ name: "workers", rationale: "Workers answer the pet matches here." })) as { proposal: string; status: string; title: string };
    assert.equal(out.status, "pending");
    assert.equal(out.title, "Make the app Workers public");
    const rec = await record(out.proposal);
    assert.equal(rec.approver, "admin");
    assert.deepEqual(rec.input, { name: "workers", version: "v2" }, "the version live when asked is pinned");
    assert.deepEqual(rec.card?.actions, { accept: "Make public", reject: "Don't" });
    // Each line of the card's cascade is the route's line, with what it exposes.
    const field = (label: string) => rec.card!.fields.find((f) => f.label === label)?.value;
    assert.equal(field("Workflows"), needs.workflows.map(needLine).join("\n"));
    assert.equal(field("Reads the page may call"), needs.reads.map(needLine).join("\n"));
    assert.equal(field("Steps"), needs.steps.map(needLine).join("\n"));
    assert.equal(field("Concept trees"), needs.concepts.map((c) => `${needLine(c)} (read by ${c.from.join(", ")})`).join("\n"));
    assert.match(field("Who can sign in")!, /Sphinx account/);

    // A member is refused: their own page's accept, their session at the route, their person token.
    const page = ctx({ app: { name: "strut/jamie", version: "v1", firstParty: true }, workflow: RUN_STEP_FLOW, path: `${RUN_STEP_FLOW}/decide` });
    await assert.rejects(step("proposal/decide").run({ id: out.proposal, action: "accept" }, page), /^Error: admin_required: only an admin of this strut server accepts "Make the app Workers public" \(app\/make-public\)/);
    assert.equal((await decide(out.proposal, { cookie: await signIn("bo", "member") })).status, 403);
    const person = await decide(out.proposal, { authorization: `Bearer ${personToken("ann")!.token}` });
    assert.equal(person.status, 403);
    assert.match(person.body.error!, /^admin_required: /);
    assert.equal((await record(out.proposal)).status, "pending");
    assert.deepEqual((await view()).apps, []);

    // An admin's yes: the app at v2, its pre-checked lines, held there; the
    // view had no sign-in set, so Sphinx with the root key.
    const admin = await decide(out.proposal, { cookie: await signIn("ada", "admin") });
    assert.equal(admin.status, 200, JSON.stringify(admin.body));
    assert.equal(admin.body.status, "applied", JSON.stringify(admin.body.result));
    assert.deepEqual(admin.body.result?.output, {
      app: "workers",
      version: "v2",
      added: { workflows: ["pets"], steps: ["demo/score"], reads: ["demo/read"], concepts: [] },
      signIn: ["sphinx"],
    });
    const s = await view();
    assert.deepEqual(s, { ...emptySurface(), workflows: [{ name: "pets", runs: true }], steps: ["demo/score"], apps: [{ name: "workers", reads: ["demo/read"] }] });
    assert.deepEqual(signInOf(s), ["sphinx"]);
    assert.equal(await liveOf("workers"), "v2", "held at v2");
    const rel = (await strut.apps.releases("workers"))!;
    assert.equal(rel.releases.at(-1)!.by, "ada", "the admin holds it");
    await assert.rejects(door().addApp("workers", "v2", { proposal: out.proposal }), /make_public_needs_admin: .*is applied/);
  });

  it("the yes holds the version the card showed, keeps everything the view lists, and leaves its sign-in as it is", async () => {
    // Someone else's view: other items, a runnable, its own sign-in; the app out of it and following latest again.
    const others = { concepts: ["Codebase"], workflows: [{ name: "other", runs: true }], types: ["Document"], apps: [], runnable: [{ kind: "workflow", name: "other", dailyCapUsd: 1 }], visitors: { signIn: ["lnurl", "sphinx"], visitorKey: "domain" } };
    await putView(others);
    await strut.apps.setLive("workers", null);
    assert.equal(await liveOf("workers"), "latest");

    const out = (await ask({ name: "workers" })) as { proposal: string };
    const rec = await record(out.proposal);
    assert.deepEqual(rec.input, { name: "workers", version: "v2" });
    assert.equal(
      rec.card!.fields.find((f) => f.label === "Who can sign in")!.value,
      "a Lightning wallet (LNURL-auth); their Sphinx account, through the wallet that holds it (Peel), with a key per domain, so a visitor is someone new on each domain. The public view's own setting, unchanged. Anyone else sees the page signed out.",
    );
    // The builder publishes again before the admin answers: v3 is live, the yes still holds v2.
    await publishApp(3);
    assert.equal(await liveOf("workers"), "latest");
    const admin = await decide(out.proposal, { cookie: await signIn("ada", "admin") });
    assert.equal(admin.body.status, "applied", JSON.stringify(admin.body.result));
    assert.equal(await liveOf("workers"), "v2", "the version the card showed, not the one published since");
    const s = await view();
    assert.deepEqual(s.concepts, ["Codebase"]);
    assert.deepEqual(s.types, ["Document"]);
    assert.deepEqual(s.runnable, others.runnable);
    assert.deepEqual(s.workflows, [{ name: "other", runs: true }, { name: "pets", runs: true }]);
    assert.deepEqual(s.apps, [{ name: "workers", reads: ["demo/read"] }]);
    assert.deepEqual(s.visitors, { signIn: ["lnurl", "sphinx"], visitorKey: "domain" }, "the sign-in as it was");
  });
});

// ── the seeds ───────────────────────────────────────────────────────────────

describe("app/make-public in the seeds: the builder job and the assistant ask for it, the chat never gets it", () => {
  type Params = { tools: string[]; approve?: string[] };
  const params = (text: string) => (yaml.load(text) as { params: Params }).params;
  const reaches = (grants: string[], type: string) => grants.some((g) => globToRegExp(g).test(type));

  it("builder and orchestrator grant it and gate it, beside app/grant; job does not reach it", async () => {
    const builder = params(await builderWorkflowYaml());
    assert.ok(reaches(builder.tools, "app/make-public"), "builder grants it (app/*)");
    assert.ok(builder.approve?.includes("app/make-public"), "a proposal: an admin's yes");
    const orchestrator = params(await orchestratorWorkflowYaml());
    assert.ok(orchestrator.tools.includes("app/make-public"));
    assert.ok(orchestrator.approve?.includes("app/make-public"));
    assert.ok(orchestrator.approve!.indexOf("app/make-public") === orchestrator.approve!.indexOf("app/grant") + 1, "beside app/grant");
    assert.ok(!reaches(params(await jobWorkflowYaml()).tools, "app/make-public"), "job does not reach it");
  });

  it("the builder chat's tools leave out the app/* steps that run only as a proposal", async () => {
    const root = await mkdtemp(join(tmpdir(), "strut-make-public-chat-"));
    try {
      const strut = await createStrut({ workspace: new WorkspaceManager(join(root, "ws")), store: new MemoryRunStore(), serveUi: false, scheduler: false, autoResume: false, stt: false, views: false, jamie: false, staff: false, knowledge: false, earnings: false, concepts: false, systemWorkflows: false, browserWorkflows: false, privacyWorkflows: false, mediaWorkflows: false });
      try {
        const registry = strut.getRegistry();
        const tools = buildTools({ workspace: strut.workspace, registry, store: new MemoryRunStore(), getRegistry: async () => registry, services: strut.services, dataDir: root, shell: { cwd: root } } as never) as Record<string, unknown>;
        assert.ok(tools["app_publish"], "the chat has the app/* steps");
        assert.equal(tools["app_make_public"], undefined);
        assert.equal(tools["app_grant"], undefined);
      } finally {
        await strut.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
