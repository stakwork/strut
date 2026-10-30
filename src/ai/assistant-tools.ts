/**
 * The ASSISTANT tool set — what `POST /mcp` serves by default (src/ai/mcp.ts
 * adapts it like any AI SDK ToolSet; `/mcp/builder` serves the builder's own
 * tools, ai/tools.ts).
 *
 * An external agent — Claude Code, Hermes, anything with forty other tools —
 * should not learn strut's YAML dialect, its step catalog or its claims to
 * get a workflow built: the workflow builder already knows all of that. So
 * this surface has NINE tools and no model behind any but the first:
 *
 *   ask_workflow_builder        — a message to the builder (a new chat, or a
 *                                 continuation), answered in the same call
 *                                 when the turn ends within `wait`
 *   read_workflow_builder_chat  — the turns since a cursor: what was said,
 *                                 what the builder answered, what it DID
 *   list_workflow_builder_chats — find a chat again (a long build outlives
 *                                 the caller's memory of the id)
 *   list_workflows              — with schedules and the last run
 *   list_runs                   — with each run's deliverables as links
 *   get_run                     — the basics up front, big output fields
 *                                 held back until asked for by name
 *   run_workflow                — the builder's own, its output trimmed
 *   search_packages             — the package STORE: what people published,
 *                                 each hit with what its release holds
 *   get_package                 — one package's page (apps, workflows with
 *                                 inputs, steps, Concept pages, README, can)
 *                                 — read only: installing is the person's
 *                                 act, and the tools say where
 *
 * Every link is ABSOLUTE on `publicUrl` and an artifact link carries its
 * read token: a caller shares it with its own connectors as it is. The chat
 * fold is src/chat-view.ts; the output trim is `trimOutput` here. Nothing in
 * this module touches the chat store's layout or launches a turn itself —
 * `AssistantDeps.chat` is createStrut's door (the same code as `POST /chat`).
 */
import { z } from "zod";
import { tool, type Tool, type ToolSet } from "ai";
import type { WorkspaceStore } from "../workspace.js";
import type { RunStore } from "../store.js";
import type { ChatMeta, ChatStore } from "../chat-store.js";
import type { ArtifactRef } from "../artifact-refs.js";
import type { Automations } from "../scheduler.js";
import { listWorkflowEntries, DEFAULT_WORKFLOW_LIST_LIMIT } from "../authoring.js";
import { buildChatView, DEFAULT_CHAT_VIEW_LIMIT, type ChatView } from "../chat-view.js";
import { fileScopeOf, fileToken } from "../auth.js";
import { jobFileUrl } from "../artifact-refs.js";
import { MAX_RUN_WAIT_MS, publicRef } from "./tools.js";
import { capToolResults } from "./tools.js";
import { INSTALL_IS_A_PERSONS_ACT, README_BRIEF_CHARS, briefPackagePage, type PackagesCapability } from "../packages/indexes.js";

export interface AssistantChatDoor {
  /** `POST /chat`'s core: append the caller's message to the chat (a new one
   *  without `chatId`) and launch its turn detached. `at` is the index of the
   *  appended message — the fold reads this turn from there. */
  send(args: { chatId?: string; message: string; title?: string; actor?: string; publicUrl?: string }): Promise<
    { chatId: string; turn: number; at: number } | { error: string; code: "not_found" | "busy" }
  >;
  /** A turn is running for this chat (the notifier's view). */
  isLive(chatId: string): boolean;
  /** Nothing this process knows of will start another turn: no detached run
   *  or verify pass is outstanding, and no turn is live. */
  isSettled(chatId: string): boolean;
  /** A chat left `live` by a dead process is reconciled on first sight. */
  reconcile(meta: ChatMeta): Promise<ChatMeta>;
  /** The error that ended a turn (`chat.error`), when it did. */
  turnError(chatId: string, turn: number): Promise<string | undefined>;
  /** The auto-turn cap: at it the chat is parked. */
  maxAutoTurns: number;
}

export interface AssistantDeps {
  workspace: WorkspaceStore;
  store: RunStore;
  chatStore: ChatStore;
  chat: AssistantChatDoor;
  /** Schedules on list_workflows; absent → none listed. */
  automations?: Automations;
  /** The base every link is made absolute on. */
  publicUrl: string;
  /** A run's declared deliverables, resolved (createStrut's `artifactRefs`). */
  artifactRefs: (runId: string, output: unknown, job?: string) => Promise<ArtifactRef[] | undefined>;
  /** Every file a run produced: its artifact directory, or its job's. */
  listFiles: (runId: string, job?: string) => Promise<string[]>;
  /** The builder's `run_workflow` (buildTools(deps).run_workflow): the one
   *  tool reused whole — its launch, detach and link logic — under a
   *  description for this caller and with its output trimmed. */
  runWorkflow: Tool;
  /** The caller's actor (`x-strut-actor`): the chats it starts are its. */
  actor?: string;
  /** The package store's reads (src/packages/indexes.ts): the indexes this
   *  strut follows and the peers' installs. Absent → the two package tools
   *  answer with an error. */
  packages?: PackagesCapability;
}

/** A run's output as this surface hands it over (`get_run`, `run_workflow`):
 *  a top-level field over this many chars is held back as `{ $omitted }`
 *  until asked for by name. */
export const OUTPUT_FIELD_MAX_CHARS = 2_000;
/** A field asked for by name comes whole up to this; past it, cut with a note. */
export const OUTPUT_FIELD_WHOLE_MAX_CHARS = 50_000;
/** The default `wait` on ask / read: most builder turns answer within it. */
export const DEFAULT_CHAT_WAIT_MS = 45_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// ── Output trimming ────────────────────────────────────────────────────────

export interface Omitted {
  field: string;
  chars: number;
  /** `object | array | string | …` */
  kind: string;
  preview: string;
}

/** Hold back the big top-level fields of a run's output (see
 *  OUTPUT_FIELD_MAX_CHARS): each becomes `{ $omitted: { chars, kind,
 *  preview } }` in place and is named in `omitted`; `fields` names the ones
 *  to include whole (cut at OUTPUT_FIELD_WHOLE_MAX_CHARS with a note). An
 *  output that is not an object is treated as one field, `output`. */
export function trimOutput(output: unknown, fields: string[] = []): { output: unknown; omitted?: Omitted[] } {
  const want = new Set(fields);
  const omitted: Omitted[] = [];
  const size = (v: unknown) => (typeof v === "string" ? v.length : (JSON.stringify(v) ?? "").length);
  const kindOf = (v: unknown) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);
  const stub = (field: string, v: unknown) => {
    const chars = size(v);
    const text = typeof v === "string" ? v : (JSON.stringify(v) ?? "");
    omitted.push({ field, chars, kind: kindOf(v), preview: text.slice(0, 120) });
    return { $omitted: { chars, kind: kindOf(v), preview: text.slice(0, 120) } };
  };
  const whole = (v: unknown) => {
    if (size(v) <= OUTPUT_FIELD_WHOLE_MAX_CHARS) return v;
    const text = typeof v === "string" ? v : (JSON.stringify(v) ?? "");
    return `${text.slice(0, OUTPUT_FIELD_WHOLE_MAX_CHARS)}… [cut, ${text.length} chars; the whole value is in the run's files or the UI]`;
  };
  if (!isRecord(output)) {
    if (output === undefined || size(output) <= OUTPUT_FIELD_MAX_CHARS) return { output };
    return want.has("output") ? { output: whole(output) } : { output: stub("output", output), omitted };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(output)) {
    if (want.has(k)) out[k] = whole(v);
    else out[k] = size(v) > OUTPUT_FIELD_MAX_CHARS ? stub(k, v) : v;
  }
  return { output: out, ...(omitted.length ? { omitted } : {}) };
}

// ── The tools ──────────────────────────────────────────────────────────────

export type ChatStatus = "working" | "asked" | "parked" | "error" | "done";

export function buildAssistantTools(deps: AssistantDeps): ToolSet {
  const base = deps.publicUrl.replace(/\/+$/, "");
  const ui = {
    workflow: (name: string, runId?: string) => `${base}/?wf=${encodeURIComponent(name)}${runId ? `&run=${encodeURIComponent(runId)}` : ""}`,
    chat: (chatId: string) => `${base}/?chat=${encodeURIComponent(chatId)}`,
  };
  const fileUrl = (relative: string) => {
    const scope = fileScopeOf(relative);
    const token = scope ? fileToken(scope) : undefined;
    return `${base}${relative}${token ? `?t=${token}` : ""}`;
  };
  const artifacts = async (runId: string, output: unknown, job?: string) => {
    const refs = await deps.artifactRefs(runId, output, job).catch(() => undefined);
    return refs ? refs.map((r) => publicRef(r, base)) : undefined;
  };

  /** Hold until the chat's turn ends or the wait is up. */
  const awaitIdle = async (chatId: string, wait: number) => {
    const deadline = Date.now() + wait;
    while (deps.chat.isLive(chatId) && Date.now() < deadline) await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
  };

  const statusOf = (meta: ChatMeta): ChatStatus => {
    if (deps.chat.isLive(meta.id)) return "working";
    if (meta.elicitation) return "asked";
    if ((meta.autoTurns ?? 0) >= deps.chat.maxAutoTurns) return "parked";
    if (meta.status === "error") return "error";
    return "done";
  };

  /** The builder's open question, as the caller relays it: a form's fields,
   *  or the absolute link where ITS user types a secret (never through the
   *  caller). */
  const questionOf = (meta: ChatMeta) => {
    const e = meta.elicitation;
    if (!e) return {};
    return {
      question:
        e.mode === "form"
          ? { id: e.elicitationId, mode: "form" as const, message: e.message, requestedSchema: e.requestedSchema, how: "Answer in your next ask_workflow_builder message on this chat (prose is fine), or decline in words." }
          : {
              id: e.elicitationId,
              mode: "url" as const,
              message: e.message,
              name: e.name,
              url: `${base}/${e.url}`,
              how: `Send your user to that link to enter the secret ${e.name} — never collect its value yourself — then tell the builder it is stored.`,
            },
    };
  };

  /** The chat's state after a wait: status, the turn(s) since `since`, the
   *  question, settledness. `lift` (ask): the one turn asked about comes as
   *  top-level `text` / `did` / `asked`, not a one-element list — `turns`
   *  only when a wake-up turn followed it within the wait. */
  const chatResult = async (meta: ChatMeta, view: ChatView, lift = false) => {
    const status = statusOf(meta);
    const error = status === "error" ? await deps.chat.turnError(meta.id, meta.currentTurn) : undefined;
    const settled = deps.chat.isSettled(meta.id);
    const [first, ...more] = view.turns;
    const { turns, ...rest } = view;
    const body = lift
      ? {
          ...(first ? { at: first.at, ...(first.text !== undefined ? { text: first.text } : {}), ...(first.did ? { did: first.did } : {}), ...(first.toolCalls ? { toolCalls: first.toolCalls } : {}), ...(first.asked ? { asked: first.asked } : {}) } : {}),
          ...(more.length ? { turns } : {}),
          ...rest,
        }
      : view;
    return {
      chat: meta.id,
      turn: meta.currentTurn,
      status,
      ...(error ? { error } : {}),
      ...body,
      ...questionOf(meta),
      settled,
      ...(status === "working"
        ? { hint: `The builder is still working: call read_workflow_builder_chat with chat "${meta.id}", since: ${view.turns[0]?.at ?? view.cursor}, wait: ${MAX_RUN_WAIT_MS} until status is not "working".` }
        : !settled
          ? { hint: "settled: false — a run the builder launched is still going and will wake it when done; read again later with wait to see what it did with the result." }
          : {}),
      ui: ui.chat(meta.id),
    };
  };

  const waitArg = (what: string) =>
    z
      .number()
      .int()
      .min(0)
      .max(MAX_RUN_WAIT_MS)
      .default(DEFAULT_CHAT_WAIT_MS)
      .describe(`Milliseconds to hold for ${what} (default ${DEFAULT_CHAT_WAIT_MS}, max ${MAX_RUN_WAIT_MS}). 0 returns at once.`);

  const tools: ToolSet = {
    ask_workflow_builder: tool({
      description:
        "Send a message to strut's workflow builder — an AI assistant that builds, edits, runs, debugs and schedules workflows here (it knows the step catalog, the YAML, the secrets' names). Say what you want in plain words, as to a colleague: 'make a workflow that …', 'schedule it every weekday at 9', 'why did the last run fail?', 'change the summary to be shorter'. Omit `chat` to start a new conversation; pass the `chat` from an earlier result to continue it (the builder remembers that conversation). " +
        "The call holds up to `wait` for the builder's turn to end and returns its reply: `text` (what it said), `did` (what it changed: workflows published, runs launched with their artifact links, schedules set), `status` — done | working (still going: read_workflow_builder_chat with wait) | asked (it has a question for you or your user — `question`; answer with your next message on this chat) | parked | error — and `settled` (false: a run it launched will wake it again later). " +
        "Links in results are absolute and shareable: an artifact link opens the file by itself (it carries its own read token).",
      inputSchema: z.object({
        message: z.string().min(1).describe("What to tell the builder. Plain prose; include the details it needs (inputs, schedule, what the output should be)."),
        chat: z.string().optional().describe("Continue this chat (from an earlier result). Omit for a new conversation."),
        title: z.string().max(120).optional().describe("A title for a NEW chat (shown in list_workflow_builder_chats). Default: the message's first line."),
        wait: waitArg("the builder's reply"),
      }),
      execute: async ({ message, chat, title, wait }) => {
        const sent = await deps.chat.send({ ...(chat ? { chatId: chat } : {}), message, ...(title ? { title } : {}), ...(deps.actor ? { actor: deps.actor } : {}), publicUrl: base });
        if ("error" in sent) {
          return sent.code === "busy"
            ? { error: sent.error, chat, status: "working" as const, hint: `Wait for the current turn: read_workflow_builder_chat with chat "${chat}" and wait: ${MAX_RUN_WAIT_MS}; then send again.` }
            : { error: sent.error };
        }
        await awaitIdle(sent.chatId, wait);
        const meta = (await deps.chatStore.getMeta(sent.chatId))!;
        const messages = await deps.chatStore.loadMessages(sent.chatId);
        return chatResult(meta, buildChatView(messages, { since: sent.at }), true);
      },
    }),

    read_workflow_builder_chat: tool({
      description:
        "Read a workflow builder chat as turns: what was said to it, what it answered (`text`), and what it DID (`did`: workflows, runs with artifact links, schedules) — never its internal tool traffic unless asked (`detail`). `since` is the `cursor` of your previous read (or a turn's `at`), so a long build is followed in small reads; `wait` holds while the builder is working. Use it to reconnect to a chat (its id from an earlier call or list_workflow_builder_chats) or to see what a slow turn produced.",
      inputSchema: z.object({
        chat: z.string().describe("The chat id."),
        since: z.number().int().min(0).default(0).describe("Read from this message index — the `cursor` of your previous read. 0 = from the start."),
        limit: z.number().int().positive().default(DEFAULT_CHAT_VIEW_LIMIT).describe(`At most this many turns, the newest kept (default ${DEFAULT_CHAT_VIEW_LIMIT}).`),
        detail: z
          .enum(["effects", "tools", "full"])
          .default("effects")
          .describe("effects (default): text + did. tools: + each tool call the builder made, with short previews. full: + each call's whole input and result (large)."),
        wait: z.number().int().min(0).max(MAX_RUN_WAIT_MS).default(0).describe(`Hold up to this many ms while the builder is working, then read (max ${MAX_RUN_WAIT_MS}; default 0).`),
      }),
      execute: async ({ chat, since, limit, detail, wait }) => {
        let meta = await deps.chatStore.getMeta(chat);
        if (!meta) return { error: `Chat "${chat}" not found — list_workflow_builder_chats lists what exists.` };
        meta = await deps.chat.reconcile(meta);
        if (wait) await awaitIdle(chat, wait);
        meta = (await deps.chatStore.getMeta(chat)) ?? meta;
        const messages = await deps.chatStore.loadMessages(chat);
        return chatResult(meta, buildChatView(messages, { since, limit, detail }));
      },
    }),

    list_workflow_builder_chats: tool({
      description:
        "The workflow builder chats on this strut, newest first: id, title, status (working | asked | parked | error | done), when it was last active, how many turns, who started it. Use it to find a conversation again — a long build outlives a session — or to see whether the builder is busy before starting another chat about the same workflow. By default only YOUR chats (the actor this connection carries); `mine: false` lists everyone's. Without an actor on the connection every chat is listed.",
      inputSchema: z.object({
        q: z.string().optional().describe("Words that must all appear in the title (case-insensitive)."),
        limit: z.number().int().positive().default(20).describe("At most this many (default 20)."),
        mine: z.boolean().default(true).describe("Only chats started by this connection's actor (default true; nothing is filtered when the connection carries no actor)."),
      }),
      execute: async ({ q, limit, mine }) => {
        const all = await Promise.all((await deps.chatStore.listChats()).map((m) => deps.chat.reconcile(m)));
        const words = (q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const matched = all
          .filter((m) => !mine || !deps.actor || m.createdBy === deps.actor || m.actor === deps.actor)
          .filter((m) => !words.length || words.every((w) => (m.title ?? "").toLowerCase().includes(w)))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const chats = matched.slice(0, limit).map((m) => ({
          chat: m.id,
          ...(m.title ? { title: m.title } : {}),
          status: statusOf(m),
          updatedAt: m.updatedAt,
          turns: m.currentTurn + 1,
          ...(m.createdBy ? { createdBy: m.createdBy } : {}),
          ...(m.elicitation ? { asked: m.elicitation.message } : {}),
          ui: ui.chat(m.id),
        }));
        return { chats, total: matched.length, ...(matched.length > chats.length ? { hint: `Showing ${chats.length} of ${matched.length}: pass q (title words) or raise limit.` } : {}) };
      },
    }),

    list_workflows: tool({
      description:
        "The workflows published here: name, description, category, active version, its schedules (each as a sentence with the next fire) and its last run (when, status) — plus a `ui` link. `query` filters (every word must hit the name, category or description). To build or change one, ask_workflow_builder.",
      inputSchema: z.object({
        query: z.string().optional().describe("Keywords; every word must hit the name, category or description. Omit to list everything (up to limit)."),
        limit: z.number().int().positive().default(DEFAULT_WORKFLOW_LIST_LIMIT).describe(`Max workflows (default ${DEFAULT_WORKFLOW_LIST_LIMIT}).`),
      }),
      execute: async ({ query, limit }) => {
        const listed = await listWorkflowEntries(deps.workspace, query, limit);
        const schedules = new Map<string, Array<{ id: string; summary: string; enabled: boolean; next: string | null }>>();
        if (deps.automations) {
          for (const a of await deps.automations.list().catch(() => [])) {
            const list = schedules.get(a.workflow) ?? [];
            list.push({ id: a.id, summary: a.summary, enabled: a.enabled, next: a.nextRunAt });
            schedules.set(a.workflow, list);
          }
        }
        const workflows = await Promise.all(
          listed.workflows.map(async (w) => {
            const lastAt = await deps.store.lastRunAt(w.name).catch(() => null);
            const last = lastAt ? await deps.store.getRunSummary(w.name, String(lastAt)).catch(() => null) : null;
            const lastRun = lastAt ? { runId: String(lastAt), at: new Date(lastAt).toISOString(), status: last?.status ?? "running" } : undefined;
            const s = schedules.get(w.name);
            return { ...w, ...(s?.length ? { schedules: s } : {}), ...(lastRun ? { lastRun } : {}), ui: ui.workflow(w.name) };
          }),
        );
        return { ...listed, workflows };
      },
    }),

    list_runs: tool({
      description:
        "A workflow's runs, newest first: id, status (running | success | error | cancelled), when it started, how long it took, what its model calls cost, who or what launched it, the error if any, and `artifacts` — the deliverables the run declared, as absolute links you can share (the usual way to hand a report or a file on). `since` (ISO time) and `status` filter. get_run reads one run's output.",
      inputSchema: z.object({
        workflow: z.string().describe("The workflow name."),
        limit: z.number().int().positive().default(20).describe("Max runs (default 20)."),
        status: z.enum(["running", "success", "error", "cancelled"]).optional().describe("Only runs with this status."),
        since: z.string().optional().describe("Only runs started at or after this ISO time (e.g. your last check)."),
      }),
      execute: async ({ workflow, limit, status, since }) => {
        const ids = await deps.store.listRuns(workflow);
        const sinceMs = since ? Date.parse(since) : NaN;
        const runs: Array<Record<string, unknown>> = [];
        for (const runId of ids) {
          if (runs.length >= limit) break;
          if (!Number.isNaN(sinceMs) && Number(runId) < sinceMs) break; // ids are ms timestamps, newest first
          const s = await deps.store.getRunSummary(workflow, runId);
          const st = s?.status ?? "running";
          if (status && st !== status) continue;
          runs.push({
            runId,
            status: st,
            startedAt: s?.startedAt ?? new Date(Number(runId)).toISOString(),
            ...(s ? { durationMs: s.durationMs } : {}),
            ...(s?.totals ? { cost: s.totals.cost, modelCalls: s.totals.modelCalls } : {}),
            ...(s?.automation ? { origin: "schedule", automation: s.automation.id } : s?.actor ? { actor: s.actor } : {}),
            ...(s?.error ? { error: s.error.message } : {}),
            ...(s?.job ? { job: s.job } : {}),
            ...(s && s.status === "success" ? await artifacts(runId, s.output, s.job).then((a) => (a ? { artifacts: a } : {})) : {}),
            ui: ui.workflow(workflow, runId),
          });
        }
        return { workflow, runs, total: ids.length };
      },
    }),

    get_run: tool({
      description:
        `One run: status, timing, cost, the error if any, its declared \`artifacts\` as shareable links, and its \`output\` with every top-level field over ${OUTPUT_FIELD_MAX_CHARS} chars HELD BACK as { $omitted: { chars, kind, preview } } and named in \`omitted\` — pass \`fields\` to get the ones you need whole. \`files: true\` lists every file the run wrote, each as a link. \`wait\` holds for a running run to finish (poll a detached run with it). This is the run's RESULT; to debug a failing run, ask_workflow_builder ("why did run <id> of <workflow> fail?") — it reads the step-by-step log.`,
      inputSchema: z.object({
        workflow: z.string().describe("The workflow name."),
        runId: z.string().describe("The run id (from list_runs, run_workflow or a chat's did.runs)."),
        fields: z.array(z.string()).optional().describe(`Output fields to include whole (from \`omitted\`); each cut at ${OUTPUT_FIELD_WHOLE_MAX_CHARS} chars with a note. For a non-object output the one field is "output".`),
        files: z.boolean().default(false).describe("Also list every file under the run's artifact directory (or its job's), each with a link."),
        wait: z.number().int().min(0).max(MAX_RUN_WAIT_MS).default(0).describe(`Hold up to this many ms for the run to finish first (max ${MAX_RUN_WAIT_MS}).`),
      }),
      execute: async ({ workflow, runId, fields, files, wait }) => {
        if (wait) {
          const deadline = Date.now() + wait;
          while (!(await deps.store.getRunSummary(workflow, runId)) && Date.now() < deadline) await sleep(Math.min(500, deadline - Date.now()));
        }
        const s = await deps.store.getRunSummary(workflow, runId);
        if (!s) {
          const ids = await deps.store.listRuns(workflow);
          if (!ids.includes(runId)) return { error: `Run "${runId}" of "${workflow}" not found.` };
          return { workflow, runId, status: "running", startedAt: new Date(Number(runId)).toISOString(), hint: `Still going: call again with wait: ${MAX_RUN_WAIT_MS}.`, ui: ui.workflow(workflow, runId) };
        }
        const trimmed = trimOutput(s.output, fields);
        const input = trimOutput(s.input);
        return {
          workflow,
          runId,
          status: s.status,
          startedAt: s.startedAt,
          finishedAt: s.finishedAt,
          durationMs: s.durationMs,
          ...(s.totals ? { cost: s.totals.cost, modelCalls: s.totals.modelCalls } : {}),
          ...(s.automation ? { origin: "schedule", automation: s.automation.id } : s.actor ? { actor: s.actor } : {}),
          ...(s.job ? { job: s.job } : {}),
          ...(s.error ? { error: s.error.message } : {}),
          ...(await artifacts(runId, s.output, s.job).then((a) => (a ? { artifacts: a } : {}))),
          input: input.output,
          ...(s.output !== undefined ? { output: trimmed.output } : {}),
          ...(trimmed.omitted ? { omitted: trimmed.omitted, hint: `Large output fields were held back: pass fields: [${trimmed.omitted.map((o) => JSON.stringify(o.field)).join(", ")}] for the ones you need.` } : {}),
          ...(files
            ? {
                files: (await deps.listFiles(runId, s.job).catch(() => [])).map((path) => ({
                  path,
                  url: fileUrl(s.job ? jobFileUrl(s.job, path) : `/artifacts/${encodeURIComponent(runId)}/${path}`),
                })),
              }
            : {}),
          ui: ui.workflow(workflow, runId),
        };
      },
    }),

    run_workflow: {
      ...deps.runWorkflow,
      description:
        `Run a published workflow now with an input and return its result — status, trimmed output (fields over ${OUTPUT_FIELD_MAX_CHARS} chars held back; get_run with \`fields\` for them), its artifacts as shareable links, and the runId. A run still going after the wait window returns { status: "running", detached: true, runId }: poll get_run with wait until its status is terminal. Use this for a workflow that exists (list_workflows); to make or change one, ask_workflow_builder.`,
      execute: async function* (args: unknown, opts: unknown) {
        const inner = (deps.runWorkflow.execute as (a: unknown, o: unknown) => unknown)(args, opts);
        // Trim the LAST yield (the result), pass the earlier ones through.
        let held: unknown;
        let any = false;
        if (inner && typeof inner === "object" && Symbol.asyncIterator in (inner as object)) {
          for await (const y of inner as AsyncIterable<unknown>) {
            if (any) yield held;
            held = y;
            any = true;
          }
        } else {
          held = await inner;
          any = true;
        }
        if (!any) return;
        if (isRecord(held) && "output" in held) {
          const { output, omitted } = trimOutput(held["output"]);
          yield { ...held, output, ...(omitted ? { omitted, hint: `Large output fields were held back: get_run with fields: [${omitted.map((o) => JSON.stringify(o.field)).join(", ")}].` } : {}) };
        } else yield held;
      },
    } as Tool,

    search_packages: tool({
      description:
        "Search the package STORE — PACKAGES people published for strut (workflows, steps, apps and Concept pages), listed by the package indexes this strut follows — before asking the builder to build an integration from scratch. Every word of `query` must match a package's name, description or publisher; empty lists everything (up to `limit`). " +
        "Each hit: { package, publisher, version, digest, description?, license?, requires?, index, detail? } — `detail` is what the release HOLDS, read off its archive: its `apps` (title, `can`), the counts of `workflows`, `steps` and `concepts`, the `secrets` it needs, `can: { spends, acts, code }` (whether running it reaches a model call, a step that acts on the world, or code — a reading of its files, not a check) and whether it has a `readme`. `peers` lists what the other struts on file have installed; `errors` an index or peer that could not be read. get_package reads one package's whole page. " +
        INSTALL_IS_A_PERSONS_ACT,
      inputSchema: z.object({
        query: z.string().default("").describe("Words to match, e.g. \"linear issues\"; empty lists everything."),
        limit: z.number().int().min(1).max(200).default(30),
      }),
      execute: async ({ query, limit }) => {
        if (!deps.packages) return { error: "This strut has no package indexes wired (ctx.services.packages)." };
        const found = await deps.packages.search(query, { limit });
        return { ...found, install: `A person installs a hit from the UI at ${base}/ — Packages, Find the name, Install — or opens ${base}/?install=<publisher/name>, which opens that dialog on the name.` };
      },
    }),

    get_package: tool({
      description:
        "One package's PAGE from the index that lists it: { package, publisher, key, urls, description?, releases (newest first), channels, readAt, detail?, detailError?, index, ui, install }. `detail` is the newest release READ OFF ITS ARCHIVE — `apps` (title, grants, `can`), `workflows` (each with its `inputs`, the step types it runs, its `grants`, `secrets`, `can`, `claims`), `steps` (effect, the secrets they read, the lint's findings), `concepts` (name, description, parent), the README (cut at " +
        `${README_BRIEF_CHARS} chars), the \`secrets\` the whole package needs, and \`can: { spends, acts, code }\` — whether running it reaches a model call (spends money), a step that acts on the world (effect: write), or code (exec, or the package's own TypeScript). ` +
        "`can` is a READING off the files — regexes over step sources, the YAML's step types — never a check or a sandbox; an install re-reads everything through the real parsers and re-verifies the package against its publisher's signed catalog. `detailError` says why there is no detail yet. " +
        INSTALL_IS_A_PERSONS_ACT +
        " `ui` is that door on this strut: the link opens its Packages dialog on the name.",
      inputSchema: z.object({
        package: z.string().describe("The package name, publisher/name (a hit's `package`)."),
        index: z.string().optional().describe("Read it from this followed index alone (its id, a hit's `index`)."),
      }),
      execute: async ({ package: name, index }) => {
        if (!deps.packages?.get) return { error: "This strut has no package indexes wired (ctx.services.packages)." };
        try {
          const page = briefPackagePage(await deps.packages.get(name, index ? { index } : {}));
          return {
            ...page,
            ui: `${base}/?install=${encodeURIComponent(name)}`,
            install: `A person installs it from the UI at ${base}/ — Packages, Find "${name}", Install — or opens the \`ui\` link, which opens that dialog on the name.`,
          };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),
  };
  return capToolResults(tools);
}
