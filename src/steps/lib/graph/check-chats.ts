import { z } from "zod";
import { defineStep, type StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";

/** The step that searches the user's chats: Peel's device read, answered by their Mac. */
const SEARCH = "sphinx/search";
const END = z.object({ ref_id: z.string(), name: z.string().optional(), type: z.string().optional(), owner: z.boolean().optional() });

/** The search a fact becomes: its value's name, and when it is about someone
 *  else, only what they wrote. Null when the name is too short to search for. */
export function chatQuery(f: { subject: { name?: string; owner?: boolean }; target: { name?: string } }): string | null {
  const name = (f.target.name ?? "").trim();
  if (name.replace(/[^\p{L}\p{N}]/gu, "").length < 3) return null;
  const value = /\s/.test(name) ? `"${name.replace(/"/g, "")}"` : name;
  const who = !f.subject.owner && f.subject.name ? f.subject.name.trim().split(/\s+/)[0] : undefined;
  return who && who.length >= 3 ? `${value} from:${who}` : value;
}

/**
 * A chat search's answer, counted: the matches since `since`, leaving out
 * the chats named in `exclude` (by name or chat id). Lines are
 * `[sender] <ISO date> (…): text` under `== Contact|Tribe 'name' (chat=id) ==`.
 */
export function countMatches(text: string, since: number, exclude: readonly string[] = []): { matched: boolean; recent: number } {
  if (/^No messages match/.test(text.trim())) return { matched: false, recent: 0 };
  const skip = new Set(exclude.map((x) => x.toLowerCase()));
  let skipping = false;
  let recent = 0;
  for (const line of text.split("\n")) {
    const heading = /^== (?:Contact|Tribe) '(.*)' \(chat=([^)]*)\)/.exec(line);
    if (heading) {
      skipping = skip.has(heading[1]!.toLowerCase()) || skip.has(heading[2]!.toLowerCase());
      continue;
    }
    if (skipping) continue;
    const at = /^\[[^\]]*\] (\S+) \(/.exec(line);
    if (at && Date.parse(at[1]!) >= since) recent++;
  }
  return { matched: true, recent };
}

export default defineStep({
  type: "graph/check-chats",
  effect: "read",
  description:
    "A memory fact's check (plans/memory-checks.md): does the fact come up in the user's chats lately? Searches them for the fact's value " +
    "(and, for a fact about someone else, what they wrote), and counts the messages since `since`. Found is indirect support; none is the " +
    "expected evidence missing; a search it cannot run (no Mac answering, no chat search here, a name too short) is unavailable. " +
    "Run by memory's checks, given the fact; `exclude_chats` leaves chats out (the agent's own, where what the user tells it is already evidence).",
  input: z.object({
    subject: END,
    edge_type: z.string(),
    target: END,
    text: z.string(),
    expects: z.string().optional(),
    since: z.string(),
    window_days: z.number(),
    exclude_chats: z.array(z.string()).optional().describe("Chats to leave out, by name or chat id."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    const c = ctx as StepContext<StrutCapabilities>;
    const q = chatQuery(cfg);
    if (!q || !c.registry?.[SEARCH]) return { unavailable: true };
    // Lazy: the runner loads the registry's steps.
    const { runSingleStep } = await import("../../../run-step.js");
    const run = await runSingleStep(SEARCH, c.registry, c.services, { config: { q, limit: 50 }, origin: "verify" });
    const text = typeof run.output === "string" ? run.output : undefined;
    // A Mac that has not answered (pending), or an error: nothing seen.
    if (run.status !== "success" || text === undefined || /^Nothing to search for/.test(text)) return { unavailable: true };
    const since = Date.parse(cfg.since);
    const { recent } = countMatches(text, since, cfg.exclude_chats ?? []);
    const day = new Date(since).toISOString().slice(0, 10);
    return recent > 0
      ? { supports: true, direct: false, content: `${recent} message${recent === 1 ? "" : "s"} mention ${q} since ${day}` }
      : { supports: false, content: `No messages mention ${q} since ${day}` };
  },
});
