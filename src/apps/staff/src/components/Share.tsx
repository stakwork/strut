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
import { Check, Copy, QrCode, UserPlus, Users } from "lucide-react";
import { useStrutClient } from "@strut/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { INVITE_WORDS, inviteSatsOf, inviteWhyText, tasksWords } from "../lib/view";
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
      {/* One line: the link is for copying, not reading. Selecting it still takes all of it. */}
      <code ref={text} className="block truncate rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground select-all" title={props.value}>
        {props.value}
      </code>
      <Note>{props.hint}</Note>
    </div>
  );
}

/** The block, for an admin who is not technical: how workers get in. An
 *  invite for someone new first; then, for someone who has Peel already,
 *  the code to scan and the link to send. */
export function ShareBlock(props: { app: string; share: TypeShare; types?: string[] }) {
  const { share } = props;
  if (!share.peelLink || !share.link) return null;
  const tasks = tasksWords(props.types);
  return (
    <section className="flex flex-col gap-4 rounded-lg border p-4" aria-label={`Share ${props.app} with workers`} data-testid="share-block">
      <div className="flex flex-col gap-0.5">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <Users className="size-4 text-muted-foreground" /> Bring workers in
        </h3>
        <Note>Workers do {tasks || "their tasks"} on their phone. Send each of them a way in.</Note>
      </div>
      <InviteMaker app={props.app} />
      <div className="flex flex-col gap-3 border-t pt-3 sm:flex-row sm:items-start sm:gap-5">
        {share.qrSvg && <Qr svg={share.qrSvg} label="QR code: opens the worker page in Peel" />}
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <h4 className="flex items-center gap-2 text-sm font-medium">
              <QrCode className="size-4 text-muted-foreground" /> Someone who has Peel already
            </h4>
            <Note>They scan this code with their phone's camera, or you send them the link. It is the same for everyone, so it can go in a group chat.</Note>
          </div>
          <CopyLine label="Link" value={share.peelLink} hint="Opens the worker page in Peel, signed in." />
          <CopyLine label="In a browser" value={share.link} hint="The same page in any browser, for someone without Peel." />
        </div>
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
    <div className="flex flex-col gap-2" data-testid="invite-maker">
      <h4 className="flex items-center gap-2 text-sm font-medium">
        <UserPlus className="size-4 text-muted-foreground" /> Someone new
      </h4>
      <Note>
        An invite is a link for one person, used once. On an Android phone it installs Peel, the app workers use, sets up their account with a few sats to start, and opens the worker page. This server's wallet pays those sats and a small fee.
      </Note>
      {q.data?.why ? (
        <Note>{inviteWhyText(q.data.why)}</Note>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Sats they start with" htmlFor={id}>
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
            <CopyLine label="Invite link" value={invite.link} hint="Send it by text message or WhatsApp, or let them scan the code. It works once." />
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
  if (share.public) return <Note>The worker page is online; its links show here once this server has been opened at its web address.</Note>;
  return (
    <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground" data-testid="share-not-public">
      The worker page for this task ({type.app}) is not online yet, so there is no link to send. Approve the card that puts it online, or add it in the Public view.
    </p>
  );
}
