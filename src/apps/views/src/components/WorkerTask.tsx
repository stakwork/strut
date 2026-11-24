import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowLeft, ArrowUpRight, Briefcase, Camera, Check, ChevronDown, ChevronRight, Clock, FileText, ImagePlus, Loader2, LogIn, MessageSquare, Plus, RotateCcw, X, Zap } from "lucide-react";
import {
  appLink, fieldsOf, formats, formProblem, taskErrorCode, useAccountWidget, useApp, useCamera, useFormats, useHost, useStep, useTask, useTaskFileUrl, useTaskHistory, useToolInput, useVisitor, useWorker,
  type FormSchema, type TaskReply, type TaskReplyFile, type UseTask, type WorkerHistoryItem, type WorkerInfo, type WorkerTask as Task, type WorkerType,
} from "@strut/kit";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ACCENT_BUTTON, ACCENT_EDGE, ACCENT_FILL, ACCENT_LINE, ACCENT_TINT, TaskForm } from "./TaskForm";
import { errorText } from "../lib/format";
import { refusalText, useWorkerWords, type WorkerWords } from "../lib/words";
import { workerHeading } from "../lib/heading";
import { shownFields } from "../lib/shown-fields";

export { INTERNAL_KEYS, isInternalKey, shownFields } from "../lib/shown-fields";

// The pieces of a WORKER app (plans/human-steps.md §5): what a task asks,
// the photos an answer carries, the answer's form, and a whole page that
// takes tasks one after another. `WorkerPage` is the app in one line; an app
// with a view of its own composes `WorkerTask`, `TaskPhotos` and `TaskForm`.
// The look is a phone's: a type that takes photos is camera first, any other
// form first, and every state between tasks (signed out, waiting, sent with
// what it earned, refused) a whole screen of its own. Signed in, the worker
// lands on their dashboard (`WorkHome`): the work they can do, each kind with
// what it pays and what waits, what they earned, and what they did. Every
// word is ../lib/words.ts's, in the page's language (plans/i18n.md).

/** msat as a worker reads it: `1,234 sats` (the rest of a sat dropped), as
 *  `locale` groups it (English without one). */
export function satsText(msat: number, locale?: string): string {
  return formats(locale).sats(msat);
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
  const w = useWorkerWords();
  const sats = useFormats().sats(msat);
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1 rounded-full border px-2.5 py-1 text-[13px] font-semibold text-foreground",
        ACCENT_EDGE,
        ACCENT_TINT,
        className,
      )}
    >
      <Zap className="size-3.5 fill-current" /> {earned ? `+${sats}` : w.earn(sats)}
    </span>
  );
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
  const w = useWorkerWords();
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
              <img src={urls[shown]} alt={w.photo(shown + 1)} className="absolute inset-0 size-full object-cover" />
            ) : (
              <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-zinc-300">{current.name}</div>
            )}
            <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/75 to-transparent px-3 pt-10 pb-3">
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/90 px-2.5 py-1 text-xs font-semibold text-white">
                <Check className="size-3.5" /> {w.added(images, shown + 1, photos.length)}
              </span>
              <div className="flex gap-2">
                <button type="button" className="inline-flex h-9 items-center gap-1.5 rounded-full bg-white/15 px-3.5 text-sm font-medium backdrop-blur hover:bg-white/25" onClick={() => (camera.available ? void take(shown) : (drop(shown), choose()))}>
                  <RotateCcw className="size-4" /> {w.retake}
                </button>
                <button type="button" aria-label={w.remove(images, shown + 1)} className="grid size-9 place-items-center rounded-full bg-white/15 backdrop-blur hover:bg-white/25" onClick={() => drop(shown)}>
                  <X className="size-4" />
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_38%,color-mix(in_oklab,var(--color-background-inverse,oklch(82.8%_0.189_84.429))_18%,transparent),transparent_62%)]" />
            <Corners />
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-8 text-center">
              <div className={cn("grid size-20 place-items-center rounded-3xl border", ACCENT_EDGE, ACCENT_TINT)}>
                {images ? <Camera className="size-9" /> : <ImagePlus className="size-9" />}
              </div>
              <p className="text-[15px] leading-snug text-zinc-300">{images ? w.fillFrame : w.addFile}</p>
              <Button type="button" className={cn("h-12 rounded-xl px-6 text-base font-semibold", ACCENT_BUTTON)} onClick={() => (camera.available && images ? void take() : choose())}>
                {camera.available && images ? <Camera /> : <ImagePlus />}
                {camera.available && images ? w.takePhoto : w.choose(images)}
              </Button>
              {camera.available && images && (
                <button type="button" className="text-sm text-zinc-400 underline-offset-4 hover:underline" onClick={choose}>
                  {w.orChoose}
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
              aria-label={w.show(images, i + 1)}
              className={cn("relative size-16 overflow-hidden rounded-xl border-2 bg-muted", i === shown ? ACCENT_LINE : "border-transparent")}
              onClick={() => setShown(i)}
            >
              {p.type.startsWith("image/") && urls[i] ? <img src={urls[i]} alt="" className="size-full object-cover" /> : <span className="p-1 text-[10px]">{p.name}</span>}
            </button>
          ))}
          {room > 0 && photos.length > 0 && (
            <button
              type="button"
              aria-label={w.add(images)}
              className="grid size-16 place-items-center rounded-xl border-2 border-dashed border-muted-foreground/30 text-muted-foreground hover:bg-muted"
              onClick={() => (camera.available && images ? void take() : choose())}
            >
              <Plus className="size-5" />
            </button>
          )}
        </div>
      )}
      <p className="text-[13px] text-muted-foreground">
        {w.rule(rule, images, photos.length)}
      </p>
      {error && <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      <input ref={picker} type="file" accept={rule.types.join(",")} multiple={room > 1} hidden onChange={(e) => void chosen(e.target.files)} />
    </div>
  );
}

/** A viewfinder's four corners, in the accent. */
function Corners() {
  const corner = cn("absolute size-9", ACCENT_LINE);
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
  const w = useWorkerWords();
  const [photos, setPhotos] = useState<File[]>([]);
  // A new task starts with no photos.
  useEffect(() => setPhotos([]), [task.lease]);
  const ask = taskAsk(task.show);
  const fields = shownFields(task.show);
  const rule = task.attachments;
  const images = task.files.filter((p) => IMAGE_PATH.test(p));
  const short = rule && photos.length < rule.min ? rule.min - photos.length : 0;
  const waitingFor = short ? w.addToSend(short, rule!.min) : undefined;
  const send = async (answer: Record<string, unknown>) => {
    if (short) throw new Error(waitingFor);
    await submit(answer, photos);
  };
  return (
    <div className={cn("flex flex-1 flex-col gap-5", className)} data-testid="worker-task">
      <div className="flex flex-col gap-2.5">
        {task.payMsat > 0 && <PayPill msat={task.payMsat} />}
        <h2 className="text-[22px] leading-tight font-semibold tracking-tight text-balance">{ask ?? w.aTask}</h2>
        {fields.length > 0 && (
          <dl className="mt-1 w-full max-w-full min-w-0 grid grid-cols-1 gap-y-2.5 sm:grid-cols-[minmax(auto,max-content)_minmax(0,1fr)] sm:gap-x-4 sm:gap-y-2 rounded-2xl border bg-muted/40 px-4 py-3 text-sm">
            {fields.map(([k, v]) => (
              <div key={k} className="min-w-0 sm:contents">
                <dt className="text-[13px] text-muted-foreground sm:max-w-[12rem] sm:truncate sm:text-sm sm:whitespace-nowrap" title={labelOf(k)}>{labelOf(k)}</dt>
                <dd className="m-0 min-w-0 font-medium [overflow-wrap:anywhere] break-words whitespace-pre-line">{v}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      {images.map((p) => (
        <TaskFileImage key={p} task={task} path={p} />
      ))}
      {rule && <TaskPhotos task={task} photos={photos} onChange={setPhotos} {...(ask ? { title: ask } : {})} />}
      <TaskForm task={task} onSubmit={send} {...(skip ? { onSkip: () => skip() } : {})} label={label ?? w.send} bar {...(waitingFor ? { waitingFor } : {})} />
    </div>
  );
}

export interface WorkerPageProps {
  /** One task type alone on the dashboard; left out, every type this app draws. */
  type?: string;
  /** The app's name, in the header: without one, the server's name (the
   *  employer, `useHost().name`) when it has one, else "Tasks" in the page's
   *  language. */
  title?: string;
  /** The header's second line: what the work is, in a few words ("Tasks"
   *  under the server's name; else "Do tasks · get paid"; "" for none). */
  subtitle?: string;
  /** The header's mark (a lucide icon); a briefcase without one. */
  icon?: ReactNode;
  /** What the work is, shown before sign-in (never once signed in: it asks
   *  them to sign in); a line saying so in the page's language without one. */
  intro?: ReactNode;
  /** The dashboard lists the task types of EVERY app the worker can open
   *  here (`task/me { all }`), not this app's alone: a type another app
   *  draws opens that app on it when tapped (`appLink(app, { type })`),
   *  whose Back returns here. strut/worker's, the server's one work link. */
  everyApp?: boolean;
  className?: string;
}

/** What was sent, for the screen after: what it earned and the answer as given. */
interface Sent {
  /** The lease it was answered by: what the workflow's reply comes back on. */
  lease?: string;
  msat: number;
  /** It earns `msat` only once it is marked OK. */
  onOk?: boolean;
  answer: Record<string, unknown>;
  schema: unknown;
  photos: File[];
}

/**
 * A worker app's whole page, phone first: a header with the app's mark, then
 * one screen at a time — sign in; the DASHBOARD (`WorkHome`: the work they
 * can do, what they earned, what they did), where choosing a kind of work
 * starts it; the task in hand, drawn by `WorkerTask` with its photos and sent
 * with them; what the last answer earned (held until it clears), with the
 * answer as given and Next task; and while there is no task, that it is
 * looking, or why the viewer may take none here. Back returns to the
 * dashboard; a task left in hand waits there as Continue. The app grants
 * `task/next`, `task/submit`, `task/skip` and `task/me` (`task/file` to show
 * a task's files; `task/history` for what they did; `task/withdraw` for the
 * account widget's Withdraw) and lists `camera` in `permissions:` for Take a
 * photo. A visitor (the public view) signs in on the page; a member or an
 * admin — the page shown in their assistant's chat — is signed in already,
 * and works and earns as themselves.
 */
export function WorkerPage({ type, title: named, subtitle: line, icon, intro, everyApp = false, className }: WorkerPageProps) {
  const w = useWorkerWords();
  const visitor = useVisitor();
  const account = useAccountWidget();
  const here = useApp()?.name;
  const host = useHost();
  // Whose work this is: the server's name (the employer) heads a page that
  // names itself nothing, "Tasks" under it.
  const { title, subtitle } = workerHeading({ named, line, server: host.name, words: w });
  // A member's or an admin's page — the app in their assistant's chat, or
  // strut's own UI — is not the public view: strut knows who is looking
  // already, and `task/me` says who. Only a visitor signs in on the page.
  const known = !host.public;
  const me = useWorker({ enabled: !!visitor.actor || known, all: everyApp });
  const signedIn = !!visitor.actor || (known && !!me.data?.actor);
  // A visitor in Peel may be signed in already as far as Peel goes: the page
  // it opened from the worker's own invite holds Peel's sign-in grant. So the
  // page asks as it loads, silently — Peel answers a grant with a toast and
  // nothing else; anything less draws nothing here and leaves Sign in to
  // start. One ask a page.
  const [signingIn, setSigningIn] = useState(false);
  const askedSilently = useRef(false);
  useEffect(() => {
    if (askedSilently.current || known || !visitor.available || visitor.actor) return;
    askedSilently.current = true;
    setSigningIn(true);
    void visitor
      .signIn({ silent: true })
      .catch(() => undefined)
      .finally(() => setSigningIn(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the page can sign in at all
  }, [known, visitor.available, visitor.actor]);
  /** What they are working on: a type, every type (`null`), or nothing yet — the dashboard. */
  const [working, setWorking] = useState<string | null | undefined>(undefined);
  // Opened on one kind of work (`appLink(app, { type })`, as another app's
  // dashboard opens it, or an invite's link): straight to it, once, when this
  // app draws it; a kind another app draws goes first on the dashboard, one
  // tap away (below).
  const input = useToolInput<Record<string, unknown>>();
  const opened = typeof input?.["type"] === "string" ? input["type"] : undefined;
  const openedOnce = useRef(false);
  /** Opened on a kind and not yet past it: the page waits (One moment)
   *  rather than drawing the dashboard for the instant before it starts
   *  that kind here. */
  const [handingOff, setHandingOff] = useState(!!opened);
  /** From the moment an answer goes until Next task: no next task is
   *  leased meanwhile, so a worker who stops here holds nothing. */
  const [paused, setPaused] = useState(false);
  const work = useTask(working ?? type, { enabled: signedIn && working !== undefined && !paused });
  /** The app that draws a kind, when it is not this one. */
  const drawnElsewhere = (kind: string) => {
    const app = me.data?.types.find((t) => t.name === kind)?.app;
    return app && here && app !== here ? app : undefined;
  };
  /** Work on a kind: here when this app draws it, else in the app that does. */
  const start = (kind: string | null) => {
    const app = kind === null ? undefined : drawnElsewhere(kind);
    if (app) void host.openLink(appLink(app, { type: kind }));
    else setWorking(kind);
  };
  // Once `task/me` has answered — an invite's grant made by then — and only
  // when the worker may do it: else the dashboard, which says what they can.
  // A kind another app draws is NOT opened from here: it goes first on the
  // dashboard, and the worker's tap opens that app. A page that opens another
  // by itself, untapped, is one a phone's Back skips: Android's web view then
  // says there is nothing to go back to, so Peel drew no Back, and Peel opens
  // the invite's link at every start, so it jumped there every time
  // (2026-11-20).
  useEffect(() => {
    if (!signedIn || !opened || openedOnce.current || !me.data) return;
    openedOnce.current = true;
    if (me.data.types.some((t) => t.name === opened) && !drawnElsewhere(opened)) setWorking(opened);
    setHandingOff(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `drawnElsewhere` reads me.data, which is a dependency
  }, [signedIn, opened, me.data]);
  const [sent, setSent] = useState<Sent | null>(null);
  const submit: UseTask["submit"] = async (answer, files) => {
    const held = work.task;
    setPaused(true);
    try {
      await work.submit(answer, files);
    } catch (err) {
      setPaused(false);
      throw err;
    }
    setSent({ ...(held ? { lease: held.lease } : {}), msat: held?.payMsat ?? 0, ...(held?.payOn === "ok" ? { onOk: true } : {}), answer: (answer ?? {}) as Record<string, unknown>, schema: held?.answer, photos: [...(files ?? [])] });
  };
  const next = () => {
    setSent(null);
    setPaused(false);
  };
  const home = () => {
    setSent(null);
    setPaused(false);
    setWorking(undefined);
  };
  /** Whether there is more of what they are working on: a standing type, or one with tasks waiting. */
  const more = (me.data?.types ?? []).some(
    (t) => (working == null || t.name === working) && (type === undefined || t.name === type) && (!here || t.app === here) && (t.standing || (t.waiting ?? 0) > 0),
  );
  const mark = icon ?? <Briefcase className="size-4" />;

  let body: ReactNode;
  if (!signedIn && ((known && me.isLoading) || signingIn)) {
    body = <Screen icon={<Loader2 className="size-10 animate-spin" />} heading={w.oneMoment} />;
  } else if (!signedIn) {
    body = (
      <Screen
        icon={mark}
        heading={w.signInHeading}
        text={intro ?? w.signInText}
        bar={
          visitor.available ? (
            <Button className={cn("h-12 w-full rounded-xl text-base font-semibold", ACCENT_BUTTON)} onClick={() => void visitor.signIn()}>
              <LogIn /> {w.signIn}
            </Button>
          ) : (
            <p className="text-center text-sm text-muted-foreground">{w.signInClosed}</p>
          )
        }
      />
    );
  } else if (handingOff && working === undefined && !me.isError) {
    body = <Screen icon={<Loader2 className="size-10 animate-spin" />} heading={w.oneMoment} />;
  } else if (working === undefined) {
    body = <WorkHome only={type} all={everyApp} onStart={start} {...(opened ? { first: opened } : {})} />;
  } else if (sent) {
    body = <SentScreen sent={sent} next={more} onNext={next} onHome={home} />;
  } else if (work.task) {
    body = <WorkerTask key={work.task.lease} task={work.task} submit={submit} skip={work.skip} />;
  } else if (work.status === "inactive") {
    body = (
      <Screen
        icon={<Clock className="size-10" />}
        heading={w.signedIn}
        text={
          <>
            {w.noWorkYet}
            {work.error ? ` ${refusalText(work.error, w)}` : ""}
            <span className="mt-3 block text-[13px]">{w.checksAgain}</span>
          </>
        }
        bar={<BackBar onBack={home} />}
      />
    );
  } else if (work.status === "error") {
    body = (
      <Screen
        tone="error"
        icon={<AlertTriangle className="size-10" />}
        heading={w.cantReach}
        text={
          <>
            {work.error ? refusalText(work.error, w) || errorText(work.error) : w.somethingWrong}
            <span className="mt-3 flex items-center justify-center gap-1.5 text-[13px]">
              <Loader2 className="size-3.5 animate-spin" /> {w.tryingAgain}
            </span>
          </>
        }
        bar={<BackBar onBack={home} />}
      />
    );
  } else {
    body = (
      <Screen
        icon={<Loader2 className="size-10 animate-spin [animation-duration:2.4s]" />}
        heading={w.looking}
        text={w.noTasksNow}
        bar={<BackBar onBack={home} />}
      />
    );
  }

  const back = signedIn && working !== undefined && !sent;
  return (
    <div className={cn("mx-auto flex min-h-dvh w-full max-w-xl flex-col bg-background text-foreground", className)} data-testid="worker-page">
      <header className={cn("sticky top-0 z-20 flex items-center gap-2.5 bg-background/90 px-4 pt-3.5 pb-3 backdrop-blur", account.available && "pr-44")}>
        {back ? (
          <button type="button" aria-label={w.backToWork} onClick={home} className="grid size-8 shrink-0 place-items-center rounded-[10px] border bg-card text-foreground [&_svg]:size-4">
            <ArrowLeft />
          </button>
        ) : (
          <div className={cn("grid size-8 shrink-0 place-items-center rounded-[10px] [&_svg]:size-4", ACCENT_FILL)}>{mark}</div>
        )}
        <div className="min-w-0">
          <div className="truncate text-[15px] leading-tight font-semibold">{back && working ? typeLabel(working, me.data?.types.find((t) => t.name === working)?.title) : title}</div>
          {subtitle && <div className="truncate text-xs text-muted-foreground">{back && working ? title : subtitle}</div>}
        </div>
      </header>
      <main className="flex flex-1 flex-col px-4 pt-1">{body}</main>
    </div>
  );
}

/** A type as a worker reads it: its `title` (what the admin calls it, in
 *  the workers' language), else its name's last segment, words spaced and
 *  capitalised — `shops/photo-check` → "Photo check". */
export function typeLabel(name: string, title?: string): string {
  return title?.trim() || labelOf(name.split("/").pop() || name);
}

/** How often the dashboard reads what waits again, while it is shown. */
const HOME_POLL_MS = 15_000;

/**
 * The worker's DASHBOARD (plans/human-steps.md §5): the task in their hand
 * (Continue, or Let go), the kinds of work they can do here — each with what it pays
 * and whether there is work of it now (any time, for a standing type; how
 * many wait, for tasks a workflow made) — what they earned here, and their
 * own tasks, newest first, with how each ended and what it earned. Choosing a
 * kind starts it (`onStart(type)`); Start working takes any kind this app
 * draws (`null`). With `all`, every app's kinds the worker can open here; one
 * another app draws says so, and `onStart` is for the page to open that app.
 * `first`: the kind the page was opened on, listed first.
 */
export function WorkHome({ only, all = false, first, onStart }: { only?: string; all?: boolean; first?: string; onStart: (type: string | null) => void }) {
  const w = useWorkerWords();
  const fmt = useFormats();
  const here = useApp()?.name;
  const me = useWorker({ all });
  const history = useTaskHistory({ all });
  const { refetch } = me;
  const { refetch: reread } = history;
  // Read both again on coming back (a task just taken is in neither), then
  // what waits every little while.
  useEffect(() => {
    void refetch();
    void reread();
    const timer = setInterval(() => void refetch(), HOME_POLL_MS);
    return () => clearInterval(timer);
  }, [refetch, reread]);

  if (!me.data) {
    return me.error ? (
      <Screen tone="error" icon={<AlertTriangle className="size-10" />} heading={w.cantReach} text={refusalText(me.error, w) || errorText(me.error)} />
    ) : (
      <Screen icon={<Loader2 className="size-10 animate-spin" />} heading={w.oneMoment} />
    );
  }
  const info: WorkerInfo = me.data;
  const types = info.types.filter((t) => only === undefined || t.name === only).sort((a, b) => Number(b.name === first) - Number(a.name === first));
  if (info.status === "suspended" || info.status === "banned") {
    return <Screen icon={<Clock className="size-10" />} heading={w.paused} text={w.pausedText} />;
  }
  const holding = info.holding && types.some((t) => t.name === info.holding!.type) ? info.holding : undefined;
  /** What a type is called here: its title, when the worker still holds it. */
  const titleOf = (name: string) => info.types.find((t) => t.name === name)?.title;
  const items = history.data?.items.filter((i) => only === undefined || i.type === only) ?? [];
  /** A kind another app draws: it opens there. */
  const elsewhere = (t: WorkerType) => !!here && t.app !== here;
  const mine = types.filter((t) => !elsewhere(t));
  const any = mine.some((t) => t.standing || (t.waiting ?? 0) > 0);

  return (
    <div className="flex flex-1 flex-col gap-6 pb-[max(1rem,env(safe-area-inset-bottom))]" data-testid="work-home">
      {info.xp && <LevelCard xp={info.xp} {...(info.pendingMsat ? { pendingMsat: info.pendingMsat } : {})} />}
      {holding && (
        <InHand
          holding={holding}
          title={titleOf(holding.type)}
          onContinue={() => onStart(holding.type)}
          onGone={() => {
            void refetch();
            void reread();
          }}
        />
      )}

      <section className="flex flex-col gap-2.5">
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{w.workYouCanDo}</h2>
        {types.length === 0 ? (
          <p className="rounded-2xl border bg-muted/40 px-4 py-5 text-center text-sm text-muted-foreground">
            {w.noWorkText}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {types.map((t) => (
              <li key={t.name}>
                <TypeRow type={t} onStart={() => onStart(t.name)} blocked={!!holding && holding.type !== t.name} {...(elsewhere(t) ? { app: t.app } : {})} />
              </li>
            ))}
          </ul>
        )}
        {mine.length > 1 && !holding && any && (
          <Button className={cn("mt-1 h-12 w-full rounded-xl text-base font-semibold", ACCENT_BUTTON)} onClick={() => onStart(only ?? null)}>
            {w.startWorking} <span aria-hidden>→</span>
          </Button>
        )}
      </section>

      <section className="flex flex-col gap-2.5">
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{w.earnedHere}</h2>
        <div className="grid grid-cols-2 gap-2">
          <Stat label={w.readyToWithdraw} msat={info.balance.withdrawableMsat} />
          <Stat
            label={w.held}
            msat={info.balance.heldMsat}
            {...(info.balance.nextReleaseAt ? { note: w.nextClears(fmt.until(info.balance.nextReleaseAt)) } : {})}
          />
          {!!info.pendingMsat && <Stat label={w.waitingForOk} msat={info.pendingMsat} note={w.paidOnceOk} />}
        </div>
      </section>

      {!history.error && (
        <section className="flex flex-col gap-2.5">
          <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{w.yourWork}</h2>
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{w.nothingYet}</p>
          ) : (
            <ul className="flex flex-col divide-y rounded-2xl border bg-card" data-testid="work-history">
              {items.map((i) => (
                <HistoryRow key={i.lease} item={i} title={titleOf(i.type)} />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * Their level (plans/worker-progress.md): XP is every sat they ever earned
 * here, and the bar how far they are from where this level starts to where
 * the next does. Drawn only when `task/me` says it: a missing XP is not
 * Level 0. Still, as numbers are: nothing moves on the dashboard.
 */
function LevelCard({ xp, pendingMsat }: { xp: NonNullable<WorkerInfo["xp"]>; pendingMsat?: number }) {
  const w = useWorkerWords();
  const fmt = useFormats();
  const to = xp.toSats;
  const share = to === undefined ? 1 : Math.min(1, Math.max(0, (xp.sats - xp.fromSats) / (to - xp.fromSats)));
  const pendingSats = Math.floor((pendingMsat ?? 0) / 1000);
  return (
    <div className={cn("flex flex-col gap-2.5 rounded-2xl border px-4 py-3.5", ACCENT_EDGE, ACCENT_TINT)} data-testid="level">
      <div className="flex items-center gap-3">
        <div className={cn("grid size-11 shrink-0 place-items-center rounded-[14px] text-lg font-bold tabular-nums", ACCENT_FILL)}>{xp.level}</div>
        <div className="min-w-0">
          <div className="text-[17px] leading-tight font-semibold">{w.level(xp.level)}</div>
          <div className="text-[13px] text-muted-foreground tabular-nums">{w.xp(fmt.number(xp.sats))}</div>
        </div>
      </div>
      <div
        role="progressbar"
        aria-label={to === undefined ? w.topLevel : w.toLevel(xp.level + 1)}
        aria-valuemin={xp.fromSats}
        aria-valuemax={to ?? xp.sats}
        aria-valuenow={xp.sats}
        className="h-2 overflow-hidden rounded-full bg-foreground/10"
      >
        <div className={cn("h-full rounded-full", ACCENT_FILL)} style={{ width: `${share * 100}%` }} />
      </div>
      <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-[13px] text-muted-foreground">
        {to === undefined ? (
          <span>{w.topLevel}</span>
        ) : (
          <span>
            <span className="font-semibold text-foreground tabular-nums">{w.xp(fmt.number(to - xp.sats))}</span> {w.toLevel(xp.level + 1)}
          </span>
        )}
        <span className="tabular-nums">{pendingSats > 0 ? w.xpWaiting(fmt.number(pendingSats)) : w.xpPerSat}</span>
      </div>
    </div>
  );
}

/** Refusals that mean the task already left their hand: nothing to let go of. */
const ALREADY_GONE = new Set(["no_lease", "lease_closed", "lease_expired", "task_closed", "not_granted"]);

/**
 * The task in their hand: Continue, and Let go — asked first, in place (a
 * framed page has no modals) — which frees it whichever app draws it
 * (`task/skip { lease, all: true }`), so the other kinds of work open again.
 */
function InHand({ holding, title, onContinue, onGone }: { holding: NonNullable<WorkerInfo["holding"]>; title?: string | undefined; onContinue: () => void; onGone: () => void }) {
  const w = useWorkerWords();
  const skip = useStep("task/skip");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const letGo = async () => {
    setError(null);
    try {
      await skip.run({ lease: holding.lease, all: true });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (!ALREADY_GONE.has(taskErrorCode(e) ?? "")) {
        setError(refusalText(e, w) || errorText(e));
        return;
      }
    }
    setAsking(false);
    onGone();
  };
  return (
    <div className={cn("rounded-2xl border p-4", ACCENT_EDGE, ACCENT_TINT)} data-testid="in-hand">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onContinue} className="min-w-0 flex-1 text-left">
          <div className="text-xs font-semibold tracking-wide text-foreground uppercase">{w.inYourHand}</div>
          <div className="truncate text-base font-semibold">{typeLabel(holding.type, title)}</div>
        </button>
        {holding.lease && !asking && (
          <button
            type="button"
            aria-label={w.letGo}
            title={w.letGo}
            onClick={() => setAsking(true)}
            className="mr-4 grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-[color:color-mix(in_oklab,var(--color-background-inverse,oklch(82.8%_0.189_84.429))_25%,transparent)] hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        )}
        <button type="button" onClick={onContinue} className="inline-flex shrink-0 items-center gap-1 text-sm font-semibold">
          {w.continue} <ChevronRight className="size-4" />
        </button>
      </div>
      {asking && (
        <div className={cn("mt-3 flex flex-col gap-2 border-t pt-3", ACCENT_EDGE)}>
          <p className="text-sm">{w.letGoAsk}</p>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" className="h-10 rounded-xl" disabled={skip.pending} onClick={() => setAsking(false)}>
              {w.keepIt}
            </Button>
            <Button className={cn("h-10 rounded-xl font-semibold", ACCENT_BUTTON)} disabled={skip.pending} onClick={() => void letGo()}>
              {skip.pending ? <Loader2 className="animate-spin" /> : <X />} {w.letGo}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** One kind of work: its name, what an answer pays, and whether there is work
 *  of it now. `blocked` while a task of another kind is in their hand: the
 *  server hands out no other until it is answered or skipped. */
function TypeRow({ type, onStart, blocked = false, app }: { type: WorkerType; onStart: () => void; blocked?: boolean; app?: string }) {
  const w = useWorkerWords();
  const waiting = type.waiting ?? 0;
  const status = blocked ? w.finishFirst : type.standing ? w.anyTime : waiting > 0 ? w.waiting(waiting) : w.noneNow;
  // Another app draws it: where it opens.
  const now = app && !blocked ? w.inApp(status, typeLabel(app)) : status;
  const ready = !blocked && (!!type.standing || waiting > 0);
  return (
    <button
      type="button"
      onClick={onStart}
      disabled={blocked}
      className="flex w-full items-center gap-3 rounded-2xl border bg-card p-4 text-left shadow-sm active:bg-muted/60 disabled:opacity-55"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-base font-semibold">{typeLabel(type.name, type.title)}</div>
        <div className={cn("mt-0.5 text-[13px]", ready ? "font-medium text-emerald-700 dark:text-emerald-400" : "text-muted-foreground")}>{now}</div>
      </div>
      {type.payMsat > 0 && <PayPill msat={type.payMsat} className="shrink-0" />}
      {app ? <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
    </button>
  );
}

function Stat({ label, msat, note }: { label: string; msat: number; note?: string }) {
  const fmt = useFormats();
  return (
    <div className="rounded-2xl border bg-card p-3.5">
      <div className="text-[13px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{fmt.sats(msat)}</div>
      {note && <div className="mt-0.5 text-xs text-muted-foreground">{note}</div>}
    </div>
  );
}

/** One of their tasks: the kind, when, how it ended and what it earned; an
 *  answer staff sent back says so, and why — what to fix. */
function HistoryRow({ item, title }: { item: WorkerHistoryItem; title?: string | undefined }) {
  const w = useWorkerWords();
  const fmt = useFormats();
  const e = item.earned;
  let badge: ReactNode;
  if (item.status === "open") badge = <Badge tone="accent">{w.inYourHand}</Badge>;
  else if (item.status === "skipped") badge = <Badge>{w.skipped}</Badge>;
  else if (item.status === "expired") badge = <Badge>{w.notFinished}</Badge>;
  else if (item.review?.verdict === "rejected") badge = <Badge tone="error">{w.sentBack}</Badge>;
  else if (item.pending) badge = <Badge>{w.waitingForOk}</Badge>;
  else if (!e) badge = <Badge tone="done">{w.sent}</Badge>;
  else if (e.takenBack) badge = <Badge tone="error">{w.notPaid}</Badge>;
  else if (e.releases > Date.now()) badge = <Badge>{w.heldClears(fmt.until(e.releases))}</Badge>;
  else badge = <Badge tone="done">{w.cleared}</Badge>;
  return (
    <li className={cn("flex min-w-0 items-center gap-3 px-4 py-3", (item.reply || item.review?.why) && "flex-wrap")}>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-medium">{item.ask ?? typeLabel(item.type, title)}</div>
        <div className="truncate text-xs text-muted-foreground">
          {item.ask ? `${typeLabel(item.type, title)} · ` : ""}
          {fmt.ago(item.closed ?? item.taken)}
        </div>
      </div>
      <div className="flex flex-col items-end gap-1">
        {e && <span className={cn("text-sm font-semibold tabular-nums", e.takenBack && "text-muted-foreground line-through")}>+{fmt.sats(e.msat)}</span>}
        {item.pending && <span className="text-sm font-semibold text-muted-foreground tabular-nums">+{fmt.sats(item.pending.msat)}</span>}
        {badge}
      </div>
      {item.review?.verdict === "rejected" && item.review.why && <div className="w-full min-w-0 text-sm [overflow-wrap:anywhere] text-destructive">{w.toFix(item.review.why)}</div>}
      {item.reply && <ReplyLine item={item} reply={item.reply} />}
    </li>
  );
}

/** A history row's reply: one line saying what it is, opened to draw it
 *  (its pictures are read only then, so a long list loads none). */
function ReplyLine({ item, reply }: { item: Pick<WorkerHistoryItem, "lease">; reply: TaskReply }) {
  const w = useWorkerWords();
  const [open, setOpen] = useState(false);
  const files = reply.files ?? [];
  const pictures = files.filter(isPicture).length;
  const said = taskAsk(reply.show) ?? shownFields(reply.show)[0]?.[1];
  const summary = said ?? (pictures ? w.pictures(pictures) : w.files(files.length));
  return (
    <div className="w-full max-w-full min-w-0 basis-full">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex w-full max-w-full min-w-0 items-center gap-1.5 text-left text-[13px] font-medium text-foreground">
        <MessageSquare className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-semibold">{w.reply}</span>
          {open ? null : ` · ${summary}`}
        </span>
        <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && <TaskReplyView item={item} reply={reply} className="mt-2.5" />}
    </div>
  );
}

/**
 * What a workflow told the worker after their answer (its `task/reply`):
 * `show.ask` or `show.title` as a line, `show`'s other plain fields, its
 * pictures drawn and any other file named. Its files are read through the
 * answered lease (`useTaskFile(item, path)`); a page whose answers' replies
 * it shows grants `task/history` and `task/file`. A page that reads them
 * another way (strut/staff, through `staff/file`) passes `file`, which draws
 * each one, and no `item`.
 */
export function TaskReplyView({ item, reply, file, className }: { item?: Pick<WorkerHistoryItem, "lease">; reply: TaskReply; file?: (f: TaskReplyFile) => ReactNode; className?: string }) {
  const heading = taskAsk(reply.show);
  const fields = shownFields(reply.show);
  return (
    <div className={cn("flex w-full max-w-full min-w-0 flex-col gap-2.5", className)} data-testid="task-reply">
      {heading && <p className="m-0 text-[15px] leading-snug font-medium [overflow-wrap:anywhere]">{heading}</p>}
      {fields.length > 0 && (
        <dl className="m-0 w-full max-w-full min-w-0 grid grid-cols-1 gap-y-2.5 sm:grid-cols-[minmax(auto,max-content)_minmax(0,1fr)] sm:gap-x-4 sm:gap-y-2 text-sm">
          {fields.map(([k, v]) => (
            <div key={k} className="min-w-0 sm:contents">
              <dt className="text-[13px] text-muted-foreground sm:max-w-[12rem] sm:truncate sm:text-sm sm:whitespace-nowrap" title={labelOf(k)}>{labelOf(k)}</dt>
              <dd className="m-0 min-w-0 font-medium [overflow-wrap:anywhere] break-words whitespace-pre-line">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {(reply.files ?? []).map((f) => (file ? <Fragment key={f.path}>{file(f)}</Fragment> : <ReplyFile key={f.path} item={item} file={f} />))}
    </div>
  );
}

/** A reply's file is a picture by its type, or by its name's ending. */
const isPicture = (f: TaskReplyFile) => f.mediaType.startsWith("image/") || IMAGE_PATH.test(f.name) || IMAGE_PATH.test(f.path);

/** One file of a reply: a picture drawn as a thumbnail with its name under
 *  it, anything else (or a picture that cannot be read here) named. */
function ReplyFile({ item, file }: { item?: Pick<WorkerHistoryItem, "lease">; file: TaskReplyFile }) {
  const picture = isPicture(file);
  const read = useTaskFileUrl(item, file.path, { enabled: picture });
  if (picture && !read.error) {
    return (
      <figure className="m-0 w-full max-w-full min-w-0 overflow-hidden rounded-2xl border bg-muted/50">
        {read.url ? <img src={read.url} alt={file.name} className="max-h-60 w-full object-contain sm:max-h-80" /> : <div className="aspect-square max-h-60 w-full animate-pulse bg-muted" />}
        <figcaption className="border-t px-3 py-1.5 text-xs [overflow-wrap:anywhere] text-muted-foreground">{file.name}</figcaption>
      </figure>
    );
  }
  return (
    <div className="flex w-full max-w-full min-w-0 items-center gap-2 rounded-xl border bg-muted/40 px-3 py-2 text-sm">
      <FileText className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{file.name}</span>
    </div>
  );
}

/** How often the screen after an answer reads the worker's history again,
 *  for the workflow's reply. */
const REPLY_POLL_MS = 4_000;
/** How long it asks: most workflows never reply, and an image model has
 *  answered well before. A reply later shows on the task's history row. */
const REPLY_WAIT_MS = 120_000;

/** The workflow's reply to an answer just sent, drawn once it comes while
 *  the worker is still here, for up to `REPLY_WAIT_MS`; nothing until then,
 *  so a type whose workflow never replies shows nothing more. */
function SentReply({ lease }: { lease: string }) {
  const w = useWorkerWords();
  const [done, setDone] = useState(false);
  const history = useTaskHistory({ refetchInterval: done ? false : REPLY_POLL_MS });
  const item = history.data?.items.find((i) => i.lease === lease);
  const reply = item?.reply;
  // A reply, a page that cannot read its history, or the wait over: stop asking.
  useEffect(() => {
    if (reply || history.error) setDone(true);
  }, [reply, history.error]);
  useEffect(() => {
    const timer = setTimeout(() => setDone(true), REPLY_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);
  if (!item || !reply) return null;
  return (
    <div className={cn("relative mt-4 w-full rounded-2xl border bg-card p-4 text-left shadow-sm", ACCENT_EDGE)}>
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-foreground uppercase">
        <MessageSquare className="size-3.5" /> {w.reply}
      </div>
      <TaskReplyView item={item} reply={reply} />
    </div>
  );
}

function Badge({ children, tone }: { children: ReactNode; tone?: "accent" | "done" | "error" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        !tone && "text-muted-foreground",
        tone === "accent" && cn("text-foreground", ACCENT_EDGE, ACCENT_TINT),
        tone === "done" && "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        tone === "error" && "border-destructive/35 bg-destructive/10 text-destructive",
      )}
    >
      {children}
    </span>
  );
}

/** Back to the dashboard, at the bottom of a screen between tasks. */
function BackBar({ onBack }: { onBack: () => void }) {
  const w = useWorkerWords();
  return (
    <Button variant="outline" className="h-12 w-full rounded-xl text-base" onClick={onBack}>
      <ArrowLeft /> {w.backToWork}
    </Button>
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
            tone === "accent" && "bg-[radial-gradient(260px_circle_at_50%_42%,color-mix(in_oklab,var(--color-background-inverse,oklch(82.8%_0.189_84.429))_16%,transparent),transparent)]",
            tone === "done" && "bg-[radial-gradient(260px_circle_at_50%_30%,rgb(16_185_129/0.16),transparent)]",
            tone === "error" && "bg-[radial-gradient(260px_circle_at_50%_42%,rgb(239_68_68/0.14),transparent)]",
          )}
        />
        <div
          className={cn(
            "relative grid size-22 place-items-center rounded-[26px] border [&_svg]:size-10",
            tone === "accent" && cn("text-foreground", ACCENT_EDGE, ACCENT_TINT),
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
function SentScreen({ sent, next, onNext, onHome }: { sent: Sent; next: boolean; onNext: () => void; onHome: () => void }) {
  const w = useWorkerWords();
  const rows = answerRows(sent.answer, sent.schema, w);
  const urls = useObjectUrls(sent.photos);
  return (
    <Screen
      tone="done"
      icon={<Check className="size-10" strokeWidth={2.5} />}
      heading={w.thanks}
      text={sent.msat > 0 ? (sent.onOk ? w.earnedOnOk : w.earnedHeld) : w.answerIn}
      bar={
        <div className="flex flex-col gap-2">
          <Button className={cn("h-12 w-full rounded-xl text-base font-semibold", ACCENT_BUTTON)} onClick={next ? onNext : onHome}>
            {next ? (
              <>
                {w.nextTask} <span aria-hidden>→</span>
              </>
            ) : (
              w.done
            )}
          </Button>
          {next && (
            <Button variant="ghost" className="h-10 w-full rounded-xl text-sm text-muted-foreground" onClick={onHome}>
              {w.backToWork}
            </Button>
          )}
        </div>
      }
    >
      {sent.msat > 0 && (
        <div className="relative flex flex-wrap justify-center gap-2">
          <PayPill msat={sent.msat} earned />
          <span className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[13px] font-medium text-muted-foreground">
            <Clock className="size-3.5" /> {sent.onOk ? w.waitingForOk : w.held}
          </span>
        </div>
      )}
      {(rows.length > 0 || urls.length > 0) && (
        <div className="relative mt-4 w-full rounded-2xl border bg-card p-4 text-left shadow-sm">
          <div className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{w.yourAnswer}</div>
          {urls.length > 0 && (
            <div className="mb-3 flex gap-2">
              {urls.map((u, i) => (
                <img key={u} src={u} alt={w.photo(i + 1)} className="size-16 rounded-xl border object-cover" />
              ))}
            </div>
          )}
          {rows.length > 0 && (
            <dl className="flex min-w-0 flex-col gap-2.5 text-sm">
              {rows.map(([k, v]) => (
                <div key={k} className="min-w-0">
                  <dt className="text-[13px] text-muted-foreground">{k}</dt>
                  <dd className="m-0 min-w-0 font-medium [overflow-wrap:anywhere] break-words">{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
      {sent.lease && <SentReply lease={sent.lease} />}
    </Screen>
  );
}

/** An answer as label and value, in its schema's order and words. */
function answerRows(answer: Record<string, unknown>, schema: unknown, w: WorkerWords): Array<[string, string]> {
  const fields = formProblem(schema) ? [] : fieldsOf(schema as FormSchema, { other: false });
  const out: Array<[string, string]> = [];
  for (const f of fields) {
    const v = answer[f.name];
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
    const text = (x: unknown) => f.enumLabels?.[String(x)] ?? String(x);
    out.push([f.label ?? labelOf(f.name), typeof v === "boolean" ? (v ? w.yes : w.no) : Array.isArray(v) ? v.map(text).join(", ") : text(v)]);
  }
  return out;
}

