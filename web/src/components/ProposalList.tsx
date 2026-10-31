import { useState } from "preact/hooks";
import * as api from "../api";
import { summaryHead, labelsOf } from "../proposal-view";

// ── Proposals (plans/proposals.md §6) ──────────────────────────────────────
//
// The card strut's own UI draws for a proposal — a tool call waiting on a
// person — in the run overview (the run's) and the job timeline (the
// job's): the step, its title, the model's rationale, the status, and
// Accept / Reject while it is pending. Accept runs the step on the server
// then and there; the row shows the result or the error it came back with.
// The generic body: the step's input as JSON, folded. A host's card renders
// by `step`; this one renders any.

type Item = api.ProposalBrief | api.Proposal;

export function ProposalList(props: {
  proposals: Item[];
  /** Re-read after a decision (the list, the run's output). */
  onDecided?: (p: api.Proposal) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, api.Proposal>>({});
  const [error, setError] = useState<string | null>(null);

  const full = (p: Item): api.Proposal | undefined => detail[p.id] ?? ("input" in p ? p : undefined);
  const toggle = async (p: Item) => {
    if (open === p.id) return setOpen(null);
    setOpen(p.id);
    if (!full(p)) api.getProposal(p.id).then((d) => setDetail((m) => ({ ...m, [p.id]: d })), () => {});
  };
  const decide = async (p: Item, action: "accept" | "reject") => {
    setBusy(p.id);
    setError(null);
    try {
      const rec = await api.decideProposal(p.id, action);
      setDetail((m) => ({ ...m, [p.id]: rec }));
      props.onDecided?.(rec);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div class="props">
      {props.proposals.map((p) => {
        const rec = full(p);
        const status = rec?.status ?? p.status;
        const labels = labelsOf(rec?.card ?? p.card);
        return (
          <div key={p.id} class={`prop prop-${status}`}>
            <button class="prop-head" onClick={() => void toggle(p)} title={p.id}>
              <span class="prop-step">{p.step}</span>
              <span class="prop-title">{p.title}</span>
              <span class={`badge prop-badge prop-badge-${status}`}>{status}</span>
            </button>
            {p.summary && open !== p.id && <div class="prop-summary">{summaryHead(p.summary)}</div>}
            {p.rationale && <div class="prop-why">{p.rationale}</div>}
            {open === p.id && (
              <div class="prop-body">
                {p.summary && <div class="prop-summary prop-summary-full">{p.summary}</div>}
                {(rec?.card ?? p.card) ? (
                  <dl class="prop-fields">
                    {(rec?.card ?? p.card)!.fields.map((f, i) => (
                      <div key={i} class={`prop-field${f.danger ? " prop-field-danger" : ""}`}>
                        <dt>{f.label}</dt>
                        <dd class={f.kind === "code" ? "prop-code" : undefined}>{f.value}</dd>
                      </div>
                    ))}
                    {!(rec?.card ?? p.card)!.full && <div class="prop-meta">Not everything is shown; the full input is in the record.</div>}
                  </dl>
                ) : (
                  <pre class="flyout-json">{rec ? JSON.stringify(rec.input, null, 2) : "…"}</pre>
                )}
                {rec?.decision && (
                  <div class="prop-meta">
                    {rec.decision.action === "accept" ? "Accepted" : "Rejected"}
                    {rec.decision.by ? ` by ${rec.decision.by}` : ""} · {new Date(rec.decision.at).toLocaleString()}
                    {rec.decision.reason ? ` · "${rec.decision.reason}"` : ""}
                  </div>
                )}
                {rec?.result?.error && <div class="prop-error">{rec.result.error}</div>}
                {rec?.result?.output !== undefined && <pre class="flyout-json">{JSON.stringify(rec.result.output, null, 2)}</pre>}
              </div>
            )}
            {(status === "pending" || status === "failed") && (
              <div class="prop-actions">
                <button class="btn btn-primary btn-sm" disabled={busy === p.id} onClick={() => void decide(p, "accept")}>
                  {status === "failed" ? "Accept again" : labels.accept}
                </button>
                {status === "pending" && (
                  <button class="btn btn-sm" disabled={busy === p.id} onClick={() => void decide(p, "reject")}>
                    {labels.reject}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
      {error && <div class="prop-error">{error}</div>}
    </div>
  );
}
