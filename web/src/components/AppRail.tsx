import { useState } from "preact/hooks";
import type { AppListEntry } from "../api";
import { appKey } from "../app-links";

/** Two letters for an app's tile: the first two words' initials, or the
 *  first two letters of a one-word title. */
export function appInitials(title: string): string {
  const words = title.split(/[\s\-_/]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 1).toUpperCase() + words[0]!.slice(1, 2).toLowerCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** A hue per app, from its key, so tiles with the same letters still differ. */
function hueOf(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** The collapsed sidebar: one tile per app, pinned ones first, its name on
 *  hover. The tooltip is fixed to the window, since the rail clips. */
export function AppRail(props: { apps: AppListEntry[]; selected: string | null; onSelect: (key: string) => void }) {
  const [tip, setTip] = useState<{ text: string; top: number } | null>(null);
  const ordered = [...props.apps.filter((a) => a.pinned), ...props.apps.filter((a) => !a.pinned)];
  const show = (e: Event, a: AppListEntry) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setTip({ text: a.peer ? `${a.title} @${a.peer}` : a.title, top: r.top + r.height / 2 });
  };
  return (
    <div class="app-rail" onScroll={() => setTip(null)}>
      {ordered.length === 0 && <div class="app-rail-empty">No apps</div>}
      {ordered.map((a) => {
        const key = appKey(a);
        return (
          <button
            key={key}
            class={`app-rail-tile${props.selected === key ? " is-active" : ""}`}
            style={{ "--hue": hueOf(key) }}
            aria-label={a.title}
            onMouseEnter={(e) => show(e, a)}
            onMouseLeave={() => setTip(null)}
            onFocus={(e) => show(e, a)}
            onBlur={() => setTip(null)}
            onClick={() => props.onSelect(key)}
          >
            {appInitials(a.title)}
            {!!a.warnings && <span class="usage-dot" />}
          </button>
        );
      })}
      {tip && <div class="app-rail-tip" role="tooltip" style={{ top: `${tip.top}px` }}>{tip.text}</div>}
    </div>
  );
}
