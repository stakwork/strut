import { useEffect, useState } from "preact/hooks";
import * as api from "../api";
import { errorMessage } from "../helpers";
import {
  RANGES,
  byEarned,
  coverLine,
  fmtSats,
  fmtUsd,
  priceLine,
  rangeFrom,
  sendPurposeNote,
  showsWorkers,
  subjectLabel,
  withdrawBlocked,
  withdrawRefusal,
  workersAcceptedLine,
  workersDayMsat,
  workersOutLine,
  workersOwedSub,
  workersPaidSub,
  type RangeId,
} from "../earnings";
import { fmtTime } from "./JobTimeline";
import { ConfirmButton } from "./ConfirmButton";
import { WithdrawDialog } from "./WithdrawDialog";
import { DepositDialog } from "./DepositDialog";
import { BuyingSection } from "./BuyingSection";

// ── The Publish dialog's Earnings tab (plans/paid-runs.md §8) ──────────────
//
// What this server earned from what anyone may run here, and the wallet it
// lands in. Earned and cost are dollars, so the margin is their difference;
// sats are what the wallet holds. On top: the wallet's balance in sats and
// at the rate of the moment, Add sats and Withdraw beside it, the credit
// still owed as service and, once any worker was paid, what workers are owed
// for accepted answers (plans/human-steps.md §8.1) with whether the balance
// covers it; then earned, cost, margin, received and withdrawn
// over a range, by day and by item; the credit this server BUYS with at
// other servers; at the bottom the wallet's settings (`GET`/`PUT
// /earnings/wallet`). Every number is the ledger's rollups.

export function EarningsPanel() {
  const [range, setRange] = useState<RangeId>("30d");
  const [view, setView] = useState<api.EarningsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [withdrawing, setWithdrawing] = useState(false);
  const [adding, setAdding] = useState(false);
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
  const deposited = new Map(view?.deposited.days.map((d) => [d.day, d]) ?? []);
  // What workers are owed: shown once any worker was paid, so a strut that
  // never paid one reads as it did.
  const workers = showsWorkers(view?.workers) ? view!.workers : undefined;
  const workerDays = new Map(workers?.accepted.days.map((d) => [d.day, d]) ?? []);
  const days = [...new Set([...byDay.map((d) => d.key), ...received.keys(), ...withdrawn.keys(), ...deposited.keys(), ...workerDays.keys()])].sort().reverse();
  const addBlocked = !wallet?.receive ? "Set a wallet first: under Wallet, below" : null;
  const dayRow = new Map(byDay.map((d) => [d.key, d]));
  const cover = coverLine(wallet);

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
            <div class={`earnings-wallet-figures${workers ? " has-workers" : ""}`}>
              <div>
                <div class="ov-tile-label">Wallet</div>
                <div class="earnings-big">{wallet?.balance ? fmtSats(wallet.balance.msat) : "—"}</div>
                <div class="ov-tile-sub">
                  {wallet?.balance?.usd !== undefined && wallet.rate
                    ? `≈ ${fmtUsd(wallet.balance.usd)} at ${fmtUsd(wallet.rate)} per bitcoin`
                    : wallet?.error ?? ""}
                </div>
                {cover && <div class={`ov-tile-sub earnings-cover${cover.short ? " is-short" : ""}`}>{cover.text}</div>}
              </div>
              <div title="Paid for and not yet charged: what buyers are still owed as service. The sats are yours either way.">
                <div class="ov-tile-label">Owed as service</div>
                <div class="earnings-big">{fmtUsd(view.outstanding.usd)}</div>
                <div class="ov-tile-sub">
                  {view.outstanding.tokens} credit token{view.outstanding.tokens === 1 ? "" : "s"}
                  {view.outstanding.held > 0 && ` · ${fmtUsd(view.outstanding.held)} held for runs in flight`}
                </div>
              </div>
              {workers && (
                <div title="Earned by workers for accepted answers, less what was taken back: sats this wallet must hold for them. Held earnings wait out their task type's hold before they can be withdrawn.">
                  <div class="ov-tile-label">Owed to workers</div>
                  <div class="earnings-big">{fmtSats(workers.owedMsat)}</div>
                  <div class="ov-tile-sub earnings-wrap">{workersOwedSub(workers, wallet?.rate)}</div>
                </div>
              )}
              <div class="earnings-withdraw">
                <div class="earnings-wallet-buttons">
                  <button class="btn" disabled={!!addBlocked} title={addBlocked ?? "An invoice into this wallet, to pay from your own"} onClick={() => setAdding(true)}>
                    Add sats
                  </button>
                  <button class="btn btn-primary" disabled={!!blocked} title={blocked ?? "Pay a Lightning invoice out of this wallet"} onClick={() => setWithdrawing(true)}>
                    Withdraw
                  </button>
                </div>
                {blocked && <div class="ov-tile-sub earnings-blocked">{blocked}</div>}
              </div>
            </div>
            {wallet && (wallet.balance || wallet.expectedMsat !== 0) && (
              <div class="auto-hint earnings-check">
                The books say it should hold {fmtSats(Math.max(0, wallet.expectedMsat))}: everything received and added, less everything sent and its fees
                {wallet.pendingMsat > 0 ? `, and less the ${fmtSats(wallet.pendingMsat)} still on its way` : ""}.
                {wallet.differenceMsat !== undefined && wallet.differenceMsat !== 0 && (
                  <> It holds {fmtSats(Math.abs(wallet.differenceMsat))} {wallet.differenceMsat > 0 ? "more — money that came some other way, or a paid invoice whose credit was never used" : "less — money that left some other way"}.</>
                )}
                {wallet.differenceMsat === 0 && " It does."}
              </div>
            )}
            {view.pending.length > 0 && (
              <div class="earnings-pending">
                <div class="ov-tile-label">On their way</div>
                {view.pending.map((p) => (
                  <PendingRow key={p.paymentHash} p={p} onChanged={() => setReload((n) => n + 1)} />
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

          <div class={`earnings-tiles${workers ? " has-workers" : ""}`}>
            <Tile label="Earned" value={fmtUsd(view.totals.earned)} sub={`${view.totals.calls} run${view.totals.calls === 1 ? "" : "s"}${view.totals.failed ? ` · ${view.totals.failed} failed` : ""}`} />
            <Tile label="Cost" value={fmtUsd(view.totals.cost)} sub="what they spent on models" />
            <Tile label="Margin" value={fmtUsd(view.totals.margin)} sub="earned − cost" tone={view.totals.margin < 0 ? "loss" : undefined} />
            <Tile label="Received" value={fmtSats(view.received.msat)} sub={`${view.received.count} payment${view.received.count === 1 ? "" : "s"} · ${fmtUsd(view.received.usd)} of credit`} />
            <Tile label="Withdrawn" value={fmtSats(view.withdrawn.msat)} sub={`${view.withdrawn.count} · fees ${fmtSats(view.withdrawn.feeMsat)}`} />
            {workers && <Tile label="Paid to workers" value={fmtSats(workers.paidOut?.msat ?? 0)} sub={workersPaidSub(workers)} />}
          </div>
          {view.deposited.count > 0 && (
            <div class="auto-hint">Also added by hand: {fmtSats(view.deposited.msat)} ({view.deposited.count}). Not credit and not earnings: sats this server may spend.</div>
          )}
          {view.purchases.count > 0 && (
            <div class="auto-hint">Also paid out: {fmtSats(view.purchases.msat)} for credit bought from other servers ({view.purchases.count}, fees {fmtSats(view.purchases.feeMsat)}).</div>
          )}
          {workers && workersOutLine(workers) && <div class="auto-hint">{workersOutLine(workers)}</div>}
          {workers && workers.accepted.answers > 0 && (
            <div class="auto-hint">In this range, {workersAcceptedLine(workers)} Worker pay is owed in sats, apart from what this server earned.</div>
          )}

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
                  <tr>
                    <th>Day (UTC)</th><th>Runs</th><th>Earned</th><th>Cost</th><th>Margin</th><th>Received</th>{deposited.size > 0 && <th>Added</th>}<th>Withdrawn</th>
                    {workers && <th title="Sats that day's accepted answers earned workers, less what of them was taken back">Workers</th>}
                  </tr>
                </thead>
                <tbody>
                  {days.map((day) => {
                    const d = dayRow.get(day);
                    const rin = received.get(day);
                    const out = withdrawn.get(day);
                    const add = deposited.get(day);
                    const pay = workerDays.get(day);
                    return (
                      <tr key={day}>
                        <td>{day}</td>
                        <td>{d?.calls ?? 0}</td>
                        <td>{fmtUsd(d?.earned ?? 0)}</td>
                        <td>{fmtUsd(d?.cost ?? 0)}</td>
                        <td class={(d?.margin ?? 0) < 0 ? "is-loss" : ""}>{fmtUsd(d?.margin ?? 0)}</td>
                        <td>{rin ? fmtSats(rin.msat) : ""}</td>
                        {deposited.size > 0 && <td>{add ? fmtSats(add.msat) : ""}</td>}
                        <td>{out ? fmtSats(out.msat) : ""}</td>
                        {workers && (
                          <td title={pay ? `${pay.answers} answer${pay.answers === 1 ? "" : "s"}${pay.takenBackAnswers ? `, ${pay.takenBackAnswers} taken back` : ""}` : undefined}>
                            {pay ? fmtSats(workersDayMsat(pay)) : ""}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <BuyingSection reload={reload} />

          <WalletForm onSaved={() => setReload((n) => n + 1)} />
        </>
      )}

      {adding && (
        <DepositDialog
          {...(wallet?.rate ? { rate: wallet.rate } : {})}
          onClose={() => {
            setAdding(false);
            setReload((n) => n + 1);
          }}
          onAdded={() => setReload((n) => n + 1)}
        />
      )}

      {withdrawing && wallet && view && (
        <WithdrawDialog
          wallet={wallet}
          outstanding={view.outstanding}
          {...(workers ? { workers } : {})}
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

/** One send still out: what it is, what is known, and what a person may do
 *  — read it now; once it is stale (past its invoice's expiry and an hour,
 *  never to be answered) or went through a wallet no longer set, record it
 *  as paid or drop it. */
function PendingRow(props: { p: api.PendingWithdrawal; onChanged: () => void }) {
  const { p } = props;
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [fee, setFee] = useState("");
  const read = async () => {
    setBusy(true);
    setSaid(null);
    try {
      const r = await api.readWithdrawal(p.paymentHash);
      setSaid(r.ok ? (r.state === "settled" ? `Settled: recorded, fee ${fmtSats(r.feeMsat)}.` : r.state === "failed" ? `It failed: ${r.error ?? "nothing was paid"}.` : r.reading ? "The wallet has not answered yet: still reading." : `Still on its way${r.error ? `: ${r.error}` : ""}.`) : withdrawRefusal(r));
      props.onChanged();
    } finally {
      setBusy(false);
    }
  };
  const resolve = async (action: "paid" | "drop") => {
    setBusy(true);
    setSaid(null);
    try {
      const sats = Number(fee);
      await api.resolveWithdrawal(p.paymentHash, { action, ...(action === "paid" && fee.trim() && Number.isFinite(sats) && sats >= 0 ? { feeMsat: Math.round(sats * 1000) } : {}) });
      props.onChanged();
    } catch (err) {
      setSaid(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const state = p.reading
    ? "being read now"
    : p.otherWallet
      ? `went out through another wallet (${p.payer || "an earlier one"}): set it back to read it`
      : p.stale
        ? "stale: the wallet will not say more — record it as paid if it left the wallet, or drop it"
        : p.answered
          ? "sent, not settled yet: read again every minute"
          : "the wallet never answered: read it now";
  const decide = p.stale || p.otherWallet;
  return (
    <div class={`earnings-pending-item${decide ? " is-stale" : ""}`}>
      <div class="earnings-pending-row">
        <span>{fmtSats(p.msat)}{sendPurposeNote(p.purpose)}</span>
        <span class="auto-hint">{state}</span>
        <span class="auto-hint">{fmtTime(new Date(p.at).toISOString())}</span>
      </div>
      {p.lastError && <div class="auto-hint">Last read: {p.lastError}</div>}
      <div class="earnings-pending-actions">
        {!p.otherWallet && <button class="btn btn-sm" disabled={busy || p.reading} onClick={() => void read()}>Read it now</button>}
        {decide && (
          <>
            <input class="earnings-fee-input" type="number" min="0" step="1" placeholder="fee, sats" value={fee} title="The routing fee it cost, when you know it (0 otherwise)" onInput={(e) => setFee((e.target as HTMLInputElement).value)} />
            <ConfirmButton class="btn btn-sm" label="Record as paid" disabled={busy || p.reading}
              note={`Record ${fmtSats(p.msat)} as paid out, in the books? Do it only if it left the wallet.`}
              confirmLabel="Record" tone="primary" onConfirm={() => void resolve("paid")} />
            <ConfirmButton class="btn btn-sm" label="Drop" disabled={busy || p.reading}
              note="Forget it? Nothing goes in the books; if it did leave the wallet, the books check will show it."
              confirmLabel="Drop" onConfirm={() => void resolve("drop")} />
          </>
        )}
        {said && <span class="auto-hint">{said}</span>}
      </div>
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
          {info.note && !info.env && <div class="auto-hint">{info.note}</div>}
        </div>
      )}
      {info?.env && (
        <div class="auto-hint">
          Set by this server's deployment (<code>LIGHTNING_*</code> in its environment), which writes it again at every boot: change it there.
          {!info.pay && " Withdraw needs a pay credential there too."}
        </div>
      )}
      {!editing && !info?.env && (
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
              {field("url", "Daemon URL", sameProvider ? "keep as it is" : "http://treasury.sphinx:8095", false)}
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
