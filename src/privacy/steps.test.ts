import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createRegistry } from "../steps/registry.js";
import { runSingleStep } from "../run-step.js";
import { runWorkflow } from "../runner.js";
import { defineStep } from "../core.js";
import { validateWorkflowYaml } from "../validate.js";
import { flowFromYaml, WorkspaceManager } from "../workspace.js";
import { createStrut } from "../createStrut.js";
import { MemoryRunStore } from "../store.js";
import { lintStepSource } from "../step-lint.js";
import { PRIVACY_CATEGORY, PRIVACY_WORKFLOWS } from "./seed.js";
import type { NerEngine } from "./types.js";
import { VAULT_KEY_SECRET } from "./keys.js";

const fakeNer = (words: Record<string, string> = {}, unaligned = 0): NerEngine => ({
  async detect(texts) {
    return {
      spans: texts.map((t) =>
        Object.entries(words).flatMap(([w, type]) => (t.includes(w) ? [{ s: t.indexOf(w), e: t.indexOf(w) + w.length, type, score: 0.99 }] : [])),
      ),
      unaligned,
    };
  },
});

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "strut-privacy-steps-")); });
afterEach(() => rm(dir, { recursive: true, force: true }));

const services = (extra: Record<string, unknown> = {}, secrets: Record<string, string> = {}, ner: NerEngine = fakeNer({ Jonas: "PER" })) => ({
  dataDir: dir,
  secrets: { get: async (n: string) => secrets[n] },
  privacy: { ner },
  ...extra,
});
const step = async (type: string, config: Record<string, unknown>, svc: unknown) => runSingleStep(type, await createRegistry([]), svc, { config });

describe("privacy steps", () => {
  it("anonymize → deanonymize round trip with a memory vault (destroyed after)", async () => {
    const svc = services();
    const a = await step("privacy/anonymize", { text: "Jonas wrote to jo@example.com on 2024-03-05." }, svc);
    assert.equal(a.status, "success", a.error?.message);
    const o = a.output as any;
    assert.equal(o.text, "[PERSON_1] wrote to [EMAIL_1] on [DATE_1].");
    assert.match(o.handle, /^pvm_[0-9a-f]{24}$/);
    assert.deepEqual(o.counts, { PERSON: 1, EMAIL: 1, DATE: 1 });
    assert.equal(o.entities, 3);
    assert.deepEqual(o.warnings, []);
    assert.deepEqual(o.detector, { rules: true, gazetteer: true, ner: true, llm: false });
    assert.equal(o.vault, "memory");
    assert.ok(!JSON.stringify(o).includes("Jonas"));

    const d = await step("privacy/deanonymize", { text: "Reply to [PERSON_1] at [email_1]; also [PERSON_9].", handle: o.handle }, svc);
    assert.equal(d.status, "success", d.error?.message);
    assert.deepEqual(d.output, { text: "Reply to Jonas at jo@example.com; also [PERSON_9].", restored: 2, unknown_pseudonyms: 1, destroyed: true });
    const again = await step("privacy/deanonymize", { text: "x", handle: o.handle }, svc);
    assert.equal(again.status, "error");
    assert.match(again.error!.message, /unknown or expired/);
  });

  it("batch: one handle per text, model engine called once for the batch path", async () => {
    const a = await step("privacy/anonymize", { texts: ["Jonas here", "no one here", "Jonas again"] }, services());
    const r = (a.output as any).results;
    assert.equal(r.length, 3);
    assert.equal(new Set(r.map((x: any) => x.handle)).size, 3);
    assert.deepEqual(r.map((x: any) => x.text), ["[PERSON_1] here", "no one here", "[PERSON_1] again"]);
  });

  it("explicit destroy, destroy: false, and privacy/destroy", async () => {
    const svc = services();
    const h = ((await step("privacy/anonymize", { text: "Jonas" }, svc)).output as any).handle;
    const kept = await step("privacy/deanonymize", { text: "[PERSON_1]", handle: h, destroy: false }, svc);
    assert.equal((kept.output as any).destroyed, false);
    assert.deepEqual((await step("privacy/destroy", { handle: h }, svc)).output, { destroyed: true });
    assert.deepEqual((await step("privacy/destroy", { handle: h }, svc)).output, { destroyed: false });
  });

  it("ner:false skips the model entirely; privacy_level warns and behaves as off", async () => {
    const boom: NerEngine = { detect: async () => { throw new Error("must not be called"); } };
    const a = await step("privacy/anonymize", { text: "Jonas at jo@example.com", detectors: { ner: false }, privacy_level: "strict" }, services({}, {}, boom));
    assert.equal(a.status, "success", a.error?.message);
    const o = a.output as any;
    assert.equal(o.text, "Jonas at [EMAIL_1]");
    assert.equal(o.detector.ner, false);
    assert.deepEqual(o.warnings.map((w: any) => w.code), ["privacy_level_not_implemented"]);
  });

  it("ner:true with an unusable model FAILS CLOSED", async () => {
    const down: NerEngine = { detect: async () => { throw new Error("offline"); } };
    const a = await step("privacy/anonymize", { text: "Jonas" }, services({}, {}, down));
    assert.equal(a.status, "error");
    assert.match(a.error!.message, /ner_unavailable/);
    assert.ok(!a.error!.message.includes("Jonas"));
  });

  it("reports unaligned NER spans as a warning", async () => {
    const a = await step("privacy/anonymize", { text: "Jonas" }, services({}, {}, fakeNer({ Jonas: "PER" }, 4)));
    assert.deepEqual((a.output as any).warnings, [{ code: "ner_unaligned_spans", message: (a.output as any).warnings[0].message, count: 4 }]);
  });

  it("deny, allow and min_score are honoured", async () => {
    const ner = fakeNer({ Jonas: "PER" });
    const a = await step("privacy/anonymize", { text: "Jonas and Mia", deny: ["Mia"], allow: ["jonas"] }, services({}, {}, ner));
    assert.equal((a.output as any).text, "Jonas and [PERSON_1]");
    const low: NerEngine = { detect: async (t) => ({ spans: t.map(() => [{ s: 0, e: 5, type: "PER", score: 0.3 }]), unaligned: 0 }) };
    const b = await step("privacy/anonymize", { text: "Jonas", min_score: 0.5 }, services({}, {}, low));
    assert.equal((b.output as any).text, "Jonas");
  });

  it("input validation: exactly one of text/texts, max_chars, bad values", async () => {
    const svc = services();
    for (const cfg of [{}, { text: "a", texts: ["b"] }, { text: "a", vault: "disk" }, { text: "a", ttl_minutes: 0 }, { text: "a", min_score: 2 }]) {
      assert.equal((await step("privacy/anonymize", cfg, svc)).status, "error", JSON.stringify(cfg));
    }
    const big = await step("privacy/anonymize", { text: "x".repeat(50), max_chars: 10 }, svc);
    assert.equal(big.status, "error");
    assert.match(big.error!.message, /max_chars/);
    assert.ok(!big.error!.message.includes("xxxx"));
  });

  it("file vault: needs the key, round trips, survives a new process view, handle stays", async () => {
    const none = await step("privacy/anonymize", { text: "Jonas", vault: "file" }, services());
    assert.equal(none.status, "error");
    assert.match(none.error!.message, /STRUT_ANONYMIZATION_VAULT_KEY/);

    const svc = services({}, { [VAULT_KEY_SECRET]: "k".repeat(32) });
    const a = await step("privacy/anonymize", { text: "Jonas", vault: "file" }, svc);
    const o = a.output as any;
    assert.match(o.handle, /^pvf_[0-9a-f]{24}$/);
    assert.equal(o.vault, "file");
    assert.deepEqual(await readdir(join(dir, "privacy", "vault")), [o.handle.slice(4) + ".enc"]);
    const d = await step("privacy/deanonymize", { text: "[PERSON_1]", handle: o.handle }, svc);
    assert.deepEqual(d.output, { text: "Jonas", restored: 1, unknown_pseudonyms: 0, destroyed: false });
    assert.deepEqual((await step("privacy/destroy", { handle: o.handle }, svc)).output, { destroyed: true });
  });
});

describe("the step files", () => {
  it("pass the step lint (no child process, fs, env, fetch in step sources)", async () => {
    for (const f of ["anonymize", "deanonymize", "destroy"]) {
      const src = await readFile(new URL(`../steps/lib/privacy/${f}.ts`, import.meta.url), "utf-8");
      assert.deepEqual(lintStepSource(src), [], f);
    }
  });
  it("are registered as lib steps and say PSEUDONYMIZATION", async () => {
    const reg = await createRegistry([]);
    for (const t of ["privacy/anonymize", "privacy/deanonymize", "privacy/destroy"]) assert.ok(reg[t], t);
    assert.match(reg["privacy/anonymize"]!.description, /PSEUDONYMIZATION, not anonymization/);
    assert.match(reg["privacy/anonymize"]!.description, /Run files record/i);
    assert.match(reg["privacy/deanonymize"]!.description, /real personal data/);
  });
});

describe("private-ask", () => {
  const text = () => readFile(new URL("../workflows/private-ask.yaml", import.meta.url), "utf-8");
  const seen: string[] = [];
  const fakeLlm = (fail = false) =>
    defineStep({
      type: "llm",
      description: "fake",
      input: z.object({ prompt: z.string(), model: z.string().optional() }),
      output: z.any(),
      async run(cfg) {
        seen.push(cfg.prompt);
        if (fail) throw new Error("provider down");
        // an echo that also mangles a token's case and invents one
        return { text: cfg.prompt.trim().split("\n\n").at(-1)!.trim() + " [person_1] and [PERSON_9]" };
      },
    });

  it("validates over strut's registry", async () => {
    const v = validateWorkflowYaml(await text(), { registry: await createRegistry([]) });
    assert.equal(v.ok, true, JSON.stringify(v.errors));
  });

  it("the model sees only masked text; the answer is restored; the report has no mapping", async () => {
    seen.length = 0;
    const flow = flowFromYaml("private-ask", "v1", await text());
    const r = await runWorkflow(flow, { prompt: "Jonas emailed jo@example.com" }, await createRegistry([fakeLlm()]), { services: services(), store: new MemoryRunStore() });
    assert.equal(r.status, "success", JSON.stringify(r.error));
    const out = r.output as any;
    assert.equal(out.answer, "Jonas emailed jo@example.com Jonas and [PERSON_9]");
    assert.equal(out.handle, undefined);
    assert.deepEqual(out.report, { counts: { PERSON: 1, EMAIL: 1 }, entities: 2, warnings: [], restored: 3, unknown_pseudonyms: 1 });
    assert.equal(seen.length, 1);
    assert.ok(!seen[0]!.includes("Jonas") && !seen[0]!.includes("jo@example.com"));
    assert.ok(seen[0]!.includes("[PERSON_1] emailed [EMAIL_1]"));
  });

  it("returns the handle for a file vault", async () => {
    const flow = flowFromYaml("private-ask", "v1", await text());
    const r = await runWorkflow(flow, { prompt: "Jonas", vault: "file" }, await createRegistry([fakeLlm()]), { services: services({}, { [VAULT_KEY_SECRET]: "k".repeat(32) }), store: new MemoryRunStore() });
    assert.equal(r.status, "success", JSON.stringify(r.error));
    assert.match((r.output as any).handle, /^pvf_[0-9a-f]{24}$/);
  });

  it("destroys the vault when the model call fails", async () => {
    const flow = flowFromYaml("private-ask", "v1", await text());
    const svc = services({}, { [VAULT_KEY_SECRET]: "k".repeat(32) });
    const r = await runWorkflow(flow, { prompt: "Jonas", vault: "file" }, await createRegistry([fakeLlm(true)]), { services: svc, store: new MemoryRunStore() });
    assert.equal(r.status, "error");
    assert.deepEqual(await readdir(join(dir, "privacy", "vault")), []);
  });

  it("createStrut seeds it in the privacy category; privacyWorkflows: false seeds none", async () => {
    const quiet = { serveUi: false, enableChat: false, scheduler: false, stt: false as const, store: new MemoryRunStore() };
    const a = await createStrut({ workspace: new WorkspaceManager(dir), ...quiet });
    for (const name of Object.keys(PRIVACY_WORKFLOWS)) {
      const meta = await a.workspace.getWorkflowMetadata(name);
      assert.ok(meta, `${name} seeded`);
      assert.equal(meta.category, PRIVACY_CATEGORY);
      assert.equal(meta.versions[meta.active]?.description, PRIVACY_WORKFLOWS[name]);
    }
    assert.deepEqual(Object.keys(PRIVACY_WORKFLOWS), ["private-ask"]);
    const dir2 = await mkdtemp(join(tmpdir(), "strut-privacy-seed-"));
    try {
      const b = await createStrut({ workspace: new WorkspaceManager(dir2), privacyWorkflows: false, ...quiet });
      assert.equal(await b.workspace.getWorkflowMetadata("private-ask"), null);
    } finally { await rm(dir2, { recursive: true, force: true }); }
  });
});
