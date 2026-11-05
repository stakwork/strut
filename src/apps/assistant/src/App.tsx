// strut/assistant (plans/jamie-app.md §5): the person's assistant — their
// conversations with the workspace's `orchestrator`, as Hive's org page
// draws them (`ChatsLayout`): the chat list beside the thread. The open
// conversation is remembered per viewer (`useAppState`); a deep link opens
// one (`?app=strut/assistant&input=session%3D…`). A first-party app
// (src/apps/tools.ts `firstPartyApp`): it acts with its viewer's own rights.
import { useEffect, useState } from "react";
import { useAppState, useToolInput } from "@strut/kit";
import { cn } from "@/lib/utils";
import { newConversationId } from "./lib/chat";
import { useConversationList } from "./hooks";
import { ViewerContext } from "./viewer";
import { ChatList } from "./components/ChatList";
import { Thread } from "./components/Thread";
import { Notice, errorText } from "./components/bits";

/** Narrower than this, the list and the thread take turns. */
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
  const [active, setActive, state] = useAppState<string>("conversation", "");
  /** A new conversation's id, before its first turn makes it one. */
  const [draft, setDraft] = useState<string | null>(null);
  const narrow = useNarrow();
  const [listShown, setListShown] = useState(true);

  // A deep link opens its conversation.
  useEffect(() => {
    if (input?.session) {
      setDraft(null);
      setActive(input.session);
    }
  }, [input?.session]);

  // Nothing open yet: the newest conversation, or a new one.
  useEffect(() => {
    if (!state.loaded || active || draft || !list.data) return;
    const first = list.data.conversations[0];
    if (first) setActive(first.id);
    else if (viewer) setDraft(newConversationId(viewer));
  }, [state.loaded, active, draft, list.data, viewer]);

  const open = (id: string) => {
    setDraft(null);
    setActive(id);
    if (narrow) setListShown(false);
  };
  const newChat = () => {
    if (!viewer) return;
    setDraft(newConversationId(viewer));
    if (narrow) setListShown(false);
  };
  const session = draft ?? (active || null);
  const showList = !narrow || listShown;
  const showThread = !narrow || !listShown;

  return (
    <ViewerContext.Provider value={viewer}>
      <div className="flex h-screen w-full overflow-hidden bg-background text-foreground" data-testid="assistant">
        {showList && (
          <aside className={cn("shrink-0 border-r", narrow ? "w-full" : "w-72")}>
            <ChatList active={draft ? null : active || null} onOpen={open} onNewChat={newChat} />
          </aside>
        )}
        {showThread && (
          <main className="flex min-w-0 flex-1 flex-col">
            {list.isError && !list.data ? (
              <div className="p-6">
                <Notice tone="error">{errorText(list.error)}</Notice>
              </div>
            ) : (
              <Thread
                session={session}
                draft={!!draft}
                onStarted={(id) => {
                  setDraft(null);
                  setActive(id);
                }}
                {...(narrow ? { onShowList: () => setListShown(true) } : {})}
              />
            )}
          </main>
        )}
      </div>
    </ViewerContext.Provider>
  );
}
