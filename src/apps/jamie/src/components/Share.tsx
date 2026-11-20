// Share (plans/jamie-app.md §5): a shared conversation is the team's — in
// everyone's list, read and answered by anyone on this strut — and its LINK
// (the host's page at `?input=session%3D<id>`, @strut/kit `useShareLink`)
// opens it for them. Until it is shared the link opens it for nobody else,
// so on an unshared chat the one action shares it AND copies the link; a
// shared one copies its link or stops sharing. The link is copied first,
// inside the click: the clipboard takes a write only while the click is
// fresh, and sharing is a call to the server. A host with no address to
// give (Peel's web view) offers no link, and Share alone.
import { useState } from "react";
import { Check, Link2, Users, UserX } from "lucide-react";
import { useHost, useShareLink } from "@strut/kit";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useUpdateConversation } from "../hooks";
import { copyText } from "./bits";

/** Sharing a conversation and copying its link, with what happened last. */
export function useShareChat() {
  const link = useShareLink();
  const update = useUpdateConversation();
  const [copied, setCopied] = useState(false);
  const copy = (session: string) => {
    if (!link) return;
    void copyText(link({ session })).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return {
    /** A link can be given here. */
    linkable: !!link,
    copied,
    update,
    copy,
    /** Share and copy the link (when there is one), or stop sharing. */
    setShared(session: string, shared: boolean) {
      if (shared) copy(session);
      update.mutate({ session, shared });
    },
  };
}

/** Who a shared chat is open to, in a line. */
export function useShareWho(): string {
  const name = useHost().name;
  return `Anyone on ${name ?? "this server"} can read it and reply.`;
}

/** The thread header's Share: a menu of what the conversation can do. */
export function ShareMenu({ session, shared, onChanged }: { session: string; shared: boolean; onChanged?: () => void }) {
  const share = useShareChat();
  const who = useShareWho();
  const set = (on: boolean) => {
    share.setShared(session, on);
    onChanged?.();
  };
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="share-menu"
          className={cn(
            "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs transition-colors hover:bg-muted [&_svg]:size-3.5",
            shared || share.copied ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {share.copied ? <Check /> : <Users />}
          {share.copied ? "Link copied" : shared ? "Shared" : "Share"}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {shared ? `Shared. ${who}` : `Share it with the team? ${who}`}
        </DropdownMenuLabel>
        {shared ? (
          <>
            {share.linkable && (
              <DropdownMenuItem onSelect={() => share.copy(session)}>
                <Link2 />
                Copy link
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => set(false)}>
              <UserX />
              Stop sharing
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem onSelect={() => set(true)}>
            {share.linkable ? <Link2 /> : <Users />}
            {share.linkable ? "Share and copy link" : "Share with the team"}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
