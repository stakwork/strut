/**
 * Strut over MCP — one stateless server + transport per request, serving an
 * AI SDK ToolSet to an external agent (Claude Code: `claude mcp add
 * --transport http strut <url>/mcp --header "Authorization: Bearer <key>"`).
 * Three tool sets ride on it (createStrut mounts them):
 *
 *   `POST /mcp`          the ASSISTANT set (ai/assistant-tools.ts): nine
 *                        tools — talk to the workflow builder, read a chat,
 *                        list workflows / runs, read a run, run a workflow,
 *                        search the package store and read a package's page
 *                        — for an agent that has forty other tools and
 *                        should not learn strut's YAML. The default.
 *   `POST /mcp/builder`  the BUILDER set: the SAME tools the builder chat's
 *                        model gets — `buildTools(deps)`: their names,
 *                        descriptions, input schemas and CAPPED results
 *                        (`capToolResults`) — for an agent that authors
 *                        workflows itself.
 *
 * A third door is the INDEX role's, `POST /index/mcp` (src/packages/
 * index-tools.ts): the store's three reads for an agent with no credential.
 *
 * Every set is adapted generically here, so no tool exists twice. tools/list reads each tool's JSON Schema through the AI SDK's own
 * `asSchema`; tools/call validates the arguments with it (defaults applied),
 * runs `execute`, drains a generator tool to its last yield (the earlier
 * ones become `notifications/progress` when the client asked for them), and
 * hands the model-facing result (`toModelOutput`, where the cap lives) back
 * as MCP content. `instructions` is the builder's procedure
 * (BUILDER_PROCEDURE) and the UI's URL; the whole system prompt — the rules
 * and the step catalog — is served as the `workflow-builder` prompt.
 *
 * The SDK is imported lazily, like @ladybugdb/core: nothing loads it until
 * the first MCP request. The LOW-LEVEL `Server` is used, never
 * `McpServer.registerTool`: strut's tool schemas are its own zod's objects
 * and must not cross into the SDK's zod (AGENTS.md, "One copy per process").
 */
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { asSchema, type ToolSet } from "ai";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult, Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { BUILDER_PROCEDURE, buildSystem, type AiDeps } from "./prompts.js";
import { buildTools } from "./tools.js";

const VERSION: string = createRequire(import.meta.url)("../../package.json").version;

/** The one prompt: the builder chat's full system prompt (`buildSystem`). */
export const PROMPT_NAME = "workflow-builder";
const PROMPT_DESCRIPTION =
  "The workflow builder's full system prompt: the YAML rules, how each tool is used, this deployment's own notes on what is built here, and the step catalog as of now. Read it before building anything.";

/** What run_workflow says about a detached run here — no notification can
 *  reach an MCP client, so it polls (`AiDeps.detach.hint`). */
export const MCP_DETACH_HINT =
  "nothing notifies you over MCP: call get_run(name, runId, wait: 30000) again until `status` is terminal (success | error | cancelled).";

/** `InitializeResult.instructions`: the procedure, the UI, and what differs
 *  over MCP — short, where the whole prompt (~28k chars) would not fit. */
export function builderInstructions(publicUrl: string): string {
  return (
    `Strut's workflow builder over MCP: the tools its builder chat's model uses, with the same descriptions and result caps. ` +
    `The "${PROMPT_NAME}" prompt (prompts/get) is that chat's full system prompt — the YAML rules, every tool's use, this deployment's own notes on what is built here and how, and the step catalog; read it before building anything. ` +
    `The web UI is at ${publicUrl}/ — a \`ui\` link in a result opens that workflow or run there, and an artifact link in a result opens the file (it carries its own read token).\n\n` +
    `${BUILDER_PROCEDURE}\n\n` +
    `Over MCP, "this prompt" above means the ${PROMPT_NAME} prompt (its step catalog is as of its read; list_steps re-lists), and no notification ever arrives: a run_workflow that detached is finished by calling get_run with \`wait\` until its status is terminal. ` +
    `The prompt's ask_user and request_secret are not offered here: ask the user yourself, and NEVER collect a credential's value — call list_secrets, and when the NAME a step needs is missing send the user to add it under Secrets in the UI, ${publicUrl}/?secrets=1 (the name, then the value; it never passes through you), then call list_secrets again.`
  );
}

/** `InitializeResult.instructions` for the ASSISTANT set: short on purpose
 *  — the caller's context is the point of this surface. */
export function assistantInstructions(publicUrl: string): string {
  return (
    `Strut runs workflows — automations built from steps (HTTP, shell, LLM and agent calls, browser, git, …), scheduled or run on demand, each run keeping its output and the files it wrote. ` +
    `You do not author them: strut's own WORKFLOW BUILDER does. ask_workflow_builder with what you want in plain words (what it should do, its inputs, a schedule, what the deliverable is); the reply is its text plus \`did\` — what it published, ran and scheduled, with links. ` +
    `Continue the same chat for changes, debugging ("why did run X fail?") and questions; it remembers. The call holds up to \`wait\` for the reply; status "working" means read_workflow_builder_chat with wait until it is not; "asked" means it has a question in \`question\` — answer it in your next message on that chat, or for a secret send YOUR USER to the link (never collect a credential's value). ` +
    `Lost the chat id? list_workflow_builder_chats. ` +
    `For a workflow that exists: list_workflows (schedules, last run), run_workflow (now), list_runs (each run's deliverables as links), get_run (the result; large output fields are held back until you name them in \`fields\`). ` +
    `Before asking for an integration from scratch, search the package STORE: search_packages (what people published — workflows, steps, apps, Concept pages — each hit with what it holds and reaches), get_package (one package's page); installing one is the PERSON's act, in the UI's Packages dialog, and the result says where. ` +
    `Ask the builder to declare a workflow's deliverables as \`artifacts\` (a file, a URL): then every run hands you links instead of big blobs. ` +
    `Every link is absolute on ${publicUrl} and an artifact link carries its own read token — anyone with the link reads that one run's files, nothing else, with no expiry — so share it with your other connectors as it is. ` +
    `The web UI is at ${publicUrl}/; a \`ui\` link opens that workflow, run or chat there. Nothing notifies you over MCP: poll with \`wait\`, or check list_runs with \`since\`.`
  );
}

// ── Tools, adapted ─────────────────────────────────────────────────────────

export interface McpCallOptions {
  signal?: AbortSignal;
  /** Called for every yield of a generator tool but the last (its result),
   *  when the client sent a progress token. */
  progress?: (progress: number, message: string) => Promise<void> | void;
}

export interface McpTools {
  /** tools/list: every tool with an `execute`, its description and its
   *  input schema as JSON Schema. */
  list(): Promise<McpTool[]>;
  /** tools/call: validate, execute, drain, cap, map — never throws for a
   *  tool's own failure (that is a result with `isError`). */
  call(name: string, args: unknown, opts?: McpCallOptions): Promise<CallToolResult>;
}

type Content = CallToolResult["content"][number];
type ModelOutput = { type: string; value?: unknown };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isAsyncIterable = (v: unknown): v is AsyncIterable<unknown> =>
  typeof v === "object" && v !== null && Symbol.asyncIterator in v;

const errorResult = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

/** A progress line for an intermediate yield: its JSON, cut short. */
function progressMessage(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
  return s.length > 400 ? `${s.slice(0, 400)}…` : s;
}

/** What the model would read (`toModelOutput`: text, json, media parts) as
 *  MCP content. JSON is also `structuredContent` when it is an object. */
function toContent(out: ModelOutput): { content: Content[]; structuredContent?: Record<string, unknown>; isError?: true } {
  switch (out.type) {
    case "text":
      return { content: [{ type: "text", text: String(out.value ?? "") }] };
    case "error-text":
      return { content: [{ type: "text", text: String(out.value ?? "") }], isError: true };
    case "json":
    case "error-json": {
      const value = out.value ?? null;
      return {
        content: [{ type: "text", text: JSON.stringify(value) ?? "null" }],
        ...(isRecord(value) ? { structuredContent: value } : {}),
        ...(out.type === "error-json" ? { isError: true as const } : {}),
      };
    }
    case "execution-denied":
      return { content: [{ type: "text", text: "execution denied" }], isError: true };
    case "content": {
      const parts = Array.isArray(out.value) ? (out.value as Array<Record<string, unknown>>) : [];
      return {
        content: parts.map((p): Content => {
          if (p["type"] === "text") return { type: "text", text: String(p["text"] ?? "") };
          const mediaType = String(p["mediaType"] ?? "application/octet-stream");
          const data = String(p["data"] ?? "");
          if (mediaType.startsWith("image/")) return { type: "image", data, mimeType: mediaType };
          if (mediaType.startsWith("audio/")) return { type: "audio", data, mimeType: mediaType };
          return { type: "text", text: `[media ${mediaType}, ${data.length} base64 chars]` };
        }),
      };
    }
    default:
      return { content: [{ type: "text", text: JSON.stringify(out) ?? "" }] };
  }
}

/** Per-tool `_meta`, listed beside the tool (tools/list): what an AI SDK
 *  tool has no field for — MCP Apps' `ui.visibility` (an app-only tool,
 *  src/apps/tools.ts), a `ui.resourceUri` later. */
export type McpToolMeta = Record<string, Record<string, unknown>>;

/** The builder's AI SDK tools as MCP tools — nothing reimplemented. */
export function mcpToolsFrom(tools: ToolSet, meta: McpToolMeta = {}): McpTools {
  const executable = Object.entries(tools).filter(([, t]) => typeof t.execute === "function");
  return {
    async list() {
      return Promise.all(
        executable.map(async ([name, t]) => {
          // The AI SDK's own JSON Schema for the tool (zod → draft-7 here);
          // `$schema` is noise to an MCP client.
          const { $schema: _, ...inputSchema } = (await asSchema(t.inputSchema).jsonSchema) as Record<string, unknown> & { $schema?: string };
          // The SDK lets a description be computed per call; the builder's are strings.
          const description = typeof t.description === "function" ? t.description({ context: undefined }) : t.description;
          return {
            name,
            ...(description ? { description } : {}),
            inputSchema: { type: "object" as const, ...inputSchema },
            ...(meta[name] ? { _meta: meta[name] } : {}),
          };
        }),
      );
    },

    async call(name, args, opts = {}) {
      const t = tools[name];
      if (!t || typeof t.execute !== "function") return errorResult(`Unknown tool: ${name}`);
      // Validate as the AI SDK would before `execute`: defaults applied, a
      // bad call refused with the schema's message.
      const schema = asSchema(t.inputSchema);
      const v = schema.validate ? await schema.validate(args ?? {}) : { success: true as const, value: args ?? {} };
      if (!v.success) return errorResult(`Invalid arguments for ${name}: ${v.error.message}`);
      const input = v.value;
      const toolCallId = `mcp-${randomUUID()}`;
      let output: unknown;
      try {
        output = await t.execute(input, { toolCallId, messages: [], context: undefined, ...(opts.signal ? { abortSignal: opts.signal } : {}) });
        // A generator tool (run_workflow): every yield but the last is a
        // preliminary result — progress to a client that asked; the last is
        // the result, as for the chat's model.
        if (isAsyncIterable(output)) {
          let last: unknown;
          let n = 0;
          let any = false;
          for await (const y of output) {
            if (any) await opts.progress?.(n++, progressMessage(last));
            last = y;
            any = true;
          }
          output = last;
        }
      } catch (err) {
        return errorResult(`${name} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      // The model-facing result — the cap lives in toModelOutput
      // (capToolResults); the SDK's default shape where a tool has none.
      const modelOutput: ModelOutput = t.toModelOutput
        ? ((await t.toModelOutput({ toolCallId, input, output })) as ModelOutput)
        : typeof output === "string"
          ? { type: "text", value: output }
          : { type: "json", value: output ?? null };
      const mapped = toContent(modelOutput);
      // The builder's tools report their own failures as `{ error }`.
      const failed = isRecord(output) && output["error"] != null;
      return { ...mapped, ...(failed || mapped.isError ? { isError: true } : {}) };
    },
  };
}

// ── The server ─────────────────────────────────────────────────────────────

export interface McpPrompt {
  name: string;
  description: string;
  /** The prompt's text, read at each prompts/get. */
  read: () => Promise<string>;
}

export interface ToolsetServerOptions {
  tools: ToolSet;
  /** `InitializeResult.instructions`. */
  instructions: string;
  /** Prompts served; none → no prompts capability. */
  prompts?: McpPrompt[];
  /** Per-tool `_meta` (`McpToolMeta`), passed through to tools/list. */
  meta?: McpToolMeta;
}

/** One SDK `Server` over a tool set (and prompts) — what `createMcpDoor`
 *  connects to a transport per request, and what a test connects to an
 *  `InMemoryTransport`. */
export async function toolsetServer({ tools: toolSet, instructions, prompts = [], meta }: ToolsetServerOptions): Promise<Server> {
  const [{ Server }, types] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/index.js"),
    import("@modelcontextprotocol/sdk/types.js"),
  ]);
  const tools = mcpToolsFrom(toolSet, meta);
  const server = new Server(
    { name: "strut", version: VERSION },
    { capabilities: { tools: {}, ...(prompts.length ? { prompts: {} } : {}) }, instructions },
  );

  server.setRequestHandler(types.ListToolsRequestSchema, async () => ({ tools: await tools.list() }));
  server.setRequestHandler(types.CallToolRequestSchema, async ({ params }, extra) => {
    const progressToken = params._meta?.progressToken;
    return tools.call(params.name, params.arguments ?? {}, {
      signal: extra.signal,
      ...(progressToken === undefined
        ? {}
        : {
            progress: (progress: number, message: string) =>
              extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress, message } }),
          }),
    });
  });
  if (prompts.length) {
    server.setRequestHandler(types.ListPromptsRequestSchema, async () => ({
      prompts: prompts.map(({ name, description }) => ({ name, description })),
    }));
    server.setRequestHandler(types.GetPromptRequestSchema, async ({ params }) => {
      const p = prompts.find((x) => x.name === params.name);
      if (!p) throw new types.McpError(types.ErrorCode.InvalidParams, `Unknown prompt: ${params.name}`);
      return { description: p.description, messages: [{ role: "user", content: { type: "text", text: await p.read() } }] };
    });
  }
  return server;
}

export interface BuilderMcpOptions {
  deps: AiDeps;
  /** `InitializeResult.instructions` (`builderInstructions`). */
  instructions: string;
  /** The `workflow-builder` prompt's text: `buildSystem(deps)` by default. */
  prompt?: () => Promise<string>;
  /** Tools served BESIDE the builder's — the app door's `step_run`
   *  (src/apps/tools.ts), with its `_meta` in `meta`. */
  tools?: ToolSet;
  meta?: McpToolMeta;
}

/** The BUILDER set: `buildTools(deps)` + the `workflow-builder` prompt. */
export function builderServer({ deps, instructions, prompt, tools, meta }: BuilderMcpOptions): Promise<Server> {
  return toolsetServer({
    tools: { ...buildTools(deps), ...(tools ?? {}) },
    instructions,
    prompts: [{ name: PROMPT_NAME, description: PROMPT_DESCRIPTION, read: prompt ?? (() => buildSystem(deps)) }],
    ...(meta ? { meta } : {}),
  });
}

/**
 * The HTTP door: a fresh server + transport per request, STATELESS (no
 * session id: every POST stands alone, initialize or not, nothing is kept
 * between requests — the deployment key is the session). The response is
 * the transport's: an SSE stream carrying the result (and any progress
 * notification), or a JSON error.
 */
export function createMcpDoor(server: () => Promise<Server>): { handle(req: Request): Promise<Response> } {
  return {
    async handle(req) {
      const { WebStandardStreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");
      const s = await server();
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await s.connect(transport);
      return transport.handleRequest(req);
    },
  };
}

/** The builder set's door (`POST /mcp/builder`). */
export function createBuilderMcp(opts: BuilderMcpOptions): { handle(req: Request): Promise<Response> } {
  return createMcpDoor(() => builderServer(opts));
}
