// The chat list (Hive's `ControlPanelList`): one row per conversation, its
// title alone, under its day; search, show more, the archived ones folded
// at the end. A row's menu renames (inline) and archives or restores; an
// unread one is bold with a dot, a running one pulses.
import { useEffect, useRef, useState } from "react";
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, MoreHorizontal, PanelLeftClose, Pencil, Search, SquarePen, X } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { groupByDay } from "../lib/chat";
import type { ConversationListItem } from "../lib/types";
import { PAGE, useConversationList, useUpdateConversation } from "../hooks";
import { IconButton, Notice, errorText } from "./bits";

const TITLE_MAX = 200;

export interface ChatListProps {
  active: string | null;
  onOpen: (id: string) => void;
  onNewChat: () => void;
  onHide?: () => void;
}

export function ChatList({ active, onOpen, onNewChat, onHide }: ChatListProps) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const open = useConversationList({ q: query, limit });
  const archived = useConversationList({ archived: true, q: query, limit: 50, enabled: archivedOpen });
  const archivedCount = useConversationList({ archived: true, limit: 1, enabled: !archivedOpen });
  const update = useUpdateConversation();
  const rows = open.data?.conversations ?? [];
  const groups = groupByDay(rows, new Date());
  const closeSearch = () => {
    setQuery("");
    setSearching(false);
  };
  const hasArchived = archivedOpen ? (archived.data?.conversations.length ?? 0) > 0 : (archivedCount.data?.conversations.length ?? 0) > 0;

  return (
    <section aria-label="Chats" className="flex h-full flex-col bg-background">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b pl-3 pr-2">
        {searching ? (
          <>
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onBlur={() => !query && setSearching(false)}
              onKeyDown={(e) => e.key === "Escape" && closeSearch()}
              placeholder="Search chats"
              aria-label="Search chats"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <IconButton label="Clear search" onClick={closeSearch}>
              <X />
            </IconButton>
          </>
        ) : (
          <>
            <h2 className="text-sm font-medium">Chats</h2>
            <div className="ml-auto flex items-center">
              <IconButton label="Search chats" onClick={() => setSearching(true)}>
                <Search />
              </IconButton>
              <IconButton label="New chat" onClick={onNewChat}>
                <SquarePen />
              </IconButton>
              {onHide && (
                <IconButton label="Hide chats" onClick={onHide}>
                  <PanelLeftClose />
                </IconButton>
              )}
            </div>
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4" data-testid="chat-list">
        {open.isError && <Notice tone="error">{errorText(open.error)}</Notice>}
        {groups.length === 0 && !open.isError && (
          <div className="px-2 py-6 text-sm text-muted-foreground">{open.isPending ? "Loading…" : query ? "No chats match." : hasArchived ? "No open chats." : "No chats yet."}</div>
        )}
        {groups.map((g) => (
          <Group key={g.key} label={g.label}>
            {g.items.map((item) => (
              <Row
                key={item.id}
                item={item}
                active={item.id === active}
                onOpen={() => onOpen(item.id)}
                onRename={(title) => update.mutate({ session: item.id, title })}
                action={{ label: "Archive", Icon: Archive, run: () => update.mutate({ session: item.id, archived: true }) }}
              />
            ))}
          </Group>
        ))}
        {open.data?.next && !query && (
          <button type="button" onClick={() => setLimit((l) => l + PAGE)} className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:text-foreground">
            Show more
          </button>
        )}
        {(hasArchived || archivedOpen) && (
          <Group label="Archived" expanded={archivedOpen} onToggle={() => setArchivedOpen((o) => !o)}>
            {(archived.data?.conversations ?? []).map((item) => (
              <Row
                key={item.id}
                item={item}
                active={item.id === active}
                onOpen={() => onOpen(item.id)}
                onRename={(title) => update.mutate({ session: item.id, title })}
                action={{ label: "Restore", Icon: ArchiveRestore, run: () => update.mutate({ session: item.id, archived: false }) }}
              />
            ))}
          </Group>
        )}
        {update.isError && <Notice tone="error">{errorText(update.error)}</Notice>}
      </div>
    </section>
  );
}

function Group({ label, expanded, onToggle, children }: { label: string; expanded?: boolean; onToggle?: () => void; children: React.ReactNode }) {
  const [own, setOwn] = useState(true);
  const open = expanded ?? own;
  return (
    <section className="pt-3">
      <button
        type="button"
        onClick={onToggle ?? (() => setOwn((o) => !o))}
        aria-expanded={open}
        className="group flex items-center gap-1 px-2 pb-1 text-xs text-muted-foreground hover:text-foreground"
      >
        {label}
        {open ? <ChevronDown className="size-3 opacity-0 transition-opacity group-hover:opacity-100" /> : <ChevronRight className="size-3" />}
      </button>
      {open && children}
    </section>
  );
}

function Row({
  item,
  active,
  onOpen,
  onRename,
  action,
}: {
  item: ConversationListItem;
  active: boolean;
  onOpen: () => void;
  onRename: (title: string) => void;
  action: { label: string; Icon: typeof Archive; run: () => void };
}) {
  const [editing, setEditing] = useState(false);
  // The menu hands focus back to its trigger on close, which would blur the input.
  const renaming = useRef(false);
  const unread = item.unread && !active;
  return (
    <div
      data-testid="chat-row"
      data-chat-id={item.id}
      className={cn(
        "group relative flex h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors",
        active ? "bg-muted text-foreground" : "text-foreground/80 hover:bg-muted/60 hover:text-foreground",
      )}
    >
      {editing ? (
        <RenameInput
          initial={item.title}
          onDone={(t) => {
            setEditing(false);
            if (t !== null && t !== item.title) onRename(t);
          }}
        />
      ) : (
        <button
          type="button"
          title={item.title}
          onClick={onOpen}
          aria-current={active ? "page" : undefined}
          className={cn(
            "min-w-0 flex-1 truncate text-left outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:ring-1 focus-visible:after:ring-ring",
            unread && "font-semibold text-foreground",
          )}
        >
          {item.title || "Untitled"}
        </button>
      )}
      <span className="relative z-10 flex size-5 shrink-0 items-center justify-center">
        {(item.running || unread) && (
          <span
            role="status"
            aria-label={item.running ? "Working" : "Unread"}
            className={cn(
              "size-1.5 rounded-full group-focus-within:hidden group-hover:hidden group-has-[[data-state=open]]:hidden",
              item.running ? "animate-pulse bg-muted-foreground/60" : "bg-sky-500",
            )}
          />
        )}
        <span className="absolute inset-0 hidden items-center justify-center group-focus-within:flex group-hover:flex has-[[data-state=open]]:flex">
          {/* Not modal: a modal menu traps focus until it is gone, taking it
              back from the rename field as that field focuses itself. */}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="Chat actions" className="rounded p-0.5 text-muted-foreground hover:text-foreground">
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onCloseAutoFocus={(e) => {
                if (renaming.current) {
                  e.preventDefault();
                  renaming.current = false;
                }
              }}
            >
              <DropdownMenuItem
                onSelect={() => {
                  renaming.current = true;
                  setEditing(true);
                }}
              >
                <Pencil />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={action.run}>
                <action.Icon />
                {action.label}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </span>
    </div>
  );
}

/** Enter or blur saves, Escape cancels, a blank title cancels. */
function RenameInput({ initial, onDone }: { initial: string; onDone: (title: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  // On the next frame: the menu that chose Rename is closing in this one.
  useEffect(() => {
    const f = requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.select();
    });
    return () => cancelAnimationFrame(f);
  }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const t = value.trim();
    onDone(save && t ? t.slice(0, TITLE_MAX) : null);
  };
  return (
    <input
      ref={ref}
      aria-label="Chat title"
      value={value}
      maxLength={TITLE_MAX}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
        e.stopPropagation();
      }}
      className="relative z-10 min-w-0 flex-1 rounded border bg-background px-1 text-sm outline-none focus:ring-1 focus:ring-ring"
    />
  );
}
