import { useEffect, useState } from "preact/hooks";
import * as api from "../api";
import { errorMessage } from "../helpers";
import { RANGES, byEarned, fmtSats, fmtUsd, priceLine, rangeFrom, subjectLabel, withdrawBlocked, type RangeId } from "../earnings";
import { fmtTime } from "./JobTimeline";
import { ConfirmButton } from "./ConfirmButton";
import { WithdrawDialog } from "./WithdrawDialog";

// ── The Publish dialog's Earnings tab (plans/paid-runs.md §8) ──────────────
//
// What this server earned from what anyone may run here, and the wallet it
// lands in. Earned and cost are dollars, so the margin is their difference;
// sats are what the wallet holds. On top: the wallet's balance in sats and
// at the rate of the moment, Withdraw beside it, and the credit still owed
// as service; then earned, cost, margin, received and withdrawn over a
// range, by day and by item; at the bottom the wallet's settings
// (`GET`/`PUT /earnings/wallet`). Every number is the ledger's rollups.

export function EarningsPanel() {
  const [range, setRange] = useState<RangeId>("30d");
  const [view, setView] = useState<api.EarningsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [withdrawing, setWithdrawing] = useState(false);
  const [byDay, setByDay] = useState<api.EarningsRow[]>([]);

  useEffect(() => {
    let alive = true;
    const from = rangeFrom(range);
    setError(null);
    Promise.all([api.getEarnings({ by: "item", wallet: true, ...(from ? { from } : {}) }), api.getEarnings({ by: "day", ...(from ? { from } : {}) })]).then(
      ([v, d]) => {
        if (!alive) return;
        setView(v);
        setByDay(d.rows);
      },
      (e) => alive && setError(errorMessage(e)),
    );
    return () => {
      alive = false;
    };
  }, [range, reload]);

  const wallet = view?.wallet;
  const blocked = withdrawBlocked(wallet);
  const items = view ? byEarned(view.rows) : [];
  const received = new Map(view?.received.days.map((d) => [d.day, d]) ?? []);
  const withdrawn = new Map(view?.withdrawn.days.map((d) => [d.day, d]) ?? []);
  const days = [...new Set([...byDay.map((d) => d.key), ...received.keys(), ...withdrawn.keys()])].sort().reverse();
  const dayRow = new Map(byDay.map((d) => [d.key, d]));

  return (
    <div class="earnings-panel">
      <div class="auto-hint">
        What anyone's runs of the workflows and tools you sell here were charged, what they cost you, and the wallet the sats land in.
        Earned and cost are dollars; the wallet holds sats.
      </div>
      {error && <div class="auto-error">{error}</div>}
      {!view && !error && <div class="auto-hint">Loading…</div>}

      {view && (
        <>
          <div class="earnings-wallet">
            <div class="earnings-wallet-figures">
              <div>
                <div class="ov-tile-label">Wallet</div>
                <div class="earnings-big">{wallet?.balance ? fmtSats(wallet.balance.msat) : "—"}</div>
                <div class="ov-tile-sub">
                  {wallet?.balance?.usd !== undefined && wallet.rate
                    ? `≈ ${fmtUsd(wallet.balance.usd)} at ${fmtUsd(wallet.rate)} per bitcoin`
                    : wallet?.error ?? ""}
                </div>
              </div>
              <div title="Paid for and not yet charged: what buyers are still owed as service. The sats are yours either way.">
                <div class="ov-tile-label">Owed as service</div>
                <div class="earnings-big">{fmtUsd(view.outstanding.usd)}</div>
                <div class="ov-tile-sub">
                  {view.outstanding.tokens} credit token{view.outstanding.tokens === 1 ? "" : "s"}
                  {view.outstanding.held > 0 && ` · ${fmtUsd(view.outstanding.held)} held for runs in flight`}
                </div>
              </div>
              <div class="earnings-withdraw">
                <button class="btn btn-primary" disabled={!!blocked} title={blocked ?? "Pay a Lightning invoice out of this wallet"} onClick={() => setWithdrawing(true)}>
                  Withdraw
                </button>
                {blocked && <div class="ov-tile-sub earnings-blocked">{blocked}</div>}
              </div>
            </div>
            {wallet && (wallet.balance || wallet.expectedMsat !== 0) && (
              <div class="auto-hint earnings-check">
                The books say it should hold {fmtSats(Math.max(0, wallet.expectedMsat))}: everything received, less everything withdrawn and its fees.
                {wallet.differenceMsat !== undefined && wallet.differenceMsat !== 0 && (
                  <> It holds {fmtSats(Math.abs(wallet.differenceMsat))} {wallet.differenceMsat > 0 ? "more — money that came some other way, or a paid invoice whose credit was never used" : "less — money that left some other way"}.</>
                )}
                {wallet.differenceMsat === 0 && " It does."}
              </div>
            )}
            {view.pending.length > 0 && (
              <div class="earnings-pending">
                <div class="ov-tile-label">Withdrawals on their way</div>
                {view.pending.map((p) => (
                  <div key={p.paymentHash} class="earnings-pending-row">
                    <span>{fmtSats(p.msat)}</span>
                    <span class="auto-hint">{p.answered ? "sent, not settled yet: read again every minute" : "the wallet never answered: open Withdraw with the same invoice to read it"}</span>
                    <span class="auto-hint">{fmtTime(new Date(p.at).toISOString())}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div class="earnings-range" role="tablist">
            {RANGES.map((r) => (
              <button key={r.id} role="tab" aria-selected={r.id === range} class={`earnings-range-btn${r.id === range ? " is-active" : ""}`} onClick={() => setRange(r.id)}>
                {r.label}
              </button>
            ))}
          </div>

          <div class="earnings-tiles">
            <Tile label="Earned" value={fmtUsd(view.totals.earned)} sub={`${view.totals.calls} run${view.totals.calls === 1 ? "" : "s"}${view.totals.failed ? ` · ${view.totals.failed} failed` : ""}`} />
            <Tile label="Cost" value={fmtUsd(view.totals.cost)} sub="what they spent on models" />
            <Tile label="Margin" value={fmtUsd(view.totals.margin)} sub="earned − cost" tone={view.totals.margin < 0 ? "loss" : undefined} />
            <Tile label="Received" value={fmtSats(view.received.msat)} sub={`${view.received.count} payment${view.received.count === 1 ? "" : "s"} · ${fmtUsd(view.received.usd)} of credit`} />
            <Tile label="Withdrawn" value={fmtSats(view.withdrawn.msat)} sub={`${view.withdrawn.count} · fees ${fmtSats(view.withdrawn.feeMsat)}`} />
          </div>

          <div class="flyout-section">
            <div class="flyout-section-title">By item</div>
            {items.length === 0 ? (
              <div class="auto-hint">Nothing anyone may run here yet: open it under Public view with "anyone can run it".</div>
            ) : (
              <table class="earnings-table">
                <thead>
                  <tr><th>Item</th><th>Price</th><th>Runs</th><th>Failed</th><th>Earned</th><th>Cost</th><th>Margin</th></tr>
                </thead>
                <tbody>
                  {items.map((r) => {
                    const s = subjectLabel(r.key);
                    return (
                      <tr key={r.key}>
                        <td class="earnings-item"><span class="badge">{s.kind}</span> {s.name}</td>
                        <td>{r.price ? priceLine(r.price) : s.kind === "expired" ? "" : "not sold now"}</td>
                        <td>{r.calls}</td>
                        <td class={r.failed ? "is-failed" : ""}>{r.failed}</td>
                        <td>{fmtUsd(r.earned)}</td>
                        <td>{fmtUsd(r.cost)}</td>
                        <td class={r.margin < 0 ? "is-loss" : ""}>{fmtUsd(r.margin)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div class="flyout-section">
            <div class="flyout-section-title">By day</div>
            {days.length === 0 ? (
              <div class="auto-hint">Nothing in this range.</div>
            ) : (
              <table class="earnings-table">
                <thead>
                  <tr><th>Day (UTC)</th><th>Runs</th><th>Earned</th><th>Cost</th><th>Margin</th><th>Received</th><th>Withdrawn</th></tr>
                </thead>
                <tbody>
                  {days.map((day) => {
                    const d = dayRow.get(day);
                    const rin = received.get(day);
                    const out = withdrawn.get(day);
                    return (
                      <tr key={day}>
                        <td>{day}</td>
                        <td>{d?.calls ?? 0}</td>
                        <td>{fmtUsd(d?.earned ?? 0)}</td>
                        <td>{fmtUsd(d?.cost ?? 0)}</td>
                        <td class={(d?.margin ?? 0) < 0 ? "is-loss" : ""}>{fmtUsd(d?.margin ?? 0)}</td>
                        <td>{rin ? fmtSats(rin.msat) : ""}</td>
                        <td>{out ? fmtSats(out.msat) : ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <WalletForm onSaved={() => setReload((n) => n + 1)} />
        </>
      )}

      {withdrawing && wallet && view && (
        <WithdrawDialog
          wallet={wallet}
          outstanding={view.outstanding}
          onClose={() => {
            setWithdrawing(false);
            setReload((n) => n + 1);
          }}
          onPaid={() => setReload((n) => n + 1)}
        />
      )}
    </div>
  );
}

function Tile(props: { label: string; value: string; sub: string; tone?: "loss" }) {
  return (
    <div class="ov-tile">
      <div class="ov-tile-label">{props.label}</div>
      <div class={`ov-tile-value${props.tone === "loss" ? " is-loss" : ""}`}>{props.value}</div>
      <div class="ov-tile-sub" title={props.sub}>{props.sub}</div>
    </div>
  );
}

/** The wallet's settings (`GET`/`PUT /earnings/wallet`, plans/paid-runs.md
 *  §9): which provider, its receive credential, and the pay credential
 *  Withdraw needs. Credentials go in and never come back out. */
function WalletForm(props: { onSaved: () => void }) {
  const [info, setInfo] = useState<api.WalletInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [provider, setProvider] = useState<"sphinx" | "nwc">("sphinx");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [host, setHost] = useState(false);

  const load = () =>
    api.getWallet(true).then(
      (w) => {
        setInfo(w);
        if (w.provider) setProvider(w.provider);
      },
      (e) => {
        const m = errorMessage(e);
        if (/host provides the wallet/.test(m)) setHost(true);
        else setError(m);
      },
    );
  useEffect(() => void load(), []);

  const save = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      setInfo(await api.putWallet(body));
      setEditing(false);
      setFields({});
      props.onSaved();
      void load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const field = (k: string, label: string, placeholder: string, secret = true) => (
    <label class="earnings-wallet-field">
      <span>{label}</span>
      <input
        type={secret ? "password" : "text"}
        autocomplete="off"
        placeholder={placeholder}
        value={fields[k] ?? ""}
        onInput={(e) => setFields({ ...fields, [k]: (e.target as HTMLInputElement).value })}
      />
    </label>
  );
  const sameProvider = info?.provider === provider;
  const body = () => {
    const b: Record<string, unknown> = { provider };
    for (const [k, v] of Object.entries(fields)) if (v.trim()) b[k] = v.trim();
    return b;
  };

  if (host) {
    return (
      <div class="flyout-section">
        <div class="flyout-section-title">Wallet</div>
        <div class="auto-hint">This server's host provides the wallet: strut neither holds nor changes it.</div>
      </div>
    );
  }
  return (
    <div class="flyout-section">
      <div class="flyout-section-title">Wallet</div>
      {error && <div class="auto-error">{error}</div>}
      {info && (
        <div class="earnings-wallet-info">
          {info.provider === null ? (
            <span class="auto-hint">No wallet is set: nothing can be sold for sats until one is.</span>
          ) : (
            <>
              <span>{info.provider === "sphinx" ? "Sphinx daemon" : "NWC wallet"}</span>
              <span class="auto-hint">{info.url ?? info.relays?.join(", ")}</span>
              <span class={`badge ${info.receive ? "badge-ok" : ""}`}>{info.receive ? "receives" : "cannot receive"}</span>
              <span class={`badge ${info.pay ? "badge-ok" : "badge-warning"}`}>{info.pay ? "can pay" : "cannot pay"}</span>
              {info.check && (info.check.ok ? <span class="auto-hint">answers: {fmtSats(info.check.msat)}</span> : <span class="auto-hint earnings-blocked">{info.check.error}</span>)}
            </>
          )}
          {info.note && <div class="auto-hint">{info.note}</div>}
        </div>
      )}
      {!editing && (
        <div class="earnings-wallet-actions">
          <button class="btn btn-sm" onClick={() => setEditing(true)}>{info?.provider ? "Change" : "Set a wallet"}</button>
          {info?.provider && !info.pay && <button class="btn btn-sm" onClick={() => setEditing(true)}>Add a pay credential</button>}
          {info?.provider && (
            <ConfirmButton class="btn btn-sm" label="Remove" disabled={busy}
              note="Remove the wallet? Nothing more can be sold for sats until one is set, and Withdraw stops."
              confirmLabel="Remove" onConfirm={() => void save({ provider: null })} />
          )}
        </div>
      )}
      {editing && (
        <div class="earnings-wallet-edit">
          <label class="earnings-wallet-field">
            <span>Provider</span>
            <select value={provider} onChange={(e) => { setProvider((e.target as HTMLSelectElement).value as "sphinx" | "nwc"); setFields({}); }}>
              <option value="sphinx">Sphinx daemon (the treasury)</option>
              <option value="nwc">NWC (Alby Hub, LNbits, …)</option>
            </select>
          </label>
          {provider === "sphinx" ? (
            <>
              {field("url", "Daemon URL", sameProvider ? "keep as it is" : "http://treasury:8090", false)}
              {field("token", "Receive token", sameProvider ? "keep as it is" : "the daemon's receive token")}
              {field("payToken", "Pay token", info?.pay && sameProvider ? "keep as it is" : "the daemon's pay token — Withdraw needs it")}
            </>
          ) : (
            <>
              {field("url", "Receive connection", sameProvider ? "keep as it is" : "nostr+walletconnect://…")}
              {field("payUrl", "Pay connection", info?.pay && sameProvider ? "keep as it is" : "a connection that may pay — Withdraw needs it")}
            </>
          )}
          <div class="auto-hint">Kept encrypted in payments.json, a file no step reads. Never shown again.</div>
          <div class="earnings-wallet-actions">
            <button class="btn btn-sm" disabled={busy} onClick={() => { setEditing(false); setFields({}); }}>Cancel</button>
            <button class="btn btn-sm btn-primary" disabled={busy} onClick={() => void save(body())}>Save</button>
          </div>
        </div>
      )}
    </div>
  );
}
