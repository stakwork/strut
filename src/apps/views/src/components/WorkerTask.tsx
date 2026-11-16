import { useEffect, useRef, useState, type ReactNode } from "react";
import { Camera, Check, ImagePlus, Loader2, LogIn, X, Zap } from "lucide-react";
import { useCamera, useTask, useTaskFileUrl, useVisitor, type UseTask, type WorkerTask as Task } from "@strut/kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TaskForm } from "./TaskForm";
import { errorText } from "../lib/format";

// The pieces of a WORKER app (plans/human-steps.md §5): what a task asks,
// the photos an answer carries, the answer's form, and a whole page that
// takes tasks one after another. `WorkerPage` is the app in one line; an app
// with a view of its own composes `WorkerTask`, `TaskPhotos` and `TaskForm`.

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
 * whose `attachments` rule takes files: Take a photo in the host's camera
 * (the app lists `camera` in `permissions:`) or Choose one from the device,
 * at most the rule's `max`; each shown, with ✕ to drop it. The page sends
 * them with the answer, `useTask().submit(answer, photos)`.
 */
export function TaskPhotos({ task, photos, onChange, title, className }: TaskPhotosProps) {
  const camera = useCamera();
  const picker = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const rule = task.attachments;
  const urls = useObjectUrls(photos);
  if (!rule) return null;
  const room = rule.max - photos.length;
  const add = (more: File[]) => onChange([...photos, ...more].slice(0, rule.max));
  const take = async () => {
    setError(null);
    try {
      const photo = await camera.capture(title ? { title } : {});
      if (photo) add([photo]);
    } catch (err) {
      setError(errorText(err));
    }
  };
  const chosen = async (files: FileList | null) => {
    setError(null);
    if (files?.length) add(await Promise.all([...files].slice(0, room).map(shrink)));
    if (picker.current) picker.current.value = "";
  };
  const images = rule.types.every((t) => t.startsWith("image/"));
  return (
    <div className={cn("flex flex-col gap-2", className)} data-testid="task-photos">
      {photos.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {photos.map((p, i) => (
            <div key={i} className="relative overflow-hidden rounded-lg border bg-muted">
              {p.type.startsWith("image/") && urls[i] ? (
                <img src={urls[i]} alt={`Photo ${i + 1}`} className="aspect-square w-full object-cover" />
              ) : (
                <div className="flex aspect-square items-center justify-center p-2 text-xs text-muted-foreground">{p.name}</div>
              )}
              <button
                type="button"
                aria-label={`Remove ${images ? "photo" : "file"} ${i + 1}`}
                className="absolute top-1 right-1 rounded-full bg-background/90 p-1 shadow"
                onClick={() => onChange(photos.filter((_, j) => j !== i))}
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      {room > 0 && (
        <div className="flex flex-wrap gap-2">
          {camera.available && (
            <Button type="button" onClick={() => void take()}>
              <Camera /> {photos.length ? "Take another" : "Take a photo"}
            </Button>
          )}
          <Button type="button" variant={camera.available ? "outline" : "default"} onClick={() => picker.current?.click()}>
            <ImagePlus /> {images ? "Choose a photo" : "Choose a file"}
          </Button>
          <input ref={picker} type="file" accept={rule.types.join(",")} multiple={room > 1} hidden onChange={(e) => void chosen(e.target.files)} />
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {rule.min > 0 ? `${rule.min === rule.max ? rule.min : `${rule.min} to ${rule.max}`} ${images ? "photo" : "file"}${rule.max === 1 ? "" : "s"} with your answer` : `Up to ${rule.max} ${images ? "photo" : "file"}${rule.max === 1 ? "" : "s"} with your answer`}
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
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
  if (!file.url) return null;
  return <img src={file.url} alt={path} className="max-h-80 w-full rounded-lg border object-contain" />;
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
 * Any task, drawn with no view of its own: what it pays, what it asks
 * (`show.ask`, the rest of `show`'s plain fields, the task's image files),
 * the photos its type takes (`TaskPhotos`) and the answer's fields
 * (`TaskForm`). Fit for a type whose answer is plain fields and a photo;
 * a type that needs more (a box on a photo) is drawn by the app's own view.
 */
export function WorkerTask({ task, submit, skip, label, className }: WorkerTaskProps) {
  const [photos, setPhotos] = useState<File[]>([]);
  // A new task starts with no photos.
  useEffect(() => setPhotos([]), [task.lease]);
  const ask = taskAsk(task.show);
  const fields = shownFields(task.show);
  const rule = task.attachments;
  const send = async (answer: Record<string, unknown>) => {
    if (rule && photos.length < rule.min) {
      throw new Error(rule.min === 1 ? "Add a photo first." : `Add ${rule.min} photos first.`);
    }
    await submit(answer, photos);
  };
  return (
    <div className={cn("flex flex-col gap-4", className)} data-testid="worker-task">
      <div className="flex flex-col gap-2">
        {task.payMsat > 0 && (
          <Badge variant="secondary" className="w-fit gap-1">
            <Zap className="size-3" /> Earn {satsText(task.payMsat)}
          </Badge>
        )}
        <h2 className="text-lg font-semibold leading-snug">{ask ?? "A task for you"}</h2>
        {fields.length > 0 && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            {fields.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="m-0 break-words">{v}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      {task.files.filter((p) => IMAGE_PATH.test(p)).map((p) => (
        <TaskFileImage key={p} task={task} path={p} />
      ))}
      {rule && <TaskPhotos task={task} photos={photos} onChange={setPhotos} {...(ask ? { title: ask } : {})} />}
      <TaskForm task={task} onSubmit={send} {...(skip ? { onSkip: () => skip() } : {})} label={label ?? (rule ? "Send" : "Submit")} />
    </div>
  );
}

export interface WorkerPageProps {
  /** One task type alone; left out, any type this app draws. */
  type?: string;
  title?: string;
  /** What the work is, shown before sign-in and while there is none. */
  intro?: ReactNode;
  className?: string;
}

/**
 * A worker app's whole page: sign in, then tasks one after another — each
 * drawn by `WorkerTask`, its answer sent with its photos — and what the last
 * one earned. While there is no task it says so, and why when the viewer may
 * take none here. The app grants `task/next`, `task/submit` and `task/skip`
 * (`task/file` to show a task's files; `task/me` and `task/withdraw` for the
 * account widget's balance and Withdraw) and lists `camera` in
 * `permissions:` for Take a photo.
 */
export function WorkerPage({ type, title = "Work", intro, className }: WorkerPageProps) {
  const visitor = useVisitor();
  const signedIn = !!visitor.actor;
  const work = useTask(type, { enabled: signedIn });
  const [sent, setSent] = useState<{ msat: number } | null>(null);
  const submit: UseTask["submit"] = async (answer, files) => {
    const msat = work.task?.payMsat ?? 0;
    await work.submit(answer, files);
    setSent({ msat });
  };

  let body: ReactNode;
  if (!signedIn) {
    body = (
      <div className="flex flex-col items-start gap-3">
        {intro && <div className="text-sm text-muted-foreground">{intro}</div>}
        {visitor.available ? (
          <Button onClick={() => void visitor.signIn()}>
            <LogIn /> Sign in to start
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">Signing in isn't open on this page.</p>
        )}
      </div>
    );
  } else if (work.task) {
    body = <WorkerTask task={work.task} submit={submit} skip={work.skip} />;
  } else if (work.status === "inactive") {
    body = <p className="text-sm text-muted-foreground">There's no work for you here yet. {work.error ? reason(work.error) : ""}</p>;
  } else if (work.status === "error") {
    body = <p className="text-sm text-destructive">{work.error ? errorText(work.error) : "Something went wrong."} Trying again…</p>;
  } else {
    body = (
      <div className="flex flex-col gap-2">
        {intro && <div className="text-sm text-muted-foreground">{intro}</div>}
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> No tasks right now. The next one shows up here.
        </p>
      </div>
    );
  }

  return (
    <div className={cn("mx-auto flex w-full max-w-xl flex-col gap-4 p-4", className)} data-testid="worker-page">
      <h1 className="text-xl font-semibold">{title}</h1>
      {sent && signedIn && (
        <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/50 px-3 py-2 text-sm" role="status">
          <span className="flex items-center gap-1.5">
            <Check className="size-4" /> Sent{sent.msat > 0 ? `: ${satsText(sent.msat)} earned, held for a while before you can withdraw it` : ""}.
          </span>
          <button type="button" aria-label="Dismiss" onClick={() => setSent(null)}>
            <X className="size-4" />
          </button>
        </div>
      )}
      {body}
    </div>
  );
}

/** A task refusal's sentence, its code dropped: "an admin decides who takes tasks here". */
function reason(err: Error): string {
  const text = err.message.replace(/^[a-z_]+:\s*/, "");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? "" : ".") : "";
}
