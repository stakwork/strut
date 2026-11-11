import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import qrcode from "qrcode-generator";
import { trustedRate } from "../api";
import { creditLine, invoiceQrText, priceView, secondsLeft, type ClaimEnd, type PayOutcome, type PaymentRequired, type TrustedRate } from "../visitor-pay";
import { PAYING_LONG_MS, STATUS_EVERY_MS, fallbackNote, type WalletAnswer, type WalletAsk } from "../native-pay";

// ── The sheet a visitor pays a priced run on (plans/paid-runs.md §10) ──────
//
// Over a public app's frame, never in it: the page asked to launch a
// workflow that costs something, and its HOST shows what it costs and what it
// is for, and the invoice as a QR code with a Copy button.
//
// **The price is the SATS the invoice asks** (../challenge held them equal
// to the invoice). Dollars appear beside them only at a rate this host
// trusts, its own strut's `GET /rate`. The server's own dollar figure is
// shown only as the CREDIT it says the payment buys, with a warning when
// that credit is worth well under what is paid.
//
// **The claim.** The relay claims the invoice — `POST
// /public/credit/claim` with the challenge's macaroon (§4.4: a phone wallet
// never gives this page the preimage) — until it settles or ends, whether or
// not this sheet is still open (../visitor-pay `createClaimKeeper`). The
// sheet waits on that (`settled`), answers the credential, and the relay
// sends the page's call again. Cancel answers the page that the run was not
// paid for. An invoice paid after Cancel is still claimed, and its credit
// kept for the next launch.
//
// **In a native host's web view (Peel)** the host's wallet is asked first
// (`wallet`, ../native-pay, specs/WALLET.md §1.2): "Confirm in ⟨wallet⟩".
// - **Show the invoice** is there for a wallet that does not answer.
// - **Once the person tapped** (the wallet answers `pending`, or paid
//   unproven), the invoice is shown NO MORE. A seller holding the first
//   payment knows its preimage and could settle a second one. The sheet
//   waits on the claim and on the wallet's `buy_credit_status`; a payment
//   that fails there brings the invoice back.
// - **A wallet that did not pay** (a decline, a refusal, a failure) leaves
//   the invoice, why, and **Pay with ⟨wallet⟩**: a fresh tap here, which a
//   native host that wants a recent tap is waiting for.

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

/** What the sheet shows: the wallet asked, the wallet paying (no invoice),
 *  the invoice, or the invoice ended. */
type Stage = "wallet" | "paying" | "invoice" | "expired";

export function PaymentSheet(props: {
  payment: PaymentRequired;
  workflow: string;
  settled: Promise<ClaimEnd>;
  onDone: (outcome: PayOutcome) => void;
  /** The native host's wallet, asked first (../native-pay). */
  wallet?: WalletAsk;
  /** Another strut server the credit is bought on: its host, named on the sheet. */
  seller?: string;
}) {
  const { payment, workflow, settled, onDone, wallet } = props;
  const [stage, setStage] = useState<Stage>(wallet ? "wallet" : "invoice");
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [payingSince, setPayingSince] = useState<number | null>(null);
  const [rate, setRate] = useState<TrustedRate | null>(null);
  const svg = useMemo(() => qrSvg(invoiceQrText(payment.invoice)), [payment.invoice]);
  /** The ask in flight: aborted when the person chooses the invoice or leaves. */
  const asking = useRef<AbortController | null>(null);
  const open = useRef(true);
  const name = wallet?.name ?? "your wallet";
  const price = priceView(payment, rate, props.seller);

  /** The wallet said it sent the payment: wait on it, invoice hidden for good. */
  const paying = () => {
    setNote(null);
    setStage((s) => (s === "expired" ? s : "paying"));
    setPayingSince((t) => t ?? Date.now());
  };
  const answered = (a: WalletAnswer) => {
    if (!open.current) return;
    if (a.outcome === "paid") onDone(a.credential);
    else if (a.outcome === "pending") paying();
    else {
      setNote(fallbackNote(a, name));
      setStage((s) => (s === "wallet" ? "invoice" : s));
    }
  };
  /** One ask of the wallet. Its late answer, after the person chose the
   *  invoice, still counts when it says the payment was sent. */
  const ask = () => {
    if (!wallet) return;
    asking.current?.abort();
    const ctl = new AbortController();
    asking.current = ctl;
    setNote(null);
    setStage("wallet");
    void wallet
      .pay(ctl.signal, (late) => {
        if (late.outcome !== "fallback") answered(late);
      })
      .then((a) => {
        if (!ctl.signal.aborted) answered(a);
      });
  };

  // Until the invoice settles or ends: then the credential goes to the
  // relay, or the sheet says it expired. Closing the sheet stops only this
  // listener; the relay goes on claiming.
  useEffect(() => {
    void settled.then((got) => {
      if (!open.current) return;
      if (got.state === "settled") onDone(got.credential);
      else setStage("expired");
    });
  }, [settled]);

  useEffect(() => {
    open.current = true;
    if (wallet) ask();
    void trustedRate().then((r) => {
      if (open.current) setRate(r);
    });
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      open.current = false;
      asking.current?.abort();
      clearInterval(t);
    };
  }, []);

  // A payment the wallet sent: where it stands, until the claim settles or
  // the wallet says it failed (the invoice comes back: nothing was paid).
  useEffect(() => {
    if (stage !== "paying" || !wallet?.status) return;
    const t = setInterval(() => {
      void wallet.status!().then((a) => {
        if (!open.current) return;
        if (a.outcome === "paid") onDone(a.credential);
        else if (a.outcome === "fallback") {
          setPayingSince(null);
          setNote(fallbackNote(a, name));
          setStage((s) => (s === "paying" ? "invoice" : s));
        }
      });
    }, STATUS_EVERY_MS);
    return () => clearInterval(t);
  }, [stage]);

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
    asking.current?.abort();
    setNote(`Pay this invoice from any Lightning wallet. If ${name} pays it after all, this invoice goes away.`);
    setStage("invoice");
  };
  const cancel = () => {
    asking.current?.abort();
    // Closed while a payment is on its way: no run now, and what settles
    // later is kept as credit (the relay goes on claiming).
    if (stage === "paying") {
      onDone({ error: `payment_pending: the run of ${workflow} did not start, because its payment had not settled — if it settles, the credit is kept on this server for your next run` });
    } else onDone(null);
  };
  const payingLong = stage === "paying" && payingSince !== null && now - payingSince > PAYING_LONG_MS;

  return (
    <div class="pay-sheet-backdrop" role="dialog" aria-modal="true" aria-labelledby="pay-sheet-title" data-testid="payment-sheet" data-stage={stage}>
      <div class="pay-sheet">
        <div class="pay-sheet-head">
          <div class="pay-sheet-title" id="pay-sheet-title">
            Pay to run {workflow}
            {props.seller && <div class="pay-sheet-seller">on {props.seller}</div>}
          </div>
          <div class="pay-sheet-price">
            <span class="pay-sheet-usd" data-testid="pay-sheet-sats">{price.sats}</span>
            {price.usd && <span class="pay-sheet-sats">{price.usd}</span>}
          </div>
        </div>
        <p class="pay-sheet-what">
          {payment.description ?? `${workflow}: credit for one run`}. {price.credit} {creditLine(payment)}
        </p>
        {price.warning && <p class="pay-sheet-note is-warning" data-testid="pay-sheet-warning">{price.warning}</p>}
        {stage === "wallet" && (
          <div class="pay-sheet-status">
            <span class="pay-sheet-spinner" aria-hidden="true" />
            Confirm the payment in {name}{ends}
          </div>
        )}
        {stage === "paying" && (
          <>
            <div class="pay-sheet-status">
              <span class="pay-sheet-spinner" aria-hidden="true" />
              {name[0]!.toUpperCase() + name.slice(1)} is paying; waiting for it to settle
            </div>
            {payingLong && (
              <p class="pay-sheet-note">
                It has not settled yet: a server may hold a payment until it settles or fails on its own. You may close this; if it settles, the credit is
                kept here for your next run.
              </p>
            )}
          </>
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
          </>
        )}
        {stage === "expired" && <div class="pay-sheet-status is-expired">The invoice expired before it was paid.</div>}
        <div class="pay-sheet-actions">
          {stage === "wallet" && (
            <button type="button" class="btn" onClick={showInvoice}>
              Show the invoice
            </button>
          )}
          {stage === "invoice" && wallet && (
            <button type="button" class="btn btn-primary" onClick={ask}>
              Pay with {name}
            </button>
          )}
          {stage === "expired" && (
            <button type="button" class="btn btn-primary" onClick={() => onDone("again")}>
              New invoice
            </button>
          )}
          <button type="button" class="btn" onClick={cancel}>
            {stage === "paying" ? "Close" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}
