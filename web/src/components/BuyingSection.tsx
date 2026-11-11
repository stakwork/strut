import { useEffect, useState } from "preact/hooks";
import * as api from "../api";
import { errorMessage } from "../helpers";
import { fmtUsd } from "../earnings";
import { fmtTime } from "./JobTimeline";
import { ConfirmButton } from "./ConfirmButton";

// ── Buying: credit this server holds at other servers (plans/paid-runs.md §10) ──
//
// What this server bought at other struts' public doors, read from
// `GET /remote/credit?balance=1` (each seller asked for its balance): the
// credit held there and what is left, a purchase still being paid, and the
// remote runs a step is waiting on. Buying itself is a proposal an admin
// accepts (`remote/buy-credit`), never a button here. A purchase a seller
// will never answer for (a rotated key, a seller gone) can be dropped, so
// the next one can go.

export function BuyingSection(props: { reload: number }) {
  const [sellers, setSellers] = useState<api.HeldAtSeller[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mine, setMine] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    api.remoteCredit(true).then(
      (r) => alive && setSellers(r.sellers),
      (e) => alive && setError(errorMessage(e)),
    );
    return () => {
      alive = false;
    };
  }, [props.reload, mine]);

  return (
    <div class="flyout-section">
      <div class="flyout-section-title">Buying</div>
      {error && <div class="auto-error">{error}</div>}
      {!sellers && !error && <div class="auto-hint">Asking each server…</div>}
      {sellers && sellers.length === 0 && (
        <div class="auto-hint">
          This server holds no credit at other servers. A free workflow on another server needs none. For a priced one, an agent asks to
          buy credit with <code>remote/buy-credit</code>, an admin accepts it, and it is paid from this wallet: add sats first.
        </div>
      )}
      {sellers && sellers.length > 0 && (
        <table class="earnings-table buying-table">
          <thead>
            <tr><th>Server</th><th>Credit left</th><th>Bought</th><th>Ends</th></tr>
          </thead>
          <tbody>
            {sellers.map((s) => (
              <SellerRow key={s.seller} s={s} onChanged={() => setMine((n) => n + 1)} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** A day with its year: credit lasts a year, so "Nov 8" alone misleads. */
function fmtDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

function hostOf(seller: string): string {
  try {
    const u = new URL(seller);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return seller;
  }
}

function SellerRow(props: { s: api.HeldAtSeller; onChanged: () => void }) {
  const { s } = props;
  const b = s.balance;
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const left =
    b?.error
      ? <span class="auto-hint earnings-blocked" title={b.error}>could not ask: {b.error}</span>
      : b?.expired
        ? "ended"
        : b?.replaced
          ? "moved to a newer token"
          : b?.remaining_usd !== undefined
            ? <>{fmtUsd(b.remaining_usd)}{b.held_usd ? <span class="auto-hint"> · {fmtUsd(b.held_usd)} held</span> : null}</>
            : s.credit
              ? "—"
              : "none";
  const drop = async () => {
    setBusy(true);
    setSaid(null);
    try {
      await api.dropRemotePurchase(s.seller);
      props.onChanged();
    } catch (err) {
      setSaid(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <tr>
        <td class="earnings-item" title={s.seller}>{hostOf(s.seller)}</td>
        <td class="buying-left">
          {left}
          {s.runs > 0 && <div class="auto-hint">{s.runs} run{s.runs === 1 ? "" : "s"} there now</div>}
        </td>
        <td>{s.credit ? <>{fmtUsd(s.credit.usd)}<div class="auto-hint">{fmtDay(s.credit.boughtAt)}</div></> : ""}</td>
        <td>{s.credit ? fmtDay(s.credit.expires) : ""}</td>
      </tr>
      {s.purchase && (
        <tr class="buying-purchase">
          <td colSpan={4}>
            <div class="buying-purchase-row">
              <span>Buying {fmtUsd(s.purchase.usd)} ({s.purchase.sats.toLocaleString("en-US")} sats)</span>
              <span class="auto-hint">
                {s.purchase.sent ? "paid, waiting for the server to hand over the credit" : "asked, not paid yet"} · since {fmtTime(new Date(s.purchase.at).toISOString())}
              </span>
              <ConfirmButton class="btn btn-sm" label="Drop" disabled={busy}
                note={`Forget this purchase from ${hostOf(s.seller)}? Do it only if that server will never hand over the credit (its key changed, or it is gone). Any sats already paid stay paid; the next purchase there can go.`}
                confirmLabel="Drop" onConfirm={() => void drop()} />
            </div>
            {s.purchase.lastError && <div class="auto-hint">Last read: {s.purchase.lastError}</div>}
            {said && <div class="auto-error">{said}</div>}
          </td>
        </tr>
      )}
    </>
  );
}
