import { displayActor } from "../actor";
import { countLedger, lastVerifyLabel, noticeTone, parseNotice, type Ledger, type LedgerClaim } from "../notice";
import { ago } from "./ClaimsPanel";
import { ToolResultView } from "./ToolResultView";

// ── Wake-up notice card ────────────────────────────────────────────────────
// A `[run-notification]` / `[verify-notification]` is the message that woke
// the builder: written for the model, so mostly JSON. A person gets a closed
// one-line card (what happened, to which run, how the claims stand) that
// opens level by level: the card → a claim → the raw message the model read.
// Open state lives in the chat's `expanded` map (keys under `prefix`) so it
// resets with the transcript, like the tool chips.

const DOT: Record<ReturnType<typeof noticeTone>, string> = {
  ok: "is-ok",
  error: "is-error",
  warning: "is-warning",
  pending: "is-pending",
  neutral: "is-unknown",
};

function Counts(props: { ledger: Ledger }) {
  const c = countLedger(props.ledger);
  return (
    <>
      {c.refuted > 0 && <span class="chat-notice-count is-refuted">{c.refuted} refuted</span>}
      {c.unknown > 0 && <span class="chat-notice-count is-unknown">{c.unknown} unknown</span>}
      {c.stale > 0 && <span class="chat-notice-count is-stale">{c.stale} stale</span>}
      {c.supported > 0 && <span class="chat-notice-count is-supported">{c.supported} supported</span>}
      {c.waiting > 0 && <span class="claim-flag" title="A check is waiting on a person or an outside system.">{c.waiting} waiting</span>}
      {c.assertedOnly > 0 && <span class="claim-flag" title="No instrument observed this — only a model's or a person's word.">{c.assertedOnly} asserted only</span>}
    </>
  );
}

function ClaimRow(props: { claim: LedgerClaim; open: boolean; onToggle: () => void }) {
  const { claim: c, open } = props;
  return (
    <div class={`chat-notice-claim${open ? " is-open" : ""}`}>
      <button type="button" class="chat-notice-claim-head" onClick={props.onToggle} aria-expanded={open}>
        <span class={`chat-tool-chev${open ? " is-open" : ""}`} aria-hidden="true" />
        <span class={`claim-status claim-status-${c.status}`}>{c.status}</span>
        {/* Flags ride on the closed row: the card's header counts them, so a
            person needs to see WHICH claim without opening each one. */}
        <span class="chat-notice-claim-text">
          {c.text}
          {c.assertedOnly && <span class="claim-flag" title="No instrument observed this — only a model's or a person's word.">asserted only</span>}
          {c.unverified > 0 && c.status !== "unknown" && <span class="claim-flag" title="Active checks with no evidence about the active version.">{c.unverified} unverified</span>}
        </span>
      </button>
      {open && (
        <div class="chat-notice-claim-body">
          {c.latest ? (
            <div class="claim-evidence">
              <span class={`claim-mode claim-mode-${c.latest.mode ?? "unknown"}`}>{c.latest.mode ?? "evidence"}</span>
              <span class="claim-evidence-content">{c.latest.content}</span>
              <div class="claim-dim">
                {ago(c.latest.observed_at)}
                {c.latest.checkVersion ? ` · ${c.latest.checkVersion}` : ""}
              </div>
            </div>
          ) : (
            <div class="claim-dim">No evidence yet.</div>
          )}
          <div class="claim-checks">
            {c.checks.map((k) => {
              const v = lastVerifyLabel(k.lastVerify);
              return (
                <div class="claim-check" key={k.id}>
                  <span class="claim-check-name">{k.name}</span>
                  {k.external && <span class="claim-dim">external</span>}
                  <span class={`chat-notice-verify is-${v.tone}`}>{v.label}</span>
                  {c.latest?.check === k.id && <span class="claim-dim">· produced the evidence above</span>}
                  {v.detail && <div class="claim-check-desc">{v.detail}</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function NoticeView(props: {
  text: string;
  /** Namespace for this notice's keys in the chat's `expanded` map. */
  prefix: string;
  expanded: Record<string, boolean>;
  onToggle: (key: string) => void;
  onOpenRun?: (workflow: string, runId: string) => void;
}) {
  const n = parseNotice(props.text);
  const key = (k: string) => `${props.prefix}:${k}`;
  const isOpen = (k: string) => !!props.expanded[key(k)];
  const open = isOpen("card");

  // The user's answer to the builder's question (plans/elicitation.md): what
  // they chose — or that they declined — and, for a secret, its NAME and
  // that it was stored. The value is not in the message, by construction.
  if (n?.kind === "elicitation" && n.action) {
    const title = n.action === "accept" ? "Answered" : n.action === "decline" ? "Declined" : "Dismissed";
    return (
      <div class={`chat-notice-card${open ? " is-open" : ""}`}>
        <button type="button" class="chat-notice-head" onClick={() => props.onToggle(key("card"))} aria-expanded={open}>
          <span class={`chat-tool-dot ${DOT[noticeTone(n)]}`} />
          <span class="chat-notice-main">
            <span class="chat-notice-title">{title}</span>
            <span class="chat-notice-subject">{n.secretName ? `secret ${n.secretName}` : "the builder's question"}</span>
            <span class="chat-notice-meta">
              {n.secretName && <span class="claim-dim">{n.secretStored ? "stored" : "not stored"}</span>}
              {n.by && <span class="claim-dim" title={n.by}>by {displayActor(n.by)}</span>}
            </span>
          </span>
          <span class={`chat-tool-chev${open ? " is-open" : ""}`} aria-hidden="true" />
        </button>
        {open && (
          <div class="chat-notice-body">
            {n.content !== undefined && (
              <ToolResultView
                label="Answer"
                result={{ output: n.content, isError: false }}
                open={isOpen("content")}
                onToggle={() => props.onToggle(key("content"))}
              />
            )}
            <ToolResultView
              label="Raw message"
              result={{ output: props.text, isError: false }}
              open={isOpen("raw")}
              onToggle={() => props.onToggle(key("raw"))}
            />
          </div>
        )}
      </div>
    );
  }

  // Not a shape we know — show it as written.
  if (!n || !n.runId) {
    return (
      <div class="chat-msg chat-msg-notice">
        <div class="chat-msg-text">{props.text}</div>
      </div>
    );
  }
  const title = n.kind === "verify" ? "Verified" : `Run ${n.runStatus === "success" ? "finished" : n.runStatus === "error" ? "failed" : n.runStatus}`;
  const canOpenRun = !!props.onOpenRun && !!n.workflow && !n.workflow.includes(":");

  return (
    <div class={`chat-notice-card${open ? " is-open" : ""}`}>
      <button type="button" class="chat-notice-head" onClick={() => props.onToggle(key("card"))} aria-expanded={open}>
        <span class={`chat-tool-dot ${DOT[noticeTone(n)]}`} />
        {/* Wraps as a unit: in a narrow flyout the counts drop to a second
            line rather than crushing the workflow name. */}
        <span class="chat-notice-main">
          <span class="chat-notice-title">{title}</span>
          <span class="chat-notice-subject">{n.workflow}</span>
          <span class="chat-notice-meta">
            {n.duration && <span class="claim-dim">{n.duration}</span>}
            {n.ledger && <Counts ledger={n.ledger} />}
            {n.verifying && <span class="claim-dim">verifying…</span>}
          </span>
        </span>
        <span class={`chat-tool-chev${open ? " is-open" : ""}`} aria-hidden="true" />
      </button>
      {open && (
        <div class="chat-notice-body">
          <div class="chat-notice-run">
            <span class="claim-dim">run {n.runId}</span>
            {canOpenRun && (
              <button type="button" class="claim-link" onClick={() => props.onOpenRun!(n.workflow!, n.runId!)}>open run</button>
            )}
            {n.cost && <span class="claim-dim">checks cost {n.cost}</span>}
          </div>
          {n.error && <pre class="chat-notice-error">{n.error}</pre>}
          {n.output !== undefined && (
            <ToolResultView
              label={n.outputTruncated ? "Output (truncated)" : "Output"}
              result={{ output: n.output, isError: false }}
              open={isOpen("output")}
              onToggle={() => props.onToggle(key("output"))}
            />
          )}
          {n.verifying && <div class="claim-dim">Verification against its claims is still running — a verdict follows.</div>}
          {n.ledger &&
            Object.entries(n.ledger).map(([subject, claims]) => (
              <div class="chat-notice-subject-group" key={subject}>
                <div class="chat-notice-subject-head">
                  <span class="chat-notice-subject-name">{subject}</span>
                  <span class="claim-dim">{claims.length} {claims.length === 1 ? "claim" : "claims"}</span>
                </div>
                {claims.map((c) => (
                  <ClaimRow
                    key={c.id}
                    claim={c}
                    open={isOpen(`claim:${subject}:${c.id}`)}
                    onToggle={() => props.onToggle(key(`claim:${subject}:${c.id}`))}
                  />
                ))}
              </div>
            ))}
          {n.notes.length > 0 && (
            <div class="chat-notice-notes">
              <span class="chat-notice-notes-label">Told to the builder</span>
              {n.notes.map((line, i) => <div key={i}>{line}</div>)}
            </div>
          )}
          <ToolResultView
            label="Raw message"
            result={{ output: props.text, isError: false }}
            open={isOpen("raw")}
            onToggle={() => props.onToggle(key("raw"))}
          />
        </div>
      )}
    </div>
  );
}
