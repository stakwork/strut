// Invite (plans/human-steps.md §5.8), on the Workers tab: one link for a new
// worker. The wallet's Sphinx daemon makes a Sphinx invite (it pays the
// mixer for it: the starting sats and the mixer's price), and strut hands
// back `https://<public view>/public/join#…`, which opens Peel on Android:
// a new Peel user signs up with the invite and lands in the worker app, an
// existing one goes straight there. Shown here: the link, its QR code, Copy
// and Share, and every invite with its status and Cancel. Nothing is kept by
// strut — the daemon keeps the invites, and an open type lets the worker in
// on their first ask.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useHost, useStrutClient } from "@strut/kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { INVITE_WORDS, inviteOpen, inviteSatsOf, inviteWhyText, whatsappUrl } from "../lib/view";
import type { Invite as InviteRow, InvitesAnswer, MadeInvite } from "../lib/types";
import { ErrorLine, Field, Loading, Note, Section, useAct } from "./bits";

/** How often the list is read while an invite is still being paid for. */
const SENDING_READ_MS = 3_000;

export function Invite() {
  const client = useStrutClient();
  const { act, busy, error } = useAct();
  const [app, setApp] = useState("");
  const [satsText, setSatsText] = useState("");
  const [made, setMade] = useState<MadeInvite | null>(null);
  const q = useQuery({
    queryKey: ["staff", "invites", app],
    queryFn: () => client.run<InvitesAnswer>("staff/invites", app ? { app } : {}),
    refetchInterval: (query) => ((query.state.data as InvitesAnswer | undefined)?.invites.some((i) => i.status === "sending") ? SENDING_READ_MS : false),
  });
  if (q.error) {
    return (
      <Section title="Invite a worker">
        <ErrorLine error={q.error} />
      </Section>
    );
  }
  if (!q.data) return <Loading>Reading the invites…</Loading>;
  const { invites, apps, why } = q.data;
  const sats = inviteSatsOf(satsText);
  const picked = app || q.data.app || "";
  // The one just made, as the list has it now (its status moves on).
  const now = made && invites.find((i) => i.code === made.code);
  const shown = made ? { ...made, ...(now ? { status: now.status } : {}) } : null;
  const make = async () => {
    if ("problem" in sats) return;
    const out = await act("invite", () => client.run<MadeInvite>("staff/invite", { ...sats, ...(picked ? { app: picked } : {}) }));
    if (out) setMade(out);
  };

  return (
    <Section title="Invite a worker" aside={<Note>One link: on Android it opens Peel, which signs them up and opens the worker app.</Note>}>
      {why ? (
        <Note>{inviteWhyText(why)}</Note>
      ) : apps.length === 0 ? (
        <Note>No task type's app is in the public view: make the worker app public first, so the link has somewhere to open.</Note>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          {apps.length > 1 && (
            <Field label="Worker app" htmlFor="invite-app">
              <NativeSelect id="invite-app" value={picked} onChange={(e) => setApp(e.target.value)}>
                <NativeSelectOption value="">an app…</NativeSelectOption>
                {apps.map((a) => (
                  <NativeSelectOption key={a} value={a}>
                    {a}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          )}
          <Field label="Starting sats" htmlFor="invite-sats">
            <Input id="invite-sats" className="w-36" inputMode="numeric" placeholder={String(q.data.sats)} value={satsText} onChange={(e) => setSatsText(e.target.value)} />
          </Field>
          <Button disabled={busy !== null || "problem" in sats || !picked} onClick={() => void make()}>
            {busy === "invite" ? "Making it…" : "Make an invite link"}
          </Button>
          <Note className={cn("w-full", "problem" in sats && "text-destructive")}>
            {"problem" in sats ? sats.problem : "Starting sats are the worker's balance in their new account; the mixer's price is paid on top."}
          </Note>
        </div>
      )}
      <ErrorLine error={error} />
      {shown && <Made invite={shown} />}
      {invites.length > 0 && <InviteTable invites={invites} />}
    </Section>
  );
}

/** The invite just made: its QR code, its link, Copy and Share. */
function Made(props: { invite: MadeInvite }) {
  const { invite } = props;
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-start">
      {invite.qr && <img src={invite.qr} alt="The invite link as a QR code" className="size-48 shrink-0 rounded-md bg-white p-2" />}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="text-sm">
          {invite.sats.toLocaleString("en-US")} sats, opening <span className="font-medium">{invite.app}</span>. <StatusBadge invite={invite} />
        </div>
        <Note>{INVITE_WORDS[invite.status]}{invite.status === "sending" ? ". It works once it is ready." : "."}</Note>
        {invite.link ? (
          <>
            <textarea readOnly className="h-20 w-full resize-none rounded-md border bg-muted p-2 font-mono text-xs break-all" value={invite.link} onFocus={(e) => e.currentTarget.select()} aria-label="The invite link" />
            <LinkActions link={invite.link} />
          </>
        ) : (
          <Note>The wallet gave no link for it.</Note>
        )}
      </div>
    </div>
  );
}

/** Copy the link; share it in WhatsApp (an https link the host opens). */
function LinkActions(props: { link: string; small?: boolean }) {
  const host = useHost();
  const [said, setSaid] = useState<string | null>(null);
  const size = props.small ? "xs" : "sm";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size={size}
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
      {host.connected && (
        <Button size={size} variant="outline" onClick={() => void host.openLink(whatsappUrl(props.link)).catch(() => setSaid("This page cannot open WhatsApp: copy the link."))}>
          Share in WhatsApp
        </Button>
      )}
      {said && <span className="text-xs text-muted-foreground">{said}</span>}
    </div>
  );
}

function StatusBadge(props: { invite: Pick<InviteRow, "status"> }) {
  const s = props.invite.status;
  return <Badge variant={s === "failed" ? "destructive" : s === "ready" ? "secondary" : "outline"}>{s}</Badge>;
}

/** Every invite the wallet keeps, newest first, with Copy and Cancel while it may be used. */
function InviteTable(props: { invites: InviteRow[] }) {
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
                <TableCell className="font-mono text-xs" title={i.code}>
                  {i.code.length > 14 ? `${i.code.slice(0, 6)}…${i.code.slice(-6)}` : i.code}
                </TableCell>
                <TableCell className="text-right tabular-nums">{i.sats.toLocaleString("en-US")}</TableCell>
                <TableCell title={INVITE_WORDS[i.status]}>
                  <StatusBadge invite={i} />
                </TableCell>
                <TableCell>
                  {inviteOpen(i) && (
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {i.link && <LinkActions link={i.link} small />}
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
