/**
 * The caller's MCP servers — `POST /workflows/:name/run { mcp }`: a launch
 * hands strut a way back INTO the caller (Hive its org's MCP, any other
 * caller its own), the pull-direction twin of `callback`. Kept the way the
 * callback is: validated before anything launches, recorded on `run.start`
 * by name and origin only, the entries themselves — credentials included —
 * kept by the run store beside the log (`setRunMcp`, read by no endpoint) so
 * a durable resume reconnects, and handed on by `job/start` / `job/continue`
 * / `meta/run-workflow` to the runs they launch. Never to a peer
 * (`strut/run-workflow`): the servers are this caller's, for this strut.
 *
 * Every step sees them as `ctx.mcp`; the `agent` step turns them into tools
 * (`mcp: true`, its default — `connectMcpTools` below), one client per
 * server for the step's life. HTTP (Streamable HTTP) only: a caller names a
 * URL to reach it at, never a process for strut to start. The SDK is the
 * one strut's own MCP door (src/ai/mcp.ts) uses, imported lazily.
 */
import type { McpServer } from "./core.js";
import { withMedia } from "./core.js";
import { callbackOrigin } from "./callback.js";
import { capToolOutput } from "./chat-store.js";
import { globToRegExp } from "./closure.js";

/** At most this many servers on one launch. */
export const MCP_SERVERS_MAX = 10;
/** A server must answer `initialize` and `tools/list` within this. */
const CONNECT_TIMEOUT_MS = 15_000;
/** One tool call may take this long (progress notifications reset it). */
const CALL_TIMEOUT_MS = 300_000;
/** The longest tool name a provider takes (Anthropic, OpenAI). */
const TOOL_NAME_MAX = 64;
/** Values shorter than this are not masked: they would mask common text. */
const MASK_MIN = 6;

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

const isStringRecord = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");

/**
 * A launch body's `mcp`, validated: absent or `null` = none. Throws with a
 * message for the 400. Only the known fields are kept, so nothing else a
 * caller sends rides into the store.
 */
export function parseMcpServers(raw: unknown): McpServer[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) throw new Error("mcp must be an array of { name, url, token?, headers?, toolFilter? }");
  if (raw.length > MCP_SERVERS_MAX) throw new Error(`mcp: at most ${MCP_SERVERS_MAX} servers`);
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    const e = entry as Partial<Record<keyof McpServer, unknown>> | null;
    const at = `mcp[${i}]`;
    if (!e || typeof e !== "object") throw new Error(`${at} must be an object`);
    if (typeof e.name !== "string" || !NAME_RE.test(e.name)) {
      throw new Error(`${at}.name must be 1-32 letters, digits, "_" or "-" (it prefixes the server's tools)`);
    }
    if (seen.has(e.name)) throw new Error(`${at}.name "${e.name}" is given twice`);
    seen.add(e.name);
    if (typeof e.url !== "string") throw new Error(`${at}.url (string) is required`);
    let url: URL;
    try {
      url = new URL(e.url);
    } catch {
      throw new Error(`${at}.url is not a valid URL`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${at}.url must be http(s)`);
    if (e.token !== undefined && typeof e.token !== "string") throw new Error(`${at}.token must be a string`);
    if (e.headers !== undefined && !isStringRecord(e.headers)) throw new Error(`${at}.headers must map names to strings`);
    if (e.toolFilter !== undefined && !(Array.isArray(e.toolFilter) && e.toolFilter.every((t) => typeof t === "string"))) {
      throw new Error(`${at}.toolFilter must be an array of tool names`);
    }
    return {
      name: e.name,
      url: e.url,
      ...(e.token ? { token: e.token } : {}),
      ...(e.headers && Object.keys(e.headers).length ? { headers: e.headers } : {}),
      ...(e.toolFilter?.length ? { toolFilter: e.toolFilter as string[] } : {}),
    };
  });
}

/** What `run.start` records of them: names and origins, never a path, a
 *  query or a credential. */
export function mcpOrigins(servers: McpServer[]): Array<{ name: string; origin: string }> {
  return servers.map((s) => ({ name: s.name, origin: callbackOrigin(s.url) }));
}

/** The request headers for a server: its `headers`, then `token` as the
 *  Authorization (whatever case the caller's own spelled it in). */
export function mcpHeaders(server: McpServer): Record<string, string> {
  const headers = { ...server.headers };
  if (server.token) {
    for (const k of Object.keys(headers)) if (k.toLowerCase() === "authorization") delete headers[k];
    headers["Authorization"] = `Bearer ${server.token}`;
  }
  return headers;
}

/** The credential values a server's results are masked of. */
function credentialValues(server: McpServer): string[] {
  const values = [...Object.values(server.headers ?? {}), ...(server.token ? [server.token] : [])];
  // `Bearer <token>` in a header: the token alone is what a server echoes.
  for (const v of [...values]) {
    const m = /^\s*\S+\s+(\S{6,})\s*$/.exec(v);
    if (m) values.push(m[1]!);
  }
  return values.filter((v) => v.length >= MASK_MIN);
}

/** `<server>_<tool>`, in the characters and length a provider accepts. */
export function mcpToolName(server: string, tool: string): string {
  return `${server}_${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, TOOL_NAME_MAX);
}

/** What the agent step hands in: its own AI SDK pieces (one copy per
 *  process — AGENTS.md), how a result reaches the model, and what is taken. */
export interface McpToolDeps {
  /** The AI SDK's `tool()`. */
  tool: (def: any) => unknown;
  /** The AI SDK's `jsonSchema()`: an MCP tool's input schema is JSON Schema. */
  jsonSchema: (schema: any) => unknown;
  /** How a result is shown to the model — the agent's
   *  `registryToolModelOutput`, so media become file parts. */
  toModelOutput: (output: unknown) => unknown;
  /** Names the agent's other tools hold: an MCP tool by one is skipped. */
  taken?: Iterable<string>;
  /** The most text one result may hand the model, read when a tool runs. */
  maxChars?: () => number;
  /** Only the tools this keeps (a registry grant, src/mcp-registry.ts). */
  only?: (server: McpServer, tool: McpToolInfo) => boolean;
  /** A tool this answers for asks the person first: the model's call
   *  records a proposal through the function returned, which gets the
   *  input without `rationale`, the rationale, and the call's options.
   *  The tool's schema gains `rationale` and its description `gateNote`. */
  gate?: (server: McpServer, tool: McpToolInfo) => ((input: unknown, rationale: string | undefined, options: unknown) => Promise<unknown>) | undefined;
  gateNote?: string;
}

export interface McpTools {
  /** The servers' tools, `<server>_<tool>`, in name order (the prompt cache
   *  reads the tool list as part of the prefix). */
  tools: Record<string, unknown>;
  /** Credential values to mask out of every result. */
  secretValues: string[];
  /** Close every client. Idempotent; never throws. */
  close: () => Promise<void>;
}

type Client = import("@modelcontextprotocol/sdk/client/index.js").Client;
/** A tool as `tools/list` gives it; `annotations.readOnlyHint` is the
 *  server's word that the tool changes nothing (src/mcp-registry.ts gates
 *  every other tool of a registered server). */
export type McpToolInfo = {
  name: string;
  description?: string;
  title?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
};

/** Connect to one server and list its tools. Throws, masked of its
 *  credentials, when it cannot be reached, refuses them or does not answer
 *  in time; the caller closes the client. */
export async function listServerTools(server: McpServer): Promise<{ client: Client; tools: McpToolInfo[] }> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "strut", version: "1" });
  try {
    const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: mcpHeaders(server) } });
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, { timeout: CONNECT_TIMEOUT_MS });
      tools.push(...(page.tools as McpToolInfo[]));
      cursor = page.nextCursor;
    } while (cursor);
    return { client, tools };
  } catch (err) {
    await client.close().catch(() => {});
    throw new Error(maskWith(credentialValues(server))(err instanceof Error ? err.message : String(err)));
  }
}

/** One call to one tool of one server, outside an agent (a proposal's
 *  apply): connect, call, close. The result as `connectMcpTools` gives it. */
export async function callMcpTool(server: McpServer, tool: string, args: Record<string, unknown>, maxChars?: number): Promise<unknown> {
  const { client } = await listServerTools(server);
  const masked = maskWith(credentialValues(server));
  try {
    const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true });
    const out = mcpResult(result, maxChars);
    if (typeof out === "string") return masked(out);
    const o = out as { text?: unknown };
    if (typeof o.text === "string") o.text = masked(o.text);
    return out;
  } catch (err) {
    throw new Error(`${server.name} ${tool} failed: ${masked(err instanceof Error ? err.message : String(err))}`);
  } finally {
    await client.close().catch(() => {});
  }
}

const maskWith = (values: string[]) => (s: string) => values.reduce((out, v) => out.split(v).join("***"), s);

/**
 * Connect to each server and list its tools as AI SDK tools. A server that
 * cannot be reached, refuses the credentials or does not answer in time is
 * skipped with a warning — one caller's server down is never a failed turn.
 * A tool call that fails comes back to the model as an `Error:` text, so the
 * loop goes on; a call cut off by the run cancelling throws, as a cancel
 * does everywhere. The caller closes the clients (`close`) when the step ends.
 */
export async function connectMcpTools(servers: McpServer[], deps: McpToolDeps): Promise<McpTools> {
  const clients: Client[] = [];
  const close = async () => {
    const all = clients.splice(0);
    await Promise.all(all.map((c) => c.close().catch(() => {})));
  };
  if (!servers.length) return { tools: {}, secretValues: [], close };
  const secretValues = [...new Set(servers.flatMap(credentialValues))];
  const masked = maskWith(secretValues);

  const listed = await Promise.all(
    servers.map(async (server) => {
      try {
        const { client, tools } = await listServerTools(server);
        clients.push(client);
        return { server, client, tools };
      } catch (err) {
        console.warn(`[mcp] ${server.name} (${callbackOrigin(server.url)}): skipped — ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
    }),
  );

  const taken = new Set(deps.taken ?? []);
  const entries: Array<[string, unknown]> = [];
  for (const found of listed) {
    if (!found) continue;
    const { server, client, tools } = found;
    const allow = server.toolFilter?.length ? server.toolFilter.map(globToRegExp) : undefined;
    for (const t of tools) {
      if (allow && !allow.some((re) => re.test(t.name))) continue;
      if (deps.only && !deps.only(server, t)) continue;
      const name = mcpToolName(server.name, t.name);
      if (taken.has(name)) {
        console.warn(`[mcp] ${server.name}: tool "${t.name}" skipped — the agent already has a tool named ${name}`);
        continue;
      }
      taken.add(name);
      const description = t.description ?? t.title ?? `The "${t.name}" tool of ${server.name}.`;
      const schema = t.inputSchema ?? { type: "object", properties: {} };
      const propose = deps.gate?.(server, t);
      if (propose) {
        entries.push([
          name,
          deps.tool({
            description: description + (deps.gateNote ?? ""),
            inputSchema: deps.jsonSchema(withRationale(schema)),
            execute: async (input: unknown, options?: unknown) => {
              const { rationale, ...rest } = (input ?? {}) as { rationale?: unknown };
              return propose(rest, typeof rationale === "string" && rationale.trim() ? rationale.trim() : undefined, options);
            },
            toModelOutput: ({ output }: { output: unknown }) => deps.toModelOutput(output),
          }),
        ]);
        continue;
      }
      entries.push([
        name,
        deps.tool({
          description,
          inputSchema: deps.jsonSchema(schema),
          execute: async (input: unknown, options?: { abortSignal?: AbortSignal }) => {
            const signal = options?.abortSignal;
            try {
              const result = await client.callTool({ name: t.name, arguments: (input ?? {}) as Record<string, unknown> }, undefined, {
                ...(signal ? { signal } : {}),
                timeout: CALL_TIMEOUT_MS,
                resetTimeoutOnProgress: true,
              });
              return mcpResult(result, deps.maxChars?.());
            } catch (err) {
              if (signal?.aborted) throw err;
              return `Error: ${server.name} ${t.name} failed: ${masked(err instanceof Error ? err.message : String(err))}`;
            }
          },
          toModelOutput: ({ output }: { output: unknown }) => deps.toModelOutput(output),
        }),
      ]);
    }
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { tools: Object.fromEntries(entries), secretValues, close };
}

/** A gated tool's schema: the server's, plus the `rationale` the card shows. */
function withRationale(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = (schema["properties"] ?? {}) as Record<string, unknown>;
  return { ...schema, type: "object", properties: { ...properties, rationale: { type: "string", description: "One sentence for the person: why this call." } } };
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image" | "audio"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string; blob?: string } }
  | { type: "resource_link"; uri: string; name?: string }
  | { type: string };

/**
 * An MCP tool result as the agent's tools return theirs: the text (`Error:`
 * first when the server says the call failed), capped; images and audio
 * ride beside it with `withMedia`, so the model sees them and the log only
 * the text. A result with no text gives its structured content as JSON.
 */
export function mcpResult(result: unknown, maxChars?: number): unknown {
  const r = (result ?? {}) as { content?: unknown; structuredContent?: unknown; isError?: unknown; toolResult?: unknown };
  const texts: string[] = [];
  const media: Array<{ mediaType: string; data: string }> = [];
  for (const block of (Array.isArray(r.content) ? r.content : []) as ContentBlock[]) {
    if (block.type === "text" && "text" in block) texts.push(block.text);
    else if ((block.type === "image" || block.type === "audio") && "data" in block) media.push({ mediaType: block.mimeType, data: block.data });
    else if (block.type === "resource" && "resource" in block) {
      const res = block.resource;
      if (res.text !== undefined) texts.push(res.text);
      else if (res.blob && res.mimeType?.startsWith("image/")) media.push({ mediaType: res.mimeType, data: res.blob });
      else texts.push(`[resource ${res.uri}${res.mimeType ? ` (${res.mimeType})` : ""}]`);
    } else if (block.type === "resource_link" && "uri" in block) texts.push(`[${block.name ?? block.uri}](${block.uri})`);
  }
  if (!texts.length && r.structuredContent !== undefined) texts.push(JSON.stringify(r.structuredContent));
  if (!texts.length && r.toolResult !== undefined) texts.push(JSON.stringify(r.toolResult));
  let text = texts.join("\n");
  if (r.isError) text = `Error: ${text || "the tool reported an error"}`;
  if (maxChars && maxChars > 0) text = capToolOutput(text, maxChars);
  return media.length ? withMedia({ text }, media) : text;
}
