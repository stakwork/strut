import { useEffect, useMemo, useState } from "preact/hooks";
import * as api from "../api";
import { jobTotals } from "../api";
import { displayActor } from "../actor";
import { formatTokens } from "../context-meter";
import { statusTone } from "../helpers";
import { isArtifactPath } from "@strut/kit/folds";
import { checkOutcomes, ledgerSignature, newestTurn, verifySummary } from "../claims-view";
import type { TouchedNode } from "@strut/kit/folds";
import { ArtifactViewer } from "./ArtifactViewer";
import { JobAppPanel } from "./JobAppPanel";
import { AccessedNodes } from "./AccessedNodes";
import { ClaimsPanel } from "./ClaimsPanel";
import { ProposalList } from "./ProposalList";
import { claimsTitle, claimsTone } from "./WorkflowFlyout";

// ── Job timeline (plans/jobs-sidebar.md §3) ────────────────────────────────
//
// The operator's view of one job, in the canvas area: the header and
// totals, the current deliverables, the threads as a tree (a thread row
// with its totals; its turns; under a turn, what it spawned — a sub-agent,
// a child run, a peer run — nested), and every graph node the job's agents
// touched. A turn's run id opens that run on the canvas you have today; a
// thread's transcript opens in the flyout. Nothing here names a workflow:
// the rows are what the server's fold found (`src/job-threads.ts`).
//
// Where the claims layer is on (the view carries `claims`), a Claims section
// sits under the deliverables (plans/job-claims.md §6): what the work must
// deliver, each claim's status as of the newest turn, and Verify — door two,
// `POST /jobs/:id/verify` — which runs every check against that turn now. A
// verdict's screenshot is one of the job's files and opens in the viewer.
//
// A deliverable of `kind: "app"` (plans/apps.md §6) is a job's APP: it opens
// in place under the cards — the first one already open — through the app
// host, with Reload and "Publish as an app", and reloads by itself when a
// refresh brings a new build hash.

export function JobTimeline(props: {
  job: api.JobView;
  /** Open a run on the canvas, the flyout on `path` when given. */
  onOpenRun: (workflow: string, runId: string, path?: string) => void;
  /** Open a thread's transcript — up to `turn` when given. */
  onOpenThread: (thread: api.JobThread, turn?: api.JobTurn) => void;
  /** Re-read the job — after a verify wrote evidence (and screenshots). */
  onRefresh?: () => void;
  /** A strut link a job's app opened (`ui/open-link`). */
  onNavigate?: (params: Record<string, string>) => void;
  /** A job's app was published to the workspace (the Apps list moved). */
  onAppPublished?: (name: string) => void;
  /** Open a workspace app under Apps. */
  onOpenApp?: (name: string) => void;
}) {
  const { job } = props;
  const threads = job.threads ?? [];
  const totals = useMemo(() => jobTotals(threads), [threads]);
  const [viewing, setViewing] = useState<string | null>(null);
  // The job's proposals (plans/proposals.md): what waits on the person,
  // what they decided; read again after a decision.
  const [proposals, setProposals] = useState<api.Proposal[]>([]);
  const [proposalsKey, setProposalsKey] = useState(0);
  useEffect(() => {
    let alive = true;
    api.getProposals({ job: job.job }).then((r) => alive && setProposals(r.proposals), () => {});
    return () => { alive = false; };
  }, [job.job, job.usedAt, proposalsKey]);
  const [inline, setInline] = useState<string | null>(null);
  // The job's app open under the cards (the first one, by default), and one
  // opened large in the viewer. Kept by id: a refresh brings the newest
  // build of the same app.
  const [appOpen, setAppOpen] = useState<{ id: string; ref: api.ArtifactRef } | null>(null);
  const [appLarge, setAppLarge] = useState<{ title: string; app: api.JobAppRef } | null>(null);
  useEffect(() => {
    const first = job.artifacts.find((a) => a.kind === "app" && a.app);
    setAppOpen(first ? { id: first.id, ref: first } : null);
  }, [job.job]);
  const openAppRef = appOpen ? job.artifacts.find((a) => a.id === appOpen.id && a.app) ?? appOpen.ref : null;

  // Claims: the panel's listing (for the dot), the last Verify, and a key
  // that makes the panel re-read when the ledger or the newest turn moves.
  const [listing, setListing] = useState<api.ClaimsResponse | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState<api.JobVerifyResult | null>(null);
  const [verifyError, setVerifyError] = useState("");
  const [verifies, setVerifies] = useState(0);
  useEffect(() => { setListing(null); setVerified(null); setVerifyError(""); }, [job.job]);
  const turn = newestTurn(job.runs);
  // A Verify's outcomes stand while its turn is the newest; then the ledger's.
  const outcomes = useMemo(
    () => checkOutcomes(verified && verified.runId === turn ? verified.claims : job.claims),
    [verified, turn, job.claims],
  );
  const claimsKey = `${verifies}|${turn ?? ""}|${ledgerSignature(job.claims)}`;
  const verify = async () => {
    setVerifying(true);
    setVerifyError("");
    try {
      setVerified(await api.verifyJob(job.job));
      setVerifies((n) => n + 1);
      props.onRefresh?.();
    } catch (e) {
      setVerifyError((e as Error).message.replace(/^\/[^:]+: /, ""));
    } finally {
      setVerifying(false);
    }
  };
  // Which thread rows are folded shut (open by default, at every depth).
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setClosed((c) => ({ ...c, [id]: !c[id] }));

  /** The version of each deliverable the job points at now. */
  const current = useMemo(() => new Set(job.artifacts.map((a) => `${a.id}\n${a.runId}`)), [job.artifacts]);

  /** Every node any turn touched, with the turns that touched it — the
   *  run flyout's Nodes section over the whole job. */
  const nodes = useMemo<TouchedNode[]>(() => {
    const byRef = new Map<string, TouchedNode>();
    const walk = (ts: api.JobThread[]) => {
      for (const th of ts) for (const t of th.turns) {
        for (const n of t.nodes ?? []) {
          let node = byRef.get(n.ref_id);
          if (!node) byRef.set(n.ref_id, (node = { ref_id: n.ref_id, touches: [] }));
          if (n.node_type) node.node_type = n.node_type;
          if (n.name) node.name = n.name;
          if (n.peer) node.peer = n.peer;
          node.touches.push({ tool: t.label, path: `${t.runId} ${t.path}`, ts: t.at });
        }
        walk(t.spawned);
      }
    };
    walk(threads);
    return [...byRef.values()];
  }, [threads]);

  const openArtifact = (ref: api.ArtifactRef & { runId?: string }) => {
    if (ref.kind === "app" && ref.app) return setAppOpen((o) => (o?.id === ref.id ? null : { id: ref.id, ref }));
    const link = linkOf(ref);
    if (link && isArtifactPath(link)) return setViewing(link);
    if (link) return void window.open(link, "_blank", "noopener");
    if (ref.content !== undefined) setInline((k) => (k === `${ref.id}\n${ref.runId ?? ""}` ? null : `${ref.id}\n${ref.runId ?? ""}`));
  };

  const inlineContent = (() => {
    if (!inline) return null;
    const [id, runId] = inline.split("\n");
    const ref = job.artifacts.find((a) => a.id === id && a.runId === runId) ?? findTurnArtifact(threads, id!, runId!);
    return ref?.content === undefined ? null : ref;
  })();

  return (
    <div class="job-view">
      <div class="job-head">
        <span class="job-title">{job.title ?? job.job}</span>
        {job.title && <span class="job-id">{job.job}</span>}
        {job.busy && <span class="badge badge-warning">running</span>}
      </div>
      <div class="job-meta">
        {job.createdBy && <span>by <b>{displayActor(job.createdBy)}</b></span>}
        {job.createdAt && <span>started <b>{fmtTime(job.createdAt)}</b></span>}
        <span>last <b>{fmtTime(job.usedAt)}</b></span>
        <span><b>{job.runs.length}</b> run{job.runs.length === 1 ? "" : "s"}{job.omittedRuns ? ` (+${job.omittedRuns} older)` : ""}</span>
        <span><b>{threads.length}</b> thread{threads.length === 1 ? "" : "s"}</span>
        <span><b>{totals.toolCalls}</b> tool calls</span>
        <span><b>{formatTokens(totals.usage.outputTokens)}</b> out · <b>{formatTokens(totals.usage.cacheReadTokens)}</b> cached</span>
        <span><b>{fmtCost(totals.cost)}</b></span>
        {job.holds.length > 0 && <span>holds: <b>{job.holds.map((h) => `${h.kind} ${h.id}`).join(", ")}</b></span>}
        {job.repos.length > 0 && <span>repos: <b>{job.repos.join(", ")}</b></span>}
        <span><b>{job.files.length}</b> file{job.files.length === 1 ? "" : "s"}</span>
      </div>

      <div class="job-section">
        <div class="job-section-title">Deliverables</div>
        {job.artifacts.length === 0 && <div class="job-empty">Nothing declared yet.</div>}
        <div class="job-arts">
          {job.artifacts.map((a) => (
            <button key={`${a.id}:${a.runId}`} class="job-art" onClick={() => openArtifact(a)} title={a.peer ? peerArtifactNote(a) : a.summary ?? a.title}>
              <span class="job-art-title"><span class="art-chip-kind">{a.kind}</span> {a.title}</span>
              <span class="job-art-sub">{a.peer ? `on @${a.peer} · ${a.path ?? a.label ?? a.kind}` : a.app ? `${openAppRef?.id === a.id ? "open below" : "open"} · ${a.app.path}` : a.label ?? a.summary ?? `run ${a.runId}`}{a.error ? ` · ${a.error}` : ""}</span>
            </button>
          ))}
        </div>
        {inlineContent && (
          <pre class="flyout-json" style="margin-top:8px;max-height:280px;overflow:auto;">{typeof inlineContent.content === "string" ? inlineContent.content : JSON.stringify(inlineContent.content, null, 2)}</pre>
        )}
        {openAppRef?.app && (
          <JobAppPanel
            key={`${openAppRef.app.job}/${openAppRef.app.path}`}
            title={openAppRef.title}
            app={openAppRef.app}
            onClose={() => setAppOpen(null)}
            onExpand={() => setAppLarge({ title: openAppRef.title, app: openAppRef.app! })}
            {...(props.onNavigate ? { onNavigate: props.onNavigate } : {})}
            {...(props.onOpenApp ? { onOpenApp: props.onOpenApp } : {})}
            {...(props.onAppPublished ? { onPublished: props.onAppPublished } : {})}
          />
        )}
      </div>

      {proposals.length > 0 && (
        <div class="job-section">
          <div class="job-section-title">Proposals</div>
          <ProposalList proposals={proposals} onDecided={() => setProposalsKey((k) => k + 1)} />
        </div>
      )}

      {job.claims && (
        <div class="job-section job-claims">
          <div class="job-section-title job-claims-head">
            <span>
              Claims
              {listing && listing.claims.length > 0 && <span class={`claims-dot claims-dot-${claimsTone(listing)}`} title={claimsTitle(listing)} />}
            </span>
            <button
              type="button"
              class="btn btn-sm"
              disabled={verifying || !turn}
              onClick={verify}
              title={turn ? `Run every check on every claim against the newest turn, ${turn}` : "The job has no turn to verify yet"}
            >{verifying ? "Verifying…" : "Verify"}</button>
          </div>
          {verified && <div class="job-verify-note">{verifySummary(verified)}</div>}
          {verifyError && <div class="claim-error">{verifyError}</div>}
          <ClaimsPanel
            subject={{ kind: "job", name: job.job }}
            onOpenRun={(workflow, runId) => props.onOpenRun(workflow, runId)}
            onLoaded={setListing}
            onViewFile={setViewing}
            outcomes={outcomes}
            reload={claimsKey}
          />
        </div>
      )}

      <div class="job-section">
        <div class="job-section-title">Threads</div>
        {threads.length === 0 && <div class="job-empty">No runs read yet.</div>}
        {threads.map((th) => (
          <ThreadRow
            key={th.id}
            thread={th}
            closed={closed}
            onToggle={toggle}
            current={current}
            onOpenRun={props.onOpenRun}
            onOpenThread={props.onOpenThread}
            onOpenArtifact={openArtifact}
          />
        ))}
      </div>

      {nodes.length > 0 && (
        <div class="job-section">
          <AccessedNodes nodes={nodes} />
        </div>
      )}

      {viewing && <ArtifactViewer path={viewing} onClose={() => setViewing(null)} {...(props.onNavigate ? { onNavigate: props.onNavigate } : {})} />}
      {appLarge && (
        <ArtifactViewer
          path={api.jobAppDocumentPath(appLarge.app.job, appLarge.app.path)}
          app={appLarge.app}
          onClose={() => setAppLarge(null)}
          {...(props.onNavigate ? { onNavigate: props.onNavigate } : {})}
        />
      )}
    </div>
  );
}

function ThreadRow(props: {
  thread: api.JobThread;
  closed: Record<string, boolean>;
  onToggle: (id: string) => void;
  current: Set<string>;
  onOpenRun: (workflow: string, runId: string, path?: string) => void;
  onOpenThread: (thread: api.JobThread, turn?: api.JobTurn) => void;
  onOpenArtifact: (a: api.ArtifactRef & { runId?: string }) => void;
}) {
  const { thread: th } = props;
  const open = !props.closed[th.id];
  const first = th.turns[0];
  const kind = first?.peer ? `peer ${first.peer.id}` : th.session ? `session ${th.id.slice(0, 8)}` : first?.stepType === "run" ? "run" : "one-shot";
  const t = th.totals;
  return (
    <div class="thread">
      <button class="thread-head" onClick={() => props.onToggle(th.id)} aria-expanded={open}>
        <span class={`cat-caret${open ? " is-open" : ""}`}>▸</span>
        <span class="thread-label">{th.label}</span>
        <span class="thread-kind">{kind}</span>
        <span class="thread-totals">
          <span><b>{t.turns}</b> turn{t.turns === 1 ? "" : "s"}</span>
          {t.toolCalls > 0 && <span><b>{t.toolCalls}</b> tools</span>}
          {t.usage.outputTokens > 0 && <span><b>{formatTokens(t.usage.outputTokens)}</b> out</span>}
          {t.usage.cacheReadTokens > 0 && <span><b>{formatTokens(t.usage.cacheReadTokens)}</b> cached</span>}
          {t.cost > 0 && <span><b>{fmtCost(t.cost)}</b></span>}
          {t.context && <span>ctx <b>{formatTokens(t.context.used)}</b>/{formatTokens(t.context.limit)}</span>}
        </span>
      </button>
      {open && (
        <div class="thread-body">
          {th.turns.map((turn) => (
            <div key={`${turn.runId}:${turn.path}`} class="turn">
              <span class="turn-no">{turn.turn != null ? `t${turn.turn}` : turn.peer ? "@" : "·"}</span>
              <div class="turn-row">
                <span class="turn-meta">{fmtTime(turn.at)}</span>
                {turn.peer
                  ? <span class="turn-meta" title={`${turn.peer.workflow} run ${turn.peer.runId} on @${turn.peer.id}`}>run {turn.peer.runId} on @{turn.peer.id}</span>
                  : <button class="turn-run" onClick={() => props.onOpenRun(turn.workflow, turn.runId, turn.stepType === "run" ? undefined : turn.path)} title={`Open run ${turn.runId} of ${turn.workflow}`}>{turn.runId}</button>}
                {turn.workflow !== th.label && turn.stepType !== "run" && <span class="turn-meta">{turn.workflow}</span>}
                {(turn.status !== "success" || turn.peer?.status === "running") && (
                  <span class={`badge badge-${statusTone(turn.peer?.status ?? turn.status)}`}>{turn.peer?.status ?? turn.status}</span>
                )}
                {turn.toolCalls > 0 && <span class="turn-meta">{turn.toolCalls} tool{turn.toolCalls === 1 ? "" : "s"}</span>}
                {turn.durationMs != null && <span class="turn-meta">{fmtDuration(turn.durationMs)}</span>}
                {typeof turn.cost === "number" && <span class="turn-meta">{fmtCost(turn.cost)}</span>}
                {turn.context && <span class="turn-meta">ctx {formatTokens(turn.context.used)}</span>}
                {turn.nodeCount > 0 && <span class="turn-meta">{turn.nodeCount} node{turn.nodeCount === 1 ? "" : "s"}</span>}
                {turn.transcript && <button class="turn-link" onClick={() => props.onOpenThread(th, turn)}>transcript</button>}
              </div>
              {turn.artifacts && turn.artifacts.length > 0 && (
                <div class="turn-arts">
                  {turn.artifacts.map((a) => {
                    const isCurrent = props.current.has(`${a.id}\n${turn.runId}`);
                    return (
                      <button key={a.id} class={`art-chip${isCurrent ? " is-current" : ""}`} onClick={() => props.onOpenArtifact({ ...a, runId: turn.runId })} title={a.peer ? peerArtifactNote(a) : a.summary ?? a.title}>
                        <span class="art-chip-kind">{a.kind}</span>
                        <span class="art-chip-title">{a.title}</span>
                        {a.peer && <span class="art-chip-peer">@{a.peer}</span>}
                        {!isCurrent && <span class="art-chip-old">superseded</span>}
                      </button>
                    );
                  })}
                </div>
              )}
              {turn.spawned.length > 0 && (
                <div class="turn-spawned">
                  {turn.spawned.map((sub) => (
                    <ThreadRow key={sub.id} {...props} thread={sub} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function findTurnArtifact(threads: api.JobThread[], id: string, runId: string): { content?: unknown } | undefined {
  for (const th of threads) for (const t of th.turns) {
    if (t.runId === runId) {
      const a = t.artifacts?.find((x) => x.id === id);
      if (a) return a;
    }
    const deep = findTurnArtifact(t.spawned, id, runId);
    if (deep) return deep;
  }
  return undefined;
}

/** Where a deliverable opens: its url, or a url inside small inline JSON
 *  (a pull request ref carries `{ url, number, state }`). A deliverable
 *  tagged with a `peer` is that strut's: only an absolute link opens from
 *  here, never a path or a strut-relative url (no read-through yet,
 *  plans/federation.md §2.1). */
export function linkOf(ref: { url?: string; content?: unknown; peer?: string }): string | null {
  let link: string | null = null;
  const c = ref.content;
  if (ref.url) link = ref.url;
  else if (typeof c === "string" && c.startsWith("{")) {
    try {
      const o = JSON.parse(c);
      if (o && typeof o.url === "string") link = o.url;
    } catch {}
  } else if (c && typeof c === "object" && typeof (c as { url?: unknown }).url === "string") {
    link = (c as { url: string }).url;
  }
  return link && ref.peer && !/^https?:\/\//.test(link) ? null : link;
}

/** A peer's deliverable's tooltip: where it is, and whether it opens here. */
export function peerArtifactNote(ref: { peer?: string; path?: string; url?: string; content?: unknown }): string {
  const link = linkOf(ref);
  if (link) return `${link} — on @${ref.peer}`;
  if (ref.content !== undefined) return `Inline, from @${ref.peer}`;
  return `${ref.path ?? ref.url} on @${ref.peer} — this strut cannot open it yet`;
}

export function fmtCost(c: number): string {
  if (c === 0) return "$0";
  return c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`;
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function fmtTime(iso: string, seconds = false): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date().toDateString() === d.toDateString();
  const time: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) };
  return today ? d.toLocaleTimeString([], time) : d.toLocaleString([], { month: "short", day: "numeric", ...time });
}
