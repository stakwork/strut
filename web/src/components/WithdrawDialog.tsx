import { useMemo, useState } from "preact/hooks";
import * as api from "../api";
import { fmtExpiresIn, fmtSats, fmtUsd, maxWithdrawMsat, readWithdrawInvoice, usdOfMsat, withdrawRefusal } from "../earnings";

// ── Withdraw (plans/paid-runs.md §8, decision 19) ──────────────────────────
//
// Sats out of the server's wallet to an invoice the person pastes. The
// dialog reads the invoice with the server's own BOLT11 reader, shows the
// amount it asks for and the fee cap beside the balance and the credit still
// owed as service, and asks before paying. `msat` sent is what was shown, so
// an invoice for any other amount is refused by the server. The answer is
// the payment's state and fee, or the wallet's refusal as it came; a
// pending one is read again by asking again (the server never pays twice).

type Stage =
  | { at: "edit" }
  | { at: "confirm" }
  | { at: "paying" }
  | { at: "done"; result: Extract<api.WithdrawResult, { ok: true }> }
  | { at: "refused"; message: string };

export function WithdrawDialog(props: {
  wallet: NonNullable<api.EarningsView["wallet"]>;
  outstanding: api.EarningsView["outstanding"];
  onClose: () => void;
  /** A payment settled or went out: the tab reads its numbers again. */
  onPaid: () => void;
}) {
  const [text, setText] = useState("");
  const [stage, setStage] = useState<Stage>({ at: "edit" });
  const balance = props.wallet.balance?.msat;
  const rate = props.wallet.rate;
  const provider = props.wallet.provider;
  const reading = useMemo(() => readWithdrawInvoice(text, { balanceMsat: balance, usdPerBtc: rate, provider }), [text, balance, rate, provider]);
  const capsFee = provider !== "nwc";
  const most = balance !== undefined ? maxWithdrawMsat(provider, balance) : undefined;

  const pay = async () => {
    if (!reading.ok) return;
    setStage({ at: "paying" });
    try {
      const r = await api.withdraw({ invoice: reading.invoice.invoice, msat: reading.msat });
      if (r.ok) {
        setStage({ at: "done", result: r });
        if (r.state !== "failed") props.onPaid();
      } else setStage({ at: "refused", message: withdrawRefusal(r) });
    } catch (err) {
      setStage({ at: "refused", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const busy = stage.at === "paying";
  return (
    <div class="dialog-backdrop withdraw-backdrop" onClick={(e) => { if (e.target === e.currentTarget && !busy) props.onClose(); }}>
      <div class="dialog withdraw-dialog" role="dialog" aria-label="Withdraw">
        <div class="dialog-title">Withdraw</div>

        <div class="withdraw-books">
          <div>
            <div class="ov-tile-label">In the wallet</div>
            <div class="withdraw-figure">{balance !== undefined ? fmtSats(balance) : "—"}</div>
            {props.wallet.balance?.usd !== undefined && <div class="ov-tile-sub">≈ {fmtUsd(props.wallet.balance.usd)}</div>}
            {most !== undefined && (
              <div class="ov-tile-sub" title={capsFee ? "The Lightning provider takes the amount first and its routing fee from what is left" : "The wallet keeps its routing fee back beside the amount"}>
                at most {fmtSats(most)} out
              </div>
            )}
          </div>
          <div title="Paid for and not yet charged: what buyers are still owed as service. The sats are yours either way.">
            <div class="ov-tile-label">Owed as service</div>
            <div class="withdraw-figure">{fmtUsd(props.outstanding.usd)}</div>
            <div class="ov-tile-sub">{props.outstanding.tokens} credit token{props.outstanding.tokens === 1 ? "" : "s"}</div>
          </div>
        </div>

        {(stage.at === "edit" || stage.at === "confirm" || stage.at === "paying") && (
          <>
            <div class="dialog-field">
              <label for="withdraw-invoice">An invoice to pay</label>
              <textarea
                id="withdraw-invoice"
                class="withdraw-invoice"
                rows={4}
                placeholder="lnbc… — from the wallet the sats should go to"
                value={text}
                disabled={stage.at !== "edit"}
                onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
                spellcheck={false}
              />
            </div>
            {!reading.ok && reading.error && <div class="auto-error">{reading.error}</div>}
            {reading.ok && (
              <div class="withdraw-ask">
                <div class="withdraw-amount">
                  <span class="withdraw-figure">{fmtSats(reading.msat)}</span>
                  {reading.usd !== undefined && <span class="auto-hint">≈ {fmtUsd(reading.usd)}{rate ? ` at ${fmtUsd(rate)} per bitcoin` : ""}</span>}
                </div>
                {reading.invoice.description && <div class="withdraw-desc">“{reading.invoice.description}”</div>}
                <div class="auto-hint">
                  {capsFee
                    ? <>Routing fee at most {fmtSats(reading.maxFeeMsat)} (the Lightning provider's own limit). </>
                    : <>Routing fee: the NWC wallet's own limit applies; strut reports the fee after. </>}
                  Expires {fmtExpiresIn(reading.expiresIn)}.
                </div>
                {reading.network && <div class="auto-hint">A {reading.network} invoice: the wallet pays it only if it is on that network.</div>}
                {reading.overBalance && most !== undefined && (
                  <div class="public-run-hint">
                    This asks for more than can be withdrawn: at most {fmtSats(most)}{capsFee ? "" : ", with the wallet's fee beside it"}. The wallet will refuse it.
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {stage.at === "done" && (
          <div class={`withdraw-result is-${stage.result.state}`}>
            {stage.result.state === "settled" && (
              <>
                <div class="withdraw-result-title">{stage.result.existing ? "Already paid" : "Paid"}: {fmtSats(stage.result.msat)}</div>
                <div class="auto-hint">
                  Fee {fmtSats(stage.result.feeMsat)}{rate ? ` (≈ ${fmtUsd(usdOfMsat(stage.result.feeMsat, rate))})` : ""}. Recorded in the books as a withdrawal.
                  {stage.result.routingFeeMsat !== undefined && ` The route reported ${fmtSats(stage.result.routingFeeMsat)}, but too little was left for the provider to take it.`}
                  {stage.result.existing && " This invoice was paid before: nothing was sent again."}
                </div>
              </>
            )}
            {stage.result.state === "pending" && (
              <>
                <div class="withdraw-result-title">{stage.result.reading ? "Still waiting on the wallet" : "Sent, not settled yet"}</div>
                <div class="auto-hint">
                  {stage.result.reading
                    ? "The wallet has not answered yet. Strut keeps reading it and records it once it settles; it shows under the wallet as on its way."
                    : "The wallet has it and is still routing it. Strut reads it again every minute and records it once it settles; asking again here reads where it stands now."}
                  {stage.result.error && !stage.result.reading && <> The wallet said: {stage.result.error}.</>}
                </div>
              </>
            )}
            {stage.result.state === "failed" && (
              <>
                <div class="withdraw-result-title">It failed: nothing was paid</div>
                <div class="auto-hint">The wallet said: {stage.result.error ?? "the payment failed"}. You may try again.</div>
              </>
            )}
            <code class="withdraw-hash" title="The payment hash">{stage.result.paymentHash}</code>
          </div>
        )}
        {stage.at === "refused" && <div class="auto-error">{stage.message}</div>}

        <div class="dialog-actions">
          {stage.at === "edit" && (
            <>
              <button class="btn" onClick={props.onClose}>Cancel</button>
              <button class="btn btn-primary" disabled={!reading.ok} onClick={() => setStage({ at: "confirm" })}>Review</button>
            </>
          )}
          {(stage.at === "confirm" || stage.at === "paying") && reading.ok && (
            <>
              <span class="withdraw-confirm">Pay {fmtSats(reading.msat)}{capsFee ? ` (+ at most ${fmtSats(reading.maxFeeMsat)} fee)` : " (+ the wallet's fee)"} out of this wallet? It cannot be taken back.</span>
              <button class="btn" disabled={busy} onClick={() => setStage({ at: "edit" })}>Back</button>
              <button class="btn btn-primary" disabled={busy} onClick={() => void pay()}>{busy ? "Paying…" : `Pay ${fmtSats(reading.msat)}`}</button>
            </>
          )}
          {stage.at === "done" && stage.result.state === "pending" && (
            <button class="btn" onClick={() => void pay()}>Ask again</button>
          )}
          {stage.at === "done" && stage.result.state === "failed" && (
            <button class="btn" onClick={() => setStage({ at: "confirm" })}>Try again</button>
          )}
          {stage.at === "refused" && (
            <button class="btn" onClick={() => setStage({ at: "edit" })}>Back</button>
          )}
          {(stage.at === "done" || stage.at === "refused") && <button class="btn btn-primary" onClick={props.onClose}>Close</button>}
        </div>
      </div>
    </div>
  );
}
