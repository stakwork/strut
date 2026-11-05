import { useState } from "preact/hooks";
import type { InstallLink } from "../store-links";
import { PackagesPanel } from "./PackagesPanel";
import { PublicViewPanel } from "./PublicViewPanel";

// ── The Publish dialog: the topbar's one door out of this server ───────────
//
// Two tabs. Packages: COPIES — releases by digest, the catalog other struts
// install from, and what this strut follows and has installed
// (PackagesPanel). Public view: what anyone may read here LIVE, with no
// account (PublicViewPanel). A tab mounts the first time it is shown and
// stays mounted, so a Public view draft and a package page you are halfway
// through survive a look at the other tab; Close drops both.

export type PublishTab = "packages" | "public";

const TABS: Array<{ tab: PublishTab; label: string; title: string }> = [
  { tab: "packages", label: "Packages", title: "The packages here, what this strut server follows and what it has installed" },
  { tab: "public", label: "Public view", title: "What anyone can read on this server, live and read-only, with no account" },
];

export function PublishDialog(props: {
  tab: PublishTab;
  onTab: (tab: PublishTab) => void;
  install?: InstallLink | null;
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
          {TABS.map((t) => (
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
        </div>
        <div class="dialog-actions">
          <button class="btn" onClick={props.onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
