// Connect (plans/people-and-hosts.md §2.1): the viewer's Peel, linked so
// Jamie in a Sphinx tribe knows their messages are theirs and Peel opens this
// server's apps as them. Link Peel shows a one-time link challenge naming the
// viewer, as a QR and an Open in Peel link; Peel signs it with its Sphinx key,
// and the list shows the link while the challenge waits. A link is removed
// here, which ends Peel's access at once.
import { useEffect, type Dispatch, type SetStateAction } from "react";
import { useHost } from "@strut/kit";
import { ArrowLeft, ExternalLink, Link2, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLinkOffer, useLinks, useUnlink } from "../hooks";
import type { AccountLink, LinkOffer } from "../lib/types";
import { CopyButton, IconButton, Notice, errorText } from "./bits";

/** How long a link challenge is good for (src/auth.ts `LINK_CHALLENGE_MS`). */
const OFFER_MS = 10 * 60_000;

/** A key as a person reads it: its ends. */
export const shortKey = (key: string) => (key.length > 16 ? `${key.slice(0, 8)}…${key.slice(-6)}` : key);

/** A link challenge Connect shows, and whether Peel has linked through it. */
export type Offer = (LinkOffer & { linked?: true }) | null;

/** `offer` is the app's, not Connect's own: a challenge still waiting when
 *  Connect closes is shown again when it reopens, and the link Peel made
 *  meanwhile is seen. */
export function Connect({ offer, setOffer, onClose }: { offer: Offer; setOffer: Dispatch<SetStateAction<Offer>>; onClose: () => void }) {
  const make = useLinkOffer();
  const waiting = !!offer && !offer.linked && offer.exp > Date.now();
  const links = useLinks(waiting);
  const unlink = useUnlink();
  const sphinx = (links.data?.links ?? []).filter((l) => l.kind === "sphinx");
  // The link Peel made: one newer than the challenge (both the server's clock).
  const made = offer && !offer.linked ? sphinx.find((l) => l.at >= offer.exp - OFFER_MS) : undefined;
  useEffect(() => {
    if (made) setOffer((o) => (o ? { ...o, linked: true } : o));
  }, [made]);
  const linked = !!offer?.linked;

  const start = async () => {
    const fresh = await make.mutateAsync().catch(() => null);
    if (fresh) setOffer(fresh);
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="connect">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <IconButton label="Back to the chat" onClick={onClose}>
          <ArrowLeft />
        </IconButton>
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">Connect</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex w-full max-w-xl flex-col gap-5">
          <section className="flex flex-col gap-3">
            <div>
              <h2 className="text-sm font-medium">Peel</h2>
              <p className="text-sm text-muted-foreground">Link Peel, so Jamie in a Sphinx tribe knows it is you, and Peel opens this server's apps as you.</p>
            </div>
            {links.isError && <Notice tone="error">{errorText(links.error)}</Notice>}
            {sphinx.length > 0 && (
              <ul className="flex flex-col divide-y rounded-lg border" data-testid="links">
                {sphinx.map((l) => (
                  <LinkRow
                    key={l.account}
                    link={l}
                    removing={unlink.isPending && unlink.variables?.account === l.account}
                    onRemove={() => {
                      // "Linked" spoke of the link just made: gone with any removal.
                      setOffer(null);
                      unlink.mutate({ account: l.account });
                    }}
                  />
                ))}
              </ul>
            )}
            {unlink.isError && <Notice tone="error">{errorText(unlink.error)}</Notice>}
            {linked ? <Notice>Linked. Peel now opens this server as you, and Jamie in your tribes knows it is you.</Notice> : offer ? <OfferCard offer={offer} /> : null}
            {!waiting && (
              <div>
                <Button size="sm" variant={sphinx.length ? "outline" : "default"} onClick={() => void start()} disabled={make.isPending}>
                  {make.isPending ? <Loader2 className="animate-spin" /> : <Link2 />}
                  {sphinx.length ? "Link another Peel" : "Link Peel"}
                </Button>
              </div>
            )}
            {make.isError && <Notice tone="error">{errorText(make.error)}</Notice>}
          </section>
        </div>
      </div>
    </div>
  );
}

function LinkRow({ link, removing, onRemove }: { link: AccountLink; removing: boolean; onRemove: () => void }) {
  return (
    <li className="flex items-center gap-3 px-3 py-2" data-testid="link-row">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{link.name ?? "Sphinx account"}</p>
        <p className="truncate font-mono text-xs text-muted-foreground" title={link.key}>
          {shortKey(link.key)} · linked {new Date(link.at).toLocaleDateString()}
        </p>
      </div>
      <IconButton label="Remove this link" onClick={onRemove} disabled={removing}>
        {removing ? <Loader2 className="animate-spin" /> : <Trash2 />}
      </IconButton>
    </li>
  );
}

/** The challenge to sign: a QR for Peel on another device, the link for
 *  Peel on this one. */
function OfferCard({ offer }: { offer: LinkOffer }) {
  const host = useHost();
  const until = new Date(offer.exp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const expired = offer.exp <= Date.now();
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3" data-testid="link-offer">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <img src={offer.qr} alt="QR code: the link for Peel to sign" className="size-40 shrink-0 self-center rounded-md border bg-white sm:self-start" data-testid="link-qr" />
        <div className="flex min-w-0 flex-col gap-2 text-sm">
          <p>Scan this with Peel, or open it on the phone where Peel is. Peel asks you to confirm, then links itself to you here.</p>
          <div className="flex items-center gap-1">
            <Button size="sm" onClick={() => void host.openLink(offer.link)} disabled={expired} data-testid="open-in-peel">
              <ExternalLink />
              Open in Peel
            </Button>
            <CopyButton text={offer.link} label="Copy the link" />
          </div>
        </div>
      </div>
      {expired ? (
        <Notice tone="warn">This link has expired. Ask for a new one.</Notice>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Waiting for Peel. The link works once, until {until}.
        </p>
      )}
    </div>
  );
}
