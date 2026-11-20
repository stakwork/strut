import { useEffect, useMemo, useState } from "preact/hooks";
import { qrSvg } from "./PaymentSheet";
import { signInNote, type SignInAsk } from "../native-pay";
import { signInWithKey, signInWithNostr, signInWithSphinx, startLnurl, type LnurlLogin, type SignInMethod, type VisitorSession } from "../visitor-signin";
import { words } from "../words";

// ── The sheet a visitor signs in on (plans/app-repos.md §5.3) ─────────────
//
// Over a public app's frame, never in it: the app asked its host to sign
// the visitor in (`useVisitor().signIn()`), and the host offers the
// methods this server and this browser can do — one button each, and
// LNURL-auth as a QR code any Lightning wallet signs. The app learns the
// actor, never a key. Close answers it that the visitor did not sign in.
// Its server is this one, or another one whose app this page hosts
// (`from`). `sphinx`: the native host's wallet (Peel), whose own sheet
// signs — a press here is the fresh tap it asks for. In the page's
// language (../words).

const LABELS: Record<SignInMethod, string> = {
  key: words.continueHere,
  nostr: words.withNostr,
  lnurl: words.withLnurl,
  sphinx: words.withWallet("Sphinx"),
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
        setError(words.codeExpired);
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
        else setError(signInNote(r, sphinx.name, words));
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
          <div class="pay-sheet-title" id="sign-in-sheet-title">{props.seller ? words.signInTo(props.seller) : words.signIn}</div>
        </div>
        {lnurl ? (
          <>
            <p class="pay-sheet-what">{words.scan}</p>
            <div class="pay-sheet-qr" aria-label={words.qrLabel} dangerouslySetInnerHTML={{ __html: svg }} />
            <div class="pay-sheet-invoice">
              <code title={lnurl.lnurl}>{lnurl.lnurl}</code>
            </div>
            <div class="pay-sheet-status">
              <span class="pay-sheet-spinner" aria-hidden="true" />
              {words.waitingForWallet}
            </div>
          </>
        ) : (
          <>
            <p class="pay-sheet-what">{words.knownByKey}</p>
            <div class="sign-in-methods">
              {methods.map((m) => (
                <button key={m} type="button" class={`btn${m === methods[0] ? " btn-primary" : ""}`} disabled={!!busy} onClick={() => void run(m)}>
                  {busy === m ? (m === "sphinx" && sphinx ? words.confirmIn(sphinx.name) : words.signingIn) : m === "sphinx" && sphinx ? words.withWallet(sphinx.name) : LABELS[m]}
                </button>
              ))}
            </div>
          </>
        )}
        {error && <div class="pay-sheet-status is-expired">{error}</div>}
        <div class="pay-sheet-actions">
          <button type="button" class="btn" onClick={() => onDone(null)}>
            {words.close}
          </button>
        </div>
      </div>
    </div>
  );
}
