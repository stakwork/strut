import { useState } from "preact/hooks";
import type { InstallLink } from "../store-links";
import { CloseIcon } from "../icons";
import { EarningsPanel } from "./EarningsPanel";
import { IndexPanel } from "./IndexPanel";
import { PackagesPanel } from "./PackagesPanel";
import { PublicViewPanel } from "./PublicViewPanel";

// ── The Publish dialog (the topbar's Publish): the one door out of this server ──
//
// Public view (the public view), Package and Store (both
// PackagesPanel, split by `part`), Earnings; Index on an index. Packages: COPIES — releases by digest, the catalog other struts
// install from, and what this strut follows and has installed
// (PackagesPanel). Public view: what anyone may read here LIVE, with no
// account (PublicViewPanel). Earnings: what anyone's runs were charged, the
// wallet the sats land in and Withdraw (EarningsPanel, plans/paid-runs.md
// §8). On an INDEX strut a fourth, Index: the listing
// requests waiting for its operator and the rows (IndexPanel,
// plans/index-listing.md §3). A tab mounts the first time it is shown and
// stays mounted, so a Public view draft and a package page you are halfway
// through survive a look at the other tab; Close drops both.

export type PublishTab = "public" | "packages" | "get" | "earnings" | "index";

// Every tab opens with what it is for in plain words: the question it
// answers, the answer, and an example. Tabs are named for what a person does,
// not for strut's terms; `packages` keeps its id (the remembered tab).
const TABS: Array<{ tab: PublishTab; label: string; hint: string; title: string; ask: string; answer: string; example: string }> = [
  {
    tab: "packages", label: "Package", hint: "People install it on their own server", title: "Package your workflows so other strut servers can install their own copy",
    ask: "Want another strut server to have its own copy of your work?",
    answer: "Bundle workflows and apps into a package and publish it. Others install it and run it on their own server, with their own data and keys.",
    example: "Example: a teammate with their own strut installs your “contract review” package.",
  },
  {
    tab: "public", label: "Public view", hint: "People use it on your server", title: "Let anyone use your apps and workflows on this server, with a link",
    ask: "Want anyone with a link to use something you built?",
    answer: "Add an app or a workflow here. People open it in their browser — no account, nothing to install. It runs on this server, so you can make it free or charge per run.",
    example: "Example: share a “translate a document” app with a client and charge $0.10 a run.",
  },
  {
    tab: "get", label: "Store", hint: "Install what others published", title: "Find and install packages other people published",
    ask: "Looking for something someone else already built?",
    answer: "Search the store, install a package, and its workflows and apps appear on this server. Below are the packages you already have.",
    example: "Example: install a legal-research package instead of building one.",
  },
  {
    tab: "earnings", label: "Earnings", hint: "What people paid you", title: "What people paid to run your shared workflows, and your wallet",
    ask: "Charging people to run what you share?",
    answer: "See what people paid, what their runs cost you, and the Lightning wallet the money lands in. Set a wallet before you charge anything.",
    example: "Nothing priced yet? This tab stays empty — sharing for free needs no wallet.",
  },
  {
    tab: "index", label: "Index", hint: "Who this store lists", title: "The publishers this index lists, and the listing requests waiting for you",
    ask: "This server runs a store (an index).",
    answer: "Approve or refuse the publishers asking to be listed, and see who is listed.",
    example: "",
  },
];

/** What the tab is for, on ONE line that scrolls away with the tab: the
 *  question, then the answer cut short. Hover reads the rest; a click (or
 *  Enter) opens it in place. */
function Intro(props: { ask: string; answer: string; example: string }) {
  const [open, setOpen] = useState(false);
  const rest = `${props.answer}${props.example ? ` ${props.example}` : ""}`;
  return (
    <button type="button" class={`publish-intro${open ? " open" : ""}`} aria-expanded={open} title={open ? "Click to fold" : rest} onClick={() => setOpen(!open)}>
      <span class="publish-intro-ask">{props.ask}</span>
      <span class="publish-intro-rest">
        {props.answer}
        {props.example && <span class="publish-intro-example"> {props.example}</span>}
      </span>
    </button>
  );
}

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

  const intro = TABS.find((t) => t.tab === props.tab);

  return (
    <div class="dialog-backdrop" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div class="dialog packages-dialog publish-dialog" role="dialog" aria-label="Publish">
        <div class="publish-head">
          <div class="dialog-title">Publish</div>
          <button type="button" class="publish-close" aria-label="Close" title="Close" onClick={props.onClose}><CloseIcon size={14} /></button>
        </div>
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
              <span class="publish-tab-label">
                {t.label}
                {t.tab === "public" && publicDirty && <span class="publish-dirty-dot" />}
                {t.tab === "index" && !!props.indexWaiting && <span class="publish-dirty-dot" title={`${props.indexWaiting} waiting`} />}
              </span>
              <span class="publish-tab-hint">{t.hint}</span>
            </button>
          ))}
        </div>
        <div class="publish-body">
          {intro && <Intro key={intro.tab} ask={intro.ask} answer={intro.answer} example={intro.example} />}
          {shown.has("packages") && (
            <div role="tabpanel" hidden={props.tab !== "packages"}>
              <PackagesPanel part="share" />
            </div>
          )}
          {shown.has("get") && (
            <div role="tabpanel" hidden={props.tab !== "get"}>
              <PackagesPanel part="get" install={props.install} />
            </div>
          )}
          {shown.has("public") && (
            <div role="tabpanel" hidden={props.tab !== "public"}>
              <PublicViewPanel onDirty={setPublicDirty} />
            </div>
          )}
          {shown.has("earnings") && (
            <div role="tabpanel" hidden={props.tab !== "earnings"}>
              <EarningsPanel />
            </div>
          )}
          {shown.has("index") && props.indexWaiting !== undefined && (
            <div role="tabpanel" hidden={props.tab !== "index"}>
              <IndexPanel onChanged={props.onIndexChanged} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
