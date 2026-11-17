// Jamie on the board: a message bar on the desk, and strut/jamie's own
// thread docked beside the canvas. The conversation is the viewer's, the
// same one they would have in the assistant app; what they have picked on
// the board rides along with each turn (`about`), so "brainstorm this"
// means the card they are looking at.
import { Component, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useHost } from "@strut/kit";
import { Thread } from "strut/jamie/components/Thread";
import { useConversationList, useSend } from "strut/jamie/hooks";
import { newConversationId, turnContext } from "strut/jamie/lib/chat";
import { ViewerContext } from "strut/jamie/viewer";

const say = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The viewer's conversation on this board: a new one until its first turn, and how to send one from the bar. */
export function useJamie(about: string) {
  const host = useHost();
  const list = useConversationList({});
  const send = useSend();
  const viewer = list.data?.viewer;
  const [active, setActive] = useState("");
  /** A new conversation's id, before its first turn makes it one. */
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (active || draft || !viewer) return;
    setDraft(newConversationId(viewer));
  }, [active, draft, viewer]);
  const session = draft ?? (active || null);
  const started = (id: string) => {
    setDraft(null);
    setActive(id);
  };
  return {
    viewer,
    session,
    draft: !!draft,
    started,
    /** Why Jamie cannot be reached from this page, when it cannot. */
    unreachable: list.isError && !list.data ? say(list.error) : null,
    error,
    sending: send.isPending,
    newChat: () => {
      setActive("");
      setDraft(viewer ? newConversationId(viewer) : null);
    },
    /** Send a turn from the bar. True when it was taken. */
    say: async (text: string): Promise<boolean> => {
      if (!session || !text.trim()) return false;
      setError(null);
      try {
        await send.mutateAsync({ session, prompt: text.trim(), context: turnContext(new Date(), host.timeZone, about) });
        if (draft) started(session);
        return true;
      } catch (err) {
        setError(say(err));
        return false;
      }
    },
  };
}
export type JamieState = ReturnType<typeof useJamie>;

/** The bar on the desk: type to Jamie about what is picked. Enter sends and opens the chat; Shift+Enter adds a line. */
export function JamieBar({ jamie, subject, onOpen, shift }: { jamie: JamieState; subject: string | null; onOpen: () => void; shift: number }) {
  const [text, setText] = useState("");
  const submit = async () => {
    const words = text;
    if (!words.trim() || jamie.sending) return;
    setText("");
    onOpen();
    if (!(await jamie.say(words))) setText(words);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
    if (e.key === "Escape") e.currentTarget.blur();
  };
  return (
    <div className="sb-jbar" style={{ left: `calc(50% + ${shift / 2}px)` }} data-testid="board-jamie-bar">
      <div className="sb-jchips">
        {subject && <span className="sb-jchip sb-jquiet">About: {subject}</span>}
        <button type="button" className="sb-jchip" onClick={onOpen}>
          ⤢ Full chat
        </button>
      </div>
      <div className="sb-jfield">
        <textarea rows={1} value={text} placeholder={subject ? "Ask about this, or tell Jamie what to change" : "Message Jamie"} aria-label="Message Jamie" onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
      </div>
    </div>
  );
}

/** Jamie's failure is Jamie's alone: the map stays up, and the bar says what went wrong. */
class Guard extends Component<{ children: ReactNode }, { error: string | null }> {
  override state = { error: null as string | null };
  static getDerivedStateFromError(err: unknown) {
    return { error: say(err) };
  }
  override render() {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="sb-jbar" style={{ left: "50%" }}>
        <div className="sb-jfield">
          <span className="sb-need">Jamie could not start here: {this.state.error}</span>
        </div>
      </div>
    );
  }
}

/** The bar, or the docked thread once it is opened. */
interface DockProps {
  about: string;
  subject: string | null;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  shift: number;
  /** A turn to send as the viewer; a new `n` is a new turn. */
  ask?: { text: string; n: number } | null;
}
export function JamieDock(props: DockProps) {
  return (
    <Guard>
      <Dock {...props} />
    </Guard>
  );
}
function Dock({ about, subject, open, onOpen, onClose, shift, ask }: DockProps) {
  const jamie = useJamie(about);
  // A turn the board itself starts (its right-click menu): sent once, when there is a conversation to send it in.
  const sent = useRef(0);
  useEffect(() => {
    if (!ask || sent.current === ask.n || !jamie.session) return;
    sent.current = ask.n;
    void jamie.say(ask.text);
  }, [ask, jamie]);
  return open ? <JamiePanel jamie={jamie} about={about} onClose={onClose} /> : <JamieBar jamie={jamie} subject={subject} onOpen={onOpen} shift={shift} />;
}

/** strut/jamie's thread, docked on the left. */
export function JamiePanel({ jamie, about, onClose }: { jamie: JamieState; about: string; onClose: () => void }) {
  return (
    <ViewerContext.Provider value={jamie.viewer}>
      <aside className="sb-jamie bg-background text-foreground" data-testid="board-jamie">
        <header className="sb-jamie-head">
          <strong>Jamie</strong>
          <button type="button" className="sb-btn" disabled={!jamie.viewer || jamie.draft} onClick={jamie.newChat}>
            New chat
          </button>
          <button type="button" className="sb-btn" aria-label="Close the chat" onClick={onClose}>
            ✕
          </button>
        </header>
        {jamie.unreachable ? (
          <p className="sb-jamie-note">Jamie cannot be reached from this page: {jamie.unreachable}</p>
        ) : (
          <div className="sb-jamie-body">
            {jamie.error && <p className="sb-jamie-note sb-need">That message was not sent: {jamie.error}</p>}
            <Thread session={jamie.session} draft={jamie.draft} about={about} onStarted={jamie.started} />
          </div>
        )}
      </aside>
    </ViewerContext.Provider>
  );
}
