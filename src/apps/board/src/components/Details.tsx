// What the graph holds on a picked card, and a person's hand on it: press a
// line to rewrite it, pick a status, set a date. Each change is one
// `graph/edit-node` on the card's own node, as the viewer; what was typed
// stays on screen until the plan is read again.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Card, Roles } from "../lib/plan";

/** Write properties on a node; the reason it was not written, or null. */
export type Save = (id: string, set: Record<string, unknown>, remove?: string[]) => Promise<string | null>;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const day = (v: unknown) => {
  const d = typeof v === "string" || typeof v === "number" ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};
const shortDay = (d: Date) => d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
/** "IN_PROGRESS" → "In progress". */
const words = (status: string) => {
  const s = status.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** A line of text a person rewrites in place: press it, type, Enter (⌘Enter on a long one) or click away to keep, Escape to drop. */
export function Editable({ value, placeholder, long, className, label, onSave }: { value: string; placeholder: string; long?: boolean; className?: string; label: string; onSave: (next: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = box.current;
    if (draft === null || !el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);
  if (draft === null) {
    return (
      <button type="button" className={`sb-edit ${className ?? ""}${value ? "" : " sb-empty"}`} aria-label={`${label}: press to edit`} onClick={() => setDraft(value)}>
        {value || placeholder}
      </button>
    );
  }
  const keep = () => {
    const next = draft.trim();
    setDraft(null);
    if (next !== value) onSave(next);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key === "Escape") setDraft(null);
    if (e.key === "Enter" && !e.nativeEvent.isComposing && (!long || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      keep();
    }
  };
  return <textarea ref={box} autoFocus rows={1} className={`sb-edit sb-editing ${className ?? ""}`} aria-label={label} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={keep} onKeyDown={onKey} />;
}

/** A card's own details: title, status, description, dates, and whether it is blocked. */
export function CardFacts({ card, roles, save }: { card: Card; roles: Roles; save: Save }) {
  // What was just typed, shown until the plan is read again and carries it.
  const [typed, setTyped] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setTyped({});
    setError(null);
  }, [card.id, card.props]);
  const p = { ...card.props, ...typed };
  const write = async (set: Record<string, unknown>, remove: string[] = []) => {
    setError(null);
    const before = typed;
    setTyped({ ...typed, ...set, ...Object.fromEntries(remove.map((k) => [k, undefined])) });
    const problem = await save(card.id, set, remove);
    if (problem) {
      setTyped(before);
      setError(problem);
    }
  };
  const status = str(p["status"]);
  const statuses = roles.statuses[card.role];
  const options = status && !statuses.some((s) => s.toLowerCase() === status.toLowerCase()) ? [status, ...statuses] : statuses;
  const dueKey = roles.due[card.role];
  const due = dueKey ? day(p[dueKey]) : null;
  const created = day(p["created_at"]) ?? day(p["date_added_to_graph"]);
  const completed = day(p["completed_at"]);
  const blocked = p["blocked"] === true;
  return (
    <>
      <Editable className="sb-edit-title" label="Title" value={str(p["name"]) || card.title} placeholder="Untitled" onSave={(name) => name && void write({ name })} />
      <Editable long className="sb-edit-text" label="Description" value={str(p["description"])} placeholder="Add a description" onSave={(description) => void (description ? write({ description }) : write({}, ["description"]))} />
      <dl className="sb-facts">
        <dt>Status</dt>
        <dd>
          <select aria-label="Status" value={options.find((s) => s.toLowerCase() === status.toLowerCase()) ?? ""} onChange={(e) => void write({ status: e.target.value })}>
            {!status && <option value="">Not set</option>}
            {options.map((s) => (
              <option key={s} value={s}>
                {words(s)}
              </option>
            ))}
          </select>
        </dd>
        {dueKey && (
          <>
            <dt>Due</dt>
            <dd>
              <input type="date" aria-label="Due date" value={due ? due.toISOString().slice(0, 10) : ""} onChange={(e) => void (e.target.value ? write({ [dueKey]: new Date(e.target.value).toISOString() }) : write({}, [dueKey]))} />
            </dd>
          </>
        )}
        {card.role === "work" && (
          <>
            <dt>Blocked</dt>
            <dd>
              <label className="sb-check">
                <input type="checkbox" checked={blocked} onChange={(e) => void (e.target.checked ? write({ blocked: true }) : write({ blocked: false }, ["blocked_reason"]))} />
                {blocked ? "Yes" : "No"}
              </label>
            </dd>
          </>
        )}
        {created && (
          <>
            <dt>Written</dt>
            <dd>
              {shortDay(created)}
              {card.by ? ` · by ${card.by === "agent" ? "an agent" : "a person"}` : ""}
            </dd>
          </>
        )}
        {completed && (
          <>
            <dt>Done</dt>
            <dd>{shortDay(completed)}</dd>
          </>
        )}
      </dl>
      {blocked && <Editable long className="sb-edit-text" label="Why it is blocked" value={str(p["blocked_reason"])} placeholder="Say what blocks it" onSave={(blocked_reason) => void (blocked_reason ? write({ blocked_reason }) : write({}, ["blocked_reason"]))} />}
      {error && <p className="sb-need">Not saved: {error}</p>}
    </>
  );
}
