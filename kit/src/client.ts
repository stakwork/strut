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

/** The `<meta name>` a document carries when it is served in a strut
 *  server's PUBLIC VIEW (plans/public-surface.md §5): a visitor with no
 *  account reads it — reads only, no launches. */
export const PUBLIC_VIEW_META = "strut-public-view";

/** Is this page a visitor's, served in a strut server's public view? */
export function isPublicView(doc: Document | undefined = typeof document !== "undefined" ? document : undefined): boolean {
  return !!doc?.querySelector(`meta[name="${PUBLIC_VIEW_META}"]`);
}

/** The `<meta name>` a public view document carries beside its mark when
 *  a visitor may START some of the workflows the app grants
 *  (plans/paid-runs.md §10): a JSON array of `{ name, results }`. */
export const PUBLIC_RUNNABLE_META = "strut-public-runnable";

/** What a visitor reads of a run it launched: its `output` alone (the
 *  summary — `useRun` — and the files the output declares, `run/files`), or
 *  the whole `run` (its events and transcripts too: `useRunEvents`,
 *  `useWorkProducts`, a run timeline). */
export type PublicResults = "output" | "run";

/** The workflows a visitor's page may start, each with what it reads of
 *  its own runs: none outside the public view, where a page starts what its
 *  viewer may. */
export function publicRunnableItems(doc: Document | undefined = typeof document !== "undefined" ? document : undefined): Array<{ name: string; results: PublicResults }> {
  const content = doc?.querySelector(`meta[name="${PUBLIC_RUNNABLE_META}"]`)?.getAttribute("content");
  if (!content) return [];
  try {
    const items: unknown = JSON.parse(content);
    if (!Array.isArray(items)) return [];
    const out: Array<{ name: string; results: PublicResults }> = [];
    for (const it of items) {
      if (typeof it === "string") out.push({ name: it, results: "output" });
      else if (it && typeof it === "object" && typeof (it as { name?: unknown }).name === "string") {
        out.push({ name: (it as { name: string }).name, results: (it as { results?: unknown }).results === "run" ? "run" : "output" });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** The names alone (`publicRunnableItems`). */
export function publicRunnable(doc?: Document): string[] {
  return publicRunnableItems(doc).map((i) => i.name);
}

/** What a public view's `run/launch` answers when the workflow is priced
 *  and no credit covers the run (plans/paid-runs.md §10): the HOST pays it
 *  and retries, so a page only sees one when its host cannot pay. */
export interface PaymentRequired {
  carries?: boolean;
  macaroon: string;
  invoice: string;
  usd: number;
  sats: number;
  rate?: { usdPerBtc: number; at: string; source: string };
  description?: string;
  expires?: string;
  remaining_usd?: number;
  reason?: string;
}

/** The `payment_required` a launch answered with, else undefined. */
export function paymentRequiredOf(output: unknown): PaymentRequired | undefined {
  const p = (output as { payment_required?: unknown } | null | undefined)?.payment_required;
  return p && typeof p === "object" && typeof (p as PaymentRequired).invoice === "string" ? (p as PaymentRequired) : undefined;
}

/** Which app a page is (plans/apps.md §7.2): a workspace app at a version. */
export type AppIdentity = { name: string; version: string };

/** The app a page's identity names — `app:<name>@<vN>.<token>` — read,
 *  never checked: strut checks the token on every call. Undefined for
 *  anything else. */
export function appOfToken(token: string | undefined): AppIdentity | undefined {
  if (!token) return undefined;
  const scope = token.slice(0, Math.max(0, token.lastIndexOf(".")));
  const app = scope.match(/^app:(.+)@(v\d+|preview-[0-9a-f]{12})$/);
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
  callServerTool(params: { name: string; arguments?: Record<string, unknown> }, options?: { timeout?: number }): Promise<ToolResult>;
}

/** How long a page waits on `run/launch` (the MCP default is 60 s): in a
 *  strut server's public view a priced launch returns only once the
 *  visitor has paid its host, and an invoice lasts ten minutes
 *  (plans/paid-runs.md §10). A host that sends progress meanwhile resets
 *  the default anyway; this is for one that does not. */
export const LAUNCH_TIMEOUT_MS = 15 * 60_000;

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
      const result = await caller.callServerTool({ name: STEP_RUN_TOOL, arguments: args }, type === "run/launch" ? { timeout: LAUNCH_TIMEOUT_MS } : undefined);
      return unwrapToolResult(type, result) as T;
    },
  };
}
