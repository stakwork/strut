// Sharing a worker app (plans/human-steps.md §9.5): how a type's workers get
// in. `staff/types` answers each type's `share`: whether its app is in the
// public view and, when it is, its links (`publicAppLinks`) and the Peel one
// as a QR code. The Queue shows a block for each public worker app; a type's
// page shows its app's, or says it is not public. Making an app public stays
// the Public view dialog or an `app/make-public` proposal. For someone new
// to Peel the block makes an INVITE link (§5.8, ./Invite): one use, on
// Android it installs Peel, makes their Sphinx account with starting sats
// and opens the app at the same share link.
import { useRef, useState } from "react";
import { Check, Copy, Share2, UserPlus } from "lucide-react";
import { useStrutClient } from "@strut/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { INVITE_WORDS, inviteSatsOf, inviteWhyText } from "../lib/view";
import type { MadeInvite, TaskType, TypeShare } from "../lib/types";
import { ErrorLine, Field, Note, useAct } from "./bits";
import { InviteBadge, useInvites, WhatsappButton } from "./Invite";

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
        <InviteMaker app={props.app} />
      </div>
    </section>
  );
}

/** For someone new to Peel: a one-use invite link (§5.8). */
function InviteMaker(props: { app: string }) {
  const client = useStrutClient();
  const q = useInvites();
  const { act, busy, error } = useAct();
  const [satsText, setSatsText] = useState("");
  const [made, setMade] = useState<MadeInvite | null>(null);
  const sats = inviteSatsOf(satsText);
  // The one just made, its status as the list has it now (it moves on).
  const now = made && q.data?.invites.find((i) => i.code === made.code);
  const shown = made ? { ...made, ...(now ? { status: now.status } : {}) } : null;
  const make = async () => {
    if ("problem" in sats) return;
    const out = await act("invite", () => client.run<MadeInvite>("staff/invite", { ...sats, app: props.app }));
    if (out) setMade(out);
  };
  const id = `invite-sats-${props.app}`;
  return (
    <div className="flex flex-col gap-2 border-t pt-3" data-testid="invite-maker">
      <h4 className="flex items-center gap-2 text-sm font-medium">
        <UserPlus className="size-4 text-muted-foreground" /> Someone new to Peel
      </h4>
      <Note>
        An invite link, for one person on Android: it installs Peel, makes their Sphinx account with starting sats, then opens {props.app}. The wallet pays the sats and the mixer's price.
      </Note>
      {q.data?.why ? (
        <Note>{inviteWhyText(q.data.why)}</Note>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Starting sats" htmlFor={id}>
            <Input id={id} className="w-32" inputMode="numeric" placeholder={q.data ? String(q.data.sats) : ""} value={satsText} onChange={(e) => setSatsText(e.target.value)} />
          </Field>
          <Button size="sm" disabled={busy !== null || "problem" in sats || !q.data} onClick={() => void make()}>
            {busy === "invite" ? "Making it…" : "Make an invite link"}
          </Button>
        </div>
      )}
      {"problem" in sats && <Note className="text-destructive">{sats.problem}</Note>}
      <ErrorLine error={error ?? q.error} />
      {shown && <MadeCard invite={shown} />}
    </div>
  );
}

/** The invite just made: its QR code, its link to copy, Share in WhatsApp. */
function MadeCard(props: { invite: MadeInvite }) {
  const { invite } = props;
  return (
    <div className="flex flex-col gap-3 rounded-md border border-dashed p-3 sm:flex-row sm:items-start" data-testid="invite-made">
      {invite.qrSvg && <Qr svg={invite.qrSvg} label="QR code: the invite link" />}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {invite.sats.toLocaleString("en-US")} sats <InviteBadge status={invite.status} />
        </div>
        <Note>
          {INVITE_WORDS[invite.status]}
          {invite.status === "sending" ? ". It works once it is ready." : "."}
        </Note>
        {invite.link ? (
          <>
            <CopyLine label="Invite link" value={invite.link} hint="Send it by SMS or WhatsApp, or show the code. One use." />
            <div>
              <WhatsappButton link={invite.link} />
            </div>
          </>
        ) : (
          <Note>The wallet gave no link for it.</Note>
        )}
      </div>
    </div>
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
