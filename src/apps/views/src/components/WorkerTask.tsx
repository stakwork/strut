import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Briefcase, Camera, Check, Clock, ImagePlus, Loader2, LogIn, Plus, RotateCcw, X, Zap } from "lucide-react";
import {
  fieldsOf, formProblem, useAccountWidget, useCamera, useTask, useTaskFileUrl, useVisitor, type FormSchema, type UseTask, type WorkerTask as Task,
} from "@strut/kit";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ACCENT_BUTTON, TaskForm } from "./TaskForm";
import { errorText } from "../lib/format";

// The pieces of a WORKER app (plans/human-steps.md §5): what a task asks,
// the photos an answer carries, the answer's form, and a whole page that
// takes tasks one after another. `WorkerPage` is the app in one line; an app
// with a view of its own composes `WorkerTask`, `TaskPhotos` and `TaskForm`.
// The look is a phone's: a type that takes photos is camera first, any other
// form first, and every state between tasks (signed out, waiting, sent with
// what it earned, refused) a whole screen of its own.

/** msat as a worker reads it: `1,234 sats` (the rest of a sat dropped). */
export function satsText(msat: number): string {
  const n = Math.floor(msat / 1000);
  return `${n.toLocaleString("en-US")} ${n === 1 ? "sat" : "sats"}`;
}

/** What a task asks, in words: its `show.ask`, else `show.title`, else a
 *  `show` that is itself a string. */
export function taskAsk(show: unknown): string | undefined {
  if (typeof show === "string") return show.trim() || undefined;
  if (!show || typeof show !== "object" || Array.isArray(show)) return undefined;
  const o = show as Record<string, unknown>;
  for (const k of ["ask", "title"]) if (typeof o[k] === "string" && (o[k] as string).trim()) return (o[k] as string).trim();
  return undefined;
}

/** The rest of what a task shows, as label and value: `show`'s other plain
 *  fields (text, numbers, yes or no), in order. Nested values are left to an
 *  app's own view. */
export function shownFields(show: unknown): Array<[string, string]> {
  if (!show || typeof show !== "object" || Array.isArray(show)) return [];
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(show as Record<string, unknown>)) {
    if (k === "ask" || k === "title") continue;
    if (typeof v === "string" && v.trim()) out.push([k, v]);
    else if (typeof v === "number" || typeof v === "boolean") out.push([k, String(v)]);
  }
  return out;
}

/** A `show` key as a label: `posted_by` → "Posted by". */
const labelOf = (key: string) => {
  const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const IMAGE_PATH = /\.(png|jpe?g|gif|webp|avif)$/i;
/** The longest side of a photo chosen from the device: as the host's camera
 *  takes one (`CAMERA_DEFAULT_SIDE`), so a phone's photo fits the 5 MB cap. */
const CHOSEN_SIDE = 1600;

/** A photo chosen from the device, made a JPEG of at most `CHOSEN_SIDE` on
 *  its longest side; the file as it is when it cannot be drawn. */
async function shrink(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || typeof createImageBitmap !== "function") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, CHOSEN_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 1_500_000) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
    return blob ? new File([blob], file.name.replace(/\.[^.]*$/, "") + ".jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}

/** What a task pays, as a pill: `⚡ Earn 50 sats`, or `+50 sats` once earned. */
export function PayPill({ msat, earned = false, className }: { msat: number; earned?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1 rounded-full border border-amber-500/40 bg-amber-400/15 px-2.5 py-1 text-[13px] font-semibold text-amber-700 dark:text-amber-300",
        className,
      )}
    >
      <Zap className="size-3.5 fill-current" /> {earned ? `+${satsText(msat)}` : `Earn ${satsText(msat)}`}
    </span>
  );
}

/** How many files the rule takes, in words: "1 photo", "2 to 4 photos", "up to 3 photos". */
function ruleText(rule: NonNullable<Task["attachments"]>, images: boolean): string {
  const noun = (n: number) => `${images ? "photo" : "file"}${n === 1 ? "" : "s"}`;
  if (rule.min === 0) return `Up to ${rule.max} ${noun(rule.max)}, if you like`;
  return rule.min === rule.max ? `${rule.min} ${noun(rule.min)}` : `${rule.min} to ${rule.max} ${noun(rule.max)}`;
}

export interface TaskPhotosProps {
  /** The task in hand: its `attachments` rule says how many and of what. */
  task: Pick<Task, "lease" | "attachments">;
  photos: File[];
  onChange: (photos: File[]) => void;
  /** The line the camera shows over the viewfinder. */
  title?: string;
  className?: string;
}

/**
 * The photos an answer carries (plans/human-steps.md §5.6), for a task type
 * whose `attachments` rule takes files, drawn camera first: a dark stage
 * with a frame to fill and Take a photo in the host's camera (the app lists
 * `camera` in `permissions:`) or Choose one from the device. Once there is
 * one, the stage shows it, with Retake; a rule that takes more lines them up
 * underneath, each with ✕, and a tile to add another, up to the rule's `max`.
 * The page sends them with the answer, `useTask().submit(answer, photos)`.
 */
export function TaskPhotos({ task, photos, onChange, title, className }: TaskPhotosProps) {
  const camera = useCamera();
  const picker = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(0);
  const rule = task.attachments;
  const urls = useObjectUrls(photos);
  // The stage shows the photo just added.
  useEffect(() => setShown(Math.max(0, photos.length - 1)), [photos.length]);
  if (!rule) return null;
  const room = rule.max - photos.length;
  const images = rule.types.every((t) => t.startsWith("image/"));
  const add = (more: File[], at = photos.length) => onChange([...photos.slice(0, at), ...more, ...photos.slice(at)].slice(0, rule.max));
  /** Take a photo; `replace` is the one it takes the place of (Retake). */
  const take = async (replace?: number) => {
    setError(null);
    try {
      const photo = await camera.capture(title ? { title } : {});
      if (!photo) return;
      if (replace === undefined) add([photo]);
      else onChange(photos.map((p, i) => (i === replace ? photo : p)));
    } catch (err) {
      setError(errorText(err));
    }
  };
  const chosen = async (files: FileList | null) => {
    setError(null);
    if (files?.length) add(await Promise.all([...files].slice(0, Math.max(room, 1)).map(shrink)));
    if (picker.current) picker.current.value = "";
  };
  const choose = () => picker.current?.click();
  const current = photos[shown];
  const drop = (i: number) => onChange(photos.filter((_, j) => j !== i));

  return (
    <div className={cn("flex flex-col gap-3", className)} data-testid="task-photos">
      <div className="relative aspect-[4/5] w-full overflow-hidden rounded-3xl bg-zinc-950 text-zinc-50 ring-1 ring-black/5 dark:bg-zinc-900 dark:ring-white/10">
        {current ? (
          <>
            {current.type.startsWith("image/") && urls[shown] ? (
              <img src={urls[shown]} alt={`Photo ${shown + 1}`} className="absolute inset-0 size-full object-cover" />
            ) : (
              <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-zinc-300">{current.name}</div>
            )}
            <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/75 to-transparent px-3 pt-10 pb-3">
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/90 px-2.5 py-1 text-xs font-semibold text-white">
                <Check className="size-3.5" /> {images ? "Photo" : "File"} {photos.length > 1 ? `${shown + 1} of ${photos.length}` : "added"}
              </span>
              <div className="flex gap-2">
                <button type="button" className="inline-flex h-9 items-center gap-1.5 rounded-full bg-white/15 px-3.5 text-sm font-medium backdrop-blur hover:bg-white/25" onClick={() => (camera.available ? void take(shown) : (drop(shown), choose()))}>
                  <RotateCcw className="size-4" /> Retake
                </button>
                <button type="button" aria-label={`Remove ${images ? "photo" : "file"} ${shown + 1}`} className="grid size-9 place-items-center rounded-full bg-white/15 backdrop-blur hover:bg-white/25" onClick={() => drop(shown)}>
                  <X className="size-4" />
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_38%,rgb(245_197_66/0.18),transparent_62%)]" />
            <Corners />
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-8 text-center">
              <div className="grid size-20 place-items-center rounded-3xl border border-amber-400/40 bg-amber-400/15 text-amber-300">
                {images ? <Camera className="size-9" /> : <ImagePlus className="size-9" />}
              </div>
              <p className="text-[15px] leading-snug text-zinc-300">{images ? "Fill the frame. Flat, sharp and in good light." : "Add the file your answer needs."}</p>
              <Button type="button" className={cn("h-12 rounded-xl px-6 text-base font-semibold", ACCENT_BUTTON)} onClick={() => (camera.available && images ? void take() : choose())}>
                {camera.available && images ? <Camera /> : <ImagePlus />}
                {camera.available && images ? "Take a photo" : images ? "Choose a photo" : "Choose a file"}
              </Button>
              {camera.available && images && (
                <button type="button" className="text-sm text-zinc-400 underline-offset-4 hover:underline" onClick={choose}>
                  or choose one from this device
                </button>
              )}
            </div>
          </>
        )}
      </div>
      {(rule.max > 1 || photos.length > 1) && (photos.length > 0 || room > 0) && (
        <div className="flex flex-wrap items-center gap-2">
          {photos.map((p, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Show ${images ? "photo" : "file"} ${i + 1}`}
              className={cn("relative size-16 overflow-hidden rounded-xl border-2 bg-muted", i === shown ? "border-amber-400" : "border-transparent")}
              onClick={() => setShown(i)}
            >
              {p.type.startsWith("image/") && urls[i] ? <img src={urls[i]} alt="" className="size-full object-cover" /> : <span className="p-1 text-[10px]">{p.name}</span>}
            </button>
          ))}
          {room > 0 && photos.length > 0 && (
            <button
              type="button"
              aria-label={images ? "Add a photo" : "Add a file"}
              className="grid size-16 place-items-center rounded-xl border-2 border-dashed border-muted-foreground/30 text-muted-foreground hover:bg-muted"
              onClick={() => (camera.available && images ? void take() : choose())}
            >
              <Plus className="size-5" />
            </button>
          )}
        </div>
      )}
      <p className="text-[13px] text-muted-foreground">
        {ruleText(rule, images)} with your answer{photos.length > 0 && rule.max > 1 ? ` · ${photos.length} added` : ""}
      </p>
      {error && <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      <input ref={picker} type="file" accept={rule.types.join(",")} multiple={room > 1} hidden onChange={(e) => void chosen(e.target.files)} />
    </div>
  );
}

/** A viewfinder's four corners, in the accent. */
function Corners() {
  const corner = "absolute size-9 border-amber-400";
  return (
    <div aria-hidden className="pointer-events-none absolute inset-[7%]">
      <span className={cn(corner, "top-0 left-0 rounded-tl-xl border-t-[3px] border-l-[3px]")} />
      <span className={cn(corner, "top-0 right-0 rounded-tr-xl border-t-[3px] border-r-[3px]")} />
      <span className={cn(corner, "bottom-0 left-0 rounded-bl-xl border-b-[3px] border-l-[3px]")} />
      <span className={cn(corner, "right-0 bottom-0 rounded-br-xl border-r-[3px] border-b-[3px]")} />
    </div>
  );
}

/** A `blob:` URL for each file, revoked when it goes. */
function useObjectUrls(files: File[]): string[] {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const made = files.map((f) => URL.createObjectURL(f));
    setUrls(made);
    return () => made.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);
  return urls;
}

/** One of a task's own files, drawn when it is an image. */
function TaskFileImage({ task, path }: { task: Pick<Task, "lease">; path: string }) {
  const file = useTaskFileUrl(task, path);
  if (file.error) return null;
  return (
    <div className="overflow-hidden rounded-2xl border bg-muted/50">
      {file.url ? <img src={file.url} alt={path} className="max-h-[55vh] w-full object-contain" /> : <div className="aspect-[4/3] w-full animate-pulse bg-muted" />}
    </div>
  );
}

export interface WorkerTaskProps {
  /** The task in hand (`useTask().task`). */
  task: Task;
  /** `useTask().submit`: the answer, with the photos when the type takes them. */
  submit: UseTask["submit"];
  /** `useTask().skip`; no Skip button without it. */
  skip?: UseTask["skip"];
  /** The send button's text. */
  label?: string;
  className?: string;
}

/**
 * Any task, drawn with no view of its own, for a phone: what it pays and
 * what it asks (`show.ask`, the rest of `show`'s plain fields, the task's
 * image files), then — for a type that takes photos — the camera's stage
 * (`TaskPhotos`), then the answer's fields (`TaskForm`), and Skip and Send in
 * a bar held at the bottom. Send stays off until the photos the rule needs
 * are there. Fit for a type whose answer is plain fields and a photo; a type
 * that needs more (a box on a photo) is drawn by the app's own view.
 */
export function WorkerTask({ task, submit, skip, label, className }: WorkerTaskProps) {
  const [photos, setPhotos] = useState<File[]>([]);
  // A new task starts with no photos.
  useEffect(() => setPhotos([]), [task.lease]);
  const ask = taskAsk(task.show);
  const fields = shownFields(task.show);
  const rule = task.attachments;
  const images = task.files.filter((p) => IMAGE_PATH.test(p));
  const short = rule && photos.length < rule.min ? rule.min - photos.length : 0;
  const waitingFor = short ? `Add ${short === 1 ? (rule!.min === 1 ? "a photo" : "1 more photo") : `${short} more photos`} to send.` : undefined;
  const send = async (answer: Record<string, unknown>) => {
    if (short) throw new Error(waitingFor);
    await submit(answer, photos);
  };
  return (
    <div className={cn("flex flex-1 flex-col gap-5", className)} data-testid="worker-task">
      <div className="flex flex-col gap-2.5">
        {task.payMsat > 0 && <PayPill msat={task.payMsat} />}
        <h2 className="text-[22px] leading-tight font-semibold tracking-tight text-balance">{ask ?? "A task for you"}</h2>
        {fields.length > 0 && (
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-2xl border bg-muted/40 px-4 py-3 text-sm">
            {fields.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{labelOf(k)}</dt>
                <dd className="m-0 font-medium break-words whitespace-pre-line">{v}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      {images.map((p) => (
        <TaskFileImage key={p} task={task} path={p} />
      ))}
      {rule && <TaskPhotos task={task} photos={photos} onChange={setPhotos} {...(ask ? { title: ask } : {})} />}
      <TaskForm task={task} onSubmit={send} {...(skip ? { onSkip: () => skip() } : {})} label={label ?? "Send"} bar {...(waitingFor ? { waitingFor } : {})} />
    </div>
  );
}

export interface WorkerPageProps {
  /** One task type alone; left out, any type this app draws. */
  type?: string;
  /** The app's name, in the header. */
  title?: string;
  /** The header's second line: what the work is, in a few words. */
  subtitle?: string;
  /** The header's mark (a lucide icon); a briefcase without one. */
  icon?: ReactNode;
  /** What the work is, shown before sign-in (never once signed in: it asks them to sign in). */
  intro?: ReactNode;
  className?: string;
}

/** What was sent, for the screen after: what it earned and the answer as given. */
interface Sent {
  msat: number;
  answer: Record<string, unknown>;
  schema: unknown;
  photos: File[];
}

/**
 * A worker app's whole page, phone first: a header with the app's mark, then
 * one screen at a time — sign in; the task in hand, drawn by `WorkerTask`
 * with its photos and sent with them; what the last answer earned (held
 * until it clears), with the answer as given and Next task; and while there
 * is no task, that it is looking, or why the viewer may take none here. The
 * app grants `task/next`, `task/submit` and `task/skip` (`task/file` to show
 * a task's files; `task/me` and `task/withdraw` for the account widget's
 * balance and Withdraw) and lists `camera` in `permissions:` for Take a photo.
 */
export function WorkerPage({ type, title = "Work", subtitle = "Do tasks · get paid", icon, intro, className }: WorkerPageProps) {
  const visitor = useVisitor();
  const account = useAccountWidget();
  const signedIn = !!visitor.actor;
  const work = useTask(type, { enabled: signedIn });
  const [sent, setSent] = useState<Sent | null>(null);
  const submit: UseTask["submit"] = async (answer, files) => {
    const held = work.task;
    await work.submit(answer, files);
    setSent({ msat: held?.payMsat ?? 0, answer: (answer ?? {}) as Record<string, unknown>, schema: held?.answer, photos: [...(files ?? [])] });
  };
  const mark = icon ?? <Briefcase className="size-4" />;

  let body: ReactNode;
  if (!signedIn) {
    body = (
      <Screen
        icon={mark}
        heading="Get paid for small tasks"
        text={intro ?? "Sign in, then answer the tasks that show up here. Each one pays what it says."}
        bar={
          visitor.available ? (
            <Button className={cn("h-12 w-full rounded-xl text-base font-semibold", ACCENT_BUTTON)} onClick={() => void visitor.signIn()}>
              <LogIn /> Sign in to start
            </Button>
          ) : (
            <p className="text-center text-sm text-muted-foreground">Signing in isn't open on this page.</p>
          )
        }
      />
    );
  } else if (sent) {
    body = <SentScreen sent={sent} next={!!work.task} onNext={() => setSent(null)} />;
  } else if (work.task) {
    body = <WorkerTask key={work.task.lease} task={work.task} submit={submit} skip={work.skip} />;
  } else if (work.status === "inactive") {
    body = (
      <Screen
        icon={<Clock className="size-10" />}
        heading="You're signed in"
        text={
          <>
            There's no work for you here yet.{work.error ? ` ${reason(work.error)}` : ""}
            <span className="mt-3 block text-[13px]">This page checks again on its own.</span>
          </>
        }
      />
    );
  } else if (work.status === "error") {
    body = (
      <Screen
        tone="error"
        icon={<AlertTriangle className="size-10" />}
        heading="Can't reach the work"
        text={
          <>
            {work.error ? reason(work.error) || errorText(work.error) : "Something went wrong."}
            <span className="mt-3 flex items-center justify-center gap-1.5 text-[13px]">
              <Loader2 className="size-3.5 animate-spin" /> Trying again…
            </span>
          </>
        }
      />
    );
  } else {
    body = (
      <Screen
        icon={<Loader2 className="size-10 animate-spin [animation-duration:2.4s]" />}
        heading="Looking for work…"
        text="No tasks right now. The next one shows up here."
      />
    );
  }

  return (
    <div className={cn("mx-auto flex min-h-dvh w-full max-w-xl flex-col bg-background text-foreground", className)} data-testid="worker-page">
      <header className={cn("sticky top-0 z-20 flex items-center gap-2.5 bg-background/90 px-4 pt-3.5 pb-3 backdrop-blur", account.available && "pr-44")}>
        <div className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-amber-400 text-amber-950 [&_svg]:size-4">{mark}</div>
        <div className="min-w-0">
          <div className="truncate text-[15px] leading-tight font-semibold">{title}</div>
          {subtitle && <div className="truncate text-xs text-muted-foreground">{subtitle}</div>}
        </div>
      </header>
      <main className="flex flex-1 flex-col px-4 pt-1">{body}</main>
    </div>
  );
}

/** A whole screen between tasks: a mark, a heading, a line, and what to do
 *  in the bar at the bottom. */
function Screen({ icon, heading, text, bar, tone = "accent", children }: { icon: ReactNode; heading: string; text?: ReactNode; bar?: ReactNode; tone?: "accent" | "done" | "error"; children?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col" role={tone === "error" ? "alert" : "status"}>
      <div className="relative flex flex-1 flex-col items-center justify-center gap-3 px-1 py-10 text-center">
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 -z-0",
            tone === "accent" && "bg-[radial-gradient(260px_circle_at_50%_42%,rgb(245_197_66/0.16),transparent)]",
            tone === "done" && "bg-[radial-gradient(260px_circle_at_50%_30%,rgb(16_185_129/0.16),transparent)]",
            tone === "error" && "bg-[radial-gradient(260px_circle_at_50%_42%,rgb(239_68_68/0.14),transparent)]",
          )}
        />
        <div
          className={cn(
            "relative grid size-22 place-items-center rounded-[26px] border [&_svg]:size-10",
            tone === "accent" && "border-amber-500/35 bg-amber-400/15 text-amber-600 dark:text-amber-300",
            tone === "done" && "border-emerald-500/35 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
            tone === "error" && "border-destructive/35 bg-destructive/10 text-destructive",
          )}
        >
          {icon}
        </div>
        <h1 className="relative mt-2 text-2xl font-semibold tracking-tight text-balance">{heading}</h1>
        {text && <div className="relative max-w-sm text-[15px] leading-relaxed text-muted-foreground">{text}</div>}
        {children}
      </div>
      {bar && <div className="sticky bottom-0 bg-background pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]">{bar}</div>}
    </div>
  );
}

/** After an answer: sent, what it earned (held until it clears), the answer
 *  as given, and Next task. */
function SentScreen({ sent, next, onNext }: { sent: Sent; next: boolean; onNext: () => void }) {
  const rows = answerRows(sent.answer, sent.schema);
  const urls = useObjectUrls(sent.photos);
  return (
    <Screen
      tone="done"
      icon={<Check className="size-10" strokeWidth={2.5} />}
      heading="Sent. Thank you!"
      text={sent.msat > 0 ? "Earned and held for a while, then it's yours to withdraw. Your balance is in the corner." : "Your answer is in."}
      bar={
        <Button className={cn("h-12 w-full rounded-xl text-base font-semibold", ACCENT_BUTTON)} onClick={onNext}>
          {next ? (
            <>
              Next task <span aria-hidden>→</span>
            </>
          ) : (
            "Done"
          )}
        </Button>
      }
    >
      {sent.msat > 0 && (
        <div className="relative flex flex-wrap justify-center gap-2">
          <PayPill msat={sent.msat} earned />
          <span className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[13px] font-medium text-muted-foreground">
            <Clock className="size-3.5" /> Held
          </span>
        </div>
      )}
      {(rows.length > 0 || urls.length > 0) && (
        <div className="relative mt-4 w-full rounded-2xl border bg-card p-4 text-left shadow-sm">
          <div className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Your answer</div>
          {urls.length > 0 && (
            <div className="mb-3 flex gap-2">
              {urls.map((u, i) => (
                <img key={u} src={u} alt={`Photo ${i + 1}`} className="size-16 rounded-xl border object-cover" />
              ))}
            </div>
          )}
          {rows.length > 0 && (
            <dl className="flex flex-col gap-2.5 text-sm">
              {rows.map(([k, v]) => (
                <div key={k}>
                  <dt className="text-[13px] text-muted-foreground">{k}</dt>
                  <dd className="m-0 font-medium break-words">{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </Screen>
  );
}

/** An answer as label and value, in its schema's order and words. */
function answerRows(answer: Record<string, unknown>, schema: unknown): Array<[string, string]> {
  const fields = formProblem(schema) ? [] : fieldsOf(schema as FormSchema, { other: false });
  const out: Array<[string, string]> = [];
  for (const f of fields) {
    const v = answer[f.name];
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
    const text = (x: unknown) => f.enumLabels?.[String(x)] ?? String(x);
    out.push([f.label ?? labelOf(f.name), typeof v === "boolean" ? (v ? "Yes" : "No") : Array.isArray(v) ? v.map(text).join(", ") : text(v)]);
  }
  return out;
}

/** A task refusal's sentence, its code dropped: "an admin decides who takes tasks here". */
function reason(err: Error): string {
  const text = err.message.replace(/^[a-z_]+:\s*/, "");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? "" : ".") : "";
}
