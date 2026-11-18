// Connect (plans/jamie-in-tribes.md §3): the viewer's accounts on other
// media, linked so a host knows them — a Sphinx tribe's Jamie runs their
// turns as them. Connect Sphinx shows a one-time code and the account to send
// it to by DM (its address, and as a QR to add it as a contact); the host
// that speaks for that account links the key that sent it, and the list
// shows the link while the code waits. A link is removed here.
import { useEffect, useState } from "react";
import { ArrowLeft, Link2, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLinkCode, useLinks, useUnlink } from "../hooks";
import type { AccountLink, LinkCode } from "../lib/types";
import { CopyButton, IconButton, Notice, errorText } from "./bits";

/** How long a code is good for (src/people.ts `LINK_CODE_MS`). */
const CODE_MS = 10 * 60_000;

/** A key as a person reads it: its ends. */
export const shortKey = (key: string) => (key.length > 16 ? `${key.slice(0, 8)}…${key.slice(-6)}` : key);

export function Connect({ onClose }: { onClose: () => void }) {
  const make = useLinkCode();
  const [code, setCode] = useState<(LinkCode & { linked?: true }) | null>(null);
  const waiting = !!code && !code.linked && code.hosts.includes("sphinx") && code.expiresAt > Date.now();
  const links = useLinks(waiting);
  const unlink = useUnlink();
  const sphinx = (links.data?.links ?? []).filter((l) => l.kind === "sphinx");
  // The link the code made: one newer than the code (both the server's clock).
  const made = code && !code.linked ? sphinx.find((l) => l.at >= code.expiresAt - CODE_MS) : undefined;
  useEffect(() => {
    if (made) setCode((c) => (c ? { ...c, linked: true } : c));
  }, [made]);
  const linked = !!code?.linked;

  const start = async () => {
    const fresh = await make.mutateAsync().catch(() => null);
    if (fresh) setCode(fresh);
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
              <h2 className="text-sm font-medium">Sphinx</h2>
              <p className="text-sm text-muted-foreground">Link your Sphinx account, so Jamie in a tribe knows it is you and works as you here.</p>
            </div>
            {links.isError && <Notice tone="error">{errorText(links.error)}</Notice>}
            {sphinx.length > 0 && (
              <ul className="flex flex-col divide-y rounded-lg border" data-testid="links">
                {sphinx.map((l) => (
                  <LinkRow key={l.account} link={l} removing={unlink.isPending && unlink.variables?.account === l.account} onRemove={() => unlink.mutate({ account: l.account })} />
                ))}
              </ul>
            )}
            {unlink.isError && <Notice tone="error">{errorText(unlink.error)}</Notice>}
            {linked ? (
              <Notice>Linked. Jamie in your tribes now knows this account is you.</Notice>
            ) : code ? (
              <CodeCard code={code} />
            ) : null}
            {!waiting && (
              <div>
                <Button size="sm" variant={sphinx.length ? "outline" : "default"} onClick={() => void start()} disabled={make.isPending}>
                  {make.isPending ? <Loader2 className="animate-spin" /> : <Link2 />}
                  {sphinx.length ? "Link another Sphinx account" : "Connect Sphinx"}
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

/** The code to send, and where to. */
function CodeCard({ code }: { code: LinkCode }) {
  if (!code.hosts.includes("sphinx")) {
    return <Notice tone="warn">Linking a Sphinx account is not set up on this server yet. Ask an admin to turn it on.</Notice>;
  }
  const until = new Date(code.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const expired = code.expiresAt <= Date.now();
  const who = code.to?.alias ? `“${code.to.alias}”` : "this server's Sphinx account";
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3" data-testid="link-code">
      <p className="text-sm">Send this code to {who} in a direct message, from the Sphinx account you want to link:</p>
      <div className="flex items-center gap-2">
        <code className="rounded-md bg-muted px-3 py-1.5 font-mono text-base tracking-wide" data-testid="code">
          {code.code}
        </code>
        <CopyButton text={code.code} label="Copy the code" />
      </div>
      {code.to && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <img src={code.to.qr} alt="QR code: the Sphinx address to send the code to" className="size-36 shrink-0 self-center rounded-md border bg-white sm:self-start" data-testid="link-qr" />
          <div className="min-w-0 text-xs text-muted-foreground">
            <p>Not a contact yet? Scan this in Sphinx to add it, or copy its address:</p>
            <div className="mt-1 flex items-center gap-1">
              <span className="truncate font-mono" title={code.to.address}>
                {code.to.address}
              </span>
              <CopyButton text={code.to.address} label="Copy the address" />
            </div>
          </div>
        </div>
      )}
      {expired ? (
        <Notice tone="warn">This code has expired. Ask for a new one.</Notice>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Waiting for your message. The code works once, until {until}.
        </p>
      )}
    </div>
  );
}
