// A captcha a job hit and cannot solve (Hive's captcha card; strut's
// src/browser/captcha.ts): the crop, its instruction and clock, and the
// answer — tiles or points tapped on the image, or text typed, or Skip —
// sent as the job's next turn (`[captcha-answer] {…}`, job.yaml runs
// browser-captcha with it), naming the conversation so strut wakes it when
// that turn ends. Never solved by a model.
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ShieldQuestion } from "lucide-react";
import { useStrutClient } from "@strut/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { captchaPrompt, cellOf, msLeft, parseCaptcha, tapAt, toggleCell, type CaptchaAnswer, type Tap } from "../lib/jobs";
import type { FileRun } from "../lib/artifacts";
import { useViewer } from "../viewer";
import { isOwn, sendRefusal } from "../lib/chat";
import type { JobView } from "../lib/types";
import { Notice, errorText } from "./bits";
import { useJobRun } from "./ArtifactCard";

interface RunFile {
  text?: string;
  base64?: string;
  mediaType: string;
}

export function CaptchaCard({ title, job, path, run: given, conversation }: { title: string; job: string; path: string; run?: FileRun; conversation?: string }) {
  const client = useStrutClient();
  const viewer = useViewer();
  const found = useJobRun(given ? undefined : job);
  const run = given ?? found.data;
  const jobView = useQuery({ queryKey: ["assistant", "job-view", job], queryFn: () => client.run<JobView>("job/get", { job }), staleTime: 10_000 });
  const manifestQ = useQuery({
    queryKey: ["assistant", "captcha", job, path, run?.runId],
    enabled: !!run,
    queryFn: () => client.run<RunFile | null>("run/files", { workflow: run!.workflow, runId: run!.runId, path }),
    refetchInterval: 10_000,
  });
  const manifest = parseCaptcha(manifestQ.data?.text);
  const imagePath = manifest ? path.replace(/[^/]*$/, manifest.image) : undefined;
  const image = useQuery({
    queryKey: ["assistant", "captcha-image", job, imagePath, run?.runId],
    enabled: !!run && !!imagePath,
    staleTime: Infinity,
    queryFn: () => client.run<RunFile | null>("run/files", { workflow: run!.workflow, runId: run!.runId, path: imagePath }),
  });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const [taps, setTaps] = useState<Tap[]>([]);
  const [text, setText] = useState("");
  const [sent, setSent] = useState<{ state: "idle" | "busy" | "sent" } | { state: "failed"; error: string }>({ state: "idle" });
  const img = useRef<HTMLImageElement>(null);

  if (manifestQ.isError) return <Notice tone="error">{errorText(manifestQ.error)}</Notice>;
  if (!manifest) return <Notice>{manifestQ.isPending || !run ? "Reading the captcha…" : "This captcha could not be read."}</Notice>;

  const left = msLeft(manifest.expiresAt, now);
  const expired = manifest.state === "expired" || (left !== null && left <= 0);
  const waiting = manifest.state === "waiting" && !expired;
  const actors = jobView.data?.actors;
  const mine = !actors || (!!viewer && actors.includes(viewer));
  const canAnswer = waiting && mine && sent.state !== "sent";
  const workflow = jobView.data?.workflow ?? "job";

  const submit = async (body: { taps: Tap[] } | { text: string } | { skip: true }) => {
    setSent({ state: "busy" });
    const answer = { round: manifest.round, site: manifest.site, ...body } as CaptchaAnswer;
    try {
      await client.run("run/launch", {
        workflow,
        job,
        input: { prompt: captchaPrompt(answer) },
        ...(conversation && isOwn(conversation, viewer) ? { conversation } : {}),
      });
      setSent({ state: "sent" });
    } catch (err) {
      const r = sendRefusal(errorText(err));
      setSent({ state: "failed", error: r.kind === "busy" ? "The job is still working — try again in a minute." : r.text });
    }
  };

  const src = image.data?.base64 ? `data:${image.data.mediaType};base64,${image.data.base64}` : undefined;
  const grid = manifest.grid;
  return (
    <div className="rounded-lg border bg-card p-3 text-card-foreground" data-testid="captcha-card">
      <div className="flex items-center gap-2 text-sm font-medium">
        <ShieldQuestion className="size-4 text-amber-600" />
        <span className="min-w-0 flex-1 truncate">{title || "A captcha to solve"}</span>
        <span className="shrink-0 text-xs font-normal text-muted-foreground">
          {manifest.site} · round {manifest.round} of {manifest.maxRounds}
          {left !== null && waiting && ` · ${Math.max(0, Math.ceil(left / 1000))}s`}
        </span>
      </div>
      {manifest.instruction && <p className="mt-1 text-sm">{manifest.instruction}</p>}
      {src && (
        <div
          className={cn("relative mt-2 inline-block max-w-full select-none", canAnswer && manifest.mode !== "text" && "cursor-pointer")}
          onPointerUp={(e) => {
            if (!canAnswer || manifest.mode === "text" || !img.current) return;
            const t = tapAt(e.clientX, e.clientY, img.current.getBoundingClientRect());
            setTaps((prev) => (grid ? toggleCell(prev, t, grid) : [...prev, t]));
          }}
        >
          <img ref={img} src={src} alt="The captcha" className="block max-h-80 max-w-full rounded border" draggable={false} />
          {grid &&
            taps.map((t, i) => {
              const c = cellOf(t, grid);
              return (
                <span
                  key={i}
                  className="pointer-events-none absolute border-2 border-sky-500 bg-sky-500/30"
                  style={{ left: `${(c.col / grid.cols) * 100}%`, top: `${(c.row / grid.rows) * 100}%`, width: `${100 / grid.cols}%`, height: `${100 / grid.rows}%` }}
                />
              );
            })}
          {!grid &&
            taps.map((t, i) => (
              <span key={i} className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-sky-500" style={{ left: `${t.nx * 100}%`, top: `${t.ny * 100}%` }} />
            ))}
        </div>
      )}
      {sent.state === "sent" || manifest.state === "sent" || manifest.state === "solved" ? (
        <p className="mt-2 flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-300">
          <Check className="size-3.5" />
          {manifest.state === "solved" ? "Solved." : "Sent to the job as its next turn."}
        </p>
      ) : expired ? (
        <Notice>This round expired.</Notice>
      ) : !mine ? (
        <Notice>Only the person who started this job can answer it.</Notice>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {manifest.mode !== "tap" && (
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type what it shows" className="h-8 w-56" aria-label="Captcha text" />
          )}
          <Button
            size="sm"
            disabled={sent.state === "busy" || (taps.length === 0 && !text.trim())}
            onClick={() => void submit(text.trim() ? { text: text.trim() } : { taps })}
          >
            Send answer
          </Button>
          {taps.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setTaps([])}>
              Clear
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={sent.state === "busy"} onClick={() => void submit({ skip: true })}>
            Skip
          </Button>
        </div>
      )}
      {sent.state === "failed" && <Notice tone="error">{sent.error}</Notice>}
    </div>
  );
}
