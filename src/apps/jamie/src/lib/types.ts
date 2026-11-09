// What the page reads, as the steps return it — copied from the server's
// types (src/conversations.ts, src/proposals.ts, src/artifact-refs.ts,
// src/ledger.ts), which a page cannot import. Only the fields it draws.

export interface ConversationListItem {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  status?: string;
  shared?: true;
  forkedFrom?: string;
  archived?: true;
  seenAt?: string;
  unread: boolean;
  running?: true;
  /** The jobs it started or continued, most recent first. */
  jobs?: ConversationJob[];
  /** Jobs past those listed. */
  moreJobs?: number;
  /** Shared, and not the viewer's yet: opening it makes it theirs. */
  team?: true;
  /** Who took its first turn. */
  startedBy?: string;
}

/** A job as a list row shows it. */
export interface ConversationJob {
  job: string;
  title?: string;
  running?: true;
  /** The pull requests it delivered, newest first. */
  prs?: ConversationPr[];
}

/** A pull request a job delivered, as it reported it. */
export interface ConversationPr {
  url: string;
  title?: string;
  /** `owner/name`. */
  repo: string;
  number: number;
  state?: string;
}

/** `conversation/list`. */
export interface ConversationList {
  conversations: ConversationListItem[];
  next?: string;
  /** The actor the list is for: a new conversation is `<viewer>/<id>`. */
  viewer?: string;
}

export interface TurnJob {
  job: string;
  runId: string;
  workflow?: string;
}

export interface WakeMark {
  job: string;
  runId: string;
  peer?: string;
  also?: Array<{ job: string; runId: string; peer?: string }>;
}

export interface CardField {
  label: string;
  value: string;
  kind?: "text" | "code" | "markdown" | "ref";
  danger?: boolean;
}

export interface ProposalCard {
  v: 1;
  title: string;
  summary?: string;
  fields: CardField[];
  actions: { accept: string; reject: string };
  full: boolean;
}

export type ProposalStatus = "pending" | "accepted" | "rejected" | "applied" | "failed";

/** A proposal as a turn lists it (`ProposalBrief`). */
export interface ProposalBrief {
  id: string;
  step: string;
  title: string;
  summary?: string;
  card?: ProposalCard;
  /** Only an admin of this strut server accepts it (installing a package). */
  approver?: "admin";
  status: ProposalStatus;
  url: string;
  rationale?: string;
  createdAt: string;
  decidedAt?: string;
}

/** `proposal/get`: the whole record. */
export interface Proposal extends Omit<ProposalBrief, "url" | "decidedAt"> {
  input: unknown;
  decision?: { action: "accept" | "reject"; by?: string; at: string; reason?: string };
  result?: { output?: unknown; error?: string; at: string };
  /** Whether the page's viewer is an admin here (`proposal/get`, a page's call). */
  viewer?: { admin: boolean };
}

/** A deliverable, resolved (`ArtifactRef`). */
export interface ArtifactRef {
  id: string;
  kind: string;
  title: string;
  label?: string;
  summary?: string;
  url?: string;
  content?: unknown;
  render?: string;
  error?: string;
  peer?: string;
  via?: string;
  job?: string;
  path?: string;
  app?: { name: string; version?: string; hash?: string };
}

/** A job run a wake woke on, and what it delivered. */
export interface Delivery {
  job: string;
  runId: string;
  workflow: string;
  artifacts: ArtifactRef[];
}

export interface ConversationTurn {
  turn: number;
  runId: string;
  workflow: string;
  at: string;
  by?: string;
  status: string;
  prompt?: string;
  wake?: WakeMark | true;
  /** A wake's job runs here, each with what it delivered. */
  delivered?: Delivery[];
  attachments?: Array<{ name: string; mediaType: string; size: number; path?: string }>;
  text?: string;
  ask?: string;
  artifacts?: ArtifactRef[];
  error?: string;
  proposals: ProposalBrief[];
  jobs: TurnJob[];
}

/** `conversation/get`. */
export interface ConversationView {
  conversation: ConversationListItem;
  participants: string[];
  /** Newest first. */
  turns: ConversationTurn[];
  next?: number;
  rev: number;
}

export type LastVerify =
  | { ran: true }
  | { pending: true }
  | { planned: string }
  | { skipped: string; reason?: string };

export interface LedgerClaim {
  id: string;
  text: string;
  status: "supported" | "refuted" | "unknown" | "stale";
  assertedOnly: boolean;
  unverified: number;
  latest?: { content?: string; observed_at?: number; mode?: string; about?: string; locator?: { url?: string; file?: string } };
  checks: Array<{ id: string; name: string; external?: true; lastVerify?: LastVerify }>;
}

/** `job/get`: what the cards read. */
export interface JobView {
  job: string;
  title?: string;
  workflow?: string;
  busy?: unknown;
  actors?: string[];
  runs: Array<{ workflow: string; runId: string; status: string; at?: string; parentRunId?: string; durationMs?: number; error?: string }>;
  artifacts?: Array<ArtifactRef & { runId?: string }>;
  text?: string;
  claims?: LedgerClaim[] | null;
  urls?: Record<string, string>;
}

/** `run/get`: a run's summary. */
export interface RunSummary {
  runId: string;
  workflow?: string;
  status: string;
  output?: unknown;
  error?: { message: string } | string;
  durationMs?: number;
  artifacts?: ArtifactRef[];
  job?: string;
  title?: string;
}

/** `llm/models`. */
export interface ModelCatalog {
  default: string;
  models: Array<{ name: string; provider: string; modelId: string; alias?: string; default: boolean; available: boolean }>;
}
