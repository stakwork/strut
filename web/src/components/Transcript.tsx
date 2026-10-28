import { formatJson } from "../helpers";
import { groupStatus, STATUS_TITLE, type AttachmentView, type ChatEntry } from "@strut/kit/folds";
import { CloseIcon, FileIcon } from "../icons";
import { ToolResultView } from "./ToolResultView";
import { NoticeView } from "./NoticeView";
import { Markdown } from "./Markdown";
import { WalkView } from "./WalkView";

// ── Transcript ─────────────────────────────────────────────────────────────
//
// The entries of a conversation (`transcript.ts`), rendered: user bubbles,
// assistant markdown, tool-call chips that disclose their input and result,
// notice cards, and turn marks. The chat flyout renders its live and
// replayed chat through this; the job timeline's thread view renders an
// agent session read back from a run. `live` = the last entry may still be
// streaming (plain text, pending dots). `expanded` is the caller's: the
// chat keeps chips open across re-renders of a streaming turn.

/** A message's attached files: an image as its thumbnail, anything else as
 *  a chip (name, size). `onRemove` makes them removable — the composer's
 *  pending files. */
export function AttachmentList(props: {
  items: AttachmentView[];
  onRemove?: (index: number) => void;
}) {
  return (
    <div class="chat-attachments">
      {props.items.map((a, i) => (
        <div key={i} class={`chat-attachment${a.src ? " is-image" : ""}`} title={`${a.name} (${a.mediaType}, ${a.size})`}>
          {a.src ? (
            <img src={a.src} alt={a.name} />
          ) : (
            <>
              <FileIcon size={14} />
              <span class="chat-attachment-name">{a.name}</span>
              <span class="chat-attachment-size">{a.size}</span>
            </>
          )}
          {props.onRemove && (
            <button
              type="button"
              class="chat-attachment-remove"
              onClick={() => props.onRemove!(i)}
              aria-label={`Remove ${a.name}`}
              title="Remove"
            >
              <CloseIcon size={10} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function Transcript(props: {
  entries: ChatEntry[];
  live?: boolean;
  expanded: Record<string, boolean>;
  onToggle: (key: string) => void;
  onOpenRun?: (workflow: string, runId: string) => void;
  /** A chat's id, for a graph walk's live graph; a thread has none. */
  chatId?: string | null;
}) {
  const { entries, expanded, onToggle } = props;
  const live = !!props.live;
  return (
    <>
      {entries.map((entry, i) => {
        if (entry.kind === "user") {
          return (
            <div key={i} class="chat-msg chat-msg-user">
              {entry.package && <span class="chat-msg-package" title="The package this message was sent under">{entry.package}</span>}
              {entry.attachments?.length ? <AttachmentList items={entry.attachments} /> : null}
              {entry.content && <div class="chat-msg-text">{entry.content}</div>}
            </div>
          );
        }
        if (entry.kind === "mark") {
          return (
            <div key={i} class="chat-mark" role="separator">
              <span class="chat-mark-label">{entry.label}</span>
              {entry.detail && <span class="chat-mark-detail">{entry.detail}</span>}
            </div>
          );
        }
        if (entry.kind === "notice") {
          return (
            <NoticeView
              key={i}
              text={entry.content}
              prefix={`notice:${i}`}
              expanded={expanded}
              onToggle={onToggle}
              onOpenRun={props.onOpenRun}
            />
          );
        }
        if (entry.kind === "tool") {
          return (
            <div key={i} class="chat-tool-calls">
              {entry.groups.map((g, j) => {
                const key = `${i}:${j}`;
                // A graph walk renders as its live graph, not a JSON chip.
                if (g.name === "graph_walk" && props.chatId) {
                  return g.calls.map((tc, k) => (
                    <WalkView
                      key={`${j}:${tc.toolCallId ?? k}`}
                      chatId={props.chatId!}
                      toolCallId={tc.toolCallId}
                      input={tc.input}
                      progress={tc.progress}
                      result={tc.result}
                      live={live && i === entries.length - 1}
                      onOpenRun={props.onOpenRun ?? (() => {})}
                    />
                  ));
                }
                const isOpen = !!expanded[key];
                const count = g.calls.length;
                const status = groupStatus(g, live && i === entries.length - 1);
                return (
                  <div key={j} class={`chat-tool-call${isOpen ? " is-open" : ""}`}>
                    <button
                      type="button"
                      class="chat-tool-head"
                      onClick={() => onToggle(key)}
                      aria-expanded={isOpen}
                    >
                      <span class={`chat-tool-dot is-${status}`} title={STATUS_TITLE[status]} />
                      <span class="chat-tool-name">{g.name}</span>
                      <span class="chat-tool-meta">
                        {status === "error" && <span class="chat-tool-err">error</span>}
                        {count > 1 && <span class="chat-tool-count">×{count}</span>}
                      </span>
                    </button>
                    {isOpen && (
                      <div class="chat-tool-body">
                        {g.calls.map((tc, k) => {
                          const rkey = `${key}:${k}:result`;
                          return (
                            <div key={k} class="chat-tool-item">
                              <pre class="chat-tool-input">{formatJson(tc.input)}</pre>
                              <ToolResultView
                                result={tc.result}
                                open={!!expanded[rkey]}
                                onToggle={() => onToggle(rkey)}
                              />
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        }
        // kind === "text" — plain text while tokens are still streaming into
        // this bubble (the last entry of a live turn); markdown once done.
        const streaming = live && i === entries.length - 1;
        return (
          <div key={i} class="chat-msg chat-msg-assistant">
            {streaming
              ? <div class="chat-msg-text">{entry.content}</div>
              : <Markdown class="chat-msg-text" source={entry.content} />}
          </div>
        );
      })}
    </>
  );
}
