import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import * as api from "../api";
import { errorMessage } from "../helpers";
import { fmtSats, fmtUsd, usdOfMsat } from "../earnings";
import { invoiceQrText, secondsLeft } from "../visitor-pay";
import { qrSvg } from "./PaymentSheet";

// ── Add sats (plans/paid-runs.md §8, §9) ──────────────────────────────────
//
// An invoice INTO this server's wallet, for an admin to pay from their own:
// sats to buy credit at other struts with (remote/buy-credit) before this
// one has sold anything. The wallet's receive side makes it; the dialog
// shows it as a QR code, its text and a `lightning:` link, and reads it every
// two seconds until it settles or expires. Closing the dialog loses nothing:
// the server keeps the invoice and records it in the books once it settles.

/** How often the dialog reads the invoice while it waits. */
const READ_EVERY_MS = 2_000;
/** The amounts offered with one click, in sats. */
const PRESETS = [10_000, 50_000, 100_000, 500_000];

type Stage =
  | { at: "edit" }
  | { at: "asking" }
  | { at: "invoice"; answer: api.DepositAnswer }
  | { at: "settled"; answer: api.DepositAnswer }
  | { at: "expired" }
  | { at: "refused"; message: string };

export function DepositDialog(props: {
  /** Dollars per bitcoin now, for the dollars beside the sats. */
  rate?: number;
  onClose: () => void;
  /** It settled: the tab reads its numbers again. */
  onAdded: () => void;
}) {
  const [text, setText] = useState("");
  const [stage, setStage] = useState<Stage>({ at: "edit" });
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [note, setNote] = useState<string | null>(null);
  const added = useRef(false);

  const sats = Number(text.replace(/[,\s_]/g, ""));
  const valid = text.trim() !== "" && Number.isSafeInteger(sats) && sats > 0;
  const usd = valid && props.rate ? usdOfMsat(sats * 1000, props.rate) : undefined;

  const ask = async () => {
    if (!valid) return;
    setStage({ at: "asking" });
    try {
      setStage({ at: "invoice", answer: await api.askDeposit(sats) });
    } catch (err) {
      setStage({ at: "refused", message: errorMessage(err).replace(/^\/earnings\/deposit: /, "") });
    }
  };

  // While the invoice waits: read it, and tick the clock for "expires in".
  const waiting = stage.at === "invoice" ? stage.answer : null;
  useEffect(() => {
    if (!waiting) return;
    let alive = true;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const read = setInterval(async () => {
      try {
        const a = await api.readDeposit(waiting.paymentHash);
        if (!alive) return;
        setNote(a.error ? `The wallet could not be asked just now: ${a.error}` : null);
        if (a.state === "settled") {
          setStage({ at: "settled", answer: a });
          if (!added.current) {
            added.current = true;
            props.onAdded();
          }
        } else if (a.state === "expired") setStage({ at: "expired" });
      } catch (err) {
        if (alive) setNote(errorMessage(err));
      }
    }, READ_EVERY_MS);
    return () => {
      alive = false;
      clearInterval(tick);
      clearInterval(read);
    };
  }, [waiting?.paymentHash]);

  const svg = useMemo(() => (waiting?.invoice ? qrSvg(invoiceQrText(waiting.invoice)) : ""), [waiting?.invoice]);
  const left = waiting ? secondsLeft(waiting.expires, now) : undefined;
  const copy = async () => {
    if (!waiting?.invoice) return;
    try {
      await navigator.clipboard.writeText(waiting.invoice);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard here: the invoice text is selectable.
    }
  };

  return (
    <div class="dialog-backdrop withdraw-backdrop" onClick={(e) => { if (e.target === e.currentTarget && stage.at !== "asking") props.onClose(); }}>
      <div class="dialog withdraw-dialog" role="dialog" aria-label="Add sats">
        <div class="dialog-title">Add sats</div>
        <div class="auto-hint">
          An invoice into this server's wallet, to pay from your own. The sats are this server's to spend: credit it buys at other
          servers, or a withdrawal. They are not credit for a run here, and not earnings.
        </div>

        {(stage.at === "edit" || stage.at === "asking") && (
          <>
            <div class="dialog-field">
              <label for="deposit-sats">Sats</label>
              <input
                id="deposit-sats"
                type="text"
                inputMode="numeric"
                autocomplete="off"
                placeholder="50,000"
                value={text}
                disabled={stage.at === "asking"}
                onInput={(e) => setText((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => { if (e.key === "Enter") void ask(); }}
              />
            </div>
            <div class="deposit-presets">
              {PRESETS.map((n) => (
                <button key={n} type="button" class="btn btn-sm" disabled={stage.at === "asking"} onClick={() => setText(String(n))}>
                  {fmtSats(n * 1000)}
                </button>
              ))}
            </div>
            {text.trim() !== "" && !valid && <div class="auto-error">A whole number of sats above 0.</div>}
            {usd !== undefined && <div class="auto-hint">≈ {fmtUsd(usd)} at {fmtUsd(props.rate!)} per bitcoin</div>}
          </>
        )}

        {waiting?.invoice && (
          <>
            <div class="withdraw-amount">
              <span class="withdraw-figure">{fmtSats(waiting.msat)}</span>
              {props.rate && <span class="auto-hint">≈ {fmtUsd(usdOfMsat(waiting.msat, props.rate))}</span>}
            </div>
            <a class="pay-sheet-qr" href={`lightning:${waiting.invoice}`} title="Open in a wallet on this device" aria-label="Lightning invoice QR code" dangerouslySetInnerHTML={{ __html: svg }} />
            <div class="pay-sheet-invoice">
              <code title={waiting.invoice}>{waiting.invoice}</code>
              <button type="button" class="btn" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
              <a class="btn" href={`lightning:${waiting.invoice}`}>Open wallet</a>
            </div>
            <div class="pay-sheet-status">
              <span class="pay-sheet-spinner" aria-hidden="true" />
              Waiting for the payment{left !== undefined ? ` · expires in ${left >= 90 ? `${Math.round(left / 60)} min` : `${left} s`}` : ""}
            </div>
            {note && <div class="auto-hint">{note}</div>}
            <div class="auto-hint">Closing this loses nothing: the server keeps reading the invoice and adds it to the books once it is paid.</div>
          </>
        )}

        {stage.at === "settled" && (
          <div class="withdraw-result is-settled">
            <div class="withdraw-result-title">Added: {fmtSats(stage.answer.deposit?.msat ?? stage.answer.msat)}</div>
            <div class="auto-hint">
              In the wallet and in the books as added by hand.
              {stage.answer.deposit && stage.answer.deposit.msat < stage.answer.msat && ` The invoice asked ${fmtSats(stage.answer.msat)}; ${fmtSats(stage.answer.deposit.msat)} settled.`}
            </div>
          </div>
        )}
        {stage.at === "expired" && <div class="pay-sheet-status is-expired">The invoice expired before it was paid. Nothing was added.</div>}
        {stage.at === "refused" && <div class="auto-error">{stage.message}</div>}

        <div class="dialog-actions">
          {(stage.at === "edit" || stage.at === "asking") && (
            <>
              <button class="btn" disabled={stage.at === "asking"} onClick={props.onClose}>Cancel</button>
              <button class="btn btn-primary" disabled={!valid || stage.at === "asking"} onClick={() => void ask()}>
                {stage.at === "asking" ? "Asking the wallet…" : valid ? `Get an invoice for ${fmtSats(sats * 1000)}` : "Get an invoice"}
              </button>
            </>
          )}
          {(stage.at === "expired" || stage.at === "refused") && (
            <button class="btn" onClick={() => setStage({ at: "edit" })}>Back</button>
          )}
          {stage.at !== "edit" && stage.at !== "asking" && <button class="btn btn-primary" onClick={props.onClose}>{stage.at === "invoice" ? "Close" : "Done"}</button>}
        </div>
      </div>
    </div>
  );
}
