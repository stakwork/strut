/**
 * LIVE privacy test — loads the real NER model (Xenova/bert-base-NER, ~110 MB,
 * downloaded into the model dir on first use) in its worker thread. Opt in with
 * STRUT_PRIVACY_LIVE=1 (`npm run test:privacy`); skipped otherwise. The fixtures
 * are synthetic; the `llm` step in private-ask is a fake, no provider is called.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineStep } from "../core.js";
import { runWorkflow } from "../runner.js";
import { createRegistry } from "../steps/registry.js";
import { MemoryRunStore } from "../store.js";
import { flowFromYaml } from "../workspace.js";
import { anonymizeTexts, deanonymizeText, type AnonymizeOptions } from "./index.js";

const enabled = process.env["STRUT_PRIVACY_LIVE"] === "1";
const RECALL_FLOOR = 0.85;
const opts: AnonymizeOptions = { vault: "memory", ttlMinutes: 10, deny: [], allow: [], ner: true, llm: false, minScore: 0.6, privacyLevel: "off" };

type Row = { text: string; planted: { value: string; type: string }[] };

describe("privacy live (STRUT_PRIVACY_LIVE=1)", { skip: !enabled }, () => {
  let dir: string;
  let rows: Row[];
  const ctx = () => ({ services: { dataDir: dir } });
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "strut-privacy-live-"));
    rows = (await readFile(new URL("./fixtures/recall.jsonl", import.meta.url), "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it("masks planted values above the recall floor, and the round trip restores every text", async () => {
    const results = await anonymizeTexts(rows.map((r) => r.text), opts, ctx());
    let planted = 0, masked = 0;
    const byType: Record<string, [number, number]> = {};
    const missed: string[] = [];
    for (const [i, r] of results.entries()) {
      for (const p of rows[i]!.planted) {
        planted++;
        const t = (byType[p.type] ??= [0, 0]);
        t[1]++;
        if (!r.text.includes(p.value)) { masked++; t[0]++; } else missed.push(`${p.type}:${p.value}`);
      }
      assert.deepEqual(r.warnings.filter((w) => w.code !== "ner_unaligned_spans"), []);
      // echo: the "model" returns the masked text unchanged
      const back = await deanonymizeText(r.text, r.handle, undefined, ctx());
      assert.equal(back.text, rows[i]!.text, "round trip");
      assert.equal(back.unknown_pseudonyms, 0);
    }
    const recall = masked / planted;
    console.log(JSON.stringify({ planted, masked, recall: Number(recall.toFixed(3)), byType, missed }));
    assert.ok(recall >= RECALL_FLOOR, `recall ${recall.toFixed(3)} below ${RECALL_FLOOR}; missed: ${missed.join(", ")}`);
  });

  it("private-ask with the default NER: the model sees no planted value, the answer is restored", async () => {
    const seen: string[] = [];
    // echoes the masked text back, as a model that keeps every token would
    const fakeLlm = defineStep({
      type: "llm",
      description: "fake",
      input: z.object({ prompt: z.string(), model: z.string().optional() }),
      output: z.any(),
      async run(cfg) {
        seen.push(cfg.prompt);
        return { text: cfg.prompt.trim().split("\n\n").at(-1)!.trim() };
      },
    });
    const row = rows[0]!;
    const flow = flowFromYaml("private-ask", "v1", await readFile(new URL("../workflows/private-ask.yaml", import.meta.url), "utf-8"));
    const services = { dataDir: dir, secrets: { get: async () => undefined } };
    const r = await runWorkflow(flow, { prompt: row.text }, await createRegistry([fakeLlm]), { services, store: new MemoryRunStore() });
    assert.equal(r.status, "success", JSON.stringify(r.error));
    assert.equal(seen.length, 1);
    for (const p of row.planted) assert.ok(!seen[0]!.includes(p.value), `${p.type} reached the model`);
    assert.equal((r.output as any).answer, row.text);
    assert.equal((r.output as any).report.unknown_pseudonyms, 0);
  });
});
