// What a run of the `dream` workflow returns (its `result` pack), and how the
// page reads it. Pure: no React, so the tests read it too.

export interface LessonTurn {
  session: string;
  turn: number;
  excerpt: string;
  why?: string;
  against: boolean;
  at: string;
}

export interface Lesson {
  id: string;
  title: string;
  text: string;
  against: number;
  for: number;
  evidence: LessonTurn[];
}

export interface DreamOutput {
  text?: string;
  lessons?: Lesson[];
  turns?: number;
  more?: boolean;
  cost?: number;
}

/** The report's sections, in the order the workflow's prompt asks for them. */
const TITLES: Record<string, string> = { LESSONS: "Lessons", FACTS: "Facts changed", PAGES: "Pages changed", "LEFT ALONE": "Left alone" };
const HEAD = /^\**(LESSONS|FACTS|PAGES|LEFT ALONE)\**:\**\s*(.*)$/;
const none = (l: string) => /^\(?none\.?\)?$/i.test(l);

/** The report split into its sections, each line an item; null when it is not shaped that way. */
export function sectionsOf(text: string): Array<{ title: string; lines: string[] }> | null {
  const out: Array<{ title: string; lines: string[] }> = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const head = HEAD.exec(line);
    if (head) {
      out.push({ title: TITLES[head[1]!]!, lines: [] });
      if (head[2] && !none(head[2])) out[out.length - 1]!.lines.push(head[2]);
      continue;
    }
    const item = line.replace(/^[-*•]\s+/, "");
    if (!item || none(item)) continue;
    if (!out.length) return null;
    out[out.length - 1]!.lines.push(item);
  }
  return out.length ? out : null;
}

export function costText(cost: unknown): string {
  const n = Number(cost);
  if (!Number.isFinite(n) || n <= 0) return "no model cost";
  return n < 0.01 ? "under $0.01" : `$${n.toFixed(2)}`;
}

export function whenText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
