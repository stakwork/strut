import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Camera, ImageOff, Loader2, Sparkles, TriangleAlert, Zap } from "lucide-react";
import { useTaskFileUrl, useTaskHistory, type WorkerHistoryItem } from "@strut/kit";
import { PictureCompare } from "./Compare";
import { REPLY_POLL_MS, REPLY_WAIT_MS, TYPE, errorText, outcomeOf, sats } from "./photo";

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** The worker's own pictures, newest first, each read only once its tile comes into view; one opens the same before and after. */
export function Pictures({ onTake }: { onTake: () => void }) {
  const [poll, setPoll] = useState(false);
  const history = useTaskHistory({ refetchInterval: poll ? REPLY_POLL_MS : false });
  const items = (history.data?.items ?? []).filter((i) => i.type === TYPE && i.status === "submitted");
  const [open, setOpen] = useState<WorkerHistoryItem | null>(null);
  // A picture still being made: read again until it lands (or the wait is over).
  useEffect(() => {
    setPoll(items.some((i) => !i.reply && Date.now() - (i.closed ?? i.taken) < REPLY_WAIT_MS));
  }, [history.data]);

  if (open) return <Opened item={open} onBack={() => setOpen(null)} />;
  if (history.isLoading) {
    return (
      <div className="px-grid" aria-busy="true">
        {[0, 1, 2, 3].map((i) => <div key={i} className="px-tile px-shimmer" />)}
      </div>
    );
  }
  if (history.error) {
    return (
      <div className="px-empty">
        <TriangleAlert size={30} />
        <h2>Your pictures didn't load</h2>
        <p>{errorText(history.error)}</p>
        <button type="button" className="px-btn px-btn-ghost" onClick={() => void history.refetch()}>Try again</button>
      </div>
    );
  }
  if (!items.length) {
    return (
      <div className="px-empty">
        <Sparkles size={30} />
        <h2>No pictures yet</h2>
        <p>Everything you snap shows up here, before and after.</p>
        <button type="button" className="px-btn" onClick={onTake}><Camera size={18} /> Take your first</button>
      </div>
    );
  }
  return (
    <>
      <h2 className="px-heading">Your pictures <span>{items.length}</span></h2>
      <div className="px-grid">
        {items.map((item) => <Tile key={item.lease} item={item} onOpen={() => setOpen(item)} />)}
      </div>
    </>
  );
}

function Tile({ item, onOpen }: { item: WorkerHistoryItem; onOpen: () => void }) {
  const outcome = outcomeOf(item);
  const file = outcome.state === "done" ? outcome.after : outcome.state === "failed" ? outcome.photo : undefined;
  const ref = useRef<HTMLButtonElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== "function") return setSeen(true);
    const watch = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setSeen(true));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const picture = useTaskFileUrl(item, file?.path, { enabled: seen && !!file });
  const earned = item.earned && !item.earned.takenBack ? item.earned.msat : 0;
  return (
    <button ref={ref} type="button" className="px-tile" onClick={onOpen} disabled={outcome.state === "waiting"} aria-label={`Picture from ${when(item.taken)}`}>
      {picture.url ? <img className={`px-fill${outcome.state === "failed" ? " px-muted" : ""}`} src={picture.url} alt="" /> : <div className="px-fill px-shimmer" />}
      {outcome.state === "waiting" && (
        <span className="px-tile-note"><Loader2 className="px-spin" size={14} /> Being made</span>
      )}
      {outcome.state === "failed" && (
        <span className="px-tile-note"><ImageOff size={14} /> Not transformed</span>
      )}
      {earned > 0 && <span className="px-tile-pay"><Zap size={11} /> {sats(earned)}</span>}
    </button>
  );
}

function Opened({ item, onBack }: { item: WorkerHistoryItem; onBack: () => void }) {
  const outcome = outcomeOf(item);
  const photo = useTaskFileUrl(item, outcome.state === "failed" ? outcome.photo?.path : undefined);
  return (
    <div className="px-opened">
      <div className="px-stage">
        {outcome.state === "done" ? (
          <PictureCompare item={item} outcome={outcome} />
        ) : (
          <div className="px-compare">
            {photo.url && <img className="px-fill px-muted" src={photo.url} alt="Your photo" />}
            <div className="px-center px-note">
              <div className="px-card">
                <ImageOff size={26} />
                <p>{outcome.state === "failed" ? outcome.title : "Still being made."}</p>
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="px-bar">
        <button type="button" className="px-btn px-btn-ghost" onClick={onBack}><ArrowLeft size={18} /> Your pictures</button>
        <span className="px-when">{when(item.taken)}</span>
      </div>
    </div>
  );
}
