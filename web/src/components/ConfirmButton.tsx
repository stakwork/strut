import { useCallback, useRef, useState } from "preact/hooks";
import { useDismiss } from "../use-dismiss";

// ── Confirm button ─────────────────────────────────────────────────────────
//
// A button that asks before it acts — in the UI, never a browser dialog
// (hosts like the Claude browser pane suppress those: the dialog never shows
// and the action looks broken). Clicked, it swaps itself for a warning line plus
// Cancel / confirm. It renders as a fragment, so its parent row lays it out:
// in a wrapping flex row the note takes a line of its own, above the buttons.
// Where the row can't grow (the topbar, a flyout meta row), `popover` asks in
// a small popover anchored under the button instead.

export function ConfirmButton(props: {
  label: string;
  /** What confirming does — shown beside the buttons. */
  note: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** false: nothing to warn about right now — act on the first click. */
  ask?: boolean;
  /** The trigger's classes. */
  class?: string;
  /** The confirm button's: danger for what can't be undone. */
  tone?: "danger" | "primary";
  disabled?: boolean;
  popover?: boolean;
  onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setAsking(false), []);
  // The anchor holds the trigger too, so clicking it again toggles.
  useDismiss(anchor, asking && !!props.popover, close);

  const trigger = (
    <button class={props.class ?? "btn btn-danger"} disabled={props.disabled}
      onClick={() => (props.ask === false ? props.onConfirm() : setAsking((a) => !a))}>
      {props.label}
    </button>
  );
  const ask = (
    <>
      <span class="confirm-note">{props.note}</span>
      <button class="btn" onClick={close}>{props.cancelLabel ?? "Cancel"}</button>
      <button class={`btn btn-${props.tone ?? "danger"}`} onClick={() => { close(); props.onConfirm(); }}>
        {props.confirmLabel}
      </button>
    </>
  );

  if (!props.popover) return asking ? ask : trigger;
  return (
    <span class="popover-anchor" ref={anchor}>
      {trigger}
      {asking && <div class="anchored-popover">{ask}</div>}
    </span>
  );
}
