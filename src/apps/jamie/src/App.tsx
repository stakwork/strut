// strut/jamie (plans/jamie-app.md §5): the person's assistant — their
// conversations with the workspace's `orchestrator`, as Hive's org page
// draws them (`ChatsLayout`): the chat list beside the thread. The page
// opens on a new conversation; a row in the list or a deep link
// (`?app=strut/jamie&input=session%3D…`) opens an earlier one. A
// first-party app (src/apps/tools.ts `firstPartyApp`): it acts with its
// viewer's own rights. The thread always shows: wide, the list is docked
// beside it and folds away (remembered per viewer); narrow — a phone, or a
// host's side panel open beside the page — it is a drawer over the thread.
import { useEffect, useState } from "react";
import { useAppState, useToolInput } from "@strut/kit";
import { cn } from "@/lib/utils";
import { newConversationId } from "./lib/chat";
import { useConversationList } from "./hooks";
import { ViewerContext } from "./viewer";
import { ChatList } from "./components/ChatList";
import { Thread } from "./components/Thread";
import { Notice, errorText } from "./components/bits";

/** Narrower than this, the list is a drawer over the thread. */
const NARROW = 768;

function useNarrow() {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth < NARROW);
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < NARROW);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return narrow;
}

export default function App() {
  const list = useConversationList({});
  const viewer = list.data?.viewer;
  const input = useToolInput<{ session?: string }>();
  const [active, setActive] = useState("");
  /** A new conversation's id, before its first turn makes it one. */
  const [draft, setDraft] = useState<string | null>(null);
  const narrow = useNarrow();
  /** Wide: the person folded the list away. */
  const [listHidden, setListHidden] = useAppState<boolean>("chatsHidden", false);
  /** Narrow: the drawer is open. */
  const [drawer, setDrawer] = useState(false);
  // Turning narrow (a panel opened beside the page) never covers the thread.
  useEffect(() => {
    if (narrow) setDrawer(false);
  }, [narrow]);

  // A deep link opens its conversation.
  useEffect(() => {
    if (input?.session) {
      setDraft(null);
      setActive(input.session);
    }
  }, [input?.session]);

  // Nothing open: a new conversation. An earlier one opens only when the
  // person picks it or a link names it.
  useEffect(() => {
    if (active || draft || !viewer) return;
    setDraft(newConversationId(viewer));
  }, [active, draft, viewer]);

  /** A job to show in the open conversation: a click on it in the list. */
  const [focusJob, setFocusJob] = useState<{ job: string; at: number } | null>(null);
  const open = (id: string, job?: string) => {
    setDraft(null);
    setActive(id);
    setFocusJob(job ? { job, at: Date.now() } : null);
    setDrawer(false);
  };
  const newChat = () => {
    if (!viewer) return;
    setDraft(newConversationId(viewer));
    setDrawer(false);
  };
  const session = draft ?? (active || null);
  const showList = narrow ? drawer : !listHidden;
  const hideList = () => (narrow ? setDrawer(false) : setListHidden(true));
  const showListAgain = () => (narrow ? setDrawer(true) : setListHidden(false));

  return (
    <ViewerContext.Provider value={viewer}>
      <div className="relative flex h-screen w-full overflow-hidden bg-background text-foreground" data-testid="assistant">
        {showList && narrow && (
          <button type="button" aria-label="Hide chats" onClick={hideList} className="absolute inset-0 z-10 bg-black/40" data-testid="chats-scrim" />
        )}
        {showList && (
          <aside className={cn("w-72 shrink-0 border-r", narrow && "absolute inset-y-0 left-0 z-20 max-w-[85%] shadow-xl")} data-testid="chats">
            <ChatList active={draft ? null : active || null} onOpen={open} onNewChat={newChat} onHide={hideList} />
          </aside>
        )}
        <main className="flex min-w-0 flex-1 flex-col">
          {list.isError && !list.data ? (
            <div className="p-6">
              <Notice tone="error">{errorText(list.error)}</Notice>
            </div>
          ) : (
            <Thread
              session={session}
              draft={!!draft}
              {...(focusJob ? { focusJob } : {})}
              onStarted={(id) => {
                setDraft(null);
                setActive(id);
              }}
              {...(showList ? {} : { onShowList: showListAgain })}
            />
          )}
        </main>
      </div>
    </ViewerContext.Provider>
  );
}
