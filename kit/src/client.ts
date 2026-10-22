/** The client every hook calls (plans/apps.md §3.2): ONE call, the §5 tool —
 *  `step_run { type, config?, input? }` under the app's grants. In an app the
 *  client is the MCP Apps bridge (`createBridgeClient`); in a host's own page
 *  the host supplies one. */
export interface StrutClient {
  /** Run one registry step: its `config` (the step's own fields) and the
   *  `input` scope its `{{ input.* }}` templates read. Resolves to the
   *  step's output; a refused or failed step rejects with a `StrutError`. */
  run<T = unknown>(type: string, config?: Record<string, unknown>, input?: unknown): Promise<T>;
  /** Which app this page is, read off its identity (`appOfToken`); absent
   *  for a host's own client. */
  readonly app?: AppIdentity;
}

/** Which app a page is (plans/apps.md §7.2): a workspace app at a version. */
export type AppIdentity = { name: string; version: string };

/** The app a page's identity names — `app:<name>@<vN>.<token>` — read,
 *  never checked: strut checks the token on every call. Undefined for
 *  anything else. */
export function appOfToken(token: string | undefined): AppIdentity | undefined {
  if (!token) return undefined;
  const scope = token.slice(0, Math.max(0, token.lastIndexOf(".")));
  const app = scope.match(/^app:(.+)@(v\d+)$/);
  return app ? { name: app[1]!, version: app[2]! } : undefined;
}

/** The one tool an app calls (§5). */
export const STEP_RUN_TOOL = "step_run";

/** The step strut wrote the page to report its failures to (§8). */
export const REPORT_ERROR_STEP = "app/report-error";

export class StrutError extends Error {
  constructor(message: string, readonly type: string, readonly detail?: unknown) {
    super(message);
    this.name = "StrutError";
  }
}

/** What `tools/call` answers with — the part of MCP's `CallToolResult` the
 *  client reads. */
export interface ToolResult {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
  [k: string]: unknown;
}

/** The step's output out of a tool result: `structuredContent` when the door
 *  set it, else the first text part parsed as JSON (the text itself when it is
 *  not JSON). An `isError` result throws with the door's message — a JSON
 *  `{ error }` text, or the text as it is. */
export function unwrapToolResult(type: string, result: ToolResult): unknown {
  const text = result.content?.find((c) => c.type === "text" && typeof c.text === "string")?.text;
  if (result.isError) {
    const parsed = parseJson(text);
    const message =
      parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : text || `${type} failed`;
    throw new StrutError(message, type, parsed ?? text);
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (text === undefined) return undefined;
  const parsed = parseJson(text);
  return parsed === undefined ? text : parsed;
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Something that can make a `tools/call` — the MCP Apps `App`'s
 *  `callServerTool`, or a host's relay. */
export interface ToolCaller {
  callServerTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<ToolResult>;
}

/** The bridge client: every `run` is `tools/call` of `step_run`, with the
 *  app's file token as its `app` argument (§7.2) — what tells strut which
 *  app is calling, so it applies that app's grants. */
export function createBridgeClient(caller: ToolCaller, token: string | undefined): StrutClient {
  const app = appOfToken(token);
  return {
    ...(app ? { app } : {}),
    async run<T>(type: string, config?: Record<string, unknown>, input?: unknown): Promise<T> {
      const args: Record<string, unknown> = { type };
      if (config !== undefined) args.config = config;
      if (input !== undefined) args.input = input;
      if (token !== undefined) args.app = token;
      const result = await caller.callServerTool({ name: STEP_RUN_TOOL, arguments: args });
      return unwrapToolResult(type, result) as T;
    },
  };
}
