/**
 * The ONE-LINE SUMMARY of an app version: what a publish changed, in plain
 * words, written by a small model AFTER the version is recorded
 * (`AppVersionInfo.summary`). Never part of the publish: a summarizer that
 * throws, times out or has no key leaves the summary empty.
 */
import type { AppManifest } from "./manifest.js";
import type { SecretsCapability } from "../capabilities.js";
import { resolveModel, type LlmAuth } from "../llm.js";

/** What the summarizer is told: `diff` is absent on the first version. */
export interface AppSummaryInput {
  name: string;
  version: string;
  manifest: AppManifest;
  diff?: string;
}

/** Returns the one line, or nothing; throws on failure. */
export type AppSummarizer = (input: AppSummaryInput) => Promise<string | undefined>;

export const SUMMARY_TIMEOUT_MS = 20_000;
const DIFF_MAX = 6000;
const FILE_MAX = 800;
const LINE_MAX = 160;
const SUMMARY_MAX = 140;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** A compact diff of two versions' source files: per changed file the lines
 *  removed and added (each file's hunks and the whole cut short). Files are
 *  path → text, null for one that is not text. */
export function appDiff(prev: Record<string, string | null>, next: Record<string, string | null>): string {
  const out: string[] = [];
  for (const path of [...new Set([...Object.keys(prev), ...Object.keys(next)])].sort()) {
    const a = prev[path], b = next[path];
    if (a === b) continue;
    if (a === undefined) out.push(`+++ ${path} (new file)`);
    else if (b === undefined) { out.push(`--- ${path} (deleted)`); continue; }
    else out.push(`~~~ ${path}`);
    const old = new Set((a ?? "").split("\n"));
    const cur = new Set((b ?? "").split("\n"));
    const lines = [
      ...[...old].filter((l) => l.trim() && !cur.has(l)).map((l) => `- ${clip(l.trim(), LINE_MAX)}`),
      ...[...cur].filter((l) => l.trim() && !old.has(l)).map((l) => `+ ${clip(l.trim(), LINE_MAX)}`),
    ];
    out.push(clip(lines.join("\n"), FILE_MAX));
  }
  return clip(out.filter(Boolean).join("\n"), DIFF_MAX);
}

/** The model's line, made one: first line, trimmed, no quotes or trailing period. */
export function oneLine(text: string): string {
  return clip(text.trim().split("\n")[0]!.trim().replace(/^["'`]+|["'`]+$/g, "").replace(/\.$/, ""), SUMMARY_MAX);
}

/** The default summarizer: a small fast model (`haiku`) through the same
 *  resolver as the llm step — the secrets boundary and the `llmAuth`
 *  gateway seam. The first version with no model reads "Initial version". */
export function llmSummarizer(deps: { secrets?: SecretsCapability; llmAuth?: LlmAuth }): AppSummarizer {
  return async ({ name, manifest, diff }) => {
    let model: any;
    try {
      ({ model } = await resolveModel({
        model: "haiku",
        ...(deps.secrets ? { secrets: deps.secrets } : {}),
        ...(deps.llmAuth ? { llmAuth: deps.llmAuth, auth: { kind: "chat" as const, chatId: `app-summary:${name}`, turn: 0 } } : {}),
      }));
    } catch (err) {
      if (diff === undefined) return "Initial version";
      throw err;
    }
    const { generateText } = await import("ai");
    const about = `App "${manifest.title}"${manifest.description ? ` — ${manifest.description}` : ""}.`;
    const prompt = diff === undefined
      ? `${about}\nIn ONE plain line of at most 100 characters, say what this app is and does. Reply with the line only.`
      : `${about}\nHere is what changed in a new version (- removed, + added):\n\n${diff || "(no source changes)"}\n\nIn ONE plain line of at most 100 characters, say what changed, like "Added an archive button to the task list and renamed the Settings tab". Reply with the line only.`;
    const { text } = await generateText({ model, prompt, maxOutputTokens: 100, abortSignal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS) });
    return oneLine(text) || undefined;
  };
}
