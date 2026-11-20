// Invites (plans/human-steps.md §5.8). A worker's one link is made in the
// Invite a worker panel (./Share): the wallet's Sphinx daemon makes a Sphinx
// invite (it pays the mixer for it: the starting sats and the mixer's
// price), and strut hands back `https://<public view>/public/join#…`, which
// on Android installs Peel when there is none, signs them up and opens Tasks
// on the work the invite is for. Here: the invites' one read, and on the
// Workers tab every invite with its work, status, Copy and Share while it
// may be used, and Cancel. The daemon keeps the invites; strut notes only
// the work each is for.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useHost, useStrutClient } from "@strut/kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { INVITE_WORDS, inviteOpen, invitesReadMs, whatsappUrl } from "../lib/view";
import type { Invite as InviteRow, InvitesAnswer, InviteStatus, TaskType } from "../lib/types";
import { ErrorLine, Note, Section, useAct } from "./bits";

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

/** The Workers tab's list, once there is an invite. */
export function Invites(props: { types?: TaskType[] | undefined }) {
  const q = useInvites();
  if (q.error) {
    return (
      <Section title="Invites">
        <ErrorLine error={q.error} />
      </Section>
    );
  }
  if (!q.data?.invites.length) return null;
  return (
    <Section title="Invites" aside={<Note>Made with Invite a worker, above.</Note>}>
      <InviteTable invites={q.data.invites} types={props.types} />
    </Section>
  );
}

export function InviteBadge(props: { status: InviteStatus }) {
  const s = props.status;
  return <Badge variant={s === "failed" ? "destructive" : s === "ready" ? "secondary" : "outline"}>{s}</Badge>;
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

/** Every invite the wallet keeps, newest first, with Copy and Cancel while it may be used. */
function InviteTable(props: { invites: InviteRow[]; types?: TaskType[] | undefined }) {
  /** The work an invite is for, as staff call it. */
  const workOf = (i: InviteRow) => {
    if (!i.type) return "Anything open";
    const title = props.types?.find((t) => t.name === i.type)?.title?.trim();
    return title || i.type;
  };
  const client = useStrutClient();
  const { act, busy, error } = useAct();
  return (
    <>
      <ErrorLine error={error} />
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Made</TableHead>
              <TableHead>Work</TableHead>
              <TableHead>Code</TableHead>
              <TableHead className="text-right">Sats</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.invites.map((i) => (
              <TableRow key={i.code}>
                <TableCell className="whitespace-nowrap">{i.createdAt ? new Date(i.createdAt).toLocaleString() : "—"}</TableCell>
                <TableCell className={i.type ? "" : "text-muted-foreground"}>{workOf(i)}</TableCell>
                <TableCell className="font-mono text-xs" title={i.code}>
                  {i.code.length > 14 ? `${i.code.slice(0, 6)}…${i.code.slice(-6)}` : i.code}
                </TableCell>
                <TableCell className="text-right tabular-nums">{i.sats.toLocaleString("en-US")}</TableCell>
                <TableCell title={INVITE_WORDS[i.status]}>
                  <InviteBadge status={i.status} />
                </TableCell>
                <TableCell>
                  {inviteOpen(i) && (
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {i.link && <LinkActions link={i.link} />}
                      <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => void act(`cancel ${i.code}`, () => client.run("staff/cancel-invite", { code: i.code }))}>
                        Cancel
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
