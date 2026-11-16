// Sharing a worker app (plans/human-steps.md §9.5): how a type's workers get
// in. `staff/types` answers each type's `share`: whether its app is in the
// public view and, when it is, its links (`publicAppLinks`) and the Peel one
// as a QR code. The Queue shows a block for each public worker app; a type's
// page shows its app's, or says it is not public. Making an app public stays
// the Public view dialog or an `app/make-public` proposal.
import { useRef, useState } from "react";
import { Check, Copy, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TaskType, TypeShare } from "../lib/types";
import { Note } from "./bits";

/** The QR, as an image of the step's SVG (no markup of its own on the page). */
function Qr(props: { svg: string; label: string }) {
  return <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(props.svg)}`} alt={props.label} className="size-40 shrink-0 self-center rounded-md border bg-white sm:size-44 sm:self-start" data-testid="share-qr" />;
}

function CopyLine(props: { label: string; value: string; hint: string }) {
  const [state, setState] = useState<"" | "copied" | "selected">("");
  const text = useRef<HTMLElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.value);
      setState("copied");
    } catch {
      // A frame without the clipboard (a host that grants none, a page not
      // focused): select the link, so a key press copies it.
      if (text.current) window.getSelection()?.selectAllChildren(text.current);
      setState("selected");
    }
    setTimeout(() => setState(""), 2500);
  };
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{props.label}</span>
        <Button variant="outline" size="xs" className="ml-auto" onClick={() => void copy()} aria-label={`Copy the ${props.label}`}>
          {state === "copied" ? <Check /> : <Copy />} {state === "copied" ? "Copied" : state === "selected" ? "Selected: copy it" : "Copy"}
        </Button>
      </div>
      <code ref={text} className="block rounded bg-muted px-2 py-1 font-mono text-xs break-all select-all">
        {props.value}
      </code>
      <Note>{props.hint}</Note>
    </div>
  );
}

/** The block: the QR of the Peel link, and both links to copy. */
export function ShareBlock(props: { app: string; share: TypeShare; types?: string[] }) {
  const { share } = props;
  if (!share.peelLink || !share.link) return null;
  return (
    <section className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-start sm:gap-5" aria-label={`Share ${props.app} with workers`} data-testid="share-block">
      {share.qrSvg && <Qr svg={share.qrSvg} label={`QR code: opens ${props.app} in Peel`} />}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Share2 className="size-4 text-muted-foreground" /> Share with workers
          </h3>
          <Note>
            {props.app} is in the public view{props.types?.length ? `; its workers answer ${props.types.join(", ")}` : ""}. Scanned with an iPhone camera, the code opens it in Peel.
          </Note>
        </div>
        <CopyLine label="Peel link" value={share.peelLink} hint="For a worker with Peel: opens the app there, signed in with their Sphinx key." />
        <CopyLine label="Web link" value={share.link} hint="For a worker in a browser: the same app, without Peel." />
      </div>
    </section>
  );
}

/** A type's page: its app's block, or why there is none. */
export function TypeShareLine(props: { type: TaskType }) {
  const { type } = props;
  const share = type.share;
  if (!share) return null;
  if (share.public && share.peelLink) return <ShareBlock app={type.app} share={share} />;
  if (share.public) return <Note>{type.app} is in the public view; its links show once this server has been reached at its address.</Note>;
  return (
    <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground" data-testid="share-not-public">
      Workers answer this type in {type.app}, which is not in the public view, so there is no link to hand them. Add it in the Public view, or accept an app/make-public proposal for it.
    </p>
  );
}
