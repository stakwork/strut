import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Camera, ImagePlus, Images, Loader2, LogIn, RotateCcw, Sparkles, TriangleAlert, Zap } from "lucide-react";
import { useAccountWidget, useCamera, useHost, useTask, useTaskHistory, useVisitor, useWorker, type WorkerHistoryItem, type WorkerTask } from "@strut/kit";
import { PictureCompare } from "./Compare";
import { Pictures } from "./Pictures";
import { REPLY_POLL_MS, REPLY_WAIT_MS, TYPE, errorText, outcomeOf, sats, shrink, type Outcome } from "./photo";
import "./styles.css";

// A WORKER app over a STANDING task type, `photo-remix`: whenever the worker
// asks, a picture is wanted. They snap one (strut's camera, or a photo from
// the device); the answer launches the type's workflow, whose image model
// reimagines it in the style its params name, and whose reply hands back the
// result and their photo. The page waits for that reply, then draws before
// and after. Strut's account widget shows what they earned.

/** The page's views: the bar at the bottom switches them. */
const VIEWS = [
  { id: "take", label: "Take", icon: Camera },
  { id: "pictures", label: "Your pictures", icon: Images },
] as const;
type View = (typeof VIEWS)[number]["id"];

type Stage =
  | { at: "start" }
  | { at: "sending"; photo: string }
  | { at: "waiting"; photo: string; lease: string; msat: number; since: number }
  | { at: "done"; photo: string; item: WorkerHistoryItem; outcome: Extract<Outcome, { state: "done" }>; msat: number }
  | { at: "failed"; photo: string; title: string }
  | { at: "late"; photo: string };

export default function App() {
  const visitor = useVisitor();
  const camera = useCamera();
  const account = useAccountWidget();
  // In strut's own UI (a member, an admin) the viewer is known already; only a visitor signs in on the page.
  const known = !useHost().public;
  const me = useWorker({ enabled: !!visitor.actor || known });
  const signedIn = !!visitor.actor || (known && !!me.data?.actor);
  const [view, setView] = useState<View>("take");
  const [stage, setStage] = useState<Stage>({ at: "start" });
  // A task is held only on the way to a picture: a standing type makes one at
  // once when asked, and a worker who stops after their last picture holds none.
  const work = useTask(TYPE, { enabled: signedIn && (stage.at === "start" || stage.at === "sending") });
  const [error, setError] = useState<string | null>(null);
  const chooser = useRef<HTMLInputElement>(null);

  // A send waits for the lease: "Take another" opens the camera while it is asked for.
  const taskRef = useRef<WorkerTask | null>(null);
  taskRef.current = work.task;
  const leased = async (): Promise<WorkerTask> => {
    for (let waited = 0; waited < 20_000; waited += 150) {
      if (taskRef.current) return taskRef.current;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error("No picture can be taken here right now. Try again in a moment.");
  };

  const send = async (photo: File) => {
    const url = URL.createObjectURL(photo);
    setError(null);
    setView("take");
    setStage({ at: "sending", photo: url });
    try {
      const task = await leased();
      await work.submit({}, [new File([photo], "photo.jpg", { type: photo.type || "image/jpeg" })]);
      setStage({ at: "waiting", photo: url, lease: task.lease, msat: task.payMsat, since: Date.now() });
    } catch (err) {
      setError(errorText(err));
      setStage({ at: "start" });
    }
  };
  const snap = async () => {
    if (!camera.available) return chooser.current?.click();
    setError(null);
    try {
      const photo = await camera.capture({ title: "Snap anything" });
      if (photo) await send(photo);
    } catch (err) {
      setError(errorText(err));
    }
  };
  const chosen = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) await send(await shrink(file));
  };

  // While a picture is being made: the worker's history, read until the reply lands or the wait is over.
  const waiting = stage.at === "waiting" ? stage : null;
  const history = useTaskHistory({ enabled: signedIn, refetchInterval: waiting ? REPLY_POLL_MS : false });
  useEffect(() => {
    if (!waiting) return;
    const item = history.data?.items.find((i) => i.lease === waiting.lease);
    const outcome = item && outcomeOf(item);
    if (!item || !outcome || outcome.state === "waiting") return;
    if (outcome.state === "failed") setStage({ at: "failed", photo: waiting.photo, title: outcome.title });
    else setStage({ at: "done", photo: waiting.photo, item, outcome, msat: waiting.msat });
  }, [history.data, waiting]);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setStage({ at: "late", photo: waiting.photo }), Math.max(0, waiting.since + REPLY_WAIT_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [waiting]);

  const again = () => {
    setStage({ at: "start" });
    void snap();
  };
  const show = work.task?.show as { ask?: string; style?: string } | undefined;
  const pay = work.task?.payMsat ?? 0;

  return (
    <div className="px-app">
      <header className="px-head" style={account.available ? { paddingRight: 176 } : undefined}>
        <div className="px-mark"><Sparkles size={16} /></div>
        <div className="px-names">
          <div className="px-title">Photo Remix</div>
          <div className="px-sub">See it reimagined</div>
        </div>
      </header>

      {view === "pictures" ? (
        <main className="px-scroll">
          <Pictures onTake={() => setView("take")} />
        </main>
      ) : stage.at === "start" ? (
        <main className="px-start">
          <div className="px-lens" aria-hidden="true"><div className="px-lens-core"><Camera size={34} /></div></div>
          {!signedIn ? (
            known && me.isLoading ? (
              <h1>One moment…</h1>
            ) : (
              <>
                <h1>Snap anything. See it reimagined.</h1>
                <p>Sign in, take a picture, and watch an image model remake it in seconds.</p>
              </>
            )
          ) : work.task ? (
            <>
              <h1>{show?.ask ?? "Take a picture of anything"}</h1>
              {show?.style && <p className="px-style">“{show.style}”</p>}
              {pay > 0 && <div className="px-pay"><Zap size={13} /> Earn {sats(pay)} a picture</div>}
            </>
          ) : work.status === "inactive" ? (
            <>
              <h1>You're signed in</h1>
              <p>This one is by invitation. Once you're in, you can start snapping here.</p>
            </>
          ) : work.status === "error" ? (
            <>
              <h1>Can't reach the camera queue</h1>
              <p>{work.error ? errorText(work.error) : "Something went wrong."} Trying again…</p>
            </>
          ) : (
            <>
              <h1>Getting ready…</h1>
              <p className="px-line px-shimmer" />
            </>
          )}
        </main>
      ) : (
        <main className="px-stage">
          {stage.at === "done" ? (
            <PictureCompare item={stage.item} outcome={stage.outcome} photo={stage.photo} intro />
          ) : (
            <Making stage={stage} />
          )}
        </main>
      )}

      {error && <div className="px-error" role="alert"><TriangleAlert size={16} /> {error}</div>}
      <input ref={chooser} type="file" accept="image/*" hidden onChange={(e) => void chosen(e)} />

      {view === "take" && stage.at === "start" && (
        <div className="px-bar">
          {!signedIn ? (
            visitor.available ? (
              <button type="button" className="px-btn px-btn-wide" onClick={() => void visitor.signIn()}><LogIn size={18} /> Sign in to start</button>
            ) : (
              !known && <p className="px-hint">Signing in isn't open on this page.</p>
            )
          ) : (
            <>
              <button type="button" className="px-shutter" onClick={() => void snap()} disabled={!work.task} aria-label="Take a picture">
                <span />
              </button>
              <button type="button" className="px-link" onClick={() => chooser.current?.click()} disabled={!work.task}><ImagePlus size={16} /> Choose a photo</button>
            </>
          )}
        </div>
      )}
      {view === "take" && stage.at === "done" && (
        <div className="px-bar px-bar-row">
          {stage.msat > 0 && <span className="px-earned"><Zap size={13} /> +{sats(stage.msat)}</span>}
          <button type="button" className="px-btn" onClick={again}><Camera size={18} /> Take another</button>
        </div>
      )}
      {view === "take" && (stage.at === "failed" || stage.at === "late") && (
        <div className="px-bar px-bar-row">
          <button type="button" className="px-btn" onClick={again}>
            {stage.at === "failed" ? <><RotateCcw size={18} /> Try another</> : <><Camera size={18} /> Take another</>}
          </button>
        </div>
      )}
      {signedIn && (view === "pictures" || stage.at === "start" || stage.at === "done" || stage.at === "failed" || stage.at === "late") && (
        <nav className="px-tabs">
          {VIEWS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={view === id ? "px-tab px-tab-on" : "px-tab"}
              aria-current={view === id ? "page" : undefined}
              onClick={() => {
                if (id === "take" && view === "take" && stage.at !== "start") setStage({ at: "start" });
                setView(id);
              }}
            >
              <Icon size={20} /> {label}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}

/** Their photo while it is sent and remade: a scan over it, the seconds counting. */
function Making({ stage }: { stage: Exclude<Stage, { at: "start" } | { at: "done" }> }) {
  const since = stage.at === "waiting" ? stage.since : null;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (since === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [since]);
  const busy = stage.at === "sending" || stage.at === "waiting";
  return (
    <div className="px-compare">
      <img className={`px-fill${busy ? " px-dim" : " px-muted"}`} src={stage.photo} alt="Your photo" />
      {busy && <div className="px-scan" aria-hidden="true" />}
      <div className="px-center px-note" role="status">
        <div className="px-card">
          {stage.at === "sending" && (
            <>
              <Loader2 className="px-spin" size={28} />
              <p>Sending your photo…</p>
            </>
          )}
          {stage.at === "waiting" && (
            <>
              <Sparkles className="px-pulse" size={30} />
              <p>Reimagining your picture…</p>
              <span className="px-secs">{Math.max(0, Math.floor((now - stage.since) / 1000))} s</span>
            </>
          )}
          {stage.at === "failed" && (
            <>
              <TriangleAlert size={28} />
              <p>{stage.title}</p>
            </>
          )}
          {stage.at === "late" && (
            <>
              <Loader2 size={28} />
              <p>This one is taking longer than usual. It will show up in Your pictures when it's ready.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
