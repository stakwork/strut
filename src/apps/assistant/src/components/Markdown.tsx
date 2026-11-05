// A reply's markdown, drawn in the bubble (Hive's `MarkdownRenderer`): no
// box of its own — a deliverable's file is DocumentView's — and every link
// opened through the host (`ui/open-link`): the page has no navigation.
import { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useHost } from "@strut/kit";
import { cn } from "@/lib/utils";

const PROSE =
  "leading-relaxed break-words [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground " +
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:text-[0.9em] [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0 " +
  "[&_h1]:mt-3 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:font-medium " +
  "[&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-0.5 [&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 " +
  "[&_table]:my-2 [&_table]:w-full [&_table]:text-xs [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_hr]:my-3";

export function Markdown({ text, className }: { text: string; className?: string }) {
  const host = useHost();
  const components = useMemo(
    (): Components => ({
      a: ({ node: _n, children, href, ...rest }) => (
        <a
          {...rest}
          href={href}
          rel="noopener noreferrer"
          onClick={(e) => {
            e.preventDefault();
            if (href) void host.openLink(href);
          }}
        >
          {children}
        </a>
      ),
    }),
    [host],
  );
  return (
    <div className={cn(PROSE, "text-sm", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
