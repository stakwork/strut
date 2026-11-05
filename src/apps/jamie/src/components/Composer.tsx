// The composer (Hive's `SidebarChatInput`): a growing textarea, files by the
// paperclip, a drop or a paste, the model picker, "/" for a Concept, and
// Send — Stop while a turn runs. Enter sends; Shift+Enter is a new line.
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Check, ChevronDown, FileText, Paperclip, Square, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { useAppState } from "@strut/kit";
import { detectSlash, insertSlash, type SlashTrigger } from "../lib/chat";
import { useConcepts, useModels } from "../hooks";
import { IconButton } from "./bits";

/** The server's caps on a run's files (src/ai/attachments.ts): checked here
 *  first, so a person hears it before anything is sent. */
const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 15 * 1024 * 1024;

export interface ComposerProps {
  placeholder: string;
  /** Send the text and files; resolves when the turn is launched. */
  onSend: (text: string, files: File[], model: string) => Promise<boolean>;
  /** A turn is running: Send becomes Stop. */
  running?: { onStop: () => void; stopping: boolean } | null;
  disabled?: boolean;
  sending?: boolean;
}

export function Composer({ placeholder, onSend, running, disabled, sending }: ComposerProps) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [model, setModel] = useAppState<string>("model", "");
  const [slash, setSlash] = useState<SlashTrigger | null>(null);
  const [slashAt, setSlashAt] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const concepts = useConcepts(slash ? slash.query : null);
  const hits = concepts.data ?? [];

  const addFiles = (list: FileList | File[] | null) => {
    if (!list) return;
    const next = [...files, ...Array.from(list)];
    const big = next.find((f) => f.size > MAX_FILE_BYTES);
    if (next.length > MAX_FILES) return setFileError(`At most ${MAX_FILES} files a message.`);
    if (big) return setFileError(`${big.name} is over 10 MB.`);
    if (next.reduce((n, f) => n + f.size, 0) > MAX_TOTAL_BYTES) return setFileError("Over 15 MB of files in one message.");
    setFileError(null);
    setFiles(next);
  };

  const send = async () => {
    const t = text.trim();
    if ((!t && files.length === 0) || disabled || sending || running) return;
    if (await onSend(t, files, model)) {
      setText("");
      setFiles([]);
      setSlash(null);
    }
  };

  const pick = (name: string) => {
    if (!slash) return;
    const next = insertSlash(text, slash, name);
    setText(next.text);
    setSlash(null);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  useEffect(() => setSlashAt(0), [hits.length]);

  return (
    <div
      className="relative rounded-xl border bg-background shadow-sm focus-within:ring-1 focus-within:ring-ring"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        addFiles(e.dataTransfer.files);
      }}
    >
      {slash && (
        <div className="absolute inset-x-0 bottom-full z-20 mb-1 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-md" data-testid="slash-menu">
          {concepts.isPending ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">Looking…</p>
          ) : concepts.isError ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">No Concepts here.</p>
          ) : hits.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">No Concept matches “{slash.query}”.</p>
          ) : (
            hits.map((c, i) => (
              <button
                key={c.ref_id}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(c.name)}
                className={cn("block w-full px-3 py-1.5 text-left text-sm", i === slashAt && "bg-accent text-accent-foreground")}
              >
                <span className="font-medium">{c.name}</span>
                {c.description && <span className="ml-2 truncate text-xs text-muted-foreground">{c.description}</span>}
              </button>
            ))
          )}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-2 pt-2">
          {files.map((f, i) => (
            <span key={`${f.name}-${i}`} className="inline-flex max-w-56 items-center gap-1 rounded-md border bg-muted/40 px-1.5 py-0.5 text-xs">
              <FileText className="size-3 shrink-0" />
              <span className="truncate">{f.name}</span>
              <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-foreground">
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={area}
        value={text}
        rows={1}
        disabled={disabled}
        placeholder={placeholder}
        aria-label="Message"
        onChange={(e) => {
          setText(e.target.value);
          setSlash(detectSlash(e.target.value, e.target.selectionStart ?? e.target.value.length));
        }}
        onPaste={(e) => {
          if (e.clipboardData.files.length) {
            e.preventDefault();
            addFiles(e.clipboardData.files);
          }
        }}
        onKeyDown={(e) => {
          if (slash && hits.length) {
            if (e.key === "ArrowDown") return void (e.preventDefault(), setSlashAt((i) => (i + 1) % hits.length));
            if (e.key === "ArrowUp") return void (e.preventDefault(), setSlashAt((i) => (i - 1 + hits.length) % hits.length));
            if (e.key === "Enter" || e.key === "Tab") return void (e.preventDefault(), pick(hits[Math.min(slashAt, hits.length - 1)]!.name));
          }
          if (slash && e.key === "Escape") return void (e.preventDefault(), setSlash(null));
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
        className="block max-h-52 min-h-10 w-full resize-none bg-transparent px-3 py-2.5 text-sm outline-none [field-sizing:content] placeholder:text-muted-foreground/70"
      />
      <div className="flex items-center gap-1 px-2 pb-2">
        <input ref={picker} type="file" multiple hidden onChange={(e) => (addFiles(e.target.files), (e.target.value = ""))} />
        <IconButton label="Attach files" onClick={() => picker.current?.click()} disabled={disabled}>
          <Paperclip />
        </IconButton>
        <ModelPicker value={model} onChange={setModel} />
        {fileError && <span className="truncate text-xs text-rose-600">{fileError}</span>}
        <div className="ml-auto">
          {running ? (
            <button
              type="button"
              aria-label="Stop"
              title={running.stopping ? "Stopping…" : "Stop"}
              disabled={running.stopping}
              onClick={running.onStop}
              className="inline-flex size-8 items-center justify-center rounded-full bg-foreground text-background transition-opacity disabled:opacity-50"
            >
              <Square className="size-3 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Send"
              title="Send"
              disabled={disabled || sending || (!text.trim() && files.length === 0)}
              onClick={() => void send()}
              className="inline-flex size-8 items-center justify-center rounded-full bg-foreground text-background transition-opacity disabled:opacity-30"
            >
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The model picker (Hive's `ModelPicker`): "Default" is the assistant's own
 *  model; any other is the turn's `params.model`. Remembered per viewer
 *  (`useAppState`), so every conversation uses it. */
function ModelPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const models = useModels();
  const items = useMemo(
    () => [{ value: "", name: "Default" }, ...(models.data?.models ?? []).filter((m) => m.available).map((m) => ({ value: m.name, name: m.alias ? `${m.alias} · ${m.provider}` : m.name }))],
    [models.data],
  );
  const current = items.find((i) => i.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Model"
          title="Model"
          data-testid="model-chip"
          className="flex max-w-48 items-center gap-1 rounded-full px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <span className="truncate">{value ? (current?.name ?? value) : "Default"}</span>
          <ChevronDown className="size-3 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-72 p-0">
        <Command>
          <CommandInput placeholder="Search models" />
          <CommandList className="max-h-56">
            <CommandEmpty>{models.isError ? "The models could not be read." : "No models match."}</CommandEmpty>
            {items.map((item) => (
              <CommandItem
                key={item.value || "default"}
                value={`${item.name} ${item.value}`}
                onSelect={() => {
                  onChange(item.value);
                  setOpen(false);
                }}
                className="text-xs"
              >
                <Check className={cn("size-3.5 shrink-0", value !== item.value && "invisible")} />
                <span className="truncate">{item.name}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
