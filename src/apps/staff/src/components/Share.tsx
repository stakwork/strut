// Bringing workers in (plans/human-steps.md §5.8, §9.5): ONE panel, on the
// Queue (a closed row), on each type's page (open, that type picked) and on
// the Workers tab, where it is the always-open Invite a worker box: a header
// with New invite at the upper right (it opens the form), and the invites
// made so far below (./Invite `InviteList`), the group link folded at the end.
// First an INVITE: a link for one person, used once, that sets up Peel when
// they have none and opens Tasks (`strut/worker`, the server's one work
// page) on the kind of work it is for — giving it them when it is
// invite-only. Someone who has Peel already goes straight to Tasks, so staff
// never need to ask. Then, folded, the ONE link for a group: Tasks' own
// share link, open work only, for people who have Peel. Every link opens
// Tasks, so Tasks must be in the public view: the panel puts it there on a
// click (`staff/tasks-online`); any other app goes online through the
// Public view or an `app/make-public` card, as before.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Copy, Globe, Plus, UserPlus, Users, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useStrutClient } from "@strut/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";
import { INVITE_WORDS, anyOpenWork, inviteChoices, inviteOpen, inviteSatsOf, inviteWhyText, inviteWorkText } from "../lib/view";
import type { MadeInvite, TaskType, TypeShare, Worker } from "../lib/types";
import { ErrorLine, Field, Note, useAct } from "./bits";
import { InviteBadge, InviteList, useInvites, WhatsappButton } from "./Invite";

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

export interface BringProps {
  types?: TaskType[] | undefined;
  /** Tasks' share (`staff/types`' `tasks`): every link opens it. */
  tasks?: TypeShare | undefined;
  /** The kind of work the invite is for, fixed: a type's own page. */
  type?: string;
  /** Shown open, not as a closed row: a type's page. */
  open?: boolean;
  /** The Workers tab's box: always open, with the invites made. `workers` says who took which. */
  history?: boolean;
  workers?: Worker[] | undefined;
  /** The kind of work picked to start with, and still a choice: a type's card asked. */
  pick?: string;
}

/** The panel on a type's page, that type picked. */
export function BringWorkersIn(props: BringProps) {
  const [open, setOpen] = useState(!!props.open);
  if (props.history) return <InviteBox {...props} />;
  if (props.open) {
    return (
      <section className="flex flex-col gap-4 rounded-lg border p-4" aria-label="Bring workers in" data-testid="bring-workers-in">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <UserPlus className="size-4 text-muted-foreground" /> Invite someone to this
        </h3>
        <Body {...props} />
      </section>
    );
  }
  return (
    <section className="rounded-lg border" aria-label="Bring workers in" data-testid="bring-workers-in">
      <button type="button" className="flex w-full min-w-0 items-center gap-2 px-4 py-3 text-left text-sm hover:bg-muted/50" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <UserPlus className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-medium">Invite a worker</span>
        <span className="ml-auto hidden shrink-0 text-xs text-muted-foreground sm:inline">a link for one person, or one for a group</span>
      </button>
      {/* Kept mounted while closed, so an invite just made stays on its card. */}
      <div hidden={!open} className="flex flex-col gap-4 border-t p-4">
        <Body {...props} />
      </div>
    </section>
  );
}

/** The panel the header's Invite a worker opens, on any tab. */
export function InvitePanel(props: BringProps & { onClose: () => void }) {
  return (
    <section className="flex flex-col gap-4 rounded-lg border p-4" aria-label="Bring workers in" data-testid="bring-workers-in">
      <div className="flex items-center gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <UserPlus className="size-4 text-muted-foreground" /> Invite a worker
        </h2>
        <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Close" onClick={props.onClose}>
          <X />
        </Button>
      </div>
      <Body {...props} />
    </section>
  );
}

/** The Workers tab's box: New invite at the upper right, the invites below. */
function InviteBox(props: BringProps) {
  const [creating, setCreating] = useState(false);
  const q = useInvites();
  const tasks = props.tasks;
  return (
    <section className="flex flex-col gap-3 rounded-lg border p-4" aria-label="Bring workers in" data-testid="bring-workers-in">
      <div className="flex items-center gap-2">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <UserPlus className="size-4 text-muted-foreground" /> Invite a worker
        </h3>
        <Button size="sm" className="ml-auto" variant={creating ? "outline" : "default"} aria-expanded={creating} onClick={() => setCreating((c) => !c)}>
          {creating ? <X /> : <Plus />} {creating ? "Close" : "New invite"}
        </Button>
      </div>
      {tasks && !tasks.public && <TasksOffline />}
      {creating && !(tasks && !tasks.public) && (
        <div className="flex flex-col gap-3 rounded-md bg-muted/30 p-3">
          <Body {...props} group={false} />
        </div>
      )}
      {!creating && q.data?.why && <Note>{inviteWhyText(q.data.why)}</Note>}
      <InviteList types={props.types} workers={props.workers} />
      {tasks?.public && tasks.peelLink && anyOpenWork(props.types) && <GroupLink share={tasks} />}
    </section>
  );
}

function Body(props: BringProps & { group?: boolean }) {
  const tasks = props.tasks;
  // A host's own public view door may say nothing of Tasks: invite anyway, and the route says.
  if (tasks && !tasks.public) return <TasksOffline />;
  return (
    <>
      {tasks && !tasks.peelLink && <Note>Tasks is online; its links show here once this server has been opened at its web address.</Note>}
      <InviteMaker types={props.types} {...(props.type ? { type: props.type } : {})} {...(props.pick ? { pick: props.pick } : {})} />
      {props.group !== false && tasks?.peelLink && anyOpenWork(props.types) && <GroupLink share={tasks} />}
    </>
  );
}

/** Tasks is not in the public view: a link would have nowhere to open. */
function TasksOffline() {
  const client = useStrutClient();
  const queries = useQueryClient();
  const { act, busy, error } = useAct();
  const put = async () => {
    const out = await act("online", () => client.run("staff/tasks-online", {}));
    if (out) await queries.invalidateQueries({ queryKey: ["staff", "types"] });
  };
  return (
    <div className="flex flex-col gap-2" data-testid="tasks-offline">
      <Note>Every invite opens Tasks, the page where workers do their work, and Tasks isn't online yet. Put it online first: anyone with its link then sees its sign-in, and only signed-in workers see any work.</Note>
      <div>
        <Button size="sm" disabled={busy !== null} onClick={() => void put()}>
          <Globe /> {busy === "online" ? "Putting it online…" : "Put Tasks online"}
        </Button>
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

/** A link for one person, used once (§5.8). */
function InviteMaker(props: { types?: TaskType[] | undefined; type?: string; pick?: string }) {
  const client = useStrutClient();
  const queries = useQueryClient();
  const q = useInvites();
  const { act, busy, error } = useAct();
  const choices = inviteChoices(props.types);
  const [work, setWork] = useState(props.type ?? props.pick ?? "");
  const [satsText, setSatsText] = useState("");
  const [touched, setTouched] = useState(false);
  // Start the box at the server's default, unless they have typed.
  useEffect(() => {
    if (!touched && q.data) setSatsText(String(q.data.sats));
  }, [q.data?.sats, touched]);
  const [made, setMade] = useState<MadeInvite | null>(null);
  const sats = inviteSatsOf(satsText);
  const choice = choices.find((c) => c.name === work);
  // The one just made, its status as the list has it now (it moves on).
  const now = made && q.data?.invites.find((i) => i.code === made.code);
  const shown = made ? { ...made, ...(now ? { status: now.status } : {}) } : null;
  const offline = choice && !choice.online;
  const make = async () => {
    if ("problem" in sats) return;
    const out = await act("invite", () => client.run<MadeInvite>("staff/invite", { ...sats, ...(work ? { type: work } : {}) }));
    if (out) {
      setMade(out);
      await queries.invalidateQueries({ queryKey: ["staff", "invites"] });
    }
  };
  const id = useRef(`invite-${Math.random().toString(36).slice(2)}`).current;
  return (
    <div className="flex flex-col gap-3" data-testid="invite-maker">
      <Note>
        An invite is a link for one person, used once. On a phone (Android or iPhone) it sets up Peel, the app workers use, with a few sats to start, then opens their work. Someone who has Peel already goes straight to it. This server's wallet pays those sats and a small fee.
      </Note>
      {q.data?.why ? (
        <Note>{inviteWhyText(q.data.why)}</Note>
      ) : (
        <>
          {!props.type && (
            <Field label="Work they'll do" htmlFor={`${id}-work`} hint={inviteWorkText(choice)}>
              <NativeSelect id={`${id}-work`} value={work} onChange={(e) => setWork(e.target.value)}>
                <NativeSelectOption value="">Anything open</NativeSelectOption>
                {choices.map((c) => (
                  <NativeSelectOption key={c.name} value={c.name}>
                    {c.open ? c.label : `${c.label} · invite-only`}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          )}
          {props.type && <Note>{inviteWorkText(choice)}</Note>}
          {offline && (
            <Note className="text-destructive">
              {choice.name} is answered in {choice.app}, which isn't online yet, so the link couldn't open it. Approve the card that puts it online, or add it in the Public view.
            </Note>
          )}
          <Field label="Sats they start with" htmlFor={`${id}-sats`}>
            <Input id={`${id}-sats`} className="w-32" inputMode="numeric" value={satsText} onChange={(e) => { setTouched(true); setSatsText(e.target.value); }} />
          </Field>
          {"problem" in sats && <Note className="text-destructive">{sats.problem}</Note>}
          <div>
            <Button size="sm" disabled={busy !== null || "problem" in sats || !q.data || !!offline} onClick={() => void make()}>
              {busy === "invite" ? "Making it…" : "Make an invite link"}
            </Button>
          </div>
        </>
      )}
      <ErrorLine error={error ?? q.error} />
      {shown && <MadeCard invite={shown} work={props.types?.find((t) => t.name === shown.type)?.title?.trim() || shown.type} />}
    </div>
  );
}

/** The invite just made: its QR code, its link to copy, Share in WhatsApp —
 *  only while it may still be used; once used or cancelled, the status. */
function MadeCard(props: { invite: MadeInvite; work?: string | undefined }) {
  const { invite } = props;
  const open = inviteOpen(invite);
  return (
    <div className="flex flex-col gap-3 rounded-md border border-dashed p-3 sm:flex-row sm:items-start" data-testid="invite-made">
      {open && invite.qrSvg && <Qr svg={invite.qrSvg} label="QR code: the invite link" />}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {invite.sats.toLocaleString("en-US")} sats <InviteBadge status={invite.status} />
          {props.work && <span className="text-muted-foreground">for {props.work}</span>}
        </div>
        <Note>
          {INVITE_WORDS[invite.status]}
          {invite.status === "sending" ? ". It works once it is ready." : "."}
        </Note>
        {!open ? null : invite.link ? (
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

/** The one link for a group: Tasks in Peel, open work only. */
function GroupLink(props: { share: TypeShare }) {
  const [open, setOpen] = useState(false);
  const { share } = props;
  return (
    <div className="border-t pt-3" data-testid="group-link">
      <button type="button" className="flex w-full items-center gap-2 text-left text-sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <Users className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-medium">Anyone with the link</span>
        <span className="text-muted-foreground">· open work only, for people who have Peel</span>
      </button>
      {open && (
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-5">
          {share.qrSvg && <Qr svg={share.qrSvg} label="QR code: opens Tasks in Peel" />}
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <Note>The same link for everyone, so it can go in a group chat or on a poster. It opens Tasks in Peel, with the open work. It gives no invite-only work, and it can't set up Peel: send someone new an invite.</Note>
            {share.peelLink && <CopyLine label="Link" value={share.peelLink} hint="Opens Tasks in Peel." />}
          </div>
        </div>
      )}
    </div>
  );
}

/** What a type's page shows: the panel with that type picked. */
export function TypeInvite(props: { type: TaskType; types?: TaskType[] | undefined; tasks?: TypeShare | undefined }): ReactNode {
  if (!props.type.enabled) return <Note>It is off: turn it on to invite anyone to it.</Note>;
  return <BringWorkersIn types={props.types} tasks={props.tasks} type={props.type.name} open />;
}
