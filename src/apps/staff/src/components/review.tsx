// What the answers' screens share (Answers, a group, one answer): a worker's
// name, a task's file read through `staff/file` as it comes into view, and
// the verdict on one answer (§9.6) where the answer is listed.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlignLeft, Check, FileText, Image as ImageIcon, X } from "lucide-react";
import { useStrutClient } from "@strut/kit";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fmtWhen, isPicture, shortActor, whoOf } from "../lib/view";
import type { Lease, TaskFile, Verdict, Worker } from "../lib/types";
import { ErrorLine, Loading, Note, Picture } from "./bits";

/** A worker's name here, from the list read. */
export function useWho(workers: Worker[] | undefined) {
  const byActor = useMemo(() => new Map((workers ?? []).map((w) => [w.actor, w])), [workers]);
  return (actor: string) => {
    const w = byActor.get(actor);
    return w ? whoOf(w) : shortActor(actor);
  };
}

/** Whether the element has come into view, once (`on` false: never asked).
 *  A page with ten pictures reads the ones in view, then each as it is
 *  scrolled to, not all ten at once. */
export function useSeen<T extends Element>(on: boolean) {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!on || seen || !el) return;
    if (typeof IntersectionObserver === "undefined") return setSeen(true);
    const watch = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setSeen(true));
    watch.observe(el);
    return () => watch.disconnect();
  }, [on, seen]);
  return [ref, seen] as const;
}

/** One file of a task, read once: its key is outside ["staff", …], so a
 *  review's reads again never read a picture again. `version` is in the key:
 *  a reply's files are read again when a later reply (its `at`) replaces it,
 *  even under the same path. */
function useTaskFile(o: { task: string; path: string; version?: number | undefined; enabled: boolean }) {
  const client = useStrutClient();
  return useQuery({
    queryKey: ["staff-file", o.task, o.path, o.version ?? 0],
    queryFn: () => client.run<TaskFile>("staff/file", { task: o.task, path: o.path }),
    enabled: o.enabled,
    staleTime: Infinity,
    retry: false,
  });
}

/** A task's picture in a box of the size `className` gives it, read when it
 *  scrolls into view: whatever the answer carried, cut to fill the box
 *  (`fit`: shown whole). With no `file`, a plain box: an answer with no
 *  picture (`words`: one of fields alone), or (`dashed`) no answer at all. */
export function Thumb(props: { task: string; file?: { path: string; mediaType?: string; name?: string } | undefined; version?: number | undefined; className?: string; fit?: boolean; dashed?: boolean; words?: boolean }) {
  const [box, seen] = useSeen<HTMLSpanElement>(!!props.file);
  const q = useTaskFile({ task: props.task, path: props.file?.path ?? "", version: props.version, enabled: !!props.file && seen });
  const f = q.data;
  const shown = f?.base64 && f.mediaType.startsWith("image/");
  // Spans: it sits inside a row's or a tile's button.
  return (
    <span
      ref={box}
      aria-hidden={!shown}
      className={cn("relative grid shrink-0 place-items-center overflow-hidden rounded-md text-muted-foreground", props.dashed ? "border border-dashed" : "bg-muted", props.className)}
    >
      {shown ? (
        <img alt={props.file?.name ?? "The picture sent"} className={cn("absolute inset-0 h-full w-full", props.fit ? "object-contain" : "object-cover")} src={`data:${f.mediaType};base64,${f.base64}`} />
      ) : props.file && !q.error && !f ? (
        <span className="absolute inset-0 animate-pulse bg-muted-foreground/10" />
      ) : props.dashed ? null : props.words ? (
        <AlignLeft className="size-4 opacity-60" />
      ) : (
        <ImageIcon className="size-4 opacity-60" />
      )}
    </span>
  );
}

/** One of a task's files through `staff/file`. A picture is read as it
 *  comes into view and drawn (a click shows it full size); text and any other
 *  file are read when opened. Its error is its own: a file that is gone says
 *  so, and the rest still draw. `large`: the answer itself, given room. */
export function TaskFileView(props: { task: string; path: string; mediaType?: string; version?: number; large?: boolean }) {
  const picture = isPicture(props.path, props.mediaType);
  const [open, setOpen] = useState(false);
  const [box, seen] = useSeen<HTMLDivElement>(picture);
  const q = useTaskFile({ task: props.task, path: props.path, version: props.version, enabled: picture ? seen : open });
  const f = q.data;
  const name = props.path.split("/").pop() ?? props.path;
  return (
    <div ref={box} className="flex min-w-0 flex-col gap-1.5">
      {(picture || open) &&
        (q.error ? (
          <ErrorLine error={q.error} />
        ) : !f ? (
          picture ? <div className={cn("w-full animate-pulse rounded-md bg-muted", props.large ? "h-80" : "h-40 max-w-sm")} /> : <Loading />
        ) : (
          <>
            {f.base64 && f.mediaType.startsWith("image/") ? (
              <Picture alt={name} className={cn("max-w-full rounded-md", props.large ? "max-h-[32rem]" : "max-h-64")} src={`data:${f.mediaType};base64,${f.base64}`} />
            ) : f.text !== undefined ? (
              <pre className="max-h-96 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">{f.text}</pre>
            ) : f.base64 ? (
              <a className="text-sm underline" download={name} href={`data:${f.mediaType};base64,${f.base64}`}>
                Download ({f.bytes.toLocaleString("en-US")} bytes)
              </a>
            ) : null}
            {f.truncated && <Note>Cut at the size a page can be handed.</Note>}
          </>
        ))}
      {picture ? (
        <div className="flex items-center gap-1.5 text-xs break-all text-muted-foreground" title={props.path}>
          <ImageIcon className="size-3.5 shrink-0" /> {name}
        </div>
      ) : (
        <button type="button" className="flex w-fit items-center gap-1.5 text-left text-sm font-medium break-all underline-offset-2 hover:underline" title={props.path} onClick={() => setOpen((o) => !o)}>
          <FileText className="size-4 shrink-0" /> {name}
        </button>
      )}
    </div>
  );
}

/** A verdict as a mark: a word and a sign, never the colour alone. */
export function VerdictBadge(props: { verdict: Verdict }) {
  return props.verdict === "ok" ? (
    <span className="inline-flex w-fit items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
      <Check className="size-3" strokeWidth={3} /> OK
    </span>
  ) : (
    <span className="inline-flex w-fit items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-semibold text-destructive">
      <X className="size-3" strokeWidth={3} /> Rejected
    </span>
  );
}

/** Whether an answer's verdict can still be given or changed: a first one
 *  always; a given one until the answer's hold ends. */
export function reviewOpen(l: Pick<Lease, "review">, now = Date.now()): boolean {
  return !l.review || (!l.review.final && l.review.until > now);
}

/**
 * §9.6: one answer's verdict, where the answer is listed. With none: OK and
 * Reject. Reject asks why on a line in the page (an app frame has no
 * prompt), and the reason is what the worker reads. With one: the verdict,
 * its reason, and Change while it can change. `big`: the answer's own page.
 * `rejecting` and `onRejecting`: the page opens the reason line itself (its
 * R key).
 */
export function ReviewControl(props: {
  lease: Lease;
  busy: boolean;
  onReview: (verdict: Verdict, why?: string) => void;
  big?: boolean;
  rejecting?: boolean;
  onRejecting?: (open: boolean) => void;
}) {
  const r = props.lease.review;
  const [changing, setChanging] = useState(false);
  const [mine, setMine] = useState(false);
  const rejecting = props.rejecting ?? mine;
  const setRejecting = props.onRejecting ?? setMine;
  const [why, setWhy] = useState("");
  // A verdict that came back closes what was open.
  useEffect(() => {
    setChanging(false);
    setRejecting(false);
    setWhy("");
  }, [r?.verdict, r?.why, r?.at]);
  const size = props.big ? "lg" : "sm";
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  if (rejecting) {
    return (
      <div className="flex min-w-0 flex-col gap-1.5" onClick={stop}>
        <input
          autoFocus
          aria-label="Why it is rejected"
          className={cn("w-full min-w-0 rounded-md border bg-background px-2 text-sm", props.big ? "h-10" : "h-8")}
          placeholder="Why? The worker reads this"
          value={why}
          onChange={(e) => setWhy(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") setRejecting(false);
            if (e.key === "Enter" && why.trim()) props.onReview("rejected", why.trim());
          }}
        />
        <div className="flex gap-1.5">
          <Button size={size} variant="destructive" className="flex-1" disabled={props.busy || !why.trim()} onClick={() => props.onReview("rejected", why.trim())}>
            Reject
          </Button>
          <Button size={size} variant="ghost" onClick={() => setRejecting(false)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  if (!r || changing) {
    return (
      <div className={cn("flex min-w-0 gap-1.5", props.big && "flex-col")} onClick={stop}>
        {r?.verdict !== "ok" && (
          <Button size={size} variant={props.big ? "default" : "outline"} className={props.big ? "w-full" : "flex-1"} disabled={props.busy} onClick={() => props.onReview("ok")}>
            <Check className={props.big ? undefined : "text-emerald-600 dark:text-emerald-400"} strokeWidth={2.5} /> {props.big ? "Mark OK" : "OK"}
          </Button>
        )}
        <Button size={size} variant="outline" className={props.big ? "w-full" : "flex-1"} disabled={props.busy} onClick={() => setRejecting(true)}>
          <X className="text-destructive" strokeWidth={2.5} /> {r?.verdict === "rejected" ? "Change the reason" : props.big ? "Reject, with a reason" : "Reject"}
        </Button>
        {changing && (
          <Button size={size} variant="ghost" onClick={() => setChanging(false)}>
            Cancel
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-1" onClick={stop}>
      <div className="flex min-w-0 items-center gap-2">
        <VerdictBadge verdict={r.verdict} />
        {reviewOpen(props.lease) ? (
          <button type="button" className="ml-auto text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setChanging(true)}>
            Change
          </button>
        ) : (
          <span className="ml-auto text-xs text-muted-foreground">final</span>
        )}
      </div>
      {r.why && <div className="text-xs break-words text-muted-foreground">{r.why}</div>}
      {props.big && (
        <div className="text-xs text-muted-foreground">
          {r.by ? `By ${r.by}, ` : ""}
          {fmtWhen(r.at)}
          {reviewOpen(props.lease) ? ` · can change until ${fmtWhen(r.until)}` : ""}
        </div>
      )}
    </div>
  );
}
