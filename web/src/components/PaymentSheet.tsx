import { useEffect, useMemo, useState } from "preact/hooks";
import qrcode from "qrcode-generator";
import { creditLine, formatSats, formatUsd, invoiceQrText, secondsLeft, type ClaimEnd, type PayOutcome, type PaymentRequired } from "../visitor-pay";
import { fallbackNote, type WalletAnswer } from "../native-pay";

// ── The sheet a visitor pays a priced run on (plans/paid-runs.md §10) ──────
//
// Over a public app's frame, never in it: the page asked to launch a
// workflow that costs something, and its HOST shows what it costs — in
// dollars and in sats at the quoted rate — what the workflow is, and the
// invoice as a QR code with a Copy button. The relay claims the invoice —
// `POST /public/credit/claim` with the challenge's macaroon (§4.4: a phone
// wallet never gives this page the preimage) — until it settles or ends,
// whether or not this sheet is still open (../visitor-pay
// `createClaimKeeper`); the sheet waits on that (`settled`) and answers the
// credential, and the relay sends the page's call again. Cancel answers the
// page that the run was not paid for — an invoice paid after it is still
// claimed, its credit kept for the next launch; an invoice that expired can
// be asked for again.
//
// In a native host's web view (Peel) the host's wallet is asked first
// (`wallet`, ../native-pay, specs/WALLET.md §1.2): the sheet says to confirm
// in the wallet, with the invoice one press away should the wallet not
// answer, and shows it — with why — once the wallet did not pay. A wallet
// that is paying but has not settled leaves the sheet waiting on the claim,
// with no QR code to pay a second time from.

/** The invoice as an SVG QR code: dark modules on white, a four-module
 *  quiet zone, scaled by the container. */
function qrSvg(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text, "Alphanumeric");
  qr.make();
  const n = qr.getModuleCount();
  let d = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + 4} ${y + 4}h1v1h-1z`;
  const size = n + 8;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

/** What the sheet shows: the wallet asked, the wallet paying, the invoice,
 *  or the invoice ended. */
type Stage = "wallet" | "paying" | "invoice" | "expired";

export function PaymentSheet(props: {
  payment: PaymentRequired;
  workflow: string;
  settled: Promise<ClaimEnd>;
  onDone: (outcome: PayOutcome) => void;
  /** The native host's wallet, asked first (../native-pay). */
  wallet?: (signal: AbortSignal) => Promise<WalletAnswer>;
  /** Another strut server the credit is bought on: its host, named on the sheet. */
  seller?: string;
}) {
  const { payment, workflow, settled, onDone } = props;
  const [stage, setStage] = useState<Stage>(props.wallet ? "wallet" : "invoice");
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const svg = useMemo(() => qrSvg(invoiceQrText(payment.invoice)), [payment.invoice]);
  /** Stops waiting on the wallet: the invoice shown instead, or the sheet gone. */
  const [askAbort] = useState(() => new AbortController());

  // Until the invoice settles or ends: then the credential goes to the
  // relay, or the sheet says it expired. Closing the sheet stops only this
  // listener; the relay goes on claiming.
  useEffect(() => {
    let open = true;
    void settled.then((got) => {
      if (!open) return;
      if (got.state === "settled") onDone(got.credential);
      else setStage("expired");
    });
    return () => {
      open = false;
    };
  }, [settled]);

  // The wallet, asked once: paid is done; paying waits on the claim;
  // anything else shows the invoice, saying why.
  useEffect(() => {
    if (!props.wallet) return;
    let open = true;
    void props.wallet(askAbort.signal).then((a) => {
      if (!open || askAbort.signal.aborted) return;
      if (a.outcome === "paid") onDone(a.credential);
      else if (a.outcome === "pending") setStage((s) => (s === "wallet" ? "paying" : s));
      else {
        setNote(fallbackNote(a));
        setStage((s) => (s === "wallet" ? "invoice" : s));
      }
    });
    return () => {
      open = false;
      askAbort.abort();
    };
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const left = secondsLeft(payment.expires, now);
  const ends = left !== undefined ? ` · the invoice ends in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(payment.invoice);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard here: the invoice is selectable below.
    }
  };
  const showInvoice = () => {
    askAbort.abort();
    setNote("Pay this invoice from any Lightning wallet. If your wallet pays after all, it is counted once.");
    setStage("invoice");
  };
  const cancel = () => {
    askAbort.abort();
    onDone(null);
  };

  return (
    <div class="pay-sheet-backdrop" role="dialog" aria-modal="true" aria-labelledby="pay-sheet-title" data-testid="payment-sheet" data-stage={stage}>
      <div class="pay-sheet">
        <div class="pay-sheet-head">
          <div class="pay-sheet-title" id="pay-sheet-title">
            Pay to run {workflow}
            {props.seller && <div class="pay-sheet-seller">on {props.seller}</div>}
          </div>
          <div class="pay-sheet-price">
            <span class="pay-sheet-usd">{formatUsd(payment.usd)}</span>
            <span class="pay-sheet-sats">{formatSats(payment.sats)}</span>
          </div>
        </div>
        <p class="pay-sheet-what">
          {payment.description ?? `${workflow}: credit for one run`}. {creditLine(payment)}
        </p>
        {stage === "wallet" && (
          <div class="pay-sheet-status">
            <span class="pay-sheet-spinner" aria-hidden="true" />
            Confirm the payment in your wallet{ends}
          </div>
        )}
        {stage === "paying" && (
          <div class="pay-sheet-status">
            <span class="pay-sheet-spinner" aria-hidden="true" />
            Your wallet is paying; waiting for it to settle{ends}
          </div>
        )}
        {stage === "invoice" && (
          <>
            {note && <p class="pay-sheet-note">{note}</p>}
            <div class="pay-sheet-qr" aria-label="Lightning invoice QR code" dangerouslySetInnerHTML={{ __html: svg }} />
            <div class="pay-sheet-invoice">
              <code title={payment.invoice}>{payment.invoice}</code>
              <button type="button" class="btn" onClick={() => void copy()}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <div class="pay-sheet-status">
              <span class="pay-sheet-spinner" aria-hidden="true" />
              Waiting for the payment{ends}
            </div>
            {payment.rate && (
              <div class="pay-sheet-rate">
                At {formatUsd(payment.rate.usdPerBtc, { whole: true })} a bitcoin ({payment.rate.source})
              </div>
            )}
          </>
        )}
        {stage === "expired" && <div class="pay-sheet-status is-expired">The invoice expired before it was paid.</div>}
        <div class="pay-sheet-actions">
          {stage === "wallet" && (
            <button type="button" class="btn" onClick={showInvoice}>
              Show the invoice
            </button>
          )}
          {stage === "expired" && (
            <button type="button" class="btn btn-primary" onClick={() => onDone("again")}>
              New invoice
            </button>
          )}
          <button type="button" class="btn" onClick={cancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
