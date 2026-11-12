import { useEffect, useMemo, useState } from "preact/hooks";
import { qrSvg } from "./PaymentSheet";
import { signInNote, type SignInAsk } from "../native-pay";
import { signInWithKey, signInWithNostr, signInWithSphinx, startLnurl, type LnurlLogin, type SignInMethod, type VisitorSession } from "../visitor-signin";

// ── The sheet a visitor signs in on (plans/app-repos.md §5.3) ─────────────
//
// Over a public app's frame, never in it: the app asked its host to sign
// the visitor in (`useVisitor().signIn()`), and the host offers the
// methods this server and this browser can do — one button each, and
// LNURL-auth as a QR code any Lightning wallet signs. The app learns the
// actor, never a key. Close answers it that the visitor did not sign in.
// Its server is this one, or another one whose app this page hosts
// (`from`). `sphinx`: the native host's wallet (Peel), whose own sheet
// signs — a press here is the fresh tap it asks for.

const LABELS: Record<SignInMethod, string> = {
  key: "Continue on this device",
  nostr: "Sign in with Nostr",
  lnurl: "Sign in with a Lightning wallet",
  sphinx: "Sign in with Sphinx",
  ticket: "",
};

const POLL_MS = 2000;

export function SignInSheet(props: {
  methods: SignInMethod[];
  onDone: (session: VisitorSession | null) => void;
  /** The native wallet that signs as the person's Sphinx account. */
  sphinx?: SignInAsk;
  /** Why the wallet did not sign them in already. */
  note?: string;
  /** Another server's app: its base, and its host to name. */
  from?: string;
  seller?: string;
}) {
  const { methods, onDone, sphinx, from } = props;
  const [busy, setBusy] = useState<SignInMethod | null>(null);
  const [error, setError] = useState<string | null>(props.note ?? null);
  const [lnurl, setLnurl] = useState<LnurlLogin | null>(null);
  const svg = useMemo(() => (lnurl ? qrSvg(`LIGHTNING:${lnurl.lnurl}`) : ""), [lnurl]);

  // The wallet signs on a phone: ask until it has, or the login ends.
  useEffect(() => {
    if (!lnurl) return;
    let open = true;
    const tick = async () => {
      if (!open) return;
      if (Date.now() > lnurl.exp) {
        setLnurl(null);
        setError("The code expired before a wallet signed it.");
        return;
      }
      try {
        const got = await lnurl.poll();
        if (got) return open && onDone(got);
      } catch (err) {
        if (open) {
          setLnurl(null);
          setError(err instanceof Error ? err.message : String(err));
        }
        return;
      }
      setTimeout(() => void tick(), POLL_MS);
    };
    const t = setTimeout(() => void tick(), POLL_MS);
    return () => {
      open = false;
      clearTimeout(t);
    };
  }, [lnurl]);

  const run = async (m: SignInMethod) => {
    setBusy(m);
    setError(null);
    try {
      if (m === "lnurl") setLnurl(await startLnurl(from));
      else if (m === "sphinx" && sphinx) {
        const r = await signInWithSphinx(sphinx, from);
        if (r.outcome === "signed") onDone(r.session);
        else setError(signInNote(r, sphinx.name));
      } else onDone(m === "nostr" ? await signInWithNostr(from) : await signInWithKey(from));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div class="pay-sheet-backdrop" role="dialog" aria-modal="true" aria-labelledby="sign-in-sheet-title" data-testid="sign-in-sheet">
      <div class="pay-sheet">
        <div class="pay-sheet-head">
          <div class="pay-sheet-title" id="sign-in-sheet-title">Sign in{props.seller ? ` to ${props.seller}` : ""}</div>
        </div>
        {lnurl ? (
          <>
            <p class="pay-sheet-what">Scan with a Lightning wallet that signs in (LNURL-auth).</p>
            <div class="pay-sheet-qr" aria-label="LNURL-auth QR code" dangerouslySetInnerHTML={{ __html: svg }} />
            <div class="pay-sheet-invoice">
              <code title={lnurl.lnurl}>{lnurl.lnurl}</code>
            </div>
            <div class="pay-sheet-status">
              <span class="pay-sheet-spinner" aria-hidden="true" />
              Waiting for the wallet
            </div>
          </>
        ) : (
          <>
            <p class="pay-sheet-what">You are known here by a key only you hold. Nothing else about you is shared.</p>
            <div class="sign-in-methods">
              {methods.map((m) => (
                <button key={m} type="button" class={`btn${m === methods[0] ? " btn-primary" : ""}`} disabled={!!busy} onClick={() => void run(m)}>
                  {busy === m ? (m === "sphinx" && sphinx ? `Confirm in ${sphinx.name}…` : "Signing in…") : m === "sphinx" && sphinx ? `Sign in with ${sphinx.name}` : LABELS[m]}
                </button>
              ))}
            </div>
          </>
        )}
        {error && <div class="pay-sheet-status is-expired">{error}</div>}
        <div class="pay-sheet-actions">
          <button type="button" class="btn" onClick={() => onDone(null)}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
