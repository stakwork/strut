import { useState } from "react";
import { Camera, Check, FileText, Loader2, RotateCcw, ScanLine, Send, Zap } from "lucide-react";
import { useCamera, useTask, useVisitor } from "@strut/kit";
import "./styles.css";

// A WORKER app (plans/human-steps.md §5.6): a task of type `court-paper`
// asks for a photo of a court document. The worker snaps one (strut draws
// the camera) and answers the task WITH it: the photo is saved in the task's
// run, whose next step reads it. Strut's account widget shows what they
// earned and withdraws it to their Sphinx account.

const TYPE = "court-paper";

type Stage =
  | { at: "start" }
  | { at: "review"; photo: File; url: string }
  | { at: "sending"; url: string }
  | { at: "sent"; url: string; earnedMsat: number };

const sats = (msat: number) => `${Math.floor(msat / 1000).toLocaleString("en-US")} sats`;

export default function App() {
  const visitor = useVisitor();
  const camera = useCamera();
  const signedIn = !!visitor.actor;
  const work = useTask(TYPE, { enabled: signedIn });
  const [stage, setStage] = useState<Stage>({ at: "start" });
  const [error, setError] = useState<string | null>(null);

  const snap = async () => {
    setError(null);
    try {
      const photo = await camera.capture({ title: "Fit the whole page in the frame" });
      if (photo) setStage({ at: "review", photo, url: URL.createObjectURL(photo) });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  // The answer is the photo: the task type takes one image with it.
  const send = async () => {
    if (stage.at !== "review" || !work.task) return;
    const { photo, url } = stage;
    const earnedMsat = work.task.payMsat;
    setError(null);
    setStage({ at: "sending", url });
    try {
      await work.submit({}, [new File([photo], "court-document.jpg", { type: photo.type || "image/jpeg" })]);
      setStage({ at: "sent", url, earnedMsat });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage({ at: "review", photo, url });
    }
  };
  const again = () => {
    setError(null);
    setStage({ at: "start" });
  };

  const pay = work.task?.payMsat ?? 0;

  return (
    <div className="court-app">
      <header className="court-head">
        <div className="court-mark"><FileText size={16} /></div>
        <div>
          <div className="court-title">Court Filing</div>
          <div className="court-sub">Photograph court papers · get paid</div>
        </div>
      </header>

      <main className="court-stage">
        {stage.at === "start" ? (
          <div className="court-start">
            <div className="court-doc-icon"><ScanLine size={44} /></div>
            {!signedIn ? (
              <>
                <h1>Earn sats for court papers</h1>
                <p>Sign in, then photograph court documents. Each one we can read pays you.</p>
              </>
            ) : work.task ? (
              <>
                <div className="court-pay"><Zap size={14} /> Earn {sats(pay)}</div>
                <h1>Wanted: a court document</h1>
                <p>{(work.task.show as { ask?: string } | null)?.ask ?? "Photograph a court document."}</p>
              </>
            ) : work.status === "inactive" ? (
              <>
                <h1>You're signed in</h1>
                <p>This work is by invitation. Once you're in, the first document shows up here.</p>
              </>
            ) : (
              <>
                <h1>Looking for work…</h1>
                <p>No documents wanted right now. The next one shows up here.</p>
              </>
            )}
          </div>
        ) : (
          <img className="court-media" src={stage.url} alt="The document" />
        )}
        {stage.at === "sending" && (
          <div className="court-busy">
            <Loader2 className="court-spin" size={28} />
            <div>Sending…</div>
          </div>
        )}
      </main>

      {stage.at === "sent" && (
        <section className="court-sheet">
          <div className="court-badges">
            <span className="court-badge"><Check size={14} /> Sent</span>
            {stage.earnedMsat > 0 && <span className="court-earned"><Zap size={13} /> +{sats(stage.earnedMsat)}</span>}
          </div>
          <h2>Thanks: we're reading it</h2>
          <p>What you earned is held for a while in case the photo can't be read (or until a reviewer marks it ok), then you can withdraw it from your account.</p>
          <button className="court-btn court-btn-ghost" onClick={again}><Camera size={16} /> Next document</button>
        </section>
      )}

      {error && <div className="court-error">{error}</div>}

      <footer className="court-bar">
        {stage.at === "start" && !signedIn && visitor.available && (
          <button className="court-btn court-btn-wide" onClick={() => void visitor.signIn()}>Sign in to start</button>
        )}
        {stage.at === "start" && signedIn && (
          <button className="court-btn court-btn-wide" onClick={() => void snap()} disabled={!camera.available || !work.task}>
            <Camera size={18} /> {camera.available ? "Snap the document" : "No camera here"}
          </button>
        )}
        {stage.at === "review" && (
          <>
            <button className="court-btn court-btn-ghost" onClick={() => void snap()}><RotateCcw size={16} /> Retake</button>
            <button className="court-btn" onClick={() => void send()} disabled={!work.task}><Send size={16} /> Send</button>
          </>
        )}
      </footer>
    </div>
  );
}
