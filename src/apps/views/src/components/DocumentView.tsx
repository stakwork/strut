import { Children, createElement, Fragment, useEffect, useMemo, useRef, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertCircle } from "lucide-react";
import {
  artifactKind, findHighlightRanges, flattenText, highlightPieces, sanitizeHtml, useHost, VOID_TAGS,
  type SafeNode, type TextRange,
} from "@strut/kit";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { errorText } from "../lib/format";
import { relPath, useRunFile, type RunFile } from "../lib/run-file";

export type DocumentKind = "html" | "markdown" | "text";

export interface DocumentViewProps {
  /** Read a run's file (`run/files`) — the importing app's grant. */
  workflow?: string;
  runId?: string;
  path?: string;
  /** Or draw this file, as `run/files` returns it… */
  file?: RunFile;
  /** …or this text. */
  text?: string;
  /** How to read it; by default the path's extension, else the file's media type. */
  kind?: DocumentKind;
  /** Words or passages to highlight, any case; the view scrolls to the first. */
  terms?: string[];
  className?: string;
}

const MARK = "rounded-sm bg-amber-200 px-0.5 text-amber-950 dark:bg-amber-500/40 dark:text-amber-50";

/** The typography a document is drawn in: markdown's and an HTML page's alike. */
export const PROSE =
  "leading-relaxed break-words [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 " +
  "[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:font-semibold [&_h4]:font-semibold " +
  "[&_hr]:my-4 [&_li]:ml-5 [&_ol]:list-decimal [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_ul]:list-disc " +
  "[&_table]:my-2 [&_table]:block [&_table]:overflow-x-auto [&_table]:text-xs [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:bg-muted/50 [&_th]:px-2 [&_th]:py-1 [&_img]:max-w-full";

function kindOf(kind: DocumentKind | undefined, path: string | undefined, file: RunFile | undefined): DocumentKind {
  if (kind) return kind;
  const byPath = path ? artifactKind(path) : null;
  if (byPath === "html" || byPath === "markdown") return byPath;
  if (file?.mediaType === "text/html") return "html";
  if (file?.mediaType === "text/markdown") return "markdown";
  return "text";
}

/** A text cut where the terms fall. */
function marked(text: string, ranges: readonly TextRange[], offset = 0): ReactNode {
  if (!ranges.length) return text;
  return highlightPieces(text, ranges, offset).map((p, i) => (typeof p === "string" ? <Fragment key={i}>{p}</Fragment> : <mark key={i} className={MARK}>{p.mark}</mark>));
}

/**
 * A document a run produced — an HTML page, markdown, plain text — drawn in
 * the page, with the terms given highlighted and the first scrolled to. An
 * HTML page is drawn from its safe elements (`sanitizeHtml`: the browser
 * parses it, nothing of it runs, only text and plain elements survive, a
 * link opens through the host), never as HTML.
 */
export function DocumentView({ workflow, runId, path, file: givenFile, text: givenText, kind, terms, className }: DocumentViewProps) {
  const read = givenText === undefined && !givenFile && !!workflow && !!runId && !!path;
  const q = useRunFile(read ? workflow! : "", read ? runId! : "", read ? relPath(path!) : "", givenFile);
  const file = givenFile ?? q.data ?? undefined;
  const text = givenText ?? file?.text;
  const k = kindOf(kind, path ?? file?.path, file);
  const box = useRef<HTMLDivElement>(null);
  const termKey = (terms ?? []).join("\u0000");

  const html = useMemo(() => (k === "html" && text !== undefined ? sanitizeHtml(text) : null), [k, text]);
  const found = useMemo(() => {
    if (!terms?.length || text === undefined) return null;
    return findHighlightRanges(html ? flattenText(html) : text, terms).length;
  }, [html, text, termKey]);

  useEffect(() => {
    const first = box.current?.querySelector("mark");
    if (first) first.scrollIntoView({ block: "center" });
  }, [text, termKey]);

  if (read && q.isError) return <p className={cn("text-sm text-destructive", className)}>{errorText(q.error)}</p>;
  if (read && q.isPending) return <Skeleton className={cn("h-48 w-full", className)} />;
  if (text === undefined) return <p className={cn("text-sm text-muted-foreground", className)}>{file ? `${relPath(file.path)} is not a text document (${file.mediaType}).` : `No file ${path ? relPath(path) : ""} in run ${runId ?? ""}.`}</p>;

  return (
    <div className={cn("flex flex-col gap-2 text-sm", className)} data-testid="document-view" data-kind={k}>
      {found !== null && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {found === 0 && <AlertCircle className="size-3.5 shrink-0" />}
          {found === 0 ? "None of the terms is in this document — showing it from the top." : `${found} match${found === 1 ? "" : "es"}`}
        </p>
      )}
      <div ref={box} className="max-h-[70vh] overflow-auto rounded-md border p-3">
        {k === "html" && html ? (
          <SafeHtml nodes={html} terms={terms} />
        ) : k === "markdown" ? (
          <MarkdownDoc text={text} terms={terms} />
        ) : (
          <pre className="font-mono text-xs whitespace-pre-wrap">{marked(text, terms?.length ? findHighlightRanges(text, terms) : [])}</pre>
        )}
      </div>
      {file?.truncated && <p className="text-xs text-muted-foreground">Cut at {Math.round(file.bytes / 1024)} KB — the rest is in strut.</p>}
    </div>
  );
}

export interface SafeHtmlProps {
  /** HTML text… */
  html?: string;
  /** …or the safe tree `sanitizeHtml` made of it. */
  nodes?: SafeNode[];
  terms?: string[];
  className?: string;
}

/**
 * HTML drawn safely: parsed by the browser (which runs nothing), kept to text
 * and plain document elements with a few named attributes (`sanitizeHtml`),
 * and drawn element by element with `createElement` — never as HTML. A link
 * opens through the host; an image is drawn only from an inline `data:` image.
 */
export function SafeHtml({ html, nodes: given, terms, className }: SafeHtmlProps) {
  const host = useHost();
  const nodes = useMemo(() => given ?? sanitizeHtml(html ?? ""), [given, html]);
  const ranges = useMemo(() => (terms?.length ? findHighlightRanges(flattenText(nodes), terms) : []), [nodes, (terms ?? []).join("\u0000")]);
  // Text offsets in the order flattenText numbered them, so a range may span elements.
  const cursor = { at: 0 };
  const draw = (list: readonly SafeNode[], key: string): ReactNode[] =>
    list.map((n, i) => {
      const k = `${key}.${i}`;
      if (typeof n === "string") {
        const at = cursor.at;
        cursor.at += n.length;
        return <Fragment key={k}>{marked(n, ranges, at)}</Fragment>;
      }
      const props: Record<string, unknown> = { key: k, ...(n.a ?? {}) };
      if (n.t === "a" && n.a?.["href"]) {
        const href = n.a["href"];
        props["rel"] = "noopener noreferrer";
        props["onClick"] = (e: { preventDefault: () => void }) => {
          e.preventDefault();
          void host.openLink(href.trim());
        };
      }
      if (VOID_TAGS.has(n.t)) return createElement(n.t, props);
      return createElement(n.t, props, n.c ? draw(n.c, k) : null);
    });
  return <div className={cn(PROSE, className)}>{draw(nodes, "h")}</div>;
}

/** Markdown with the terms marked in each text it holds (a passage across two formats is two marks). */
function MarkdownDoc({ text, terms }: { text: string; terms?: string[] }) {
  const host = useHost();
  const components = useMemo((): Components => {
    const hl = (children: ReactNode) =>
      Children.map(children, (c) => (typeof c === "string" && terms?.length ? marked(c, findHighlightRanges(c, terms)) : c));
    const tags = ["p", "li", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "del", "code", "blockquote"] as const;
    const out: Record<string, unknown> = {};
    for (const tag of tags) {
      out[tag] = ({ node: _n, children, ...rest }: { node?: unknown; children?: ReactNode }) => createElement(tag, rest, hl(children));
    }
    out["a"] = ({ node: _n, children, href, ...rest }: { node?: unknown; children?: ReactNode; href?: string }) =>
      createElement("a", { ...rest, href, rel: "noopener noreferrer", onClick: (e: { preventDefault: () => void }) => { e.preventDefault(); if (href) void host.openLink(href); } }, hl(children));
    return out as Components;
  }, [(terms ?? []).join("\u0000"), host]);
  return (
    <div className={PROSE}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>
    </div>
  );
}
