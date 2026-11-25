/**
 * Task groups' lifecycle (plans: task groups): a group is the tasks of one
 * type that share a `group` key (`task/reply`'s `group`). A type may MANAGE
 * its groups (`TaskType.groups`): then each key has a row with a status, an
 * owner and an append-only history, and the status moves along the type's
 * lifecycle, by the roles it names. Pure: no store, no clock.
 *
 * Roles are two: the group's `owner` (the first worker to send a page, read
 * from the worker's session) and `admin` (the staff door).
 */

export const GROUP_ROLES = ["owner", "admin"] as const;
export type GroupRole = (typeof GROUP_ROLES)[number];

/** One allowed move: from a status to another, by these roles. */
export interface GroupMove {
  from: string;
  to: string;
  by: GroupRole[];
  /** The move needs a reason. */
  reason?: "required";
}

export interface GroupLifecycle {
  statuses: string[];
  initial: string;
  moves: GroupMove[];
  /** Statuses in which a group takes no new tasks. */
  closed: string[];
}

/** What a type's `groups` says. Absent on the type: groups are only names. */
export interface GroupRule {
  /** `"default"`, or a lifecycle of the type's own. */
  lifecycle: "default" | GroupLifecycle;
  /** Hours without a new task after which an open group is marked idle (a hint only). Default 14 days. */
  idleHours?: number;
  /** What entering a status does to the group's answers' reviews: `ok` approves them (per-task pay follows), `rejected` rejects them. Off unless given. */
  onEnter?: Record<string, { review: "ok" | "rejected" }>;
  /** A template over the answer, `{title}|{author}`, that names its group when the run names none. */
  keyFrom?: string;
}

export const DEFAULT_IDLE_HOURS = 14 * 24;
export const GROUP_STATUS_MAX = 40;

export const DEFAULT_LIFECYCLE: GroupLifecycle = {
  statuses: ["open", "submitted", "accepted", "rejected", "reopened", "abandoned"],
  initial: "open",
  moves: [
    ...["open", "reopened"].flatMap((from): GroupMove[] => [
      { from, to: "submitted", by: ["owner", "admin"] },
      { from, to: "abandoned", by: ["admin"], reason: "required" },
    ]),
    { from: "submitted", to: "accepted", by: ["admin"] },
    { from: "submitted", to: "rejected", by: ["admin"], reason: "required" },
    { from: "submitted", to: "reopened", by: ["owner", "admin"] },
    { from: "submitted", to: "abandoned", by: ["admin"], reason: "required" },
    { from: "rejected", to: "submitted", by: ["owner", "admin"] },
    { from: "rejected", to: "reopened", by: ["owner", "admin"] },
    { from: "rejected", to: "abandoned", by: ["admin"], reason: "required" },
    { from: "accepted", to: "reopened", by: ["admin"] },
    { from: "abandoned", to: "reopened", by: ["admin"] },
  ],
  closed: ["submitted", "accepted", "rejected", "abandoned"],
};

export const lifecycleOf = (rule: GroupRule): GroupLifecycle => (rule.lifecycle === "default" ? DEFAULT_LIFECYCLE : rule.lifecycle);

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A type's `groups` as saved: validated, with a refusal that says what is wrong. */
export function groupRuleOf(raw: unknown): GroupRule | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) throw new Error("groups is an object: { lifecycle?, idleHours?, onEnter?, keyFrom? }");
  for (const k of Object.keys(raw)) if (!["lifecycle", "idleHours", "onEnter", "keyFrom"].includes(k)) throw new Error(`groups has lifecycle, idleHours, onEnter and keyFrom, not ${k}`);
  const out: GroupRule = { lifecycle: "default" };
  const lc = raw["lifecycle"];
  if (lc !== undefined && lc !== "default") {
    if (!isRecord(lc)) throw new Error('groups.lifecycle is "default" or { statuses, initial, moves, closed? }');
    const statuses = lc["statuses"];
    if (!Array.isArray(statuses) || !statuses.length || !statuses.every((s) => typeof s === "string" && /^[a-z][a-z0-9_-]*$/.test(s) && s.length <= GROUP_STATUS_MAX)) {
      throw new Error("groups.lifecycle.statuses is a list of lowercase names");
    }
    if (new Set(statuses).size !== statuses.length) throw new Error("groups.lifecycle.statuses names each status once");
    const known = new Set(statuses as string[]);
    const initial = lc["initial"];
    if (typeof initial !== "string" || !known.has(initial)) throw new Error("groups.lifecycle.initial is one of its statuses");
    if (!Array.isArray(lc["moves"])) throw new Error("groups.lifecycle.moves is a list of { from, to, by, reason? }");
    const moves = lc["moves"].map((m): GroupMove => {
      if (!isRecord(m) || typeof m["from"] !== "string" || typeof m["to"] !== "string" || !known.has(m["from"]) || !known.has(m["to"])) throw new Error("each move is { from, to, by } between its statuses");
      const by = m["by"];
      if (!Array.isArray(by) || !by.length || !by.every((r) => (GROUP_ROLES as readonly unknown[]).includes(r))) throw new Error(`a move's by is a list of ${GROUP_ROLES.join(" and ")}`);
      if (m["reason"] !== undefined && m["reason"] !== "required") throw new Error('a move\'s reason is "required" or left out');
      return { from: m["from"], to: m["to"], by: [...new Set(by as GroupRole[])], ...(m["reason"] ? { reason: "required" as const } : {}) };
    });
    const closed = lc["closed"] ?? [];
    if (!Array.isArray(closed) || !closed.every((s) => typeof s === "string" && known.has(s))) throw new Error("groups.lifecycle.closed is a list of its statuses");
    out.lifecycle = { statuses: statuses as string[], initial, moves, closed: closed as string[] };
  }
  const idle = raw["idleHours"];
  if (idle !== undefined) {
    if (typeof idle !== "number" || !Number.isFinite(idle) || idle <= 0 || idle > 24 * 365) throw new Error("groups.idleHours is a number of hours above 0");
    out.idleHours = idle;
  }
  const onEnter = raw["onEnter"];
  if (onEnter !== undefined) {
    if (!isRecord(onEnter)) throw new Error("groups.onEnter is { <status>: { review: ok | rejected } }");
    const known = new Set(lifecycleOf(out).statuses);
    const o: NonNullable<GroupRule["onEnter"]> = {};
    for (const [status, v] of Object.entries(onEnter)) {
      if (!known.has(status)) throw new Error(`groups.onEnter names ${status}, which is not a status`);
      if (!isRecord(v) || (v["review"] !== "ok" && v["review"] !== "rejected")) throw new Error("groups.onEnter's value is { review: ok | rejected }");
      o[status] = { review: v["review"] };
    }
    if (Object.keys(o).length) out.onEnter = o;
  }
  const keyFrom = raw["keyFrom"];
  if (keyFrom !== undefined) {
    if (typeof keyFrom !== "string" || !/\{[A-Za-z0-9_.-]+\}/.test(keyFrom) || keyFrom.length > 200) throw new Error("groups.keyFrom is a template with fields in braces, like {title}|{author}");
    out.keyFrom = keyFrom;
  }
  return out;
}

/** Why `role` cannot move a group from `from` to `to`, or what the move needs; undefined when it may. */
export function moveProblem(rule: GroupRule, from: string, to: string, role: GroupRole, reason: string | undefined): { code: "bad_move" | "reason_required"; message: string } | undefined {
  const lc = lifecycleOf(rule);
  if (!lc.statuses.includes(to)) return { code: "bad_move", message: `${to} is not a status of this lifecycle (${lc.statuses.join(", ")})` };
  const moves = lc.moves.filter((m) => m.from === from && m.to === to);
  if (!moves.length) return { code: "bad_move", message: `a group ${from} cannot become ${to}` };
  const m = moves.find((x) => x.by.includes(role));
  if (!m) return { code: "bad_move", message: `a group ${from} becomes ${to} by ${moves[0]!.by.join(" or ")}, not by ${role}` };
  if (m.reason === "required" && !reason?.trim()) return { code: "reason_required", message: `moving a group to ${to} says why` };
  return undefined;
}

/** The statuses `role` can move a group to from `from`, with whether a reason is needed. */
export const movesFor = (rule: GroupRule, from: string, role: GroupRole): Array<{ to: string; reason: boolean }> =>
  lifecycleOf(rule)
    .moves.filter((m) => m.from === from && m.by.includes(role))
    .map((m) => ({ to: m.to, reason: m.reason === "required" }));

export const isClosed = (rule: GroupRule, status: string): boolean => lifecycleOf(rule).closed.includes(status);

/** A group key from a template over an answer: `{title}|{author}` with the
 *  answer's fields (dots reach into objects). Undefined when a field is
 *  missing or empty, or the key is too long. Trimmed and single-spaced. */
export function keyFromAnswer(template: string, answer: unknown, max: number): string | undefined {
  let missing = false;
  const key = template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (_m, path: string) => {
    let v: unknown = answer;
    for (const p of path.split(".")) v = isRecord(v) ? v[p] : undefined;
    const s = typeof v === "string" || typeof v === "number" ? String(v).replace(/\s+/g, " ").trim() : "";
    if (!s) missing = true;
    return s;
  });
  return missing || !key.trim() || key.length > max || /[\r\n]/.test(key) ? undefined : key;
}
