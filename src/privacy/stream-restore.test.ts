import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateText, streamText } from "ai";
import { restore } from "./restore.js";
import { StreamRestorer } from "./stream-restore.js";
import { jsonEscape, restoreToolInput } from "./tool-restore.js";
import { FIX, makeCtx, uid, wrap } from "./testing/harness.js";
import { mockModel } from "./testing/mock-model.js";
import type { TokenMap } from "./types.js";

const map: TokenMap = {
  "[PERSON_1]": { type: "PERSON", value: FIX.person },
  "[PERSON_1a]": { type: "PERSON", value: FIX.first },
  "[EMAIL_1]": { type: "EMAIL", value: FIX.email },
  "[PERSON_12]": { type: "PERSON", value: "Twelve Person" },
};
const TEXT = "Hi [PERSON_1], mail [EMAIL_1]; [PERSON_1a] and PERSON_12 or [ person_1 ] too, [PERSON_99] stays. plain end [PERS";

describe("stream restore", () => {
  it("a pseudonym split at every offset (and at every pair of offsets) restores like the whole text", () => {
    const whole = restore(TEXT, map).text;
    for (let i = 0; i <= TEXT.length; i++) {
      const r = new StreamRestorer(map);
      assert.equal(r.push(TEXT.slice(0, i)) + r.push(TEXT.slice(i)) + r.flush(), whole, `split at ${i}`);
    }
    for (let i = 0; i <= TEXT.length; i += 3) for (let j = i; j <= TEXT.length; j += 5) {
      const r = new StreamRestorer(map);
      assert.equal(r.push(TEXT.slice(0, i)) + r.push(TEXT.slice(i, j)) + r.push(TEXT.slice(j)) + r.flush(), whole);
    }
    const bytes = new StreamRestorer(map);
    assert.equal([...TEXT].map((c) => bytes.push(c)).join("") + bytes.flush(), whole, "one character at a time");
  });

  it("nothing half restored is ever emitted", () => {
    const r = new StreamRestorer(map);
    assert.equal(r.push("Hello [PERS"), "Hello ");
    assert.equal(r.push("ON_1] and PERS"), `${FIX.person} and `);
    assert.equal(r.push("ON_1"), "", "PERSON_1 could still become PERSON_1a");
    assert.equal(r.push(" there"), `${FIX.person} there`, "a lower-case word is never held");
    assert.equal(r.flush(), "");
  });

  it("a snake_case name in code or SQL is never a token, in text, a stream or a tool input", () => {
    const m: TokenMap = { "[ADDRESS_1]": { type: "ADDRESS", value: "221 Maple Street" }, "[EMAIL_1]": { type: "EMAIL", value: FIX.email } };
    const sql = "SELECT address_1, email_1 FROM contacts WHERE id = 1";
    assert.equal(restore(sql, m).text, sql);
    const r = new StreamRestorer(m);
    assert.equal([...sql].map((c) => r.push(c)).join("") + r.flush(), sql);
    const input = JSON.stringify({ command: "ALTER TABLE t ADD COLUMN address_1 text" });
    assert.equal(restoreToolInput(input, m), input);
    assert.equal(restore("ADDRESS_1 and [address_1]", m).text, "221 Maple Street and 221 Maple Street", "upper case bare, or any case in brackets");
  });

  it("JSON escaping of real values, in text and in tool input", () => {
    const q: TokenMap = { "[PERSON_1]": { type: "PERSON", value: 'Ann "The Boss" O\'Neil\\' } };
    const text = restore('{"who":"[PERSON_1]"}', q, jsonEscape).text;
    assert.deepEqual(JSON.parse(text), { who: 'Ann "The Boss" O\'Neil\\' });
    assert.deepEqual(JSON.parse(restoreToolInput('{"a":["[PERSON_1]",{"b":"x [PERSON_1]"}],"n":3}', q)), { a: ['Ann "The Boss" O\'Neil\\', { b: 'x Ann "The Boss" O\'Neil\\' }], n: 3 });
  });
});

describe("stream and generate agree", () => {
  const turn = () => [
    { type: "reasoning", text: "thinking about [PERSON_1]", providerMetadata: { anthropic: { signature: "s" } } },
    { type: "text", text: `Hello [PERSON_1], I wrote to [EMAIL_1] and PERSON_1a came by.` },
    { type: "tool-call", toolCallId: "c", toolName: "t", input: '{"who":"[PERSON_1]"}' },
  ];
  const PROMPT = `I am ${FIX.person}, call me ${FIX.first}, ${FIX.email}.`;
  for (const chunk of [1, 2, 5, 1000]) {
    it(`chunk size ${chunk}`, async () => {
      const g = mockModel({ turns: [turn()] });
      const s = mockModel({ turns: [turn()], chunk });
      const ctx = makeCtx({ privacy: "hosted" });
      const gen = await generateText({ model: await wrap(g, { ctx, session: uid("g") }), prompt: PROMPT });
      const st = streamText({ model: await wrap(s, { ctx, session: uid("s") }), prompt: PROMPT });
      await st.consumeStream();
      assert.equal(await st.text, gen.text);
      assert.equal(await st.reasoningText, gen.reasoningText);
      assert.deepEqual((await st.toolCalls).map((c: any) => c.input), gen.toolCalls.map((c: any) => c.input));
      assert.deepEqual(gen.toolCalls[0]!.input, { who: FIX.person });
      assert.equal(gen.text, `Hello ${FIX.person}, I wrote to ${FIX.email} and ${FIX.first} came by.`);
    });
  }
});
