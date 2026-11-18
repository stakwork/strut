import { useEffect, useState } from "preact/hooks";
import { workerOf, type CreditView, type PlacementController, type WorkerView } from "../account-widget";
import type { AccountApi } from "../app-host";
import { signOutVisitor, visitorInfo } from "../visitor-signin";
import { fmt, words } from "../words";

// ── The visitor's account widget ───────────────────────────────────────────
//
// Strut's own, drawn over a visitor's app (components/AppHost.tsx) and never
// inside its frame. A pill that opens a panel: who is signed in (the sheet's
// sign-in flow, the one `useVisitor` draws), the credit held at this seller,
// and — for a signed-in worker on a site that grants `task/me` — what is held
// and what can be withdrawn. Where it sits and whether it is collapsed is the
// controller's (../account-widget): the app may move or collapse it, but a
// collapsed widget is a dot that stays on screen and opens on a click.
// The worker section is the host's own `step_run` of `task/me` and
// `task/withdraw` as the app's viewer; refused (not granted, not a worker),
// it is not drawn. In the page's language (../words).

export function AccountWidget(props: {
  placement: PlacementController;
  api: AccountApi;
  from?: string;
  /** Bumped when the page signed the visitor in or out: read again. */
  tick: number;
  /** The widget signed the visitor in or out: the page starts again as the new viewer. */
  onSession: () => void;
}) {
  const { placement, api, from } = props;
  const [state, setState] = useState(placement.state());
  useEffect(() => placement.subscribe(() => setState(placement.state())), [placement]);
  const [open, setOpen] = useState(false);
  const [actor, setActor] = useState<string | undefined>(undefined);
  const [canSignIn, setCanSignIn] = useState(false);
  const [credit, setCredit] = useState<CreditView | null>(null);
  const [worker, setWorker] = useState<WorkerView | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const readWorker = async () => {
    try {
      setWorker(api.run ? workerOf(await api.run("task/me", {})) : null);
    } catch {
      setWorker(null);
    }
  };
  // Who is signed in: read at start and when the page signs in or out.
  useEffect(() => {
    let on = true;
    visitorInfo(from).then(
      (i) => on && (setActor(i.actor), setCanSignIn(!!api.signIn)),
      () => on && setActor(undefined),
    );
    return () => {
      on = false;
    };
  }, [from, props.tick]);
  // Credit and earnings: read when the panel opens (and who changed).
  useEffect(() => {
    if (!open) return;
    let on = true;
    api.credit().then((c) => on && setCredit(c), () => on && setCredit(null));
    if (actor) void readWorker();
    else setWorker(null);
    return () => {
      on = false;
    };
  }, [open, actor, props.tick]);
  // A collapse by the app closes the panel.
  useEffect(() => {
    if (state.collapsed) setOpen(false);
  }, [state.collapsed]);

  const signIn = async () => {
    setBusy(true);
    setNote(null);
    try {
      if (await api.signIn!()) props.onSession();
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const signOut = async () => {
    await signOutVisitor(from);
    props.onSession();
  };
  const withdraw = async () => {
    if (!worker || !api.run) return;
    setBusy(true);
    setNote(null);
    try {
      const r = (await api.run("task/withdraw", { msat: worker.maxMsat })) as { state?: string; error?: string };
      setNote(r.state === "failed" ? r.error ?? words.withdrawFailed : r.state === "pending" ? words.withdrawPending : words.withdrawn);
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      await readWorker();
    }
  };

  return (
    <div class={`account-widget at-${state.corner}${state.collapsed ? " is-collapsed" : ""}`} data-testid="account-widget">
      {state.collapsed ? (
        <button
          type="button"
          class="account-dot"
          aria-label={words.openAccount}
          title={words.account}
          onClick={() => {
            placement.user(false);
            setOpen(true);
          }}
        />
      ) : (
        <>
          {/* Signed in: a person, never the key — the key is no name. */}
          <button
            type="button"
            class={`account-pill${actor ? " is-icon" : ""}`}
            aria-expanded={open}
            aria-label={actor ? words.accountSignedIn : undefined}
            title={actor ? words.account : undefined}
            onClick={() => setOpen(!open)}
          >
            {actor ? (
              <>
                <svg class="account-person" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="8.5" r="4" />
                  <path d="M4.5 20.5c0-4.1 3.4-7 7.5-7s7.5 2.9 7.5 7" />
                </svg>
                <span class="account-pill-dot is-on is-badge" aria-hidden="true" />
              </>
            ) : (
              <>
                <span class="account-pill-dot" aria-hidden="true" />
                {canSignIn ? words.signIn : words.account}
              </>
            )}
          </button>
          {open && (
            <div class="account-panel" role="dialog" aria-label={words.account}>
              <div class="account-row">
                {actor ? (
                  <>
                    <span title={actor}>{words.signedIn}</span>
                    <button type="button" class="btn" onClick={() => void signOut()}>{words.signOut}</button>
                  </>
                ) : (
                  <>
                    <span>{words.notSignedIn}</span>
                    {canSignIn && <button type="button" class="btn btn-primary" disabled={busy} onClick={() => void signIn()}>{words.signIn}</button>}
                  </>
                )}
              </div>
              {/* A worker's page is about what they earn: their credit only when they hold some. */}
              {(credit || !worker) && (
                <div class="account-row">
                  <span>{words.credit}</span>
                  <span class="account-num">{credit ? `$${credit.usd.toFixed(2)}${credit.sats ? ` · ${fmt.sats(credit.sats * 1000)}` : ""}` : words.noCredit}</span>
                </div>
              )}
              {worker && (
                <>
                  <div class="account-row"><span>{words.held}</span><span class="account-num">{fmt.sats(worker.heldMsat)}</span></div>
                  <div class="account-row">
                    <span>{words.withdrawable}</span>
                    <span class="account-num">{fmt.sats(worker.withdrawableMsat)}</span>
                  </div>
                  {worker.canWithdraw ? (
                    <button type="button" class="btn btn-primary" disabled={busy} onClick={() => void withdraw()}>
                      {words.withdraw(fmt.sats(worker.maxMsat))}
                    </button>
                  ) : (
                    worker.blocked && <div class="account-note" data-testid="withdraw-blocked">{worker.blocked}</div>
                  )}
                </>
              )}
              {note && <div class="account-note">{note}</div>}
              <button type="button" class="account-collapse" onClick={() => placement.user(true)}>{words.collapse}</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
