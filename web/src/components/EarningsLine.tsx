import { useEffect, useState } from "preact/hooks";
import * as api from "../api";
import { fmtUsd, priceLine } from "../earnings";

// ── One item's earnings, in a line (plans/paid-runs.md §8) ─────────────────
//
// What a workflow or tool sold anyone has earned here: its price, calls,
// failed, earned, cost and margin. The Public view's runnable row, the
// Workflow flyout and a package's page (summed over its prefix) all draw it.
// Earnings are full scope: a credential that may not read them sees nothing.

/** `GET /earnings` for `q`, read again when `key` changes; null while it
 *  loads or when this credential may not read earnings. */
export function useEarnings(q: Parameters<typeof api.getEarnings>[0], key: unknown = ""): api.EarningsView | null {
  const [view, setView] = useState<api.EarningsView | null>(null);
  const json = JSON.stringify(q);
  useEffect(() => {
    let alive = true;
    api.getEarnings(q).then((v) => alive && setView(v), () => alive && setView(null));
    return () => {
      alive = false;
    };
  }, [json, key]);
  return view;
}

export function EarningsLine(props: {
  row: Pick<api.EarningsRow, "calls" | "failed" | "earned" | "cost" | "margin"> | undefined;
  price?: { base?: number; markup?: number };
  /** What the numbers cover, said first: "Here, all time". */
  label?: string;
}) {
  const r = props.row ?? { calls: 0, failed: 0, earned: 0, cost: 0, margin: 0 };
  return (
    <div class="earnings-line" title="From the ledger: what anyone's runs were charged here, what they cost, and the difference">
      {props.label && <span class="earnings-line-label">{props.label}</span>}
      {props.price && <span class="earnings-line-item"><span>price</span> <b>{priceLine(props.price)}</b></span>}
      <span class="earnings-line-item"><b>{r.calls}</b> run{r.calls === 1 ? "" : "s"}</span>
      {r.failed > 0 && <span class="earnings-line-item is-failed"><b>{r.failed}</b> failed</span>}
      <span class="earnings-line-item"><span>earned</span> <b>{fmtUsd(r.earned)}</b></span>
      <span class="earnings-line-item"><span>cost</span> <b>{fmtUsd(r.cost)}</b></span>
      <span class={`earnings-line-item${r.margin < 0 ? " is-loss" : ""}`}><span>margin</span> <b>{fmtUsd(r.margin)}</b></span>
    </div>
  );
}
