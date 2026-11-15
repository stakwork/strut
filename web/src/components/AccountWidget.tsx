import { useEffect, useState } from "preact/hooks";
import { formatSats, shortActor, workerOf, type CreditView, type PlacementController, type WorkerView } from "../account-widget";
import type { AccountApi } from "../app-host";
import { signOutVisitor, visitorInfo } from "../visitor-signin";

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
// it is not drawn.

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
      setNote(r.state === "failed" ? r.error ?? "The withdrawal failed." : r.state === "pending" ? "Withdrawal on its way." : "Withdrawn.");
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
          aria-label="Open account"
          title="Account"
          onClick={() => {
            placement.user(false);
            setOpen(true);
          }}
        />
      ) : (
        <>
          <button type="button" class="account-pill" aria-expanded={open} onClick={() => setOpen(!open)}>
            <span class={`account-pill-dot${actor ? " is-on" : ""}`} aria-hidden="true" />
            {actor ? shortActor(actor) : canSignIn ? "Sign in" : "Account"}
          </button>
          {open && (
            <div class="account-panel" role="dialog" aria-label="Account">
              <div class="account-row">
                {actor ? (
                  <>
                    <span>Signed in as <strong title={actor}>{shortActor(actor)}</strong></span>
                    <button type="button" class="btn" onClick={() => void signOut()}>Sign out</button>
                  </>
                ) : (
                  <>
                    <span>Not signed in</span>
                    {canSignIn && <button type="button" class="btn btn-primary" disabled={busy} onClick={() => void signIn()}>Sign in</button>}
                  </>
                )}
              </div>
              {/* A worker's page is about what they earn: their credit only when they hold some. */}
              {(credit || !worker) && (
                <div class="account-row">
                  <span>Credit</span>
                  <span class="account-num">{credit ? `$${credit.usd.toFixed(2)}${credit.sats ? ` · ${credit.sats.toLocaleString("en-US")} sats` : ""}` : "No credit"}</span>
                </div>
              )}
              {worker && (
                <>
                  <div class="account-row"><span>Held</span><span class="account-num">{formatSats(worker.heldMsat)}</span></div>
                  <div class="account-row">
                    <span>Withdrawable</span>
                    <span class="account-num">{formatSats(worker.withdrawableMsat)}</span>
                  </div>
                  {worker.canWithdraw && (
                    <button type="button" class="btn btn-primary" disabled={busy} onClick={() => void withdraw()}>
                      Withdraw {formatSats(worker.maxMsat)}
                    </button>
                  )}
                </>
              )}
              {note && <div class="account-note">{note}</div>}
              <button type="button" class="account-collapse" onClick={() => placement.user(true)}>Collapse to a dot</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
