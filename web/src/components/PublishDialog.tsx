import { useState } from "preact/hooks";
import type { InstallLink } from "../store-links";
import { IndexPanel } from "./IndexPanel";
import { PackagesPanel } from "./PackagesPanel";
import { PublicViewPanel } from "./PublicViewPanel";

// ── The Publish dialog: the topbar's one door out of this server ───────────
//
// Two tabs, three on an index. Packages: COPIES — releases by digest, the catalog other struts
// install from, and what this strut follows and has installed
// (PackagesPanel). Public view: what anyone may read here LIVE, with no
// account (PublicViewPanel). On an INDEX strut a third, Index: the listing
// requests waiting for its operator and the rows (IndexPanel,
// plans/index-listing.md §3). A tab mounts the first time it is shown and
// stays mounted, so a Public view draft and a package page you are halfway
// through survive a look at the other tab; Close drops both.

export type PublishTab = "packages" | "public" | "index";

const TABS: Array<{ tab: PublishTab; label: string; title: string }> = [
  { tab: "packages", label: "Packages", title: "The packages here, what this strut server follows and what it has installed" },
  { tab: "public", label: "Public view", title: "What anyone can read on this server, live and read-only, with no account" },
  { tab: "index", label: "Index", title: "The publishers this index lists, and the listing requests waiting for you" },
];

export function PublishDialog(props: {
  tab: PublishTab;
  onTab: (tab: PublishTab) => void;
  install?: InstallLink | null;
  /** Listing requests waiting for this index's operator; undefined when this strut is no index. */
  indexWaiting?: number;
  onIndexChanged?: (waiting: number) => void;
  onClose: () => void;
}) {
  const [shown, setShown] = useState<Set<PublishTab>>(() => new Set([props.tab]));
  const [publicDirty, setPublicDirty] = useState(false);
  const pick = (tab: PublishTab) => {
    if (!shown.has(tab)) setShown(new Set([...shown, tab]));
    props.onTab(tab);
  };

  return (
    <div class="dialog-backdrop" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div class="dialog packages-dialog publish-dialog" role="dialog" aria-label="Publish">
        <div class="dialog-title">Publish</div>
        <div class="flyout-tabs publish-tabs" role="tablist">
          {TABS.filter((t) => t.tab !== "index" || props.indexWaiting !== undefined).map((t) => (
            <button
              key={t.tab}
              role="tab"
              aria-selected={t.tab === props.tab}
              class={`flyout-tab${t.tab === props.tab ? " is-active" : ""}`}
              title={t.tab === "public" && publicDirty ? "Unsaved changes" : t.title}
              onClick={() => pick(t.tab)}
            >
              {t.label}
              {t.tab === "public" && publicDirty && <span class="publish-dirty-dot" />}
              {t.tab === "index" && !!props.indexWaiting && <span class="publish-dirty-dot" title={`${props.indexWaiting} waiting`} />}
            </button>
          ))}
        </div>
        <div class="publish-body">
          {shown.has("packages") && (
            <div role="tabpanel" hidden={props.tab !== "packages"}>
              <PackagesPanel install={props.install} />
            </div>
          )}
          {shown.has("public") && (
            <div role="tabpanel" hidden={props.tab !== "public"}>
              <PublicViewPanel onDirty={setPublicDirty} />
            </div>
          )}
          {shown.has("index") && props.indexWaiting !== undefined && (
            <div role="tabpanel" hidden={props.tab !== "index"}>
              <IndexPanel onChanged={props.onIndexChanged} />
            </div>
          )}
        </div>
        <div class="dialog-actions">
          <button class="btn" onClick={props.onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
