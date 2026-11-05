// The files a person attached to a turn (Hive's attachment row): an image as
// a thumbnail that opens large, a text file as a chip that opens to read,
// anything else as a chip. Read through `run/files` on the turn's run, where
// strut saved them; a file the viewer may not read, or one too big to be
// sent whole, stays a chip.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, X } from "lucide-react";
import { useStrutClient } from "@strut/kit";
import { attachmentShow, type TurnAttachment } from "../lib/attachments";
import { Markdown } from "./Markdown";

interface RunFile {
  text?: string;
  base64?: string;
  mediaType: string;
  truncated?: true;
}

function useTurnFile(workflow: string, runId: string, path: string | undefined, enabled = true) {
  const client = useStrutClient();
  return useQuery({
    queryKey: ["jamie", "turn-file", workflow, runId, path],
    enabled: enabled && !!path,
    staleTime: Infinity,
    retry: false,
    queryFn: () => client.run<RunFile | null>("run/files", { workflow, runId, path }),
  });
}

export function TurnAttachments({ files, workflow, runId }: { files: readonly TurnAttachment[]; workflow: string; runId: string }) {
  return (
    <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5" data-testid="turn-attachments">
      {files.map((a) => {
        const show = attachmentShow(a);
        if (show === "image") return <ImageThumb key={a.name} file={a} workflow={workflow} runId={runId} />;
        if (show === "text") return <TextChip key={a.name} file={a} workflow={workflow} runId={runId} />;
        return <Chip key={a.name} name={a.name} />;
      })}
    </div>
  );
}

function Chip({ name, onClick }: { name: string; onClick?: () => void }) {
  const body = (
    <>
      <FileText className="size-3 shrink-0" />
      <span className="max-w-48 truncate">{name}</span>
    </>
  );
  const cls = "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs text-muted-foreground";
  return onClick ? (
    <button type="button" onClick={onClick} className={`${cls} hover:bg-muted hover:text-foreground`} title={`Open ${name}`}>
      {body}
    </button>
  ) : (
    <span className={cls} title={name}>{body}</span>
  );
}

function ImageThumb({ file, workflow, runId }: { file: TurnAttachment; workflow: string; runId: string }) {
  const read = useTurnFile(workflow, runId, file.path);
  const [open, setOpen] = useState(false);
  const data = read.data;
  if (!data?.base64 || data.truncated) return <Chip name={file.name} />;
  const src = `data:${file.mediaType || data.mediaType};base64,${data.base64}`;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title={file.name} className="overflow-hidden rounded-lg border bg-muted/40" data-testid="attachment-image">
        <img src={src} alt={file.name} className="h-20 max-w-40 object-cover" />
      </button>
      {open && (
        <Overlay title={file.name} onClose={() => setOpen(false)}>
          <img src={src} alt={file.name} className="max-h-[85vh] max-w-full rounded-md object-contain" />
        </Overlay>
      )}
    </>
  );
}

function TextChip({ file, workflow, runId }: { file: TurnAttachment; workflow: string; runId: string }) {
  const [open, setOpen] = useState(false);
  const read = useTurnFile(workflow, runId, file.path, open);
  return (
    <>
      <Chip name={file.name} onClick={() => setOpen(true)} />
      {open && (
        <Overlay title={file.name} onClose={() => setOpen(false)} panel>
          {read.isPending ? (
            <p className="text-sm text-muted-foreground">Reading…</p>
          ) : read.data?.text !== undefined ? (
            /\.(md|markdown)$/i.test(file.name) ? (
              <Markdown text={read.data.text} />
            ) : (
              <pre className="whitespace-pre-wrap break-words font-mono text-xs">{read.data.text}</pre>
            )
          ) : (
            <p className="text-sm text-muted-foreground">This file can't be read here.</p>
          )}
          {read.data?.truncated && <p className="mt-2 text-xs text-muted-foreground">Only the start of it is shown.</p>}
        </Overlay>
      )}
    </>
  );
}

/** Over the whole page: Esc, the ✕ or a click outside closes it. `panel`: a
 *  readable card, for text. */
function Overlay({ title, onClose, panel, children }: { title: string; onClose: () => void; panel?: boolean; children: React.ReactNode }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);
  return (
    <div role="dialog" aria-label={title} className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4" onClick={onClose} data-testid="attachment-overlay">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute right-3 top-3 rounded-md p-1.5 text-white/80 hover:bg-white/10 hover:text-white">
        <X className="size-5" />
      </button>
      <div
        onClick={(e) => e.stopPropagation()}
        className={panel ? "max-h-[85vh] w-full max-w-3xl overflow-auto rounded-lg border bg-background p-4 text-foreground shadow-lg" : "flex max-h-full max-w-full items-center justify-center"}
      >
        {panel && <div className="mb-2 truncate text-sm font-medium">{title}</div>}
        {children}
      </div>
    </div>
  );
}
