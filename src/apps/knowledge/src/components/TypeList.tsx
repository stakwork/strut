// A type's nodes in the sidebar, under its row: a page at a time ("Show
// more" reads the next from the graph), and once there are more than a page,
// a search within the type.
import { useEffect, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useSearch, useTypeNodes } from "../lib/read";
import { typePlural } from "../lib/ontology";
import { NodeRow, type Picked } from "./bits";

export const TYPE_PAGE = 15;

export function TypeList({ type, selected, onSelect }: { type: string; selected: string | null; onSelect: (n: Picked) => void }) {
  const pages = useTypeNodes(type, TYPE_PAGE);
  const [text, setText] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setTerm(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const within = useSearch(term, { type, limit: 30 });
  if (pages.isPending) return <p className="px-4 py-1 text-xs text-muted-foreground">Reading…</p>;
  if (pages.isError) return <p className="px-4 py-1 text-xs text-muted-foreground">Couldn't read these.</p>;
  const total = pages.data.pages[0]?.total ?? 0;
  const listed = pages.data.pages.flatMap((p) => p.nodes);
  const finding = term.length > 1;
  const rows = finding ? (within.data ?? []) : listed;
  const name = typePlural(type).toLowerCase();
  return (
    <div className="pb-1 pl-6 pr-2" data-testid="type-list">
      {total > TYPE_PAGE && (
        <div className="relative my-1">
          <Search className="absolute left-2 top-2 size-3.5 text-muted-foreground" />
          <Input className="h-8 pl-7 text-xs" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Find in ${total.toLocaleString()} ${name}…`} aria-label={`Search within ${name}`} />
          {within.isFetching && <Loader2 className="absolute right-2 top-2 size-3.5 animate-spin text-muted-foreground" />}
        </div>
      )}
      {finding && within.data && !within.data.length && <p className="px-2 py-1 text-xs text-muted-foreground">Nothing in {name} matches “{term}”.</p>}
      {rows.map((n) => (
        <NodeRow key={n.ref_id} node={n} selected={n.ref_id === selected} onSelect={onSelect} showType={false} />
      ))}
      {!finding && pages.hasNextPage && (
        <button
          type="button"
          onClick={() => void pages.fetchNextPage()}
          disabled={pages.isFetchingNextPage}
          className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
        >
          {pages.isFetchingNextPage && <Loader2 className="size-3 animate-spin" />}
          Show more
          <span className="tabular-nums">
            · {listed.length} of {total.toLocaleString()}
          </span>
        </button>
      )}
    </div>
  );
}
