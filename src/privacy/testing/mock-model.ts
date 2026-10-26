// A scripted AI SDK language model (spec v4) for the privacy tests: it records
// every prompt it is sent, as the bytes a provider would see, and answers from a
// script. Not shipped code: only tests import it.

export type MockContent = Record<string, any>;
export type MockTurn = MockContent[] | ((prompt: any[], call: number) => MockContent[]);

export interface MockOptions {
  turns: MockTurn[];
  provider?: string;
  modelId?: string;
  /** Characters per text/reasoning/tool-input delta when streaming. */
  chunk?: number;
  /** Throw (like a provider 400) when a prompt carries a signed reasoning block this model did not issue. */
  verifySignatures?: boolean;
  config?: Record<string, unknown>;
  /** Another mock whose signatures this one honours (a restarted process talking to the same provider). */
  issuedFrom?: { issued: Map<string, string> };
}

const usage = () => ({
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
});

export function mockModel(o: MockOptions) {
  const issued = o.issuedFrom?.issued ?? new Map<string, string>(); // signature -> reasoning text
  const calls: string[] = [];
  const prompts: any[][] = [];
  let n = 0;

  function check(prompt: any[]) {
    if (!o.verifySignatures) return;
    for (const m of prompt) {
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
      for (const p of m.content) {
        const sig = p.providerOptions?.anthropic?.signature;
        if (p.type === "reasoning" && sig && issued.get(sig) !== p.text) {
          const e = new Error("400 invalid_request_error: messages.N.content.0: thinking block signature does not match");
          (e as any).statusCode = 400;
          throw e;
        }
      }
    }
  }

  function next(prompt: any[]): MockContent[] {
    const i = n++;
    const t = o.turns[Math.min(i, o.turns.length - 1)]!;
    const content = typeof t === "function" ? t(prompt, i) : t;
    const out = JSON.parse(JSON.stringify(content)) as MockContent[];
    for (const p of out) {
      const sig = p.providerMetadata?.anthropic?.signature;
      if (p.type === "reasoning" && sig) issued.set(sig, p.text);
    }
    return out;
  }

  function record(params: any) {
    calls.push(JSON.stringify(params.prompt));
    prompts.push(JSON.parse(JSON.stringify(params.prompt)));
    check(params.prompt);
  }

  const finish = (content: MockContent[]) => ({
    unified: content.some((p) => p.type === "tool-call" && !p.providerExecuted) ? "tool-calls" : "stop",
    raw: undefined,
  });

  const model = {
    specificationVersion: "v4" as const,
    provider: o.provider ?? "anthropic.messages",
    modelId: o.modelId ?? "mock-model",
    supportedUrls: {},
    ...(o.config ? { config: o.config } : {}),
    calls,
    prompts,
    issued,
    get count() { return n; },
    async doGenerate(params: any) {
      record(params);
      const content = next(params.prompt);
      return { content, finishReason: finish(content), usage: usage(), warnings: [] };
    },
    async doStream(params: any) {
      record(params);
      const content = next(params.prompt);
      const size = o.chunk ?? 1000000;
      const parts: any[] = [{ type: "stream-start", warnings: [] }];
      const split = (s: string) => { const r: string[] = []; for (let i = 0; i < s.length; i += size) r.push(s.slice(i, i + size)); return r.length ? r : [""]; };
      content.forEach((p, i) => {
        const id = String(i);
        if (p.type === "text" || p.type === "reasoning") {
          parts.push({ type: `${p.type}-start`, id });
          for (const d of split(p.text)) parts.push({ type: `${p.type}-delta`, id, delta: d });
          parts.push({ type: `${p.type}-end`, id, ...(p.providerMetadata ? { providerMetadata: p.providerMetadata } : {}) });
        } else if (p.type === "tool-call" && !p.providerExecuted) {
          parts.push({ type: "tool-input-start", id: p.toolCallId, toolName: p.toolName });
          for (const d of split(p.input)) parts.push({ type: "tool-input-delta", id: p.toolCallId, delta: d });
          parts.push({ type: "tool-input-end", id: p.toolCallId });
          parts.push(p);
        } else parts.push(p);
      });
      parts.push({ type: "finish", usage: usage(), finishReason: finish(content) });
      return {
        stream: new ReadableStream({
          start(c) { for (const p of parts) c.enqueue(p); c.close(); },
        }),
      };
    },
  };
  return model;
}

/** What the provider saw, as one string, for leak assertions. */
export const sent = (m: { calls: string[] }) => m.calls.join("\n");
