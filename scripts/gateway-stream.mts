/**
 * One streamed request through aieo's model (with its bundled
 * @ai-sdk/anthropic — the copy that actually parses strut's streams) and
 * strut's real tool wiring, direct or through a gateway. Prints stream part
 * counts, or the full error (a TypeValidationError names the bad frame).
 *
 *   npx tsx scripts/gateway-stream.mts <baseUrl|direct> <model> <case>
 *     case: text | tool | thinking | editor | websearch | webfetch
 *
 *   npx tsx --env-file=.env scripts/gateway-stream.mts direct sonnet webfetch
 *   VK=sk-bf-… npx tsx scripts/gateway-stream.mts http://localhost:8181 sonnet webfetch
 *
 * Through a gateway the key is $VK (a virtual key); direct, the provider's
 * env key. Headers from $HEADERS (JSON) ride along, e.g. an x-macaroon.
 */
import os from "node:os";
import { z } from "zod";
import { createWebTools } from "../src/llm.js";
import { textEdit, type TextEditInput } from "../src/steps/core/agent.js";

const [base, model, kind] = process.argv.slice(2);
const CASES = ["text", "tool", "thinking", "editor", "websearch", "webfetch"];
if (!base || !model || !CASES.includes(kind!)) {
  console.error(`usage: gateway-stream.mts <baseUrl|direct> <model> <${CASES.join("|")}>`);
  process.exit(2);
}

const aieo = await import("aieo");
const { streamText, tool, isStepCount } = await import("ai");
const direct = base === "direct";
if (!direct && !process.env["VK"]) throw new Error("set VK to a gateway virtual key");
const r = await aieo.resolveModel({
  model,
  ...(direct ? {} : { baseUrl: base, apiKey: process.env["VK"] }),
  ...(process.env["HEADERS"] ? { headers: JSON.parse(process.env["HEADERS"]) } : {}),
});
console.log(`${r.name} via ${direct ? "direct" : base} — case ${kind}`);

const prompts: Record<string, string> = {
  text: "Say hello in five words.",
  tool: "Call the echo tool with text 'strut-ok', then reply with what it returned.",
  thinking: "Think briefly, then: what is 17 * 23?",
  editor: `Use the editor tool to view ${os.tmpdir()} and reply with one file name you saw.`,
  websearch: "Use web_search to find the capital of Australia; answer in one word.",
  webfetch: "Use web_fetch on https://example.com/ and reply with the page's <title> text only.",
};

let tools: Record<string, any> = {};
let providerOptions: any;
if (kind === "tool") {
  tools = { echo: tool({ description: "echo text back", inputSchema: z.object({ text: z.string() }), execute: async ({ text }) => text }) };
} else if (kind === "thinking") {
  providerOptions = { anthropic: { thinking: { type: "adaptive" } } };
} else if (kind === "editor") {
  // Same construction as the agent step (steps/core/agent.ts).
  if (r.provider !== "anthropic") throw new Error("editor is the anthropic text-editor tool");
  const { anthropic } = await import("@ai-sdk/anthropic");
  tools = {
    str_replace_based_edit_tool: anthropic.tools.textEditor_20250728({
      execute: async (input: TextEditInput) => textEdit(input, [os.tmpdir()]),
    }),
  };
} else if (kind === "websearch" || kind === "webfetch") {
  const web = await createWebTools({ provider: r.provider, apiKey: r.apiKey, searchMaxUses: 1, fetchMaxUses: 1 });
  const name = kind === "websearch" ? aieo.WEB_SEARCH_TOOL_NAME : aieo.WEB_FETCH_TOOL_NAME;
  if (!web.tools[name]) throw new Error(`${name} unavailable for ${r.provider} (EXA_API_KEY for search off anthropic)`);
  tools = { [name]: web.tools[name] };
}

const counts: Record<string, number> = {};
let text = "";
try {
  const res = streamText({
    model: r.model,
    prompt: prompts[kind!]!,
    tools,
    providerOptions,
    maxOutputTokens: 2000,
    stopWhen: isStepCount(4),
  });
  for await (const part of res.fullStream) {
    counts[part.type] = (counts[part.type] ?? 0) + 1;
    if (part.type === "text-delta") text += part.text;
    if (part.type === "error") throw part.error;
  }
  console.log(counts);
  console.log(`text: ${text.trim().slice(0, 300)}`);
} catch (err) {
  console.log(counts);
  console.error("STREAM FAILED:");
  console.error(err);
  process.exit(1);
}
