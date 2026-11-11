import { useEffect, useMemo, useState } from "preact/hooks";
import qrcode from "qrcode-generator";
import * as api from "../api";
import { creditLine, formatSats, formatUsd, invoiceQrText, secondsLeft, waitForClaim, type PayOutcome, type PaymentRequired } from "../visitor-pay";

// ── The sheet a visitor pays a priced run on (plans/paid-runs.md §10) ──────
//
// Over a public app's frame, never in it: the page asked to launch a
// workflow that costs something, and its HOST shows what it costs — in
// dollars and in sats at the quoted rate — what the workflow is, and the
// invoice as a QR code with a Copy button. The sheet asks `POST
// /public/credit/claim` with the challenge's macaroon until the invoice
// settles (§4.4: a phone wallet never gives this page the preimage), then
// answers the credential to the relay (../visitor-pay `callPaying`), which
// keeps it in memory and sends the page's call again. Cancel answers the
// page that the run was not paid for; an invoice that expired can be asked
// for again.

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

export function PaymentSheet(props: { payment: PaymentRequired; workflow: string; onDone: (outcome: PayOutcome) => void }) {
  const { payment, workflow, onDone } = props;
  const [state, setState] = useState<"waiting" | "expired">("waiting");
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const svg = useMemo(() => qrSvg(invoiceQrText(payment.invoice)), [payment.invoice]);

  // Until the invoice settles or expires: then the credential goes to the
  // relay, or the sheet says it expired.
  useEffect(() => {
    const abort = new AbortController();
    void waitForClaim(() => api.claimPublicCredit(payment.macaroon), { signal: abort.signal }).then((got) => {
      if (!got || abort.signal.aborted) return;
      if (got.state === "settled") onDone(got.credential);
      else setState("expired");
    });
    return () => abort.abort();
  }, [payment.macaroon]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const left = secondsLeft(payment.expires, now);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(payment.invoice);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard here: the invoice is selectable below.
    }
  };

  return (
    <div class="pay-sheet-backdrop" role="dialog" aria-modal="true" aria-labelledby="pay-sheet-title" data-testid="payment-sheet">
      <div class="pay-sheet">
        <div class="pay-sheet-head">
          <div class="pay-sheet-title" id="pay-sheet-title">Pay to run {workflow}</div>
          <div class="pay-sheet-price">
            <span class="pay-sheet-usd">{formatUsd(payment.usd)}</span>
            <span class="pay-sheet-sats">{formatSats(payment.sats)}</span>
          </div>
        </div>
        <p class="pay-sheet-what">
          {payment.description ?? `${workflow}: credit for one run`}. {creditLine(payment)}
        </p>
        {state === "waiting" ? (
          <>
            <div class="pay-sheet-qr" aria-label="Lightning invoice QR code" dangerouslySetInnerHTML={{ __html: svg }} />
            <div class="pay-sheet-invoice">
              <code title={payment.invoice}>{payment.invoice}</code>
              <button type="button" class="btn" onClick={() => void copy()}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <div class="pay-sheet-status">
              <span class="pay-sheet-spinner" aria-hidden="true" />
              Waiting for the payment{left !== undefined ? ` · the invoice ends in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : ""}
            </div>
            {payment.rate && (
              <div class="pay-sheet-rate">
                At {formatUsd(payment.rate.usdPerBtc, { whole: true })} a bitcoin ({payment.rate.source})
              </div>
            )}
          </>
        ) : (
          <div class="pay-sheet-status is-expired">The invoice expired before it was paid.</div>
        )}
        <div class="pay-sheet-actions">
          {state === "expired" && (
            <button type="button" class="btn btn-primary" onClick={() => onDone("again")}>
              New invoice
            </button>
          )}
          <button type="button" class="btn" onClick={() => onDone(null)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
