import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import { encodeId, idProblem } from "../../../session-store.js";
import { AcpClient, type AcpUpdate, type PermissionOutcome, type PermissionRequest } from "./_client.js";

/**
 * One turn of a LOCAL coding agent over the Agent Client Protocol — Claude
 * Code, Codex, goose, Gemini CLI, opencode, or any command that speaks ACP
 * on stdio. The agent brings its own model, login and tools; strut hands it
 * a folder and a prompt and records what it did.
 *
 * - `agent`: a preset name (ACP_PRESETS) or a command line.
 * - `session`: strut's name for the thread. The agent mints its own session
 *   id; the step keeps the pair under <dataDir>/acp/sessions/ and resumes it
 *   with session/load when the agent supports that. A different agent on the
 *   same session name starts a fresh thread.
 * - `mode`: how much the agent may do — plan (look only), edit (edit files,
 *   no commands), auto (anything). Set as the agent's own session mode when
 *   it offers one that matches, and enforced again on every
 *   session/request_permission: what the mode doesn't allow is refused, and
 *   the refusals come back as `denied` plus an `ask`, so a host can offer
 *   to rerun the turn with more room.
 *
 * Each tool call is a `step.start`/`step.end` under this step's path, and
 * each stretch of the agent's prose a `message` pair, so a run's event
 * stream reads as the conversation as it happens.
 */

/** Pinned adapter versions: an unpinned `npx -y` reuses whatever is cached. */
export const ACP_PRESETS: Record<string, string[]> = {
  claude: ["npx", "-y", "@agentclientprotocol/claude-agent-acp@0.93.0"],
  codex: ["npx", "-y", "@agentclientprotocol/codex-acp@2.2.2"],
  goose: ["goose", "acp"],
  gemini: ["gemini", "--experimental-acp"],
  opencode: ["opencode", "acp"],
};

type Mode = "plan" | "edit" | "auto";

/** Each agent names its modes differently; the first one it offers wins. */
const MODE_IDS: Record<Mode, string[]> = {
  plan: ["plan", "read-only", "chat"],
  edit: ["acceptEdits", "workspace-write", "smart_approve", "default"],
  auto: ["bypassPermissions", "agent-full-access", "auto"],
};

/** ACP tool kinds a mode lets through when the agent asks. */
const ALLOWED_KINDS: Record<Mode, Set<string> | "all"> = {
  plan: new Set(["read", "search", "think", "fetch"]),
  edit: new Set(["read", "search", "think", "fetch", "edit", "delete", "move"]),
  auto: "all",
};

export function parseAgent(agent: string): string[] {
  const preset = ACP_PRESETS[agent.trim()];
  if (preset) return preset;
  // A command line: whitespace-separated, double quotes group.
  const parts = agent.match(/"[^"]*"|\S+/g) ?? [];
  return parts.map((p) => (p.startsWith('"') ? p.slice(1, -1) : p));
}

export function decidePermission(mode: Mode, req: PermissionRequest): PermissionOutcome & { allowed: boolean } {
  const kind = req.toolCall.kind ?? "other";
  const allowed = ALLOWED_KINDS[mode] === "all" || (ALLOWED_KINDS[mode] as Set<string>).has(kind);
  const pick = (kinds: string[]) => req.options.find((o) => kinds.includes(o.kind));
  const option = allowed ? pick(["allow_once", "allow_always"]) : pick(["reject_once", "reject_always"]);
  return option ? { outcome: "selected", optionId: option.optionId, allowed } : { outcome: "cancelled", allowed };
}

/** `cost`: the session total the agent last reported (ACP usage is cumulative), so a turn reports only its own. */
type SessionRecord = { agent: string; sessionId: string; cost?: number };

async function readSession(file: string): Promise<SessionRecord | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as SessionRecord;
  } catch {
    return null;
  }
}

const textOf = (content: unknown): string => {
  if (!content) return "";
  if (Array.isArray(content)) return content.map(textOf).join("");
  const c = content as Record<string, any>;
  if (c.type === "text") return c.text ?? "";
  if (c.type === "content") return textOf(c.content);
  if (c.type === "diff") return `${c.path ?? ""}\n${c.newText ?? ""}`;
  return "";
};

const clip = (s: string, n = 4000) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more)` : s);

const EXAMPLE = `- id: work
  type: acp/prompt
  config:
    agent: claude
    cwd: "{{ input.repo }}"
    prompt: "{{ input.prompt }}"
    session: "{{ $job }}"
    mode: edit`;

export default defineStep({
  type: "acp/prompt",
  description:
    "Hand one turn to a LOCAL coding agent over ACP (Agent Client Protocol) and return its reply: Claude Code, Codex, goose, Gemini CLI, opencode, or any command that speaks ACP. " +
    "The agent uses its own login, model and tools in `cwd`. `session` continues a thread across turns. `mode`: plan = look only, edit = edit files (commands only inside the agent's own sandbox), auto = anything; " +
    "what the mode refuses comes back in `denied` with an `ask`. Output: { text, session?, stopReason, artifacts (files it changed), denied, ask?, toolCalls, cost? }\n\n" +
    EXAMPLE,
  input: z.object({
    agent: z
      .string()
      .min(1)
      .default("claude")
      .describe(`a preset (${Object.keys(ACP_PRESETS).join(", ")}) or the command line of any ACP agent`),
    cwd: z.string().min(1).describe("absolute path of the folder the agent works in"),
    prompt: z.string().min(1).describe("what to do this turn"),
    session: z.string().optional().describe("strut's name for the thread; the same name next turn continues it"),
    mode: z.enum(["plan", "edit", "auto"]).default("edit").describe("plan: look only. edit: edit files; commands only inside the agent's own sandbox. auto: anything"),
    model: z.string().optional().describe("a model id the agent offers (session/set_model); ignored when it doesn't"),
    env: z.record(z.string(), z.string()).optional().describe("extra environment for the agent process"),
  }),
  output: z.object({
    text: z.string(),
    session: z.string().optional(),
    stopReason: z.string(),
    artifacts: z
      .array(z.object({ id: z.string(), title: z.string(), kind: z.string(), path: z.string() }))
      .describe("files the agent changed this turn, relative to cwd"),
    denied: z.array(z.object({ title: z.string(), kind: z.string() })),
    ask: z.object({ message: z.string() }).optional(),
    toolCalls: z.number(),
    cost: z.number().optional().describe("this turn's spend in USD, when the agent reports it"),
  }),
  async run(cfg, ctx: StepContext) {
    const [cmd, ...args] = parseAgent(cfg.agent);
    if (!cmd) throw new Error("acp/prompt: `agent` is empty");
    if (cfg.session !== undefined) {
      const problem = idProblem(cfg.session);
      if (problem) throw new Error(`acp/prompt: session ${problem}`);
    }
    const mode = cfg.mode as Mode;
    const dataDir = (ctx.services as { dataDir?: string } | undefined)?.dataDir ?? join(tmpdir(), "strut");
    const sessionsDir = join(dataDir, "acp", "sessions");
    const sessionFile = cfg.session ? join(sessionsDir, `${encodeId(cfg.session)}.json`) : null;

    const emit = (ctx.emit ?? (async () => {})) as unknown as (e: Record<string, unknown>) => Promise<void>;
    const base = ctx.path ?? "acp";
    let n = 0;
    const nextPath = (name: string) => `${base}/${String(++n).padStart(3, "0")}-${name}`;

    // Prose arrives in chunks; a tool call (or the end) closes the stretch.
    let message = "";
    let reply = "";
    const flush = async () => {
      if (!message.trim()) return (message = "");
      const path = nextPath("message");
      await emit({ type: "step.start", path, stepType: "message" });
      await emit({ type: "step.end", path, stepType: "message", output: message });
      reply += (reply ? "\n\n" : "") + message.trim();
      message = "";
    };

    const tools = new Map<string, { path: string; title: string; kind: string; started: number; locations?: unknown }>();
    // Files the agent changed this turn, from its edit calls' locations: the turn's artifacts.
    const changed = new Set<string>();
    // The agent may report paths under the cwd's real path (/private/var for /var on macOS).
    const roots = [cfg.cwd, (() => { try { return realpathSync(cfg.cwd); } catch { return cfg.cwd; } })()];
    const rel = (p: string) => {
      if (!isAbsolute(p)) return p;
      const root = roots.find((r) => p === r || p.startsWith(r + sep));
      return root ? relative(root, p) : p;
    };
    const noteLocations = (kind: string, locations: unknown) => {
      if (!["edit", "delete", "move"].includes(kind) || !Array.isArray(locations)) return;
      for (const l of locations as Array<{ path?: unknown }>) {
        if (typeof l?.path !== "string") continue;
        changed.add(rel(l.path));
      }
    };
    const denied: Array<{ title: string; kind: string }> = [];
    let toolCalls = 0;
    let cost: number | undefined;
    let loading = false; // session/load replays history; none of it is this turn
    let queue = Promise.resolve();
    const later = (fn: () => Promise<void>) => (queue = queue.then(fn).catch(() => {}));

    const onUpdate = (_sid: string, u: AcpUpdate) => {
      if (loading) return;
      later(async () => {
        switch (u.sessionUpdate) {
          case "agent_message_chunk":
            message += textOf(u.content);
            break;
          case "tool_call": {
            await flush();
            toolCalls++;
            const id = String(u.toolCallId);
            const title = String(u.title ?? "tool");
            const kind = String(u.kind ?? "other");
            const path = nextPath(kind);
            tools.set(id, { path, title, kind, started: Date.now(), locations: u.locations });
            await emit({ type: "step.start", path, stepType: `tool:${kind}`, input: { title, rawInput: u.rawInput }, toolCallId: id });
            if (u.status === "completed" || u.status === "failed") await finishTool(id, u);
            break;
          }
          case "tool_call_update": {
            const t = tools.get(String(u.toolCallId));
            if (t && typeof u.title === "string") t.title = u.title;
            if (t && u.locations) t.locations = u.locations;
            if (t && typeof u.kind === "string") t.kind = u.kind;
            if (u.status === "completed" || u.status === "failed") await finishTool(String(u.toolCallId), u);
            break;
          }
          case "usage_update": {
            const amount = (u.cost as { amount?: number } | undefined)?.amount;
            if (typeof amount === "number") cost = amount;
            break;
          }
        }
      });
    };

    const finishTool = async (id: string, u: AcpUpdate) => {
      const t = tools.get(id);
      if (!t) return;
      tools.delete(id);
      if (u.status === "completed") noteLocations(t.kind, u.locations ?? t.locations);
      const out = clip(textOf(u.content) || (u.rawOutput !== undefined ? JSON.stringify(u.rawOutput) : ""));
      if (u.status === "failed") {
        await emit({ type: "step.error", path: t.path, stepType: `tool:${t.kind}`, error: { message: out || `${t.title} failed` }, toolCallId: id });
      } else {
        await emit({ type: "step.end", path: t.path, stepType: `tool:${t.kind}`, output: { title: t.title, output: out }, durationMs: Date.now() - t.started, toolCallId: id });
      }
    };

    const onPermission = (req: PermissionRequest) => {
      const decision = decidePermission(mode, req);
      if (!decision.allowed) denied.push({ title: req.toolCall.title ?? "a tool", kind: req.toolCall.kind ?? "other" });
      const { allowed: _a, ...outcome } = decision;
      return outcome as PermissionOutcome;
    };

    const client = new AcpClient(cmd, args, { cwd: cfg.cwd, env: { ...process.env, ...cfg.env } }, { update: onUpdate, permission: onPermission });

    // Cancel: the runner flips control to "cancelling"; tell the agent, then stop waiting.
    let sessionId = "";
    const watch = setInterval(() => {
      if (ctx.control?.state === "cancelling" && sessionId) client.notify("session/cancel", { sessionId });
    }, 300);

    try {
      const init = await client.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "strut", version: "1" },
      });
      const canLoad = Boolean(init?.agentCapabilities?.loadSession);

      const saved = sessionFile ? await readSession(sessionFile) : null;
      let modes: { availableModes?: Array<{ id: string }> } | undefined;
      let models: { availableModels?: Array<{ modelId: string }> } | undefined;
      if (saved && saved.agent === cfg.agent && canLoad) {
        loading = true;
        try {
          const res = await client.request("session/load", { sessionId: saved.sessionId, cwd: cfg.cwd, mcpServers: [] });
          sessionId = saved.sessionId;
          modes = res?.modes;
          models = res?.models;
        } catch {
          // Gone on the agent's side (cleared, another machine): start over below.
        } finally {
          await queue;
          loading = false;
        }
      }
      if (!sessionId) {
        const res = await client.request("session/new", { cwd: cfg.cwd, mcpServers: [] });
        sessionId = res.sessionId;
        modes = res?.modes;
        models = res?.models;
      }
      const priorCost = saved && saved.sessionId === sessionId ? (saved.cost ?? 0) : 0;
      const save = async (total?: number) => {
        if (!sessionFile) return;
        await mkdir(sessionsDir, { recursive: true });
        await writeFile(sessionFile, JSON.stringify({ agent: cfg.agent, sessionId, cost: total ?? priorCost } satisfies SessionRecord));
      };
      await save();

      const offered = new Set((modes?.availableModes ?? []).map((m) => m.id));
      const modeId = MODE_IDS[mode].find((id) => offered.has(id));
      if (modeId) await client.request("session/set_mode", { sessionId, modeId }).catch(() => {});
      if (cfg.model && (models?.availableModels ?? []).some((m) => m.modelId === cfg.model)) {
        await client.request("session/set_model", { sessionId, modelId: cfg.model }).catch(() => {});
      }

      const result = await client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: cfg.prompt }] });
      await queue;
      await flush();
      if (cost !== undefined) await save(cost);
      const turnCost = cost === undefined ? undefined : Math.round(Math.max(0, cost - priorCost) * 1e6) / 1e6;

      const ask = denied.length
        ? {
            message:
              `This turn ran in ${mode} mode, which kept the agent from: ` +
              denied.map((d) => d.title).join("; ") +
              ". Run it again with more room if that's fine.",
          }
        : undefined;
      return {
        text: reply,
        ...(cfg.session ? { session: cfg.session } : {}),
        stopReason: String(result?.stopReason ?? "end_turn"),
        artifacts: [...changed].map((p) => ({ id: p, title: p, kind: "code", path: p })),
        denied,
        ...(ask ? { ask } : {}),
        toolCalls,
        ...(turnCost !== undefined ? { cost: turnCost } : {}),
      };
    } finally {
      clearInterval(watch);
      await client.close();
    }
  },
});
