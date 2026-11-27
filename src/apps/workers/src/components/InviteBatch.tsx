// A batch of invites just made (several from one New invite): a sheet of one
// card per invite — its number, QR code, Copy and Share in WhatsApp — and, for
// the whole batch, Copy all links, Download CSV and Print. Each invite is
// still its own single-use Sphinx invite (made by `staff/invite`, one after
// another); the sheet only lays them out. The status of each follows the
// invites' read (Share passes it), so one taken moves on here as in the list.
import { useEffect, useState } from "react";
import { Check, Copy, Download, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { inviteCsv, inviteOpen, type BatchRow } from "../lib/view";
import type { MadeInvite } from "../lib/types";
import { InviteBadge, WhatsappButton } from "./Invite";
import { Note } from "./bits";

/** While a sheet is on the page, printing shows it alone: one card per invite, none split across pages. */
const PRINT_CSS =
  "@media print { body * { visibility: hidden !important; } [data-print-sheet], [data-print-sheet] * { visibility: visible !important; } [data-print-sheet] { position: absolute; left: 0; top: 0; width: 100%; } [data-print-hide] { display: none !important; } [data-print-card] { break-inside: avoid; } }";

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function CardCopy(props: { link: string; n: number }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="xs"
      variant="outline"
      aria-label={`Copy link ${props.n}`}
      onClick={() =>
        void navigator.clipboard?.writeText(props.link).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        })
      }
    >
      {done ? <Check /> : <Copy />} {done ? "Copied" : "Copy"}
    </Button>
  );
}

export function InviteBatch(props: { invites: MadeInvite[]; label?: string | undefined; work?: string | undefined }) {
  const [said, setSaid] = useState("");
  useEffect(() => {
    const el = document.createElement("style");
    el.textContent = PRINT_CSS;
    document.head.appendChild(el);
    return () => el.remove();
  }, []);
  const rows: BatchRow[] = props.invites.flatMap((i, k) => (i.link ? [{ n: k + 1, label: props.label, link: i.link }] : []));
  const copyAll = () =>
    void navigator.clipboard?.writeText(rows.map((r) => r.link).join("\n")).then(
      () => setSaid(`Copied ${rows.length} links, one a line.`),
      () => setSaid("This page cannot copy: use Download CSV."),
    );
  const title = props.label || "Invites";
  return (
    <div className="flex flex-col gap-3 rounded-md border border-dashed p-3" data-testid="invite-batch" data-print-sheet>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          {title}: {props.invites.length} {props.invites.length === 1 ? "invite" : "invites"}
        </span>
        {props.work && <span className="text-sm text-muted-foreground">for {props.work}</span>}
        <div className="flex flex-wrap gap-2 sm:ml-auto" data-print-hide>
          <Button size="xs" variant="outline" disabled={!rows.length} onClick={copyAll}>
            <Copy /> Copy all links
          </Button>
          <Button size="xs" variant="outline" disabled={!rows.length} onClick={() => download(`${(props.label || "invites").replace(/[^\w.-]+/g, "-")}.csv`, inviteCsv(rows), "text/csv")}>
            <Download /> Download CSV
          </Button>
          <Button size="xs" variant="outline" disabled={!rows.length} onClick={() => window.print()}>
            <Printer /> Print
          </Button>
        </div>
      </div>
      {said && <Note>{said}</Note>}
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="invite-batch-cards">
        {props.invites.map((i, k) => {
          const open = inviteOpen(i);
          return (
            <li key={i.code} className="flex min-w-0 flex-col items-center gap-2 rounded-md border p-3" data-testid="invite-batch-card" data-print-card>
              <div className="flex w-full items-center gap-2 text-sm">
                <span className="font-semibold tabular-nums">#{k + 1}</span>
                {props.label && <span className="min-w-0 truncate text-muted-foreground">{props.label}</span>}
                <span className="ml-auto" data-print-hide>
                  <InviteBadge status={i.status} />
                </span>
              </div>
              {open && i.qrSvg ? (
                <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(i.qrSvg)}`} alt={`QR code: invite ${k + 1}`} className="size-36 rounded-md border bg-white" />
              ) : (
                <Note>{open ? "The wallet gave no link for it." : "No longer open."}</Note>
              )}
              {open && i.link && (
                <div className="flex flex-wrap items-center justify-center gap-2" data-print-hide>
                  <CardCopy link={i.link} n={k + 1} />
                  <WhatsappButton link={i.link} small />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
