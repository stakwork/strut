// strut/board: the plan as a map on a paper desk. The whole page is the
// canvas. It opens on the home map — the initiatives in progress ringed
// round the centre, the rest one click away — and each initiative opens
// into its own map: a road left to right through its milestones, each
// milestone's features in a plot beside it, and the brainstorms about its
// cards on a shelf under the gate. Green is built, a pulsing blue outline
// is being built now, a dashed outline is an empty plot.
//
// "Needs you" is the viewer's own: the changes waiting on their yes or no,
// and the questions still open. "Working now" shows only while one of their
// jobs is running.
//
// Positions come from the plan (lib/map.ts), never from storage. The camera
// lives in a ref and writes the world's transform directly, so panning and
// zooming re-render nothing.
import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useAppState } from "@strut/kit";
import "./board.css";
import { useAdd, useAddAsk, useBrainstorms, useEdit, useLiveJobs, usePlan, useWaiting, useWhy } from "./lib/read";
import { goalOf, HIVE_PLAN, openingGoals, progress, type Card, type Plan, type Role, type State } from "./lib/plan";
import { CardFacts, Editable } from "./components/Details";
import { asksIn, jobsByCard, openByGoal, type Ask, type Brainstorms } from "./lib/brainstorm";
import { boundsOf, freeMap, goalMap, homeMap, type MapLayout, type Spot } from "./lib/map";
import { JamieDock } from "./components/Jamie";
import { WhySheet, type Trace } from "./components/WhySheet";
import { workFor } from "./lib/why";

const STATE_WORD: Record<State, string> = { idle: "Not started", prog: "In progress", done: "Done", block: "Blocked" };
const ROLE_WORD: Record<Role, string> = { goal: "Initiative", group: "Milestone", work: "Feature" };
const HOME = "all";
type Menu = "boards" | "needs" | "live" | null;

interface Camera {
  x: number;
  y: number;
  z: number;
}

/** A card's small line: what it is, its state, how much under it is done. */
function metaOf(plan: Plan, c: Card): string {
  const p = progress(plan, c.id);
  const done = p.total ? ` · ${p.done} of ${p.total} done` : "";
  if (c.role === "goal") return `${ROLE_WORD.goal}${c.status ? ` · ${c.status.replace(/_/g, " ")}` : ""}${done}`;
  return `${ROLE_WORD[c.role]} · ${STATE_WORD[c.state]}${done}`;
}

const who = (by: "person" | "agent" | null) => (by === "agent" ? "an agent" : by === "person" ? "a person" : null);

/** A question's options, and one level of what each leads to. */
function Options({ ask, b }: { ask: Ask; b: Brainstorms }) {
  if (!ask.options.length) return <p>No options yet.</p>;
  return (
    <ul className="sb-opts">
      {ask.options.map((id) => {
        const o = b.choices[id]!;
        return (
          <li key={id} className={`sb-opt sb-opt-${o.state}`}>
            <strong>{o.text}</strong>
            <small>
              {o.state === "chosen" ? "Chosen" : o.state === "rejected" ? "Not chosen" : "Open"}
              {who(o.by) ? ` · by ${who(o.by)}` : ""}
            </small>
            {o.asks.map((q) => (
              <small key={q}>Leads to: {b.asks[q]!.text}</small>
            ))}
          </li>
        );
      })}
    </ul>
  );
}

/** A failure anywhere on the board says what it was, on the desk, instead of leaving a blank page. */
class Fence extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
  override render() {
    const e = this.state.error;
    if (!e) return this.props.children;
    return (
      <div className="sb">
        <div className="sb-note" style={{ width: "min(640px, calc(100% - 32px))", textAlign: "left" }}>
          <h2>The board hit a problem</h2>
          <p>{e.message}</p>
          <p style={{ marginTop: 8, fontSize: 11, whiteSpace: "pre-wrap" }}>{(e.stack ?? "").split("\n").slice(1, 6).join("\n")}</p>
        </div>
      </div>
    );
  }
}

export default function App() {
  return (
    <Fence>
      <Board />
    </Fence>
  );
}

function Board() {
  const { data, error, isLoading } = usePlan();
  const plan = data?.plan;
  const b = useBrainstorms(plan).data;
  const live = useLiveJobs().data ?? [];
  const waiting = useWaiting().data ?? [];
  const [where, setWhere] = useAppState<string>("board", HOME);
  const [everything, setEverything] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [chat, setChat] = useState(false);
  const why = useWhy(plan).data;
  const save = useEdit();
  const [askError, setAskError] = useState<string | null>(null);
  /** The Why sheet is open, and what is picked on it. */
  const [sheet, setSheet] = useState(false);
  const [trace, setTrace] = useState<Trace>({ story: null, requirement: null });

  const goal =plan && where !== HOME && plan.cards[where]?.role === "goal" ? where : null;
  const opening = useMemo(() => (plan ? openingGoals(plan) : []), [plan]);
  const shown = useMemo(() => (plan ? (everything ? plan.goals : opening) : []), [plan, everything, opening]);
  const shelf = useMemo(() => (plan && b && goal ? asksIn(plan, b, goal) : []), [plan, b, goal]);
  const mapped: MapLayout | null = useMemo(() => (plan ? (goal ? goalMap(plan, goal, shelf) : homeMap(plan, shown)) : null), [plan, goal, shown, shelf]);
  // Map is the board's own drawing of the plan. Free is the viewer's arrangement of the same cards:
  // theirs alone, kept per board, and started from the map. The board always opens on the Map;
  // the arrangement is there when they switch to it.
  const [mode, setMode] = useState<"map" | "free">("map");
  const [arranged, setArranged] = useAppState<Record<string, Record<string, Spot>>>("free", {});
  /** The card being dragged, where it is now. */
  const [held, setHeld] = useState<(Spot & { id: string }) | null>(null);
  const free = mode === "free";
  const boardKey = goal ?? HOME;
  const moved = arranged[boardKey];
  const layout: MapLayout | null = useMemo(
    () => (plan && mapped && free ? freeMap(plan, mapped, held ? { ...moved, [held.id]: held } : (moved ?? {})) : mapped),
    [plan, mapped, free, moved, held],
  );
  const openAsks = useMemo(() => (plan && b ? openByGoal(plan, b) : {}), [plan, b]);
  // The cards one of the viewer's running jobs wrote a question about.
  const working = useMemo(() => {
    const out = new Map<string, string>();
    if (!b || !live.length) return out;
    const busy = new Map(live.map((j) => [j.job, j.title]));
    for (const [card, jobs] of Object.entries(jobsByCard(b))) {
      const j = jobs.find((id) => busy.has(id));
      if (j) out.set(card, busy.get(j)!);
    }
    return out;
  }, [b, live]);

  const desk = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const cam = useRef<Camera>({ x: 0, y: 0, z: 1 });
  // Threads: a dotted line from what is picked on the Why sheet to each lit card on the map (or back
  // from the picked card to what it is for). Drawn from where the elements are on screen, so it is
  // redrawn whenever the camera moves, without a render.
  const threads = useRef<SVGSVGElement>(null);
  const drawThreads = useCallback(() => {
    const svg = threads.current;
    const d = desk.current;
    if (!svg || !d) return;
    const o = d.getBoundingClientRect();
    const from = [...d.querySelectorAll<HTMLElement>('[data-thread="from"]')];
    const to = [...d.querySelectorAll<HTMLElement>(".sb-lit")];
    const edge = d.querySelector<HTMLElement>(".sb-why")?.getBoundingClientRect();
    const nodes: SVGElement[] = [];
    for (const f of from) {
      const a = f.getBoundingClientRect();
      // A row scrolled out of the sheet starts its thread at the sheet's edge.
      const y1 = Math.max((edge?.top ?? a.top) + 14, Math.min((edge?.bottom ?? a.bottom) - 14, a.top + Math.min(a.height / 2, 22))) - o.top;
      const x1 = (edge?.right ?? a.right) - o.left + 2;
      for (const t of to) {
        const r = t.getBoundingClientRect();
        if (r.right < x1 + o.left || r.left > o.right || r.bottom < o.top || r.top > o.bottom) continue;
        const x2 = Math.max(r.left - o.left, x1 + 12);
        const y2 = r.top + r.height / 2 - o.top;
        const m = x1 + (x2 - x1) / 2;
        const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("d", `M${x1},${y1} C${m},${y1} ${m},${y2} ${x2},${y2}`);
        nodes.push(p);
      }
      const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("cx", String(x1));
      c.setAttribute("cy", String(y1));
      c.setAttribute("r", "3");
      nodes.push(c);
    }
    svg.replaceChildren(...nodes);
  }, []);
  const apply = useCallback((fly = false) => {
    const w = world.current;
    const d = desk.current;
    if (!w || !d) return;
    const c = cam.current;
    w.classList.toggle("sb-fly", fly);
    w.style.transform = `translate(${c.x}px,${c.y}px) scale(${c.z})`;
    // The linen moves with the cards.
    const tile = 320 * Math.max(c.z, 0.45);
    d.style.backgroundSize = `${tile}px ${tile}px`;
    d.style.backgroundPosition = `${c.x}px ${c.y}px`;
    drawThreads();
  }, [drawThreads]);
  // A panel docked on the left (the Why sheet, or Jamie) covers that much of the desk.
  const inset = sheet || chat ? 444 : 0;

  const fit = useCallback(
    (fly = false) => {
      const d = desk.current;
      const box = layout && boundsOf(layout);
      if (!d || !box) return;
      const r = d.getBoundingClientRect();
      if (!r.width) return;
      const w = box.x1 - box.x0 + 80;
      const h = box.y1 - box.y0 + 190;
      // A goal's road can be long: open readable at its start, not shrunk to a line.
      const room = Math.max(240, r.width - inset);
      const z = Math.max(goal ? 0.55 : 0.16, Math.min(1, room / w, r.height / h));
      cam.current = { z, x: inset + (w * z > room ? 16 : (room - w * z) / 2) - (box.x0 - 40) * z, y: (h * z > r.height ? 70 : (r.height - h * z) / 2 + 20) - (box.y0 - 40) * z };
      apply(fly);
    },
    [layout, goal, apply, inset],
  );
  // A new board, or more of it shown: frame it. Brainstorms arriving on the shelf do not move the camera.
  const framed = useRef("");
  useLayoutEffect(() => {
    const key = `${goal ?? HOME}/${shown.length}/${plan ? Object.keys(plan.cards).length : 0}/${inset}`;
    if (framed.current === key) return;
    framed.current = key;
    fit();
  }, [fit, goal, shown.length, plan]);

  /** Bring a card to the middle of the window. */
  const flyTo = useCallback(
    (id: string) => {
      const s = layout?.spots[id];
      const r = desk.current?.getBoundingClientRect();
      if (!s || !r) return;
      const z = Math.max(cam.current.z, 0.75);
      cam.current = { z, x: r.width / 2 - (s.x + 120) * z, y: r.height / 2 - (s.y + 50) * z };
      apply(true);
    },
    [layout, apply],
  );

  const zoomAt = useCallback(
    (factor: number, cx: number, cy: number) => {
      const d = desk.current;
      if (!d) return;
      const r = d.getBoundingClientRect();
      const c = cam.current;
      const z = Math.max(0.12, Math.min(2, c.z * factor));
      const px = cx - r.left;
      const py = cy - r.top;
      cam.current = { z, x: px - ((px - c.x) * z) / c.z, y: py - ((py - c.y) * z) / c.z };
      apply();
    },
    [apply],
  );
  // The wheel zooms about the pointer. Not passive: the page must not scroll.
  useEffect(() => {
    const d = desk.current;
    if (!d) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest(".sb-menu, .sb-detail, .sb-jamie, .sb-why")) return;
      e.preventDefault();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    };
    d.addEventListener("wheel", onWheel, { passive: false });
    return () => d.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // Dragging the desk pans; a press that does not move clears what was picked.
  // Dragging the desk pans; a press that does not move clears what was picked. The move and the
  // release are listened for on the window for the length of the drag, not captured by the desk:
  // a captured pointer turns the click that follows into a click on the desk, whatever was pressed.
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button, textarea, .sb-menu, .sb-detail, .sb-note, .sb-jamie, .sb-why, .sb-jbar")) return;
    const d = e.currentTarget;
    const g = { x: e.clientX, y: e.clientY, cx: cam.current.x, cy: cam.current.y, moved: false };
    const move = (ev: PointerEvent) => {
      if (!g.moved && Math.hypot(ev.clientX - g.x, ev.clientY - g.y) < 4) return;
      g.moved = true;
      d.classList.add("sb-drag");
      cam.current = { ...cam.current, x: g.cx + ev.clientX - g.x, y: g.cy + ev.clientY - g.y };
      apply();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      d.classList.remove("sb-drag");
      if (!g.moved) {
        setPicked(null);
        setMenu(null);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  // In Free, dragging a card moves it. The press that ends a drag is not a pick.
  const dragged = useRef(false);
  const onCardDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = free && e.button === 0 ? (e.target as HTMLElement).closest<HTMLElement>("[data-id]") : null;
    const id = el?.dataset["id"];
    const from = id ? layout?.spots[id] : undefined;
    if (!id || !from) return;
    const g = { x: e.clientX, y: e.clientY, moved: false, at: from };
    const move = (ev: PointerEvent) => {
      if (!g.moved && Math.hypot(ev.clientX - g.x, ev.clientY - g.y) < 4) return;
      g.moved = true;
      g.at = { x: Math.round(from.x + (ev.clientX - g.x) / cam.current.z), y: Math.round(from.y + (ev.clientY - g.y) / cam.current.z) };
      setHeld({ id, ...g.at });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (!g.moved) return;
      dragged.current = true;
      setArranged((all) => ({ ...all, [boardKey]: { ...all[boardKey], [id]: g.at } }));
      setHeld(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  // The right-click menu: what a person can do by hand to the card under the pointer, or to the desk.
  const [ctx, setCtx] = useState<{ x: number; y: number; id: string | null } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [jamieAsk, setJamieAsk] = useState<{ text: string; n: number } | null>(null);
  const add = useAdd();
  const onContext = (e: ReactMouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (!plan || t.closest("textarea, input, select, .sb-menu, .sb-detail, .sb-jamie, .sb-why, .sb-jbar, .sb-bar")) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const id = t.closest<HTMLElement>("[data-id]")?.dataset["id"] ?? null;
    setMenu(null);
    if (id) setPicked(id);
    setCtx({ x: Math.min(e.clientX - r.left, r.width - 250), y: Math.min(e.clientY - r.top, r.height - 150), id });
  };
  useEffect(() => {
    if (!ctx) return;
    const away = (e: PointerEvent) => !(e.target as HTMLElement).closest(".sb-ctx") && setCtx(null);
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, [ctx]);
  /** Add a card by hand under `under` (or an initiative, under nothing), and pick it so it can be named. */
  const addCard = async (role: Role, under?: Card) => {
    if (!plan) return;
    setCtx(null);
    setProblem(null);
    const r = await add(plan, role, `New ${ROLE_WORD[role].toLowerCase()}`, under);
    if ("problem" in r) setProblem(`Not added: ${r.problem}`);
    else setPicked(r.id);
  };
  const addAsk = useAddAsk();
  /** Put a sticky note on a card: the viewer's own open question about it, picked so it can be written. */
  const addNote = async (about: Card) => {
    setCtx(null);
    setProblem(null);
    const r = await addAsk("New note", about);
    if ("problem" in r) setProblem(`Not added: ${r.problem}`);
    else setPicked(r.id);
  };
  // Next: step through what needs the viewer on this board — the open questions on a goal's map,
  // the goals that have any on the map of them all.
  const nextAt = useRef(-1);
  const goNext = () => {
    if (!plan) return;
    const list = goal ? openHere : plan.goals.filter((g) => openAsks[g]);
    if (!list.length) return;
    nextAt.current = (nextAt.current + 1) % list.length;
    const id = list[nextAt.current]!;
    setMenu(null);
    if (layout?.spots[id]) show(id);
    else open(id);
  };
  const askJamie = (text: string) => {
    setCtx(null);
    setSheet(false);
    setChat(true);
    setJamieAsk((a) => ({ text, n: (a?.n ?? 0) + 1 }));
  };

  const open = (id: string) => {
    setWhere(id);
    setPicked(null);
    setMenu(null);
    setTrace({ story: null, requirement: null });
    setSheet(false);
  };
  const show = (id: string) => {
    setPicked(id);
    setMenu(null);
    flyTo(id);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (menu) setMenu(null);
      else if (picked) setPicked(null);
      else if (goal) open(HOME);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const center = () => {
    const r = desk.current?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 0, y: 0 };
  };
  const pickedCard = plan && picked ? plan.cards[picked] : undefined;
  const pickedAsk = b && picked ? b.asks[picked] : undefined;
  // Tracing: with the Why sheet open, what is picked on it lights the work that answers it; picking
  // work on the map lights what it is for instead.
  const tracing = sheet && !!goal && !!why;
  const serving = tracing && pickedCard && pickedCard.role !== "goal" ? new Set(why!.serves[pickedCard.id] ?? []) : null;
  const lit = new Set<string>(!tracing ? [] : serving ? [pickedCard!.id] : trace.requirement ? (why!.answers[trace.requirement] ?? []) : trace.story ? workFor(why!, trace.story) : []);
  const dimmed = tracing && (serving !== null || !!trace.story);
  const storyCount = goal && why ? (why.byGoal[goal]?.length ?? 0) : 0;
  const hasWhy = !!goal && !!why && (storyCount > 0 || !!why.brief[goal]);
  const toggleWhy = () => {
    setChat(false);
    setMenu(null);
    // Its own details open with it, on the other side of the desk.
    setPicked(sheet ? null : goal);
    setSheet((v) => !v);
    if (!trace.story) setTrace({ story: why!.byGoal[goal!]?.[0] ?? null, requirement: null });
  };
  useLayoutEffect(() => drawThreads());
  const hidden = plan ? plan.goals.length - opening.length : 0;
  const openHere = goal ? shelf.filter((id) => b?.asks[id]?.open) : [];
  const openTotal = goal ? openHere.length : Object.values(openAsks).reduce((n, k) => n + k, 0);
  const needs = waiting.length + openTotal;
  // What Jamie is told the person is looking at, with ids it can act on.
  const name = (id: string) => `the ${ROLE_WORD[plan!.cards[id]!.role].toLowerCase()} "${plan!.cards[id]!.title}" (ref_id ${id})`;
  const subject = pickedCard ? pickedCard.id : pickedAsk?.about && plan?.cards[pickedAsk.about] ? pickedAsk.about : null;
  const about = !plan
    ? ""
    : `On the board: ${
        [pickedAsk ? `looking at the question "${pickedAsk.text}" (ref_id ${pickedAsk.id})${subject ? ` about ${name(subject)}` : ""}` : subject ? `looking at ${name(subject)}` : "", goal && goal !== subject ? `in ${name(goal)}` : !goal && !subject ? "on the map of every initiative" : ""]
          .filter(Boolean)
          .join(", ")
      }.`;

  const subjectTitle = pickedAsk ? pickedAsk.text : pickedCard ? pickedCard.title : null;

  return (
    <div className="sb" ref={desk} onPointerDown={onDown} onContextMenu={onContext}>
      <div
        className={`sb-world${dimmed ? " sb-trace" : ""}${free ? " sb-free" : ""}${held ? " sb-holding" : ""}`}
        ref={world}
        onTransitionEnd={drawThreads}
        onPointerDown={onCardDown}
        onClickCapture={(e) => {
          if (!dragged.current) return;
          dragged.current = false;
          e.stopPropagation();
        }}
      >
        {plan && layout && (
          <>
            {layout.rings.map((r, i) => (
              <div key={i} className="sb-ring" style={{ left: -r.rx, top: -r.ry, width: r.rx * 2, height: r.ry * 2 }} />
            ))}
            {layout.plots.map((p, i) => (
              <div key={i} className={`sb-plot sb-plot-${p.state}`} style={{ left: p.x, top: p.y, width: p.w, height: p.h }} />
            ))}
            {layout.labels.map((l, i) => (
              <div key={i} className="sb-label" style={{ left: l.x, top: l.y }}>
                {l.text}
              </div>
            ))}
            <svg className="sb-roads" aria-hidden="true">
              {layout.roads.map((r, i) => (
                <path key={i} className={`sb-road-${r.kind}`} d={`M${r.a.x},${r.a.y} L${r.b.x},${r.b.y}`} />
              ))}
            </svg>
            {!goal && (
              <>
                <div className="sb-centre">
                  Initiatives
                  <small>{shown.length === plan.goals.length ? `${shown.length} in all` : `${shown.length} of ${plan.goals.filter((g) => plan.cards[g]!.state === "prog").length || plan.goals.length} in progress`}</small>
                </div>
                {hidden > 0 && (
                  <button type="button" className="sb-btn sb-more" onClick={() => setEverything((v) => !v)}>
                    {everything ? "Collapse" : `Show all ${plan.goals.length}`}
                  </button>
                )}
              </>
            )}
            {Object.entries(layout.spots).map(([id, s]) => {
              const on = picked === id ? " sb-on" : "";
              const ask = b?.asks[id];
              if (ask) {
                return (
                  <button key={id} type="button" data-id={id} className={`sb-sticky${ask.open ? "" : " sb-decided"}${on}`} style={{ left: s.x, top: s.y }} onClick={() => setPicked(id)}>
                    <span className="sb-meta">
                      {ask.by === "person" && !ask.options.length ? `Note · ${ask.open ? "Open" : "Decided"}` : `Question · ${ask.open ? "Open" : "Decided"} · ${ask.options.length} option${ask.options.length === 1 ? "" : "s"}`}
                    </span>
                    <span className="sb-title">{ask.text}</span>
                  </button>
                );
              }
              const c = plan.cards[id];
              if (!c) return null;
              const busy = (working.has(id) ? " sb-working" : "") + (lit.has(id) ? " sb-lit" : "");
              if (c.role === "work") {
                return (
                  <button key={id} type="button" data-id={id} className={`sb-tile sb-s-${c.state}${busy}${on}`} style={{ left: s.x, top: s.y }} title={`${c.title} · ${STATE_WORD[c.state]}`} onClick={() => setPicked(id)}>
                    <span className="sb-title">{c.title}</span>
                  </button>
                );
              }
              const draft = c.role === "goal" && c.state === "idle" ? " sb-draft" : "";
              const faded = layout.faded.includes(id) ? " sb-faded" : "";
              const asking = c.role === "goal" ? (openAsks[id] ?? 0) : (b?.byCard[id] ?? []).filter((q) => b!.asks[q]!.open).length;
              return (
                <button
                  key={id}
                  type="button"
                  data-id={id}
                  className={`sb-card sb-${c.role} sb-s-${c.state}${draft}${faded}${busy}${on}`}
                  style={{ left: s.x, top: s.y }}
                  aria-pressed={id === goal && hasWhy ? sheet : undefined}
                  // On its own map, the initiative opens why it exists: its brief, stories and requirements.
                  onClick={() => (id === goal && hasWhy ? toggleWhy() : setPicked(id))}
                  // On the home map an initiative opens on a second press: the first shows what it is.
                  onDoubleClick={() => c.role === "goal" && !goal && open(id)}
                >
                  <span className="sb-meta">
                    {c.role === "group" && <i className={`sb-dot sb-s-${c.state}`} />}
                    {metaOf(plan, c)}
                    {id === goal && storyCount > 0 && ` · ${storyCount} ${storyCount === 1 ? "story" : "stories"}`}
                    {asking > 0 && (
                      <span className="sb-need">
                        {" "}
                        · {asking} open question{asking === 1 ? "" : "s"}
                      </span>
                    )}
                  </span>
                  <span className="sb-title">{c.title}</span>
                  {c.role === "goal" && !goal && (plan.kids[id]?.length ?? 0) > 0 && (
                    <span className="sb-dots">
                      {plan.kids[id]!.map((k) => (
                        <i key={k} className={`sb-dot sb-s-${plan.cards[k]!.state}`} />
                      ))}
                    </span>
                  )}
                </button>
              );
            })}
          </>
        )}
      </div>

      <div className="sb-bar sb-bar-left">
        <button type="button" className="sb-btn sb-where" aria-haspopup="true" aria-expanded={menu === "boards"} onClick={() => setMenu((m) => (m === "boards" ? null : "boards"))}>
          <span>{goal && plan ? plan.cards[goal]!.title : "All initiatives"}</span>
        </button>
        {plan && (
          <>
            <i className="sb-sep" />
            <button type="button" className="sb-btn" aria-haspopup="true" aria-expanded={menu === "needs"} onClick={() => setMenu((m) => (m === "needs" ? null : "needs"))}>
              Needs you{needs > 0 && <b className="sb-count">{needs}</b>}
            </button>
            {openTotal > 0 && (
              <button type="button" className="sb-btn" title="Go to the next open question" onClick={goNext}>
                Next ›
              </button>
            )}
          </>
        )}
        {live.length > 0 && (
          <button type="button" className="sb-btn sb-livebtn" aria-haspopup="true" aria-expanded={menu === "live"} onClick={() => setMenu((m) => (m === "live" ? null : "live"))}>
            <i className="sb-dot sb-s-prog" />
            Working now · {live.length}
          </button>
        )}
      </div>

      {menu === "boards" && plan && (
        <div className="sb-menu">
          <button type="button" onClick={() => open(HOME)}>
            <span>All initiatives</span>
            <b>{plan.goals.length}</b>
          </button>
          {(["prog", "rest"] as const).map((part) => {
            const list = plan.goals.filter((g) => (plan.cards[g]!.state === "prog") === (part === "prog"));
            if (!list.length) return null;
            return (
              <div key={part} className="sb-group-list">
                <h4>{part === "prog" ? "In progress" : "Everything else"}</h4>
                {list.map((g) => (
                  <button key={g} type="button" onClick={() => open(g)}>
                    <span>{plan.cards[g]!.title}</span>
                    <b>{plan.kids[g]?.length || ""}</b>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {menu === "needs" && plan && (
        <div className="sb-menu">
          {needs === 0 && <h4>Nothing needs you here</h4>}
          {waiting.length > 0 && (
            <div className="sb-group-list">
              <h4>Waiting on your yes or no · {waiting.length}</h4>
              {waiting.map((w) => (
                <div key={w.id} className="sb-row">
                  <span>{w.title}</span>
                  {w.summary && <small>{w.summary}</small>}
                </div>
              ))}
              <small className="sb-hint">Decide these in Jamie.</small>
            </div>
          )}
          {goal && openHere.length > 0 && (
            <div className="sb-group-list">
              <h4>Open questions here · {openHere.length}</h4>
              {openHere.map((id) => (
                <button key={id} type="button" onClick={() => show(id)}>
                  <span>{b!.asks[id]!.text}</span>
                  <b>{b!.asks[id]!.options.length || ""}</b>
                </button>
              ))}
            </div>
          )}
          {!goal && openTotal > 0 && (
            <div className="sb-group-list">
              <h4>Open questions, everyone's · {openTotal}</h4>
              {plan.goals
                .filter((g) => openAsks[g])
                .sort((x, y) => openAsks[y]! - openAsks[x]!)
                .map((g) => (
                  <button key={g} type="button" onClick={() => open(g)}>
                    <span>{plan.cards[g]!.title}</span>
                    <b>{openAsks[g]}</b>
                  </button>
                ))}
            </div>
          )}
        </div>
      )}

      {menu === "live" && (
        <div className="sb-menu">
          <h4>Your jobs working now · {live.length}</h4>
          {live.map((j) => {
            const card = [...working.entries()].find(([, title]) => title === j.title)?.[0];
            return card && layout?.spots[card] ? (
              <button key={j.job} type="button" onClick={() => show(card)}>
                <span>{j.title}</span>
                <b>on this map</b>
              </button>
            ) : (
              <div key={j.job} className="sb-row">
                <span>{j.title}</span>
              </div>
            );
          })}
        </div>
      )}

      <div className="sb-bar sb-bar-right">
        <div className="sb-seg" role="group" aria-label="How the cards are laid out">
          <button type="button" className="sb-btn" aria-pressed={!free} title="Laid out for you from the plan" onClick={() => setMode("map")}>
            Map
          </button>
          <button type="button" className="sb-btn" aria-pressed={free} title="Your own arrangement: drag the cards where you want them" onClick={() => setMode("free")}>
            Free
          </button>
        </div>
        {free && moved && Object.keys(moved).length > 0 && (
          <button type="button" className="sb-btn" title="Put every card back where the map has it" onClick={() => setArranged(({ [boardKey]: _, ...rest }) => rest)}>
            Tidy
          </button>
        )}
        <i className="sb-sep" />
        <button type="button" className="sb-btn" aria-label="Zoom in" onClick={() => zoomAt(1.25, center().x, center().y)}>
          +
        </button>
        <button type="button" className="sb-btn" aria-label="Zoom out" onClick={() => zoomAt(0.8, center().x, center().y)}>
          −
        </button>
        <button type="button" className="sb-btn" onClick={() => fit(true)}>
          Fit
        </button>
      </div>

      <svg className="sb-threads" ref={threads} aria-hidden="true" />
      {tracing && plan && goal && why && (
        <WhySheet
          plan={plan}
          why={why}
          goal={goal}
          trace={trace}
          serving={serving}
          onTrace={(t) => {
            setTrace(t);
            setPicked(null);
          }}
          onClose={() => setSheet(false)}
          onScroll={drawThreads}
        />
      )}
      <JamieDock
        about={about}
        subject={subjectTitle && subjectTitle.length > 48 ? `${subjectTitle.slice(0, 48)}…` : subjectTitle}
        open={chat}
        ask={jamieAsk}
        // Clear of whatever is docked on the left.
        shift={inset}
        onOpen={() => {
          setSheet(false);
          setChat(true);
        }}
        onClose={() => setChat(false)}
      />

      {pickedCard && plan && (
        <div className="sb-detail">
          <span className="sb-meta">{metaOf(plan, pickedCard)}</span>
          <CardFacts card={pickedCard} roles={HIVE_PLAN} save={save} />
          {working.has(pickedCard.id) && <p className="sb-need">Working now: {working.get(pickedCard.id)}</p>}
          {pickedCard.role === "goal" && why?.brief[pickedCard.id] && <p className="sb-brief">{why.brief[pickedCard.id]}</p>}
          {pickedCard.role === "goal" && !goal && (
            <button type="button" className="sb-btn sb-primary" onClick={() => open(pickedCard.id)}>
              Open its map
            </button>
          )}
          {pickedCard.role !== "goal" && !goal && goalOf(plan, pickedCard.id) && (
            <button type="button" className="sb-btn" onClick={() => open(goalOf(plan, pickedCard.id)!)}>
              Open its initiative
            </button>
          )}
          {(plan.kids[pickedCard.id]?.length ?? 0) > 0 && (
            <>
              <span className="sb-meta">
                {pickedCard.role === "goal" ? "Milestones" : "Features"} · {plan.kids[pickedCard.id]!.length}
              </span>
              <ul className="sb-kids">
                {plan.kids[pickedCard.id]!.map((k) => (
                  <li key={k}>
                    <i className={`sb-dot sb-s-${plan.cards[k]!.state}`} title={STATE_WORD[plan.cards[k]!.state]} />
                    {layout?.spots[k] ? (
                      <button type="button" className="sb-link" onClick={() => show(k)}>
                        {plan.cards[k]!.title}
                      </button>
                    ) : (
                      <span>{plan.cards[k]!.title}</span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {why && pickedCard.role === "work" && goal && storyCount > 0 && (
            <>
              <span className="sb-meta">What it is for</span>
              {(why.serves[pickedCard.id] ?? []).map((r) => (
                <p key={r} className="sb-for">
                  {why.requirements[r]!.text}
                </p>
              ))}
              {!(why.serves[pickedCard.id] ?? []).length && <p className="sb-need">It answers no requirement.</p>}
            </>
          )}
          {b && (b.byCard[pickedCard.id]?.length ?? 0) > 0 && (
            <>
              <span className="sb-meta">Questions about it</span>
              {b.byCard[pickedCard.id]!.map((q) =>
                layout?.spots[q] ? (
                  <button key={q} type="button" className="sb-link" onClick={() => show(q)}>
                    {b.asks[q]!.text}
                  </button>
                ) : (
                  <p key={q}>{b.asks[q]!.text}</p>
                ),
              )}
            </>
          )}
        </div>
      )}
      {pickedAsk && plan && b && (
        <div className="sb-detail">
          <span className="sb-meta">
            Question · {pickedAsk.open ? "Open" : "Decided"}
            {who(pickedAsk.by) ? ` · asked by ${who(pickedAsk.by)}` : ""}
          </span>
          <Editable long className="sb-edit-title" label="Question" value={pickedAsk.text} placeholder="Untitled question" onSave={(text) => text && void save(pickedAsk.id, { text }).then(setAskError)} />
          {askError && <p className="sb-need">Not saved: {askError}</p>}
          {pickedAsk.about && plan.cards[pickedAsk.about] && (
            <p>
              About {ROLE_WORD[plan.cards[pickedAsk.about]!.role].toLowerCase()}:{" "}
              <button type="button" className="sb-link" onClick={() => show(pickedAsk.about!)}>
                {plan.cards[pickedAsk.about]!.title}
              </button>
            </p>
          )}
          <span className="sb-meta">Options · {pickedAsk.options.length}</span>
          <Options ask={pickedAsk} b={b} />
        </div>
      )}

      {isLoading && !plan && (
        <div className="sb-note">
          <h2>Reading the graph</h2>
          <p>Collecting initiatives, milestones and features.</p>
        </div>
      )}
      {error && !plan && (
        <div className="sb-note">
          <h2>The plan could not be read</h2>
          <p>{error instanceof Error ? error.message : String(error)}</p>
        </div>
      )}
      {plan && !plan.goals.length && (
        <div className="sb-note">
          <h2>No initiatives yet</h2>
          <p>This graph holds no initiatives. Ask Jamie to plan one and it will appear here.</p>
        </div>
      )}
      {ctx &&
        plan &&
        (() => {
          const card = ctx.id ? plan.cards[ctx.id] : undefined;
          const q = ctx.id ? b?.asks[ctx.id] : undefined;
          // On the desk of a goal's map, the menu is about that goal.
          const on = card ?? (!ctx.id && goal ? plan.cards[goal] : undefined);
          return (
            <div className="sb-menu sb-ctx" style={{ left: ctx.x, top: ctx.y }} role="menu">
              {on && <h4>{on.title}</h4>}
              {q && <h4>{q.text}</h4>}
              {!on && !q && (
                <button type="button" role="menuitem" onClick={() => void addCard("goal")}>
                  <span>Add initiative</span>
                </button>
              )}
              {on?.role === "goal" && (
                <button type="button" role="menuitem" onClick={() => void addCard("group", on)}>
                  <span>Add milestone</span>
                </button>
              )}
              {on?.role === "group" && (
                <button type="button" role="menuitem" onClick={() => void addCard("work", on)}>
                  <span>Add feature</span>
                </button>
              )}
              {on && goal && (
                <button type="button" role="menuitem" onClick={() => void addNote(on)}>
                  <span>Add sticky note</span>
                </button>
              )}
              {on && (
                <button type="button" role="menuitem" onClick={() => (setPicked(on.id), askJamie(`Brainstorm this ${ROLE_WORD[on.role].toLowerCase()} with me: what are the open questions and the options for each?`))}>
                  <span>Brainstorm with Jamie</span>
                </button>
              )}
              {q && (
                <button type="button" role="menuitem" onClick={() => askJamie("Help me decide this question: lay out the options and what each leads to.")}>
                  <span>Work through it with Jamie</span>
                </button>
              )}
              {on && on.role === "goal" && !goal && (
                <button type="button" role="menuitem" onClick={() => (setCtx(null), open(on.id))}>
                  <span>Open its map</span>
                </button>
              )}
            </div>
          );
        })()}
      {problem && (
        <button type="button" className="sb-cut sb-problem sb-need" title="Dismiss" onClick={() => setProblem(null)}>
          {problem}
        </button>
      )}
      {data?.truncated && <div className="sb-cut">This graph holds more than the board reads at once. Some cards are missing.</div>}
    </div>
  );
}
