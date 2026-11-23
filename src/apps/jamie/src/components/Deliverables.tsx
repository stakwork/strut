// What a job or a turn delivered, laid out (Hive's ChatArtifacts and
// FoldedArtifacts; lib/artifacts.ts `placementOf`): pictures — screenshots,
// recordings, videos — in a strip of thumbnails, a click opening one in full
// under the strip (a video beside the chat); things to read or act on as
// cards; reference material (a log, JSON, code, a diff) folded into one
// line, each name opening its card under it.
import { Fragment, useState, type ReactNode } from "react";
import { Play, Video } from "lucide-react";
import { useHost, useRunFileUrl } from "@strut/kit";
import { WalkthroughPlayer } from "strut/views";
import { cn } from "@/lib/utils";
import { placeArtifact, placementOf, type ArtifactPlace, type Shown } from "../lib/artifacts";
import { useJobRun, type TurnRuns } from "./ArtifactCard";

interface Laid {
  key: string;
  shown: Shown;
  place: ArtifactPlace;
}

/** `card(shown, open)`: the caller's card for one deliverable, open at once
 *  when a thumbnail or a folded name asked for it. */
export function Deliverables({ items, runs, card }: { items: Shown[]; runs: TurnRuns; card: (shown: Shown, open?: boolean) => ReactNode }) {
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (key: string) => setOpen((o) => (o === key ? null : key));
  const laid = items.map((shown) => {
    const place = placeArtifact(shown.artifact, runs);
    return { key: `${shown.job ?? ""}:${shown.artifact.id}`, shown, place, at: placementOf(shown.artifact, place) };
  });
  const thumbs = laid.filter((l) => l.at === "thumb");
  const folded = laid.filter((l) => l.at === "folded");
  const openThumb = thumbs.find((l) => l.key === open);
  const openFolded = folded.find((l) => l.key === open);
  return (
    <>
      {thumbs.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1" data-testid="deliverable-strip">
          {thumbs.map((l) => (
            <Thumb key={l.key} laid={l} active={open === l.key} onOpen={() => toggle(l.key)} />
          ))}
        </div>
      )}
      {openThumb && card(openThumb.shown, true)}
      {laid.filter((l) => l.at === "row").map((l) => <Fragment key={l.key}>{card(l.shown)}</Fragment>)}
      {folded.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="deliverables-folded">
          {folded.length} more ·{" "}
          {folded.map((l, i) => (
            <Fragment key={l.key}>
              {i > 0 && ", "}
              <button type="button" onClick={() => toggle(l.key)} aria-expanded={open === l.key} className={cn("cursor-pointer hover:text-foreground hover:underline", open === l.key && "text-foreground")}>
                {l.shown.artifact.title}
              </button>
            </Fragment>
          ))}
        </p>
      )}
      {openFolded && card(openFolded.shown, true)}
    </>
  );
}

const TILE = "relative block h-[84px] w-[132px] shrink-0 overflow-hidden rounded-md border bg-muted/40";

/** One thumbnail with its title under it. */
function Thumb({ laid, active, onOpen }: { laid: Laid; active: boolean; onOpen: () => void }) {
  const { shown, place } = laid;
  return (
    <div className="flex w-[132px] shrink-0 flex-col gap-0.5" data-testid="deliverable-thumb" data-kind={place.show === "file" ? place.kind : "video"}>
      <div className={cn("rounded-md", active && "ring-2 ring-ring")}>
        {place.show === "file" ? <FileThumb place={place} url={shown.artifact.url} title={shown.artifact.title} onOpen={onOpen} /> : place.show === "link" ? <VideoThumb href={place.href} title={shown.artifact.title} /> : null}
      </div>
      <span className="truncate text-xs text-muted-foreground" title={shown.artifact.title}>{shown.artifact.title}</span>
    </div>
  );
}

/** A screenshot's or a recording's thumbnail, read through the run its file is in (a job's newest run when the turn knows none). */
function FileThumb({ place, url, title, onOpen }: { place: Extract<ArtifactPlace, { show: "file" }>; url?: string; title: string; onOpen: () => void }) {
  const found = useJobRun(place.run ? undefined : place.job, url);
  const run = place.run ?? found.data;
  if (!run) return <div className={TILE} />;
  if (place.kind === "walkthrough") return <WalkthroughPlayer mode="thumb" workflow={run.workflow} runId={run.runId} path={place.path} onOpen={onOpen} className="h-[84px] w-[132px]" />;
  return <ImageThumb workflow={run.workflow} runId={run.runId} path={place.path} title={title} onOpen={onOpen} />;
}

function ImageThumb({ workflow, runId, path, title, onOpen }: { workflow: string; runId: string; path: string; title: string; onOpen: () => void }) {
  const image = useRunFileUrl(workflow, runId, path);
  return (
    <button type="button" onClick={onOpen} aria-label={`Open ${title}`} className={cn(TILE, "cursor-pointer")}>
      {image.url && <img src={image.url} alt={title} className="size-full object-cover object-top" />}
    </button>
  );
}

/** A video: a dark tile with a play mark, opened beside the chat (a page plays no file bigger than `run/files` reads). */
function VideoThumb({ href, title }: { href: string; title: string }) {
  const host = useHost();
  return (
    <button type="button" onClick={() => void host.openLink(href)} title="Play beside the chat" aria-label={`Play ${title}`} className={cn(TILE, "flex cursor-pointer items-center justify-center bg-neutral-900 text-white")}>
      <Video className="absolute left-1.5 top-1.5 size-3.5 opacity-70" />
      <span className="flex size-8 items-center justify-center rounded-full bg-black/60">
        <Play className="size-4 fill-current" />
      </span>
    </button>
  );
}
