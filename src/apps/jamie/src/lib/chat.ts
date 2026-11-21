// The chat's pure parts — tested by src/apps/jamie.test.ts: the turn's
// context (the time where the person is, where the reply is read), the
// list's day groups, new conversation ids, what a refused send means, the
// composer's "/Concept" trigger and its model picker. Nothing here imports
// React or the kit.

import type { ConversationListItem, ModelCatalog } from "./types";

/** Where this conversation is read, as the orchestrator's `context.where`
 *  says it (plans/jamie-app.md §1.3): what the person sees beside the reply. */
export const WHERE =
  "In the assistant app: your reply is read in full, and each job you start shows under it as a card the person opens — its reply, what it made, its checks. ";

/** "Wed 4 Nov 2026, 14:02, Europe/London. ": the time where the person is,
 *  as Hive writes it (`orchestratorContextLine`) — UTC when the zone is
 *  missing or not one. */
export function timeLine(now: Date, timeZone?: string): string {
  const zone = timeZone?.trim() || "UTC";
  const format = (tz: string) =>
    new Intl.DateTimeFormat("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: tz,
    }).format(now);
  try {
    return `${format(zone)}, ${zone}. `;
  } catch {
    return `${format("UTC")}, UTC. `;
  }
}

/** A closing sentence that asks the person for something: a question, a
 *  request ("I'd also need the names of your shops."), or one that tells
 *  them how to answer ("Reply \"yes\" with those, or change anything."). */
const ASKS = /\?["\u201d')\]]*$|^(also |and |then |so |just )?(please )?(send|tell|let me know|reply|answer|attach|confirm|share|upload)\b|\b(i|i'd|i would|we) (also )?need\b/i;

/**
 * The reply as Jamie shows it above the turn's `ask`: the model is told the
 * question shows apart, under the reply, yet often asks it at the end of
 * `text` too, in other words. So when there is an `ask`, the reply's last
 * paragraph loses its closing sentences that ask for something, and the
 * question shows once, in its box. A list, a paragraph left with nothing,
 * or a reply that would be empty is left as it is.
 */
export function withoutAsk(text: string, ask: string | undefined): string {
  if (!ask?.trim()) return text;
  const paragraphs = text.trimEnd().split(/\n\s*\n/);
  const last = paragraphs.at(-1) ?? "";
  if (/^\s*([-*+]|\d+[.)])\s/m.test(last)) return text;
  const sentences = last.match(/[^.!?]+[.!?]+["\u201d')\]]*\s*|[^.!?]+$/g) ?? [last];
  let keep = sentences.length;
  while (keep > 0 && ASKS.test(sentences[keep - 1]!.trim())) keep--;
  if (keep === sentences.length) return text;
  const rest = sentences.slice(0, keep).join("").trim();
  const out = [...paragraphs.slice(0, -1), ...(rest ? [rest] : [])].join("\n\n").trimEnd();
  return out || text;
}

/** The orchestrator's `input.context` for a turn sent now. */
export function turnContext(now: Date, timeZone?: string): { line: string; where: string; timeZone?: string } {
  const zone = timeZone?.trim();
  return { line: timeLine(now, zone) + WHERE, where: WHERE, ...(zone ? { timeZone: zone } : {}) };
}

/** A local day's key: the list groups by the viewer's own days. */
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** "Today", "Yesterday", or a short date ("Oct 13"; with the year when not this one). */
export function dayLabel(date: Date, now: Date): string {
  if (dayKey(date) === dayKey(now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(date) === dayKey(yesterday)) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}

export interface DayGroup<T> {
  key: string;
  label: string;
  items: T[];
}

/** Rows (newest first) under their day's label, in the order they came. */
export function groupByDay<T extends Pick<ConversationListItem, "updatedAt">>(items: readonly T[], now: Date): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const item of items) {
    const date = new Date(item.updatedAt);
    const key = Number.isNaN(date.getTime()) ? "?" : dayKey(date);
    const last = groups[groups.length - 1];
    if (last?.key === key) last.items.push(item);
    else groups.push({ key, label: key === "?" ? "Earlier" : dayLabel(date, now), items: [item] });
  }
  return groups;
}

/** A new conversation's id: the viewer's own namespace, `<viewer>/<12 hex>`
 *  — what `conversation/fork` mints, and what a first-party page's turn
 *  opens as itself. */
export function newConversationId(viewer: string, random: () => number = Math.random): string {
  let hex = "";
  for (let i = 0; i < 12; i++) hex += Math.floor(random() * 16).toString(16);
  return `${viewer}/${hex}`;
}

/** Is `id` the viewer's own (`<viewer>`, `<viewer>/…`)? */
export function isOwn(id: string, viewer: string | undefined): boolean {
  return !!viewer && (id === viewer || id.startsWith(`${viewer}/`));
}

/** May the viewer add to this conversation (plans/jamie-app.md §2.2)? Their
 *  own id, one they took a turn in, or a shared one. An admin reads anyone's
 *  (§2.3) and continues only these: the rest is read-only, with Continue here. */
export function mayContinue(view: { conversation: Pick<ConversationListItem, "shared">; participants: readonly string[] }, session: string, viewer: string | undefined): boolean {
  return isOwn(session, viewer) || (!!viewer && view.participants.includes(viewer)) || !!view.conversation.shared;
}

/** Whose a conversation of an admin's Everyone is, as it says it: the
 *  person whose id it is under (`<actor>/…`: a fork's first turns are its
 *  source's), else who started it (Hive's bare ids, a host's), else where a
 *  host's is continued. */
export function ownerLabel(item: Pick<ConversationListItem, "id" | "startedBy" | "host">): string {
  const under = !item.host && item.id.includes("/") ? item.id.slice(0, item.id.indexOf("/")) : undefined;
  return under ?? item.startedBy ?? (item.host ? hostPlace(item.host) : "");
}

/** Opened from an admin's Everyone as a reader (`everyone`), unless it is
 *  plainly the viewer's own: their id, or a conversation they started. */
export function readsAsAdmin(item: Pick<ConversationListItem, "id" | "startedBy">, viewer: string | undefined): boolean {
  return !isOwn(item.id, viewer) && !(viewer && item.startedBy === viewer);
}

/** The line every viewer reads under the composer (plans/jamie-app.md §2.3).
 *  Recommended, not yet ruled: to drop it, delete this and the one line in
 *  Thread.tsx that shows it (`data-testid="admins-read"`). */
export const ADMINS_READ = "Admins on this server can read conversations with Jamie.";

/** What a refused send means to the person. */
export type SendRefusal = { kind: "busy"; text: string } | { kind: "not-yours"; text: string } | { kind: "error"; text: string };

export const BUSY_NOTICE = "Still on your last message — send this once the reply is in.";
/** A person may continue a conversation they took a turn in, or a shared
 *  one (plans/jamie-app.md §2.2): someone who only read one while it was
 *  shared, and it has since been unshared, is refused. */
export const NOT_YOURS_NOTICE = "This is someone else's conversation, and it is no longer shared: you can't add to it. Start a new chat to carry on.";

/** What a link to a conversation the viewer may not read says. Strut answers
 *  one that does not exist and one that is not theirs alike, so it says both. */
export const NOT_SHARED_NOTICE = "This chat isn't shared with you, or it no longer exists. Ask whoever sent you the link to share it with the team.";

/** A refused read (`conversation/get`) as the person reads it: the notice
 *  for a conversation that is not theirs to read, else null (another error,
 *  shown as it is). */
export function readRefusal(message: string): string | null {
  return /\bNo conversation ".*" \(or not yours to read\)/.test(message) ? NOT_SHARED_NOTICE : null;
}

export function sendRefusal(message: string): SendRefusal {
  if (/\bsession_busy:/.test(message) || /\bjob_busy:/.test(message)) return { kind: "busy", text: BUSY_NOTICE };
  if (/\bconversation_not_yours:/.test(message)) return { kind: "not-yours", text: NOT_YOURS_NOTICE };
  return { kind: "error", text: message };
}

/** A turn still going: no settled status yet. */
export function inFlight(status: string | undefined): boolean {
  return status === "running" || status === "paused" || status === "pending" || status === "cancelling";
}

/** A wake turn the orchestrator answered with `[silent]`: nothing to show. */
export function silentReply(text: string | undefined): boolean {
  return (text ?? "").trim() === "[silent]";
}

// ── the composer's "/Concept" ──────────────────────────────────────────────

export interface SlashTrigger {
  /** Where the "/" is. */
  start: number;
  /** What was typed after it, up to the caret (no whitespace). */
  query: string;
}

/** An in-progress "/concept" before the caret: a "/" that begins a word,
 *  with no whitespace up to the caret — never one inside a path or a URL
 *  (Hive's `detectSlashTrigger`). */
export function detectSlash(text: string, caret: number): SlashTrigger | null {
  const before = text.slice(0, caret);
  const m = /(?:^|\s)\/(\S*)$/.exec(before);
  if (!m) return null;
  return { start: before.length - m[1]!.length - 1, query: m[1]! };
}

/** The "/query" replaced with "/Concept Name ", and the caret after it. */
export function insertSlash(text: string, trigger: SlashTrigger, name: string): { text: string; caret: number } {
  const end = trigger.start + 1 + trigger.query.length;
  const before = text.slice(0, trigger.start);
  const inserted = `/${name} `;
  return { text: before + inserted + text.slice(end), caret: before.length + inserted.length };
}

// ── the composer's model picker ────────────────────────────────────────────

/** The picker's choices: "Default" (`""`: no `params.model`, so the turn
 *  runs on the deployment's default), then each model `llm/models` says
 *  people may pick — the deployment's own list, when it has one. */
export function modelChoices(catalog: ModelCatalog | undefined): Array<{ value: string; name: string }> {
  const listed = (catalog?.models ?? []).filter((m) => m.available);
  return [{ value: "", name: "Default" }, ...listed.map((m) => ({ value: m.name, name: m.alias ? `${m.alias} · ${m.provider}` : m.name }))];
}

/** The model a turn sends: the remembered pick while `llm/models` still
 *  lists it, else `""` — Default, no `params.model` (an admin took it off
 *  the list, or its key went). The pick is kept, so it comes back if the
 *  model does. Until the list is read the pick stands: the gateway still
 *  refuses a model it does not allow. */
export function sentModel(pick: string, catalog: ModelCatalog | undefined): string {
  if (!pick || !catalog) return pick;
  return catalog.models.some((m) => m.available && m.name === pick) ? pick : "";
}

/** What a turn the page launches carries for its model: `{ params: { model }
 *  }`, or nothing for Default. A person's message and the job turns the cards
 *  send (Fix, a captcha's answer, a stored secret) alike — and the jobs a
 *  message starts get its model from strut — so a conversation and its jobs
 *  run on one model. */
export function modelParams(model: string): { params?: { model: string } } {
  return model ? { params: { model } } : {};
}

/** Where a host's conversation is continued, as a person reads it: a Sphinx
 *  tribe for the Sphinx daemon's, else the host's name. */
export function hostPlace(host: string): string {
  return host === "sphinx" ? "a Sphinx tribe" : host;
}
