// Invites (plans/human-steps.md §5.8). A worker's one link is made in the
// Invite a worker panel (./Share): the wallet's Sphinx daemon makes a Sphinx
// invite (it pays the mixer for it: the starting sats and the mixer's
// price), and strut hands back `https://<public view>/public/join#…`, which
// on a phone (Android or iPhone) gets Peel when there is none, signs them up and opens Tasks
// on the work the invite is for. Here: the invites' one read, and on the
// Workers tab every invite with its work, status, Copy and Share while it
// may be used, and Cancel. The daemon keeps the invites; strut notes only
// the work each is for.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useHost, useStrutClient } from "@strut/kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { INVITE_WORDS, acceptedBy, fmtWhen, inviteBadge, inviteExpiry, inviteOpen, invitesReadMs, shortActor, sortInvites, whatsappUrl } from "../lib/view";
import type { Invite as InviteRow, InvitesAnswer, InviteStatus, TaskType, Worker } from "../lib/types";
import { ErrorLine, Loading, Note, useAct } from "./bits";

/** The invites, one read for the Share blocks and the Workers tab: read again
 *  when the app's channel says one was used (App), and on `invitesReadMs`. */
export function useInvites() {
  const client = useStrutClient();
  return useQuery({
    queryKey: ["staff", "invites"],
    queryFn: () => client.run<InvitesAnswer>("staff/invites", {}),
    refetchInterval: (query) => invitesReadMs((query.state.data as InvitesAnswer | undefined)?.invites),
  });
}

/** The badge: a friendly word, coloured by status; the long wording on hover. */
export function InviteBadge(props: { status: InviteStatus }) {
  const b = inviteBadge(props.status);
  return (
    <Badge variant="outline" className={b.className} title={INVITE_WORDS[props.status]}>
      {b.label}
    </Badge>
  );
}

/** Share the link in WhatsApp: an https link the host opens (a frame opens
 *  no `sms:`). Absent outside a host. */
export function WhatsappButton(props: { link: string; small?: boolean; onRefused?: (why: string) => void }) {
  const host = useHost();
  if (!host.connected) return null;
  return (
    <Button size={props.small ? "xs" : "sm"} variant="outline" onClick={() => void host.openLink(whatsappUrl(props.link)).catch(() => props.onRefused?.("This page cannot open WhatsApp: copy the link."))}>
      Share in WhatsApp
    </Button>
  );
}

/** Copy the link; share it in WhatsApp. */
function LinkActions(props: { link: string }) {
  const [said, setSaid] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="xs"
        variant="outline"
        onClick={() =>
          void navigator.clipboard?.writeText(props.link).then(
            () => setSaid("Copied."),
            () => setSaid("Select it and copy by hand."),
          )
        }
      >
        Copy link
      </Button>
      <WhatsappButton link={props.link} small onRefused={setSaid} />
      {said && <span className="text-xs text-muted-foreground">{said}</span>}
    </div>
  );
}

/** The invites made, newest first, in a box that scrolls: status badge, work,
 *  sats, made, who took it and when, link expiry, Copy / WhatsApp / Cancel
 *  while it may be used. `workers` tells who took which (their grant's `by`). */
export function InviteList(props: { types?: TaskType[] | undefined; workers?: Worker[] | undefined }) {
  const q = useInvites();
  const client = useStrutClient();
  const queries = useQueryClient();
  const { act, busy, error } = useAct();
  if (q.error) return <ErrorLine error={q.error} />;
  if (!q.data) return <Loading>Reading the invites…</Loading>;
  if (q.data.why) return null;
  const invites = sortInvites(q.data.invites);
  if (!invites.length) return <Note>No invites yet. Use New invite to make one.</Note>;
  /** The work an invite is for, as staff call it. */
  const workOf = (i: InviteRow) => {
    if (!i.type) return "Anything open";
    const title = props.types?.find((t) => t.name === i.type)?.title?.trim();
    return title || i.type;
  };
  const cancel = async (code: string) => {
    if (await act(`cancel ${code}`, () => client.run("staff/cancel-invite", { code }))) await queries.invalidateQueries({ queryKey: ["staff", "invites"] });
  };
  return (
    <div className="flex flex-col gap-2">
      <ErrorLine error={error} />
      <ul className="flex max-h-[28rem] flex-col divide-y overflow-y-auto rounded-md border" data-testid="invite-list">
        {invites.map((i) => {
          const took = i.status === "used" ? acceptedBy(i, props.workers) : null;
          const until = inviteOpen(i) ? inviteExpiry(i) : null;
          const maker = i.by ? shortActor(i.by) : "";
          return (
            <li key={i.code} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm" data-testid="invite-row">
              <InviteBadge status={i.status} />
              <span className={i.type ? "font-medium" : "text-muted-foreground"}>{workOf(i)}</span>
              <span className="tabular-nums">{i.sats.toLocaleString("en-US")} sats</span>
              <span className="font-mono text-xs text-muted-foreground" title={i.code}>
                {i.code.length > 14 ? `${i.code.slice(0, 6)}…${i.code.slice(-6)}` : i.code}
              </span>
              <div className="flex basis-full flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                <span>Made {i.createdAt ? new Date(i.createdAt).toLocaleString() : "—"}{maker && ` by ${maker}`}</span>
                {took && <span className="text-foreground">Taken by {took.who}{took.at !== undefined && `, ${fmtWhen(took.at)}`}</span>}
                {until !== null && <span>link valid until {new Date(until).toLocaleDateString()}</span>}
              </div>
              {inviteOpen(i) && (
                <div className="flex basis-full flex-wrap items-center gap-2">
                  {i.link && <LinkActions link={i.link} />}
                  <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => void cancel(i.code)}>
                    Cancel
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
