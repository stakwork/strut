// The Why sheet: one piece of paper beside a goal's map. Top to bottom it
// reads why (the brief), who it is for (the stories) and what must be true
// (each story's requirements). Picking a story or a requirement lights the
// work that answers it on the map, and a thread runs to each (App draws
// them, from the element marked `data-thread`); picking work on the map
// lights what it is for here.
import { useState } from "react";
import type { Plan } from "../lib/plan";
import { parseStory, workFor, type Why } from "../lib/why";

export interface Trace {
  story: string | null;
  requirement: string | null;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function WhySheet({
  plan,
  why,
  goal,
  trace,
  onTrace,
  serving,
  onClose,
  onScroll,
}: {
  plan: Plan;
  why: Why;
  goal: string;
  trace: Trace;
  onTrace: (t: Trace) => void;
  /** The requirements the work picked on the map answers; null when none is picked. */
  serving: Set<string> | null;
  onClose: () => void;
  onScroll: () => void;
}) {
  const [whole, setWhole] = useState(false);
  const brief = why.brief[goal] ?? "";
  const stories = why.byGoal[goal] ?? [];
  return (
    <aside className={`sb-why${serving ? " sb-why-rev" : ""}`} onScroll={onScroll} data-testid="board-why">
      <header className="sb-why-head">
        <span className="sb-meta">Why</span>
        <button type="button" className="sb-btn" aria-label="Close" onClick={onClose}>
          ✕
        </button>
        <h2>{plan.cards[goal]!.title}</h2>
      </header>
      {brief ? (
        <>
          <p className={`sb-brief${whole ? "" : " sb-clamp"}`}>{brief}</p>
          {brief.length > 280 && (
            <button type="button" className="sb-link sb-quiet" onClick={() => setWhole((v) => !v)}>
              {whole ? "Show less" : "Read the whole brief"}
            </button>
          )}
        </>
      ) : (
        <p className="sb-brief">No brief has been written for this yet.</p>
      )}
      <span className="sb-meta sb-why-sec">Who it is for · {count(stories.length, "story", "stories")}</span>
      {stories.map((id) => {
        const s = why.stories[id]!;
        const parts = parseStory(s.text);
        const work = workFor(why, id).length;
        const bare = s.requirements.filter((r) => !why.answers[r]?.length).length;
        const lit = !!serving && s.requirements.some((r) => serving.has(r));
        const open = serving ? lit : trace.story === id;
        const from = open && !serving && !trace.requirement;
        return (
          <div key={id} className={`sb-story${open ? " sb-open" : ""}${lit ? " sb-story-lit" : ""}${s.accepted ? "" : " sb-pencil"}`}>
            <button type="button" className="sb-story-head" aria-expanded={open} {...(from ? { "data-thread": "from" } : {})} onClick={() => onTrace({ story: id, requirement: null })}>
              {parts ? (
                <>
                  <span className="sb-who">As {/^[aeiou]/i.test(parts.who) ? "an" : "a"} {parts.who}</span>
                  <span className="sb-want">{parts.want}</span>
                  {parts.why && <span className="sb-sothat">so that {parts.why}</span>}
                </>
              ) : (
                <span className="sb-want">{s.text || "A story with no words yet"}</span>
              )}
              <span className="sb-cov">
                <span>{count(s.requirements.length, "requirement")}</span>
                {work ? <span>{count(work, "feature")}</span> : <span className="sb-need">no feature answers it yet</span>}
                {work > 0 && bare > 0 && <span className="sb-need">{bare} not answered</span>}
                {!s.accepted && <span>proposed</span>}
              </span>
            </button>
            {open && (
              <ul className="sb-reqs">
                {s.requirements.map((r) => {
                  const q = why.requirements[r]!;
                  const n = why.answers[r]?.length ?? 0;
                  const on = serving ? serving.has(r) : trace.requirement === r;
                  return (
                    <li key={r}>
                      <button
                        type="button"
                        className={`sb-req${on ? " sb-req-on" : ""}${q.accepted ? "" : " sb-pencil"}`}
                        {...(on ? { "data-thread": "from" } : {})}
                        onClick={() => onTrace({ story: id, requirement: trace.requirement === r && !serving ? null : r })}
                      >
                        <i className={`sb-dot${q.accepted ? " sb-s-done" : ""}`} />
                        <span className="sb-req-text">{q.text}</span>
                        <small>
                          <span>{q.accepted ? "accepted" : "proposed"}</span>
                          {n ? <span>{count(n, "feature")}</span> : <span className="sb-need">no feature answers this yet</span>}
                        </small>
                      </button>
                    </li>
                  );
                })}
                {!s.requirements.length && <li className="sb-quiet">No requirements written yet.</li>}
              </ul>
            )}
          </div>
        );
      })}
      {!stories.length && <p className="sb-brief">No stories have been written for this yet. Ask Jamie to write them.</p>}
    </aside>
  );
}
