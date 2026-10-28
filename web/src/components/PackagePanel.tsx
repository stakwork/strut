import { useEffect, useState } from "preact/hooks";
import * as api from "../api";
import { PackagePage } from "./PackagesDialog";

// ── Package panel ───────────────────────────────────────────────────────────
//
// The canvas area when a PACKAGE is selected in the sidebar (plans/
// packages-ux.md §1): its page — what a release holds, version, channel,
// Publish, the releases — the same PackagePage the Packages dialog opens
// behind a row. Selecting the package is also what makes it the builder's
// working package; this is where you see what you are working in.

export function PackagePanel(props: {
  pkg: string;
  publisher?: string;
  /** Every workflow here, by name. */
  workflows: string[];
  /** A publish or a channel move happened: the shell re-reads versions. */
  onChanged: () => void;
}) {
  const [catalog, setCatalog] = useState<api.Catalog | null | undefined>(undefined);
  const [peers, setPeers] = useState<string[] | null>(null);
  const load = () => api.getCatalog().then(setCatalog, () => setCatalog(null));
  useEffect(() => {
    void load();
    api.listPeers().then((p) => setPeers(p.map((x) => x.id)), () => setPeers([]));
  }, [props.pkg]);
  if (catalog === undefined) return <div class="empty">Loading…</div>;
  return (
    <div class="package-panel">
      <div class="package-panel-body">
        <PackagePage key={props.pkg} pkg={props.pkg} publisher={props.publisher} catalog={catalog} workflows={props.workflows}
          peers={peers} onChanged={() => { void load(); props.onChanged(); }} />
      </div>
    </div>
  );
}
