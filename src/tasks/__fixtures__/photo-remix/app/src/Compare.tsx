import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ChevronsLeftRight, Loader2 } from "lucide-react";
import { useTaskFileUrl, type WorkerHistoryItem } from "@strut/kit";
import type { Outcome } from "./photo";

/**
 * Before and after in one frame: the result underneath, the photo over it
 * clipped at the divider. Drag anywhere (touch or mouse), or focus the handle
 * and use the arrow keys. With `intro`, the divider sweeps in from the right
 * once the result is drawn: the reveal.
 */
export function Compare({ before, after, intro = false }: { before: string | null; after: string | null; intro?: boolean }) {
  const [pos, setPos] = useState(intro ? 100 : 50);
  const [gliding, setGliding] = useState(intro);
  const frame = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    if (!intro || !after) return;
    const timer = setTimeout(() => setPos(50), 350);
    const done = setTimeout(() => setGliding(false), 1_600);
    return () => {
      clearTimeout(timer);
      clearTimeout(done);
    };
  }, [intro, after]);

  const moveTo = (clientX: number) => {
    const rect = frame.current?.getBoundingClientRect();
    if (!rect?.width) return;
    setPos(Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100)));
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    setGliding(false);
    e.currentTarget.setPointerCapture(e.pointerId);
    moveTo(e.clientX);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) moveTo(e.clientX);
  };
  const up = () => {
    dragging.current = false;
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const to = { ArrowLeft: pos - 5, ArrowRight: pos + 5, Home: 0, End: 100 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    setGliding(true);
    setPos(Math.min(100, Math.max(0, to)));
  };

  return (
    <div ref={frame} className={`px-compare${gliding ? " px-glide" : ""}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      {after ? <img className="px-fill" src={after} alt="Reimagined" draggable={false} /> : <div className="px-fill px-dark" />}
      {before && <img className="px-fill px-before" src={before} alt="Your photo" draggable={false} style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }} />}
      {!after && (
        <div className="px-center">
          <Loader2 className="px-spin" size={26} />
        </div>
      )}
      <span className="px-tag px-tag-left" style={{ opacity: pos > 12 ? 1 : 0 }}>Before</span>
      <span className="px-tag px-tag-right" style={{ opacity: pos < 88 ? 1 : 0 }}>After</span>
      <div className="px-divider" style={{ left: `${pos}%` }} />
      {/* Kept inside the frame at either end, where the line meets the edge. */}
      <div
        className="px-handle"
        style={{ left: `clamp(30px, ${pos}%, calc(100% - 30px))` }}
        role="slider"
        tabIndex={0}
        aria-label="Before and after: move to compare"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pos)}
        aria-valuetext={`${Math.round(pos)}% of your photo shown`}
        onKeyDown={key}
      >
        <ChevronsLeftRight size={18} />
      </div>
    </div>
  );
}

/** A finished picture of the worker's history, both files read through the lease they answered by; `photo` is the photo they just took, when the page still has it. */
export function PictureCompare({ item, outcome, photo, intro }: { item: WorkerHistoryItem; outcome: Extract<Outcome, { state: "done" }>; photo?: string; intro?: boolean }) {
  const after = useTaskFileUrl(item, outcome.after.path);
  const before = useTaskFileUrl(item, outcome.before?.path, { enabled: !photo });
  if (after.error) {
    return (
      <div className="px-compare">
        <div className="px-center px-note">
          <p>This picture didn't load.</p>
          <button type="button" className="px-btn px-btn-ghost" onClick={after.refetch}>Try again</button>
        </div>
      </div>
    );
  }
  return <Compare before={photo ?? before.url} after={after.url} intro={intro} />;
}
