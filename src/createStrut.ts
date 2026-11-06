import { Hono, type Context } from "hono";
import { logger } from "hono/logger";
import { compress } from "hono/compress";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import { serve } from "@hono/node-server";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AnyStepDef, Flow, McpServer, PeerOpen, RunAttachment, StepRegistry, RunEvent, RunResult, RunSummary, StepContext } from "./core.js";
import type { RunStore } from "./store.js";
import { FileRunStore, MemoryRunStore, countSteps, generateRunId, summarizeFromEvents } from "./store.js";
import type { ChatStore, ChatEvent, ChatMeta } from "./chat-store.js";
import {
  FileChatStore,
  MemoryChatStore,
  generateChatId,
  capToolOutput,
  toolResultMaxCharsFromEnv,
  truncateToolMessages,
} from "./chat-store.js";
import { CHAT_RETAIN, cachedSystem, compactAtFromEnv, compactionMessage, overMark, resultCapChars, summarize } from "./compaction.js";
import { createDrain, DrainingError, parseDrainBody } from "./drain.js";
import { assertWorkflowEnabled, workflowDisabled, FileWorkspaceStore, claimsBlockOf, readClaimsBlock, type PublishOptions, type WorkspaceStore } from "./workspace.js";
import type { InputBlock } from "./input-block.js";
import { buildRegistry, resolveStep } from "./steps/registry.js";
import { parseStepRef } from "./step-ref.js";
import { zodToFields } from "./ai/schemaHelpers.js";
import { resolveModel, listModelOptions, defaultModel, createWebTools, type LlmAuth } from "./llm.js";
import type { StepSources } from "./steps/registry.js";
import { runWorkflow, settleUnfinishedRun, summaryFromLog } from "./runner.js";
import { RunController } from "./run-control.js";
import { buildJournal, changedSteps, invalidateFrom, invalidateSteps, readRunStart } from "./journal.js";
import { appIdentity, publicAppIdentity, publicAppOfIdentity, carriesApiKey, carriesPeerKey, carriesFileToken, carriesBadFileToken, catalogToken, catalogTokenOf, CATALOG_TOKEN_DAYS, publicPackageRead, fileToken, warnIfUnconfigured, channelTicket, channelTicketOf, actorFromHeader, inProcessOf, inProcessRequest, scopeFromKey, isPeerScope, isRole, memberOf, personOf, personToken, PERSON_TOKEN_DAYS, unauthorized, issueSession, redeemSignInTicket, signInTicket, sessionCookie, sessionOf, isSecureRequest, type Scope } from "./auth.js";
import { standardServices, fileArtifactsCapability } from "./capabilities.js";
import type { ArtifactsCapability, SecretsCapability } from "./capabilities.js";
import type { SecretStore } from "./secret-store.js";
import {
  FileSessionStore,
  MemorySessionStore,
  PEER_NAMESPACE,
  appSessionId,
  idProblem,
  peerSessionId,
  sessionInfo,
  sessionsCapability,
  type SessionStore,
} from "./session-store.js";
import {
  FileSecretStore,
  MemorySecretStore,
  isValidSecretName,
  secretBlanks,
} from "./secret-store.js";
import { runStep, cassettePath, RUN_STEP_FLOW } from "./run-step.js";
import { buildProvenance } from "./provenance.js";
import { RUN_GET_MAX_WAIT_MS, RUN_LIST_DEFAULT_LIMIT, RUN_LIST_MAX_LIMIT, RUN_LIST_SCAN_MAX, capEvents, capTranscript, fileResult, launchedAt, listEntryOf, matchesRunFilter, runsPage, sinceMs, type RunCaller, type RunListEntry, type RunTranscript, type RunsCapability } from "./runs.js";
import { isFirstParty, type AppRef, type StartedBy, type WakeMark } from "./core.js";
import { WAKE_MAX, artifactsOf, createWakes, parseWakeDoor, replyOf, type WakeEnd, type WakeOutcome } from "./wake.js";
import { createConversations, isConversationFlow, outsideConversations, type ConversationViewer } from "./conversations.js";
import { createVerifier, type Verifier, type VerifyResult } from "./verify.js";
import { CLAIMS_OFF, type ClaimsBlock } from "./claims-schemas.js";
import { PERSON, claimsRoutes } from "./claims-routes.js";
import { automationsRoutes } from "./automations-routes.js";
import { createAutomations, type Automations } from "./scheduler.js";
import { AUTOMATION_CALLBACKS_FILE } from "./automations.js";
import { createVerifyWaker, type VerifyWaker } from "./ai/verify-waker.js";
import type { RunEndInfo } from "./runner.js";
import { ACTOR_SECRETS_FILE, actorSecretStore, type ActorSecretStore } from "./actor-secrets.js";
import { seedJobWorkflow, type JobSeedOptions } from "./job-seed.js";
import { PERSONAL_CONCEPTS, PERSONAL_ROOT, STRUT_CONCEPTS, seedConcepts } from "./concept-seed.js";
import { builderSystem } from "./ai/builder-system.js";
import { seedOrchestratorWorkflow, type OrchestratorSeedOptions } from "./orchestrator-seed.js";
import { seedBuilderWorkflow, type BuilderSeedOptions } from "./builder-seed.js";
import { installSystemWorkflows } from "./system-workflows.js";
import { PEERS_FILE, checkPeer, checkSelf, parsePeersEnv, parseSelfEnv, peerIdProblem, peerInfo, peerStore, peersCapability, type Peer, type SelfInfo } from "./peers.js";
import { globToRegExp, grantWidenedBy, stepHashesFor } from "./closure.js";
import { stepStats } from "./step-stats.js";
import { AI_PUBLISHER, buildAuthoringCapability } from "./authoring.js";
import type { ReachPolicy } from "./reach.js";
import { appErrors, createApps, type AppsCapability, type AppPublishResult } from "./apps/apps.js";
import { fileAppGrants } from "./apps/grants.js";
import { createAppMonitor, type AppMonitor } from "./apps/monitor.js";
import { seedViewsApp } from "./apps/views-seed.js";
import { RETIRED_APP, seedJamieApp } from "./apps/jamie-seed.js";
import { seedKnowledgeApp } from "./apps/knowledge-seed.js";
import type { KitLocation } from "./apps/kit.js";
import { appsRoot, isPreviewLabel, listAppFiles, readAppFile, reservedAppName, validateAppName, writeAppFiles } from "./apps/files.js";
import { DOCUMENT_FILE, readBuildInfo, withPublicIdentity, withToken, withoutTokenMeta } from "./apps/build.js";
import { packArchive } from "./packages/archive.js";
import { buildPackage, type BuildRequest } from "./packages/build.js";
import { PUBLISHER_FILE, PUBLISHER_NAME, catalogStore, moveChannel, publicCatalogStore, publishRelease, publisherStore } from "./packages/publisher.js";
import { SUBSCRIPTIONS_FILE, createSubscriptions, subscriptionProblem, type Subscription, type Subscriptions } from "./packages/subscriptions.js";
import { createPackageIndex, indexDir, indexRowProblem, liveRowProblem, type PackageIndex } from "./packages/index.js";
import { INDEXES_FILE, createIndexes, indexSubscriptionProblem, parseIndexesEnv, type IndexSubscription, type PackageIndexes, type PackagesCapability } from "./packages/indexes.js";
import type { IndexLiveRow, IndexRow } from "./packages/card.js";
import { packageCache } from "./packages/cache.js";
import { workspaceFences } from "./packages/fence.js";
import { PACKAGE_DIGEST, PACKAGE_NAME } from "./packages/format.js";
import {
  installPackage,
  installPackages,
  uninstallPackage,
  type InstallOptions,
  type InstallResult,
  type PackageDeps,
  type PackageDoor,
  type UninstallResult,
} from "./packages/install.js";
import { listInstalledPackages } from "./packages/installed.js";
import { checkBootPackages, installBootPackages, parseBootPackagesEnv, type BootPackage, type BootPackageOutcome } from "./packages/boot.js";
import type { AppRelease, Upstream } from "./workspace.js";
import type { CassetteMode } from "./cassette.js";
// Type-only: the graph backend stays a lazy, opt-in dependency.
import type { GraphBackend } from "./graph/backend.js";
import { graphView, mayQueryRaw, readerFor, listFor, type GraphReaders } from "./graph/scope.js";
import { projectChatOnce, projectProposalOnce, projectRunOnce, type ConversationReader } from "./graph/projector.js";
import { createGraphChangeFeed, GRAPH_FEED_READ_MAX } from "./graph-writes.js";
// No runtime graph dependency in here either (type-only imports inside).
import type { ClaimsReader } from "./graph/claims.js";
import { buildClaimsAuthoring, type ClaimsReconcileOutcome } from "./claims-authoring.js";
import { createStt, type SttService } from "./audio/stt.js";
import { createTts, type TtsService } from "./audio/tts.js";
import { audioRoutes, speakRoutes } from "./audio/routes.js";
import { readLexicon } from "./steps/lib/dictation/_shared.js";
import { onLadybug } from "./steps/lib/dictation/_graph.js";
import { createAudioUpgradeHandler } from "./audio/ws.js";
import { roomsFor } from "./rooms.js";
import { createChannels, type ChannelApp, type Channels, type ChannelTransport } from "./channels.js";
import { pipeChannelToPeer } from "./channels-peer.js";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { STATUS_CODES, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { bootEnv } from "./env.js";
import { fmtBytes, positiveBytes } from "./output-cap.js";
import { installEscapeGuard } from "./escaped-errors.js";
import { lintStepSource } from "./step-lint.js";
// Static import is safe: notifier depends only on chat-store, never the AI
// SDK (which stays lazy-loaded inside launchChatTurn).
import { createChatNotifier, formatRestartNotification, formatRunNotification } from "./ai/notifier.js";
import { createTurnCallbacks, finalAssistantText } from "./ai/turn-callback.js";
import { attachmentParts, parseAttachments, saveAttachments, saveRunAttachments, type Attachment } from "./ai/attachments.js";
import { callbackOrigin, parseCallback, parseLaunchCallback, postCallback, roomActorOf, roomTarget } from "./callback.js";
import { createEventsSink, parseSinkUrl, type EventsSink } from "./events-sink.js";
import { listServerTools, parseMcpServers } from "./mcp-servers.js";
import { fileMcpRegistry, gatedByDefault, mcpStepDef, parseRegistration, resolveRegistration, type McpRegistration } from "./mcp-registry.js";
import { PROPOSAL_FEED_READ_MAX, createProposalFeed } from "./proposal-feed.js";
import { briefOf, decideProposal, visibleTo, listProposals, proposalsCapability, proposalsRoot, readProposal, type Decision, type Proposal, type ProposalsCapability, type ProposalStatus } from "./proposals.js";
import type { AssistantChatDoor } from "./ai/assistant-tools.js";
import { shellCapability, type ShellCapability } from "./capabilities.js";
import { JOB_WORKFLOWS, deleteJob, jobFilePath, jobRoot, jobsCapability, listJobFiles, readJobRecord, releaseWith, setJobCallback, turnOf, wakeJobFeeds, type JobsCapability } from "./jobs.js";
import { createJobIndex } from "./job-index.js";
import { transcriptUrl } from "./job-threads.js";
import { resolveArtifactRefs, type ArtifactRef } from "./artifact-refs.js";
import { searchWorkflows } from "./search.js";
import type { AutomationStepsCapability, AutomationStepsOptions } from "./steps/lib/automation/_shared.js";
import { BrowserService } from "./browser/service.js";
import { seedBrowserWorkflows } from "./browser/seed.js";
import "./privacy/register.js";
import { seedPrivacyWorkflows } from "./privacy/seed.js";
import { HOME_POSTS, homeSyncRole, homeSyncRoutes, seedHomeSyncWorkflow, type HomeSyncRole } from "./home-sync.js";
import { VOICE_CALLS, voiceConfig, voiceRoutes, warmSpeech, type VoiceConfig } from "./voice.js";
import { createPublicSurface, normalizeSurface, surfaceProblem, visitorRefusal, visitorRuns, type PublicSurface } from "./public-surface.js";
import { brandProblem, brandStyles, normalizeBrand, readBrand, writeBrand } from "./brand.js";
import { PUBLIC_PATH, publicRoutes, visitorAddress } from "./public-routes.js";
import { publicViewNeeds } from "./public-view.js";
// Pure (node:crypto only): the ask/answer shapes behind the two elicitation
// tools and endpoints — plans/elicitation.md.
import {
  ELICITATION_ACTIONS,
  callbackElicitation,
  formatElicitationResponse,
  newElicitationId,
  renderElicitationText,
  secretUrl,
  stepAsked,
  validateContent,
  type ElicitationAction,
  type ElicitationRecord,
  type ElicitationRequest,
} from "./ai/elicitation.js";

// ── Public types ───────────────────────────────────────────────────────────

/**
 * Options for constructing a Strut instance. Everything is optional — pass
 * nothing for the default "filesystem-backed server" behavior, or supply
 * any subset to embed strut in your own app.
 */
export interface StrutOptions<TServices = unknown> {
  /** Persistent store for workflows and steps. Defaults to a new
   *  `FileWorkspaceStore()` (reads `STRUT_WORKSPACE` env, falls back to
   *  `./workspace`). Any `WorkspaceStore` implementation works. */
  workspace?: WorkspaceStore;

  /** Where the app KIT is (plans/apps.md §3; `src/apps/kit.ts`): the vendor
   *  layer app builds resolve against. Default: `@strut/kit` when pinned,
   *  else the repo's `kit/` — read at the first build, so a strut without a
   *  built kit boots and the build says what is missing. */
  kit?: KitLocation;

  /** Local directory for the inherently-local things: run artifacts,
   *  step cassettes, the chat builder's shell cwd + scratch/. Defaults to
   *  the file workspace's root (so a file-backed deployment keeps one
   *  directory), else `STRUT_WORKSPACE` / `./workspace`. A non-file
   *  workspace can point this at any scratch volume — losing it loses
   *  blobs and cassettes, never workspace records. */
  dataDir?: string;

  /** Step registry. If supplied, used as-is and `rebuildRegistry` becomes
   *  a no-op (the consumer owns step composition). If omitted, strut
   *  discovers steps via `buildRegistry(await workspace.materializeCustomSteps())`. */
  registry?: StepRegistry;

  /** Where to persist run events + summaries. Defaults to a `FileRunStore`
   *  rooted at the workspace path. Pass `new MemoryRunStore()` for
   *  ephemeral / test environments. */
  store?: RunStore;

  /** Consumer-defined capabilities bag exposed to every step via
   *  `ctx.services`. Use this to inject environment-specific
   *  implementations (Neo4j vs in-memory store, real vs fake LLM, …)
   *  without changing the workflow or registry. */
  services?: TServices;

  /** When true, mount the static web UI under `/` (SPA fallback) and
   *  `/assets/*`. Defaults to true. Disable when embedding strut under a
   *  larger app that owns its own UI routes. */
  serveUi?: boolean;

  /** Mount the `POST /chat` AI workflow-builder endpoint. Defaults to
   *  true; disable to avoid pulling in the `ai`/`@ai-sdk/anthropic` deps. */
  enableChat?: boolean;

  /** Mount strut's MCP doors (src/ai/mcp.ts) for an external agent (Claude
   *  Code, Hermes): `POST /mcp`, the ASSISTANT set (src/ai/assistant-tools.ts
   *  — talk to the workflow builder, read its chats, list and run workflows,
   *  read runs), and `POST /mcp/builder`, the builder's own tools — the same
   *  ones the chat's model gets. Behind the gate like every route. Defaults
   *  to `enableChat`; with the chat off, `/mcp` serves the builder set. */
  enableMcp?: boolean;

  /** This server's public base URL, for links handed to a caller OUTSIDE
   *  the UI — the MCP door's artifact links (absolute, with their read
   *  token) and `ui` deep links. Defaults to the request's own origin
   *  (`x-forwarded-proto` / `x-forwarded-host` honored). `STRUT_PUBLIC_URL`
   *  on the default server. */
  publicUrl?: string;

  /** Where to persist chat sessions (the detached AI-builder background jobs:
   *  `messages.jsonl` + `events.jsonl` + `meta.json`). Defaults to a
   *  `FileChatStore` rooted at the workspace path (or `MemoryChatStore` when
   *  `store` is a `MemoryRunStore`). */
  chatStore?: ChatStore;

  /** Where agent sessions live (session-store.ts; plans/agent-sessions.md):
   *  the threads an `agent` step with `session` set continues. Defaults by
   *  the CHAT store's kind — files under dataDir when chats are on disk
   *  (passed or defaulted), memory otherwise — so a host that keeps chats
   *  across restarts keeps sessions too. */
  sessionStore?: SessionStore;

  /** Deployment-scoped secret store backing `ctx.services.secrets` and the
   *  `/secrets` admin endpoints. Defaults to an encrypted `FileSecretStore`
   *  rooted at the workspace path (or `MemorySecretStore` when `store` is a
   *  `MemoryRunStore`). The default `secrets` capability reads this store with
   *  `process.env` as fallback. Pass your own `services.secrets` to bypass
   *  entirely (then the `/secrets` endpoints return 501). */
  secretStore?: SecretStore;

  /** Per-actor secrets (actor-secrets.ts; plans/code-change.md §3.2), the
   *  store behind `/actors/:actor/secrets` and the runner's per-principal
   *  binding of `ctx.services.secrets`. Defaults by the resolved
   *  `secretStore`'s kind (NOT the workspace's): when that is a
   *  `FileSecretStore` — passed or defaulted — an encrypted
   *  `actor-secrets.json` under dataDir beside `secrets.json`; memory
   *  otherwise. So a graph-workspace host that keeps its deployment
   *  secrets on disk keeps actor secrets across restarts too. */
  actorSecretStore?: SecretStore;

  /** The peer records (peers.ts; plans/federation.md §3) — the struts this
   *  one may call through `ctx.services.peers` and `strut/run-workflow`,
   *  behind `PUT/DELETE/GET /peers`. Defaults like `actorSecretStore`: an
   *  encrypted `peers.json` beside `secrets.json` when the deployment's
   *  secrets are on disk, memory otherwise. */
  peerStore?: SecretStore;
  /** Peers to put on file at boot, beside `STRUT_PEERS` — the paste door
   *  for a strut nobody pushes to (a desktop host, a test). Each replaces
   *  the record of the same id. */
  peers?: Peer[];
  /** Package INDEXES to follow (src/packages/indexes.ts; plans/marketplace.md
   *  §7), put on file at boot after `STRUT_PACKAGE_INDEXES` (else the
   *  built-in defaults) — each `{ id, key, urls, label? }` replaces the
   *  record of the same id. A bare package name installs through them. */
  packageIndexes?: IndexSubscription[];
  /** Packages installed at FIRST BOOT (src/packages/boot.ts), after
   *  `STRUT_PACKAGES` — each `{ ref, url?, digest? }`, what `POST
   *  /packages/install` takes. A listed package not installed here is
   *  installed in the background once the boot is done; one already here,
   *  at any digest, is left alone. A bad entry fails the boot; a failed
   *  install is a warning, tried again next boot. */
  packages?: BootPackage[];
  /** This strut's OWN workspace — `{ id?, label?, description?, repos? }`,
   *  what `strut/list-peers` reports as `self` so an agent knows which repos
   *  are here. Seeded at boot after `STRUT_SELF` (this wins); `PUT /self` is
   *  the same door. No baseUrl or token: nothing is dispatched to self. */
  self?: SelfInfo;
  /** The events sink (src/events-sink.ts; `STRUT_EVENTS_SINK` for the
   *  default server): every run's events — the ENVELOPE only, never a
   *  step's input, output or transcript — batched and POSTed to this one
   *  URL as `{ event: "run.events", events }`. Telemetry for a listener set
   *  once: nothing in a run waits on a delivery, and one that fails is
   *  dropped. A URL that is not http(s) fails the boot. */
  eventsSink?: { url: string };

  /** Max agent steps (tool-call iterations) per chat turn. Raise for longer
   *  autonomous "let it rip" loops. Defaults to `STRUT_CHAT_MAX_STEPS` or 100. */
  chatMaxSteps?: number;

  /** Default model for the chat agent — any aieo model name: an alias
   *  (`sonnet`, `gpt`, `kimi`), a full id, or `provider/id` (OpenRouter as
   *  `openrouter/org/model`). A per-chat pick (`POST /chat { model }`, the
   *  flyout's picker) overrides it, and `STRUT_DEFAULT_MODEL` (secret store,
   *  then env, read each turn) comes before it. Defaults to
   *  `STRUT_CHAT_MODEL` or `claude-sonnet-5-5`. */
  chatModel?: string;

  /** The host's section of the builder's system prompt: called once per
   *  CHAT, when its first turn renders the prompt, and its text appended
   *  verbatim after strut's own rules (before the steps tree). The prompt is
   *  then replayed as-is for the chat's life (it heads the cached prefix), so
   *  an edit reaches new chats only. For what the DEPLOYMENT knows and strut
   *  does not — the kinds of thing built here and their conventions; mcp
   *  renders it from its knowledge graph. Nothing returned, or a throw
   *  (logged) → the prompt is strut's alone: a turn never fails on it.
   *  Default, with a graph: the `Workflow Builder` Concept's page and the
   *  kinds under it (src/ai/builder-system.ts); a hook passed here replaces
   *  it. */
  chatSystem?: (ctx: { chatId: string; turn: number; actor?: string }) => string | undefined | Promise<string | undefined>;

  /** How long the chat agent's `run_workflow` tool waits before a still-
   *  running workflow converts to a DETACHED run (the tool returns a
   *  `{ status: "running", runId }` stub and the chat is woken with a
   *  `[run-notification]` message when the run settles). Defaults to
   *  `STRUT_CHAT_RUN_WAIT_MS` or 60000. */
  chatRunWaitMs?: number;

  /** Max consecutive notification-triggered chat turns since the last human
   *  message before the chat PARKS (notifications still append to the
   *  transcript, but no turn launches until a human replies) — the runaway
   *  guard for autonomous launch→wake→relaunch loops. Defaults to
   *  `STRUT_CHAT_MAX_AUTO_TURNS` or 10. */
  chatMaxAutoTurns?: number;

  /** Boot-time auto-resume of runs cut off by a crash/restart
   *  (RUN_CONTROL_SPEC §5.3). Defaults to ON whenever the RUN STORE outlives
   *  the process — anything but `MemoryRunStore`, whatever the workspace's
   *  kind — unless `STRUT_AUTO_RESUME=0`; pass `false` to disable, or an
   *  object to tune the guards. Every root run the last death cut off is
   *  considered (`AutoResumeOptions.since`, from `<dataDir>/boot.json`). */
  autoResume?: boolean | AutoResumeOptions;

  /** The largest run log a durable resume will READ, in bytes — boot-time
   *  auto-resume and `POST …/resume` alike: a log past it is skipped (one
   *  line) or refused (413) by its size, never loaded. A run's log is read
   *  whole to replay its journal, and a step that returns megabytes writes
   *  a log the serving process cannot hold (swarm38, 2026-10-30: a 139 MB
   *  log replayed at every boot crashed the process each time). Default
   *  `STRUT_RESUME_MAX_LOG_BYTES` or 64 MB. */
  resumeMaxLogBytes?: number;

  /** Listen for uncaught exceptions and unhandled rejections in this
   *  process (src/escaped-errors.ts): an error a step lets escape — thrown in
   *  a callback, or from a promise it never awaits — fails that step instead
   *  of ending the process, and one no step owns is logged. Without it Node
   *  exits, every run in flight is cut off, and boot's auto-resume replays
   *  the run into the same crash. Default on; `false` for a host that keeps
   *  its own handlers and wants nothing added (an escaped error then ends
   *  the process as before, unless the host's handler says otherwise). */
  escapeGuard?: boolean;

  /** The automations tick loop (plans/automations.md §6): fires scheduled
   *  workflows from inside this process. Defaults to ON unless
   *  `STRUT_SCHEDULER=0`. Pass `false` for a host that owns the clock itself
   *  — `strut.automations` still stores, previews and fires on demand
   *  (`fire`), it just never ticks. Single-process by design: two strut
   *  processes over one workspace would each fire. */
  scheduler?: boolean;

  /** How often each package subscription reads its catalog
   *  (plans/marketplace.md §12.1), in minutes: `STRUT_DISTRO_POLL_MINUTES`,
   *  default 10; `0` = at boot only; `false` = never by itself (only on a
   *  ping, a `PUT`, or `strut.subscriptions.sync`). */
  subscriptionPoll?: number | false;

  /** The claims layer (plans/claims.md): claims, checks, the verify pass, the
   *  claim tools and the Claims panel. Needs a graph-backed workspace; there
   *  it defaults to ON unless `STRUT_CLAIMS=0`. Pass `false` to turn the
   *  whole layer off — `strut.claims` / `strut.verifier` are null, no claim
   *  tool or `claims` arg is offered, the prompt has no claims section, no
   *  run is verified and the panel hides itself. */
  claims?: boolean;

  /** The `job` workflow strut ships (plans/jobs.md §5; `src/job-seed.ts`),
   *  seeded into the workspace at boot by content hash: a changed template
   *  publishes and activates the next version, an unchanged one leaves a
   *  workspace-side edit active. `{ tools, system }` is the HOST's delta —
   *  grants appended to `params.tools` (the lab's `pod/*`), a section
   *  appended to the agent's system prompt after strut's — the twin of
   *  `chatSystem`; the merged text is what is hashed. `false` seeds nothing. */
  job?: false | JobSeedOptions;
  /** The Concept pages strut ships (src/concepts/; `src/concept-seed.ts`):
   *  `Workflow Builder`, which the builder's prompt reads, and `Job`, which
   *  the job workflow puts in its agent's prompt — seeded at boot on a graph, each
   *  reconciled by its source stamp, and like every seed it always matches
   *  git: each boot puts the file's text back over an edit made in the
   *  graph. A host seeds its own pages under them with
   *  `seedConcepts` once this returned. `false` seeds nothing.
   *  `{ personal: true }` also seeds `Personal`, the root of a person's
   *  own knowledge (`PERSONAL_CONCEPTS`), for a host whose graph is one
   *  person's. */
  concepts?: false | { personal?: boolean };
  /** The `orchestrator` workflow strut ships (`src/orchestrator-seed.ts`):
   *  one conversation turn that answers with its tools and starts jobs
   *  detached. Seeded as `job` is, with the same host delta (`{ tools,
   *  system }`, appended after strut's). `false` seeds nothing. */
  orchestrator?: false | OrchestratorSeedOptions;
  /** The `builder` workflow strut ships (`src/builder-seed.ts`,
   *  plans/builder-job.md): one turn of a WORKFLOW BUILD as a job — the
   *  meta/* authoring twins as its agent's tools, the web tools as its only
   *  built-ins, the `Workflow Builder` page in its prompt — `peer: true`,
   *  so another strut may launch it as published. Seeded as `job` is, with
   *  the same host delta plus `peer: false` to close it to peers, and
   *  `reach`: what a workflow it publishes may touch, and no step code
   *  (src/reach.ts; none set = no limit, as before). `false` seeds nothing. */
  builder?: false | BuilderSeedOptions;
  /** `strut/views` (`src/apps/views-seed.ts`, plans/apps.md §3.3): strut's
   *  own components — RunTimeline, RunGraph, LaunchForm, … — as an app other
   *  apps import, its page the gallery. Seeded at boot by tree hash, as `job`
   *  is by content hash, when the kit is built. `false` seeds nothing. */
  views?: false;
  /** `strut/jamie` (`src/apps/jamie-seed.ts`, plans/jamie-app.md §5): Jamie,
   *  the person's assistant — the `orchestrator`'s conversations, their jobs,
   *  proposals, pull requests and deliverables — as a first-party app,
   *  seeded at boot after `strut/views` (it imports it; none without it).
   *  `false` seeds nothing. */
  jamie?: false;
  /** `strut/knowledge` (`src/apps/knowledge-seed.ts`, plans/knowledge-app.md):
   *  the organisation's Concept tree and graph, as a first-party app, seeded
   *  at boot after `strut/views` (it imports it; none without it). `false`
   *  seeds nothing. */
  knowledge?: false;
  /** The `automation/*` steps (src/steps/lib/automation/), an agent's own
   *  door onto the automations: the one workflow they schedule, and the
   *  registry step that asks the person before one is made, changed,
   *  deleted or run (`{ intent }` → `{ approved }`, or a `withStop`
   *  output while nobody has answered). Absent: the steps refuse. */
  automation?: AutomationStepsOptions;
  /** The built-in automations strut ships (src/system-workflows.ts),
   *  installed at boot with their automations off. `false` installs none. */
  systemWorkflows?: false;
  /** The browser workflows strut ships beside the `browser/*` steps
   *  (src/browser/seed.ts: browser-capture, browser-explore, browser-watch),
   *  seeded at boot by content hash like `job`. `false` seeds none. */
  browserWorkflows?: false;
  /** The `private-ask` workflow strut ships beside the privacy/* steps
   *  (src/privacy/seed.ts), seeded at boot by content hash. `false` seeds none. */
  privacyWorkflows?: false;
  /** Home sync (src/home-sync.ts, AGENTS.md "Home sync"): `"box"` serves
   *  `POST /home/pull` and `/home/push` to a person's credential, so a strut
   *  that keeps a read copy of this memory can sync with it (on, it hands
   *  the whole memory to any person token this strut minted); `"copy"`
   *  seeds the `home-sync` workflow that copy runs. Off unless set, or
   *  STRUT_HOME_SYNC=box | copy. */
  homeSync?: HomeSyncRole;

  /** The voice service beside this strut (src/voice.ts,
   *  plans/private-voice.md §4.1): `POST /voice/calls` forwards a person's
   *  call set-up to `<url>/calls` as that person, with `token` as the
   *  bearer, and answers what it answers. Wins over STRUT_VOICE_URL +
   *  STRUT_VOICE_TOKEN; `false` turns it off. Unset, the route is a 503. */
  voice?: VoiceConfig | false;

  /** The package INDEX role (plans/marketplace.md §7, step 7;
   *  src/packages/index.ts): this strut as the phone book — a signed card
   *  of publisher rows, `PUT /index/:prefix`, served to anyone at `GET
   *  /index/catalog` — and the crawler behind it, which follows every
   *  listed publisher's public catalog and serves `GET /index/packages?q=`
   *  and `GET /index/packages/:publisher/:name`, open to anyone. `true`, or
   *  `{ urls }` — where this index's catalog is served, written into every
   *  card. Off unless set, or STRUT_INDEX=1 (STRUT_INDEX_URLS, a JSON list). */
  index?: boolean | { urls?: string[] };

  /** The strut graph backend, when the deployment has one. Default: the one
   *  behind a graph-backed workspace (`workspace.graph`), so the default
   *  server need not pass it; a host wiring a graph beside a filesystem
   *  workspace does. It is `ctx.services.graph` for the `graph/*` steps,
   *  the chat builder's read-only `graph_query` (+ `graph_get`), and the
   *  `/graph/*` reads; without one none of those is offered. */
  graph?: GraphBackend;

  /** Who may read which namespaces of the graph (src/graph/scope.ts,
   *  plans/graph-memory-plan.md step 6): a list per reader — `assistant`
   *  (with its `workflows`), `builder`, `jobs`, `apps`, `peers`, `ui` —
   *  each `{ namespaces, exclude_domains? }`. Unset: every reader reads
   *  everything, as before. Set: a reader it leaves out reads nothing.
   *  `STRUT_HOST_CONFIG`'s `graphReaders` (src/server.ts). */
  graphReaders?: GraphReaders;

  /** Accepted and ignored: the assistant's memory is always the workspace
   *  graph (plans/graph-memory-plan.md step 7). Kept so a host config that
   *  still says `memory: "graph"` starts. */
  memory?: "graph";

  /** Directory containing the built web UI (the `dist` folder). Defaults
   *  to strut's own bundled UI resolved relative to this module, so it
   *  works regardless of the host process's CWD. The built UI uses
   *  relative asset paths, so it can be mounted at any sub-path (e.g.
   *  `/lab`) as long as the host serves it with a trailing slash. */
  webDist?: string;

  /** Speech-to-text (src/audio): the `/audio/*` routes, the `/audio/stream`
   *  WebSocket (attached by `listen()`), and `ctx.services.stt`. Defaults
   *  to a service rooted at `dataDir` with models under `STRUT_MODEL_DIR`;
   *  pass your own, or `false` to mount nothing. The sherpa addon is an
   *  optionalDependency loaded on first use, so the default costs nothing
   *  at boot and the routes answer 501 without it. */
  stt?: SttService | false;

  /** Text-to-speech (src/audio/tts.ts): `POST /audio/speak` and its listing,
   *  Kokoro through the same optional sherpa addon, in a worker thread of
   *  its own. Defaults to a service with models under `STRUT_MODEL_DIR`;
   *  pass your own, or `false` to mount nothing. Nothing loads until the
   *  first speech, and without the addon the route answers 501. */
  tts?: TtsService | false;

  /** Where an LLM call goes and how it is attributed (plans/mothership-
   *  cost-control.md §1): consulted by the `agent`/`llm` steps and the chat
   *  turn before a model client is built. `undefined` from the hook = call
   *  the provider directly with the secrets boundary's key, as always.
   *  Placed on the services bag as `llmAuth`. Omit and nothing changes. */
  llmAuth?: LlmAuth;
  settings?: Record<string, unknown>;

  /** Who is making this request (§2) — an opaque string strut stores and
   *  forwards, never interprets: the workflow owner stamp, the run's `actor`,
   *  and (with `llmAuth`) who the spend is billed to. The host decides per
   *  request: mcp reads its verified JWT. Default: the `x-strut-actor`
   *  header, honored only alongside a configured, matching `STRUT_API_KEY`. */
  resolveActor?: (c: Context) => string | undefined | Promise<string | undefined>;

  /** What this request may do (plans/federation.md §3), the twin of
   *  `resolveActor`: `"full"`, or `"peer"` — another strut, which may read
   *  every route, launch a run, and cancel / pause / resume a run a peer
   *  launched; everything else answers 403. Asked by the one gate, after the
   *  request has a credential; `undefined` is `"full"`. mcp maps its JWT's
   *  scope. Default: `"peer"` for a request carrying `STRUT_PEER_KEY`
   *  (`scopeFromKey`), else `"full"`. */
  resolveScope?: (c: Context) => Scope | undefined | Promise<Scope | undefined>;
}

/** `STRUT_RESUME_MAX_LOG_BYTES` unset: 64 MB (`StrutOptions.resumeMaxLogBytes`). */
export const DEFAULT_RESUME_MAX_LOG_BYTES = 64 * 1024 * 1024;

/** How far a log's mtime may lag its last event: some filesystems (HFS+,
 *  FAT) keep mtimes to the second or two. The boot scan skips a run by its
 *  mtime only when it is older than `since` by more than this. */
const LOG_MTIME_SLACK_MS = 2_000;

export interface AutoResumeOptions {
  /** Ignore cut-off runs whose last event is older than this. Default 7 days. */
  maxAgeMs?: number;
  /** Give up on a run that has already been resumed this many times — a step
   *  that deterministically kills the server must not loop forever. Default 5. */
  maxResumes?: number;
  /** Delay after construction before the scan runs (lets the host finish
   *  booting). Default 3000ms; 0 runs it on the next tick. */
  delayMs?: number;
  /** Look at EVERY cut-off root run whose last event is at or after this
   *  time (epoch ms) — the runs one death cut off — instead of only the
   *  newest root run of each workflow. The boot scan passes when the
   *  previous process started (`<dataDir>/boot.json`, written once each
   *  boot scan is done); with no record of it, newest only. A run whose log
   *  was last written before it (`RunStore.logWrittenAt`) is passed over
   *  unread, summary and all. */
  since?: number;
}

/** One line of the boot-time chat auto-resume report (`autoResumeStaleChats`). */
export interface ChatResumeOutcome {
  chatId: string;
  /** The turn that was cut off. */
  turn: number;
  /** `resumed`: a wake-up turn launched (`next`). `finalized`: the dead turn
   *  got its terminal event and no turn launched — `reason` says why. */
  action: "resumed" | "finalized";
  next?: number;
  reason: string;
}

/** One line of the boot-time auto-resume report. */
export interface AutoResumeOutcome {
  workflow: string;
  runId: string;
  action: "resumed" | "finalized" | "skipped";
  reason: string;
}

/**
 * A configured strut instance. Carries the Hono `app` (mount it under your
 * own router, or call `listen()`), the underlying workspace / store /
 * services bag, and a typed `run()` helper that automatically threads
 * `services` into every workflow execution.
 */
export interface Strut<TServices = unknown> {
  /** Hono app with all strut routes mounted. Mount under your own router
   *  with `parent.route("/strut", strut.app)`, or call `strut.listen(port)`. */
  app: Hono;
  workspace: WorkspaceStore;
  /** Resolved local data directory (see `StrutOptions.dataDir`). */
  dataDir: string;
  store: RunStore;
  /** Deployment-scoped secret store backing `ctx.services.secrets` + the
   *  `/secrets` endpoints. */
  secretStore: SecretStore;
  /** Agent sessions — the store behind `ctx.services.sessions` + `/sessions`. */
  sessionStore: SessionStore;
  services: TServices;
  /** Apps (plans/apps.md): what the `/apps` routes and the `app/*` steps are
   *  thin over — `ctx.services.apps`. */
  apps: AppsCapability;
  /** What every app's pages cost the server (src/apps/monitor.ts): each
   *  `step_run` counted, `GET /apps/:name/usage` its report. */
  appMonitor: AppMonitor;

  /** Current registry. Reads through the closure so callers always see
   *  the latest after `rebuildRegistry()`. */
  getRegistry: () => StepRegistry;

  /** Re-scan the workspace for newly-published custom steps. No-op when
   *  the instance was constructed with an explicit `registry`. */
  rebuildRegistry: () => Promise<void>;

  /** Resume runs cut off by a dead process (RUN_CONTROL_SPEC §5.3): every
   *  root run with a log but no summary whose last event is at or after
   *  `since` — without it, the newest root run of each workflow — that was
   *  not paused or cancelling, is younger than `maxAgeMs`, and has fewer
   *  than `maxResumes` prior durable resumes. Runs automatically after boot
   *  when `autoResume` is enabled, with `since` = the previous process's
   *  start; callable directly. */
  autoResumeStaleRuns: (opts?: AutoResumeOptions) => Promise<AutoResumeOutcome[]>;
  /** The builder's twin: every chat left `live` by a dead process gets its
   *  cut-off turn finalized and, with a `[restart-notification]` of what was
   *  lost appended, a wake-up turn — `reconcileStaleChat` in the chat block.
   *  Runs after boot beside `autoResumeStaleRuns`; callable directly, and a
   *  direct call wakes whatever the `autoResume` setting. `[]` without chat. */
  autoResumeStaleChats: (opts?: AutoResumeOptions) => Promise<ChatResumeOutcome[]>;

  /** Record the contracts declared as `claims:` blocks in the workspace's
   *  workflow YAML (plans/claims.md §2, door one) — what a boot seeder's
   *  templates carry. Runs once at construction where the claims layer
   *  exists; callable again after seeding more. Idempotent; empty without
   *  the layer. */
  reconcileClaims: (names?: readonly string[]) => Promise<ClaimsReconcileOutcome[]>;

  /** Run a workflow by name (resolves through the workspace) or by Flow
   *  object. `services` is auto-injected from the instance; pass a
   *  `services` override in `opts` to use a different bag for one run. */
  run: (
    workflow: string | Flow,
    input?: unknown,
    opts?: StrutRunOptions<TServices>,
  ) => Promise<RunResult>;

  /** The speech-to-text service behind `/audio/*` (null when disabled). A
   *  host that mounts `app` itself must call `attachAudioWebSocket(server,
   *  strut.stt)` to get the dictation socket; `listen()` does it. */
  stt: SttService | null;

  /** The text-to-speech service behind `/audio/speak` (null when disabled). */
  tts: TtsService | null;

  /** Strut's WebSocket paths for a Node server's `upgrade` event: `/rooms`
   *  (plans/chained-orchestrators.md §3, src/rooms.ts) and `/channels`
   *  (plans/app-channels.md §2, src/channels.ts). The upgrade request runs
   *  through `app`'s own gate and hooks — `resolveScope` and `resolveActor`
   *  see `c.env.incoming`, the Node request, as on HTTP — and the socket
   *  joins the actor's room or the app's channels, or is refused with the
   *  gate's status. False (nothing touched) for a path that is not strut's.
   *  `listen()` hooks it; a host that owns the server routes its upgrades
   *  here, with its mount prefix as `basePath` (mcp: `/lab`). */
  upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer, opts?: { basePath?: string }) => boolean;

  /** App channels (plans/app-channels.md): live messages between the
   *  people on an app. The `/channels` socket hands every host's socket to
   *  it; code an app runs reaches it through `send` / `read`. */
  channels: Channels;

  /** Automations (plans/automations.md): the policy layer behind the
   *  `/automations` routes and the chat tools — list / create / update /
   *  remove / preview / fire. Ticks by itself unless `scheduler: false`. */
  automations: Automations;

  /** Packages (plans/marketplace.md), in process: what `POST
   *  /packages/install` and `DELETE /packages/…` do, one write at a time
   *  with them — plus the distro's door (`door: "distro"`, §12), which
   *  applies a release with no ask and updates an installed package item by
   *  item (§4). No route takes the door: an operator's subscription does. */
  packages: {
    /** `ref` is `file:`, `pk:` (with `url`), or a bare name looked up in
     *  the indexes this strut follows — the first that lists its publisher,
     *  or the one `index` names. */
    install(ref: string, opts?: Pick<InstallOptions, "digest" | "url" | "actor" | "door"> & { index?: string }): Promise<InstallResult>;
    uninstall(pkg: string, opts?: { door?: PackageDoor }): Promise<UninstallResult>;
    /** The first-boot installs (`STRUT_PACKAGES`, `StrutOptions.packages`;
     *  src/packages/boot.ts): settles once each listed package was installed,
     *  found here, or failed. `[]` when none are listed. */
    booted: Promise<BootPackageOutcome[]>;
  };

  /** Package subscriptions (plans/marketplace.md §12.1): this strut
   *  following another's catalog by its key — what `/packages/subscriptions`
   *  is over. `sync` reads one now and applies what is new. */
  subscriptions: Subscriptions;

  /** The package index (plans/marketplace.md §7) — null unless this strut
   *  has the index role (`StrutOptions.index`, STRUT_INDEX=1). */
  index: PackageIndex | null;

  /** The package indexes this strut FOLLOWS (src/packages/indexes.ts): a
   *  bare name resolves through their cards; `search` reads them and the
   *  peers' installed packages — what `/packages/indexes` and
   *  `/packages/search` are over. */
  indexes: PackageIndexes;

  /** Reads over the claims layer (plans/claims.md) — null unless the
   *  workspace is graph-backed AND the layer is on (`StrutOptions.claims`):
   *  claims hang off the subjects' graph nodes, so on a filesystem workspace
   *  no claim tool is offered and the verify pass is a no-op. */
  claims: ClaimsReader | null;

  /** The verify pass (plans/claims.md §4) — null wherever `claims` is.
   *  Runs by itself after every top-level run; a host calls
   *  `verifyRun` to wait for a run's evidence (single-flighted with the
   *  automatic pass), or `addEvidence` to report what it observed. */
  verifier: Verifier | null;

  /** Boot the Hono server with `@hono/node-server`. Resolves once the
   *  socket is listening, to the *bound* port — so `listen(0)` (or
   *  `STRUT_PORT=0`) lets the OS pick one, which a desktop host that spawns
   *  strut as a child process relies on. `host` (or `STRUT_HOST`) sets the
   *  bind address; unset binds every interface, `127.0.0.1` keeps a local
   *  strut off the LAN. Prints one JSON line on stdout when ready,
   *  `{"event":"ready","port":N,"host":"…"}`, for hosts to parse; with
   *  `STRUT_READY_KEY=1` the line also carries `key` (the `STRUT_API_KEY`),
   *  so a host that spawned strut reads port and credential from one line.
   *  Convenience wrapper — feel free to mount `app` yourself. */
  listen: (port?: number, host?: string) => Promise<number>;

  /** Stop the server started by `listen()` (no-op otherwise). */
  close: () => Promise<void>;
}

export interface StrutRunOptions<TServices = unknown> {
  runId?: string;
  /** Workflow version (only meaningful when `workflow` is a string). */
  version?: string;
  /** The launching run's id (the calling step's `ctx.runId`) — attaches this
   *  run's controller under the parent's, so cancel/pause on the parent
   *  reach it (RUN_CONTROL_SPEC §2.2 tree linkage). */
  parentRunId?: string;
  /** Per-event hook — useful for SSE streaming. */
  onEvent?: (event: RunEvent) => void | Promise<void>;
  /** Override the instance-level services for a single run. */
  services?: TServices;
  /** Per-run overrides for the workflow's `params` knobs (shallow-merged
   *  over the flow's `params` defaults). */
  params?: Record<string, unknown>;
  /** Per-run overrides keyed by workflow name, applied at every level of the
   *  execution tree (entry + nested subflows). See `RunOptions.paramOverrides`. */
  paramOverrides?: Record<string, Record<string, unknown>>;
  /** Who launched this run; billed to `principal`, else to the actor, else
   *  to the workflow's owner (plans/mothership-cost-control.md §2). */
  actor?: string;
  principal?: string;
  /** The job to launch under (plans/jobs.md §1) — the in-process twin of
   *  `POST …/run { job }`. Not format-checked here, as the route's is. */
  job?: string;
  /** The job's name, recorded on the job (plans/job-index.md §1) — the twin
   *  of `POST …/run { title }`. Ignored without `job`. */
  title?: string;
  /** The caller's MCP servers — the in-process twin of `POST …/run { mcp }`
   *  (src/mcp-servers.ts), handed to the run's steps as `ctx.mcp`. Not
   *  validated here, as the route's is. */
  mcp?: McpServer[];
}

// ── Run-output helpers ─────────────────────────────────────────────────────

/** Resolve a dotted/bracketed path (`a.b`, `a[0].b`) into a nested value.
 *  Used to pull a promote spec's `from` value out of a run's output. */
function getByPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Split a promote spec's `to` ("<workflow>.<param>") on the FIRST dot. */
function parsePromoteTarget(to: string): { workflow: string; param: string } | null {
  const dot = to.indexOf(".");
  if (dot <= 0 || dot >= to.length - 1) return null;
  return { workflow: to.slice(0, dot), param: to.slice(dot + 1) };
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Build a configured Strut instance. This is the primary entry point for
 * using strut as a library: pass your registry (or let it be discovered
 * from disk), your services bag, and mount the returned Hono `app`
 * wherever you like.
 *
 * ```ts
 * import { createStrut, createRegistry, defineStep } from "strut";
 *
 * interface MyServices { graph: GraphStore; llm: LLMClient }
 *
 * const strut = await createStrut<MyServices>({
 *   registry: await createRegistry([myStep, anotherStep]),
 *   services: { graph: new Neo4jGraph(), llm: new Anthropic() },
 * });
 *
 * await strut.listen(3000);
 * ```
 *
 * The returned `app` can also be mounted under a parent Hono / Express
 * app — strut owns its routes (`/workflows`, `/steps`, `/chat`, `/health`)
 * but nothing else.
 */
export async function createStrut<TServices = unknown>(
  opts: StrutOptions<TServices> = {},
): Promise<Strut<TServices>> {
  // The packages to install at first boot (src/packages/boot.ts): checked
  // first, so a bad value fails the boot before anything opens; installed
  // once the boot is done.
  const bootPackages = [...parseBootPackagesEnv(bootEnv()["STRUT_PACKAGES"]), ...checkBootPackages(opts.packages ?? [])];
  if (opts.escapeGuard !== false) installEscapeGuard();
  const workspace: WorkspaceStore = opts.workspace ?? new FileWorkspaceStore();
  // The ONE graph backend everything here reads: the host's, else the
  // workspace's own (Neo4j or a LadybugDB file). The claims gate below is
  // deliberately `workspace.graph`: claims hang off the workspace's nodes.
  const graph: GraphBackend | undefined = opts.graph ?? workspace.graph;
  // The graph writes made through strut, for a reader that shows what the
  // graph holds (plans/live-feeds.md §3): every run's writes land here
  // (bindGraph, src/graph-writes.ts), `graph/changes` and
  // `GET /graph/changes` read it.
  const graphChanges = graph ? createGraphChangeFeed() : undefined;
  // Backend mode, used ONLY to pick unspecified defaults: the run/chat/secret
  // stores follow the workspace's kind (file-backed → file stores under
  // dataDir; anything else → in-memory). No capability is gated on it —
  // every store is the full interface. An explicitly passed store always wins.
  const fileBacked = workspace instanceof FileWorkspaceStore;
  const dataDir =
    opts.dataDir ??
    (fileBacked ? workspace.path : (bootEnv()["STRUT_WORKSPACE"] ?? "./workspace"));
  const store: RunStore = opts.store ?? (fileBacked ? new FileRunStore(dataDir) : new MemoryRunStore());
  // Home sync's role here (src/home-sync.ts): a box serves it, a copy runs it.
  const homeRole = opts.homeSync ?? homeSyncRole(bootEnv()["STRUT_HOME_SYNC"]);
  // The voice service a person's call is handed to (src/voice.ts); half a
  // configuration fails the boot.
  const voice = voiceConfig(opts.voice, bootEnv());
  // The package index role (src/packages/index.ts): on, its reads — and
  // its MCP door, `POST /index/mcp` — open to anyone.
  const indexConfig = ((): { urls?: string[] } | undefined => {
    if (opts.index !== undefined) return opts.index === false ? undefined : opts.index === true ? {} : opts.index;
    if (bootEnv()["STRUT_INDEX"] !== "1") return undefined;
    const raw = bootEnv()["STRUT_INDEX_URLS"];
    if (!raw) return {};
    let urls: unknown;
    try {
      urls = JSON.parse(raw);
    } catch (err) {
      throw new Error(`STRUT_INDEX_URLS is not JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!Array.isArray(urls) || !urls.every((u) => typeof u === "string" && /^https?:\/\/\S+$/.test(u))) throw new Error("STRUT_INDEX_URLS is a JSON list of http(s) URLs");
    return { urls };
  })();
  const INDEX_READ = /^(?:\/llms\.txt$|\/index\/(?:catalog|packages(?:\/|$)|concepts(?:\/|$)|live$|mcp$))/;
  /** The index's MCP door (src/packages/index-tools.ts): the one POST the
   *  role opens, the three read tools over the same derived pages. */
  const INDEX_MCP = "/index/mcp";
  const mcpRegistry = fileMcpRegistry(dataDir);
  // Controllers for runs currently executing **in this process** (keyed
  // `${workflow}/${runId}`) — RUN_CONTROL_SPEC §2.2. A controller's presence
  // IS "in-flight" (superseding the old `activeRuns` set): detached execution
  // is in-memory, so a run with no `run.json` summary is only genuinely live
  // if it's in this map; otherwise it never finalized (server restart /
  // crash) and is reported as "stale" — i.e. resumable (§5).
  const controllers = new Map<string, RunController>();
  // Secondary index for tree linkage: a nested launch names only its
  // `parentRunId` (the calling step's ctx.runId), not the parent workflow.
  const controllersByRunId = new Map<string, RunController>();
  /** The live runs a peer launched (`origin: "peer"`), known from the
   *  launch — before `run.start` reaches the log — so a peer's cancel of the
   *  run it has just launched is never refused. A dead run is judged by its
   *  log. */
  const peerLaunched = new WeakSet<RunController>();
  /** The deployment's drain (src/drain.ts, `PUT /drain`). Lifting it — by
   *  hand or at its deadline — launches the wake turns it held back. */
  const drain = createDrain({ onLift: () => void wakes.reconcile() });
  /** The builder chats with a turn running in this process (set by the chat
   *  block; none with the chat off) — what `GET /drain` waits on beside runs. */
  let liveChats = (): string[] => [];
  /** A launch route's answer while draining: 503, and when to ask again. */
  const drainingResponse = (c: Context): Response | undefined => {
    const refused = drain.refusal();
    return refused ? c.json({ error: refused }, 503, { "retry-after": "60" }) : undefined;
  };
  /** Who a live run was launched for — its app and actor, as its `run.start`
   *  will record them — known from the launch, so a run a caller has just
   *  been handed the id of is theirs before its first event lands (`ownRun`).
   *  A dead run is judged by its log. */
  const launchedAs = new WeakMap<RunController, { app?: AppRef; actor?: string }>();
  /** Register a run as in-flight, creating its controller (attached to the
   *  launching run's controller when `parentRunId` resolves — controls apply
   *  to whole subtrees). Every launch path must register: HTTP
   *  (launchDetached), programmatic (strut.run), in-process nested runs
   *  (authoring's meta/run-workflow), and chat-detached runs. The returned
   *  untrack fn belongs in the launcher's finally. `job` is the launch's
   *  job and title, shown on the run's row until its summary is written. */
  const trackRun = (workflow: string, runId: string, parentRunId?: string, job?: { id: string; title?: string }) => {
    const key = `${workflow}/${runId}`;
    const parent = parentRunId ? controllersByRunId.get(parentRunId) : undefined;
    // While draining (src/drain.ts) nothing new starts: every launch path
    // registers here, so this is where a new ROOT run is refused. A run a
    // run in flight launches is part of that run's work and still starts.
    const draining = parent ? undefined : drain.refusal();
    if (draining) throw new DrainingError(draining);
    const controller = new RunController(runId, workflow, parent);
    if (job) controller.job = job;
    controllers.set(key, controller);
    controllersByRunId.set(runId, controller);
    const untrack = () => {
      controllers.delete(key);
      if (controllersByRunId.get(runId) === controller) controllersByRunId.delete(runId);
      controller.detach();
    };
    return { controller, untrack };
  };
  /** Listing/stream status for a summary-less run: the controller's live
   *  state, or "stale" (orphaned by a crash/restart — resumable). */
  const liveStatus = (workflow: string, runId: string): string => {
    const controller = controllers.get(`${workflow}/${runId}`);
    return controller ? controller.state : "stale";
  };
  /** A live run's job as a listing row carries it: `job`, like the summary
   *  it has yet to write, and `jobTitle`, the launch's name for the job —
   *  the record only has it once the run reaches `run.start`. */
  const liveJob = (controller: RunController | undefined) =>
    controller?.job
      ? { job: controller.job.id, ...(controller.job.title ? { jobTitle: controller.job.title } : {}) }
      : {};
  /** Append a control marker (run.paused / run.resumed) to a run's log so
   *  the parked gap is visible in the record (§4 observability). A
   *  `run.resumed` written here is an UNPAUSE of a live run, marked `live`:
   *  the crash-loop guard counts only the durable resumes the runner writes. */
  const appendControlEvent = async (
    workflow: string,
    runId: string,
    type: "run.paused" | "run.resumed" | "run.cancelling",
  ) => {
    await store.append(workflow, runId, {
      ts: new Date().toISOString(),
      runId,
      path: workflow,
      type,
      ...(type === "run.resumed" ? { live: true as const } : {}),
    });
  };
  // Deployment-scoped secret store backing the `secrets` capability + the
  // `/secrets` admin endpoints. Mirrors the run/chat store defaults: encrypted
  // file store for the standard server, in-memory when runs are in-memory.
  const secretStore: SecretStore =
    opts.secretStore ??
    (fileBacked ? new FileSecretStore(dataDir) : new MemorySecretStore());
  // Did the consumer inject their own `secrets` capability? If so we leave it
  // alone and the `/secrets` endpoints (which manage *our* store) report 501.
  const secretsInjected =
    opts.services != null &&
    typeof (opts.services as Record<string, unknown>)["secrets"] === "object";
  // Per-actor secrets, in their own encrypted file — never in `/secrets`.
  // Defaults follow the DEPLOYMENT secret store's kind, not the workspace's:
  // a graph-workspace host that keeps `secrets.json` on disk (mcp's lab)
  // gets `actor-secrets.json` beside it, so a pushed credential survives a
  // restart. Memory only when the deployment's secrets are in memory too.
  const actorSecrets: ActorSecretStore = actorSecretStore(
    opts.actorSecretStore ??
      (secretStore instanceof FileSecretStore
        ? new FileSecretStore(dataDir, ACTOR_SECRETS_FILE)
        : new MemorySecretStore()),
  );
  // Peers (plans/federation.md §3): the struts this one may call, in a
  // fourth encrypted file beside the deployment's secrets — the actor-secret
  // default. Tokens never leave this process: steps and the builder get a
  // capability that names a peer and makes the request.
  const peerRecords = peerStore(
    opts.peerStore ??
      (secretStore instanceof FileSecretStore ? new FileSecretStore(dataDir, PEERS_FILE) : new MemorySecretStore()),
  );
  for (const peer of [...parsePeersEnv(bootEnv()["STRUT_PEERS"]), ...(opts.peers ?? [])]) {
    await peerRecords.set(peer);
  }
  const selfSeed = opts.self ? checkSelf(opts.self) : parseSelfEnv(bootEnv()["STRUT_SELF"]);
  if (selfSeed) await peerRecords.setSelf(selfSeed);
  const peersCap = peersCapability(peerRecords);
  // Automation callbacks (plans/automations.md): each URL is a host's
  // credential, kept in a fifth encrypted file beside the deployment's
  // secrets — never in `secrets.json`, which every step reads through
  // `ctx.services.secrets` and `GET /secrets` lists.
  const automationCallbacks: SecretStore =
    secretStore instanceof FileSecretStore ? new FileSecretStore(dataDir, AUTOMATION_CALLBACKS_FILE) : new MemorySecretStore();
  // Agent sessions follow the chat store's kind: both are conversations a
  // host expects to find again after a restart.
  const sessionStore: SessionStore =
    opts.sessionStore ??
    ((opts.chatStore ? opts.chatStore instanceof FileChatStore : fileBacked)
      ? new FileSessionStore(dataDir)
      : new MemorySessionStore());
  const sessions = sessionsCapability(sessionStore);
  // A consumer's own `sessions` capability is theirs: the `/sessions`
  // endpoints (which manage OUR store) then report 501, like `/secrets`.
  const sessionsInjected =
    opts.services != null &&
    typeof (opts.services as Record<string, unknown>)["sessions"] === "object";
  // Auto-provide the standard capabilities (http + secrets) every adapter step
  // builds on, with the consumer's bag spread on top so they can override or
  // extend any capability. The default `secrets` capability reads the secret
  // store (UI-managed) with `process.env` as fallback. This is what lets an
  // LLM-authored adapter rely on `ctx.services.http` / `ctx.services.secrets`
  // existing out of the box.
  // Speech-to-text: sessions + hotword lists live under dataDir; models under
  // STRUT_MODEL_DIR. Nothing loads until a stream or transcribe call.
  const stt: SttService | null = opts.stt === false ? null : (opts.stt ?? createStt({ dataDir }));
  // The recognizer thread strut started, stopped by `close()`; a host's own service is the host's.
  const ownStt = opts.stt === undefined ? stt : null;
  // Text-to-speech: models under STRUT_MODEL_DIR; nothing loads until a speech.
  const tts: TtsService | null = opts.tts === false ? null : (opts.tts ?? createTts());
  const ownTts = opts.tts === undefined ? tts : null;
  // What the job index may not read past a run's status (plans/job-index.md
  // §2): a sealed workflow's runs — `job/get` is the meta surface from
  // inside a run (src/sealed.ts).
  const isSealedWorkflow = async (name: string): Promise<boolean> => {
    try {
      return (await workspace.getWorkflow(name)).sealed === true;
    } catch {
      return false;
    }
  };
  // The job INDEX (plans/job-index.md): what `GET /jobs[/:id]`, the job/*
  // steps and the assistant MCP door's get_run { files } read through.
  const jobIndex = createJobIndex({
    dataDir,
    store,
    sessions: sessionStore,
    sessionHolder: sessions.holder,
    isLive: (workflow, runId) => controllers.has(`${workflow}/${runId}`),
    sealed: isSealedWorkflow,
    // Called only once the server is up: `appVersionOf` is defined below.
    appVersion: async (name, version) => appVersionOf(name, version),
  });
  // Proposals (plans/proposals.md): the bag's capability — its `decide` is
  // attached with the decide route below, where its deps are. On a graph
  // workspace each change is projected (`StrutProposal`, graph/projector.ts),
  // detached: the record is written first and stays what every list reads.
  const proposalGraph = workspace.graph;
  const projectProposal = proposalGraph
    ? (p: { id: string }) =>
        void projectProposalOnce(proposalGraph, ownProposals, p.id).catch((err) => console.error(`[projector] proposal ${p.id} was not projected:`, err))
    : undefined;
  // Each change is also an event on the proposal feed (plans/live-feeds.md,
  // "Proposal feed"): `proposal/changes` and `GET /proposals/changes` read it.
  const proposalChanges = createProposalFeed();
  const proposalChanged = (p: Proposal) => {
    proposalChanges.push(p);
    projectProposal?.(p);
  };
  const ownProposals: ProposalsCapability = proposalsCapability(dataDir, {
    changed: proposalChanged,
    // What the host's deltas gate: a step that reaches past this strut
    // checks it whatever the route (proposals.ts `requireApproval`).
    hostApprove: [opts.job, opts.orchestrator, opts.builder].flatMap((d) => (d ? (d.approve ?? []) : [])),
    notify: (job, update) => ((services as Record<string, unknown>)["jobs"] as JobsCapability | undefined)?.notify?.(job, update),
    // Where a proposal shows (proposals.ts `visibleTo`); called at
    // proposal time, long after this function has returned.
    conversationOf: (runId) => conversationOf(runId),
  });
  const services = {
    ...(standardServices({ secretStore, actorSecretStore: actorSecrets, dataDir }) as unknown as Record<
      string,
      unknown
    >),
    // Per-run artifact files, rooted in the local data dir. A consumer bag
    // can override with its own ArtifactsCapability (spread below wins).
    artifacts: fileArtifactsCapability(join(dataDir, "artifacts")),
    // A person's one write to the deployment's secrets, from an app: fill
    // a blank, never overwrite (`secret/add`, plans/member-rights.md). Only
    // when strut owns the store.
    ...(secretsInjected ? {} : { secretBlanks: secretBlanks(secretStore) }),
    sessions,
    // The job record's writer (standardServices gives a bare one) plus the
    // INDEX that reads it back (plans/job-index.md): the run store for
    // each run's status, the session store for the job's threads, the
    // workspace for what is sealed. What `GET /jobs[/:id]` and the
    // `job/*` steps read through.
    jobs: jobsCapability(dataDir, jobIndex, {
      // A hold's update names the run that took or let go of it: the
      // job's top-level run in flight (its turn), when there is one.
      runOf: (job) => [...controllers.values()].find((c) => c.job?.id === job && !c.parent)?.runId,
    }),
    peers: peersCap,
    // Proposals (plans/proposals.md): the record a gated tool call writes
    // and the proposal/* steps read; a job's host hears each as a
    // `job.update` through the jobs capability's notify (read lazily: the
    // bag is being built).
    // The registered MCP servers (src/mcp-registry.ts), which an agent's
    // `agentTools: [mcp/<server>/*]` reaches.
    mcpRegistry,
    proposals: ownProposals,
    // The graph backend the server wired, for the graph/* steps (graphCtx
    // prefers it over opening one from env). Borrowed: a step's `close()`
    // must not close the connection the workspace and claims read through.
    // On a host that set `graphReaders`, a view that holds each `graph/*`
    // step to its caller's list (src/graph/scope.ts).
    ...(graph ? { graph: graphView({ ...graph, close: async () => undefined }, opts.graphReaders) } : {}),
    ...(graphChanges ? { graphChanges } : {}),
    proposalChanges,
    ...(stt ? { stt } : {}),
    // The LLM auth seam, for the model-building call sites (llm.ts).
    ...(opts.llmAuth ? { llmAuth: opts.llmAuth } : {}),
    ...(opts.settings ? { settings: opts.settings } : {}),
    ...((opts.services ?? {}) as Record<string, unknown>),
  } as TServices;
  // The browser the browser/* steps drive (src/browser/service.ts), unless
  // the host brought its own — whose teardown is then the host's too.
  // Building it touches nothing: the first step that opens a page connects.
  // Each run's contexts close when the run ends; a bad BROWSER_* value is a
  // warning here and an error in those steps, never a failed boot.
  // The events sink (src/events-sink.ts; STRUT_EVENTS_SINK): every run's
  // events, the envelope only, batched to one URL the deployment names —
  // hung on the bag as `onRunEvent`, the twin of `onRunEnd` the runner
  // calls at every emit, after a host's own. A bad URL fails the boot, like
  // STRUT_PEERS; nothing in a run waits on a delivery.
  let ownSink: EventsSink | undefined;
  if (opts.eventsSink) {
    const url = parseSinkUrl(opts.eventsSink.url);
    const sink = createEventsSink({ url });
    const bag = services as Record<string, unknown>;
    const prior = (bag["onRunEvent"] as ((workflow: string, event: RunEvent) => unknown) | undefined)?.bind(bag);
    bag["onRunEvent"] = async (workflow: string, event: RunEvent) => {
      try {
        await prior?.(workflow, event);
      } finally {
        sink.push(workflow, event);
      }
    };
    ownSink = sink;
    console.log(`[events-sink] posting every run's events to ${callbackOrigin(url)}`);
  }

  let ownBrowser: BrowserService | undefined;
  if (!(services as Record<string, unknown>)["browser"]) {
    try {
      const browser = BrowserService.fromEnv();
      const bag = services as Record<string, unknown>;
      const prior = (bag["onRunEnd"] as ((id: string, info?: RunEndInfo) => unknown) | undefined)?.bind(bag);
      bag["browser"] = browser;
      bag["onRunEnd"] = async (runId: string, info?: RunEndInfo) => {
        try {
          await prior?.(runId, info);
        } finally {
          await browser.dispose(runId);
        }
      };
      ownBrowser = browser;
    } catch (err) {
      console.warn("[browser] no browser service:", err instanceof Error ? err.message : err);
    }
  }
  const artifacts = (services as Record<string, unknown>)["artifacts"] as
    | ArtifactsCapability
    | undefined;
  // The secrets boundary (store → env) that the chat's model resolution and
  // the /llm/models availability check read provider keys through.
  const secretsCap = (services as Record<string, unknown>)["secrets"] as
    | SecretsCapability
    | undefined;

  // ── Actors and the principal rule (plans/mothership-cost-control.md §2) ──
  //
  // The host says who a request is from; strut never reads a header it did
  // not ask for. A run's spend lands on the actor who launched it, else on
  // the workflow's owner (an automation has no actor, so the owner pays).
  // A request strut made to itself (auth.ts `inProcessRequest`, app/look's
  // page) names its actor and is `full`, before any host hook is asked.
  const hostActor = opts.resolveActor ?? actorFromHeader;
  const resolveActor = (c: Context) => {
    const own = inProcessOf(c);
    return own ? own.actor : hostActor(c);
  };
  // And what it may do: a `peer` (another strut) reads, launches, and
  // controls the runs a peer launched (plans/federation.md §3); a
  // `peer:person` (a person's credential through one) the same, and more
  // (auth.ts `Scope`).
  const hostScope = opts.resolveScope ?? scopeFromKey;
  // A member's session is strut's own credential, whatever a host's hook
  // maps (plans/member-rights.md): one that carries nothing else is
  // `member`, before the hook is asked.
  const memberOnly = (c: Context) => !carriesApiKey(c) && !carriesPeerKey(c) && !personOf(c) && memberOf(c) !== undefined;
  const resolveScope = (c: Context) => (inProcessOf(c) ? ("full" as const) : memberOnly(c) ? ("member" as const) : hostScope(c));
  const scopeOf = async (c: Context): Promise<Scope> => (await resolveScope(c)) ?? "full";
  const isPeer = async (c: Context) => isPeerScope(await scopeOf(c));
  const principalFor = async (workflow: string, actor?: string): Promise<string | undefined> => {
    if (actor) return actor;
    return (await workspace.getWorkflowMetadata(workflow).catch(() => null))?.owner;
  };
  /** A workflow with no owner is adopted by the first actor who publishes it. */
  const adoptWorkflow = async (name: string, actor: string | undefined) => {
    if (!actor) return;
    const meta = await workspace.getWorkflowMetadata(name).catch(() => null);
    if (meta && !meta.owner) await workspace.setWorkflowOwner(name, actor);
  };
  /** `{ actor, principal }` for a launch with no workflow to own it (a single
   *  step): the actor pays for their own call. */
  const actorStamp = async (c: Context) => {
    const actor = await resolveActor(c);
    return actor ? { actor, principal: actor } : {};
  };
  const serveUi = opts.serveUi ?? true;
  const enableChat = opts.enableChat ?? true;
  const enableMcp = opts.enableMcp ?? enableChat;
  // Boot-time auto-resume (RUN_CONTROL_SPEC §5.3), the setting: on by default
  // whenever the store in question outlives the process — the run store for
  // runs, the chat store for the builder's chats — off with
  // `STRUT_AUTO_RESUME=0` or `autoResume: false`. The scans are scheduled at
  // the end of construction; the chat flag also decides whether a read that
  // finds a chat cut off by a restart wakes it or only marks it.
  const autoResumeOpts: AutoResumeOptions = typeof opts.autoResume === "object" ? opts.autoResume : {};
  const resumeMaxLogBytes =
    opts.resumeMaxLogBytes ?? positiveBytes(bootEnv()["STRUT_RESUME_MAX_LOG_BYTES"], DEFAULT_RESUME_MAX_LOG_BYTES);
  const autoResumeOn = (persistent: boolean) =>
    opts.autoResume === undefined ? persistent && bootEnv()["STRUT_AUTO_RESUME"] !== "0" : opts.autoResume !== false;
  /** Set inside the chat block; a no-op without chat. */
  let autoResumeStaleChats: (o?: AutoResumeOptions) => Promise<ChatResumeOutcome[]> = async () => [];
  const chatStore: ChatStore =
    opts.chatStore ?? (fileBacked ? new FileChatStore(dataDir) : new MemoryChatStore());
  const autoResumeRuns = autoResumeOn(!(store instanceof MemoryRunStore));
  /** When this process started — what the NEXT boot's scan reads back as
   *  the previous start (`boot.json`, §5.3). */
  const bootedAt = Date.now();
  const autoResumeChats = enableChat && autoResumeOn(!(chatStore instanceof MemoryChatStore));
  const chatMaxSteps =
    opts.chatMaxSteps ?? Number(bootEnv()["STRUT_CHAT_MAX_STEPS"] ?? 100);
  const chatModel =
    opts.chatModel ?? bootEnv()["STRUT_CHAT_MODEL"] ?? "claude-sonnet-5-5";
  const chatRunWaitMs =
    opts.chatRunWaitMs ?? Number(bootEnv()["STRUT_CHAT_RUN_WAIT_MS"] ?? 60_000);
  const chatMaxAutoTurns =
    opts.chatMaxAutoTurns ?? Number(bootEnv()["STRUT_CHAT_MAX_AUTO_TURNS"] ?? 10);
  const webDist =
    opts.webDist ??
    bootEnv()["STRUT_WEB_DIST"] ??
    resolve(dirname(fileURLToPath(import.meta.url)), "../web/dist");
  const registryWasInjected = opts.registry !== undefined;

  // Mutable closure state — `app` handlers read through these.
  let registry: StepRegistry = opts.registry ?? {};
  // Apps (plans/apps.md §1.3, §8): the one implementation the `/apps`
  // routes and the `app/*` steps share, over the workspace's pointers and
  // the version directories under dataDir. A host's own `apps` on the bag
  // wins, as every other capability's does. The monitor counts every call a
  // page makes (`step_run`), for `GET /apps/:name/usage`, the UI's warning
  // dot and `app/get`'s `usage` — kept in each app's `.usage/` under dataDir,
  // so a restart loses only the last few seconds.
  const appMonitor = createAppMonitor({ root: appsRoot(dataDir) });
  // A person's grants of sealed workflows to an app — the assistant for an
  // app's own chat (src/apps/grants.ts): read by the publish and by the run
  // doors below (`openFlow`), on every backend under dataDir.
  const appGrants = fileAppGrants(dataDir);
  const apps: AppsCapability =
    ((services as Record<string, unknown>)["apps"] as AppsCapability | undefined) ??
    createApps({
      workspace,
      getRegistry: () => registry,
      ...(opts.kit ? { kit: opts.kit } : {}),
      // An app's client-side errors are kept runs (plans/apps.md §8): read
      // off the run store, newest first, when `app/get` asks.
      errors: (name, max) => appErrors(store, name, max),
      monitor: appMonitor,
      // A person's grants of sealed workflows (src/apps/grants.ts).
      grants: appGrants,
      // The viewers' state (src/apps/state.ts), dropped with the app.
      dataDir,
      // An app's declared graph types are registered here, on Neo4j.
      ...(graph ? { graph } : {}),
    });
  (services as Record<string, unknown>)["apps"] = apps;
  let stepSources: StepSources = {};
  // `type@vN` pins load through the workspace's version archive (src/step-ref.ts).
  const loadStepVersion = (name: string, version: string) => workspace.materializeStepVersion(name, version);
  // The host's section of the builder's prompt; by default, on a graph, the
  // `Workflow Builder` page read through the registry in force at the time.
  const chatSystem: StrutOptions["chatSystem"] =
    opts.chatSystem ?? (graph ? () => builderSystem({ graph, registry, services }) : undefined);

  // What the AI may publish, when the host says (src/reach.ts).
  const reach = opts.builder ? opts.builder.reach : undefined;
  /** The workspace's registry: core, lib and its custom steps, a step a
   *  package installed behind that package's fence (src/packages/fence.ts). */
  const workspaceRegistry = async () =>
    buildRegistry(await workspace.materializeCustomSteps(), { loadVersion: loadStepVersion, fences: await workspaceFences(workspace) });
  async function rebuildRegistry(): Promise<void> {
    if (registryWasInjected) return; // consumer owns the registry
    const bundle = await workspaceRegistry();
    registry = bundle.registry;
    stepSources = bundle.sources;
  }

  if (!registryWasInjected) {
    await rebuildRegistry();
  }

  // The workflows strut ships: `job` (plans/jobs.md §5; src/job-seed.ts),
  // `orchestrator` (src/orchestrator-seed.ts) and `builder`
  // (src/builder-seed.ts; plans/builder-job.md).
  // Content-hash seeded, so a boot is a no-op unless the template or the
  // host's delta changed; before the claims reconcile below, which records
  // a seeded workflow's `claims:` block. A workspace that will not take it
  // is a warning, never a failed boot.
  if (opts.job !== false) {
    try {
      const { version, changed } = await seedJobWorkflow(workspace, opts.job);
      if (changed) console.log(`[job] seeded workflow: job @ ${version}`);
    } catch (err) {
      console.warn(`[job] could not seed the job workflow:`, err instanceof Error ? err.message : err);
    }
  }
  if (opts.orchestrator !== false) {
    try {
      // A host that keeps the person's own pages: the orchestrator follows them.
      const personal = opts.concepts !== false && opts.concepts?.personal ? { personalConcept: PERSONAL_ROOT } : {};
      const { version, changed } = await seedOrchestratorWorkflow(workspace, { ...opts.orchestrator, ...personal });
      if (changed) console.log(`[orchestrator] seeded workflow: orchestrator @ ${version}`);
    } catch (err) {
      console.warn(`[orchestrator] could not seed the orchestrator workflow:`, err instanceof Error ? err.message : err);
    }
  }
  if (opts.builder !== false) {
    try {
      const { version, changed } = await seedBuilderWorkflow(workspace, opts.builder);
      if (changed) console.log(`[builder] seeded workflow: builder @ ${version}`);
    } catch (err) {
      console.warn(`[builder] could not seed the builder workflow:`, err instanceof Error ? err.message : err);
    }
  }

  // `strut/views` (src/apps/views-seed.ts): strut's components as an app
  // other apps import. By tree hash; skipped without a built kit.
  if (opts.views !== false) {
    try {
      const r = await seedViewsApp({ workspace, ...(opts.kit ? { kit: opts.kit } : {}) });
      if (r?.changed) console.log(`[views] seeded app: strut/views @ ${r.version}`);
    } catch (err) {
      console.warn(`[views] could not seed strut/views:`, err instanceof Error ? err.message : err);
    }
  }
  // `strut/jamie` (src/apps/jamie-seed.ts): the person's assistant as a
  // first-party app. After strut/views, whose components it imports. The
  // app it was before it was Jamie goes.
  if (opts.jamie !== false) {
    try {
      const r = await seedJamieApp({ workspace, ...(opts.kit ? { kit: opts.kit } : {}) });
      if (r?.changed) console.log(`[jamie] seeded app: strut/jamie @ ${r.version}`);
    } catch (err) {
      console.warn(`[jamie] could not seed strut/jamie:`, err instanceof Error ? err.message : err);
    }
  }
  // `strut/knowledge` (src/apps/knowledge-seed.ts): the Concept tree as a
  // first-party app. After strut/views, whose components it imports.
  if (opts.knowledge !== false) {
    try {
      const r = await seedKnowledgeApp({ workspace, ...(opts.kit ? { kit: opts.kit } : {}) });
      if (r?.changed) console.log(`[knowledge] seeded app: strut/knowledge @ ${r.version}`);
    } catch (err) {
      console.warn(`[knowledge] could not seed strut/knowledge:`, err instanceof Error ? err.message : err);
    }
  }
  if (await workspace.getApp(RETIRED_APP).catch(() => null)) {
    await apps.delete(RETIRED_APP).catch((err) => console.warn(`[jamie] could not remove ${RETIRED_APP}:`, err instanceof Error ? err.message : err));
  }

  // Apps' history (src/apps/objects.ts): versions published before it get
  // their sources recorded once per file, and the directories no longer
  // kept (the active version and the newest few are) go.
  try {
    const c = await apps.compact();
    if (c.recorded || c.evicted) console.log(`[apps] recorded ${c.recorded} app version(s), removed ${c.evicted} version folder(s) no longer kept`);
    if (c.mismatched.length) console.warn(`[apps] left alone, files no longer match the version: ${c.mismatched.join(", ")}`);
  } catch (err) {
    console.warn(`[apps] could not compact app versions:`, err instanceof Error ? err.message : err);
  }

  // The Concept pages strut ships (src/concepts/): the `Workflow Builder`
  // page the builder's prompt reads and the `Job` page the job agent opens
  // first. On a graph only; a page that will not seed is a warning.
  if (graph && opts.concepts !== false) {
    try {
      await seedConcepts(graph, opts.concepts?.personal ? [STRUT_CONCEPTS, PERSONAL_CONCEPTS] : [STRUT_CONCEPTS]);
    } catch (err) {
      console.warn(`[concepts] could not seed strut's Concept pages:`, err instanceof Error ? err.message : err);
    }
  }

  // The browser workflows strut ships beside the browser/* steps
  // (src/browser/seed.ts): browser-capture, browser-explore, browser-watch.
  // Seeded like `job`, by content hash; one that will not take is a warning.
  if (opts.browserWorkflows !== false) {
    for (const w of await seedBrowserWorkflows(workspace)) {
      if (w.changed) console.log(`[browser] seeded workflow: ${w.name} @ ${w.version}`);
    }
  }

  // `private-ask` (src/privacy/seed.ts), seeded like the browser workflows.
  if (opts.privacyWorkflows !== false) {
    for (const w of await seedPrivacyWorkflows(workspace)) {
      if (w.changed) console.log(`[privacy] seeded workflow: ${w.name} @ ${w.version}`);
    }
  }

  // The workflow a strut that keeps a read copy of its home's memory runs.
  if (homeRole === "copy") {
    try {
      const w = await seedHomeSyncWorkflow(workspace);
      if (w.changed) console.log(`[home] seeded workflow: home-sync @ ${w.version}`);
    } catch (err) {
      console.warn(`[home] could not seed workflow "home-sync":`, err instanceof Error ? err.message : err);
    }
  }

  // The built-in automations strut ships (src/system-workflows.ts): each a
  // workflow of category "system" plus its automation, installed off. Before
  // the scheduler's first load, so a new one is scheduled once turned on.
  if (opts.systemWorkflows !== false) {
    for (const w of await installSystemWorkflows(workspace)) {
      if (w.action !== "unchanged" || w.automation) console.log(`[system] ${w.name} @ ${w.version}: ${w.action}${w.automation ? `, automation ${w.automation} (off)` : ""}`);
    }
  }

  // The claims layer (plans/claims.md) — decided HERE and nowhere else. It
  // needs the subjects' graph nodes, so a filesystem workspace never has it;
  // on a graph workspace it is on unless `claims: false` / `STRUT_CLAIMS=0`.
  // Everything downstream (authoring, the chat tools, the prompt, the HTTP
  // door, the verify pass) is handed `claimsAuthoring` and gates on that,
  // never on `workspace.graph`.
  const claimsEnabled = opts.claims ?? bootEnv()["STRUT_CLAIMS"] !== "0";
  const claimsGraph = claimsEnabled ? workspace.graph : undefined;
  // The job index (plans/job-claims.md §1–§2): a job subject's node is
  // upserted from its record, its active version is its newest turn.
  const claimsJobs = (services as Record<string, unknown>)["jobs"] as JobsCapability | undefined;
  const claimsAuthoring = claimsGraph
    ? buildClaimsAuthoring({
        graph: claimsGraph,
        workspace,
        jobs: claimsJobs,
        getRegistry: async () => {
          await rebuildRegistry();
          return registry;
        },
      })
    : null;
  const claims = claimsAuthoring?.reader ?? null;

  // Contracts that reached the store WITHOUT passing a door — a boot seeder's
  // templates, a script, an older strut — declared as `claims:` blocks in
  // their YAML. Recorded here, once per boot, before anything runs. A
  // template this deployment cannot honor (a check naming a step it lacks)
  // is a warning, never a failed boot.
  const reconcileClaims = async (names?: readonly string[]): Promise<ClaimsReconcileOutcome[]> =>
    claimsAuthoring ? claimsAuthoring.reconcileWorkflowClaims(names) : [];
  if (claimsAuthoring) {
    try {
      for (const o of await reconcileClaims()) {
        if (o.error) console.warn(`[claims] ${o.name}: ${o.error}`);
        else if (o.added > 0) console.log(`[claims] ${o.name}: recorded ${o.added} claim(s) from its YAML`);
      }
    } catch (err) {
      console.warn(`[claims] recording the workspace's claims: blocks at boot failed:`, err);
    }
  }

  // The verify pass (plans/claims.md §4) — only where the claims layer exists.
  // Triggered where `services.onRunEnd` fires — `runWorkflow`'s `finally`,
  // once per TOP-LEVEL run — and NOT at the launch sites: a candidate that a
  // harness launches through `meta/run-workflow` is its own top-level run and
  // must be verified too. Always detached; a consumer's own onRunEnd
  // (per-run teardown) still runs first.
  let verifySettled: ((r: VerifyResult) => void) | undefined;
  // Wakes the chat that launched a run with its verdict — built with the chat
  // block (it needs the notifier); without chat, evidence is just written.
  let verifyWaker: VerifyWaker | undefined;
  const verifier = claimsGraph
    ? createVerifier({
        graph: claimsGraph,
        store,
        workspace,
        jobs: claimsJobs,
        services: () => services,
        getRegistry: async () => {
          await rebuildRegistry();
          return registry;
        },
        onSettled: (r) => verifySettled?.(r),
      })
    : null;
  // A job's ledger rides on the jobs capability (plans/job-claims.md §6), so
  // `GET /jobs/:id` and `job/get` carry the same `claims`.
  if (verifier && claimsJobs) {
    claimsJobs.claims = (job) => verifier.jobLedger(job);
    // A person's two doors onto a job's claims, as steps (`job/verify`,
    // `job/evidence`: strut's own app): what `POST /jobs/:id/verify` and
    // `POST /claims/:id/evidence { job }` do.
    claimsJobs.verify = async (job, o = {}) => {
      const opts = o.claims ? { claims: o.claims } : {};
      if (o.detach) {
        if ((await verifier.jobLedger(job)) === null) return null;
        void verifier.verifyJob(job, opts).catch((err) => console.error(`[verify] job "${job}" failed:`, err));
        return { job, started: true };
      }
      const result = await verifier.verifyJob(job, opts);
      return result.skipped === "unknown-job" ? null : result;
    };
    claimsJobs.evidence = ({ slot, ...input }) => verifier.addEvidence({ ...input, ...(slot ? { slot } : {}), by: "person", mode: "asserted" });
  }
  //
  // The same hook PROJECTS the run into the graph (graph/projector.ts: its
  // `StrutRun`, agent sessions, tool calls and the nodes they touched) —
  // every top-level run, wherever the workspace is graph-backed, claims or
  // not. Detached too: a graph that is slow or down never holds a teardown.
  const runGraph = workspace.graph;
  if (runGraph) {
    const bag = services as Record<string, unknown>;
    const prior = (bag["onRunEnd"] as ((id: string, info?: RunEndInfo) => unknown) | undefined)?.bind(bag);
    bag["onRunEnd"] = async (runId: string, info?: RunEndInfo) => {
      try {
        await prior?.(runId, info);
      } finally {
        // Check runs are never projected or verified (the recursion guard);
        // a single-step run is verified by `runStep`, once it reaches the
        // real store.
        if (info?.workflow && info.origin !== "verify" && info.workflow !== RUN_STEP_FLOW) {
          const key = info.workflow;
          // With the job index, so a run launched under a job refreshes
          // its `StrutJob` (plans/job-index.md §6).
          const jobs = (services as Record<string, unknown>)["jobs"] as JobsCapability | undefined;
          // …and with the conversation index, so a turn of a conversation
          // refreshes its `StrutChat` (plans/jamie-app.md §2). Its end was
          // recorded from the run's terminal event, before this.
          const convs = (services as Record<string, unknown>)["conversations"] as Partial<ConversationReader> | undefined;
          void projectRunOnce(runGraph, store, key, runId, jobs, typeof convs?.record === "function" ? (convs as ConversationReader) : undefined, ownProposals).catch((err) =>
            console.error(`[projector] run ${key}/${runId} was not projected:`, err),
          );
          verifier?.schedule(key, runId);
        }
      }
    };
  }

  // Auto-provide the AUTHORING capability (the workspace's author/test/inspect
  // operations as one service) unless the consumer injected their own — same
  // spirit as http/secrets/artifacts above, added here because it closes over
  // the registry state initialized just before. This is what the meta/* lib
  // steps reach via ctx.services.authoring, letting an in-workflow agent
  // (agentTools: ["meta/*"]) author and evaluate candidate workflows
  // (EVOLVE_SPEC §5). Everything it publishes is stamped publisher "ai" and
  // it publishes only over that stamped set; it runs and inspects anything
  // but what is sealed (src/sealed.ts: a grading harness, a grader step).
  if (reach) {
    // Frozen, and a copy: a step holds the bag, and must not widen it.
    const policy: ReachPolicy = Object.freeze({
      reach: Object.freeze({
        tools: Object.freeze([...(reach.tools ?? [])]) as string[],
        builtins: Object.freeze([...(reach.builtins ?? [])]) as string[],
        secrets: Object.freeze([...(reach.secrets ?? [])]) as string[],
      }),
      aiWorkflow: async (name: string) => (await workspace.getWorkflowMetadata(name))?.publisher === AI_PUBLISHER,
    });
    Object.defineProperty(services, "reach", { value: policy, enumerable: true, writable: false, configurable: false });
  }
  if (!(services as Record<string, unknown>)["authoring"]) {
    (services as Record<string, unknown>)["authoring"] = buildAuthoringCapability({
      workspace,
      dataDir,
      store,
      services,
      trackRun,
      claims: claimsAuthoring,
      verifier,
      publishingEnabled: !registryWasInjected,
      getRegistry: async () => {
        await rebuildRegistry();
        return registry;
      },
      ...(secretsInjected ? {} : { secrets: secretStore }),
      ...(reach ? { reach } : {}),
      // Defined further down; called only once a run is going.
      resumeRun: (name, runId, body) => resumeRun(name, runId, body),
    });
  }

  const app = new Hono();
  // `?key=` (below) and a channel socket's `?ticket=` never reach the log.
  app.use(logger((line, ...rest) => console.log(line.replace(/([?&](?:key|ticket)=)[^&\s]*/g, "$1…"), ...rest)));
  // gzip/br for a client that accepts it. A chat transcript is megabytes of
  // JSON, and nothing in front of strut compresses: over a 400 KB/s link
  // 2.8 MB took 7 s raw (swarm38, 2026-09-30). SSE is skipped by content
  // type, so the streams flush event by event as before.
  app.use(compress());

  // ── Auth ─────────────────────────────────────────────────────────────────
  //
  // With `STRUT_API_KEY` set, NOTHING is served without it — reads included
  // (a run's events, a transcript, an artifact are the deployment's data).
  // This one gate is in front of every route, those a host mounts on `app`
  // later too. Two things pass: `/health`, which tells a probe `{ ok: true }`
  // and nothing else, and the UI's own files — they hold no data, and a
  // person has to load the page to give it the key. A third opens with a
  // FILE TOKEN in place of the key (`carriesFileToken`, auth.ts): a read of
  // one run's artifacts or one job's files, with the token their listing
  // minted for that scope — what the UI's links carry, since a browser
  // cannot set a header on them and the key must never sit in a URL a
  // served page can read.
  //
  // Past the credential, the SCOPE (plans/federation.md §3): a `peer` —
  // another strut, holding `STRUT_PEER_KEY` or a person token (scope
  // `peer:person`) or whatever the host's `resolveScope` maps (mcp's
  // `lab:peer` JWT) — may read every route,
  // launch a run, and cancel / pause / resume one; the control routes then
  // refuse it a run no peer launched. Anything else is 403, a route a host
  // mounts later included. Launch is not narrowed by workflow: a workflow
  // whose agent has `bash` reaches whatever the server can (decided
  // 2026-10-09, plan as written).
  //
  // A fourth: the login itself. `POST /auth/session` trades the key for a
  // session cookie (auth.ts "Sessions") — the browser's credential from
  // then on, the key's equal to this gate (`carriesApiKey`) under the CSRF
  // rules `sessionOf` keeps — and `DELETE /auth/session` ends one; neither
  // needs a credential to be called. The login also takes a host's
  // sign-in ticket in place of the key; minting one (`POST /auth/ticket`)
  // is behind the key like any other route.
  //
  // A fifth: a CATALOG token (`catalogTokenOf`, auth.ts), a subscriber's
  // read of the catalog this strut published and of the archives it names
  // (plans/marketplace.md §12.1) — and, marked `?public=1`, a read of the
  // PUBLIC catalog and the archives it names with no credential at all
  // (`publicPackageRead`, auth.ts; §13 "One publisher, two keys"): the
  // routes serve nothing but what the public card lists, whatever the
  // gate's mode. With the INDEX role on, `GET /index/catalog`,
  // `/index/packages…` and `/index/concepts…` are open the same way — the
  // phone book and the search over public catalogs, public by construction
  // (§7) — and so are `GET /llms.txt` (the same store as a markdown page
  // for an agent that fetches URLs; llmstxt.org) and ONE POST,
  // `/index/mcp`: the same three reads as MCP tools for an agent with no
  // credential (src/packages/index-tools.ts); nothing on them installs or
  // writes. And a peer may POST one more route,
  // `/packages/subscriptions/sync`: it carries nothing, and makes this strut
  // read its own subscriptions' catalogs — what the publisher pings.
  //
  // One POST more for a PERSON's token (`peer:person`, never a plain peer):
  // `/mcp`, where it gets an app's `step_run` and nothing else — how a
  // person's own strut hosts an app that lives here (plans/apps.md §7.4).
  // `step_run` holds every call to the app's grants and runs as the viewer,
  // and a plain peer's actor is a header any strut sets. On a home box
  // (`homeSync: "box"`), home sync's `/home/pull` and `/home/push` too.
  // And `/voice/calls`, a call set up as that person (src/voice.ts).
  //
  // A sixth: a CHANNEL TICKET (`channelTicketOf`, auth.ts) opens the one
  // read it was minted for, `GET /channels` — a browser host's upgrade of
  // an app's channel socket (plans/app-channels.md §2), which carries no
  // other credential: Hive's page has none.
  //
  // And a MEMBER's session (plans/member-rights.md; auth.ts "Sessions"):
  // a person a host signed in as `member` uses apps and nothing else. It
  // passes exactly the routes strut's page calls to show an app alone
  // (`?app=<name>&solo=1`), `MEMBER_ROUTES`, and every other route is 403 —
  // reads included, and a route a host mounts later. On `/mcp` it gets an
  // app's `step_run` alone, as itself, the way a person token does.
  const UI_FILE = /^\/($|index\.html$|favicon\.ico$|assets\/)/;
  const PROPOSAL_DECIDE = /^\/proposals\/[^/]+\/decide$/;
  const CONVERSATION_POSTS = new Set(["/conversations/update", "/conversations/fork"]);
  const PEER_POST = /^\/workflows\/[^/]+\/(?:[^/]+\/run|run|runs\/[^/]+\/(?:cancel|pause|resume))$/;
  /** What a member's session may call: the page of one app, its calls, its
   *  channels, and a file it hands the side panel. `GET /brand` is the
   *  style the app is shown in; `GET` and `DELETE /mcp` answer 405 (the
   *  page's MCP client asks for a stream once). */
  const MEMBER_ROUTES: Array<[method: string, path: RegExp]> = [
    ["GET", /^\/auth\/session$/],
    ["GET", /^\/apps$/],
    ["GET", /^\/apps\/[^/]+\/versions$/],
    ["GET", /^\/apps\/[^/]+\/[^/]+\/files(?:\/.+)?$/],
    ["GET", /^\/brand$/],
    ["POST", /^\/mcp$/],
    ["GET", /^\/mcp$/],
    ["DELETE", /^\/mcp$/],
    ["POST", /^\/apps\/[^/]+\/channel-ticket$/],
    ["GET", /^\/artifacts\/[^/]+(?:\/.+)?$/],
    ["GET", /^\/jobs\/[^/]+\/files(?:\/.+)?$/],
  ];
  const memberMay = (method: string, path: string) =>
    MEMBER_ROUTES.some(([m, re]) => (m === method || (m === "GET" && method === "HEAD")) && re.test(path));
  app.use("*", async (c, next) => {
    const path = c.req.path;
    const read = c.req.method === "GET" || c.req.method === "HEAD";
    // `/public/*` (src/public-routes.ts): what a person made public, served
    // from the surface alone, so open to anyone — reads and a browser's
    // preflight for them.
    const open = read
      ? path === "/health" || (serveUi && UI_FILE.test(path)) || carriesFileToken(c) || !!catalogTokenOf(c) || publicPackageRead(c) || (!!indexConfig && INDEX_READ.test(path)) || PUBLIC_PATH.test(path) || !!channelTicketOf(c)
      : (path === "/auth/session" && (c.req.method === "POST" || c.req.method === "DELETE")) || (!!indexConfig && path === INDEX_MCP && c.req.method === "POST") || (c.req.method === "OPTIONS" && PUBLIC_PATH.test(path)) || (c.req.method === "POST" && path === "/public/mcp");
    if (open) return next();
    if (memberOnly(c)) {
      if (memberMay(c.req.method, path)) return next();
      return c.json({ error: "forbidden: a member's session opens the apps here and nothing else; ask an admin for the rest" }, 403);
    }
    if (!carriesApiKey(c) && !carriesPeerKey(c) && !personOf(c)) return unauthorized(c);
    if (!read) {
      const scope = await scopeOf(c);
      const post = c.req.method === "POST";
      const personPost = scope === "peer:person" && (path === "/mcp" || path === VOICE_CALLS || (homeRole === "box" && HOME_POSTS.has(path)) || PROPOSAL_DECIDE.test(path) || CONVERSATION_POSTS.has(path));
      if (isPeerScope(scope) && !(post && (PEER_POST.test(path) || path === "/packages/subscriptions/sync" || personPost))) {
        return c.json({ error: "forbidden: a peer may read, launch a run, control a run a peer launched, and ask this strut server to sync its subscriptions; a person's token may also call an app's step_run on /mcp, start a voice call, decide the proposals it made and change or fork its conversations" }, 403);
      }
    }
    return next();
  });

  // ── Sessions (auth.ts "Sessions") ──────────────────────────────────────

  // The login. A matching key buys an HttpOnly cookie for `STRUT_SESSION_HOURS`
  // naming who signed in; the page never sees the key again. A wrong key
  // is a 401 after a pause — the one route that takes guesses. With no
  // key configured there is nothing to sign in to.
  app.post("/auth/session", async (c) => {
    if (!bootEnv()["STRUT_API_KEY"]) return c.json({ error: "STRUT_API_KEY is not set: nothing to sign in to" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { key?: unknown; actor?: unknown; ticket?: unknown };
    // A host's sign-in ticket (auth.ts "Sign-in tickets"): the same cookie,
    // naming the ticket's actor — never a field beside it. No pause: a
    // ticket is signed, so there is nothing to guess.
    if (body.ticket !== undefined) {
      const redeemed = typeof body.ticket === "string" ? redeemSignInTicket(body.ticket.trim()) : undefined;
      if (!redeemed) return c.json({ error: "unauthorized: this sign-in ticket has expired, was already used, or is not this strut's" }, 401);
      c.header("set-cookie", sessionCookie(redeemed.token, redeemed.session.exp, isSecureRequest(c)));
      return c.json(redeemed.session);
    }
    const key = typeof body.key === "string" ? body.key : "";
    const actor = typeof body.actor === "string" ? body.actor.trim() : "";
    if (body.actor !== undefined && (typeof body.actor !== "string" || actor.length > 120 || /[\r\n]/.test(actor))) {
      return c.json({ error: "actor must be a short string" }, 400);
    }
    const issued = key ? issueSession(key, actor || undefined) : undefined;
    if (!issued) {
      await new Promise((r) => setTimeout(r, 500));
      return c.json({ error: "unauthorized: that is not STRUT_API_KEY" }, 401);
    }
    c.header("set-cookie", sessionCookie(issued.token, issued.session.exp, isSecureRequest(c)));
    return c.json(issued.session);
  });

  // The session this request spends, for the UI to show who is signed in
  // and as what (`role`: a host's ticket's; none for the key login); 404
  // for a request the key or nothing authenticated.
  app.get("/auth/session", (c) => {
    const session = sessionOf(c);
    return session ? c.json(session) : c.json({ error: "no session" }, 404);
  });

  // Sign out: the cookie is cleared. The token itself stays valid until
  // its expiry — it is stateless — but no browser holds it any more.
  app.delete("/auth/session", (c) => {
    c.header("set-cookie", sessionCookie(undefined, 0, isSecureRequest(c)));
    return c.body(null, 204);
  });

  // A SIGN-IN TICKET (auth.ts "Sign-in tickets"): a host's server, holding
  // the key, signs one person into the UI it frames as `?ticket=` — good
  // once, for a minute. A `full` caller mints it (the gate keeps a peer, a
  // person token and a member off every POST but theirs); the actor and
  // the role are the host's to name, as with `x-strut-actor` beside the
  // key. No role is a member's (plans/member-rights.md): a host that does
  // not say signs nobody in with the console.
  app.post("/auth/ticket", async (c) => {
    if (!bootEnv()["STRUT_API_KEY"]) return c.json({ error: "STRUT_API_KEY is not set: nothing to sign in to" }, 400);
    const body = await c.req.json<{ actor?: unknown; role?: unknown }>().catch(() => ({}) as { actor?: unknown; role?: unknown });
    const actor = typeof body.actor === "string" ? body.actor.trim() : "";
    if (!actor || actor.length > 120 || /[\r\n]/.test(actor)) {
      return c.json({ error: "actor is required: a short string, the person the ticket signs in" }, 400);
    }
    const role = body.role ?? "member";
    if (!isRole(role)) return c.json({ error: 'role must be "admin" or "member": an admin runs this strut server, a member uses its apps' }, 400);
    const minted = signInTicket(actor, role)!;
    c.header("cache-control", "no-store");
    return c.json({ ticket: minted.ticket, expiresAt: minted.exp });
  });

  // ── Workflows ────────────────────────────────────────────────────────────

  app.get("/workflows", async (c) => {
    // The workspace lists what it stores; the run store decorates with each
    // workflow's newest run time. Composed here so neither layer reads the
    // other's records. `?q=` filters like the sidebar: every word must hit
    // the name, the category or the description; name hits rank first.
    const workflows = searchWorkflows(await workspace.listWorkflows(), c.req.query("q") ?? "");
    const decorated = await Promise.all(
      workflows.map(async (w) => {
        const lastRunAt = await store.lastRunAt(w.name);
        return lastRunAt != null ? { ...w, lastRunAt } : w;
      }),
    );
    return c.json(decorated);
  });

  // A publish over HTTP carries its contract as the YAML's `claims:` block
  // (or `claims` beside `steps`) — a PERSON's publish, stamped like the
  // Claims panel's edits. What the block NAMES is validated before the
  // publish where a claims layer exists, so a broken contract blocks it the
  // way a YAML error does; its shape is the workspace's own check. A block
  // that does not even parse is left to the publish, whose refusal carries
  // the workspace's fuller message.
  const httpContract = async (body: { yaml?: string; claims?: ClaimsBlock }): Promise<{ contract?: ClaimsBlock; error?: string }> => {
    if (!claimsAuthoring) return {};
    let contract: ClaimsBlock | undefined;
    try {
      contract = body.yaml ? claimsBlockOf(body.yaml) : readClaimsBlock({ claims: body.claims });
    } catch {
      return {};
    }
    if (!contract) return {};
    const invalid = await claimsAuthoring.validateClaimsArg(contract, PERSON);
    return invalid ? { error: `Nothing was published — fix the claims first. ${invalid.error}` } : { contract };
  };

  /** A version published over HTTP is `api`, or `ui` when the web UI says so
   *  — the only source a request may name (`seed` etc. are other doors'). */
  const httpPublishOptions = (source: string | undefined, actor: string | undefined): PublishOptions => ({
    source: source === "ui" ? "ui" : "api",
    ...(actor ? { actor } : {}),
  });

  app.post("/workflows", async (c) => {
    const body = await c.req.json<{
      name: string;
      steps?: any[];
      input?: InputBlock;
      params?: Record<string, unknown>;
      claims?: ClaimsBlock;
      sealed?: boolean;
      peer?: boolean | PeerOpen;
      yaml?: string;
      description?: string;
      category?: string;
      source?: string;
    }>();

    if (!body.name) return c.json({ error: "name is required" }, 400);
    const { contract, error: contractError } = await httpContract(body);
    if (contractError) return c.json({ error: contractError }, 400);

    const actor = await resolveActor(c);
    const opts = httpPublishOptions(body.source, actor);
    let result;
    try {
      if (body.yaml) {
        result = await workspace.createWorkflow(body.name, body.yaml, body.description, body.category, undefined, opts);
      } else if (body.steps) {
        result = await workspace.createWorkflow(
          body.name,
          {
            steps: body.steps,
            ...(body.input != null ? { input: body.input } : {}),
            ...(body.params != null ? { params: body.params } : {}),
            ...(body.claims != null ? { claims: body.claims } : {}),
            ...(body.sealed != null ? { sealed: body.sealed } : {}),
            ...(body.peer != null ? { peer: body.peer } : {}),
          },
          body.description,
          body.category,
          undefined,
          opts,
        );
      } else {
        return c.json({ error: "either steps or yaml is required" }, 400);
      }
    } catch (err) {
      // What the workspace refuses (an unquoted template, a bad `input:`
      // block) is the author's to fix — hand the message back, not a 500.
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    await adoptWorkflow(result.name, actor);
    await rebuildRegistry();
    const applied = contract ? await claimsAuthoring!.applyClaimsArg({ kind: "workflow", name: result.name }, contract, PERSON) : undefined;

    return c.json(
      {
        ok: true,
        workflow: result.name,
        version: result.version,
        active: result.version,
        renamed: result.name !== body.name,
        requested: body.name,
        ...(applied ? { claims: applied } : {}),
      },
      201,
    );
  });

  app.get("/workflows/:name", async (c) => {
    const name = c.req.param("name");
    const meta = await workspace.getWorkflowMetadata(name);
    if (!meta) return c.json({ error: `Workflow "${name}" not found` }, 404);
    return c.json(meta);
  });

  // Every run executing in THIS process, across workflows — the sidebar's
  // running dot. Read off the controllers map, so it is cheap to poll; a run
  // cut off by a crash has no controller and is not listed.
  app.get("/runs/active", (c) =>
    c.json([...controllers.values()].map((r) => ({
      workflow: r.workflow,
      runId: r.runId,
      state: r.state,
      ...(r.parent ? { parentRunId: r.parent.runId } : {}),
      ...liveJob(r),
    }))),
  );

  // A page of the workflow's runs, newest first: `?limit=` (50, at most 500)
  // after `?before=<runId>`, the last row of the page before (`runsPage`).
  // A workflow on a swarm has thousands of runs, and each row is a summary
  // read from its own file, so only the page's are read.
  app.get("/workflows/:name/runs", async (c) => {
    const name = c.req.param("name");
    const page = runsPage(await store.listRuns(name), { limit: c.req.query("limit"), before: c.req.query("before") });
    const runs = await Promise.all(page.map(async (runId) =>
      (await store.getRunSummary(name, runId)) ??
        { runId, workflow: name, status: liveStatus(name, runId), ...liveJob(controllers.get(`${name}/${runId}`)) }));
    return c.json(runs);
  });

  app.get("/workflows/:name/runs/:runId", async (c) => {
    const { name, runId } = c.req.param();
    const summary = await store.getRunSummary(name, runId);
    if (summary) return c.json(summary);
    // No run.json — in-flight, or orphaned before finalize (crash/restart).
    // The event log is durable per-step, so serve a summary reconstructed
    // from it (`partial: true` is the discriminator) instead of a 404: a
    // 17-hour run that dies mid-generation must not cost its whole report.
    const events = await store.getRunEvents(name, runId);
    const partial = summarizeFromEvents(name, runId, events, liveStatus(name, runId));
    if (!partial) {
      return c.json({ error: `Run "${runId}" not found for workflow "${name}"` }, 404);
    }
    return c.json(partial);
  });

  /** An event as the run read endpoints serve it: an agent session (can be
   *  megabytes) becomes a `transcript` link to fetch, never inline. */
  const withTranscriptLink = (workflow: string, e: RunEvent) => {
    if (!e.messages) return e;
    const { messages: _, ...rest } = e;
    return { ...rest, transcript: transcriptUrl(workflow, e.runId, e.path) };
  };

  app.get("/workflows/:name/runs/:runId/events", async (c) => {
    const { name, runId } = c.req.param();
    const events = await store.getRunEvents(name, runId);
    return c.json(events.map((e) => withTranscriptLink(name, e)));
  });

  // A run's declared deliverables (plans/jobs.md §3), resolved as the run
  // callback resolves them — for a host that missed the callback.
  app.get("/workflows/:name/runs/:runId/artifacts", async (c) => {
    const { name, runId } = c.req.param();
    const summary = await store.getRunSummary(name, runId);
    if (!summary) return c.json({ error: `Run "${runId}" of "${name}" has no summary yet` }, 404);
    const refs = (await artifactRefs(runId, summary.output, summary.job)) ?? [];
    return c.json({ workflow: name, runId, ...(summary.job ? { job: summary.job } : {}), artifacts: refs });
  });

  // What one run proposed (plans/proposals.md §6) — the `run.end` field's
  // twin, for a host that missed the callback. Read from the records, so a
  // run still going lists what it has proposed so far.
  app.get("/workflows/:name/runs/:runId/proposals", async (c) => {
    const { name, runId } = c.req.param();
    const scope = await scopeOf(c);
    const actor = await resolveActor(c);
    const proposals = (await listProposals(proposalsRoot(dataDir), { runId, viewer: { scope, ...(actor ? { actor } : {}) } })).filter((p) => p.by.workflow === name).map(briefOf);
    return c.json({ workflow: name, runId, proposals });
  });

  /** One agent session by step path — what the transcript route serves and
   *  `run/transcript` (the runs capability below) returns — or why not. */
  const readTranscript = async (
    workflow: string,
    runId: string,
    path: string,
    full: boolean,
  ): Promise<{ messages: unknown[]; full?: true } | { error: string }> => {
    const events = await store.getRunEvents(workflow, runId);
    const end = events.filter((e) => e.type === "step.end" && e.path === path && e.messages).pop();
    if (!end) return { error: `No transcript at "${path}" in run "${runId}"` };
    const at = (end.output as { session?: { id?: unknown; offset?: unknown } } | null | undefined)?.session;
    if (!full || typeof at?.id !== "string" || typeof at.offset !== "number") return { messages: end.messages! };
    const thread = sessionsInjected ? null : await sessionStore.load(at.id).catch(() => null);
    if (!thread) return { error: `Session "${at.id}" is gone` };
    const [system, ...turn] = end.messages!;
    return { messages: [system, ...thread.messages.slice(0, at.offset), ...turn], full: true };
  };

  // One agent session from a run, by step path (`wf/review`, a sub-agent's
  // `wf/review/003-agent`): the `messages` of that path's last `step.end`,
  // as a bare JSON array. What the run callback's `transcripts` point at, so
  // a host copies each transcript byte-for-byte without parsing `/events`.
  //
  // A session turn (plans/agent-sessions.md) recorded its system prompt and
  // THAT TURN; `?full=1` serves the thread up to and including it, read from
  // the session store.
  app.get("/workflows/:name/runs/:runId/transcripts/:path{.+}", async (c) => {
    const { name, runId, path } = c.req.param();
    const t = await readTranscript(name, runId, path, c.req.query("full") === "1");
    return "error" in t ? c.json({ error: t.error }, 404) : c.json(t.messages);
  });

  // Reattach to a run (live or completed) — SSE tail of its event log.
  // Replays history from the start of the file, then follows appends until
  // the terminal event, then sends a final `done` carrying the RunResult.
  // One path serves in-flight and finished runs (see `RunStore.tailEvents`).
  //
  // `?skip=N` leaves out the first N events: the client read them from
  // `GET …/events` (one compressed response) and only wants what follows.
  // SSE is never compressed and each event is its own frame, so replaying
  // a big log through the tail is slow (swarm38, 2026-10-03); the UI reads
  // the log first and tails from its end.
  app.get("/workflows/:name/runs/:runId/stream", async (c) => {
    const { name, runId } = c.req.param();
    const skip = Number(c.req.query("skip") ?? 0);
    if (!Number.isInteger(skip) || skip < 0) {
      return c.json({ error: "skip must be a non-negative integer" }, 400);
    }
    return streamSSE(c, async (stream) => {
      const ac = new AbortController();
      stream.onAbort(() => ac.abort());
      for await (const event of store.tailEvents(name, runId, {
        signal: ac.signal,
        skip,
        // A resumed run appends past its old terminal event — keep following
        // while a live controller exists (§5.2 tail terminality).
        stillLive: () => controllers.has(`${name}/${runId}`),
        // A log with no terminal event and no controller is a STALE run
        // (cut off by a crash, not resumed): close with `done { status:
        // "stale" }` instead of following it forever — a peer's
        // `strut/run-workflow` waits on this tail (plans/federation.md
        // §2.2). A run not yet launched is never this: `trackRun` registers
        // the controller before the 202 that names the run.
        live: () => controllers.has(`${name}/${runId}`),
      })) {
        await stream.writeSSE({ data: JSON.stringify(withTranscriptLink(name, event)) });
      }
      if (ac.signal.aborted) return;
      const summary = await store.getRunSummary(name, runId);
      const result = summary
        ? { runId, status: summary.status, output: summary.output, error: summary.error }
        : { runId, status: liveStatus(name, runId) };
      await stream.writeSSE({ event: "done", data: JSON.stringify(result) });
    });
  });

  // ── Run control (RUN_CONTROL_SPEC §3–§5) ────────────────────────────────
  //
  // Cancel / pause / resume act on the LIVE controller (whole subtree via the
  // effective-state walk); resume additionally covers DURABLE resume (§5):
  // with no live controller, it replays the journal of a "stale" (crashed),
  // `error`, or `cancelled` run — or, with `from`, re-runs a completed run
  // from a chosen step.

  /** The stored workflow version whose content hash is `hash`, or null.
   *  Lets a durable resume run against the exact DAG a run executed when
   *  the active version has since moved on (§5 validity guard). */
  const findWorkflowVersionByHash = async (name: string, hash: string): Promise<string | null> => {
    const meta = await workspace.getWorkflowMetadata(name);
    if (!meta) return null;
    // Prefer the active version when it matches; then newest first so a
    // republished identical version wins over an older twin.
    const labels = Object.keys(meta.versions).sort((a, b) => b.localeCompare(a));
    for (const v of [meta.active, ...labels]) {
      if ((await workspace.getWorkflowHash(name, v)) === hash) return v;
    }
    return null;
  };

  type PreparedResume = {
    ok: true;
    name: string;
    runId: string;
    flow: Flow;
    version?: string;
    /** Top-level steps that re-run because the resume moved the run onto
     *  another version and they changed (`changedSteps`). */
    changed?: string[];
    journal: Record<string, unknown>;
    runStart: NonNullable<ReturnType<typeof readRunStart>>;
    events: RunEvent[];
    /** The callback the launch recorded (`RunStore.setRunCallback`). */
    callback?: { url: string };
    /** The caller's MCP servers the launch recorded (`RunStore.setRunMcp`). */
    mcp?: McpServer[];
  };
  type ResumeRefusal = { ok: false; status: 400 | 404 | 409 | 413; error: string };

  /** The refusal for a run log past `resumeMaxLogBytes`, or null — asked
   *  BEFORE the log is read, since reading it is what the cap prevents. */
  const logTooBig = async (name: string, runId: string): Promise<string | null> => {
    const size = await store.logSize(name, runId);
    if (size <= resumeMaxLogBytes) return null;
    return (
      `run log is ${fmtBytes(size)}, over the ${fmtBytes(resumeMaxLogBytes)} resume cap ` +
      `(STRUT_RESUME_MAX_LOG_BYTES) — not loaded`
    );
  };

  /** Everything a durable resume (§5) needs, or a refusal with the HTTP
   *  status it maps to. Shared by the resume endpoint and boot-time
   *  auto-resume (§5.3). Heals a torn log, recovers the run's input/params
   *  from `run.start`, resolves the DAG the run actually executed, and
   *  builds (optionally `from`-invalidated) the journal. */
  const prepareDurableResume = async (
    name: string,
    runId: string,
    body: { from?: string; force?: boolean; version?: string },
  ): Promise<PreparedResume | ResumeRefusal> => {
    // Crash hardening (§5.1): a kill mid-append leaves a torn final line.
    // Heal it BEFORE reading, or the resumed run's first append would be
    // glued onto the fragment and the whole log would turn unreadable.
    if (await store.repairLog?.(name, runId)) {
      console.warn(`[run ${runId}] repaired a torn event log before resume`);
    }
    const big = await logTooBig(name, runId);
    if (big) return { ok: false, status: 413, error: big };
    const events = await store.getRunEvents(name, runId);
    const runStart = readRunStart(events);
    if (!runStart) {
      return { ok: false, status: 409, error: "Run log has no run.start event — cannot resume" };
    }

    let flow: Flow;
    let version: string | undefined;
    try {
      flow = await workspace.getWorkflow(name);
    } catch (err) {
      return { ok: false, status: 404, error: err instanceof Error ? err.message : String(err) };
    }
    // A disabled workflow refuses a resume like any launch; boot's auto-resume
    // reports it skipped, and a person resumes it once it is enabled again.
    const disabled = await workflowDisabled(workspace, name);
    if (disabled) return { ok: false, status: 409, error: disabled };

    let changed: string[] | undefined;
    let journal = buildJournal(events);
    if (body.version !== undefined) {
      // §5.4: onto ANOTHER version — "active" or a label — so a fix to the
      // workflow reaches a run that failed. The two versions are compared
      // step by step: what changed re-runs with everything downstream of
      // it, the rest replays.
      const meta = await workspace.getWorkflowMetadata(name);
      const label = body.version === "active" ? meta?.active : body.version;
      if (!label || !meta?.versions[label]) {
        return { ok: false, status: 404, error: `Workflow "${name}" has no version "${body.version}"` };
      }
      const target = await workspace.getWorkflowVersion(name, label);
      const targetHash = await workspace.getWorkflowHash(name, label);
      const ran = runStart.workflowHash ? await findWorkflowVersionByHash(name, runStart.workflowHash) : null;
      if (ran && targetHash !== runStart.workflowHash) {
        changed = changedSteps(await workspace.getWorkflowVersion(name, ran), target);
        journal = invalidateSteps(journal, changed, target).journal;
      } else if (!ran && targetHash !== runStart.workflowHash && !body.force) {
        return {
          ok: false,
          status: 409,
          error:
            `The version this run executed is no longer on record, so which of its steps changed in ${label} ` +
            `cannot be told — pass { force: true } to replay its journal into ${label} as it is, or { from } to ` +
            `re-run from a step.`,
        };
      }
      flow = target;
      version = label;
    }
    // Validity guard (§5): replaying outputs into a DIFFERENT DAG is
    // undefined. When the active version's hash differs from the one
    // the run executed, resume against that version if it is still on
    // record (a run of a pinned or since-superseded version must not
    // dead-end on "content changed"); refuse only when no stored version
    // matches, unless forced. A resume that names a `version` (above)
    // decided already.
    const currentHash = body.version !== undefined ? undefined : await workspace.getWorkflowHash(name);
    if (runStart.workflowHash && currentHash && runStart.workflowHash !== currentHash) {
      const pinned = await findWorkflowVersionByHash(name, runStart.workflowHash);
      if (pinned) {
        flow = await workspace.getWorkflowVersion(name, pinned);
        version = pinned;
      } else if (!body.force) {
        return {
          ok: false,
          status: 409,
          error:
            `Workflow content changed since this run started (recorded ${runStart.workflowHash}, ` +
            `active ${currentHash}) and no stored version matches — replaying its journal into a ` +
            `different DAG is refused. Pass { force: true } to override.`,
        };
      }
    }
    if (!runStart.workflowHash) {
      console.warn(
        `[run ${runId}] no workflow hash recorded at run.start (pre-run-control log) — resuming without the DAG guard`,
      );
    }

    if (body.from) {
      try {
        const inv = await invalidateFrom(journal, body.from, flow, workspace);
        journal = inv.journal;
        for (const w of inv.warnings) console.warn(`[run ${runId}] resume from=${body.from}: ${w}`);
      } catch (err) {
        return { ok: false, status: 400, error: err instanceof Error ? err.message : String(err) };
      }
    }
    // The resumed run posts `run.end` the way the launch would have: the
    // URL is the store's, beside the log, never in it.
    const url = await store.getRunCallback(name, runId);
    const mcp = await store.getRunMcp(name, runId);
    return {
      ok: true,
      name,
      runId,
      flow,
      version,
      ...(changed ? { changed } : {}),
      journal,
      runStart,
      events,
      ...(url ? { callback: { url } } : {}),
      ...(mcp?.length ? { mcp } : {}),
    };
  };

  /** Relaunch a prepared durable resume under its ORIGINAL runId (§5). */
  const launchDurableResume = (p: PreparedResume) => {
    launchDetached(
      p.flow,
      {
        input: p.runStart.input,
        runId: p.runId,
        params: p.runStart.params,
        paramOverrides: p.runStart.paramOverrides,
        ...(p.runStart.job ? { job: p.runStart.job } : {}),
        ...(p.runStart.conversation ? { conversation: p.runStart.conversation } : {}),
        ...(p.runStart.wakeAsked ? { wake: true } : {}),
      },
      {
        journal: p.journal,
        resume: true,
        ...(p.version ? { version: p.version } : {}),
        ...(p.changed ? { resumeChanged: p.changed } : {}),
        ...(p.runStart.automation ? { origin: "schedule" as const, automation: p.runStart.automation } : {}),
        ...(p.runStart.origin === "peer" ? { origin: "peer" as const } : {}),
        ...(p.runStart.origin === "peer" && p.runStart.peerPerson ? { peerPerson: true } : {}),
        ...(p.runStart.continues ? { continues: p.runStart.continues } : {}),
        // An app's run stays the app's: its sessions under the app's
        // namespace (runner.ts `bindApp`), never the ids its page passed.
        ...(p.runStart.origin === "app" && p.runStart.app ? { origin: "app" as const, app: p.runStart.app } : {}),
        ...(p.runStart.startedBy ? { startedBy: p.runStart.startedBy } : {}),
        ...(p.runStart.wake ? { wake: p.runStart.wake } : {}),
        // Billed to whoever the original launch was billed to — never
        // re-derived, the owner may have changed since (§2).
        ...(p.runStart.actor ? { actor: p.runStart.actor } : {}),
        ...(p.runStart.principal ? { principal: p.runStart.principal } : {}),
        ...(p.callback ? { callback: p.callback } : {}),
        ...(p.mcp ? { mcp: p.mcp } : {}),
        ...(p.runStart.attachments?.length ? { savedAttachments: p.runStart.attachments } : {}),
      },
    );
  };

  const isTerminalEvent = (e: RunEvent) =>
    e.type === "run.end" || e.type === "run.error" || e.type === "run.cancelled";

  /** Write the summary a dead run never got to write: its log already ends
   *  in a terminal event (crash between the event append and `finalize`),
   *  or it was cancelling when the process died (finalize as cancelled,
   *  appending the `run.cancelled` the boundary would have emitted). The
   *  dead process never posted its `run.end` either: the host hears it now.
   *  Returns the callback URL it posts to, if any. */
  const finalizeDeadRun = async (
    name: string,
    runId: string,
    events: RunEvent[],
    status: "success" | "error" | "cancelled",
  ): Promise<string | null> => {
    const last = events[events.length - 1]!;
    const start = events.find((e) => e.type === "run.start");
    if (status === "cancelled" && last.type !== "run.cancelled") {
      await store.append(name, runId, { ts: new Date().toISOString(), runId, path: name, type: "run.cancelled" });
    }
    const summary = summaryFromLog(name, runId, events, status);
    const { output, error, durationMs } = summary;
    await store.finalize(name, runId, summary);
    const url = await store.getRunCallback(name, runId);
    // A job turn's end the dead process never woke on wakes now; a wake
    // turn's is the boot reconcile's (src/wake.ts).
    const res: RunResult = { runId, status, ...(output !== undefined ? { output } : {}), ...(error ? { error } : {}) };
    const session = (start?.input as Record<string, unknown> | undefined)?.["session"];
    const wake = start?.wake ?? (await wakeOnEnd(name, res, {
      ...(start?.job ? { job: start.job } : {}),
      ...(start?.startedBy ? { startedBy: start.startedBy } : {}),
      ...(start?.conversation ? { conversation: start.conversation } : {}),
      ...(start?.wakeAsked ? { asked: true } : {}),
      ...(start?.actor ? { actor: start.actor } : {}),
      ...(start?.principal ? { principal: start.principal } : {}),
      ...(typeof session === "string" ? { session } : {}),
    }));
    if (url) postRunCallback(url, name, res, Date.now() - durationMs, start?.job, start?.startedBy, wake);
    return url;
  };

  /** Boot-time auto-resume (RUN_CONTROL_SPEC §5.3). Every run that died
   *  with a process has a log and no summary. Root runs only (children are
   *  relaunched by their parent's re-executed step), newest first: with
   *  `since` — the boot scan passes when the previous process started —
   *  EVERY root run the last death cut off; without it, the newest root run
   *  of each workflow only. For each:
   *    - log already terminal → just write the missing summary;
   *    - last control marker `run.cancelling` → finalize as cancelled;
   *    - last control marker `run.paused` → leave parked (a human chose that);
   *    - older than `maxAgeMs`, or resumed ≥ `maxResumes` times → skip, loudly;
   *    - otherwise → durable resume, same path as the endpoint.
   *  A run whose last event is before `since` was cut off by an earlier
   *  death, which the boot after it already looked at: left alone. */
  const autoResumeStaleRuns = async (o: AutoResumeOptions = {}): Promise<AutoResumeOutcome[]> => {
    const maxAgeMs = o.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
    const maxResumes = o.maxResumes ?? 5;
    const since = o.since;
    const out: AutoResumeOutcome[] = [];
    const report = (workflow: string, runId: string, action: AutoResumeOutcome["action"], reason: string) => {
      out.push({ workflow, runId, action, reason });
      console.warn(`[auto-resume] ${workflow}/${runId}: ${action} — ${reason}`);
    };

    /** One run: `nested` when it is not a root run (the scan looks past it
     *  either way), else `seen`. */
    const consider = async (name: string, runId: string): Promise<"nested" | "seen"> => {
      if (controllers.has(`${name}/${runId}`)) return "seen"; // live in this process
      // Nothing written since the previous boot: an earlier death's, as the
      // `since` check below would find — known without reading the summary
      // or the log, so a boot touches only the runs the last process did.
      // The slack covers a filesystem that keeps mtimes to the second.
      if (since !== undefined) {
        const at = await store.logWrittenAt(name, runId);
        if (at !== null && at < since - LOG_MTIME_SLACK_MS) return "seen";
      }
      if (await store.getRunSummary(name, runId)) return "seen"; // finished → nothing was cut off
      await store.repairLog?.(name, runId);
      // Asked before the read: a log the process cannot hold is what
      // crashed it, and loading it again at every boot would again.
      const big = await logTooBig(name, runId);
      if (big) {
        report(name, runId, "skipped", big);
        return "seen";
      }
      const events = await store.getRunEvents(name, runId);
      const runStart = readRunStart(events);
      if (!runStart) return "seen"; // unreadable / empty — a human's call
      if (runStart.parentRunId) return "nested"; // its parent relaunches it

      const last = events[events.length - 1]!;
      if (since !== undefined && !(Date.parse(last.ts) >= since)) return "seen"; // an earlier death's
      if (isTerminalEvent(last)) {
        const status = last.type === "run.end" ? "success" : last.type === "run.error" ? "error" : "cancelled";
        const url = await finalizeDeadRun(name, runId, events, status);
        report(name, runId, "finalized", `log already ended in ${last.type}; wrote the missing summary${url ? `; run.end goes to ${callbackOrigin(url)}` : ""}`);
        return "seen";
      }
      const marker = [...events].reverse().find(
        (e) => e.type === "run.paused" || e.type === "run.resumed" || e.type === "run.cancelling",
      );
      if (marker?.type === "run.cancelling") {
        const url = await finalizeDeadRun(name, runId, events, "cancelled");
        report(name, runId, "finalized", `was cancelling when the process died; finalized as cancelled${url ? `; run.end goes to ${callbackOrigin(url)}` : ""}`);
        return "seen";
      }
      if (marker?.type === "run.paused") {
        report(name, runId, "skipped", "was paused when the process died — resume it by hand");
        return "seen";
      }
      const ageMs = Date.now() - Date.parse(last.ts);
      if (!(ageMs <= maxAgeMs)) {
        report(name, runId, "skipped", `last event ${Math.round(ageMs / 3_600_000)}h ago exceeds the ${Math.round(maxAgeMs / 3_600_000)}h age cap`);
        return "seen";
      }
      // Durable resumes only: an unpause of a live run (`live`) is no restart.
      const resumes = events.filter((e) => e.type === "run.resumed" && !e.live).length;
      if (resumes >= maxResumes) {
        report(name, runId, "skipped", `already resumed ${resumes} times (cap ${maxResumes}) — a step may be crashing the server; resume by hand`);
        return "seen";
      }
      const prepared = await prepareDurableResume(name, runId, {});
      if (!prepared.ok) {
        report(name, runId, "skipped", prepared.error);
        return "seen";
      }
      if (controllers.has(`${name}/${runId}`)) return "seen";
      launchDurableResume(prepared);
      report(
        name,
        runId,
        "resumed",
        `replaying ${Object.keys(prepared.journal).length} journaled step(s)${prepared.version ? ` against version ${prepared.version}` : ""}${prepared.callback ? `; run.end goes to ${callbackOrigin(prepared.callback.url)}` : ""}`,
      );
      return "seen";
    };

    let workflows: Array<{ name: string }>;
    try {
      workflows = await workspace.listWorkflows();
    } catch (err) {
      console.error(`[auto-resume] could not list workflows:`, err);
      return out;
    }

    for (const { name } of workflows) {
      let runIds: string[];
      try {
        runIds = await store.listRuns(name); // newest first
      } catch {
        continue;
      }
      for (const runId of runIds) {
        let seen: "nested" | "seen";
        try {
          seen = await consider(name, runId);
        } catch (err) {
          // One run that cannot be read or relaunched never stops the others.
          console.error(`[auto-resume] ${name}/${runId}:`, err);
          seen = "seen";
        }
        if (seen === "seen" && since === undefined) break;
      }
    }
    return out;
  };

  /** Resolve a control request target: its live controller (if any) and
   *  whether the run exists at all. */
  const findRun = async (name: string, runId: string) => {
    const key = `${name}/${runId}`;
    const events = await store.getRunEvents(name, runId);
    // A run whose log already ends in a terminal event is only tearing down
    // (`onRunEnd`) until its controller is released. Wait for that, briefly,
    // so a finished run never reads as live — a control request in that
    // window would otherwise "resume in memory" a run that has ended and
    // append a stray marker to its log.
    const last = events[events.length - 1];
    if (last && isTerminalEvent(last)) {
      const deadline = Date.now() + 2000;
      while (controllers.has(key) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    }
    const controller = controllers.get(key) ?? null;
    const summary = await store.getRunSummary(name, runId);
    const byPeer =
      (controller != null && peerLaunched.has(controller)) ||
      events.find((e) => e.type === "run.start")?.origin === "peer";
    return { controller, summary, exists: controller != null || events.length > 0, byPeer };
  };
  /** A peer controls only the runs a peer launched (plans/federation.md §3). */
  const NOT_A_PEER_RUN = "forbidden: a peer may only control a run a peer launched";

  /** Cancel / pause / resume a run that is LIVE in this process — the shared
   *  core of the HTTP control endpoints and the chat builder's cancel_run /
   *  pause_run / resume_run tools. `status` is the HTTP code the endpoint
   *  answers with; the chat tool just relays ok/error. */
  const controlLiveRun = async (
    name: string,
    runId: string,
    action: "cancel" | "pause" | "resume",
    peer = false,
    force = false,
  ): Promise<
    | { ok: true; runId: string; state: string; quiesced?: boolean; status: 202 }
    | { ok: false; error: string; status: 403 | 404 | 409 }
  > => {
    const { controller, summary, exists, byPeer } = await findRun(name, runId);
    if (!exists) return { ok: false, error: `Run "${runId}" not found`, status: 404 };
    if (peer && !byPeer) return { ok: false, error: NOT_A_PEER_RUN, status: 403 };
    if (!controller) {
      return {
        ok: false,
        error: summary ? `Run already terminal (${summary.status})` : `Run is not live (stale) — nothing to ${action}`,
        status: 409,
      };
    }
    if (action === "cancel") {
      // `force` also abandons a step body that never returns (run-control.ts).
      if (force) controller.force();
      else controller.cancel();
      // Marker: if the process dies before the run reaches its boundary and
      // finalizes as `run.cancelled`, boot-time auto-resume must know this
      // run was being cancelled, not cut off (§5.3).
      await appendControlEvent(name, runId, "run.cancelling");
      return { ok: true, runId, state: controller.state, status: 202 };
    }
    if (action === "pause") {
      controller.pause();
      await appendControlEvent(name, runId, "run.paused");
      return { ok: true, runId, state: controller.state, quiesced: controller.quiesced(), status: 202 };
    }
    controller.resume();
    await appendControlEvent(name, runId, "run.resumed");
    return { ok: true, runId, state: controller.state, status: 202 };
  };
  /** The chat-tool view of controlLiveRun: same result minus the HTTP code. */
  const controlRunForChat = async (name: string, runId: string, action: "cancel" | "pause" | "resume", force = false) => {
    const { status: _status, ...rest } = await controlLiveRun(name, runId, action, false, force);
    return rest;
  };

  app.post("/workflows/:name/runs/:runId/cancel", async (c) => {
    const { name, runId } = c.req.param();
    const opts = await c.req.json<{ force?: boolean }>().catch(() => ({}) as { force?: boolean });
    const { status, ...body } = await controlLiveRun(name, runId, "cancel", await isPeer(c), opts.force === true);
    return c.json(body, status);
  });

  app.post("/workflows/:name/runs/:runId/pause", async (c) => {
    const { name, runId } = c.req.param();
    const { status, ...body } = await controlLiveRun(name, runId, "pause", await isPeer(c));
    return c.json(body, status);
  });

  type ResumeBody = { from?: string; force?: boolean; version?: string };
  type ResumeOutcome =
    | { ok: true; runId: string; resumed: "in-memory"; state: string; status: 202 }
    | { ok: true; runId: string; resumed: "journal"; replaying: number; version?: string; changed?: string[]; status: 202 }
    | { ok: false; error: string; status: 400 | 403 | 404 | 409 | 413 | 503 };

  /** Resume a run — the shared core of `POST …/resume`, the builder chat's
   *  `resume_run` and `meta/resume-run`. A LIVE run is unpaused (§4); a dead
   *  one (stale, error, cancelled — or a success, with `from`) is durably
   *  resumed under its own id (§5): its journal replays and the rest runs,
   *  on the version it executed or, with `version`, on another one with what
   *  changed re-run (§5.4). `peer` = the caller is another strut; `admit`
   *  may refuse a prepared resume before it launches. */
  const resumeRun = async (
    name: string,
    runId: string,
    body: ResumeBody,
    opts: { peer?: boolean; admit?: (p: PreparedResume) => Promise<string | null> } = {},
  ): Promise<ResumeOutcome> => {
    if (body.version !== undefined && (typeof body.version !== "string" || !body.version)) {
      return { ok: false, error: '`version` is "active" or a version label like "v5"', status: 400 };
    }
    // A durable resume reads the whole log (findRun does too): refuse one
    // past the cap before anything reads it. A live run is in memory already.
    if (!controllers.has(`${name}/${runId}`)) {
      // A durable resume starts the run again: nothing new while draining.
      // Unpausing a live run is its own work going on, and is let through.
      const draining = drain.refusal();
      if (draining) return { ok: false, error: draining, status: 503 };
      const big = await logTooBig(name, runId);
      if (big) return { ok: false, error: big, status: 413 };
    }
    const { controller, summary, exists, byPeer } = await findRun(name, runId);
    if (exists && !byPeer && opts.peer) return { ok: false, error: NOT_A_PEER_RUN, status: 403 };

    // Live controller → in-memory resume of a paused run (§4).
    if (controller) {
      if (body.from || body.version !== undefined) {
        return {
          ok: false,
          error: "Run is live — `from` and `version` apply to durable resume of a dead run. Pause/cancel it first.",
          status: 409,
        };
      }
      controller.resume();
      await appendControlEvent(name, runId, "run.resumed");
      return { ok: true, runId, state: controller.state, resumed: "in-memory", status: 202 };
    }

    // No controller → durable resume: journal replay (§5).
    if (!exists) return { ok: false, error: `Run "${runId}" not found`, status: 404 };
    if (summary?.status === "success" && !body.from) {
      return {
        ok: false,
        error: "Run completed successfully — nothing to resume (pass `from` to force re-execution from a step)",
        status: 400,
      };
    }

    const prepared = await prepareDurableResume(name, runId, body);
    if (!prepared.ok) return prepared;
    const refused = await opts.admit?.(prepared);
    if (refused) return { ok: false, error: refused, status: 403 };

    // Re-check liveness after the awaits above: two concurrent resume
    // requests must not both launch onto the same log.
    if (controllers.has(`${name}/${runId}`)) {
      return { ok: false, error: "Resume already in flight for this run", status: 409 };
    }
    const { version, journal, changed } = prepared;
    launchDurableResume(prepared);
    return {
      ok: true,
      runId,
      resumed: "journal",
      replaying: Object.keys(journal).length,
      ...(version ? { version } : {}),
      ...(changed ? { changed } : {}),
      status: 202,
    };
  };

  app.post("/workflows/:name/runs/:runId/resume", async (c) => {
    const { name, runId } = c.req.param();
    const body = await c.req.json<ResumeBody>().catch(() => ({}) as ResumeBody);
    const scope = await scopeOf(c);
    const { status, ...out } = await resumeRun(name, runId, body, {
      peer: isPeerScope(scope),
      // A forced resume runs the ACTIVE version when none matches the run's:
      // a peer resumes only into one that is open to it. A run a person's
      // credential launched opens that person's sessions, so only the same
      // person's credential resumes it.
      admit: async (prepared) => {
        if (!isPeerScope(scope)) return null;
        if (!opensTo(prepared.flow.peer, scope)) return notForPeers(name, prepared.flow.peer);
        if (prepared.runStart.peerPerson && (scope !== "peer:person" || (await resolveActor(c)) !== prepared.runStart.actor)) {
          return "forbidden: a person's credential launched this run — only the same person's resumes it";
        }
        return null;
      },
    });
    // An error answers `{ error }` alone, as this route always has.
    return c.json(out.ok ? out : { error: out.error }, status, status === 503 ? { "retry-after": "60" } : undefined);
  });

  // Resolve this workflow's declared `promotes` against a run's OUTPUT — the
  // review surface for "promote a winner". For each spec: the resolved value
  // from the run output (`value`) and the target param's CURRENT default
  // (`current`), so the UI can diff current → value. Pure read; nothing is
  // written until the human POSTs to `/promote`.
  app.get("/workflows/:name/runs/:runId/promotions", async (c) => {
    const { name, runId } = c.req.param();
    let flow: Flow;
    try {
      flow = await workspace.getWorkflow(name);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
    const specs = flow.promotes ?? [];
    if (specs.length === 0) return c.json([]);

    const summary = await store.getRunSummary(name, runId);
    if (!summary) {
      return c.json({ error: `Run "${runId}" not found for workflow "${name}"` }, 404);
    }
    const output = summary.output;

    const promotions = [];
    for (const spec of specs) {
      const target = parsePromoteTarget(spec.to);
      if (!target) continue;
      const value = getByPath(output, spec.from);
      let current: unknown = undefined;
      try {
        current = (await workspace.getWorkflow(target.workflow)).params?.[target.param];
      } catch {
        current = undefined; // target workflow may not exist yet
      }
      promotions.push({
        from: spec.from,
        to: spec.to,
        target,
        label: spec.label ?? spec.to,
        value,
        current,
        resolved: value !== undefined,
      });
    }
    return c.json(promotions);
  });

  // Apply a single declared promotion (human-approved): resolve the run output
  // value for the spec whose `to` === body.to, write it to the target's param
  // default, publish a new version, and rebuild the registry. Returns the new
  // version + before/after.
  app.post("/workflows/:name/runs/:runId/promote", async (c) => {
    const { name, runId } = c.req.param();
    const body = await c.req.json<{ to?: string }>();
    if (!body.to) return c.json({ error: "to is required" }, 400);

    let flow: Flow;
    try {
      flow = await workspace.getWorkflow(name);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
    const spec = (flow.promotes ?? []).find((s) => s.to === body.to);
    if (!spec) {
      return c.json({ error: `No promote spec with to="${body.to}" on workflow "${name}"` }, 404);
    }
    const target = parsePromoteTarget(spec.to);
    if (!target) return c.json({ error: `Invalid promote target "${spec.to}"` }, 400);

    const summary = await store.getRunSummary(name, runId);
    if (!summary) {
      return c.json({ error: `Run "${runId}" not found for workflow "${name}"` }, 404);
    }
    const value = getByPath(summary.output, spec.from);
    if (value === undefined) {
      return c.json({ error: `Promote value at "${spec.from}" is undefined in this run's output` }, 422);
    }

    let result;
    try {
      result = await workspace.setParam(target.workflow, target.param, value, await resolveActor(c));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    await rebuildRegistry();
    return c.json({
      ok: true,
      workflow: target.workflow,
      param: target.param,
      version: result.version,
      before: result.before,
      after: result.after,
    });
  });

  // Every version, newest first, with how often each one ran — the Versions
  // tab. A run is attributed by the content hash it recorded (summary, else
  // `run.start` for runs that predate the summary stamp); identical content
  // published twice goes to the newest twin that existed when the run started.
  app.get("/workflows/:name/versions", async (c) => {
    const name = c.req.param("name");
    const meta = await workspace.getWorkflowMetadata(name);
    if (!meta) return c.json({ error: `Workflow "${name}" not found` }, 404);
    const versions = Object.entries(meta.versions)
      .map(([version, info]) => ({
        version,
        createdAt: info.createdAt,
        description: info.description,
        ...(info.source ? { source: info.source } : {}),
        ...(info.actor ? { actor: info.actor } : {}),
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const hashes = new Map<string, string | null>();
    await Promise.all(versions.map(async (v) => hashes.set(v.version, await workspace.getWorkflowHash(name, v.version))));
    const stats = new Map<string, { runs: number; success: number; error: number; lastRunAt?: string }>();
    let unattributed = 0;
    // Each run is read and counted as it comes, 32 at a time. A summary
    // without the hash reads only the log's first line (`getRunStart`).
    const count = async (runId: string) => {
      const summary = await store.getRunSummary(name, runId);
      if (!summary) return; // in flight — counted once it finishes
      const hash =
        summary.workflowHash ?? ((await store.getRunStart(name, runId)) as { workflowHash?: string } | null)?.workflowHash;
      const twins = hash ? versions.filter((v) => hashes.get(v.version) === hash) : [];
      const v = twins.find((t) => t.createdAt <= summary.startedAt) ?? twins[twins.length - 1];
      if (!v) { unattributed++; return; }
      const s = stats.get(v.version) ?? { runs: 0, success: 0, error: 0 };
      s.runs++;
      if (summary.status === "success") s.success++;
      if (summary.status === "error") s.error++;
      if (!s.lastRunAt || summary.startedAt > s.lastRunAt) s.lastRunAt = summary.startedAt;
      stats.set(v.version, s);
    };
    const runIds = await store.listRuns(name);
    for (let i = 0; i < runIds.length; i += 32) await Promise.all(runIds.slice(i, i + 32).map(count));
    return c.json({
      active: meta.active,
      versions: versions.map((v) => ({ ...v, ...(stats.get(v.version) ?? { runs: 0, success: 0, error: 0 }) })),
      unattributed,
    });
  });

  app.get("/workflows/:name/flow", async (c) => {
    const name = c.req.param("name");
    // ?version= pins a historical version (the UI's version picker);
    // omitted = the active version, as before.
    const version = c.req.query("version");
    try {
      const flow = version
        ? await workspace.getWorkflowVersion(name, version)
        : await workspace.getWorkflow(name);
      return c.json({
        name: flow.name,
        steps: flow.steps,
        ...(flow.inputBlock != null ? { input: flow.inputBlock } : {}),
        ...(flow.params != null ? { params: flow.params } : {}),
        ...(flow.promotes != null ? { promotes: flow.promotes } : {}),
        ...(flow.sealed ? { sealed: true } : {}),
        ...(flow.peer ? { peer: flow.peer } : {}),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  // The Claims panel's HTTP door (plans/claims.md §2 "UI", §4.2). Before
  // the `/:version` catch-all below: it serves `/workflows/:name/evidence`.
  claimsRoutes(app, { claims: claimsAuthoring, verifier });

  app.get("/workflows/:name/:version", async (c) => {
    const { name, version } = c.req.param();
    try {
      const src = await workspace.getWorkflowSource(name, version);
      return c.text(src, 200, { "Content-Type": "text/yaml" });
    } catch {
      return c.json(
        { error: `Version "${version}" of workflow "${name}" not found` },
        404,
      );
    }
  });

  app.post("/workflows/:name", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json<{
      version: string;
      steps?: any[];
      input?: InputBlock;
      params?: Record<string, unknown>;
      claims?: ClaimsBlock;
      sealed?: boolean;
      peer?: boolean | PeerOpen;
      yaml?: string;
      description?: string;
      source?: string;
    }>();

    if (!body.version) return c.json({ error: "version is required" }, 400);
    const { contract, error: contractError } = await httpContract(body);
    if (contractError) return c.json({ error: contractError }, 400);

    const actor = await resolveActor(c);
    const opts = httpPublishOptions(body.source, actor);
    try {
      if (body.yaml) {
        await workspace.publishWorkflow(name, body.version, body.yaml, body.description, undefined, undefined, opts);
      } else if (body.steps) {
        await workspace.publishWorkflow(
          name,
          body.version,
          {
            steps: body.steps,
            ...(body.input != null ? { input: body.input } : {}),
            ...(body.params != null ? { params: body.params } : {}),
            ...(body.claims != null ? { claims: body.claims } : {}),
            ...(body.sealed != null ? { sealed: body.sealed } : {}),
            ...(body.peer != null ? { peer: body.peer } : {}),
          },
          body.description,
          undefined,
          undefined,
          opts,
        );
      } else {
        return c.json({ error: "either steps or yaml is required" }, 400);
      }
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    await adoptWorkflow(name, actor);
    await rebuildRegistry();
    const applied = contract ? await claimsAuthoring!.applyClaimsArg({ kind: "workflow", name }, contract, PERSON) : undefined;

    return c.json({ ok: true, workflow: name, version: body.version, active: body.version, ...(applied ? { claims: applied } : {}) }, 201);
  });

  // Set or clear a workflow's grouping category. Metadata-only — no new
  // version is published (unlike POST /workflows/:name).
  app.put("/workflows/:name/category", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json<{ category?: string | null }>();
    try {
      await workspace.setWorkflowCategory(name, body.category ?? null);
      return c.json({ ok: true, workflow: name, category: body.category ?? null });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  // Transfer a workflow to another actor (plans/mothership-cost-control.md §2).
  // The owner pays for the workflow's automations.
  app.put("/workflows/:name/owner", async (c) => {
    const name = c.req.param("name")!;
    const body = await c.req.json<{ owner?: string | null }>();
    const owner = (typeof body.owner === "string" ? body.owner.trim() : "") || null;
    try {
      await workspace.setWorkflowOwner(name, owner);
      return c.json({ ok: true, workflow: name, owner });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  // Set or clear a workflow's per-run LLM spend cap (§3). Metadata-only like
  // the category; only the Mothership module enforces it.
  app.put("/workflows/:name/run-cap", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json<{ maxRunCostUsd?: number | null }>();
    const cap = body.maxRunCostUsd ?? null;
    if (cap !== null && !(typeof cap === "number" && Number.isFinite(cap) && cap > 0)) {
      return c.json({ error: "maxRunCostUsd must be a positive number, or null to clear" }, 400);
    }
    try {
      await workspace.setWorkflowRunCap(name, cap);
      return c.json({ ok: true, workflow: name, maxRunCostUsd: cap });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  // Disable or re-enable a workflow: a disabled one refuses every new run
  // (`workflowDisabled`, src/workspace.ts) and holds its schedules.
  // Metadata-only like the category — no version.
  app.put("/workflows/:name/disabled", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json<{ disabled?: boolean }>().catch(() => ({}) as { disabled?: boolean });
    if (typeof body.disabled !== "boolean") return c.json({ error: "disabled must be a boolean" }, 400);
    try {
      await workspace.setWorkflowDisabled(name, body.disabled);
      return c.json({ ok: true, workflow: name, disabled: body.disabled });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  // Hand a workflow to the builder, or take it back: the `publisher` stamp
  // the meta surface publishes over (it writes only over names stamped
  // "ai", src/authoring.ts). A person's door — the gate refuses a peer, and
  // no tool reaches it. It moves the stamp between none and "ai" only (a
  // service's stamp is the service's), and refuses to hand over what the
  // builder could not keep: a sealed workflow (a candidate without
  // `sealed:` would unseal a grading harness), one open to peers (the
  // builder may not publish `peer:`, so its next version would close it to
  // them) and a seed (every boot puts the committed version back).
  app.put("/workflows/:name/publisher", async (c) => {
    const name = c.req.param("name")!;
    const body = await c.req.json<{ publisher?: string | null }>().catch(() => ({}) as { publisher?: string | null });
    const publisher = body.publisher ?? null;
    if (publisher !== null && publisher !== AI_PUBLISHER) {
      return c.json({ error: `publisher is "${AI_PUBLISHER}" (hand the workflow to the builder) or null (take it back)` }, 400);
    }
    const meta = await workspace.getWorkflowMetadata(name);
    if (!meta) return c.json({ error: `Workflow "${name}" not found` }, 404);
    if (meta.publisher && meta.publisher !== AI_PUBLISHER) {
      return c.json({ error: `Workflow "${name}" is stamped "${meta.publisher}", a service's: only an unstamped workflow is handed to the builder` }, 409);
    }
    if (publisher) {
      const refusal = async (): Promise<string | undefined> => {
        if (meta.versions[meta.active]?.source === "seed") return "it is a seed: every boot puts the committed version back, so change it where it is seeded";
        const flow = await workspace.getWorkflow(name);
        if (flow.sealed) return "it is sealed: the builder may never publish over a grading harness";
        if (flow.peer) return `it is open to other struts (\`peer: ${flow.peer}\`), and the builder may not publish that key: its next version would close it to them`;
        return undefined;
      };
      const why = await refusal();
      if (why) return c.json({ error: `Workflow "${name}" is not handed to the builder — ${why}` }, 409);
    }
    await workspace.setWorkflowPublisher(name, publisher);
    return c.json({ ok: true, workflow: name, publisher });
  });

  app.put("/workflows/:name/active", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json<{ version: string }>();
    if (!body.version) return c.json({ error: "version is required" }, 400);
    try {
      await workspace.setActiveVersion(name, body.version);
      return c.json({ ok: true, workflow: name, active: body.version });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  // ── Artifacts ────────────────────────────────────────────────────────────
  // Files a run wrote via `ctx.services.artifacts` (keyed by runId alone —
  // artifacts are run-scoped, not workflow-scoped). Read-only: steps are the
  // only writers — so a file's content is untrusted, and it is served
  // sandboxed (`artifactHeaders`). The listing mints the run's file token
  // (`fileToken`, auth.ts; absent with no secret to sign it): what a link to
  // any of these files carries as `?t=` instead of the key. A `?t=` strut
  // cannot vouch for is refused here even when the gate is open — a host
  // gate in front of this strut (mcp's `/lab`) hands token-bearing file
  // reads through on that promise.

  const badToken = (c: Context) =>
    carriesBadFileToken(c) ? c.json({ error: "unauthorized: that file token does not open this path" }, 401) : undefined;

  app.get("/artifacts/:runId", async (c) => {
    if (!artifacts) return c.json({ error: "artifacts capability not available" }, 501);
    const refused = badToken(c);
    if (refused) return refused;
    const runId = c.req.param("runId");
    try {
      const token = fileToken({ kind: "run", id: runId });
      return c.json({ runId, files: await artifacts.list(runId), ...(token ? { token } : {}) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/artifacts/:runId/:path{.+}", async (c) => {
    if (!artifacts) return c.json({ error: "artifacts capability not available" }, 501);
    const refused = badToken(c);
    if (refused) return refused;
    const runId = c.req.param("runId");
    const relPath = c.req.param("path");
    try {
      const bytes = await artifacts.read(runId, relPath);
      return c.body(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        200,
        artifactHeaders(relPath, carriesFileToken(c)),
      );
    } catch (err: any) {
      // A directory is not a file: the listing above is what names what is
      // in it, and the job route answers the same way.
      if (err?.code === "ENOENT" || err?.code === "EISDIR") {
        return c.json({ error: `artifact not found: ${relPath}` }, 404);
      }
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // ── The public view (plans/public-surface.md) ────────────────────────────
  // What a PERSON put in the server's public view, read by anyone under
  // `/public/*` (src/public-routes.ts), from the record alone whatever the
  // gate's mode. The record's door is `/public-view` — behind the gate like
  // every route (a peer's write is a 403), and no step or builder tool
  // writes it. Never a "publish": nothing is copied or versioned.
  const publicSurface = createPublicSurface({
    dataDir,
    store,
    ...(graph ? { graph: { reader: graph.reader, schemas: graph.schemas } } : {}),
  });
  {
    // Keep the public view's visible-refs index current as steps end.
    const bag = services as Record<string, unknown>;
    const prior = (bag["onRunEvent"] as ((workflow: string, event: RunEvent) => unknown) | undefined)?.bind(bag);
    bag["onRunEvent"] = async (workflow: string, event: RunEvent) => {
      try {
        await prior?.(workflow, event);
      } finally {
        publicSurface.noteEvent(workflow, event);
      }
    };
  }
  /** A public app as a visitor's host reads it: the version people open
   *  (the held release's once the public view holds it). */
  const publicAppInfo = async (name: string) => {
    const view = await apps.get(name).catch(() => null);
    if (!view) return null;
    return {
      name,
      version: view.version,
      title: view.manifest.title,
      ...(view.manifest.description ? { description: view.manifest.description } : {}),
      ...(view.manifest.icon ? { icon: view.manifest.icon } : {}),
    };
  };
  publicRoutes(app, {
    surface: publicSurface,
    workspace,
    store,
    registry: () => registry,
    stepSources: () => stepSources,
    ...(artifacts ? { artifacts } : {}),
    fileHeaders: (path) => artifactHeaders(path),
    documentHeaders: (path) => artifactHeaders(path, true),
    liveStatus,
    apps: {
      info: publicAppInfo,
      async document(name) {
        const dir = await apps.versionDir(name);
        if (!dir) return null;
        const bytes = await readAppFile(dir.path, DOCUMENT_FILE);
        if (!bytes) return null;
        return { version: dir.version, html: withPublicIdentity(Buffer.from(bytes).toString("utf8"), publicAppIdentity(name, dir.version)) };
      },
    },
  });
  /** What the record names that this server does not hold — reported to
   *  the person, never refused: an item may come later, and one that is
   *  gone is skipped by every read. */
  const publicViewMissing = async (s: PublicSurface) => {
    const workflows = new Set((await workspace.listWorkflows()).map((w) => w.name));
    const appNames = new Set((await apps.list().catch(() => [])).map((a) => a.name));
    const tree = s.concepts.length ? await publicSurface.conceptTree().catch(() => undefined) : undefined;
    return {
      workflows: s.workflows.map((w) => w.name).filter((n) => !workflows.has(n)),
      steps: s.steps.filter((t) => !registry[t]),
      concepts: tree ? tree.missing : s.concepts.length && !graph ? s.concepts : [],
      apps: s.apps.map((a) => a.name).filter((n) => !appNames.has(n)),
    };
  };
  app.get("/public-view", async (c) => {
    const s = await publicSurface.get();
    return c.json({ surface: s, missing: await publicViewMissing(s) });
  });
  app.put("/public-view", async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const problem = surfaceProblem(body);
    if (problem) return c.json({ error: problem }, 400);
    const before = new Set((await publicSurface.get()).apps.map((a) => a.name));
    const next = await publicSurface.set(normalizeSurface(body));
    // An app added to the public view is HELD at the version it shows
    // (plans/public-surface.md §2, as pinning holds, plans/app-releases.md):
    // a builder's later publish is a draft until a person moves the release.
    const actor = await resolveActor(c);
    const held: Array<{ app: string; version?: string; release?: string; error?: string }> = [];
    for (const a of next.apps) {
      if (before.has(a.name)) continue;
      try {
        const rel = await apps.releases(a.name);
        if (!rel || rel.live !== "latest") continue;
        const dir = await apps.versionDir(a.name);
        if (!dir) continue;
        const release = await apps.promote(a.name, dir.version, actor ? { by: actor } : {});
        held.push({ app: a.name, version: dir.version, release: release.id });
      } catch (err) {
        held.push({ app: a.name, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return c.json({ surface: next, missing: await publicViewMissing(next), ...(held.length ? { held } : {}) });
  });
  // What adding an app or a workflow brings along, for the dialog to
  // pre-check (src/public-view.ts): every line with what it exposes.
  app.get("/public-view/needs", async (c) => {
    const appName = c.req.query("app");
    const wf = c.req.query("workflow");
    const out = await publicViewNeeds(
      {
        workspace,
        registry: () => registry,
        stepSources: () => stepSources,
        app: async (name) => {
          const view = await apps.get(name).catch(() => null);
          return view ? { version: view.version, title: view.manifest.title, grants: { workflows: view.manifest.grants.workflows, steps: view.manifest.grants.steps } } : null;
        },
        walk: (roots) => publicSurface.walk(roots),
      },
      { ...(appName ? { app: appName } : {}), ...(wf ? { workflow: wf } : {}) },
    );
    return "error" in out ? c.json(out, 404) : c.json(out);
  });

  // ── Apps (plans/apps.md §7.2) ────────────────────────────────────────────
  // A workspace app's pointers and its version directories. The files are
  // served exactly as a run's artifacts are: the listing mints the app's
  // FILE TOKEN (`app:<name>@<vN>`, auth.ts), a file under it opens with
  // `?t=`, and `dist/index.html` — the document — is served with the token
  // written into its `<meta name="strut-app-token">` and `CSP: sandbox
  // allow-scripts`, so the page's calls carry its identity and the key is
  // never in a URL it can read. Read with the key instead it carries no meta
  // and runs no script. A name may hold `/` (`acme/hvac/invoices`): encoded
  // in the URL, decoded by the router. `POST /apps` is a PERSON's door: its
  // grants are unrestricted (§9); build errors are a 400.

  const appRoute = (c: Context): { name: string } | Response => {
    const name = c.req.param("name") ?? "";
    try {
      validateAppName(name);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    return { name };
  };

  app.get("/apps", async (c) => c.json({ apps: await apps.list() }));

  app.get("/apps/:name", async (c) => {
    const at = appRoute(c);
    if (at instanceof Response) return at;
    const version = c.req.query("version") || undefined;
    const view = await apps.get(at.name, version);
    if (!view) return c.json({ error: version ? `App "${at.name}" has no version ${version}` : `App "${at.name}" not found` }, 404);
    return c.json(view);
  });

  // What the app's pages cost the server (src/apps/monitor.ts): calls,
  // failures and data per minute for the last hour and by step type for the
  // last day, and the warnings — kept in the app's `.usage/`, so across restarts.
  app.get("/apps/:name/usage", async (c) => {
    const at = appRoute(c);
    if (at instanceof Response) return at;
    if (!(await workspace.getApp(at.name))) return c.json({ error: `App "${at.name}" not found` }, 404);
    return c.json(appMonitor.report(at.name));
  });

  app.get("/apps/:name/versions", async (c) => {
    const at = appRoute(c);
    if (at instanceof Response) return at;
    const rec = await workspace.getApp(at.name);
    if (!rec) return c.json({ error: `App "${at.name}" not found` }, 404);
    // `live`, `releases` (with their locks) and `behind`: plans/app-releases.md §1.2.
    const releases = await apps.releases(at.name);
    return c.json({
      name: at.name,
      active: rec.active,
      versions: rec.versions,
      ...(rec.publisher ? { publisher: rec.publisher } : {}),
      ...(rec.owner ? { owner: rec.owner } : {}),
      ...(rec.pinned ? { pinned: true } : {}),
      ...(releases ?? { live: "latest", releases: [], behind: [] }),
    });
  });

  /** The version's directory, or the 404 / 400 that says why not. */
  const appVersionRoute = async (c: Context): Promise<{ name: string; version: string; path: string; hash: string } | Response> => {
    const at = appRoute(c);
    if (at instanceof Response) return at;
    const version = c.req.param("version") ?? "";
    // A preview (`apps.preview`, app/look { path }) is hosted where a version is.
    if (!/^v\d+$/.test(version) && !isPreviewLabel(version)) return c.json({ error: `"${version}" is not a version label (v1, v2, …)` }, 404);
    const dir = await apps.versionDir(at.name, version);
    if (!dir) return c.json({ error: `App "${at.name}" has no version ${version}` }, 404);
    return { name: at.name, version, path: dir.path, hash: dir.hash };
  };

  app.get("/apps/:name/:version/files", async (c) => {
    const refused = badToken(c);
    if (refused) return refused;
    const at = await appVersionRoute(c);
    if (at instanceof Response) return at;
    const token = fileToken({ kind: "app", id: `${at.name}@${at.version}` });
    return c.json({ app: at.name, version: at.version, hash: at.hash, files: await listAppFiles(at.path), ...(token ? { token } : {}) });
  });

  app.get("/apps/:name/:version/files/:path{.+}", async (c) => {
    const refused = badToken(c);
    if (refused) return refused;
    const at = await appVersionRoute(c);
    if (at instanceof Response) return at;
    const relPath = c.req.param("path");
    let bytes: Uint8Array | null;
    try {
      bytes = await readAppFile(at.path, relPath);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    if (!bytes) return c.json({ error: `no file "${relPath}" in ${at.name}@${at.version}` }, 404);
    const tokenRead = carriesFileToken(c);
    if (relPath === DOCUMENT_FILE) {
      // The document: the app's IDENTITY goes in as it is served (§7.2;
      // `appIdentity`, auth.ts — the scope and its token, what `step_run`
      // reads the app off): under the token it was read with; on a strut
      // with no secret to sign one (nothing minted, the gate open) the
      // scope alone, so a dev strut's apps still call; read with the key
      // instead, nothing.
      const html = Buffer.from(bytes).toString("utf8");
      const signs = fileToken({ kind: "app", id: `${at.name}@${at.version}` }) !== undefined;
      const identity = tokenRead || !signs ? appIdentity(at.name, at.version) : undefined;
      const served = identity ? withToken(html, identity) : withoutTokenMeta(html);
      // The same bytes every time a version is served (the identity is a
      // signature of it, not a nonce), so a host keeps them and asks again
      // with If-None-Match: a rebuild, a rotated key or another version
      // changes the tag.
      const etag = `"${createHash("sha256").update(served).digest("hex").slice(0, 32)}"`;
      const headers = { ...artifactHeaders(relPath, tokenRead), etag, "cache-control": "private, no-cache" };
      if (etagMatches(c.req.header("if-none-match"), etag)) return c.body(null, 304, headers);
      return c.body(served, 200, headers);
    }
    return c.body(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 200, artifactHeaders(relPath, tokenRead));
  });

  // Publish from a files map: `{ name, files: { "app.yaml": "…", "src/App.tsx": "…", "public/logo.png": { base64 } }, publisher?, upstream? }`.
  // Written to a scratch directory, built, recorded, copied into place.
  app.post("/apps", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: unknown;
      files?: unknown;
      publisher?: unknown;
      upstream?: unknown;
      reactivateKnown?: unknown;
    };
    if (typeof body.name !== "string" || !body.name) return c.json({ error: "name is required" }, 400);
    if (!body.files || typeof body.files !== "object" || Array.isArray(body.files) || !Object.keys(body.files).length) {
      return c.json({ error: "files is required: a path → content map (text, or { base64 } for a binary file), app.yaml among them" }, 400);
    }
    try {
      validateAppName(body.name);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    const reserved = reservedAppName(body.name);
    if (reserved) return c.json({ error: reserved }, 400);
    const scratch = await mkdtemp(join(tmpdir(), "strut-app-publish-"));
    let result: AppPublishResult;
    try {
      await writeAppFiles(scratch, body.files as Record<string, string | { base64: string }>);
      const actor = await resolveActor(c);
      result = await apps.publish(scratch, body.name, {
        surface: "person",
        source: "api",
        ...(typeof body.publisher === "string" ? { publisher: body.publisher } : {}),
        ...(actor ? { actor } : {}),
        ...(body.upstream === null || (body.upstream && typeof body.upstream === "object") ? { upstream: body.upstream as Upstream | null } : {}),
        ...(typeof body.reactivateKnown === "boolean" ? { reactivateKnown: body.reactivateKnown } : {}),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    if (!result.ok) return c.json({ error: "the app did not build", errors: result.errors, warnings: result.warnings }, 400);
    return c.json(result, 201);
  });

  // What people open (plans/app-releases.md §1.2): `{ version: "vN" }`
  // PROMOTES — a new release with a lock on the workflows and steps the
  // version reaches, made live, the app held; `{ release: "rN" }` makes an
  // earlier release live again; `{ version: "latest" }` follows the newest
  // publish. A person's door.
  app.put("/apps/:name/active", async (c) => {
    const at = appRoute(c);
    if (at instanceof Response) return at;
    const body = (await c.req.json().catch(() => ({}))) as { version?: unknown; release?: unknown };
    const version = typeof body.version === "string" && body.version ? body.version : undefined;
    const release = typeof body.release === "string" && body.release ? body.release : undefined;
    if (!version === !release) return c.json({ error: 'one of version ("vN", or "latest" to follow the newest publish) or release ("rN") is required' }, 400);
    let made: AppRelease | undefined;
    try {
      if (release) await apps.setLive(at.name, release);
      else if (version === "latest") await apps.setLive(at.name, null);
      else {
        const actor = await resolveActor(c);
        made = await apps.promote(at.name, version!, actor ? { by: actor } : {});
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, /not found/.test(message) ? 404 : 409);
    }
    const rec = await workspace.getApp(at.name);
    return c.json({ ok: true, name: at.name, active: rec?.active, live: rec?.live ?? "latest", ...(made ? { release: made } : {}) });
  });

  // Pin the app as a TAB, or unpin it: `{ pinned: boolean }` — the record's
  // flag a host reads off `GET /apps` (hive's sidebar for the workspace this
  // strut is the swarm of). A person's door, like `/active`; `app/pin` is
  // the builder's.
  app.put("/apps/:name/pin", async (c) => {
    const at = appRoute(c);
    if (at instanceof Response) return at;
    const body = (await c.req.json().catch(() => ({}))) as { pinned?: unknown };
    if (typeof body.pinned !== "boolean") return c.json({ error: "pinned is required: true or false" }, 400);
    let made: AppRelease | undefined;
    try {
      const actor = await resolveActor(c);
      made = (await apps.pin(at.name, body.pinned, actor ? { by: actor } : {})).release;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, /not found/.test(message) ? 404 : 409);
    }
    // Pinning holds an app that followed latest (plans/app-releases.md): `release` is the one made.
    const live = (await workspace.getApp(at.name))?.live ?? "latest";
    return c.json({ ok: true, name: at.name, pinned: body.pinned, live, ...(made ? { release: made } : {}) });
  });

  // A person's grants of SEALED workflows to an app (src/apps/grants.ts):
  // the assistant (`orchestrator`) for an app with a chat of its own. The
  // builder's door is `app/grant`, run on an accepted proposal; this is a
  // person's own, like `/pin`. By the app's name: it need not be published
  // yet. `DELETE …?workflow=` takes one back.
  app.get("/apps/:name/grants", async (c) => {
    const at = appRoute(c);
    if (at instanceof Response) return at;
    return c.json({ name: at.name, grants: await apps.grantsOf(at.name) });
  });
  app.post("/apps/:name/grants", async (c) => {
    const at = appRoute(c);
    if (at instanceof Response) return at;
    const body = (await c.req.json().catch(() => ({}))) as { workflow?: unknown };
    if (typeof body.workflow !== "string" || !body.workflow) return c.json({ error: "workflow is required: the sealed workflow the app's pages may run" }, 400);
    try {
      const actor = await resolveActor(c);
      return c.json({ ok: true, name: at.name, grant: await apps.grant(at.name, body.workflow, actor ? { by: actor } : {}) }, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, /^no workflow/.test(message) ? 404 : 400);
    }
  });
  app.delete("/apps/:name/grants", async (c) => {
    const at = appRoute(c);
    if (at instanceof Response) return at;
    const workflow = c.req.query("workflow") ?? "";
    if (!workflow) return c.json({ error: "workflow=<name> is required" }, 400);
    if (!(await apps.revoke(at.name, workflow))) return c.json({ error: `${at.name} holds no grant of "${workflow}"` }, 404);
    return c.json({ ok: true, name: at.name, workflow });
  });

  // A CHANNEL TICKET (plans/app-channels.md §2; auth.ts): what a browser
  // host opens the app's channel socket with, `GET /channels?ticket=…`. The
  // host names the app and version it is showing; the viewer is the
  // request's actor (Hive: the member, as `x-strut-actor` with the swarm
  // key). A `full` caller only: the gate keeps every peer off this POST.
  /** The app a ticket or a socket may name: a version (or a preview) this strut holds. */
  const channelAppOf = async (name: string, version: string): Promise<ChannelApp | undefined> => {
    if (!/^v\d+$/.test(version) && !isPreviewLabel(version)) return undefined;
    return (await apps.versionDir(name, version)) ? { name, version } : undefined;
  };
  app.post("/apps/:name/channel-ticket", async (c) => {
    const at = appRoute(c);
    if (at instanceof Response) return at;
    const body = (await c.req.json().catch(() => ({}))) as { version?: unknown; peer?: unknown };
    const version = typeof body.version === "string" ? body.version : "";
    if (!version) return c.json({ error: "version is required: the version the host is showing (v1, v2, … or a preview's label)" }, 400);
    // A PEER's app (plans/app-channels.md §4): its channels are the peer's,
    // and this strut relays the socket there — the peer says whether it
    // holds the version when the relay connects.
    const peer = typeof body.peer === "string" && body.peer ? body.peer : undefined;
    if (body.peer !== undefined && !peer) return c.json({ error: "peer: a peer id" }, 400);
    if (peer) {
      if (!(await peerRecords.get(peer))) return c.json({ error: `no peer "${peer}" on file` }, 404);
      if (!/^v\d+$/.test(version) && !isPreviewLabel(version)) return c.json({ error: `"${version}" is not a version label` }, 404);
    } else if (!(await channelAppOf(at.name, version))) {
      return c.json({ error: `App "${at.name}" has no version ${version}` }, 404);
    }
    const actor = await resolveActor(c);
    return c.json(channelTicket({ ...(actor ? { actor } : {}), app: at.name, version, ...(peer ? { peer } : {}) }));
  });

  app.delete("/apps/:name", async (c) => {
    const at = appRoute(c);
    if (at instanceof Response) return at;
    const removed = await apps.delete(at.name);
    if (!removed) return c.json({ error: `App "${at.name}" not found` }, 404);
    return c.json({ ok: true, name: at.name });
  });

  // ── Packages (plans/marketplace.md §5, §13) ─────────────────────────────
  // A package's bytes BY DIGEST: the archive another strut fetches
  // (`fetchArchive`, src/packages/archive.ts) — any package this strut's
  // cache holds (`<dataDir>/packages/`), built here or resolved here, so a
  // strut that installed one can serve it as a mirror. The digest names
  // every byte, so the answer never changes: an ETag of the digest, kept a
  // year. Behind the gate like every route; a package a catalog publishes
  // is opened to anyone with the catalog (§13), a sold one by its token (§6).
  const packageStore = packageCache(dataDir);
  app.get("/packages/:publisher/:name/archive", async (c) => {
    const pkg = `${c.req.param("publisher")}/${c.req.param("name")}`;
    const digest = c.req.query("digest") ?? "";
    if (!PACKAGE_DIGEST.test(digest)) return c.json({ error: "digest=sha256:<64 hex> is required" }, 400);
    // A PUBLIC read (§13): `?public=1` opens a digest the public catalog
    // lists, with no credential — and nothing else, whatever the gate's
    // mode, since a host's gate hands such a read through (mcp's labAuth).
    if (publicPackageRead(c)) {
      const pub = await catalogDeps.publicCatalogs.current();
      if (!pub?.card.packages[pkg]?.releases.some((r) => r.digest === digest)) return c.json({ error: `no public release of ${pkg} at ${digest} here` }, 404);
    }
    // A subscriber's read (§12.1): a catalog token opens the digests this
    // strut's catalog names, no other package the cache holds.
    else if (c.req.query("t") !== undefined) {
      const token = catalogTokenOf(c);
      const current = token ? await catalogDeps.catalogs.current() : undefined;
      if (!token || token.key !== current?.card.key) return c.json({ error: "unauthorized: not a catalog token this strut server minted" }, 401);
      if (!current.card.packages[pkg]?.releases.some((r) => r.digest === digest)) return c.json({ error: `no release of ${pkg} at ${digest} in this strut server's catalog` }, 404);
    }
    const info = await packageStore.get(digest);
    if (!info || info.manifest.package !== pkg) return c.json({ error: `no package ${pkg} at ${digest} here` }, 404);
    const etag = `"${digest}"`;
    const headers = {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="${pkg.replace("/", "-")}-${digest.slice(7, 19)}.tar.gz"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=31536000, immutable",
      etag,
    };
    if (c.req.header("if-none-match") === etag) return c.body(null, 304, headers);
    const gz = await packArchive(info.dir, info.files);
    return c.body(gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength) as ArrayBuffer, 200, headers);
  });
  // What a package in the cache holds, by each item's name INSIDE it — a
  // workflow's, step's or app's path, a Concept's page name, helpers left
  // out (plans/packages-ux.md §3): the package page ticks what a published
  // package's newest release held. Reads only.
  app.get("/packages/:publisher/:name/items", async (c) => {
    const pkg = `${c.req.param("publisher")}/${c.req.param("name")}`;
    const digest = c.req.query("digest") ?? "";
    if (!PACKAGE_DIGEST.test(digest)) return c.json({ error: "digest=sha256:<64 hex> is required" }, 400);
    const info = await packageStore.get(digest);
    if (!info || info.manifest.package !== pkg) return c.json({ error: `no package ${pkg} at ${digest} here` }, 404);
    const items = info.items
      .filter((i) => !i.helper)
      .map((i) => ({ kind: i.kind, name: i.kind === "concept" || i.kind === "type" ? i.name : i.name.slice(pkg.length + 1) }));
    return c.json({ package: pkg, version: info.manifest.version, digest, items });
  });

  // What is INSTALLED — a fold over the workspace's version stamps and the
  // graph's Concept stamps, never a store (src/packages/installed.ts) — and
  // the two writes (src/packages/install.ts, §3). Installing is a person's
  // act, putting someone's code in this process: behind the key at full
  // scope (the gate 403s a peer's write) and never a meta/* twin. One write
  // at a time: an install checks every name before its first write.
  const packageDeps: PackageDeps = {
    workspace,
    cache: packageStore,
    ...(graph ? { graph } : {}),
    claims: claimsAuthoring,
    ...(verifier ? { verifyPublish: (subject) => verifier.verifyPublish(subject) } : {}),
    ...(secretsCap ? { secrets: secretsCap } : {}),
    path: bootEnv()["PATH"] ?? "",
    apps,
    getRegistry: async () => {
      await rebuildRegistry();
      return registry;
    },
  };
  let packageWrites: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = packageWrites.then(fn);
    packageWrites = next.catch(() => undefined);
    return next;
  };
  // The writes, in process (`strut.packages`) and behind the routes below.
  const busyWorkflow = (workflow: string) => [...controllers.keys()].some((k) => k.startsWith(`${workflow}/`));
  const forgetWorkflow = (workflow: string) => automations.forget(workflow);
  // The indexes this strut FOLLOWS (src/packages/indexes.ts): a bare name
  // installs through their signed cards, and `/packages/search` reads them
  // and the peers. On file at boot from STRUT_PACKAGE_INDEXES (else the
  // built-in defaults) and `opts.packageIndexes`, each replacing its id; a
  // bad env value fails the boot.
  const indexes = createIndexes({ file: join(packageStore.root, INDEXES_FILE), cache: packageStore, peers: peersCap });
  for (const sub of [...parseIndexesEnv(bootEnv()["STRUT_PACKAGE_INDEXES"]), ...(opts.packageIndexes ?? [])]) {
    const problem = indexSubscriptionProblem(sub);
    if (problem) throw new Error(`packageIndexes: ${problem}`);
    await indexes.set(sub);
  }
  // The package/* steps' door (src/steps/lib/package/): the store's reads —
  // search, a package's page, the Concept tree — and package/install's,
  // below, once the in-process door exists.
  const packagesBag = ((services as Record<string, unknown>)["packages"] ??= {
    search: (q, o) => indexes.search(q, o),
    get: (n, o) => indexes.get(n, o),
    concepts: (q, o) => indexes.concepts(q, o),
    concept: (n, o) => indexes.concept(n, o),
  } satisfies PackagesCapability) as Record<string, unknown>;
  /** A bare name (`acme/linear`) → `pk:` through the first card that lists
   *  its publisher, the row's catalog URLs tried in order; any other ref as
   *  it came. */
  const installByName = async (ref: string, opts: Parameters<Strut["packages"]["install"]>[1] = {}): Promise<InstallResult> => {
    const { index: which, ...rest } = opts;
    const run = (r: string, o: typeof rest) => oneAtATime(() => installPackage(packageDeps, r, { ...o, busy: busyWorkflow, forget: forgetWorkflow }));
    if (!PACKAGE_NAME.test(ref)) return run(ref, rest);
    if (rest.url) throw new Error(`package_source_invalid: ${ref} is a name, looked up in an index; a url goes with a pk: ref`);
    const named = await indexes.resolveName(ref, which ? { index: which } : {});
    let last: unknown;
    for (const url of named.urls) {
      try {
        return await run(named.ref, { ...rest, url });
      } catch (err) {
        last = err;
        // Only a host that did not answer moves on to the row's next URL.
        if (!(err instanceof Error && err.message.startsWith("package_fetch_failed:"))) throw err;
      }
    }
    throw last;
  };
  const packages: Strut["packages"] = {
    booted: Promise.resolve([]),
    install: (ref, opts = {}) => {
      if (registryWasInjected) return Promise.reject(new Error("package_unsupported: installing is disabled when the registry is provided at construction time"));
      return installByName(ref, opts);
    },
    uninstall: (pkg, opts = {}) =>
      oneAtATime(async () => {
        const out = await uninstallPackage(packageDeps, pkg, { ...opts, busy: busyWorkflow, forget: forgetWorkflow });
        await rebuildRegistry();
        return out;
      }),
  };
  // `package/install`'s door (src/steps/lib/package/install.ts; plans/
  // marketplace.md §8, ruled 2026-10-29: an agent ASKS, a person accepts):
  // the install runs only as the apply of an ACCEPTED proposal of that step
  // for this very ref. The record on disk is the proof — an `accepted`
  // `package/install` proposal whose input names `ref` — so no step, authored
  // or installed, reaches this with a forged `ctx.proposal`; `applied` and
  // `failed` records do not open it again (a failed apply is accepted again
  // by the person, which puts it back to `accepted`).
  packagesBag["install"] ??= async (ref: string, opts: { proposal: string; index?: string; digest?: string; url?: string; actor?: string }) => {
    const rec = typeof opts?.proposal === "string" ? await readProposal(proposalsDir, opts.proposal) : null;
    const asked = (rec?.input ?? {}) as { package?: unknown; digest?: unknown };
    if (!rec || rec.step !== "package/install" || rec.status !== "accepted" || asked.package !== ref || (asked.digest !== undefined && asked.digest !== opts.digest)) {
      throw new Error(
        `package_install_needs_person: installing ${ref} runs only as the apply of a proposal a person accepted for it` +
          (rec ? ` (proposal ${rec.id} is ${rec.status}, for ${rec.step}${asked.package ? ` ${String(asked.package)}` : ""})` : ""),
      );
    }
    const { proposal: _id, ...rest } = opts;
    return packages.install(ref, rest);
  };
  /** A refusal's code (`package_conflict: …`) → its status. */
  const packageError = (c: Context, err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    const code = /^([a-z_]+):/.exec(message)?.[1] ?? "";
    const status = ["package_conflict", "package_update_not_built", "package_busy", "package_distro_owned"].includes(code) || code.startsWith("catalog_")
      ? 409
      : code === "package_index_unreachable"
        ? 502
      : ["package_not_installed", "package_not_published", "package_not_listed", "package_index_unknown"].includes(code)
        ? 404
        : code === "bad_package" || code.startsWith("package_")
          ? 400
          : 500;
    return c.json({ error: message }, status);
  };
  app.get("/packages", async (c) => c.json({ packages: await listInstalledPackages(packageDeps) }));
  app.post("/packages/install", async (c) => {
    if (registryWasInjected) return c.json({ error: "Installing is disabled when the registry is provided at construction time" }, 409);
    const body = await c.req.json<{ ref?: unknown; digest?: unknown; url?: unknown; index?: unknown }>().catch(() => ({}) as { ref?: unknown; digest?: unknown; url?: unknown; index?: unknown });
    if (typeof body.ref !== "string" || !body.ref) return c.json({ error: "ref is required: file:/path/to/package, pk:<key>/<publisher>/<name> with url, or a name (publisher/name) looked up in the indexes this strut server follows" }, 400);
    if (body.index !== undefined && typeof body.index !== "string") return c.json({ error: "index is the id of an index this strut server follows (GET /packages/indexes)" }, 400);
    if (body.digest !== undefined && (typeof body.digest !== "string" || !PACKAGE_DIGEST.test(body.digest))) {
      return c.json({ error: "digest is sha256:<64 hex>" }, 400);
    }
    if (body.url !== undefined && (typeof body.url !== "string" || !/^https?:\/\/\S+$/.test(body.url))) {
      return c.json({ error: "url is where the publisher's catalog is served: an http(s) URL (a strut server's …/packages/catalog?public=1)" }, 400);
    }
    const actor = await resolveActor(c);
    try {
      const result = await packages.install(body.ref, { ...(body.digest ? { digest: body.digest as string } : {}), ...(body.url ? { url: body.url as string } : {}), ...(body.index ? { index: body.index as string } : {}), ...(actor ? { actor } : {}) });
      return c.json(result, 201);
    } catch (err) {
      return packageError(c, err);
    }
  });
  // A package BUILT from this workspace (src/packages/build.ts, §2): what the
  // named workflows and apps can execute, the named steps, apps and Concepts,
  // written into the cache — so the archive route above serves it and an install takes it
  // from `file:<dir>`. A person's act like install, one write at a time.
  /** A build request's body, checked, or the reason it is not one. */
  const buildRequestOf = (body: Record<string, unknown>): BuildRequest | string => {
    const str = (k: string) => body[k] === undefined || typeof body[k] === "string";
    const list = (k: string) => body[k] === undefined || (Array.isArray(body[k]) && (body[k] as unknown[]).every((v) => typeof v === "string"));
    if (typeof body["package"] !== "string" || typeof body["version"] !== "string" || !str("description") || !str("license")) {
      return "package and version are required strings (publisher/name, 1.4.0); description and license are strings";
    }
    if (!["workflows", "steps", "concepts", "apps", "types"].every(list)) return "workflows, steps, concepts, apps and types are lists of names";
    const requires = body["requires"] as { packages?: unknown } | undefined;
    const pinsOk = (p: unknown) => Array.isArray(p) && p.every((r) => r && typeof r === "object" && typeof (r as { package?: unknown }).package === "string" && typeof (r as { digest?: unknown }).digest === "string");
    if (requires !== undefined && (!requires || typeof requires !== "object" || (requires.packages !== undefined && !pinsOk(requires.packages)))) {
      return "requires is { packages: [{ package, digest }] }: packages built on this strut server, by the digest their build returned";
    }
    return body as unknown as BuildRequest;
  };
  const builtBody = (built: Awaited<ReturnType<typeof buildPackage>>) => ({
    package: built.package,
    version: built.version,
    digest: built.digest,
    files: built.files,
    requires: built.manifest.requires ?? {},
    warnings: built.warnings,
  });
  app.post("/packages/build", async (c) => {
    const { dryRun, ...body } = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    if (dryRun !== undefined && typeof dryRun !== "boolean") return c.json({ error: "dryRun is true or false" }, 400);
    const req = buildRequestOf(body);
    if (typeof req === "string") return c.json({ error: req }, 400);
    try {
      if (dryRun) return c.json(builtBody(await oneAtATime(() => buildPackage(packageDeps, req, { dryRun: true }))), 200);
      return c.json(builtBody(await oneAtATime(() => buildPackage(packageDeps, req))), 201);
    } catch (err) {
      return packageError(c, err);
    }
  });

  // ── The publisher (plans/marketplace.md §13, §12.1) ─────────────────────
  // This strut's Ed25519 key, in a file of its own beside peers.json, and
  // the catalog it seals with it: what it PUBLISHED, where `GET /packages`
  // folds what it installed. The byte host is this strut: the catalog is
  // `GET /packages/catalog`, each release's archive the route above. Reads
  // are open to any credential (a subscriber's); the writes are a person's.
  const publisherSecrets = secretStore instanceof FileSecretStore ? new FileSecretStore(dataDir, PUBLISHER_FILE) : new MemorySecretStore();
  const publisher = publisherStore(publisherSecrets, {
    unsafe: () =>
      publisherSecrets instanceof FileSecretStore && !bootEnv()["STRUT_SECRET_KEY"]
        ? `STRUT_SECRET_KEY is not set, so ${PUBLISHER_FILE} would be stored under the dev default key — obfuscated, not encrypted. Set it and restart before publishing`
        : undefined,
  });
  const catalogDeps = { publisher, catalogs: catalogStore(dataDir), publicCatalogs: publicCatalogStore(dataDir) };
  /** A publisher refusal's code → its status, else as a package refusal. */
  const catalogError = (c: Context, err: unknown) => {
    const code = /^([a-z_]+):/.exec(err instanceof Error ? err.message : String(err))?.[1] ?? "";
    const status = ({ publisher_unsafe_key: 409, publisher_name: 400, catalog_no_release: 404, catalog_channel: 400, catalog_channel_public: 409, catalog_private_requirement: 409, publisher_not_public: 409 } as Record<string, 400 | 404 | 409>)[code];
    return status ? c.json({ error: (err as Error).message }, status) : packageError(c, err);
  };
  app.get("/publisher", async (c) => {
    const info = await publisher.get();
    return info ? c.json(info) : c.json({ error: "this strut server has no publisher key yet: POST /publisher, or publish a package" }, 404);
  });
  app.post("/publisher", async (c) => {
    try {
      const { info, minted } = await publisher.ensure();
      return c.json(info, minted ? 201 : 200);
    } catch (err) {
      return catalogError(c, err);
    }
  });
  // The publisher's NAME (plans/packages-ux.md §2): the first segment of
  // every package built here, set once — the UI composes package names
  // from it, and a publish under another prefix is refused below.
  app.put("/publisher", async (c) => {
    const body = await c.req.json<{ name?: unknown }>().catch(() => ({}) as { name?: unknown });
    if (typeof body.name !== "string" || !PUBLISHER_NAME.test(body.name)) {
      return c.json({ error: "name is the publisher's prefix segment, lowercase [a-z][a-z0-9-]* (`stakwork` in `stakwork/tools`)" }, 400);
    }
    try {
      return c.json(await publisher.setName(body.name));
    } catch (err) {
      return catalogError(c, err);
    }
  });
  // A subscriber's READ TOKEN (auth.ts, "Catalog read tokens"): what a
  // fleet's operator hands each strut that follows this one's catalog, with
  // the key. The key is minted first when there is none.
  app.post("/publisher/tokens", async (c) => {
    const body = await c.req.json<{ subscriber?: unknown; days?: unknown }>().catch(() => ({}) as { subscriber?: unknown; days?: unknown });
    if (typeof body.subscriber !== "string" || !body.subscriber.trim() || body.subscriber.length > 200) {
      return c.json({ error: "subscriber is who the token is for: the strut server's name in the fleet (a workspace slug)" }, 400);
    }
    if (body.days !== undefined && !(typeof body.days === "number" && body.days > 0 && body.days <= 366)) return c.json({ error: "days is a number of days, at most 366" }, 400);
    try {
      const { info } = await publisher.ensure();
      const minted = catalogToken(info.key, body.subscriber.trim(), ((body.days as number | undefined) ?? CATALOG_TOKEN_DAYS) * 86_400_000);
      if (!minted) return c.json({ error: "no secret to sign a token: set STRUT_API_KEY or STRUT_SECRET_KEY" }, 409);
      return c.json({ key: info.key, subscriber: body.subscriber.trim(), token: minted.token, exp: minted.exp }, 201);
    } catch (err) {
      return catalogError(c, err);
    }
  });
  // Build a package and publish it: its release added to the catalog, and
  // `channel` moved to it when named. One write at a time with the rest.
  app.post("/packages/publish", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const { channel, public: pub, ...rest } = body;
    if (channel !== undefined && typeof channel !== "string") return c.json({ error: "channel is a channel's name (stable, canary)" }, 400);
    if (pub !== undefined && (typeof pub !== "boolean" || !channel)) return c.json({ error: "public is true to make the channel public (it needs a channel), or false" }, 400);
    const req = buildRequestOf(rest);
    if (typeof req === "string") return c.json({ error: req }, 400);
    try {
      const { built, catalog, publicBefore } = await oneAtATime(async () => {
        const { info } = await publisher.ensure(); // refused before a build when the key cannot be kept safely
        // With a name set, every package published here is under it.
        if (info.name && req.package.split("/")[0] !== info.name) {
          throw new Error(`package_build_refused: ${req.package} is not under this strut server's publisher ${info.name}: a package published here is named ${info.name}/<name>`);
        }
        const built = await buildPackage(packageDeps, req);
        const publicBefore = (await catalogDeps.publicCatalogs.current())?.digest;
        const catalog = await publishRelease(catalogDeps, { manifest: built.manifest, digest: built.digest, ...(channel ? { channel } : {}), ...(pub !== undefined ? { public: pub as boolean } : {}) });
        return { built, catalog, publicBefore };
      });
      pingSubscribers(catalog.card.key);
      void pingPublic(publicBefore);
      return c.json({ ...builtBody(built), ...(channel ? { channel } : {}), catalog: { key: catalog.card.key, seq: catalog.card.seq, digest: catalog.digest } }, 201);
    } catch (err) {
      return catalogError(c, err);
    }
  });
  // The catalog as served — its RFC 8785 bytes, which a reader checks
  // against the key it subscribed to — the current one, or one by digest.
  // `?public=1` is the PUBLIC catalog, sealed by the public key, open to
  // anyone (§13 "One publisher, two keys").
  app.get("/packages/catalog", async (c) => {
    const digest = c.req.query("digest");
    if (digest !== undefined && !PACKAGE_DIGEST.test(digest)) return c.json({ error: "digest is sha256:<64 hex>" }, 400);
    const store = publicPackageRead(c) ? catalogDeps.publicCatalogs : catalogDeps.catalogs;
    const file = digest ? await store.get(digest) : await store.current();
    // A `?t=` strut cannot vouch for is refused whatever the gate's mode,
    // as for a file token: a host's gate hands a token-bearing read through.
    const token = c.req.query("t") !== undefined ? catalogTokenOf(c) : undefined;
    if (!publicPackageRead(c) && c.req.query("t") !== undefined && (!token || token.key !== (await publisher.get())?.key)) {
      return c.json({ error: "unauthorized: not a catalog token this strut server minted" }, 401);
    }
    if (!file) {
      return c.json({ error: digest ? `no ${publicPackageRead(c) ? "public " : ""}catalog at ${digest} here` : publicPackageRead(c) ? "this strut server has made nothing public yet" : "this strut server has published nothing yet" }, 404);
    }
    const etag = `"${file.digest}"`;
    const headers = {
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
      // The current one changes with every publish; one by digest never does.
      "cache-control": digest ? "private, max-age=31536000, immutable" : "private, no-cache",
      etag,
    };
    if (etagMatches(c.req.header("if-none-match"), etag)) return c.body(null, 304, headers);
    return c.body(file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength) as ArrayBuffer, 200, headers);
  });
  // Point a channel at a release the catalog lists — a rollback is moving
  // it back — or take a package out of it (`digest: null`). `public: true`
  // marks the channel public first (**Make public** is this, on the
  // channel `public`): the public key is minted, and the release is listed
  // in the public catalog for anyone. A public channel never goes private.
  app.put("/packages/channels/:channel", async (c) => {
    const body = await c.req.json<{ package?: unknown; digest?: unknown; public?: unknown }>().catch(() => ({}) as { package?: unknown; digest?: unknown; public?: unknown });
    if (typeof body.package !== "string" || !(body.digest === null || (typeof body.digest === "string" && PACKAGE_DIGEST.test(body.digest)))) {
      return c.json({ error: "package is publisher/name, and digest is sha256:<64 hex> or null" }, 400);
    }
    if (body.public !== undefined && typeof body.public !== "boolean") return c.json({ error: "public is true to make the channel public, or false" }, 400);
    try {
      const { catalog, publicBefore } = await oneAtATime(async () => {
        const publicBefore = (await catalogDeps.publicCatalogs.current())?.digest;
        const catalog = await moveChannel(catalogDeps, { channel: c.req.param("channel"), package: body.package as string, digest: body.digest as string | null, ...(body.public !== undefined ? { public: body.public as boolean } : {}) });
        return { catalog, publicBefore };
      });
      pingSubscribers(catalog.card.key);
      void pingPublic(publicBefore);
      const info = await publisher.get();
      return c.json({ channel: c.req.param("channel"), package: body.package, digest: body.digest, public: info?.publicChannels.includes(c.req.param("channel")) ?? false, catalog: { key: catalog.card.key, seq: catalog.card.seq, digest: catalog.digest } });
    } catch (err) {
      return catalogError(c, err);
    }
  });
  /** The same ping with the PUBLIC key, when the public catalog changed —
   *  what an index strut among the peers follows (§7). */
  const pingPublic = async (before: string | undefined) => {
    const after = (await catalogDeps.publicCatalogs.current().catch(() => undefined))?.digest;
    if (!after || after === before) return;
    const key = (await publisher.get().catch(() => undefined))?.public;
    if (key) pingSubscribers(key);
  };
  /** Tell every peer on file that this strut's catalog moved, so a strut
   *  that subscribes to it reads it now instead of at its next poll
   *  (§12.1). Best effort and detached: the ping carries nothing, and a
   *  peer that subscribes to nothing of ours ignores it. */
  const pingSubscribers = (key: string) => {
    void (async () => {
      const peers = await peerRecords.list().catch(() => []);
      await Promise.allSettled(
        peers.map(async (peer) => {
          const res = await peersCap.fetch(peer.id, "/packages/subscriptions/sync", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ key }),
            signal: AbortSignal.timeout(10_000),
          });
          await res.body?.cancel();
        }),
      );
    })();
  };

  // ── Subscriptions (plans/marketplace.md §12.1) ──────────────────────────
  // This strut following another's catalog by its KEY, and applying each
  // release through the distro's door (src/packages/subscriptions.ts). The
  // record is the operator's (full scope), in an encrypted file beside
  // peers.json — its read token is a credential; `GET` is the fleet's view.
  // Registered before the uninstall route, whose `/packages/:publisher/:name`
  // would take `/packages/subscriptions/<id>`.
  const subscriptionSecrets = secretStore instanceof FileSecretStore ? new FileSecretStore(dataDir, SUBSCRIPTIONS_FILE) : new MemorySecretStore();
  const subscriptions = createSubscriptions({
    secrets: subscriptionSecrets,
    dir: join(dataDir, "packages", "subscriptions"),
    cache: packageStore,
    install: (refs, o) => {
      if (registryWasInjected) return Promise.reject(new Error("package_unsupported: installing is disabled when the registry is provided at construction time"));
      return oneAtATime(() => installPackages(packageDeps, refs, { ...o, busy: busyWorkflow, forget: forgetWorkflow }));
    },
    uninstall: (pkg, o) => packages.uninstall(pkg, o),
    installed: () => listInstalledPackages(packageDeps),
  });
  // ── The indexes this strut FOLLOWS (§7, step 7's client half) ──────────
  // `{ id, key, urls }`: the operator's (full scope; a peer reads). Search
  // reads each index strut's derived `/index/packages` and every peer's
  // `GET /packages` — a peer asking gets the indexes' answer alone, never a
  // fan-out over this strut's own peers. Before the uninstall route, whose
  // `/packages/:publisher/:name` would take `/packages/indexes/<id>`.
  app.get("/packages/indexes", async (c) => c.json({ indexes: await indexes.list() }));
  app.put("/packages/indexes/:id", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const sub = { ...body, id: c.req.param("id") } as IndexSubscription;
    const problem = indexSubscriptionProblem(sub);
    if (problem) return c.json({ error: `package_index_invalid: ${problem}` }, 400);
    await indexes.set(sub);
    // The first read now, so a wrong key or URL shows at once.
    await indexes.card(sub.id).catch(() => undefined);
    return c.json((await indexes.list()).find((s) => s.id === sub.id));
  });
  app.delete("/packages/indexes/:id", async (c) => {
    const removed = await indexes.remove(c.req.param("id"));
    return removed ? c.json({ ok: true, id: c.req.param("id") }) : c.json({ error: `this strut server follows no index "${c.req.param("id")}"` }, 404);
  });
  app.get("/packages/search", async (c) => {
    const limit = Number(c.req.query("limit"));
    const peers = c.req.query("peers") !== "0" && !isPeerScope(await scopeOf(c));
    return c.json(await indexes.search(c.req.query("q") ?? "", { ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}), peers }));
  });

  app.get("/packages/subscriptions", async (c) => c.json({ subscriptions: await subscriptions.list() }));
  app.put("/packages/subscriptions/:id", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const sub = { ...body, id: c.req.param("id") } as Subscription;
    const problem = subscriptionProblem(sub);
    if (problem) return c.json({ error: `subscription_invalid: ${problem}` }, 400);
    const info = await subscriptions.set(sub);
    // The first read now; its outcome is on GET /packages/subscriptions.
    void subscriptions.sync(sub.id);
    return c.json(info);
  });
  app.delete("/packages/subscriptions/:id", async (c) => {
    try {
      const out = await subscriptions.delete(c.req.param("id"), { uninstall: c.req.query("uninstall") === "1" });
      if (!out.removed) return c.json({ error: `no subscription "${c.req.param("id")}" here` }, 404);
      return c.json({ ok: true, ...out });
    } catch (err) {
      return packageError(c, err);
    }
  });
  // The publisher's ping (a peer may send it): read the catalogs now — of
  // the subscriptions to `key`, or all of them. Answered at once.
  app.post("/packages/subscriptions/sync", async (c) => {
    const body = await c.req.json<{ key?: unknown }>().catch(() => ({}) as { key?: unknown });
    if (body.key !== undefined && typeof body.key !== "string") return c.json({ error: "key is a publisher key" }, 400);
    void subscriptions.syncAll(body.key ? { key: body.key } : {});
    // The index follows the same ping: a listed publisher's public catalog moved.
    if (index) void index.crawl(body.key ? { key: body.key } : {}).catch(() => undefined);
    return c.json({ ok: true }, 202);
  });

  // ── The package INDEX (plans/marketplace.md §7, step 7) ─────────────────
  // This strut as the phone book and the crawler behind it (src/packages/
  // index.ts): the rows are a person's (full scope), the card and the
  // search are anyone's — open in the gate, as the public catalog is.
  /** The base a caller OUTSIDE the UI is handed links on: `STRUT_PUBLIC_URL`
   *  (`opts.publicUrl`), else the request's own origin (a proxy's headers
   *  honored) — the MCP doors' links, the index door's store links. */
  const publicUrlOf = (c: Context) => {
    if (opts.publicUrl) return opts.publicUrl.replace(/\/+$/, "");
    const url = new URL(c.req.url);
    const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(/:$/, "");
    const host = c.req.header("x-forwarded-host")?.split(",")[0]?.trim() || c.req.header("host") || url.host;
    return `${proto}://${host}`;
  };
  const index: PackageIndex | null = indexConfig
    ? createPackageIndex({
        secrets: publisherSecrets,
        dir: indexDir(dataDir),
        cache: packageStore,
        ...(indexConfig.urls ? { urls: indexConfig.urls } : {}),
        // What this strut knows of a step a package's workflow uses — a lib
        // step's `effect` and `secrets` — for the derived page's flags.
        stepInfo: (type) => {
          const def = registry[type];
          return def ? { ...(def.effect ? { effect: def.effect } : {}), ...(def.secrets ? { secrets: def.secrets } : {}), ...(def.description ? { description: def.description } : {}) } : undefined;
        },
        unsafe: () =>
          publisherSecrets instanceof FileSecretStore && !bootEnv()["STRUT_SECRET_KEY"]
            ? `STRUT_SECRET_KEY is not set, so the index key in ${PUBLISHER_FILE} would be stored under the dev default key — obfuscated, not encrypted. Set it and restart before listing a publisher`
            : undefined,
      })
    : null;
  if (index) {
    const indexError = (c: Context, err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const code = /^([a-z_]+):/.exec(message)?.[1] ?? "";
      return c.json({ error: message }, code === "index_row_invalid" ? 400 : code === "publisher_unsafe_key" ? 409 : 500);
    };
    app.get("/index", async (c) => {
      const info = await index.info();
      return info ? c.json(info) : c.json({ error: "this index has no key yet: PUT /index/:prefix lists the first publisher and mints it" }, 404);
    });
    app.put("/index/:prefix", async (c) => {
      const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
      const problem = indexRowProblem(c.req.param("prefix"), body);
      if (problem) return c.json({ error: `index_row_invalid: ${problem}` }, 400);
      try {
        return c.json(await oneAtATime(() => index.setRow(c.req.param("prefix"), body as unknown as IndexRow)));
      } catch (err) {
        return indexError(c, err);
      }
    });
    app.delete("/index/:prefix", async (c) => {
      try {
        const removed = await oneAtATime(() => index.removeRow(c.req.param("prefix")));
        return removed ? c.json({ ok: true, prefix: c.req.param("prefix") }) : c.json({ error: `no publisher ${c.req.param("prefix")} in this index` }, 404);
      } catch (err) {
        return indexError(c, err);
      }
    });
    // A LIVE row (plans/public-surface.md §8): where a publisher server's
    // public view is served — no key, no catalog — sealed into the card's
    // `live` map beside `publishers`, and read now. A person's act.
    app.put("/index/live/:prefix", async (c) => {
      const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
      const problem = liveRowProblem(c.req.param("prefix"), body);
      if (problem) return c.json({ error: `index_row_invalid: ${problem}` }, 400);
      try {
        return c.json(await oneAtATime(() => index.setLive(c.req.param("prefix"), body as unknown as IndexLiveRow)));
      } catch (err) {
        return indexError(c, err);
      }
    });
    app.delete("/index/live/:prefix", async (c) => {
      try {
        const removed = await oneAtATime(() => index.removeLive(c.req.param("prefix")));
        return removed ? c.json({ ok: true, prefix: c.req.param("prefix") }) : c.json({ error: `no live row ${c.req.param("prefix")} in this index` }, 404);
      } catch (err) {
        return indexError(c, err);
      }
    });
    // Read the listed publishers' catalogs now (full scope; a peer's ping
    // arrives on /packages/subscriptions/sync).
    app.post("/index/crawl", async (c) => c.json({ crawled: await index.crawl() }));
    // Open to anyone from here on.
    app.get("/index/catalog", async (c) => {
      const digest = c.req.query("digest");
      if (digest !== undefined && !PACKAGE_DIGEST.test(digest)) return c.json({ error: "digest is sha256:<64 hex>" }, 400);
      const file = await index.catalog(digest);
      if (!file) return c.json({ error: digest ? `no index catalog at ${digest} here` : "this index lists no publisher yet" }, 404);
      const etag = `"${file.digest}"`;
      const headers = { "content-type": "application/json", "x-content-type-options": "nosniff", "cache-control": digest ? "public, max-age=31536000, immutable" : "public, no-cache", etag };
      if (etagMatches(c.req.header("if-none-match"), etag)) return c.body(null, 304, headers);
      return c.body(file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength) as ArrayBuffer, 200, headers);
    });
    // What the live rows' public views show, as last read: apps, workflows,
    // steps and Concept roots, each with its publisher's base URL — the
    // store reads the item itself from `<url>/public/...` in the visitor's
    // browser. Open to anyone.
    app.get("/index/live", async (c) => c.json({ items: await index.live(c.req.query("q") ?? "") }, 200, { "cache-control": "public, no-cache" }));
    app.get("/index/packages", async (c) => {
      const limit = Number(c.req.query("limit") ?? 100);
      return c.json({ packages: await index.search(c.req.query("q") ?? "", Number.isFinite(limit) ? limit : 100) }, 200, { "cache-control": "public, no-cache" });
    });
    app.get("/index/packages/:publisher/:name", async (c) => {
      const name = `${c.req.param("publisher")}/${c.req.param("name")}`;
      const page = await index.package(name);
      return page ? c.json(page, 200, { "cache-control": "public, no-cache" }) : c.json({ error: `no listed publisher's catalog has ${name}` }, 404);
    });
    // The Concept pages across every crawled package (plans/marketplace.md
    // §7, the store): the tree, and one page with its docs.
    app.get("/index/concepts", async (c) => c.json({ concepts: await index.concepts(c.req.query("q") ?? "") }, 200, { "cache-control": "public, no-cache" }));
    app.get("/index/concepts/:name", async (c) => {
      const name = c.req.param("name");
      const page = await index.concept(name);
      return page ? c.json(page, 200, { "cache-control": "public, no-cache" }) : c.json({ error: `no listed package carries a Concept page named ${name}` }, 404);
    });
    // The same reads as MCP tools — search_packages, get_package,
    // get_concept — for an agent with no credential (src/packages/
    // index-tools.ts; src/ai/mcp.ts adapts them like the other doors, the
    // SDK loaded on the first request). Part of the role, whatever
    // `enableMcp` says of the keyed doors: it is the store's face for an
    // agent, as `?store=1` is for a person. Stateless, POST alone.
    app.post(INDEX_MCP, async (c) => {
      const { createMcpDoor, toolsetServer } = await import("./ai/mcp.js");
      const { buildIndexTools, indexInstructions } = await import("./packages/index-tools.js");
      const publicUrl = publicUrlOf(c);
      const store = serveUi ? publicUrl : undefined;
      return createMcpDoor(() =>
        toolsetServer({ tools: buildIndexTools(index, { ...(store ? { store } : {}) }), instructions: indexInstructions({ publicUrl, ...(store ? { store } : {}) }) }),
      ).handle(c.req.raw);
    });
    const indexMcpNotAllowed = (c: Context) => c.json({ error: "method not allowed: /index/mcp takes POST (JSON-RPC over HTTP, stateless)" }, 405);
    app.get(INDEX_MCP, indexMcpNotAllowed);
    app.delete(INDEX_MCP, indexMcpNotAllowed);
    // The store as ONE markdown page at the root (llmstxt.org), for an
    // agent that fetches URLs rather than speaks MCP: what the index is, the
    // door above, the open reads, every package and Concept page, each a
    // link to its JSON page here. Open like the reads; derived like them.
    app.get("/llms.txt", async (c) => {
      const { llmsTxt } = await import("./packages/index-tools.js");
      const publicUrl = publicUrlOf(c);
      const text = await llmsTxt(index, { publicUrl, ...(serveUi ? { store: publicUrl } : {}) });
      return c.body(text, 200, { "content-type": "text/markdown; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "public, no-cache" });
    });
  }

  const envPoll = Number(bootEnv()["STRUT_DISTRO_POLL_MINUTES"] ?? 10);
  const pollMinutes = opts.subscriptionPoll ?? (Number.isFinite(envPoll) && envPoll >= 0 ? envPoll : 10);
  const subscriptionTimers: NodeJS.Timeout[] = [];
  if (pollMinutes !== false) {
    const tick = () => {
      void subscriptions.syncAll();
      if (index) void index.crawl().catch(() => undefined);
    };
    subscriptionTimers.push(setTimeout(tick, 3_000));
    if (pollMinutes > 0) subscriptionTimers.push(setInterval(tick, pollMinutes * 60_000));
    for (const t of subscriptionTimers) t.unref?.();
  }

  app.delete("/packages/:publisher/:name", async (c) => {
    const pkg = `${c.req.param("publisher")}/${c.req.param("name")}`;
    try {
      const result = await packages.uninstall(pkg);
      return c.json({ ok: true, ...result });
    } catch (err) {
      return packageError(c, err);
    }
  });

  // ── Jobs (plans/jobs.md §2.2, §6) ────────────────────────────────────────
  // The files in a job's directory — what a session-carrying agent wrote
  // across runs (`job/dir`; src/jobs.ts). Read-only, and served sandboxed
  // like a run's artifacts: an agent wrote them. The listing skips the
  // repositories checked out into the job. A job exists once it has a
  // directory or a record (a hold can come before the first `job/dir`).

  const jobRoute = (c: Context): { id: string; root: string } | Response => {
    let id: string;
    try {
      id = decodeURIComponent(c.req.param("id") ?? "");
    } catch {
      return c.json({ error: "malformed job id" }, 400);
    }
    const problem = idProblem(id);
    if (problem) return c.json({ error: `job id "${id}" ${problem}` }, 400);
    const root = jobRoot(dataDir, id);
    if (!existsSync(root) && !existsSync(`${root}.json`)) return c.json({ error: `No job "${id}"` }, 404);
    return { id, root };
  };

  // The index (plans/job-index.md §2): every job, and one job read back —
  // its runs with their status, its threads, holds, files and current
  // deliverables. Thin over the capability the `job/*` steps read through;
  // 501 when a consumer's own `jobs` capability keeps no index.
  const jobsCap = (services as Record<string, unknown>)["jobs"] as JobsCapability | undefined;
  const NO_JOB_INDEX = "jobs are managed by an injected capability with no index";
  // `?mine=1` keeps the jobs the request's actor launched a run of. The
  // response names that actor when the request carries one, so a UI knows
  // whether the filter means anything here; `mine` with no actor lists
  // nothing — none of them are yours.
  app.get("/jobs", async (c) => {
    if (!jobsCap?.list) return c.json({ error: NO_JOB_INDEX }, 501);
    const limit = Number(c.req.query("limit"));
    const actor = await resolveActor(c);
    const mine = c.req.query("mine") === "1";
    const jobs = mine && !actor
      ? []
      : await jobsCap.list({ q: c.req.query("q"), workflow: c.req.query("workflow"), ...(mine ? { actor } : {}), ...(limit > 0 ? { limit } : {}) });
    return c.json({ jobs, ...(actor ? { actor } : {}) });
  });

  // `?threads=0` leaves the thread fold out (the run list and the
  // deliverables alone, as before); `?nodes=1` adds each turn's touched
  // graph nodes; `?limit=N` bounds the runs the fold reads (newest first).
  app.get("/jobs/:id", async (c) => {
    if (!jobsCap?.get) return c.json({ error: NO_JOB_INDEX }, 501);
    const at = jobRoute(c);
    if (at instanceof Response) return at;
    const limit = Number(c.req.query("limit"));
    const view = await jobsCap.get(at.id, {
      threads: c.req.query("threads") !== "0",
      nodes: c.req.query("nodes") === "1",
      ...(limit > 0 ? { limit } : {}),
    });
    if (!view) return c.json({ error: `No job "${at.id}"` }, 404);
    // The job's claims (plans/job-claims.md §6) — where the layer is on.
    const claims = jobsCap.claims ? await jobsCap.claims(at.id) : null;
    return c.json(claims ? { ...view, claims } : view);
  });

  // A job's live updates (plans/live-feeds.md §1): `?since=` the cursor the
  // last read returned (or `now`), `?wait=` ms to hold while nothing is new,
  // `?limit=`. Answers for a job with no record yet: a reader may start
  // watching before the job's first run.
  app.get("/jobs/:id/updates", async (c) => {
    if (!jobsCap?.updates) return c.json({ error: "jobs are managed by an injected capability with no update feed" }, 501);
    let id: string;
    try {
      id = decodeURIComponent(c.req.param("id") ?? "");
    } catch {
      return c.json({ error: "malformed job id" }, 400);
    }
    const problem = idProblem(id);
    if (problem) return c.json({ error: `job id "${id}" ${problem}` }, 400);
    const wait = Number(c.req.query("wait"));
    const limit = Number(c.req.query("limit"));
    return c.json(
      await jobsCap.updates(id, {
        since: c.req.query("since"),
        ...(wait > 0 ? { wait } : {}),
        ...(limit > 0 ? { limit } : {}),
        signal: c.req.raw.signal,
      }),
    );
  });

  app.get("/jobs/:id/files", async (c) => {
    const refused = badToken(c);
    if (refused) return refused;
    const at = jobRoute(c);
    if (at instanceof Response) return at;
    const token = fileToken({ kind: "job", id: at.id });
    return c.json({ job: at.id, files: await listJobFiles(at.root, await readJobRecord(at.root)), ...(token ? { token } : {}) });
  });

  app.get("/jobs/:id/files/:path{.+}", async (c) => {
    const refused = badToken(c);
    if (refused) return refused;
    const at = jobRoute(c);
    if (at instanceof Response) return at;
    const relPath = c.req.param("path");
    try {
      const bytes = new Uint8Array(await readFile(jobFilePath(at.root, relPath)));
      return c.body(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        200,
        artifactHeaders(relPath, carriesFileToken(c)),
      );
    } catch (err: any) {
      if (err?.code === "ENOENT" || err?.code === "EISDIR") {
        return c.json({ error: `no file "${relPath}" in job "${at.id}"` }, 404);
      }
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // Close a job (§6): let every hold go — each through its release step, in
  // this process, with the registry and the bag — then remove its
  // repositories, directory and record. Runs, chats and sessions are
  // records of their own and stay. 409 while a run holds the directory; a
  // hold that will not release keeps the job (500, the error names it), so
  // a pod is never forgotten silently.
  app.delete("/jobs/:id", async (c) => {
    const at = jobRoute(c);
    if (at instanceof Response) return at;
    const shell = ((services as Record<string, unknown>)["shell"] as ShellCapability | undefined) ?? shellCapability();
    try {
      const { released } = await deleteJob(shell, at.root, at.id, releaseWith(registry, services));
      return c.json({ ok: true, job: at.id, released });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, message.startsWith("job_busy:") ? 409 : 500);
    }
  });

  // ── Proposals (plans/proposals.md §3) ──────────────────────────────────
  //
  // A gated tool call's record, and the person's door onto it. Reads list
  // the records; `decide` applies the step in code (never a model turn).
  // The actor of the decide request is recorded as who decided. A person
  // token's lists are its own; by id it reads any (`visibleTo`).

  const proposalsDir = proposalsRoot(dataDir);
  const STATUSES: ReadonlySet<string> = new Set(["pending", "accepted", "rejected", "applied", "failed"]);
  /** A person's decision, applied in code: the route's, and `proposal/decide`'s
   *  (a first-party page's, plans/jamie-app.md §3) through the bag. */
  const decide = (id: string, decision: Decision) =>
    decideProposal(proposalsDir, id, decision, {
      registry,
      services,
      mcpOf: (workflow, runId) => store.getRunMcp(workflow, runId),
      stepFor: (type) => mcpStepDef(type, mcpRegistry),
      notify: (job, update) => ((services as Record<string, unknown>)["jobs"] as JobsCapability | undefined)?.notify?.(job, update),
      changed: proposalChanged,
    });
  ownProposals.decide = decide;

  app.get("/proposals", async (c) => {
    const status = c.req.query("status");
    if (status !== undefined && !STATUSES.has(status)) return c.json({ error: `status must be one of ${[...STATUSES].join(", ")}` }, 400);
    const limitQ = c.req.query("limit");
    if (limitQ !== undefined && !/^[1-9]\d*$/.test(limitQ)) return c.json({ error: "limit must be a positive integer" }, 400);
    const scope = await scopeOf(c);
    const actor = await resolveActor(c);
    // What this request may see is decided on the index, before the limit
    // and before any file is read: a person token's poll reads its own.
    const proposals = await listProposals(proposalsDir, {
      viewer: { scope, ...(actor ? { actor } : {}) },
      ...(limitQ !== undefined ? { limit: Number(limitQ) } : {}),
      ...(c.req.query("job") !== undefined ? { job: c.req.query("job") } : {}),
      ...(c.req.query("session") !== undefined ? { session: c.req.query("session") } : {}),
      ...(c.req.query("runId") !== undefined ? { runId: c.req.query("runId") } : {}),
      ...(status !== undefined ? { status: status as ProposalStatus } : {}),
    });
    return c.json({ proposals });
  });

  // What happened to proposals after a cursor (plans/live-feeds.md, "Proposal
  // feed"): created / decided / applied / failed, ids and a short title, never
  // the input. `?cursor=` (or `since`), `?wait=` ms, `?limit=`. Scoped like the
  // list above. Registered BEFORE /proposals/:id, which would take "changes".
  app.get("/proposals/changes", async (c) => {
    const wait = Number(c.req.query("wait"));
    const limit = Number(c.req.query("limit"));
    return c.json(
      await proposalChanges.read({
        scope: await scopeOf(c),
        actor: await resolveActor(c),
        cursor: c.req.query("cursor") ?? c.req.query("since"),
        ...(wait > 0 ? { wait } : {}),
        ...(limit > 0 ? { limit: Math.min(limit, PROPOSAL_FEED_READ_MAX) } : {}),
        signal: c.req.raw.signal,
      }),
    );
  });

  app.get("/proposals/:id", async (c) => {
    const p = await readProposal(proposalsDir, c.req.param("id"));
    return p && visibleTo(await scopeOf(c), await resolveActor(c), p, { byId: true }) ? c.json(p) : c.json({ error: `No proposal "${c.req.param("id")}"` }, 404);
  });

  app.post("/proposals/:id/decide", async (c) => {
    const id = c.req.param("id");
    let body: { action?: unknown; input?: unknown; reason?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "JSON body required: { action: 'accept' | 'reject', input?, reason? }" }, 400);
    }
    if (body.action !== "accept" && body.action !== "reject") return c.json({ error: "action must be 'accept' or 'reject'" }, 400);
    if (body.input !== undefined && (typeof body.input !== "object" || body.input === null || Array.isArray(body.input))) {
      return c.json({ error: "input must be an object: the edits merged onto the proposal's input" }, 400);
    }
    if (body.reason !== undefined && typeof body.reason !== "string") return c.json({ error: "reason must be a string" }, 400);
    const actor = await resolveActor(c);
    const outcome = await decide(id, {
      action: body.action,
      ...(body.input ? { input: body.input as Record<string, unknown> } : {}),
      ...(body.reason ? { reason: body.reason } : {}),
      ...(actor ? { by: actor } : {}),
      scope: await scopeOf(c),
    });
    return c.json(outcome.body, outcome.status);
  });

  // ── Agent sessions (plans/agent-sessions.md §4) ───────────────────────
  //
  // The threads `agent` steps with `session` set continue. The id is a query
  // parameter (it may hold slashes). 501 when the consumer injected their
  // own `sessions` capability (we don't own that store).

  const sessionRoute = (c: Context): { id: string } | Response => {
    if (sessionsInjected) return c.json({ error: "sessions are managed by an injected capability" }, 501);
    const id = c.req.query("id") ?? "";
    const problem = idProblem(id);
    return problem ? c.json({ error: `session id "${id}" ${problem}` }, 400) : { id };
  };

  app.get("/sessions", async (c) => {
    if (sessionsInjected) return c.json({ error: "sessions are managed by an injected capability" }, 501);
    const busy = (id: string) => (sessions.holder(id) ? { busy: true } : {});
    if (c.req.query("id") === undefined) {
      return c.json({ sessions: (await sessionStore.list()).map((s) => ({ ...s, ...busy(s.id) })) });
    }
    const at = sessionRoute(c);
    if (at instanceof Response) return at;
    const thread = await sessionStore.load(at.id);
    const info = thread && sessionInfo(at.id, thread.turns);
    if (!thread || !info) return c.json({ error: `No session "${at.id}"` }, 404);
    return c.json({ ...info, ...busy(at.id), turnLog: thread.turns });
  });

  app.get("/sessions/messages", async (c) => {
    const at = sessionRoute(c);
    if (at instanceof Response) return at;
    const thread = await sessionStore.load(at.id);
    if (!thread) return c.json({ error: `No session "${at.id}"` }, 404);
    return c.json([{ role: "system", content: thread.system }, ...thread.messages]);
  });

  app.delete("/sessions", async (c) => {
    const at = sessionRoute(c);
    if (at instanceof Response) return at;
    const by = sessions.holder(at.id);
    if (by) return c.json({ error: `session "${at.id}" is in use by run ${by.runId} (${by.path})` }, 409);
    await sessionStore.delete(at.id);
    return c.json({ ok: true });
  });

  // ── Graph nodes ──────────────────────────────────────────────────────────
  // One node as the graph holds it NOW — what the run flyout opens when a
  // node an agent read is clicked (the run log records which node, its type
  // and its name; never its content). Read-only. 501 without a graph.
  //
  // Each read is held to its caller's reader list (src/graph/scope.ts): a
  // peer strut's (`peers`), or a person's — the key, a session, a person
  // token — (`ui`), when the host set `graphReaders`; a node outside it
  // reads as missing.
  const graphRouteKind = async (c: Context): Promise<"peers" | "ui"> => ((await scopeOf(c)) === "peer" ? "peers" : "ui");
  const graphReaderOf = async (c: Context) => readerFor(graph!, opts.graphReaders, await graphRouteKind(c));
  /** The per-type counts and change feed name what the graph holds: only
   *  for a reader that may read all of it. */
  const readsWholeGraph = async (c: Context) => mayQueryRaw(listFor(opts.graphReaders, await graphRouteKind(c)), graph!.reader, graph!.namespace);
  app.get("/graph/nodes/:ref_id", async (c) => {
    if (!graph) return c.json({ error: "this deployment has no graph" }, 501);
    const ref_id = c.req.param("ref_id");
    const node = await (await graphReaderOf(c)).getNode(ref_id);
    if (!node) return c.json({ error: `No node "${ref_id}" in the graph` }, 404);
    return c.json({ ref_id: node.ref_id, node_type: node.node_type ?? null, name: node.name ?? null, title: node.title ?? null, properties: node.properties });
  });

  // The names of one type's nodes a typed fragment matches — the Run
  // popover's typeahead for an input a step resolves by name (an input that
  // lands in graph/graph-get's `name`; web/src/run-inputs.ts). A read over
  // the backend's own reader, never a step the workflow names: the UI decides
  // what it calls. `?type=Concept&q=med&limit=8` → { nodes: [{ ref_id,
  // node_type, name, description? }] }, names starting with the fragment
  // first. Read-only. 501 without a graph, 400 without a type.
  app.get("/graph/names", async (c) => {
    if (!graph) return c.json({ error: "this deployment has no graph" }, 501);
    const type = (c.req.query("type") ?? "").trim();
    if (!type) return c.json({ error: "type is required" }, 400);
    const limit = Number(c.req.query("limit") ?? 8);
    return c.json({ nodes: await (await graphReaderOf(c)).namesLike(type, c.req.query("q") ?? "", Number.isFinite(limit) ? limit : 8) });
  });

  // A person moves one node or edge to another namespace — `shared`, or back
  // to `private` (plans/graph-memory-plan.md step 6; src/graph/set-namespace.ts).
  // `{ namespace }` → `{ kind, ref_id, from, namespace, moved }`. A full
  // credential only: peers and person tokens post nowhere here (the gate
  // above). Moving a node doesn't move its edges.
  for (const kind of ["node", "edge"] as const) {
    app.post(`/graph/${kind}s/:ref_id/namespace`, async (c) => {
      if (!graph) return c.json({ error: "this deployment has no graph" }, 501);
      const body = (await c.req.json().catch(() => null)) as { namespace?: unknown } | null;
      if (typeof body?.namespace !== "string" || !body.namespace.trim()) return c.json({ error: "namespace is required" }, 400);
      const { setNamespace } = await import("./graph/set-namespace.js");
      try {
        return c.json(await setNamespace(graph, { kind, ref_id: c.req.param("ref_id"), namespace: body.namespace }));
      } catch (e) {
        const code = (e as { code?: unknown }).code;
        return c.json({ error: e instanceof Error ? e.message : String(e), ...(typeof code === "string" ? { code } : {}) }, code === "NOT_FOUND" ? 404 : 400);
      }
    });
  }

  // The embedding pass (plans/semantic-search.md §1) as the graph backend
  // reports it: the sweep's position, per-type counts, the types it skips
  // and why, the newcomer mark, the last error. `{ enabled: false }` with
  // embeddings off. Read-only — a debugging read. 501 without a graph.
  app.get("/graph/embeddings", async (c) => {
    if (!graph) return c.json({ error: "this deployment has no graph" }, 501);
    if (!(await readsWholeGraph(c))) return c.json({ error: "this reader may not read every namespace in the graph" }, 403);
    return c.json(graph.embeddings ? graph.embeddings.status() : { enabled: false });
  });

  // The graph writes made through strut after a cursor (plans/live-feeds.md
  // §3): ids, types and time, the latest per node or edge. `?types=A,B`,
  // `?since=` the cursor the last read returned (or `now`), `?wait=` ms to
  // hold while nothing is new, `?limit=`. 501 without a graph.
  app.get("/graph/changes", async (c) => {
    if (!graphChanges) return c.json({ error: "this deployment has no graph" }, 501);
    if (!(await readsWholeGraph(c))) return c.json({ error: "this reader may not read every namespace in the graph" }, 403);
    const types = (c.req.query("types") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    const wait = Number(c.req.query("wait"));
    const limit = Number(c.req.query("limit"));
    return c.json(
      await graphChanges.read({
        ...(types.length ? { types } : {}),
        since: c.req.query("since"),
        ...(wait > 0 ? { wait } : {}),
        limit: limit > 0 ? Math.min(limit, GRAPH_FEED_READ_MAX) : GRAPH_FEED_READ_MAX,
        signal: c.req.raw.signal,
      }),
    );
  });

  // ── Secrets ──────────────────────────────────────────────────────────────
  // Deployment-scoped credential store behind `ctx.services.secrets`. Values
  // are write-only over the API: GET returns NAMES + metadata only, never the
  // value. 501 when the consumer injected their own `secrets` capability (we
  // don't own that store).

  app.get("/secrets", async (c) => {
    if (secretsInjected) {
      return c.json({ error: "secrets are managed by an injected capability" }, 501);
    }
    return c.json({ secrets: await secretStore.list() });
  });

  app.put("/secrets/:name", async (c) => {
    if (secretsInjected) {
      return c.json({ error: "secrets are managed by an injected capability" }, 501);
    }
    const name = c.req.param("name");
    if (!name || !isValidSecretName(name)) {
      return c.json(
        { error: `invalid secret name "${name}" — use letters, digits, underscore (not starting with a digit)` },
        400,
      );
    }
    const body = await c.req.json<{ value?: unknown }>().catch(() => ({ value: undefined }));
    if (typeof body.value !== "string" || body.value.length === 0) {
      return c.json({ error: "value (non-empty string) is required" }, 400);
    }
    await secretStore.set(name, body.value);
    return c.json({ ok: true, name });
  });

  app.delete("/secrets/:name", async (c) => {
    if (secretsInjected) {
      return c.json({ error: "secrets are managed by an injected capability" }, 501);
    }
    const name = c.req.param("name");
    if (!name) return c.json({ error: "secret name is required" }, 400);
    const existed = await secretStore.delete(name);
    if (!existed) return c.json({ error: `secret "${name}" not found` }, 404);
    return c.json({ ok: true, name });
  });

  // ── MCP servers (src/mcp-registry.ts) ────────────────────────────────────
  //
  // Registered once, their values by secret NAME; an agent reaches one's
  // tools through `agentTools: [mcp/<server>/*]`. Nothing here returns a
  // value. A per-launch `mcp` (POST …/run) is a different thing, untouched.
  // A peer reads which servers there are and where, never a full URL (a
  // path can carry a key the way a query would).
  const regView = async (c: Context, reg: McpRegistration) => ((await isPeer(c)) ? { name: reg.name, origin: new URL(reg.url).origin } : reg);
  app.get("/mcp-servers", async (c) => c.json({ servers: await Promise.all((await mcpRegistry.list()).map((r) => regView(c, r))) }));

  app.get("/mcp-servers/:name", async (c) => {
    const reg = await mcpRegistry.get(c.req.param("name"));
    return reg ? c.json(await regView(c, reg)) : c.json({ error: `MCP server "${c.req.param("name")}" is not registered` }, 404);
  });

  app.put("/mcp-servers/:name", async (c) => {
    let reg: McpRegistration;
    try {
      reg = parseRegistration(c.req.param("name"), await c.req.json().catch(() => ({})), { allowLocal: bootEnv()["STRUT_MCP_LOCAL"] === "1" });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    await mcpRegistry.put(reg);
    return c.json(reg);
  });

  app.delete("/mcp-servers/:name", async (c) => {
    const name = c.req.param("name");
    if (!(await mcpRegistry.remove(name))) return c.json({ error: `MCP server "${name}" is not registered` }, 404);
    return c.json({ ok: true, name });
  });

  // A probe: connect as the request's actor would (their own secret first)
  // and list the tools, each with whether it asks first. `ok: false` with the
  // reason when it cannot connect — a missing secret, a 401, a timeout.
  app.post("/mcp-servers/:name/test", async (c) => {
    const reg = await mcpRegistry.get(c.req.param("name"));
    if (!reg) return c.json({ error: `MCP server "${c.req.param("name")}" is not registered` }, 404);
    const actor = await resolveActor(c);
    const secrets = (services as { secrets?: SecretsCapability }).secrets;
    const bound = actor && secrets?.forPrincipal ? secrets.forPrincipal(actor) : secrets;
    try {
      const { client, tools } = await listServerTools(await resolveRegistration(reg, bound));
      await client.close().catch(() => {});
      const kept = reg.toolFilter?.length ? tools.filter((t) => reg.toolFilter!.some((p) => globToRegExp(p).test(t.name))) : tools;
      return c.json({
        ok: true,
        tools: kept.map((t) => ({
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          readOnly: t.annotations?.readOnlyHint === true,
          gated: gatedByDefault(reg, t),
        })),
      });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message });
    }
  });

  // ── Peers (plans/federation.md §3) ───────────────────────────────────────
  //
  // The struts this one may call. A host pushes them (hive, by workspace
  // slug) or a person pastes one on a strut the host cannot reach. GET
  // returns the records — never a token; the token has no
  // read route at all.

  app.get("/peers", async (c) => c.json({ peers: await peerRecords.list() }));

  // READ-THROUGH (plans/federation.md §2.1, the files slice;
  // plans/chained-orchestrators.md §5): a peer's job files and run
  // artifacts, fetched with THIS strut's token for it — how a deliverable
  // tagged `{ peer, via, job }` opens from a strut with no record for
  // `via`, one hop at a time, each with its own token:
  // `/peers/<id>/jobs/<job>/files[/…]`, `/peers/<id>/artifacts/<runId>[/…]`,
  // and `peers/<id>/` before either for one more hop. Files only, anything
  // else 404. A read like any other (a peer reads it as it reads every
  // route). The peer's file is untrusted content on THIS origin now: served
  // under this strut's own artifact headers, typed by its own extension
  // map and never with scripts; a listing or an error as JSON. This
  // strut's `?key=` never travels on.
  //
  // And a peer's APPS (plans/apps.md §7.4): its app list, an app version's
  // files and its document, read with the person token on file for the
  // peer, so a host here frames a page that lives there — the document's
  // `ETag` and a host's `If-None-Match` pass through, so it caches; and an
  // app's usage (src/apps/monitor.ts), counted where its calls run. The
  // page's tools/call go the same way, `POST /peers/<id>/mcp` below.
  const READ_THROUGH = /^(?:peers\/[^/]+\/)*(?:(?:jobs\/[^/]+\/files|artifacts\/[^/]+|apps\/[^/]+\/v\d+\/files)(?:\/.*)?|apps|apps\/[^/]+\/usage)$/;
  const peerFailure = (c: Context, err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, message.startsWith("peer_unknown:") ? 404 : 502);
  };
  app.get("/peers/:id/*", async (c) => {
    const url = new URL(c.req.url);
    // The raw path, as it came: a job id travels encoded (`peer%2Fj1`).
    const rest = url.pathname.split("/").slice(3).join("/");
    // The relay below is POST only, as `/mcp` is: an MCP client's GET for a
    // stream gets the 405 it reads as "none".
    if (rest === "mcp") return c.json({ error: "method not allowed: /peers/:id/mcp takes POST (JSON-RPC over HTTP, stateless)" }, 405);
    if (!READ_THROUGH.test(rest)) {
      return c.json({ error: "a peer's read-through serves its job files (jobs/<job>/files/…), run artifacts (artifacts/<runId>/…) and apps (apps, apps/<name>/usage, apps/<name>/<vN>/files/…) only" }, 404);
    }
    url.searchParams.delete("key");
    const query = url.searchParams.toString();
    const ifNoneMatch = c.req.header("if-none-match");
    let res: Response;
    try {
      res = await peersCap.fetch(c.req.param("id"), `/${rest}${query ? `?${query}` : ""}`, ifNoneMatch ? { headers: { "if-none-match": ifNoneMatch } } : undefined);
    } catch (err) {
      return peerFailure(c, err);
    }
    const listing = /(?:\/files|^(?:peers\/[^/]+\/)*artifacts\/[^/]+|^(?:peers\/[^/]+\/)*apps(?:\/[^/]+\/usage)?)\/?$/.test(rest);
    const headers: Record<string, string> = (res.ok || res.status === 304) && !listing
      ? artifactHeaders(rest)
      : { "content-type": "application/json", "x-content-type-options": "nosniff", "content-security-policy": "sandbox" };
    for (const name of ["etag", "cache-control"]) {
      const v = res.headers.get(name);
      if (v) headers[name] = v;
    }
    return new Response(res.status === 304 ? null : res.body, { status: res.status, headers });
  });

  // An app page's tools/call, relayed to the peer whose app it is
  // (plans/apps.md §7.4): the JSON-RPC body as it came, the MCP headers, the
  // token on file for the peer — a person's, so the peer answers with
  // `step_run` alone, as that person. The answer streams back with its own
  // content type (JSON or an event stream). A POST, so a peer of THIS strut
  // never relays through it (the gate).
  app.post("/peers/:id/mcp", async (c) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: c.req.header("accept") ?? "application/json, text/event-stream",
    };
    for (const name of ["mcp-protocol-version", "mcp-session-id"]) {
      const v = c.req.header(name);
      if (v) headers[name] = v;
    }
    let res: Response;
    try {
      res = await peersCap.fetch(c.req.param("id"), "/mcp", { method: "POST", headers, body: await c.req.text() });
    } catch (err) {
      return peerFailure(c, err);
    }
    const out: Record<string, string> = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
    for (const name of ["content-type", "mcp-session-id"]) {
      const v = res.headers.get(name);
      if (v) out[name] = v;
    }
    return new Response(res.body, { status: res.status, headers: out });
  });

  // A PERSON TOKEN (auth.ts "Person tokens"; plans/chained-orchestrators.md
  // §4): what a person's own strut puts in its peer record for this one,
  // so a request through it is `peer:person` — its actor the one named
  // here, never a header. A `full` caller mints it (the gate keeps a peer
  // off every POST but a launch); nothing is stored, and rotating the
  // signing secret revokes every one.
  app.post("/peers/tokens", async (c) => {
    const body = await c.req.json<{ actor?: unknown; days?: unknown }>().catch(() => ({}) as { actor?: unknown; days?: unknown });
    const actor = typeof body.actor === "string" ? body.actor.trim() : "";
    if (!actor || actor.length > 120 || /[\r\n]/.test(actor)) {
      return c.json({ error: "actor is required: a short string, the person the token stands for" }, 400);
    }
    const days = body.days ?? PERSON_TOKEN_DAYS;
    if (typeof days !== "number" || !(days > 0) || days > 365) return c.json({ error: "days must be a positive number, at most 365" }, 400);
    const minted = personToken(actor, days * 86_400_000);
    if (!minted) return c.json({ error: "nothing to sign a person token with: set STRUT_API_KEY or STRUT_SECRET_KEY" }, 400);
    return c.json({ token: minted.token, actor, exp: minted.exp });
  });

  app.put("/peers/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    let peer: Peer;
    try {
      peer = checkPeer({ ...body, id });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    await peerRecords.set(peer);
    return c.json({ ok: true, ...peerInfo(peer) });
  });

  app.delete("/peers/:id", async (c) => {
    const id = c.req.param("id");
    const problem = peerIdProblem(id);
    if (problem) return c.json({ error: `peer id ${problem}` }, 400);
    if (!(await peerRecords.delete(id))) return c.json({ error: `peer "${id}" not found` }, 404);
    return c.json({ ok: true, id });
  });

  // The brand every app here is shown in (src/brand.ts): a person sets it,
  // strut's app host hands it to each page as MCP Apps style variables.
  // Every credential reads it; the gate keeps the write to full scope.
  app.get("/brand", async (c) => {
    const brand = await readBrand(dataDir);
    return c.json({ brand, styles: brandStyles(brand) });
  });
  app.put("/brand", async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const problem = brandProblem(body);
    if (problem) return c.json({ error: problem }, 400);
    const brand = normalizeBrand(body as Record<string, unknown>);
    await writeBrand(dataDir, brand);
    return c.json({ brand, styles: brandStyles(brand) });
  });

  // This strut's own workspace (never a peer): what it holds, for agents.
  app.get("/self", async (c) => c.json({ self: (await peerRecords.getSelf()) ?? null }));

  app.put("/self", async (c) => {
    const body = await c.req.json<unknown>().catch(() => undefined);
    let self: SelfInfo;
    try {
      self = checkSelf(body);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    await peerRecords.setSelf(self);
    return c.json({ ok: true, ...self });
  });

  app.delete("/self", async (c) => {
    if (!(await peerRecords.deleteSelf())) return c.json({ error: "no self record on file" }, 404);
    return c.json({ ok: true });
  });

  // ── Rooms (src/rooms.ts; plans/chained-orchestrators.md §3) ─────────────
  //
  // A client that cannot be called (a laptop behind NAT) holds a socket open
  // here and hears its runs' callbacks on it: `GET /rooms` upgrades into the
  // request's actor's room, and a launch's `callback` / `jobCallback`
  // `{ room: true }` delivers there. The upgrade runs through this app — the
  // one gate, `resolveScope`, `resolveActor` — the same in a standalone
  // strut (`listen()` hooks `upgrade`) and behind a host that owns the Node
  // server (it routes the upgrade here; its hooks read their stash off
  // `env.incoming` as on HTTP).

  /** Whose room a request may use: its actor, when the gate resolved one it
   *  can vouch for — a `full` request (the key, a session, a host's own
   *  credential) or a person's credential through a peer (`peer:person`). A
   *  plain peer's actor is a header any strut sets, so it has no room. */
  const roomActorFor = async (c: Context): Promise<{ actor: string } | { error: string }> => {
    if ((await scopeOf(c)) === "peer") {
      return { error: "a room is a person's — a strut server's credential names its actor by header; use a person's credential" };
    }
    const actor = await resolveActor(c);
    return actor ? { actor } : { error: "this request names no actor, and a room is a person's" };
  };

  const rooms = roomsFor(dataDir);
  const roomsWss = new WebSocketServer({ noServer: true });
  /** In the env of an upgrade `upgrade` runs through the app: where the route
   *  puts the actor it admitted. Env comes from the server, never from the
   *  request, so a plain `GET /rooms` has none. */
  const ROOM_SLOT = Symbol("strut.room");
  type RoomSlot = { actor?: string };

  app.get("/rooms", async (c) => {
    const slot = (c.env as Record<symbol, RoomSlot | undefined> | undefined)?.[ROOM_SLOT];
    if (!slot) return c.json({ error: "upgrade required: GET /rooms is a WebSocket" }, 426);
    const room = await roomActorFor(c);
    if ("error" in room) return c.json({ error: `forbidden: ${room.error}` }, 403);
    slot.actor = room.actor;
    return c.body(null, 204);
  });

  // ── Channels (src/channels.ts; plans/app-channels.md) ───────────────────
  //
  // A HOST holds one socket per open app page and relays it to the page
  // over the MCP Apps bridge; the page itself connects nowhere. `GET
  // /channels` upgrades into the app's channels, through this app like a
  // room: a browser host with a ticket (`POST /apps/:name/channel-ticket`),
  // a server (the peer relay) with its own credential and `?app=<name>@<vN>`.
  // A host coming back after a drop names its last client id as
  // `?client=`, so its channels never saw it leave.

  const channels = createChannels();
  // What the channel/* steps reach: code an app runs sends and reads here.
  if (!(services as Record<string, unknown>)["channels"]) (services as Record<string, unknown>)["channels"] = channels;
  // A send batch is at most a burst of messages at their cap (~0.5 MB).
  const channelsWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const CHANNEL_SLOT = Symbol("strut.channel");
  type ChannelSlot = { app?: ChannelApp; actor?: string; peer?: Peer };

  /** The app and viewer an upgrade of the channel socket is admitted for. */
  const channelViewerFor = async (c: Context): Promise<{ app: ChannelApp; actor?: string; peer?: Peer } | { status: 401 | 403 | 404 | 400; error: string }> => {
    if (c.req.query("ticket") !== undefined) {
      const ticket = channelTicketOf(c);
      if (!ticket) return { status: 401, error: "unauthorized: a channel ticket strut cannot vouch for, or one that has expired — mint another (POST /apps/:name/channel-ticket)" };
      if (ticket.peer) {
        const peer = await peerRecords.get(ticket.peer);
        if (!peer) return { status: 404, error: `no peer "${ticket.peer}" on file` };
        return { app: { name: ticket.app, version: ticket.version }, peer, ...(ticket.actor ? { actor: ticket.actor } : {}) };
      }
      const app = await channelAppOf(ticket.app, ticket.version);
      if (!app) return { status: 404, error: `App "${ticket.app}" has no version ${ticket.version}` };
      return { app, ...(ticket.actor ? { actor: ticket.actor } : {}) };
    }
    if ((await scopeOf(c)) === "peer") {
      return { status: 403, error: "forbidden: a strut server's credential names its actor by header; a channel's members are people — use a person's credential, or a ticket" };
    }
    const named = (c.req.query("app") ?? "").match(/^(.+)@(v\d+|preview-[0-9a-f]{12})$/);
    if (!named) return { status: 400, error: "app=<name>@<version> is required with a credential (a browser host uses ?ticket=)" };
    const app = await channelAppOf(named[1]!, named[2]!);
    if (!app) return { status: 404, error: `App "${named[1]}" has no version ${named[2]}` };
    const actor = await resolveActor(c);
    return { app, ...(actor ? { actor } : {}) };
  };

  app.get("/channels", async (c) => {
    const slot = (c.env as Record<symbol, ChannelSlot | undefined> | undefined)?.[CHANNEL_SLOT];
    if (!slot) return c.json({ error: "upgrade required: GET /channels is a WebSocket" }, 426);
    const viewer = await channelViewerFor(c);
    if ("error" in viewer) return c.json({ error: viewer.error }, viewer.status);
    slot.app = viewer.app;
    if (viewer.actor) slot.actor = viewer.actor;
    if (viewer.peer) slot.peer = viewer.peer;
    return c.body(null, 204);
  });

  /** A channel socket answered in this process — app/look's page
   *  (src/browser/service.ts), whose socket no server sees: admitted by the
   *  same route as an upgrade, as the run's person, then handed to the
   *  channels. A peer's app is not relayed there. */
  const channelSocketInProcess = async (url: string, actor: string | undefined, transport: ChannelTransport) => {
    const search = new URL(url).search;
    const slot: ChannelSlot = {};
    const res = await app.fetch(inProcessRequest(new Request(`http://localhost/channels${search}`), actor), { [CHANNEL_SLOT]: slot });
    if (res.status !== 204 || !slot.app) return { error: `the channel socket was refused: ${res.status} ${await res.text()}` };
    if (slot.peer) return { error: "a peer's app's channels are not relayed in app/look" };
    const rejoin = new URL(url).searchParams.get("client");
    return channels.connect(slot.app, { ...(slot.actor ? { actor: slot.actor } : {}), transport, ...(rejoin ? { rejoin } : {}) });
  };

  /** A socket the upgrade admitted, handed to the channels. */
  const attachChannelSocket = (ws: WsSocket, slot: Required<Pick<ChannelSlot, "app">> & ChannelSlot, rejoin: string | null) => {
    const conn = channels.connect(slot.app, {
      ...(slot.actor ? { actor: slot.actor } : {}),
      transport: { send: (text) => ws.send(text), ping: () => ws.ping(), terminate: () => ws.terminate() },
      ...(rejoin ? { rejoin } : {}),
    });
    ws.on("message", (data) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(data));
      } catch {
        frame = undefined;
      }
      conn.receive(frame);
    });
    ws.on("pong", () => conn.pong());
    // 1000 / 1001: the host closed it (the frame went away). Anything else may come back.
    ws.on("close", (code) => conn.close(code === 1000 || code === 1001));
    ws.on("error", () => conn.close(false));
  };

  /** A refusal written on a socket the upgrade did not take. */
  const refuseUpgrade = (socket: Duplex, status: number, body: string) => {
    if (socket.destroyed) return;
    socket.write(
      `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
    socket.destroy();
  };

  /** An upgrade run through this app — the one gate, the hooks, the Node
   *  request as `env.incoming` — to the route at `path`, which answers 204
   *  having filled its slot in `env`. False once it has refused. */
  const admitUpgrade = async (req: IncomingMessage, socket: Duplex, path: string, search: string, env: Record<symbol, unknown>): Promise<boolean> => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, v);
    }
    const res = await app.fetch(new Request(`http://localhost${path}${search}`, { headers }), { incoming: req, ...env });
    if (res.status !== 204) {
      refuseUpgrade(socket, res.status, await res.text());
      return false;
    }
    return !socket.destroyed;
  };

  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, opts: { basePath?: string } = {}): boolean {
    const url = new URL(req.url ?? "/", "http://localhost");
    const base = opts.basePath ?? "";
    const which = url.pathname === `${base}/rooms` ? "rooms" : url.pathname === `${base}/channels` ? "channels" : undefined;
    if (!which) return false;
    const failed = () => refuseUpgrade(socket, 500, JSON.stringify({ error: "the upgrade failed" }));
    void (async () => {
      if (which === "rooms") {
        const slot: RoomSlot = {};
        if (!(await admitUpgrade(req, socket, "/rooms", url.search, { [ROOM_SLOT]: slot }))) return;
        const actor = slot.actor;
        if (!actor) return failed();
        roomsWss.handleUpgrade(req, socket, head, (ws) => rooms.join(actor, ws));
        return;
      }
      const slot: ChannelSlot = {};
      if (!(await admitUpgrade(req, socket, "/channels", url.search, { [CHANNEL_SLOT]: slot }))) return;
      const admitted = slot.app;
      if (!admitted) return failed();
      const client = url.searchParams.get("client") ?? undefined;
      const peer = slot.peer;
      channelsWss.handleUpgrade(req, socket, head, (ws) =>
        peer ? pipeChannelToPeer(ws, peer, admitted, client ? { client } : {}) : attachChannelSocket(ws, { ...slot, app: admitted }, client ?? null),
      );
    })().catch((err: unknown) => {
      console.error(`[${which}] upgrade failed:`, err);
      failed();
    });
    return true;
  }

  // ── Actor secrets (plans/code-change.md §3.2) ────────────────────────────
  //
  // A host pushes a PERSON's credential here (hive: the user's GitHub token,
  // before it dispatches a run as that actor), and a run launched as that
  // principal reads it through the ordinary `ctx.services.secrets.get(NAME)`.
  // Separate file, separate routes, never in `/secrets` or `list_secrets`.

  app.get("/actors/:actor/secrets", async (c) => {
    if (secretsInjected) {
      return c.json({ error: "secrets are managed by an injected capability" }, 501);
    }
    const actor = c.req.param("actor");
    if (!actor) return c.json({ error: "actor is required" }, 400);
    return c.json({ actor, secrets: await actorSecrets.list(actor) });
  });

  app.put("/actors/:actor/secrets/:name", async (c) => {
    if (secretsInjected) {
      return c.json({ error: "secrets are managed by an injected capability" }, 501);
    }
    const { actor, name } = c.req.param();
    if (!actor) return c.json({ error: "actor is required" }, 400);
    if (!name || !isValidSecretName(name)) {
      return c.json(
        { error: `invalid secret name "${name}" — use letters, digits, underscore (not starting with a digit)` },
        400,
      );
    }
    const body = await c.req.json<{ value?: unknown }>().catch(() => ({ value: undefined }));
    if (typeof body.value !== "string" || body.value.length === 0) {
      return c.json({ error: "value (non-empty string) is required" }, 400);
    }
    await actorSecrets.set(actor, name, body.value);
    return c.json({ ok: true, actor, name });
  });

  app.delete("/actors/:actor/secrets/:name", async (c) => {
    if (secretsInjected) {
      return c.json({ error: "secrets are managed by an injected capability" }, 501);
    }
    const { actor, name } = c.req.param();
    if (!actor || !name) return c.json({ error: "actor and secret name are required" }, 400);
    const existed = await actorSecrets.delete(actor, name);
    if (!existed) return c.json({ error: `secret "${name}" not found for actor` }, 404);
    return c.json({ ok: true, actor, name });
  });

  // ── Steps ────────────────────────────────────────────────────────────────

  // A step's own `secrets` / `effect`, served only when well formed: a
  // custom step's mistyped `effect: "Write"` must read as undeclared, never
  // as something a host could take for `read`.
  const declaredStepMeta = (def: AnyStepDef | undefined) => ({
    ...(Array.isArray(def?.secrets) && def.secrets.every((n) => typeof n === "string") ? { secrets: def.secrets } : {}),
    ...(def?.effect === "read" || def?.effect === "write" ? { effect: def.effect } : {}),
  });
  app.get("/steps", async (c) => {
    const allSteps = Object.keys(registry).map((type) => ({
      type,
      source: stepSources[type] ?? "core",
      description: registry[type]?.description,
      ...declaredStepMeta(registry[type]),
    }));
    const workspaceSteps = await workspace.listSteps();
    return c.json({ core: allSteps, workspace: workspaceSteps });
  });

  // `type@vN` resolves to that version's schema — the step editor asks with
  // the reference as written, so a pinned step's form is the pinned shape.
  app.get("/steps/:type{.+}/schema", async (c) => {
    const type = c.req.param("type");
    let def: AnyStepDef | undefined;
    try {
      def = (await resolveStep(registry, type))?.def;
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404);
    }
    if (!def) return c.json({ error: `Step type "${type}" not found` }, 404);
    return c.json({ type, fields: zodToFields(def.input) });
  });

  // Where a step type is used and how its executions went (step-stats.ts).
  app.get("/steps/:type{.+}/stats", async (c) => {
    const type = c.req.param("type");
    if (!registry[type]) return c.json({ error: `Step type "${type}" not found` }, 404);
    return c.json(await stepStats(workspace, store, type));
  });

  // Source code for a step. In-code steps (injected via createRegistry) carry
  // their source on the def; everything else comes through the workspace
  // boundary (core / lib / custom). `source` is null when none is available.
  app.get("/steps/:type{.+}/source", async (c) => {
    const type = c.req.param("type");
    const ref = parseStepRef(type);
    if (ref.version) {
      try {
        return c.json({ type, source: await workspace.getStepVersionSource(ref.type, ref.version), origin: "custom" });
      } catch (e) {
        return c.json({ error: (e as Error).message }, 404);
      }
    }
    const def = registry[type];
    if (!def) return c.json({ error: `Step type "${type}" not found` }, 404);
    if (def.source) {
      return c.json({ type, source: def.source, origin: "registry" });
    }
    const found = await workspace.getStepSource(type);
    return c.json({
      type,
      source: found?.code ?? null,
      origin: found?.origin ?? null,
    });
  });

  // List a step's versions + its active version id (parallels workflows).
  app.get("/steps/:type{.+}/versions", async (c) => {
    const type = c.req.param("type");
    try {
      return c.json({ type, ...(await workspace.listStepVersions(type)) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
  });

  // Source for a specific archived step version.
  app.get("/steps/:type{.+}/version/:version", async (c) => {
    const { type, version } = c.req.param();
    try {
      const src = await workspace.getStepVersionSource(type, version);
      return c.json({ type, version, source: src });
    } catch {
      return c.json(
        { error: `Version "${version}" of step "${type}" not found` },
        404,
      );
    }
  });

  // Switch a step's active version.
  app.put("/steps/:type{.+}/active", async (c) => {
    if (registryWasInjected) {
      return c.json(
        { error: "Step versioning is disabled when the registry is provided at construction time" },
        409,
      );
    }
    const type = c.req.param("type");
    const body = await c.req.json<{ version: string }>();
    if (!type) return c.json({ error: "step type is required" }, 400);
    if (!body.version) return c.json({ error: "version is required" }, 400);
    try {
      await workspace.setActiveStepVersion(type, body.version);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
    await rebuildRegistry();
    return c.json({ ok: true, type, active: body.version });
  });

  app.post("/steps", async (c) => {
    if (registryWasInjected) {
      return c.json(
        { error: "Step publishing is disabled when the registry is provided at construction time" },
        409,
      );
    }
    const body = await c.req.json<{
      name: string;
      code: string;
      description?: string;
      publisher?: string;
    }>();
    if (!body.name || !body.code) return c.json({ error: "name and code are required" }, 400);
    // A host's own step is the host's call: a source that reaches past
    // ctx.services is published, with the findings in the answer and the
    // log (the builder's door refuses the same — authoring.ts).
    const warnings = lintStepSource(body.code).map((f) => `line ${f.line}: ${f.message}`);
    if (warnings.length) console.warn(`[steps] ${body.name} reaches past ctx.services:\n${warnings.join("\n")}`);
    let result: { version: string; changed: boolean };
    try {
      result = await workspace.publishStep(body.name, body.code, body.description, body.publisher);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    if (result.changed) await rebuildRegistry();
    return c.json({ ok: true, type: body.name, version: result.version, changed: result.changed, ...(warnings.length ? { warnings } : {}) }, 201);
  });

  // Run a SINGLE step in isolation (synchronous) — the adapter author's inner
  // loop. Body: { config?, input?, params?, cassette?: "record"|"replay",
  // cassetteName?, keep? }. With `cassette`, external `ctx.services` calls are recorded
  // to / replayed from `steps/_cassettes/<name>.json` (secrets scrubbed), so the
  // step can be iterated offline. Returns { runId, status, output?, error?,
  // events, recorded?, kept? }. Unlike workflow runs, this awaits and returns
  // the result. The run is persisted under the store key `step:<type>` (never
  // a workflow) when the step has claims or `keep` is set — `kept` names it.
  app.post("/steps/:type{.+}/run", async (c) => {
    const type = c.req.param("type");
    if (!registry[type]) return c.json({ error: `Step type "${type}" not found` }, 404);
    // A step that only reads keeps answering while draining; anything else
    // is new work.
    const draining = registry[type]!.effect === "read" ? undefined : drainingResponse(c);
    if (draining) return draining;
    const body = await c.req
      .json<{
        config?: Record<string, unknown>;
        input?: unknown;
        params?: Record<string, unknown>;
        cassette?: CassetteMode;
        cassetteName?: string;
        keep?: boolean;
      }>()
      .catch(() => ({}) as Record<string, never>);

    const mode = body.cassette;
    if (mode && mode !== "record" && mode !== "replay") {
      return c.json({ error: `cassette must be "record" or "replay"` }, 400);
    }

    const result = await runStep(
      type,
      registry,
      services,
      {
        config: body.config,
        input: body.input,
        params: body.params,
        workspace,
        keep: body.keep === true,
        ...(await actorStamp(c)),
        ...(mode
          ? { cassette: { mode, path: cassettePath(dataDir, body.cassetteName ?? type) } }
          : {}),
      },
      { store, workspace, claims, onKept: (key, runId) => verifier?.schedule(key, runId) },
    );
    return c.json(result);
  });

  app.delete("/steps", async (c) => {
    const publisher = c.req.query("publisher");
    if (!publisher) return c.json({ error: "publisher query parameter is required" }, 400);
    const deleted = await workspace.deleteStepsByPublisher(publisher);
    if (deleted.length > 0) await rebuildRegistry();
    return c.json({ ok: true, deleted });
  });

  app.delete("/steps/:name{.+}", async (c) => {
    const name = c.req.param("name");
    if (!name) return c.json({ error: "step name is required" }, 400);
    let removed: boolean;
    try {
      removed = await workspace.deleteStep(name);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    if (!removed) return c.json({ error: `Step "${name}" not found` }, 404);
    await rebuildRegistry();
    return c.json({ ok: true, type: name });
  });

  // ── Run workflows ────────────────────────────────────────────────────────

  interface RunBody {
    input?: unknown;
    params?: Record<string, unknown>;
    settings?: Record<string, unknown>;
    paramOverrides?: Record<string, Record<string, unknown>>;
    runId?: string;
    /** Where to POST the result when the run settles (src/callback.ts), or
     *  `{ room: true }`: the launching actor's room (src/rooms.ts). */
    callback?: { url: string } | { room: true } | null;
    /** The job to launch the run under (plans/jobs.md §1): a flat, global
     *  id the caller minted, the format of a session id. */
    job?: string;
    /** The job's name (plans/job-index.md §1), recorded on the job — not
     *  the run. A launch-level field like `job` and `callback`: what
     *  describes the job and the host, not the run's subject. 400 without
     *  `job`. */
    title?: string;
    /** Where to POST live updates (plans/live-artifacts.md §1,
     *  CALLBACKS.md §5). With `job`: kept on the job, not the run — every
     *  run under the job reaches it, the latest launch that carries one
     *  wins, `null` clears it. With or without one, the jobs THIS run
     *  starts (`job/start`, `job/continue`) inherit it: an orchestrator
     *  turn launched with none of its own hands its host's URL to every
     *  job it starts. Kept by the run store beside the log for that. */
    jobCallback?: { url: string } | { room: true } | null;
    /** The conversation (a session id) this run belongs to, for a job turn
     *  a HOST launched itself (plans/jamie-app.md §1.2): its end wakes that
     *  conversation as a job/start's does (src/wake.ts). Full scope only;
     *  recorded on `run.start`. */
    conversation?: string;
    /** `true`: the host asks strut to wake this run's conversation
     *  (`input.session`) when a job it starts ends (src/wake.ts,
     *  plans/jamie-app.md §7) — and draws that wake turn's `run.end`, so it
     *  no longer wakes on its own. Opt-in per launch: a host that does not
     *  ask never gets a wake turn it cannot show. Full scope only (a peer's
     *  is dropped: its turns are relays); recorded on `run.start`
     *  (`wakeAsked`), echoed as the 202's `wake: true`. */
    wake?: boolean;
    /** The caller's MCP servers (src/mcp-servers.ts): its door back into
     *  itself for this run's agents, the pull-direction twin of `callback`.
     *  Kept beside the log like the callback URL, never in it. */
    mcp?: McpServer[] | null;
    /** Files for the run's agents (src/ai/attachments.ts, the shape and
     *  caps of `POST /chat { attachments }`): saved under the run's
     *  artifacts when it starts, put on each `agent` step's prompt. The
     *  bytes never reach the log. */
    attachments?: unknown;
  }

  /**
   * Launch a run **detached** (§8): kick off `runWorkflow` without awaiting it
   * in the request and return the `runId` immediately. The run's liveness is
   * decoupled from the connection — it executes server-side and persists every
   * event to the store's append-only log, which `GET …/runs/:runId/stream`
   * tails for live or after-the-fact viewing. `runWorkflow` finalizes its own
   * errors into the log; the `.catch` is only a safety net for unexpected
   * throws (e.g. a store write failure) so they don't become unhandled
   * rejections.
   */
  /** The conversation a PERSON's turn continues (plans/jamie-app.md §2.2):
   *  a person token's launch, or a first-party page's, of a conversation
   *  workflow names `input.session`. Their own id (`<actor>`, `<actor>/…`)
   *  opens as it is anyway, and an id outside the index (`peer/…`,
   *  `app/…`) or no conversation stays in the caller's namespace, as
   *  before. Any other the index decides: a conversation they took a turn
   *  in, or a shared one, opens as it is; another person's is refused. */
  async function continuesFor(flow: Flow, input: unknown, actor: string | undefined): Promise<{ continues?: string } | { refused: string }> {
    const id = (input as Record<string, unknown> | undefined)?.["session"];
    if (!actor || typeof id !== "string" || !id || !isConversationFlow(flow)) return {};
    if (id === actor || id.startsWith(`${actor}/`) || outsideConversations(id) || idProblem(id)) return {};
    const may = await conversations.mayContinue(id, actor);
    if (may === true) return { continues: id };
    if (may === false) {
      return { refused: `conversation_not_yours: "${id}" is another person's conversation — take a turn in it once a participant shares it, or start your own (an id under "${actor}/")` };
    }
    return {};
  }

  function launchDetached(
    flow: Flow,
    body: RunBody,
    extra?: {
      journal?: Record<string, unknown>;
      resume?: boolean;
      version?: string;
      /** An automation's fire (plans/automations.md §3), a peer's launch
       *  (plans/federation.md §3), or an app's (plans/apps.md §5). */
      origin?: "schedule" | "peer" | "app";
      /** A peer's launch through a PERSON's credential (scope
       *  `peer:person`): the run may open its actor's own sessions. */
      peerPerson?: boolean;
      automation?: { id: string };
      /** The app the run is launched for (`run/launch` under `ctx.app`):
       *  recorded with `origin: "app"`, handed to every step as `ctx.app`. */
      app?: AppRef;
      /** The request actor, and (on resume) the principal recorded at the
       *  original launch; otherwise the principal rule decides (§2). */
      actor?: string;
      principal?: string;
      /** Where to POST the result when the run settles (`POST …/run
       *  { callback }`). The host's credential: the log records its origin
       *  only, and the URL is kept by the run store beside the log
       *  (`setRunCallback`, served by no endpoint) so a durable resume
       *  posts `run.end` the way the launch would have. */
      callback?: { url: string };
      /** The caller's MCP servers (`POST …/run { mcp }`), validated: kept
       *  by the run store beside the log (`setRunMcp`) for a resume, handed
       *  to the run's steps as `ctx.mcp`; the log records names and
       *  origins only. */
      mcp?: McpServer[];
      /** Where the jobs this run starts post their live updates (`POST
       *  …/run { jobCallback }`): kept by the run store beside the log
       *  (`setRunJobCallback`), read by the job launcher
       *  (`rootJobCallbackOf`). Never in the log. */
      jobCallback?: { url: string };
      /** A job run started by a turn (`job/start`, the job launcher below):
       *  recorded on `run.start`, carried on its `run.end` (CALLBACKS.md §2). */
      startedBy?: StartedBy;
      /** The files the launch attached (`POST …/run { attachments }`),
       *  validated: saved under the run's artifacts before the first event
       *  and handed to its steps as `ctx.attachments` — or, on a resume,
       *  the ones `run.start` recorded, already saved. */
      attachments?: Attachment[];
      savedAttachments?: RunAttachment[];
      /** A wake turn (src/wake.ts): the job run(s) it woke on. */
      wake?: WakeMark;
      /** The conversation a person's turn continues (`continuesFor`,
       *  plans/jamie-app.md §2.2): opened as it is. */
      continues?: string;
      /** A durable resume onto another version: the top-level steps that
       *  re-run because they changed — recorded on `run.resumed`. */
      resumeChanged?: string[];
    },
  ): string {
    const runId = body.runId ?? generateRunId();
    const { controller, untrack } = trackRun(
      flow.name,
      runId,
      undefined,
      body.job ? { id: body.job, ...(body.title ? { title: body.title } : {}) } : undefined,
    );
    if (extra?.origin === "peer") peerLaunched.add(controller);
    launchedAs.set(controller, { ...(extra?.app ? { app: extra.app } : {}), ...(extra?.actor ? { actor: extra.actor } : {}) });
    const launchedAt = Date.now();
    const callback = extra?.callback;
    const mcp = extra?.mcp?.length ? extra.mcp : undefined;
    // The conversation it runs on: a wake waits while it is in flight.
    const rawSession = (body.input as Record<string, unknown> | undefined)?.["session"];
    const session = typeof rawSession === "string" && rawSession ? rawSession : undefined;
    if (session) liveSessions.set(session, new Set([...(liveSessions.get(session) ?? []), runId]));
    // A turn of a conversation (src/conversations.ts): recorded at launch,
    // so a turn that fails — and commits nothing to the session — still
    // shows. The session the run's agent opens (runner.ts bindPeer, bindApp):
    // a plain peer's and an app's are their own namespaces, never a
    // conversation; a person's token and a first-party app (plans/jamie-app.md
    // §3) open the person's own as they are, and the one it continues (§2.2).
    const opened = !session
      ? undefined
      : extra?.app
        ? appSessionId(session, extra.app.name, extra.actor, body.job, extra.app.firstParty, extra.continues)
        : extra?.origin === "peer"
          ? peerSessionId(session, extra.peerPerson ? extra.actor : undefined, extra.continues)
          : session;
    const conversation = opened && isConversationFlow(flow) && !outsideConversations(opened) && !idProblem(opened) ? opened : undefined;
    let principal = extra?.principal;
    void (async () => {
      // A resume drops the summary of the attempt it resumes FIRST, so the
      // run reads as live (its controller), never as the outcome it is
      // resumed from — and a crash from here on leaves a run boot-time
      // auto-resume picks up. A crash before `run.resumed` leaves the old
      // terminal event last, which boot finalizes again.
      if (extra?.resume) await store.clearRunSummary(flow.name, runId);
      // Recorded before the first event, so a run cut off at any point is
      // resumed WITH its callback and its caller's MCP servers. A resume
      // read them from there already.
      if (callback && !extra?.resume) await store.setRunCallback(flow.name, runId, callback.url);
      if (mcp && !extra?.resume) await store.setRunMcp(flow.name, runId, mcp);
      if (extra?.jobCallback && !extra.resume) await store.setRunJobCallback(flow.name, runId, extra.jobCallback.url);
      const attachments =
        extra?.savedAttachments ??
        (extra?.attachments?.length ? await saveRunAttachments(requireRunFiles(), runId, extra.attachments) : undefined);
      const workflowHash =
        (await workspace.getWorkflowHash(flow.name, extra?.version)) ?? undefined;
      const stepHashes = await stepHashesFor(workspace, flow);
      principal ??= await principalFor(flow.name, extra?.actor);
      // Once who pays is known: an automation's turn is its owner's. On
      // record before the run starts.
      if (conversation) {
        await conversations
          .launched(conversation, {
            runId,
            workflow: flow.name,
            ...(extra?.actor ? { actor: extra.actor } : {}),
            ...(principal ? { principal } : {}),
            ...(extra?.wake ? { wake: true } : {}),
            prompt: (body.input as Record<string, unknown> | undefined)?.["prompt"],
          })
          .catch((err) => console.error(`[conversations] ${conversation}: recording run ${runId} failed:`, err));
      }
      return runWorkflow(flow, body.input ?? {}, registry, {
        runId,
        store,
        workspace,
        services,
        params: body.params,
        settings: body.settings,
        paramOverrides: body.paramOverrides,
        controller,
        ...(workflowHash ? { workflowHash } : {}),
        ...(stepHashes ? { stepHashes } : {}),
        ...(extra?.journal ? { journal: extra.journal } : {}),
        ...(extra?.resume ? { resume: true } : {}),
        ...(extra?.resumeChanged ? { resumeChanged: extra.resumeChanged } : {}),
        ...(extra?.origin ? { origin: extra.origin } : {}),
        ...(extra?.origin === "peer" && extra.peerPerson ? { peerPerson: true } : {}),
        ...(extra?.continues ? { continues: extra.continues } : {}),
        ...(extra?.automation ? { automation: extra.automation } : {}),
        ...(extra?.app ? { app: extra.app } : {}),
        ...(extra?.actor ? { actor: extra.actor } : {}),
        ...(principal ? { principal } : {}),
        ...(body.job ? { job: body.job } : {}),
        ...(body.job && body.title ? { title: body.title } : {}),
        ...(extra?.startedBy ? { startedBy: extra.startedBy } : {}),
        ...(body.conversation ? { conversation: body.conversation } : {}),
        ...(body.wake === true ? { wakeAsked: true } : {}),
        ...(extra?.wake ? { wake: extra.wake } : {}),
        ...(callback ? { callback: roomActorOf(callback.url) !== undefined ? { room: true as const } : { origin: callbackOrigin(callback.url) } } : {}),
        ...(mcp ? { mcp } : {}),
        ...(attachments?.length ? { attachments } : {}),
        // Its end, recorded from the terminal event — before the summary is
        // written, so whoever sees the run done sees the conversation say so.
        ...(conversation ? { onEvent: (e: RunEvent) => conversationEnd(conversation, runId, e) } : {}),
      });
    })()
      .then(
        (res) => res,
        // runWorkflow finalizes its own errors into a resolved result; a
        // rejection is an unexpected throw (e.g. a store write failure), or
        // a launch that failed before it ran. Logged, and the run's log gets
        // the end it is missing (a resume that cleared its summary gets it
        // back), so it never lists as stale — and the host that asked still
        // hears it, as an error.
        async (err): Promise<RunResult> => {
          console.error(`[run ${runId}] launch failed:`, err);
          await settleUnfinishedRun(store, flow.name, runId, err);
          return { runId, status: "error", error: { message: err instanceof Error ? err.message : String(err) } };
        },
      )
      .then(async (res) => {
        // What strut does about the end — a job turn's wake, decided before
        // its run.end goes out, which says so; a wake turn's end — then the
        // host hears it.
        const wake = await wakeOnEnd(flow.name, res, {
          ...(body.job ? { job: body.job } : {}),
          ...(extra?.startedBy ? { startedBy: extra.startedBy } : {}),
          ...(body.conversation ? { conversation: body.conversation } : {}),
          ...(body.wake === true ? { asked: true } : {}),
          ...(extra?.actor ? { actor: extra.actor } : {}),
          ...(principal ? { principal } : {}),
          ...(extra?.wake ? { mark: extra.wake } : {}),
          ...(session ? { session } : {}),
        });
        if (callback) postRunCallback(callback.url, flow.name, res, launchedAt, body.job, extra?.startedBy, wake);
      })
      .finally(() => {
        untrack();
        if (!session) return;
        const live = liveSessions.get(session);
        live?.delete(runId);
        if (!live?.size) liveSessions.delete(session);
        wakes.kick(session);
      });
    return runId;
  }

  // ── The wake (src/wake.ts, plans/jamie-app.md §1) ─────────────────────
  // A job turn that ends naming a conversation here wakes it: one more turn
  // of the conversation's workflow, its prompt the workflow's `params.wake`.

  /** Every run in flight launched on a session (`input.session`), by
   *  session: a wake waits for them. */
  const liveSessions = new Map<string, Set<string>>();
  // The conversation index (src/conversations.ts, plans/jamie-app.md §2):
  // what `conversation/*` and `/conversations` read, written by the
  // launcher above when a turn launches and ends.
  /** A conversation turn's terminal event → its end on the index. */
  const conversationEnd = async (id: string, runId: string, e: RunEvent): Promise<void> => {
    const status = e.type === "run.end" ? "success" : e.type === "run.error" ? "error" : e.type === "run.cancelled" ? "cancelled" : undefined;
    if (status) await conversations.ended(id, runId, status).catch((err) => console.error(`[conversations] ${id}: run ${runId}'s end:`, err));
  };
  const conversations = createConversations({
    dataDir,
    store,
    sessions: sessionStore,
    getWorkflow: (name) => workspace.getWorkflow(name),
    running: (id) => liveSessions.has(id) || !!sessions.holder(id),
    liveState: (workflow, runId) => controllers.get(`${workflow}/${runId}`)?.state,
    artifactRefs: (runId, output, job) => artifactRefs(runId, output, job),
  });
  const orchestratorOpts = opts.orchestrator === false ? undefined : opts.orchestrator;
  const wakeMax = orchestratorOpts?.wakeMax ?? WAKE_MAX;
  if (!Number.isInteger(wakeMax) || wakeMax < 0) throw new Error(`orchestrator.wakeMax must be a whole number of turns, not ${wakeMax}`);
  const wakes = createWakes({
    dataDir,
    enabled: orchestratorOpts?.wake !== false,
    max: wakeMax,
    store,
    sessions: sessionStore,
    holder: (id) => sessions.holder(id),
    liveOn: (id) => [...(liveSessions.get(id) ?? [])],
    isLive: (workflow, runId) => controllers.has(`${workflow}/${runId}`),
    getWorkflow: async (name) => {
      await assertWorkflowEnabled(workspace, name);
      return workspace.getWorkflow(name);
    },
    launch: (flow, run) =>
      launchDetached(
        flow,
        { input: run.input, ...(run.params ? { params: run.params } : {}) },
        {
          ...(run.actor ? { actor: run.actor } : {}),
          ...(run.principal ? { principal: run.principal } : {}),
          ...(run.callback ? { callback: { url: run.callback } } : {}),
          ...(run.jobCallback ? { jobCallback: { url: run.jobCallback } } : {}),
          wake: run.wake,
        },
      ),
  });

  /** A job turn's end as the wake keeps it: its reply, its question, what
   *  it produced, its title (the job's record), who asked for it. */
  async function wakeEndOf(
    workflow: string,
    res: RunResult,
    info: { job: string; startedBy?: StartedBy; asked?: boolean; actor?: string; principal?: string },
  ): Promise<WakeEnd> {
    const title = (await readJobRecord(jobRoot(dataDir, info.job)))?.title;
    const refs = await artifactRefs(res.runId, res.output, info.job).catch(() => undefined);
    return {
      runId: res.runId,
      workflow,
      job: info.job,
      ...(title ? { title } : {}),
      status: res.status,
      ...replyOf(res.output),
      ...(res.error ? { error: res.error.message } : {}),
      artifacts: artifactsOf(refs),
      ...(info.startedBy ? { startedBy: info.startedBy } : {}),
      ...(info.asked ? { asked: true as const } : {}),
      ...(info.actor ? { actor: info.actor } : {}),
      ...(info.principal ? { principal: info.principal } : {}),
    };
  }

  /** What strut does when a run ends: a job turn's (`JOB_WORKFLOWS`) end
   *  wakes the conversation it names — `startedBy.session`, else the
   *  launch's `conversation` — and its run.end carries the outcome; a wake
   *  turn's end lets the next one go, and its run.end carries its mark.
   *  Anything else: nothing, no `wake` field. Never throws: a failure is
   *  `none`, logged. */
  async function wakeOnEnd(
    workflow: string,
    res: RunResult,
    info: { job?: string; startedBy?: StartedBy; conversation?: string; asked?: boolean; actor?: string; principal?: string; mark?: WakeMark; session?: string },
  ): Promise<WakeOutcome | WakeMark | undefined> {
    try {
      if (info.mark) {
        if (info.session) await wakes.turnEnded(info.session, res.runId, res.error?.message);
        return info.mark;
      }
      if (!(JOB_WORKFLOWS as readonly string[]).includes(workflow)) return undefined;
      const session = info.startedBy?.session ?? info.conversation;
      if (!session || !info.job || !wakes.enabled) return "none";
      return await wakes.jobEnded(session, await wakeEndOf(workflow, res, { ...info, job: info.job }));
    } catch (err) {
      console.error(`[wake] run ${res.runId} of ${workflow}:`, err);
      return info.mark ?? "none";
    }
  }

  /** Tell the host that asked (`POST …/run { callback }`) how a run ended:
   *  one POST, detached from the run's teardown and never awaited — a slow
   *  or dead host holds nothing up, and `postCallback` retries then warns,
   *  never throws. The payload mirrors the run's summary, minus the stack. */
  function postRunCallback(
    url: string,
    workflow: string,
    res: RunResult,
    launchedAt: number,
    job?: string,
    startedBy?: StartedBy,
    wake?: WakeOutcome | WakeMark,
  ): void {
    const durationMs = Date.now() - launchedAt;
    void (async () => {
      const transcripts = await transcriptLinks(workflow, res.runId).catch(() => []);
      const artifacts = await artifactRefs(res.runId, res.output, job).catch(() => undefined);
      // What the run proposed (plans/proposals.md §6): from the records,
      // never from the model's output.
      const proposals = (await listProposals(proposalsRoot(dataDir), { runId: res.runId }).catch(() => [])).map(briefOf);
      await postCallback(
        url,
        {
          event: "run.end",
          workflow,
          runId: res.runId,
          ...(job ? { job } : {}),
          ...(startedBy ? { startedBy } : {}),
          // A job turn's: what strut did about the end (src/wake.ts). A
          // wake turn's: the job run it woke on.
          ...(wake ? { wake } : {}),
          status: res.status,
          ...(res.output !== undefined ? { output: res.output } : {}),
          ...(res.error ? { error: { message: res.error.message } } : {}),
          ...(transcripts.length ? { transcripts } : {}),
          ...(artifacts ? { artifacts } : {}),
          ...(proposals.length ? { proposals } : {}),
          durationMs,
        },
        { tag: `[run ${res.runId}] callback run.end`, room: rooms.deliver },
      );
    })();
  }

  // `job/start` / `job/continue` (ctx.services.jobs.launch): a turn hands
  // work to the `job` workflow and ends, the job running detached as if the
  // host had launched it. Its `run.end` goes where the launching run's
  // would — the URL the run store keeps beside that run's log — never to a
  // URL the model wrote.
  // Only on the bag's own capability: an injected one is the consumer's,
  // and may be shared with another strut.
  const launchCap = (opts.services as Record<string, unknown> | undefined)?.["jobs"]
    ? undefined
    : ((services as Record<string, unknown>)["jobs"] as JobsCapability | undefined);
  /** The ROOT run of the run `runId` belongs to: only a top-level launch
   *  keeps a callback, and a turn may be a child run (meta/run-workflow)
   *  of the one the host launched. */
  const rootRunOf = (runId: string): RunController | undefined => {
    let root = controllersByRunId.get(runId);
    while (root?.parent) root = root.parent;
    return root;
  };
  /** The callback URL of the run `runId` belongs to: the root run's. */
  async function rootCallbackOf(runId: string): Promise<string | null> {
    const root = rootRunOf(runId);
    return root ? store.getRunCallback(root.workflow, root.runId) : null;
  }
  /** The job callback the run `runId` was launched with (the root run's,
   *  as above): what the jobs it starts inherit (CALLBACKS.md §5). */
  async function rootJobCallbackOf(runId: string): Promise<string | null> {
    const root = rootRunOf(runId);
    return root ? store.getRunJobCallback(root.workflow, root.runId) : null;
  }
  /** The TURN the run `runId` belongs to, for the jobs it starts: the root
   *  run and the `session` its launch named (`RunEvent.startedBy`), and the
   *  model its launch picked (`params.model`, a person's pick in their
   *  assistant; absent on the template's own) — read off its `run.start`,
   *  the one record of both. */
  async function launchingTurnOf(runId: string): Promise<{ startedBy?: StartedBy; model?: string }> {
    const root = rootRunOf(runId);
    if (!root) return {};
    const start = (await store.getRunEvents(root.workflow, root.runId).catch(() => [])).find((e) => e.type === "run.start");
    const session = (start?.input as Record<string, unknown> | undefined)?.["session"];
    const model = start?.params?.["model"];
    return {
      startedBy: { workflow: root.workflow, runId: root.runId, ...(typeof session === "string" && session ? { session } : {}) },
      ...(typeof model === "string" && model ? { model } : {}),
    };
  }
  /** The thread the run `runId` belongs to, for its proposals
   *  (`Proposal.by.conversation`): a job's run belongs to the turn that
   *  started it (its `run.start.startedBy`), any other run to the session
   *  its root's launch named. */
  async function conversationOf(runId: string): Promise<string | undefined> {
    const root = rootRunOf(runId);
    if (!root) return undefined;
    const start = (await store.getRunEvents(root.workflow, root.runId).catch(() => [])).find((e) => e.type === "run.start");
    const session = start?.startedBy
      ? start.startedBy.session
      : (start?.conversation ?? (start?.input as Record<string, unknown> | undefined)?.["session"]);
    return typeof session === "string" && session ? session : undefined;
  }
  if (launchCap) {
    launchCap.launch = async ({ job, title, input, from, actor, principal, mcp, attachments, workflow: wanted }) => {
      const problem = idProblem(job);
      if (problem) throw new Error(`job "${job}" ${problem}`);
      // Which job-shaped workflow runs the turn (plans/builder-job.md §2):
      // the launch's (job/start), else the one the job's newest turn ran
      // (job/continue: a builder job stays a builder job), else `job`. A
      // builder turn on a peer carries `input.peer`, a code job its `kind`;
      // a continue inherits each from that turn's `run.start` unless it
      // names its own, so the caller names only the job.
      const last = wanted ? undefined : turnOf((await readJobRecord(jobRoot(dataDir, job)))?.runs);
      const workflow = wanted ?? last?.workflow ?? "job";
      const carried = (["peer", "kind"] as const).filter((k) => input[k] === undefined);
      if (last && carried.length) {
        const start = (await store.getRunEvents(last.workflow, last.runId)).find((e) => e.type === "run.start") as { input?: unknown } | undefined;
        const was = start?.input as Record<string, unknown> | undefined;
        for (const k of carried) if (typeof was?.[k] === "string") input = { ...input, [k]: was[k] };
      }
      // A builder job on a peer runs there (builder.yaml's `remote`
      // branch), and strut/run-workflow carries no files.
      if (attachments?.length && typeof input["peer"] === "string") {
        throw new Error(`attachments: a build on another strut server (peer "${input["peer"]}") cannot take files yet — describe what the job needs from them in its prompt`);
      }
      // The workspace this strut belongs to (its `self` record): both
      // job-shaped workflows put it on the agent's first line, so a job the
      // orchestrator starts knows it as a host's own launch would.
      if (input["workspace"] === undefined) {
        const self = await peersCap.self();
        if (self?.id) input = { ...input, workspace: self.id };
      }
      const flow = await workspace.getWorkflow(workflow).catch((e: unknown) => {
        throw new Error(`no_workflow: this strut server has no "${workflow}" workflow to run the job on (${(e as Error).message})`);
      });
      await assertWorkflowEnabled(workspace, workflow);
      const url = await rootCallbackOf(from);
      const live = await rootJobCallbackOf(from);
      // The TURN this job belongs to (CALLBACKS.md §5): the root run the host
      // launched and the conversation it named, so a host that hears the
      // job's run.end on a per-person channel (a room) finds the
      // conversation — a URL per conversation carries that by itself. The
      // job runs on the turn's model when the turn picked one, so a
      // conversation and its jobs run on one model; job/continue reads the
      // turn that continues it, so a new pick reaches the job's next turn.
      const { startedBy, model } = await launchingTurnOf(from);
      // The job INHERITS the launching run's job callback: on file before
      // the run starts, so its first update finds it — the latest launch
      // that carries one wins, as over HTTP; a run launched with none
      // leaves what the job has. Handed to the job's run too, so a job
      // that starts a job passes it on.
      if (live) await setJobCallback(jobRoot(dataDir, job), live);
      // After the awaits: from here to launchDetached's trackRun is
      // synchronous, so two launches of one job cannot both pass.
      const running = [...controllers.values()].find((c) => c.job?.id === job);
      if (running) {
        throw new Error(`job_busy: job "${job}" has a run in flight (${running.workflow} ${running.runId}); its result comes when it ends — continue it then`);
      }
      const runId = launchDetached(flow, { input, job, ...(title ? { title } : {}), ...(model ? { params: { model } } : {}) }, {
        ...(actor ? { actor } : {}),
        ...(principal ? { principal } : {}),
        ...(startedBy ? { startedBy } : {}),
        ...(url ? { callback: { url } } : {}),
        ...(live ? { jobCallback: { url: live } } : {}),
        // The launching turn's caller, reachable from the job's agents too.
        ...(mcp?.length ? { mcp } : {}),
        ...(attachments?.length ? { attachments } : {}),
      });
      return { runId, callback: !!url, workflow };
    };
  }

  /** Every agent session a run recorded, as links to fetch — never the
   *  sessions themselves, which can run to megabytes each. `url` is relative
   *  to this server; one entry per step path (a retried step's last try). */
  async function transcriptLinks(
    workflow: string,
    runId: string,
  ): Promise<Array<{ step: string; stepType?: string; url: string }>> {
    const byPath = new Map<string, string | undefined>();
    for (const e of await store.getRunEvents(workflow, runId)) {
      if (e.type === "step.end" && e.messages) byPath.set(e.path, e.stepType);
    }
    return [...byPath].map(([step, stepType]) => ({
      step,
      ...(stepType ? { stepType } : {}),
      url: transcriptUrl(workflow, runId, step),
    }));
  }

  /** A launch's callback target: `{ url }`, or `{ room: true }` resolved
   *  to the launching actor's room — kept as `room:<actor>` where a URL is
   *  kept (callback.ts) — when the request may use one (`roomActorFor`). */
  const launchCallbackTarget = async (raw: unknown, c: Context): Promise<{ url: string }> => {
    const parsed = parseLaunchCallback(raw);
    if ("url" in parsed) return parsed;
    const room = await roomActorFor(c);
    if ("error" in room) throw new Error(`callback.room: ${room.error}`);
    return { url: roomTarget(room.actor) };
  };

  /** A run body's `callback`, validated; absent or `null` = none. */
  const runCallbackOf = async (body: RunBody, c: Context): Promise<{ url: string } | undefined> =>
    body.callback == null ? undefined : launchCallbackTarget(body.callback, c);

  /** A run body's `jobCallback`: a URL or a room, `null` (clear the job's),
   *  or absent (leave what is on file). With `job` it is the job's; either
   *  way it is what the jobs this run starts inherit. */
  const jobCallbackOf = async (body: RunBody, c: Context): Promise<{ url: string } | null | undefined> => {
    if (body.jobCallback === undefined) return undefined;
    return body.jobCallback === null ? null : launchCallbackTarget(body.jobCallback, c);
  };

  /** A run body's `conversation`: a session id (full scope only — a peer's
   *  launch is refused it by `peerLaunchBody`); absent or `null` = none. */
  const runConversationOf = (body: RunBody): string | undefined => {
    if (body.conversation == null) return undefined;
    const problem = idProblem(body.conversation);
    if (problem) throw new Error(`conversation "${String(body.conversation)}" ${problem}`);
    return body.conversation;
  };
  /** A run body's `wake`: `true` or absent (`false` / `null` = not asked). */
  const runWakeOf = (body: RunBody): void => {
    if (body.wake != null && typeof body.wake !== "boolean") throw new Error("wake must be true or false");
  };
  /** Whether strut wakes for a launch of `flow` (the 202's `wake: true`,
   *  plans/jamie-app.md §7): the host asked (`wake: true`) with the
   *  deployment's rights — a peer's turn is a relay, never woken, and its
   *  `wake` is dropped before it launches — on a conversation turn (a
   *  workflow with `params.wake`, on a session: the jobs it starts wake it)
   *  or on a job turn it launched itself naming the `conversation`. */
  const announcesWake = (flow: Flow, body: RunBody, scope: Scope): boolean =>
    wakes.enabled &&
    body.wake === true &&
    scope === "full" &&
    ((typeof flow.params?.["wake"] === "string" && typeof (body.input as Record<string, unknown> | undefined)?.["session"] === "string") ||
      (typeof body.conversation === "string" && (JOB_WORKFLOWS as readonly string[]).includes(flow.name)));

  /** A run body's `job`, validated (the session-id format); absent = none.
   *  A `title` names the job, so it needs one. */
  const runJobOf = (body: RunBody): string | undefined => {
    if (body.job === undefined || body.job === null) {
      if (body.title !== undefined && body.title !== null) throw new Error("title names a job: pass it with `job`");
      return undefined;
    }
    const problem = idProblem(body.job);
    if (problem) throw new Error(`job "${String(body.job)}" ${problem}`);
    if (body.title !== undefined && body.title !== null && typeof body.title !== "string") throw new Error("title must be a string");
    return body.job;
  };

  /** A run body's `attachments`, validated with the chat's caps
   *  (src/ai/attachments.ts); absent = none. They are kept as the run's
   *  files, so a server without an artifacts capability refuses them. */
  const runAttachmentsOf = (body: RunBody): Attachment[] => {
    const list = parseAttachments(body.attachments);
    if (list.length) requireRunFiles();
    return list;
  };
  /** Where a run's attachments are kept: the run's artifacts. */
  const requireRunFiles = (): ArtifactsCapability => {
    if (!artifacts) throw new Error("attachments: this server keeps no run files (no artifacts capability)");
    return artifacts;
  };

  /** A PEER's launch (plans/federation.md §3) runs the workflow as published:
   *  `params`, `paramOverrides`, `runId` and `settings` are refused — an
   *  override could hand a workflow's agents tools its author never gave
   *  them, or turn off a setting the author turned on — and its
   *  `job` is kept under `PEER_NAMESPACE`, so a name a peer chooses never
   *  opens a local job's directory, files or holds. The body to launch, or
   *  why not. Which workflows a peer may launch is their YAML's `peer:`
   *  (`opensTo`, `notForPeers`). */
  const peerLaunchBody = (body: RunBody): RunBody | { refused: string } => {
    const set = (["params", "paramOverrides", "runId", "settings", "conversation"] as const).filter((k) => body[k] != null);
    if (set.length) return { refused: `forbidden: a peer launches a workflow as published — drop ${set.join(", ")}` };
    // A peer's turn is a relay, never woken here (src/wake.ts): its `wake`
    // is dropped, not refused, so a relay that passes one through works.
    const { wake: _wake, ...asPublished } = body;
    return typeof asPublished.job === "string" ? { ...asPublished, job: `${PEER_NAMESPACE}${asPublished.job}` } : asPublished;
  };
  /** May a peer request of `scope` launch a workflow whose YAML says
   *  `peer: <open>`? `true` takes any peer; `person` only a credential that
   *  names a person (plans/chained-orchestrators.md §2). */
  const opensTo = (open: PeerOpen | undefined, scope: Scope) => open === true || (open === "person" && scope === "peer:person");
  const notForPeers = (name: string, open?: PeerOpen) =>
    open === "person"
      ? `forbidden: workflow "${name}" is open to a person's credential only — its YAML says \`peer: person\`, and this request names its actor by header, not by its credential`
      : `forbidden: workflow "${name}" is not open to peers — its YAML does not say \`peer: true\``;

  /** Whether the file behind a strut-relative artifact url is here: a job's
   *  file on disk, a run's through the artifacts capability (whatever
   *  backs it). Absolute urls are never checked. */
  const artifactFileExists = async (url: string): Promise<boolean> => {
    const job = /^\/jobs\/([^/]+)\/files\/(.+)$/.exec(url);
    if (job) {
      try {
        await access(jobFilePath(jobRoot(dataDir, decodeURIComponent(job[1]!)), decodeURIComponent(job[2]!)));
        return true;
      } catch {
        return false;
      }
    }
    const run = /^\/artifacts\/([^/]+)\/(.+)$/.exec(url);
    if (run) {
      if (!artifacts) return false;
      const rel = decodeURIComponent(run[2]!);
      return (await artifacts.list(decodeURIComponent(run[1]!)).catch(() => [] as string[])).includes(rel);
    }
    return true;
  };

  /** A run's declared deliverables, resolved to links on this server
   *  (plans/jobs.md §3; src/artifact-refs.ts). Undefined when the output
   *  declares none. */
  /** A published app's version (the active one, or the one named) and its
   *  build: a `{ kind: "app", app: <name> }` deliverable's document. */
  const appVersionOf = async (name: string, version?: string) => {
    const v = await apps.versionDir(name, version);
    if (!v) return null;
    const build = await readBuildInfo(v.path);
    return { version: v.version, hash: build?.hash ?? v.hash, ...(build?.builtAt ? { builtAt: build.builtAt } : {}) };
  };
  const artifactRefs = (runId: string, output: unknown, job: string | undefined): Promise<ArtifactRef[] | undefined> =>
    resolveArtifactRefs(output, { runId, ...(job ? { job } : {}), exists: artifactFileExists, appVersion: appVersionOf });

  // ── Runs as a capability (src/runs.ts; plans/apps.md §5) ──────────────
  // What the `run/*` steps are thin over — list, read, launch, cancel, a
  // workflow's contract, one of a run's files, an agent's transcript — over
  // the same layers the run routes call above: the store, the controllers,
  // `launchDetached`, `controlLiveRun`, `artifactRefs`, `readTranscript`. On the bag as `runs` unless the
  // consumer brought its own. An APP reaches these through `step_run` on
  // its `grants.workflows`; an agent through `agentTools: ["run/*"]`.

  /** `run/launch { key }` (§5.1): `<workflow>\0<key>` → the run launched
   *  under it, memory-only — a key whose run is no longer live is free. */
  const launchKeys = new Map<string, string>();
  const liveKey = (workflow: string, runId: string) => controllers.has(`${workflow}/${runId}`);
  /** The active flow — or a throw: unknown, or sealed (these are a model's
   *  door; EVOLVE_SPEC §6). A sealed workflow a PERSON granted the calling
   *  app (src/apps/grants.ts: the assistant, for the app's own chat) opens
   *  to that app's pages, `scoped`: they reach only the runs the app
   *  launched for the same viewer (`ownRun`) — a sealed workflow's runs are
   *  its people's conversations. A FIRST-PARTY page (plans/jamie-app.md §3)
   *  needs no grant: it opens the viewer's own runs, whoever launched them. */
  const openFlow = async (name: string, by?: RunCaller): Promise<{ flow: Flow; scoped: boolean }> => {
    const flow = await workspace.getWorkflow(name);
    if (!flow.sealed) return { flow, scoped: false };
    if (isFirstParty(by?.app) && by?.actor) return { flow, scoped: true };
    if (by?.app && (await appGrants.has(by.app.name, name))) return { flow, scoped: true };
    throw new Error(
      by?.app
        ? `workflow "${name}" is sealed — a person grants it to an app (app/grant, approved by them); ${by.app.name} holds no grant of it`
        : `workflow "${name}" is sealed — its runs are not readable or launchable from here`,
    );
  };
  /** The scoped launches still live, by `<workflow>/<runId>`: who they were
   *  for, before the run's `run.start` is in its log. */
  const scopedLaunches = new Map<string, { app: string; actor: string }>();
  /** Was the run launched by `by.app` for `by.actor`? The summary's stamp,
   *  a live run's `run.start`, or the launch itself — before `run.start`
   *  lands, a run launched elsewhere (`POST …/run`) by its controller's
   *  `launchedAs`. For a first-party page: is it the viewer's, from wherever
   *  it was launched? `summary` is the one a caller already read (null:
   *  none), so it is not read twice. */
  const ownRun = async (workflow: string, runId: string, by: RunCaller | undefined, summary?: RunSummary | null): Promise<boolean> => {
    const anyApp = isFirstParty(by?.app);
    const key = `${workflow}/${runId}`;
    const launched = scopedLaunches.get(key);
    if (launched && (anyApp || launched.app === by?.app?.name) && launched.actor === (by?.actor ?? "")) return true;
    const live = controllers.get(key);
    const stamp: { app?: AppRef; actor?: string; input?: unknown } | null =
      (summary === undefined ? await store.getRunSummary(workflow, runId) : summary) ??
      (await store.getRunStart(workflow, runId)) ??
      (live ? launchedAs.get(live) : undefined) ??
      null;
    if (!launched && stamp && (anyApp || stamp.app?.name === by?.app?.name) && (stamp.actor ?? "") === (by?.actor ?? "")) return true;
    // A first-party page also reads a turn of a conversation its viewer
    // may read (one they are in, or a shared one: plans/jamie-app.md §5.2),
    // whoever took the turn — its files, its reply.
    const session = (stamp?.input as { session?: unknown } | undefined)?.session;
    if (!anyApp || !by?.actor || typeof session !== "string") return false;
    const rec = await conversations.record(session).catch(() => null);
    return !!rec && (!!rec.shared || rec.viewers.includes(by.actor)) && rec.turns.some((t) => t.runId === runId);
  };
  /** `openFlow` for one run: a scoped caller's own runs only — any other is
   *  not there, as a run that does not exist is not. */
  const openRun = async (workflow: string, runId: string, by: RunCaller | undefined): Promise<{ flow: Flow; visible: boolean }> => {
    const { flow, scoped } = await openFlow(workflow, by);
    return { flow, visible: !scoped || (await ownRun(workflow, runId, by)) };
  };
  /** A job's runs, newest first, off its record — every workflow it ran;
   *  a sealed workflow's runs left out (a model's door). */
  const jobRunLines = async (job: string): Promise<Array<{ workflow: string; runId: string }>> => {
    const problem = idProblem(job);
    if (problem) throw new Error(`job "${job}" ${problem}`);
    const lines = [...((await readJobRecord(jobRoot(dataDir, job)))?.runs ?? [])].reverse();
    const sealed = new Map<string, boolean>();
    const out: Array<{ workflow: string; runId: string }> = [];
    for (const line of lines) {
      if (!sealed.has(line.workflow)) sealed.set(line.workflow, !!(await workspace.getWorkflow(line.workflow).catch(() => null))?.sealed);
      if (!sealed.get(line.workflow)) out.push({ workflow: line.workflow, runId: line.runId });
    }
    return out;
  };
  const runsCap: RunsCapability = {
    async list(q, by) {
      if (!q.workflow && !q.job) throw new Error("run/list needs `workflow`, or `job` for a job's runs");
      const scoped = q.workflow ? (await openFlow(q.workflow, by)).scoped : false;
      const limit = Math.min(RUN_LIST_MAX_LIMIT, Math.max(1, q.limit ?? RUN_LIST_DEFAULT_LIMIT));
      // One workflow's runs, or a job's across its workflows (its record).
      const rows = q.workflow
        ? (await store.listRuns(q.workflow)).map((runId) => ({ workflow: q.workflow!, runId }))
        : await jobRunLines(q.job!);
      const from = sinceMs(q.since);
      const out: RunListEntry[] = [];
      for (const [read, { workflow, runId }] of rows.entries()) {
        if (out.length >= limit || read >= RUN_LIST_SCAN_MAX) break;
        // A workflow's ids are newest first: the first launched before
        // `since` ends the list (a job's lines are in record order).
        if (q.workflow && from !== undefined && (launchedAt({ runId }) ?? from) < from) break;
        const summary = await store.getRunSummary(workflow, runId);
        const row: RunListEntry & { jobTitle?: string } = summary
          ? listEntryOf(summary)
          : { runId, workflow, status: liveStatus(workflow, runId), ...liveJob(controllers.get(`${workflow}/${runId}`)), ...(q.workflow ? {} : { job: q.job }) } as RunListEntry;
        if (!matchesRunFilter(row, q)) continue;
        if (scoped && !(await ownRun(workflow, runId, by, summary))) continue;
        const artifacts = summary ? await artifactRefs(runId, summary.output, summary.job).catch(() => undefined) : undefined;
        out.push({ ...row, ...(artifacts ? { artifacts } : {}) });
      }
      return out;
    },
    async get(q, by) {
      if (!(await openRun(q.workflow, q.runId, by)).visible) return null;
      const deadline = Date.now() + Math.min(RUN_GET_MAX_WAIT_MS, Math.max(0, q.wait ?? 0));
      for (;;) {
        const summary = await store.getRunSummary(q.workflow, q.runId);
        if (summary) {
          const artifacts = (await artifactRefs(q.runId, summary.output, summary.job).catch(() => undefined)) ?? [];
          return { ...summary, artifacts };
        }
        // In flight: hold while the caller's wait lasts, then answer with the
        // partial summary the log gives (the route's rule, `partial: true`).
        if (liveKey(q.workflow, q.runId) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        const events = await store.getRunEvents(q.workflow, q.runId);
        const partial = summarizeFromEvents(q.workflow, q.runId, events, liveStatus(q.workflow, q.runId));
        return partial ? { ...partial, partial: true } : null;
      }
    },
    async events(q, by) {
      if (!(await openRun(q.workflow, q.runId, by)).visible) return [];
      const events = await store.getRunEvents(q.workflow, q.runId);
      return capEvents(events.map((e) => withTranscriptLink(q.workflow, e)), q.skip);
    },
    async launch(q, by) {
      const { flow, scoped } = await openFlow(q.workflow, by);
      await assertWorkflowEnabled(workspace, q.workflow);
      // Its params may narrow what its agents are granted, never widen it
      // (the meta/run-workflow rule).
      const widened = grantWidenedBy(flow, q.params ?? {}, registry);
      if (widened) throw new Error(`params may not widen what the workflow "${q.workflow}" allows — more tools, or fewer approvals: ${widened}`);
      if (q.job) {
        const problem = idProblem(q.job);
        if (problem) throw new Error(`job "${q.job}" ${problem}`);
      }
      const attachments = parseAttachments(q.attachments);
      if (attachments.length) requireRunFiles();
      // A job turn's conversation (plans/jamie-app.md §5): strut's own app
      // names one its viewer may continue (§2.2: their own, one they took a
      // turn in, a shared one) — a captcha's answer, a job continued from a
      // card — so the wake finds it. Never another person's, never a page
      // a model wrote.
      if (q.conversation !== undefined) {
        if (!isFirstParty(by.app) || !by.actor) throw new Error("conversation: only strut's own app names the conversation a launch belongs to, for its viewer (plans/jamie-app.md §5)");
        if (!(JOB_WORKFLOWS as readonly string[]).includes(flow.name)) throw new Error(`conversation names the conversation a JOB turn belongs to (${JOB_WORKFLOWS.join(", ")}), not a run of "${q.workflow}"`);
        const problem = idProblem(q.conversation);
        if (problem) throw new Error(`conversation "${q.conversation}" ${problem}`);
        const own = q.conversation === by.actor || q.conversation.startsWith(`${by.actor}/`);
        if (!own && (await conversations.mayContinue(q.conversation, by.actor)) !== true) {
          throw new Error(`conversation_not_yours: "${q.conversation}" is not a conversation you may continue — your own (${by.actor}/…), one you took a turn in, or a shared one`);
        }
      }
      // A first-party page's turn may continue a conversation the viewer
      // is in (plans/jamie-app.md §2.2).
      const cont = isFirstParty(by.app) ? await continuesFor(flow, q.input, by.actor) : {};
      if ("refused" in cont) throw new Error(cont.refused);
      // Dedupe in flight (§5.1): the run launched under this key, while it
      // lives. Keys whose runs have ended are let go here.
      for (const [k, id] of launchKeys) if (!liveKey(k.slice(0, k.indexOf("\0")), id)) launchKeys.delete(k);
      // A scoped caller's key is its own: another viewer's run is never theirs.
      const key = q.key ? `${q.workflow}\0${scoped ? `${by.app!.name}\0${by.actor ?? ""}\0` : ""}${q.key}` : undefined;
      const prior = key ? launchKeys.get(key) : undefined;
      if (prior) return { runId: prior, existing: true };
      const runId = launchDetached(
        flow,
        {
          input: q.input,
          ...(q.params ? { params: q.params } : {}),
          ...(q.job ? { job: q.job } : {}),
          ...(q.job && q.title ? { title: q.title } : {}),
          ...(q.conversation ? { conversation: q.conversation } : {}),
          // A first-party page's turn is the person's (plans/jamie-app.md
          // §3): strut is its host, so strut wakes it when its jobs end.
          ...(isFirstParty(by.app) ? { wake: true } : {}),
        },
        {
          ...(by.actor ? { actor: by.actor } : {}),
          ...(by.principal ? { principal: by.principal } : {}),
          ...(by.app ? { origin: "app" as const, app: by.app } : {}),
          ...(by.mcp?.length ? { mcp: by.mcp } : {}),
          ...(attachments.length ? { attachments } : {}),
          ...(cont.continues ? { continues: cont.continues } : {}),
        },
      );
      if (key) launchKeys.set(key, runId);
      if (scoped) {
        for (const k of scopedLaunches.keys()) if (!controllers.has(k)) scopedLaunches.delete(k);
        scopedLaunches.set(`${q.workflow}/${runId}`, { app: by.app!.name, actor: by.actor ?? "" });
      }
      return { runId };
    },
    async cancel(q, by) {
      if (!(await openRun(q.workflow, q.runId, by)).visible) return { ok: false, error: `Run "${q.runId}" not found for workflow "${q.workflow}"` };
      const r = await controlLiveRun(q.workflow, q.runId, "cancel", false, q.force === true);
      return r.ok ? { ok: true, runId: r.runId, state: r.state } : { ok: false, error: r.error };
    },
    async workflow(q, by) {
      const [meta, { flow }] = await Promise.all([workspace.getWorkflowMetadata(q.workflow), openFlow(q.workflow, by)]);
      const description = meta?.versions[meta.active]?.description;
      return {
        name: q.workflow,
        ...(description ? { description } : {}),
        ...(meta?.category ? { category: meta.category } : {}),
        ...(meta?.active ? { activeVersion: meta.active } : {}),
        ...(flow.inputBlock != null ? { input: flow.inputBlock as Record<string, unknown> } : {}),
        ...(flow.params != null ? { params: flow.params } : {}),
        ...(flow.sealed ? { sealed: true as const } : {}),
        ...(flow.peer ? { peer: flow.peer } : {}),
      };
    },
    async files(q, by) {
      if (!(await openRun(q.workflow, q.runId, by)).visible) return null;
      const summary = await store.getRunSummary(q.workflow, q.runId);
      let job = summary?.job;
      if (!summary) {
        const events = await store.getRunEvents(q.workflow, q.runId);
        if (!events.length) return null;
        job = events.find((e) => e.type === "run.start")?.job;
      }
      try {
        // A job run's files are the job's; a plain run's, its artifacts —
        // what its artifact links point at. Each guard keeps the path inside.
        const bytes = job ? new Uint8Array(await readFile(jobFilePath(jobRoot(dataDir, job), q.path))) : artifacts ? await artifacts.read(q.runId, q.path) : null;
        return bytes ? fileResult(q.path, bytes) : null;
      } catch (err: any) {
        if (err?.code === "ENOENT" || err?.code === "EISDIR") return null;
        throw err;
      }
    },
    async transcript(q, by) {
      if (!(await openRun(q.workflow, q.runId, by)).visible) throw new Error(`Run "${q.runId}" not found for workflow "${q.workflow}"`);
      const t = await readTranscript(q.workflow, q.runId, q.path, !!q.full);
      if ("error" in t) throw new Error(t.error);
      return { path: q.path, ...capTranscript(t.messages as RunTranscript["messages"]), ...(t.full ? { full: true as const } : {}) };
    },
    async provenance({ workflow, runId, ...subject }, by) {
      if (!(await openRun(workflow, runId, by)).visible) return null;
      const events = await store.getRunEvents(workflow, runId);
      return events.length ? buildProvenance(events, subject) : null;
    },
  };
  if (!(services as Record<string, unknown>)["runs"]) (services as Record<string, unknown>)["runs"] = runsCap;
  (services as Record<string, unknown>)["conversations"] ??= conversations;
  // The model catalog (`GET /llm/models`), for the `llm/models` step: one
  // list, one default, whether a route or a page reads it.
  const llmModels = () => listModelOptions({ default: chatModel, secrets: secretsCap });
  (services as Record<string, unknown>)["llmModels"] ??= llmModels;

  // Automations (plans/automations.md): scheduled launches go through the
  // same detached path as `POST /run`, stamped with their automation.
  const automations = createAutomations({
    workspace,
    store,
    secrets: automationCallbacks,
    launch: (flow, input, automation, callback) =>
      launchDetached(flow, { input }, { origin: "schedule", automation, ...(callback ? { callback } : {}) }),
    isInFlight: (workflow, runId) => controllers.has(`${workflow}/${runId}`),
    draining: () => drain.refusal(),
  });
  // The `automation/*` steps' door (src/steps/lib/automation/), unless the
  // consumer's bag brought its own: an automation made from a turn reports
  // where that turn does.
  const bag = services as Record<string, unknown>;
  if (!bag["automations"]) {
    bag["automations"] = {
      api: automations,
      ...(opts.automation ?? {}),
      callbackOf: async (runId: string) => {
        const url = await rootCallbackOf(runId);
        return url ? { url } : undefined;
      },
    } satisfies AutomationStepsCapability;
  }
  // Scheduling adopts an ownerless workflow: the scheduler's runs are billed
  // to the owner, and whoever schedules it just made it spend (§2).
  automationsRoutes(app, automations, { adopt: async (name, c) => adoptWorkflow(name, await resolveActor(c)) });

  // Delete a workflow: every version, its metadata (category, owner, cap,
  // schedules) and its run records. Refused while one of its runs is in
  // flight — a live run needs somewhere to write; cancel it first. Gated
  // like the owner transfer: the one workflow mutation nothing undoes from
  // the UI (the graph backend keeps the nodes, soft-deleted).
  app.delete("/workflows/:name", async (c) => {
    const name = c.req.param("name")!;
    const live = [...controllers.keys()].filter((k) => k.startsWith(`${name}/`)).length;
    if (live) return c.json({ error: `Workflow "${name}" has ${live} run${live === 1 ? "" : "s"} in flight — cancel first` }, 409);
    if (!(await workspace.getWorkflowMetadata(name))) return c.json({ error: `Workflow "${name}" not found` }, 404);
    await automations.forget(name);
    await store.deleteRuns(name);
    publicSurface.forgetRuns(name);
    await workspace.deleteWorkflow(name);
    return c.json({ ok: true, workflow: name });
  });

  // Claim ownerless workflows for the request actor — the migration for a
  // workspace that predates owners (seeded lab workflows, script publishes).
  // Never re-owns: a workflow someone else owns is reported, not taken;
  // transfers are `PUT /workflows/:name/owner`. Omit `workflows` for all.
  app.post("/actor/claim", async (c) => {
    const actor = await resolveActor(c);
    if (!actor) return c.json({ error: "no actor on this request — nothing to claim for" }, 400);
    const body = await c.req.json<{ workflows?: unknown }>().catch(() => ({}) as { workflows?: unknown });
    if (body.workflows !== undefined && !(Array.isArray(body.workflows) && body.workflows.every((w) => typeof w === "string"))) {
      return c.json({ error: "workflows must be a list of names" }, 400);
    }
    const names = (body.workflows as string[] | undefined) ?? (await workspace.listWorkflows()).map((w) => w.name);
    const claimed: string[] = [];
    const skipped: Array<{ workflow: string; owner?: string; reason: string }> = [];
    for (const name of names) {
      const meta = await workspace.getWorkflowMetadata(name).catch(() => null);
      if (!meta) skipped.push({ workflow: name, reason: "not found" });
      else if (meta.owner === actor) skipped.push({ workflow: name, owner: actor, reason: "already yours" });
      else if (meta.owner) skipped.push({ workflow: name, owner: meta.owner, reason: "owned by someone else — transfer instead" });
      else {
        await workspace.setWorkflowOwner(name, actor);
        claimed.push(name);
      }
    }
    return c.json({ actor, claimed, skipped });
  });
  if (opts.scheduler === undefined ? bootEnv()["STRUT_SCHEDULER"] !== "0" : opts.scheduler) automations.start();

  // Re-verify a finished run (plans/claims.md §4): after claims or checks
  // change, to backfill, or to fire `manual` checks. Synchronous, idempotent
  // per (check, run, path), and single-flighted with the detached pass.
  app.post("/workflows/:name/runs/:runId/verify", async (c) => {
    if (!verifier) return c.json({ error: CLAIMS_OFF }, 409);
    const { name, runId } = c.req.param();
    const result = await verifier.verifyRun(name, runId, { explicit: true });
    if (result.skipped === "unknown-run") return c.json({ error: `Run ${runId} of "${name}" not found` }, 404);
    return c.json(result);
  });

  // The wake for a job that ran on ANOTHER strut (plans/jamie-app.md §1.2):
  // a host that heard the job's run.end on that strut's room (Peel's bridge,
  // an org's) hands it in, and the local conversation is woken on it as on
  // a job of its own — its Continue hands the go-ahead to `@<source>`'s
  // assistant. Full scope only: a peer never wakes this strut's sessions.
  app.post("/conversations/wake", async (c) => {
    if ((await scopeOf(c)) !== "full") return c.json({ error: "forbidden: waking a conversation is the deployment's" }, 403);
    const parsed = parseWakeDoor(await c.req.json().catch(() => null));
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    const actor = await resolveActor(c);
    const wake = await wakes.jobEnded(parsed.session, { ...parsed.end, ...(actor ? { actor } : {}) });
    return c.json({ wake });
  });

  // ── Conversations (src/conversations.ts, plans/jamie-app.md §2) ────────
  // The assistant's chats as a person reads them, for a host (its key, the
  // person as `x-strut-actor`) and for a person's own token: its own and
  // the shared ones. A plain peer reads like any peer, and sees none: its
  // actor is a header any strut sets (the gate refuses it the writes). The
  // id is a query parameter or a body field: it may hold slashes.
  /** `null`: a viewer who has none here. */
  const conversationViewer = async (c: Context): Promise<ConversationViewer | null> => {
    const scope = await scopeOf(c);
    const actor = await resolveActor(c);
    if (scope === "peer:person") return actor ? { actor, person: true } : null;
    if (scope !== "full") return null;
    return actor ? { actor } : { all: true };
  };
  const conversationError = (c: Context, err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, message.startsWith("No conversation") ? 404 : message.includes("already exists") ? 409 : 400);
  };
  const intParam = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined);

  app.get("/conversations", async (c) => {
    const by = await conversationViewer(c);
    if (!by) return c.json({ conversations: [] });
    const q = c.req.query();
    const limit = intParam(q["limit"]);
    return c.json(
      await conversations.list(
        {
          ...(q["q"] ? { q: q["q"] } : {}),
          ...(q["archived"] === "1" || q["archived"] === "true" ? { archived: true } : {}),
          ...(limit ? { limit } : {}),
          ...(q["before"] ? { before: q["before"] } : {}),
        },
        by,
      ),
    );
  });

  app.get("/conversations/item", async (c) => {
    const by = await conversationViewer(c);
    const q = c.req.query();
    const session = q["id"] ?? "";
    const problem = idProblem(session);
    if (problem) return c.json({ error: `conversation id "${session}" ${problem}` }, 400);
    const [limit, before, wait, since] = [intParam(q["limit"]), intParam(q["before"]), intParam(q["wait"]), intParam(q["since"])];
    const view = by && (await conversations.get(
      { session, ...(limit ? { limit } : {}), ...(before !== undefined ? { before } : {}), ...(wait ? { wait } : {}), ...(since !== undefined ? { since } : {}) },
      by,
    ));
    return view ? c.json(view) : c.json({ error: `No conversation "${session}" (or not yours to read)` }, 404);
  });

  app.post("/conversations/update", async (c) => {
    const by = await conversationViewer(c);
    if (!by) return c.json({ error: "forbidden: no conversations here" }, 403);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body["session"] !== "string") return c.json({ error: "body must be { session, title?, archived?, seen?, shared? }" }, 400);
    for (const k of ["archived", "seen", "shared"]) {
      if (body[k] !== undefined && typeof body[k] !== "boolean") return c.json({ error: `${k} must be true or false` }, 400);
    }
    if (body["title"] !== undefined && typeof body["title"] !== "string") return c.json({ error: "title must be a string" }, 400);
    try {
      return c.json(
        await conversations.update(
          {
            session: body["session"],
            ...(typeof body["title"] === "string" ? { title: body["title"] } : {}),
            ...(typeof body["archived"] === "boolean" ? { archived: body["archived"] } : {}),
            ...(typeof body["seen"] === "boolean" ? { seen: body["seen"] } : {}),
            ...(typeof body["shared"] === "boolean" ? { shared: body["shared"] } : {}),
          },
          by,
        ),
      );
    } catch (err) {
      return conversationError(c, err);
    }
  });

  app.post("/conversations/fork", async (c) => {
    const by = await conversationViewer(c);
    if (!by) return c.json({ error: "forbidden: no conversations here" }, 403);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body["session"] !== "string" || (body["id"] !== undefined && typeof body["id"] !== "string")) {
      return c.json({ error: "body must be { session, id? }" }, 400);
    }
    try {
      return c.json(await conversations.fork({ session: body["session"], ...(typeof body["id"] === "string" ? { id: body["id"] } : {}) }, by), 201);
    } catch (err) {
      return conversationError(c, err);
    }
  });

  // `callback: { url }` asks for the result to be POSTed there when the run
  // settles (postRunCallback): validated BEFORE anything launches, and the
  // 202 carries `callback: true` — the host's proof this server honors it.
  app.post("/workflows/:name/run", async (c) => {
    const name = c.req.param("name");
    const draining = drainingResponse(c);
    if (draining) return draining;
    const scope = await scopeOf(c);
    const peer = isPeerScope(scope);
    let body = await c.req.json<RunBody>();
    if (peer) {
      const launch = peerLaunchBody(body);
      if ("refused" in launch) return c.json({ error: launch.refused }, 403);
      body = launch;
    }
    let callback: { url: string } | undefined;
    let jobCallback: { url: string } | null | undefined;
    let mcp: McpServer[] | undefined;
    let attachments: Attachment[];
    try {
      callback = await runCallbackOf(body, c);
      runJobOf(body);
      runConversationOf(body);
      runWakeOf(body);
      jobCallback = await jobCallbackOf(body, c);
      mcp = parseMcpServers(body.mcp);
      attachments = runAttachmentsOf(body);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    let flow;
    try {
      flow = await workspace.getWorkflow(name);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
    if (peer && !opensTo(flow.peer, scope)) return c.json({ error: notForPeers(name, flow.peer) }, 403);
    const disabled = await workflowDisabled(workspace, name);
    if (disabled) return c.json({ error: disabled }, 409);
    const actor = await resolveActor(c);
    // A person's turn may continue a conversation they are in
    // (plans/jamie-app.md §2.2).
    const cont = scope === "peer:person" ? await continuesFor(flow, body.input, actor) : {};
    if ("refused" in cont) return c.json({ error: cont.refused }, 403);
    // On file before the run starts, so its first update finds it.
    if (jobCallback !== undefined && body.job) await setJobCallback(jobRoot(dataDir, body.job), jobCallback?.url ?? null);
    const runId = launchDetached(flow, body, {
      actor,
      ...(cont.continues ? { continues: cont.continues } : {}),
      ...(peer ? { origin: "peer" as const } : {}),
      ...(scope === "peer:person" ? { peerPerson: true } : {}),
      ...(callback ? { callback } : {}),
      ...(jobCallback ? { jobCallback } : {}),
      ...(mcp?.length ? { mcp } : {}),
      ...(attachments.length ? { attachments } : {}),
    });
    return c.json(
      {
        runId,
        ...(callback ? { callback: true } : {}),
        ...(jobCallback ? { jobCallback: true } : {}),
        ...(mcp?.length ? { mcp: true } : {}),
        ...(attachments.length ? { attachments: true } : {}),
        ...(announcesWake(flow, body, scope) ? { wake: true } : {}),
      },
      202,
    );
  });

  app.post("/workflows/:name/:version/run", async (c) => {
    const { name, version } = c.req.param();
    const draining = drainingResponse(c);
    if (draining) return draining;
    const scope = await scopeOf(c);
    const peer = isPeerScope(scope);
    let body = await c.req.json<RunBody>();
    if (peer) {
      const launch = peerLaunchBody(body);
      if ("refused" in launch) return c.json({ error: launch.refused }, 403);
      body = launch;
    }
    let callback: { url: string } | undefined;
    let jobCallback: { url: string } | null | undefined;
    let mcp: McpServer[] | undefined;
    let attachments: Attachment[];
    try {
      callback = await runCallbackOf(body, c);
      runJobOf(body);
      runConversationOf(body);
      runWakeOf(body);
      jobCallback = await jobCallbackOf(body, c);
      mcp = parseMcpServers(body.mcp);
      attachments = runAttachmentsOf(body);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    let flow;
    try {
      flow = await workspace.getWorkflowVersion(name, version);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
    }
    // The version launched must say it, not the active one: an older
    // version is not open to peers because a newer one is.
    if (peer && !opensTo(flow.peer, scope)) return c.json({ error: notForPeers(`${name}@${version}`, flow.peer) }, 403);
    const disabled = await workflowDisabled(workspace, name);
    if (disabled) return c.json({ error: disabled }, 409);
    const actor = await resolveActor(c);
    const cont = scope === "peer:person" ? await continuesFor(flow, body.input, actor) : {};
    if ("refused" in cont) return c.json({ error: cont.refused }, 403);
    // On file before the run starts, so its first update finds it.
    if (jobCallback !== undefined && body.job) await setJobCallback(jobRoot(dataDir, body.job), jobCallback?.url ?? null);
    const runId = launchDetached(flow, body, {
      version,
      actor,
      ...(cont.continues ? { continues: cont.continues } : {}),
      ...(peer ? { origin: "peer" as const } : {}),
      ...(scope === "peer:person" ? { peerPerson: true } : {}),
      ...(callback ? { callback } : {}),
      ...(jobCallback ? { jobCallback } : {}),
      ...(mcp?.length ? { mcp } : {}),
      ...(attachments.length ? { attachments } : {}),
    });
    return c.json(
      {
        runId,
        ...(callback ? { callback: true } : {}),
        ...(jobCallback ? { jobCallback: true } : {}),
        ...(mcp?.length ? { mcp: true } : {}),
        ...(attachments.length ? { attachments: true } : {}),
        ...(announcesWake(flow, body, scope) ? { wake: true } : {}),
      },
      202,
    );
  });

  // ── The builder's tools: what every door shares ──────────────────────────

  /** The `AiDeps` the chat turn and the MCP door (`POST /mcp`) both spread,
   *  then add their own to: the chat its per-turn caps, web tools, model
   *  catalog, verify watch, elicitation and the notifying detach; MCP its
   *  public links and the polling detach. Read per turn / per request, so
   *  `registry` is the current one. */
  const builderDeps = (actor: string | undefined) => ({
    workspace,
    dataDir,
    registry,
    store,
    services,
    ...(actor ? { actor } : {}),
    secrets: secretsInjected ? undefined : secretStore,
    // The other struts this one may call: list_peers + `peer` on
    // list_workflows / get_workflow / run_workflow.
    peers: peersCap,
    // Build-time bash for the builder, cwd'd at the local data dir
    // (scrubbed env — see shell.ts).
    shell: { cwd: dataDir },
    // Read-only graph_query (+ graph_get), when there is a graph backend.
    graph,
    // The claim tools + `claims` arg, and verify_run / add_evidence +
    // the verify triggers — where the claims layer is on.
    claims: claimsAuthoring,
    verifier,
    // list_automations / set_automation / delete_automation.
    automations,
    // cancel_run / pause_run / resume_run over the live controllers.
    controlRun: controlRunForChat,
    resumeRun: async (name: string, runId: string, body: { from?: string; version?: string }) => {
      const { status: _status, ...out } = await resumeRun(name, runId, body);
      return out;
    },
    publishingEnabled: !registryWasInjected,
    getRegistry: async () => {
      if (registryWasInjected) return registry;
      const bundle = await workspaceRegistry();
      registry = bundle.registry;
      stepSources = bundle.sources;
      return bundle.registry;
    },
    // Controller registration for builder-launched runs — cancellable/
    // pausable like any other launch path (tracked from launch inside
    // the run_workflow tool, not only on detach).
    trackRun,
  });

  /** The assistant MCP door's way into the chat (set inside the chat block;
   *  absent with the chat off). */
  let assistantDoor: AssistantChatDoor | undefined;

  // ── Chat (AI workflow builder) ───────────────────────────────────────────
  //
  // A chat is a DETACHED background job (EVAL_SPEC §8), mirroring workflow
  // runs: `POST /chat` launches a turn server-side and returns immediately;
  // the turn keeps running (and persists to `messages.jsonl` + `events.jsonl`)
  // regardless of the connection. Watch it — live or after the fact — by
  // tailing `GET /chat/:id/stream`. Close the browser and the agent keeps
  // working; reopen and reattach. See `chat-store.ts`.

  if (enableChat) {
    // Wakes the chat when a detached `run_workflow` run settles: queues
    // while a turn is live (drained into one wake-up turn), appends the
    // `[run-notification]` message, and launches the next turn through the
    // same launchChatTurn path a human message uses. `meta.autoTurns`
    // (reset by POST /chat) caps consecutive machine-triggered turns.
    const notifier = createChatNotifier({
      chatStore,
      maxAutoTurns: chatMaxAutoTurns,
      // `human` when a person's elicitation answer is among the messages.
      startTurn: (chatId, turn, modelMessages, trigger) =>
        launchChatTurn(chatId, turn, modelMessages, trigger),
    });
    liveChats = () => notifier.liveChats();

    // The verify pass settled for a run this chat launched: wake it with the
    // ledger (plans/claims.md §5; ai/verify-waker.ts). Queue-and-drain applies
    // unchanged, and `autoTurns` counts it like any machine-triggered turn, so
    // the park limit holds.
    // Tells a dispatching host (`POST /chat { callback }`) when each turn
    // ends and whether another is coming — see ai/turn-callback.ts.
    const callbacks = createTurnCallbacks({
      chatStore,
      isLive: (chatId) => notifier.isLive(chatId),
      maxAutoTurns: chatMaxAutoTurns,
    });

    if (verifier) {
      verifyWaker = createVerifyWaker({
        verifier,
        deliver: async (chatId, text) => {
          await notifier.deliver(chatId, text);
        },
        expect: (chatId) => callbacks.expect(chatId),
      });
      verifySettled = (r) => void verifyWaker!.settled(r);
    }

    // The live turn's abort handle per chat — `POST /chat/:id/cancel` stops
    // it. In-process, like the notifier's liveness set.
    const turnAborts = new Map<string, AbortController>();

    // The chat in the graph (projector.ts: its `StrutChat`, turns and the
    // runs it launched), as every run is at its end: at every turn's end, and
    // when a detached run it launched settles. Detached: a graph that is
    // slow or down never holds a turn.
    const projectChatToGraph = (chatId: string): void => {
      if (runGraph) void projectChatOnce(runGraph, chatStore, chatId).catch((err) => console.error(`[projector] chat ${chatId} was not projected:`, err));
    };

    /**
     * Run one chat turn detached: build the agent, stream it server-side,
     * persist each fine-grained part to `events.jsonl`, then append the new
     * conversation messages to `messages.jsonl` and mark the turn terminal.
     * Not awaited by the request (`launchChatTurn` returns void) — its
     * liveness is decoupled from any connection, exactly like `launchDetached`.
     */
    function launchChatTurn(
      chatId: string,
      turn: number,
      modelMessages: any[],
      trigger: "human" | "notification" = "human",
    ): void {
      void (async () => {
        let outcome: { status: "done" | "error"; text?: string; error?: { message: string }; stopped?: true } = { status: "done" };
        // Synchronous (before any await): run-notifications arriving during
        // this turn must queue rather than launching a concurrent turn.
        notifier.turnStarted(chatId);
        const ac = new AbortController();
        turnAborts.set(chatId, ac);
        const emit = (e: Partial<ChatEvent> & { type: ChatEvent["type"] }) =>
          chatStore.appendEvent(chatId, {
            ts: new Date().toISOString(),
            chatId,
            turn,
            ...e,
          });

        try {
          const { ToolLoopAgent, isStepCount, streamText } = await import("ai");
          const { buildTools, buildSystem } = await import("./ai/index.js");

          // The chat's model (`ChatMeta.model`, set by POST /chat) or the
          // deployment default, read this turn (`STRUT_DEFAULT_MODEL`, which
          // a host changes at run time, else `chatModel`), key via the
          // secrets boundary. Everything
          // provider-shaped keys off the RESOLVED provider: the web tools
          // (web_search + web_fetch — native on anthropic, Exa/HTTP shims
          // elsewhere, and the shims everywhere when the call is routed
          // through a gateway) and the output cap (without which the SDK's 4096
          // default truncates a create_step call MID-JSON). A missing key
          // throws here and lands in the stream as chat.error, naming it.
          const meta = await chatStore.getMeta(chatId);
          const actor = meta?.actor;
          const llm = await resolveModel({
            model: meta?.model ?? (await defaultModel(chatModel, secretsCap)),
            secrets: secretsCap,
            // Billed as the assistant, to the chat's actor (plans/mothership-cost-control.md §3).
            ...(opts.llmAuth
              ? { llmAuth: opts.llmAuth, auth: { kind: "chat" as const, chatId, turn, ...(actor ? { actor, principal: actor } : {}) } }
              : {}),
          });
          // Compaction (plans/compaction.md §5): the mark, and the cap that
          // keeps one tool result inside the room above it.
          const compactAt = compactAtFromEnv();
          const catalog = await listModelOptions({ default: chatModel, secrets: secretsCap });
          const web = await createWebTools({
            provider: llm.provider,
            apiKey: llm.apiKey,
            secrets: secretsCap,
            searchMaxUses: 5,
            routed: llm.routed,
          });

          const deps = {
            ...builderDeps(actor),
            // A chat started over the assistant MCP door: its tool results
            // carry absolute links (an artifact's with its read token), so
            // the reply text the caller reads can be shared as it is.
            ...(meta?.publicUrl ? { publicUrl: meta.publicUrl, artifactRefs } : {}),
            toolResultMaxChars: resultCapChars(toolResultMaxCharsFromEnv(), llm.contextLimit, compactAt),
            // A document read (get_workflow / get_step) is bound by the
            // window alone — no env ceiling; uncapped with compaction off.
            documentMaxChars: resultCapChars(0, llm.contextLimit, compactAt),
            webTools: web.tools,
            // So the builder only authors `model:` values this deployment can run.
            models: {
              default: catalog.default,
              available: [...new Set(catalog.models.filter((m) => m.available).map((m) => m.provider))],
              keyNames: catalog.keyNames,
              ...(catalog.listed ? { listed: catalog.models.filter((m) => m.available).map((m) => m.name) } : {}),
            },
            watchVerify: (runId: string) => verifyWaker?.watch(runId, chatId),
            // ask_user / request_secret (plans/elicitation.md): record the
            // question on the chat — one open at a time, the newest replaces
            // — with the secret page's RELATIVE link when it asks for one.
            openElicitation: async (req: ElicitationRequest) => {
              const prev = (await chatStore.getMeta(chatId))?.elicitation;
              const elicitationId = newElicitationId();
              const base = { elicitationId, toolCallId: req.toolCallId, turn, createdAt: new Date().toISOString(), message: req.message };
              const record: ElicitationRecord =
                req.mode === "form"
                  ? { ...base, mode: "form", requestedSchema: req.requestedSchema }
                  : { ...base, mode: "url", name: req.name, exists: req.exists, url: secretUrl(chatId, elicitationId) };
              await chatStore.setMeta(chatId, { elicitation: record });
              return {
                elicitationId,
                ...(record.mode === "url" ? { url: record.url } : {}),
                ...(prev ? { replaced: prev.elicitationId } : {}),
              };
            },
            // Dispatch-mode run_workflow: a run that outlives the wait window
            // converts to detached — wake this chat with a [run-notification]
            // when it settles.
            detach: {
              waitMs: chatRunWaitMs,
              onDetach: ({
                workflow,
                runId,
                startedAt,
                promise,
              }: {
                workflow: string;
                runId: string;
                startedAt: number;
                promise: Promise<RunResult>;
              }) => {
                const delivered = callbacks.expect(chatId);
                promise
                  .then(
                    async (res) => {
                      const text = formatRunNotification({
                        workflow,
                        runId,
                        status: res.status,
                        durationMs: Date.now() - startedAt,
                        output: res.output,
                        ...(res.error ? { error: res.error } : {}),
                      });
                      // One wake-up turn carries the run AND its ledger when the
                      // verify pass settles quickly; else a [verify-notification] follows.
                      return notifier.deliver(chatId, `${text}${(await verifyWaker?.ledgerLinesFor(workflow, runId)) ?? ""}`);
                    },
                    // runWorkflow finalizes its own errors into a resolved
                    // result; a rejection here is an unexpected throw (e.g.
                    // store write failure) — still wake the chat with it.
                    (err) =>
                      notifier.deliver(
                        chatId,
                        formatRunNotification({
                          workflow,
                          runId,
                          status: "error",
                          durationMs: Date.now() - startedAt,
                          error: {
                            message: err instanceof Error ? err.message : String(err),
                          },
                        }),
                      ),
                  )
                  .catch((err) =>
                    console.error(`[chat ${chatId}] run-notification delivery failed:`, err),
                  )
                  .finally(() => {
                    delivered();
                    projectChatToGraph(chatId);
                  });
              },
            },
          };

          // The system prompt is rendered on the chat's first turn and
          // replayed verbatim after (ChatStore.getSystem): it heads the cached
          // prefix, so a new step in the tree or a re-read host section would
          // otherwise miss the cache for the whole conversation. The host's
          // section (StrutOptions.chatSystem) is read then — never fails the turn.
          let system = await chatStore.getSystem(chatId);
          if (system == null) {
            const hostSystem = await Promise.resolve()
              .then(() => chatSystem?.({ chatId, turn, ...(actor ? { actor } : {}) }))
              .catch((err) => {
                console.warn(`[chat ${chatId}] chatSystem hook failed:`, err instanceof Error ? err.message : err);
                return undefined;
              });
            system = await buildSystem({ ...deps, ...(hostSystem ? { hostSystem } : {}) });
            await chatStore.setSystem(chatId, system);
          }

          // Anthropic's automatic prompt caching (the request's top-level
          // `cache_control`): each step reads the conversation so far and
          // writes only what the last step added. Other providers cache on
          // their own (xai, openai) or through aieo's model settings.
          const providerOptions =
            llm.provider === "anthropic" ? { anthropic: { cacheControl: { type: "ephemeral" as const } } } : undefined;
          const tools = buildTools(deps);
          // What the requests send: the frozen prompt, with its own cache breakpoint.
          const instructions = cachedSystem(system, providerOptions) as any;
          // The context after the latest model call, and the compaction mark
          // against it (plans/compaction.md §5). Set in `onStepEnd`, which the
          // SDK awaits before it asks `stopWhen` — never from the event loop
          // below, which may still be writing an earlier step's events.
          let lastContext: { used: number; limit: number } | undefined;
          const overMarkStop = () => !!lastContext && overMark(lastContext, compactAt);
          /** A tool-loop runner with `budget` steps left. The turn ends on an
           *  ask (plans/elicitation.md: the tool's result is in, and the
           *  answer arrives as the next turn's message), at the cap, or past
           *  the mark — the loop below then compacts and goes on. */
          const makeAgent = (budget: number) =>
            new ToolLoopAgent({
              model: llm.model,
              instructions,
              tools,
              maxOutputTokens: llm.maxOutputTokens,
              ...(providerOptions ? { providerOptions } : {}),
              stopWhen: [({ steps }) => stepAsked(steps[steps.length - 1]), isStepCount(budget), overMarkStop],
              onEnd: () => {
                registry = deps.registry;
              },
            });

          console.log(`[chat ${chatId}] turn ${turn} start (${modelMessages.length} msgs, model ${llm.name})`);

          // Every step's messages — the assistant message and its tool
          // results — go to messages.jsonl AS THE STEP ENDS, before the next
          // model call (the SDK awaits onStepEnd), so a turn cut off by a
          // restart leaves a consistent history behind: whole steps, never a
          // call without its result (`reconcileStaleChat` builds on that).
          // The end of the turn has nothing left to write but a stop's
          // partial step. One chain keeps the appends in order; a write that
          // fails ends the turn — the model must not go on past a step the
          // record lost.
          let persisted: Promise<void> = Promise.resolve();
          // This stretch's completed steps (what the compaction sent, where
          // the final text is) and, for a stop mid-turn (POST
          // /chat/:id/cancel), the in-flight step as far as it streamed — so
          // the transcript holds what the user saw, and a tool call cut off
          // before its result gets a "stopped" result rather than dangling
          // into the next turn.
          const doneMessages: any[] = [];
          let stepText = "";
          let stepCalls: { toolCallId: string; toolName: string; input: unknown; output?: unknown }[] = [];
          const setOutput = (toolCallId: string, output: unknown) => {
            const call = stepCalls.find((c) => c.toolCallId === toolCallId);
            if (call) call.output = output;
          };
          const partialStep = (): any[] => {
            if (!stepText && stepCalls.length === 0) return [];
            const assistant = {
              role: "assistant",
              content: [
                ...(stepText ? [{ type: "text", text: stepText }] : []),
                ...stepCalls.map(({ toolCallId, toolName, input }) => ({ type: "tool-call", toolCallId, toolName, input })),
              ],
            };
            if (stepCalls.length === 0) return [assistant];
            const tool = {
              role: "tool",
              content: stepCalls.map(({ toolCallId, toolName, output }) => ({
                type: "tool-result",
                toolCallId,
                toolName,
                output: output ?? { type: "error-text", value: "Stopped by the user; this call's result was not recorded." },
              })),
            };
            return [assistant, tool];
          };

          // What this attempt sends: the history from the chat's last boundary
          // plus the new message — and, after a compaction mid-turn, the
          // compaction message alone. One attempt per stretch of the turn.
          let request: any[] = modelMessages;
          let stepsUsed = 0;
          let lastStep: any;
          let stopped = false;
          let responseMessages: any[] = [];
          for (;;) {
            doneMessages.length = 0;
            const result = await makeAgent(Math.max(1, chatMaxSteps - stepsUsed)).stream({
              messages: request,
              abortSignal: ac.signal,
              onStepEnd: (step) => {
                doneMessages.push(...step.response.messages);
                persisted = persisted.then(() => chatStore.appendMessages(chatId, step.response.messages as any));
                stepsUsed++;
                lastStep = step;
                const u = step.usage;
                const context = chatEventOf({ type: "finish-step", usage: u }, llm.contextLimit)?.context;
                if (context) lastContext = context;
                console.log(
                  `[chat ${chatId}] turn ${turn} step ${step.stepNumber} finish=${step.finishReason} tokens=in:${u?.inputTokens ?? "?"}/out:${u?.outputTokens ?? "?"}`,
                );
                // finish=length is a TRUNCATED generation: a cut-off tool call
                // never executes and the turn dies silently. Say why, loudly.
                if (step.finishReason === "length") {
                  console.warn(
                    `[chat ${chatId}] turn ${turn} step ${step.stepNumber} TRUNCATED at maxOutputTokens=${llm.maxOutputTokens} — a cut-off tool call never executed; the turn likely ended incomplete. Raise STRUT_MAX_OUTPUT_TOKENS if this recurs.`,
                  );
                }
                // Awaited by the SDK: the step is on disk before the next call.
                return persisted;
              },
            });

            try {
              for await (const part of result.stream) {
                // Bookkeeping for a stop mid-turn (partialStep above). A
                // preliminary tool-result (graph_walk's hops) is progress, not
                // the call's result.
                switch (part.type) {
                  case "text-delta":
                    if (part.text) stepText += part.text;
                    break;
                  case "tool-call":
                    stepCalls.push({ toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
                    break;
                  case "tool-result":
                    if (!(part as { preliminary?: boolean }).preliminary) setOutput(part.toolCallId, capToolOutput({ type: "json", value: part.output }));
                    break;
                  case "tool-error":
                    setOutput(part.toolCallId, {
                      type: "error-text",
                      value: part.error instanceof Error ? part.error.message : String(part.error),
                    });
                    break;
                  case "finish-step":
                    stepText = "";
                    stepCalls = [];
                    break;
                  case "error":
                    throw part.error;
                }
                const e = chatEventOf(part, llm.contextLimit);
                if (e) await emit(e);
                if (e?.context) await chatStore.setMeta(chatId, { context: e.context });
              }
            } catch (err) {
              // A stop can surface as the aborted provider call's throw.
              if (!ac.signal.aborted) throw err;
            }

            // The completed steps are on disk — each append was awaited
            // before the next model call; the last may still be in flight
            // when the stream closes. A stopped turn never awaits the SDK's
            // promises (they reject when no step completed): what it has is
            // what streamed, and only the partial step is left to write.
            await persisted;
            stopped = ac.signal.aborted;
            const partial = stopped ? partialStep() : [];
            responseMessages = [...doneMessages, ...partial];
            if (partial.length) await chatStore.appendMessages(chatId, partial as any);
            if (stopped) break;

            // Past the mark (plans/compaction.md §5): fold everything the
            // model has seen into its own summary, appended as a user message
            // — the history only grows — and move the chat's replay boundary
            // to it. Mid-task (the last step called tools, their results are
            // in, no question asked, budget left) the turn goes on from the
            // summary alone; a finished turn leaves the summary for the next
            // one. The summarizer runs under the turn's own system, tools and
            // provider options — the prefix the thinking blocks are bound to,
            // and the cache's. A failed summarizer is a warning: the turn goes
            // on uncompacted and the next step boundary tries again.
            if (lastContext && overMark(lastContext, compactAt)) {
              const sent = [...request, ...responseMessages];
              const midTask = responseMessages.at(-1)?.role === "tool" && !stepAsked(lastStep) && stepsUsed < chatMaxSteps;
              let compaction: { role: "user"; content: string } | undefined;
              try {
                const got = await summarize({
                  streamText,
                  model: llm.model,
                  system: instructions,
                  tools,
                  providerOptions,
                  messages: sent,
                  retain: CHAT_RETAIN,
                  abortSignal: ac.signal,
                });
                if (got.summary === undefined) throw new Error(`the summary ended with finishReason "${got.finishReason}"`);
                const of = { messages: sent.length, tokens: lastContext.used };
                compaction = { role: "user", content: compactionMessage(got.summary, of) };
                // Its index in messages.jsonl is where the chat replays from.
                const replayFrom = (await chatStore.loadMessages(chatId)).length;
                await chatStore.appendMessages(chatId, [compaction]);
                // A floor for the meter — the summary's size; the next call corrects it.
                const context = { used: got.usage.outputTokens, limit: llm.contextLimit };
                lastContext = context;
                await chatStore.setMeta(chatId, { replayFrom, context });
                await emit({ type: "chat.compact", compact: { ...of, usage: got.usage }, context });
                console.log(`[chat ${chatId}] turn ${turn} compacted ${of.messages} messages (~${of.tokens} tokens); the replay begins at ${replayFrom}.`);
              } catch (err) {
                if (ac.signal.aborted) {
                  stopped = true;
                  break;
                }
                console.warn(`[chat ${chatId}] turn ${turn} compaction failed (${err instanceof Error ? err.message : String(err)}); continuing uncompacted.`);
              }
              if (midTask) {
                request = compaction ? [compaction] : sent;
                continue;
              }
            }
            break;
          }
          outcome = { status: "done", text: finalAssistantText(responseMessages), ...(stopped ? { stopped: true as const } : {}) };
          await emit({ type: "chat.end", ...(stopped ? { stopped: true as const } : {}) });
          await chatStore.setMeta(chatId, { status: "done" });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[chat ${chatId}] turn ${turn} failed:`, err);
          outcome = { status: "error", error: { message } };
          await emit({ type: "chat.error", error: { message } });
          await chatStore.setMeta(chatId, { status: "error" });
        } finally {
          turnAborts.delete(chatId);
          // Drain run-notifications that queued during this turn — delivers
          // them all in ONE follow-up turn (launched via startTurn above).
          try {
            await notifier.turnEnded(chatId);
          } catch (err) {
            console.error(`[chat ${chatId}] notification drain failed:`, err);
          }
          // Tell the dispatching host — AFTER the drain, so the chat is no
          // longer live when it hears (or the follow-up turn already is, and
          // this one reports `settled: false`). The builder's open question
          // rides along (plans/elicitation.md); when THIS turn asked it,
          // `text` IS the question, so a host that only reads text still
          // sees it. (An answer the drain just delivered has cleared it.)
          try {
            const asked = (await chatStore.getMeta(chatId))?.elicitation;
            if (asked && asked.turn === turn && outcome.status === "done") outcome.text = renderElicitationText(asked);
            await callbacks.turnEnded({ chatId, turn, trigger, ...outcome, ...(asked ? { elicitation: callbackElicitation(asked) } : {}) });
          } catch (err) {
            console.error(`[chat ${chatId}] turn callback failed:`, err);
          }
          projectChatToGraph(chatId);
        }
      })();
    }

    /**
     * A turn that was live when this process died never wrote its
     * `chat.end`/`chat.error` — `meta.status` stays `"live"` on disk and any
     * tail of that turn waits forever (which is what pins the UI: the client
     * treats a live chat as loading until its stream ends). Liveness is only
     * knowable in-process (`notifier.isLive`), so a stale chat is reconciled
     * on first sight — the boot scan (`autoResumeStaleChats`, beside the run
     * scan) or whichever read finds it first:
     *
     *   1. the dead turn gets its terminal event and the chat its status:
     *      `error`, or `done` when that turn had asked the user a question —
     *      its work was finished and only the `chat.end` was lost;
     *   2. with auto-resume on, a `[restart-notification]` is appended. The
     *      completed steps are already in messages.jsonl (written as each
     *      ended), so it says what the event log knows and the transcript
     *      does not: the tool calls with no result yet, the detached runs
     *      whose notifications died with the process;
     *   3. `launch` → a wake-up turn through the notifier, like a run
     *      notification — counted against the auto-turn cap, so a turn that
     *      crashes the server every time parks after `chatMaxAutoTurns`
     *      restarts — unless the chat sat idle past `maxAgeMs`. `POST /chat`
     *      passes `launch: false`: its own turn follows at once and reads
     *      the notice ahead of the typed message;
     *   4. the host hears the dead turn's `turn.end`, after the wake-up
     *      launched (`settled: false` then; that turn's end follows).
     *
     * Returns the (possibly patched) meta; a chat another caller is
     * reconciling is returned as found.
     */
    const reconciling = new Set<string>();
    const staleChat = (meta: ChatMeta) =>
      meta.status === "live" && meta.currentTurn >= 0 && !notifier.isLive(meta.id) && !reconciling.has(meta.id);

    async function reconcileStaleChat(meta: ChatMeta, o: { launch: boolean } = { launch: true }): Promise<ChatMeta> {
      if (!staleChat(meta)) return meta;
      reconciling.add(meta.id);
      try {
        return (await resumeStaleChat(meta, { wake: autoResumeChats, launch: o.launch, maxAgeMs: autoResumeOpts.maxAgeMs })).meta;
      } finally {
        reconciling.delete(meta.id);
      }
    }

    autoResumeStaleChats = async (o: AutoResumeOptions = {}) => {
      const out: ChatResumeOutcome[] = [];
      let chats: ChatMeta[];
      try {
        chats = await chatStore.listChats();
      } catch (err) {
        console.error(`[auto-resume] could not list chats:`, err);
        return out;
      }
      for (const meta of chats) {
        if (!staleChat(meta)) continue;
        reconciling.add(meta.id);
        try {
          out.push((await resumeStaleChat(meta, { wake: true, launch: true, maxAgeMs: o.maxAgeMs })).outcome);
        } catch (err) {
          console.error(`[auto-resume] chat ${meta.id}:`, err);
        } finally {
          reconciling.delete(meta.id);
        }
      }
      return out;
    };

    /** What the event log knows of a cut-off turn that its persisted steps
     *  do not: the tool calls with no result yet, and the runs its
     *  run_workflow detached (nothing will wake the chat for them). Read
     *  once the turn's terminal event is written, where the tail closes. */
    async function cutOffTurn(
      chatId: string,
      turn: number,
    ): Promise<{ inFlight: string[]; detached: { workflow: string; runId: string }[] }> {
      const open = new Map<string, string>();
      const detached: { workflow: string; runId: string }[] = [];
      for await (const e of chatStore.tailEvents(chatId, turn)) {
        if (!e.toolCallId) continue;
        if (e.type === "tool-input") open.set(e.toolCallId, e.toolName ?? "a tool");
        else if (e.type === "tool-output") {
          open.delete(e.toolCallId);
          const out = e.output as { detached?: boolean; workflow?: string; runId?: string } | null;
          if (e.toolName === "run_workflow" && out?.detached && out.workflow && out.runId) {
            detached.push({ workflow: out.workflow, runId: out.runId });
          }
        }
      }
      return { inFlight: [...open.values()], detached };
    }

    async function resumeStaleChat(
      meta: ChatMeta,
      o: { wake: boolean; launch: boolean; maxAgeMs?: number },
    ): Promise<{ meta: ChatMeta; outcome: ChatResumeOutcome }> {
      const chatId = meta.id;
      const turn = meta.currentTurn;
      // The turn had asked and stopped on it (`stepAsked`): finished, only
      // its chat.end lost. The question stays open for its answer.
      const asked = meta.elicitation?.turn === turn ? meta.elicitation : undefined;
      const status = asked ? ("done" as const) : ("error" as const);
      const error = asked ? undefined : { message: "Turn interrupted: the server restarted mid-turn." };
      await chatStore.appendEvent(chatId, {
        ts: new Date().toISOString(),
        chatId,
        turn,
        ...(error ? { type: "chat.error" as const, error } : { type: "chat.end" as const }),
      });
      let next = (await chatStore.setMeta(chatId, { status })) ?? meta;

      const finalized = (reason: string): ChatResumeOutcome => ({ chatId, turn, action: "finalized", reason });
      let outcome: ChatResumeOutcome;
      if (asked) outcome = finalized("marked done: it had asked the user and was waiting for the answer");
      else if (!o.wake) outcome = finalized("marked error: auto-resume is off");
      else {
        const text = formatRestartNotification({ turn, ...(await cutOffTurn(chatId, turn)) });
        const idleMs = Date.now() - Date.parse(meta.updatedAt);
        const maxAgeMs = o.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
        if (!o.launch) {
          await chatStore.appendMessages(chatId, [{ role: "user", content: text }]);
          outcome = finalized("the restart notice appended; the typed message's turn follows");
        } else if (idleMs > maxAgeMs) {
          await chatStore.appendMessages(chatId, [{ role: "user", content: text }]);
          outcome = finalized(`the restart notice appended, no turn: idle ${Math.round(idleMs / 3_600_000)} h (cap ${Math.round(maxAgeMs / 3_600_000)} h)`);
        } else {
          const r = await notifier.deliver(chatId, text);
          outcome =
            r.turn !== undefined
              ? { chatId, turn, action: "resumed", next: r.turn, reason: `woken as turn ${r.turn}` }
              : finalized("the restart notice appended, no turn: parked at the auto-turn cap");
          next = (await chatStore.getMeta(chatId)) ?? next;
        }
      }
      console.warn(`[chat ${chatId}] turn ${turn} was live when the process died — ${outcome.reason}.`);
      // The host hears the dead turn end — after a wake-up launched, so
      // `settled` says more is coming. What triggered it was not recorded.
      callbacks
        .turnEnded({
          chatId,
          turn,
          status,
          ...(error ? { error } : {}),
          ...(asked ? { text: renderElicitationText(asked), elicitation: callbackElicitation(asked) } : {}),
        })
        .catch((err) => console.error(`[chat ${chatId}] turn callback failed:`, err));
      return { meta: next, outcome };
    }

    /** A chat's meta as a read endpoint returns it: the callback URL is a
     *  credential, so only its origin leaves the server. */
    const publicMeta = (meta: ChatMeta) =>
      meta.callback ? { ...meta, callback: { origin: callbackOrigin(meta.callback.url) } } : meta;

    /**
     * `POST /chat`'s core, shared with the assistant MCP door
     * (ask_workflow_builder): look the chat up — or make one — append the
     * caller's message and launch its turn detached. One turn per chat at a
     * time: two agents appending to the same transcript would interleave
     * (different chats run concurrently). `at` is the appended message's
     * index — where a read of THIS turn starts.
     */
    async function sendChatMessage(args: {
      chatId?: string;
      /** The user message's content, given the chat's id (an attachment is
       *  saved under it first): text, or text + file parts. */
      content: (chatId: string) => Promise<unknown>;
      /** A NEW chat's title. */
      title?: string;
      /** A validated model pick, canonical. */
      model?: string;
      callback?: { url: string } | null;
      actor?: string;
      /** A chat started over MCP: links in its builder's tool results are
       *  absolute on this base (`ChatMeta.publicUrl`, stamped once). */
      publicUrl?: string;
    }): Promise<{ chatId: string; turn: number; at: number } | { error: string; code: "not_found" | "busy" | "draining" }> {
      // A person's message is new work: none while draining (src/drain.ts).
      const draining = drain.refusal();
      if (draining) return { error: draining, code: "draining" };
      let chatId = args.chatId;
      let meta = chatId ? await chatStore.getMeta(chatId) : null;
      if (chatId && !meta) return { error: `Chat "${chatId}" not found`, code: "not_found" };
      if (meta) {
        // A chat cut off by a restart: its dead turn is finalized and the
        // restart notice appended, but no wake-up turn — this message's turn
        // follows at once and reads the notice ahead of it.
        meta = await reconcileStaleChat(meta, { launch: false });
        if (notifier.isLive(meta.id)) return { error: `Chat "${meta.id}" has a turn in progress`, code: "busy" };
      }
      if (!chatId) {
        chatId = generateChatId();
        // Only a pick is recorded: a chat without one runs on the
        // deployment's default as it is at each turn (launchChatTurn).
        meta = await chatStore.createChat({ id: chatId, ...(args.title ? { title: args.title } : {}), ...(args.model ? { model: args.model } : {}) });
      }
      // From the chat's compaction boundary (plans/compaction.md §5): the
      // whole history stays on disk; the model replays from the summary.
      const all = await chatStore.loadMessages(chatId);
      const prior = all.slice(meta!.replayFrom ?? 0);
      const userMsg = { role: "user", content: await args.content(chatId) };
      await chatStore.appendMessages(chatId, [userMsg]);

      const turn = (meta!.currentTurn ?? -1) + 1;
      // A human message resets the consecutive-auto-turn counter (the
      // notification runaway guard) — see `ai/notifier.ts` — and closes the
      // builder's open question, if any: the model reads the typed text
      // instead, and a late answer to that question is a 404.
      await chatStore.setMeta(chatId, {
        status: "live",
        currentTurn: turn,
        autoTurns: 0,
        elicitation: undefined,
        ...(args.model ? { model: args.model } : {}),
        ...(args.callback !== undefined ? { callback: args.callback ?? undefined } : {}),
        ...(args.actor ? { actor: args.actor } : {}),
        // The first identified speaker started the chat; nobody re-stamps it.
        ...(args.actor && !meta!.createdBy ? { createdBy: args.actor } : {}),
        ...(args.publicUrl && !meta!.publicUrl ? { publicUrl: args.publicUrl } : {}),
      });

      // Tool results are capped where they are made, so this is a no-op on
      // anything recent; it holds a history recorded before then at the size
      // the model has been reading.
      launchChatTurn(chatId, turn, truncateToolMessages([...prior, userMsg]));
      return { chatId, turn, at: all.length };
    }

    // The assistant MCP door's way into the chat (src/ai/assistant-tools.ts):
    // the same send as `POST /chat`, the notifier's liveness, the callbacks'
    // settledness, the turn's recorded error.
    assistantDoor = {
      send: ({ chatId, message, title, actor, publicUrl }) =>
        sendChatMessage({
          ...(chatId ? { chatId } : {}),
          title: title ?? message.split("\n")[0]!.slice(0, 80),
          content: async () => message,
          ...(actor ? { actor } : {}),
          ...(publicUrl ? { publicUrl } : {}),
        }),
      isLive: (id) => notifier.isLive(id),
      isSettled: (id) => callbacks.isSettled(id),
      reconcile: (m) => reconcileStaleChat(m),
      turnError: async (chatId, turn) => {
        if (notifier.isLive(chatId)) return undefined;
        for await (const e of chatStore.tailEvents(chatId, turn)) if (e.type === "chat.error") return e.error?.message;
        return undefined;
      },
      maxAutoTurns: chatMaxAutoTurns,
    };

    // Send a message: append it, launch the turn detached, return ids (202).
    app.post("/chat", async (c) => {
      const body = await c.req.json<{
        chatId?: string;
        message?: string;
        title?: string;
        model?: string;
        callback?: { url?: string } | null;
        attachments?: unknown;
      }>();
      // Files ride beside the text (ai/attachments.ts), validated before
      // anything is persisted. With them, the text may be empty.
      let attachments: Attachment[];
      try {
        attachments = parseAttachments(body.attachments);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
      if (body.message !== undefined && typeof body.message !== "string") {
        return c.json({ error: "message must be a string" }, 400);
      }
      const message = body.message?.trim() ? body.message : "";
      if (!message && !attachments.length) {
        return c.json({ error: "message (string) is required" }, 400);
      }
      // Whoever speaks to the chat is its actor from here on (§2).
      const actor = await resolveActor(c);
      const chatId = body.chatId;
      // An explicit model pick is validated (provider known, key configured)
      // BEFORE anything is persisted — a bad pick is a 400 here, not a dead
      // chat — and recorded on the chat in canonical "provider/id" form.
      // Without one the chat keeps its recorded model (else the default);
      // launchChatTurn resolves that per turn.
      let pickedModel: string | undefined;
      if (body.model !== undefined) {
        if (typeof body.model !== "string" || !body.model.trim()) {
          return c.json({ error: "model must be a non-empty string" }, 400);
        }
        try {
          pickedModel = (
            await resolveModel({
              model: body.model.trim(),
              secrets: secretsCap,
              // Through the gateway the key is the actor's grant, not ours —
              // same auth the turn will use (a strut behind the Mothership
              // may hold no provider keys at all).
              ...(opts.llmAuth
                ? { llmAuth: opts.llmAuth, auth: { kind: "chat" as const, chatId: chatId ?? "new", turn: 0, ...(actor ? { actor, principal: actor } : {}) } }
                : {}),
            })
          ).name;
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
      }
      // A host that wants to hear each turn end (ai/turn-callback.ts). Kept on
      // the chat until replaced, or cleared with `callback: null`.
      let callback: { url: string } | null | undefined;
      if (body.callback !== undefined) {
        try {
          callback = body.callback === null ? null : parseCallback(body.callback);
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
      }
      const sent = await sendChatMessage({
        ...(chatId ? { chatId } : {}),
        title: body.title ?? (message || attachments.map((a) => a.name).join(", ")).slice(0, 80),
        // Text first, then each file (saved where bash and a run can read it).
        content: async (id) => {
          if (!attachments.length) return message;
          const paths = await saveAttachments(dataDir, id, attachments);
          const parts = await Promise.all(attachments.map((a, i) => attachmentParts(a, paths[i]!)));
          return [...(message ? [{ type: "text", text: message }] : []), ...parts.flat()];
        },
        ...(pickedModel ? { model: pickedModel } : {}),
        ...(callback !== undefined ? { callback } : {}),
        ...(actor ? { actor } : {}),
      });
      if ("error" in sent) {
        if (sent.code === "draining") return c.json({ error: sent.error }, 503, { "retry-after": "60" });
        return c.json({ error: sent.error }, sent.code === "not_found" ? 404 : 409);
      }

      // `callback: true` is the host's proof this server honors callbacks (an
      // older one ignores the field and would never call back).
      const hasCallback = callback !== undefined ? callback !== null : !!(await chatStore.getMeta(sent.chatId))?.callback;
      return c.json({ chatId: sent.chatId, turn: sent.turn, ...(hasCallback ? { callback: true } : {}) }, 202);
    });

    // List chat sessions (newest first).
    app.get("/chats", async (c) => {
      const list = await chatStore.listChats();
      return c.json((await Promise.all(list.map((m) => reconcileStaleChat(m)))).map(publicMeta));
    });

    // Reattach to a chat turn's event stream (live or completed) — SSE tail.
    // Defaults to the latest turn; pass ?turn=N to follow a specific one.
    app.get("/chat/:chatId/stream", async (c) => {
      const chatId = c.req.param("chatId");
      const stored = await chatStore.getMeta(chatId);
      if (!stored) return c.json({ error: `Chat "${chatId}" not found` }, 404);
      const meta = await reconcileStaleChat(stored);

      const turnParam = c.req.query("turn");
      const turn = turnParam != null ? Number(turnParam) : meta.currentTurn;

      return streamSSE(c, async (stream) => {
        // No such turn yet — nothing to tail; report current status.
        if (!(turn >= 0) || turn > meta.currentTurn) {
          await stream.writeSSE({
            event: "done",
            data: JSON.stringify({ chatId, turn, status: meta.status }),
          });
          return;
        }
        const ac = new AbortController();
        stream.onAbort(() => ac.abort());
        for await (const event of chatStore.tailEvents(chatId, turn, { signal: ac.signal })) {
          await stream.writeSSE({ data: JSON.stringify(event) });
        }
        if (ac.signal.aborted) return;
        const fresh = await chatStore.getMeta(chatId);
        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({ chatId, turn, status: fresh?.status ?? "done" }),
        });
      });
    });

    // Stop the live turn (the flyout's stop square): abort the agent stream,
    // keep what streamed, end the turn as `chat.end { stopped: true }`.
    app.post("/chat/:chatId/cancel", async (c) => {
      const chatId = c.req.param("chatId");
      if (!(await chatStore.getMeta(chatId))) return c.json({ error: `Chat "${chatId}" not found` }, 404);
      const ac = turnAborts.get(chatId);
      if (!ac) return c.json({ error: `Chat "${chatId}" has no turn in progress` }, 409);
      ac.abort();
      return c.json({ ok: true });
    });

    // ── Elicitation answers (plans/elicitation.md) ─────────────────────
    //
    // The builder asked (ask_user / request_secret) and its turn ended on
    // the call; the answer comes back here and starts the next turn through
    // the notifier — queued behind a live one, so a form never sees a 409.
    // Who answered is RECORDED (`by`), never checked against the chat's
    // actor: the secret store is deployment-global, so the deployment's auth
    // in front of the UI is the binding, exactly as for PUT /secrets.

    /** The chat's open elicitation `:eid`, or the error response. */
    async function openElicitationOf(c: Context): Promise<{ meta: ChatMeta; open: ElicitationRecord } | Response> {
      // An answer starts the chat's next turn: while draining the question
      // stays open, to be answered once the server is back.
      const draining = drainingResponse(c);
      if (draining) return draining;
      const chatId = c.req.param("chatId") ?? "";
      const eid = c.req.param("eid") ?? "";
      const meta = await chatStore.getMeta(chatId);
      if (!meta) return c.json({ error: `Chat "${chatId}" not found` }, 404);
      const open = meta.elicitation;
      if (!open || open.elicitationId !== eid) {
        return c.json({ error: `No open elicitation "${eid}" on chat "${chatId}" — answered, replaced by a newer question, or closed by a message` }, 404);
      }
      return { meta, open };
    }

    /** Close the question and hand the response to the chat as a HUMAN
     *  message: the next turn launches now, or queues behind a live one. */
    async function answerElicitation(chatId: string, text: string) {
      await chatStore.setMeta(chatId, { elicitation: undefined });
      const r = await notifier.deliver(chatId, text, { human: true });
      return { chatId, ...(r.turn !== undefined ? { turn: r.turn } : {}), ...(r.queued ? { queued: true as const } : {}) };
    }

    // A form answer — or a decline / cancel of either kind of question.
    app.post("/chat/:chatId/elicitations/:eid", async (c) => {
      const found = await openElicitationOf(c);
      if (found instanceof Response) return found;
      const { meta, open } = found;
      const body = await c.req.json<{ action?: unknown; content?: unknown }>().catch(() => ({}) as { action?: unknown; content?: unknown });
      const action = body.action;
      if (typeof action !== "string" || !(ELICITATION_ACTIONS as readonly string[]).includes(action)) {
        return c.json({ error: "action must be accept | decline | cancel" }, 400);
      }
      if (action === "accept" && open.mode === "url") {
        return c.json(
          { error: `"${open.name}" is a secret: accept it through POST /chat/${meta.id}/elicitations/${open.elicitationId}/secret { value }, never here` },
          400,
        );
      }
      let content: Record<string, unknown> | undefined;
      if (action === "accept" && open.mode === "form") {
        try {
          content = validateContent(open.requestedSchema, body.content);
        } catch (err) {
          return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
      }
      const by = await resolveActor(c);
      const text = formatElicitationResponse({
        elicitationId: open.elicitationId,
        action: action as ElicitationAction,
        ...(by ? { by } : {}),
        ...(content ? { content } : {}),
        ...(open.mode === "url" ? { secret: { name: open.name } } : {}),
      });
      return c.json(await answerElicitation(meta.id, text), 202);
    });

    // URL mode's completion: the value goes straight into the store under
    // the NAME the server recorded — never one from the request — and the
    // chat hears "stored". Nothing else ever carries the value.
    app.post("/chat/:chatId/elicitations/:eid/secret", async (c) => {
      if (secretsInjected) {
        return c.json({ error: "secrets are managed by an injected capability" }, 501);
      }
      const found = await openElicitationOf(c);
      if (found instanceof Response) return found;
      const { meta, open } = found;
      if (open.mode !== "url") return c.json({ error: "this question is a form, not a secret — answer it through POST /chat/:id/elicitations/:eid" }, 400);
      const body = await c.req.json<{ value?: unknown }>().catch(() => ({ value: undefined }));
      if (typeof body.value !== "string" || body.value.length === 0) {
        return c.json({ error: "value (non-empty string) is required" }, 400);
      }
      await secretStore.set(open.name, body.value);
      const by = await resolveActor(c);
      const text = formatElicitationResponse({ elicitationId: open.elicitationId, action: "accept", ...(by ? { by } : {}), secret: { name: open.name } });
      return c.json(await answerElicitation(meta.id, text), 202);
    });

    // Full chat transcript + meta (for reload / reattach).
    // A streaming tool call's progress (graph_walk's hop events), for a chat
    // loaded from history: messages.jsonl keeps only the final result, the
    // event log keeps every `tool-progress`. Scans finished turns, newest first.
    app.get("/chat/:chatId/progress/:toolCallId", async (c) => {
      const chatId = c.req.param("chatId");
      const toolCallId = c.req.param("toolCallId");
      let meta = await chatStore.getMeta(chatId);
      if (!meta) return c.json({ error: `Chat "${chatId}" not found` }, 404);
      meta = await reconcileStaleChat(meta);
      const last = meta.status === "live" ? meta.currentTurn - 1 : meta.currentTurn;
      for (let turn = last; turn >= 0; turn--) {
        const outputs: unknown[] = [];
        for await (const e of chatStore.tailEvents(chatId, turn)) {
          if (e.type === "tool-progress" && e.toolCallId === toolCallId) outputs.push(e.output);
        }
        if (outputs.length) return c.json({ outputs });
      }
      return c.json({ outputs: [] });
    });

    // Meta alone — what the flyout's idle poll needs (turn, status, open
    // question, context). A long transcript is megabytes; the client loads
    // it only when the turn advanced.
    app.get("/chat/:chatId/meta", async (c) => {
      const chatId = c.req.param("chatId");
      const meta = await chatStore.getMeta(chatId);
      if (!meta) return c.json({ error: `Chat "${chatId}" not found` }, 404);
      return c.json(publicMeta(await reconcileStaleChat(meta)));
    });

    app.get("/chat/:chatId", async (c) => {
      const chatId = c.req.param("chatId");
      let meta = await chatStore.getMeta(chatId);
      if (!meta) return c.json({ error: `Chat "${chatId}" not found` }, 404);
      meta = await reconcileStaleChat(meta);
      const messages = await chatStore.loadMessages(chatId);
      return c.json({ meta: publicMeta(meta), messages });
    });
  }

  // ── MCP (strut for an external agent) ────────────────────────────────────
  //
  // Two tool sets over the Model Context Protocol (src/ai/mcp.ts) — stateless,
  // a fresh server per request, behind the gate like every route (the
  // deployment key; a peer is 403, but a person's token gets `step_run`
  // alone on `/mcp`, plans/apps.md §7.4). `POST /mcp` is the ASSISTANT set
  // (src/ai/assistant-tools.ts): talk to the workflow builder, read its
  // chats, list and run workflows, read runs — seven tools, for an agent with
  // forty others that should not learn strut's YAML. `POST /mcp/builder` is
  // the BUILDER set: the SAME tools the chat's model gets, for an agent that
  // authors workflows itself. With the chat off there is no builder to talk
  // to, so `/mcp` serves the builder set then. The caller is not the UI, so
  // every link is absolute (`publicUrl`, else the request's origin) and an
  // artifact link carries its file token; a `ui` link opens the workflow,
  // run or chat in the UI. A third door, `POST /index/mcp`, is the INDEX
  // role's (above, with its routes): the store's three reads for an agent
  // with no credential.

  if (enableMcp) {
    /** The app door (src/apps/tools.ts): `step_run`, app-only, on BOTH
     *  doors — hidden from a model, callable by a page whose host relays
     *  its tools/call here. The viewer is the connection's actor. */
    const appDoor = async (actor: string | undefined) => {
      const { buildAppTools, APP_TOOL_META } = await import("./apps/tools.js");
      const appTools = buildAppTools({
        apps,
        registry,
        services,
        ...(actor ? { actor } : {}),
        runStepDeps: { store, workspace, claims, onKept: (key, runId) => verifier?.schedule(key, runId) },
        monitor: appMonitor,
      });
      return { appTools, appMeta: APP_TOOL_META };
    };
    /** A VISITOR's door (plans/public-surface.md §5): a public app's page,
     *  hosted with no credential, calls `step_run` here. The identity is the
     *  public view's own (it opens nothing else), every call is held to the
     *  public view after the app's grants (`visitorRefusal`), nothing is
     *  kept, and the step runs against a bag of reads alone: `http`,
     *  `secrets` (for a read a person ticked), the graph's reader held to
     *  visible nodes, the runs held to the public view. Nothing else is on
     *  it, so a step reaching for a write, a shell or a file fails naming
     *  what is missing. */
    app.post("/public/mcp", async (c) => {
      const { buildAppTools, APP_TOOL_META } = await import("./apps/tools.js");
      const { createMcpDoor, toolsetServer } = await import("./ai/mcp.js");
      const bag = services as Record<string, unknown>;
      const reader = publicSurface.reader();
      const visitorBag = {
        ...(bag["http"] ? { http: bag["http"] } : {}),
        ...(bag["secrets"] ? { secrets: bag["secrets"] } : {}),
        ...(graph && reader
          ? {
              graph: {
                kind: graph.kind,
                namespace: graph.namespace,
                cfg: graph.cfg,
                schemas: graph.schemas,
                reader,
                query: () => Promise.reject(new Error("raw graph queries are not available in the public view")),
              },
            }
          : {}),
        ...(bag["runs"] ? { runs: visitorRuns(bag["runs"] as Parameters<typeof visitorRuns>[0]) } : {}),
      };
      const tools = buildAppTools({
        apps,
        registry,
        services: visitorBag,
        runStepDeps: { store, workspace },
        monitor: appMonitor,
        visitor: {
          identity: publicAppOfIdentity,
          refusal: async (at, type, config) => visitorRefusal(await publicSurface.get(), (await apps.versionDir(at.name).catch(() => null))?.version, at, type, config),
          viewer: `visitor ${visitorAddress(c)}`,
        },
      });
      const instructions = "A public app's one tool, step_run, for a visitor's page: reads only, held to this strut server's public view.";
      return createMcpDoor(() => toolsetServer({ tools, instructions, meta: APP_TOOL_META })).handle(c.req.raw);
    });
    /** The builder deps both doors spread: public links, and a run that
     *  outlives the wait window goes on detached, tracked like any launch —
     *  nothing can notify an MCP client, so it polls get_run. */
    const mcpDeps = async (c: Context) => {
      const { MCP_DETACH_HINT } = await import("./ai/mcp.js");
      const publicUrl = publicUrlOf(c);
      const actor = await resolveActor(c);
      const deps = {
        ...builderDeps(actor),
        publicUrl,
        artifactRefs,
        detach: { waitMs: chatRunWaitMs, onDetach: () => {}, hint: MCP_DETACH_HINT },
      };
      return { publicUrl, actor, deps, ...(await appDoor(actor)) };
    };
    /** A PERSON's token on `/mcp` (scope `peer:person`, plans/apps.md §7.4):
     *  `step_run` and nothing else — a person's own strut hosting an app
     *  that lives here relays its page's tools/call through the token it
     *  holds for this strut. The viewer is the token's own subject. A
     *  MEMBER's session gets the same (scope `member`,
     *  plans/member-rights.md): strut's own page relays its app's calls. */
    const personAppHandler = async (c: Context) => {
      const { createMcpDoor, toolsetServer } = await import("./ai/mcp.js");
      const { appTools, appMeta } = await appDoor(await resolveActor(c));
      const instructions = "An app's one tool, step_run, for a page hosted by a person's own strut: every call runs as that person, under the app's grants.";
      return createMcpDoor(() => toolsetServer({ tools: appTools, instructions, meta: appMeta })).handle(c.req.raw);
    };
    const builderHandler = async (c: Context) => {
      // The SDK loads on the first MCP request, never at boot.
      const { createBuilderMcp, builderInstructions } = await import("./ai/mcp.js");
      const { buildSystem } = await import("./ai/prompts.js");
      const { publicUrl, actor, deps, appTools, appMeta } = await mcpDeps(c);
      // The `workflow-builder` prompt is the chat's whole system prompt, the
      // host's section included (StrutOptions.chatSystem — on a graph, the
      // `Workflow Builder` Concept's page), read at each prompts/get: there
      // is no chat to freeze it for, so an edit to the page shows at once.
      // The hook takes a chat id; `mcp` stands in. A throw is one warning,
      // and the prompt is strut's alone, as for a chat turn.
      const prompt = async () => {
        const hostSystem = await Promise.resolve()
          .then(() => chatSystem?.({ chatId: "mcp", turn: 0, ...(actor ? { actor } : {}) }))
          .catch((err) => {
            console.warn(`[mcp] chatSystem hook failed:`, err instanceof Error ? err.message : err);
            return undefined;
          });
        return buildSystem({ ...deps, ...(hostSystem ? { hostSystem } : {}) });
      };
      return createBuilderMcp({ deps, instructions: builderInstructions(publicUrl), prompt, tools: appTools, meta: appMeta }).handle(c.req.raw);
    };
    const assistantHandler = async (c: Context) => {
      const { createMcpDoor, toolsetServer, assistantInstructions } = await import("./ai/mcp.js");
      const { buildAssistantTools } = await import("./ai/assistant-tools.js");
      const { buildTools } = await import("./ai/tools.js");
      const { publicUrl, actor, deps, appTools, appMeta } = await mcpDeps(c);
      const tools = buildAssistantTools({
        workspace,
        store,
        chatStore,
        chat: assistantDoor!,
        automations,
        publicUrl,
        artifactRefs,
        listFiles: async (runId, job) => (job ? ((await jobIndex.get(job))?.files ?? []) : artifacts ? artifacts.list(runId) : []),
        runWorkflow: buildTools(deps)["run_workflow"]!,
        ...(actor ? { actor } : {}),
        packages: (services as Record<string, unknown>)["packages"] as PackagesCapability,
      });
      return createMcpDoor(() => toolsetServer({ tools: { ...tools, ...appTools }, instructions: assistantInstructions(publicUrl), meta: appMeta })).handle(c.req.raw);
    };
    app.post("/mcp/builder", builderHandler);
    app.post("/mcp", async (c) =>
      ["peer:person", "member"].includes(await scopeOf(c)) ? personAppHandler(c) : assistantDoor ? assistantHandler(c) : builderHandler(c),
    );
    // Stateless: no SSE stream to open, no session to end.
    const notAllowed = (c: Context) => c.json({ error: "method not allowed: /mcp takes POST (JSON-RPC over HTTP, stateless)" }, 405);
    for (const path of ["/mcp", "/mcp/builder", "/public/mcp"]) {
      app.get(path, notAllowed);
      app.delete(path, notAllowed);
    }
  }

  // ── LLM model catalog ────────────────────────────────────────────────────
  //
  // Feeds the chat flyout's model picker, Jamie's (through `llm/models`)
  // and the step editor's `model` suggestions: every model aieo knows, each
  // with its context window, its price and whether people may pick it — the
  // host's list (`STRUT_MODELS`) when it sets one, else a key in the secret
  // store or env, never the values — and the deployment's default chat
  // model (`STRUT_DEFAULT_MODEL`, else `chatModel`) in canonical
  // "provider/id" form.

  app.get("/llm/models", async (c) => {
    try {
      return c.json(await llmModels());
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ── Health ───────────────────────────────────────────────────────────────

  // Open to a probe (a container healthcheck has no key), which learns
  // nothing but that the process answers. With the key: where the data is,
  // how many steps loaded, and which backend holds the workspace — `fs`,
  // `neo4j`, or `ladybug` with the file's path (plans/ladybug-backend.md).
  app.get("/health", (c) => {
    if (!carriesApiKey(c)) return c.json({ ok: true });
    const wg = workspace.graph;
    const draining = drain.current();
    return c.json({
      ok: true,
      dataDir,
      stepCount: Object.keys(registry).length,
      workspace: { backend: wg?.kind ?? "fs", ...(wg?.kind === "ladybug" ? { path: wg.cfg.path } : {}) },
      ...(draining ? { drain: { ...draining, idle: drainView().idle } } : {}),
    });
  });

  // ── Drain (src/drain.ts) ─────────────────────────────────────────────────

  // What an updater or a backup turns on before it restarts this process:
  // nothing new starts, what runs finishes, and `idle` says when nothing is
  // left. A paused run waits on a person, not on the process, so it is not
  // waited on (a restart leaves it paused). The writes are a person's or
  // the deployment's: a peer's credential is refused by the gate.
  function drainView() {
    const state = drain.current();
    const running = [...controllers.values()].filter((ctl) => ctl.state !== "paused");
    const chats = liveChats();
    return {
      draining: !!state,
      ...(state ?? {}),
      idle: running.length === 0 && chats.length === 0,
      active: { runs: running.length, chats: chats.length },
      // The top-level runs it waits on (the first 50), so a person sees what.
      runs: running
        .filter((ctl) => !ctl.parent)
        .slice(0, 50)
        .map((ctl) => ({ workflow: ctl.workflow, runId: ctl.runId, state: ctl.state })),
    };
  }
  app.get("/drain", (c) => c.json(drainView()));
  app.put("/drain", async (c) => {
    const parsed = parseDrainBody(await c.req.json().catch(() => ({})));
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    const state = drain.set(parsed);
    console.log(`[drain] on: ${state.reason}${state.until ? ` (until ${state.until})` : ""}`);
    return c.json(drainView());
  });
  app.delete("/drain", (c) => {
    if (drain.lift()) console.log("[drain] lifted");
    return c.json(drainView());
  });

  // ── Speech, both ways (src/audio) ──────────────────────────────────────

  // Dictation's vocabulary, from the workspace graph. A graph that is not a
  // Ladybug one keeps none: the transcript goes out as heard, no fixer run.
  if (stt) {
    const ctx = { services } as unknown as StepContext;
    audioRoutes(app, stt, { lexicon: async () => (onLadybug(ctx) ? readLexicon(ctx) : undefined) });
  }
  if (tts) speakRoutes(app, tts);
  if (homeRole === "box") homeSyncRoutes(app, { services, scopeOf });
  voiceRoutes(app, { voice, resolveActor });

  // ── Static files (web UI) ────────────────────────────────────────────────

  if (serveUi) {
    app.use("/assets/*", serveStatic({ root: webDist }));
    app.use("/favicon.ico", serveStatic({ root: webDist }));

    // On an index strut the UI's root is the STORE FRONT for anyone who
    // arrives with no credential (`?store=1`, web/src/components/Store.tsx:
    // the page over the three open reads above). The operator's shell is
    // one `?key=` or a signed-in session away, as before.
    if (index) {
      app.get("/", async (c, next) => {
        // A page meant alone (`?solo=1`: a visitor's public app, a file) is
        // served as asked: the store frames this server's own public apps.
        if (c.req.query("store") !== undefined || c.req.query("solo") === "1" || carriesApiKey(c) || carriesPeerKey(c)) return next();
        const q = new URLSearchParams(c.req.query());
        q.set("store", "1");
        return c.redirect(`./?${q.toString()}`, 302);
      });
    }

    app.get("*", async (c, next) => {
      const path = c.req.path;
      // API prefixes fall through — to a route a host mounted after
      // construction (e.g. createMothership's `/llm/delegations`), else 404.
      if (
        path.startsWith("/workflows") ||
        path.startsWith("/steps") ||
        path.startsWith("/chat") ||
        path.startsWith("/health") ||
        path.startsWith("/llm") ||
        path.startsWith("/audio")
      ) {
        return next();
      }
      try {
        const html = await readFile(join(webDist, "index.html"), "utf-8");
        return c.html(html);
      } catch {
        return c.text("UI not built. Run: cd web && npm run build", 404);
      }
    });

    // `app/look`'s page (BrowserService `lookAtApp`): this UI hosting an
    // app, every request it makes answered here, in process, as the run's
    // actor — the browser needs no address for strut and holds no key.
    const browser = (services as Record<string, unknown>)["browser"];
    if (browser instanceof BrowserService) browser.serveStrut(async (req, actor) => app.fetch(inProcessRequest(req, actor)), channelSocketInProcess);
  }

  // ── Programmatic run helper ──────────────────────────────────────────────

  async function run(
    workflow: string | Flow,
    input: unknown = {},
    runOpts?: StrutRunOptions<TServices>,
  ): Promise<RunResult> {
    const flow =
      typeof workflow === "string"
        ? runOpts?.version
          ? await workspace.getWorkflowVersion(workflow, runOpts.version)
          : await workspace.getWorkflow(workflow)
        : workflow;
    await assertWorkflowEnabled(workspace, flow.name);

    // Generate the runId here (rather than letting runWorkflow default it) so
    // the run can be registered as in-flight — otherwise nested runs (e.g. the
    // optimizer capability's generation runs) list as "stale" while running.
    const runId = runOpts?.runId ?? generateRunId();
    // Tree linkage (RUN_CONTROL_SPEC §2.2): `parentRunId` (the calling
    // step's ctx.runId — set by e.g. the lab's optimizer capability) attaches
    // this run's controller under the launching run's.
    const { controller, untrack } = trackRun(
      flow.name,
      runId,
      runOpts?.parentRunId,
      runOpts?.job ? { id: runOpts.job, ...(runOpts.title ? { title: runOpts.title } : {}) } : undefined,
    );
    try {
      const workflowHash =
        typeof workflow === "string"
          ? ((await workspace.getWorkflowHash(workflow, runOpts?.version)) ?? undefined)
          : undefined;
      const stepHashes = await stepHashesFor(workspace, flow);
      const principal = runOpts?.principal ?? (await principalFor(flow.name, runOpts?.actor));
      return await runWorkflow(flow, input, registry, {
        runId,
        store,
        workspace,
        services: runOpts?.services ?? services,
        params: runOpts?.params,
        paramOverrides: runOpts?.paramOverrides,
        onEvent: runOpts?.onEvent,
        controller,
        ...(workflowHash ? { workflowHash } : {}),
        ...(stepHashes ? { stepHashes } : {}),
        ...(runOpts?.actor ? { actor: runOpts.actor } : {}),
        ...(principal ? { principal } : {}),
        ...(runOpts?.job ? { job: runOpts.job } : {}),
        ...(runOpts?.job && runOpts.title ? { title: runOpts.title } : {}),
        ...(runOpts?.mcp?.length ? { mcp: runOpts.mcp } : {}),
      });
    } finally {
      untrack();
    }
  }

  // ── Listener ─────────────────────────────────────────────────────────────

  let httpServer: import("node:http").Server | null = null;

  async function listen(port?: number, host?: string): Promise<number> {
    warnIfUnconfigured();
    const requested = port ?? parseInt(bootEnv()["STRUT_PORT"] ?? "3000", 10);
    const hostname = host ?? bootEnv()["STRUT_HOST"] ?? undefined;
    console.log(
      fileBacked
        ? `strut workspace: ${dataDir}`
        : `strut workspace: ${workspace.constructor.name} (data dir: ${dataDir})`,
    );
    console.log(`strut steps: ${Object.keys(registry).length} registered`);
    const server = serve({ fetch: app.fetch, port: requested, ...(hostname ? { hostname } : {}) }) as unknown as import("node:http").Server;
    httpServer = server;
    // The sockets upgrade on the Node server, not inside Hono: a room, then
    // dictation; anything else is a 404, never a socket left hanging open.
    const audio = stt ? createAudioUpgradeHandler(stt) : null;
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (upgrade(req, socket, head) || audio?.handle(req, socket, head)) return;
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
    });
    // Resolve on the *bound* port (requested may be 0) — and surface a bind
    // failure (EADDRINUSE etc.) as a rejection instead of an unhandled error.
    const bound = await new Promise<number>((resolvePort, reject) => {
      const onError = (e: Error) => reject(e);
      server.once("error", onError);
      const done = () => {
        server.off("error", onError);
        const addr = server.address();
        resolvePort(addr && typeof addr === "object" ? addr.port : requested);
      };
      if (server.listening) done();
      else server.once("listening", done);
    });
    console.log(`strut server: http://${hostname ?? "localhost"}:${bound}`);
    // Structured ready line for a host that spawned us (desktop app): one
    // JSON object on its own stdout line, after the human ones.
    const readyKey = bootEnv()["STRUT_READY_KEY"] ? bootEnv()["STRUT_API_KEY"] : undefined;
    console.log(JSON.stringify({ event: "ready", port: bound, host: hostname ?? "0.0.0.0", ...(readyKey ? { key: readyKey } : {}) }));
    // Dictation's fixer loads now, in its worker, so the first transcript is fixed too.
    void stt?.fixer.warm();
    // A strut with a voice service fetches and loads the speech its calls
    // use now, so the first call does not wait for a download (src/voice.ts).
    if (voice) void warmSpeech({ stt, tts });
    return bound;
  }

  /** The boot scan (below): a closed strut neither starts it nor leaves it
   *  writing into its data dir (`boot.json`) after `close()`. */
  let bootTimer: ReturnType<typeof setTimeout> | undefined;
  let bootScan: Promise<unknown> | undefined;

  async function close(): Promise<void> {
    if (bootTimer) clearTimeout(bootTimer);
    bootTimer = undefined;
    await bootScan;
    await packages.booted;
    automations.stop();
    // Every feed read still waiting answers now (plans/live-feeds.md).
    graphChanges?.close();
    proposalChanges.close();
    wakeJobFeeds(dataDir);
    for (const t of subscriptionTimers) clearTimeout(t);
    // The browser connection, when strut built it: every run's context goes with it.
    await ownBrowser?.close();
    await ownStt?.close();
    await ownTts?.close();
    // What the sink still holds goes out before the process does.
    await ownSink?.close();
    // And the apps' usage counted since the last write.
    await appMonitor.close();
    // A room's sockets close with the server; their rooms queue what follows.
    for (const ws of roomsWss.clients) ws.terminate();
    // A channel's sockets too; the channels are memory, and go with the process.
    for (const ws of channelsWss.clients) ws.terminate();
    channels.close();
    const s = httpServer;
    if (!s) return;
    httpServer = null;
    if (!s.listening) return; // bind failed or already closed
    await new Promise<void>((resolveClose, reject) => {
      s.close((e) => (e ? reject(e) : resolveClose()));
      s.closeAllConnections?.();
    });
  }

  // Boot-time auto-resume (§5.3): on by default whenever the RUN STORE
  // outlives the process — anything but `MemoryRunStore`, which cannot hold
  // a cut-off run — off with `STRUT_AUTO_RESUME=0` or `autoResume: false`.
  // The gate is the run store, not the workspace: the lab host keeps its
  // workflows in the graph and its runs in a `FileRunStore`, and gating on
  // the workspace's kind left every graph-backed swarm without auto-resume
  // (2026-10-01, swarm38: a container update cut a run off, hive declared it
  // lost 10 s later, and a human resumed it by hand). The builder's chats
  // the same way, gated on the chat store (`reconcileStaleChat`). Deferred
  // and unref'd so a host that constructs strut and exits (tests, CLIs) is
  // never held open.
  // The runs scan looks at every run cut off since the PREVIOUS process
  // started — the runs its death cut off, however many — read from
  // `<dataDir>/boot.json`; this process's start is written there once the
  // scan is done, so a process that dies before its scan leaves the record
  // as it was and the next boot still looks at the same runs. No record
  // (the first boot): the newest root run of each workflow only.
  const bootResumeRuns = async () => {
    const file = join(dataDir, "boot.json");
    let since: number | undefined;
    try {
      const { startedAt } = JSON.parse(await readFile(file, "utf-8")) as { startedAt?: unknown };
      const t = typeof startedAt === "string" ? Date.parse(startedAt) : NaN;
      if (Number.isFinite(t)) since = t;
    } catch {
      // never written, or unreadable: newest only
    }
    await autoResumeStaleRuns({ ...(since !== undefined ? { since } : {}), ...autoResumeOpts });
    // The wakes a dead process left: after the scan, so a wake turn it
    // resumed is live and waited on (src/wake.ts).
    await wakes.reconcile().catch((err) => console.error(`[wake] boot reconcile failed:`, err));
    try {
      await mkdir(dataDir, { recursive: true });
      await writeFile(file, JSON.stringify({ startedAt: new Date(bootedAt).toISOString() }) + "\n", "utf-8");
    } catch (err) {
      console.warn(`[auto-resume] could not record this boot in ${file}:`, err);
    }
  };
  // The first-boot installs (src/packages/boot.ts), last: after the seeds
  // (strut/views an app may import, the Concept roots a page may hang
  // under) and in the background, so a catalog that does not answer never
  // holds or fails the boot. `close()` waits for them.
  if (bootPackages.length) {
    if (registryWasInjected) console.warn(`[packages] not installing ${bootPackages.map((p) => p.ref).join(", ")} at boot: installing is disabled when the registry is provided at construction time`);
    else
      packages.booted = installBootPackages(bootPackages, {
        installed: async () => (await listInstalledPackages(packageDeps)).map((p) => p.package),
        install: (ref, o) => packages.install(ref, o),
      });
  }

  if (autoResumeRuns || autoResumeChats) {
    bootTimer = setTimeout(() => {
      bootTimer = undefined;
      bootScan = Promise.all([
        autoResumeRuns ? bootResumeRuns().catch((err) => console.error(`[auto-resume] scan failed:`, err)) : undefined,
        autoResumeChats ? autoResumeStaleChats(autoResumeOpts).catch((err) => console.error(`[auto-resume] chat scan failed:`, err)) : undefined,
      ]);
    }, autoResumeOpts.delayMs ?? 3000);
    bootTimer.unref?.();
  }

  return {
    app,
    workspace,
    dataDir,
    store,
    secretStore,
    sessionStore,
    services,
    getRegistry: () => registry,
    rebuildRegistry,
    autoResumeStaleRuns,
    autoResumeStaleChats,
    reconcileClaims,
    run,
    apps,
    appMonitor,
    stt,
    tts,
    upgrade,
    channels,
    automations,
    packages,
    subscriptions,
    index,
    indexes,
    claims,
    verifier,
    listen,
    close,
  };
}

/** Does an `If-None-Match` header name this ETag? (`*`, a list, weak or strong.) */
function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const bare = (t: string) => t.trim().replace(/^W\//, "");
  return ifNoneMatch.split(",").some((t) => t.trim() === "*" || bare(t) === bare(etag));
}

/**
 * Response headers for an artifact. A step or an agent wrote the file, and it
 * is served from strut's own origin, where the UI keeps the API key.
 * `sandbox`: opened as a document (a new tab, a frame) it gets an opaque
 * origin, so it cannot read the UI's storage, navigate the top window, open
 * a popup, submit a form, or send its URL as a referrer. An HTML page also
 * gets `allow-scripts` — never `allow-same-origin` — when the request was
 * opened by a FILE TOKEN (`tokenRead`): then a page an agent built can run,
 * because a script can read its own URL, and all it finds there is that
 * token (auth.ts), worth the files the page already shows. A request the
 * key let in, or a host's gate did, may carry that credential in its URL
 * (`?key=`, a host's own `?key=<jwt>`), so it runs no script. Everything
 * else runs no script either (an `.svg` opened as a document could).
 * `nosniff`: the browser never reads a file as a type the map did not say.
 * Sandboxed unless exempt, so a type added to the map is sandboxed too. The
 * one exemption is video and audio: they cannot script, and the player a
 * browser builds for one in its own tab cannot load the file from an opaque
 * origin. `access-control-allow-origin: *`: a page's script can `fetch` a
 * sibling file (its data) from its opaque origin — the token in the URL
 * gates the read, not the origin.
 */
function artifactHeaders(path: string, tokenRead = false): Record<string, string> {
  const type = contentTypeFor(path);
  const headers: Record<string, string> = {
    "content-type": type,
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "*",
  };
  if (type.startsWith("text/html") && tokenRead) headers["content-security-policy"] = "sandbox allow-scripts";
  else if (!/^(video|audio)\//.test(type)) headers["content-security-policy"] = "sandbox";
  return headers;
}

/** Minimal content-type map for serving artifacts; octet-stream otherwise. */
function contentTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    json: "application/json",
    txt: "text/plain; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    csv: "text/csv; charset=utf-8",
    html: "text/html; charset=utf-8",
    yaml: "text/yaml; charset=utf-8",
    yml: "text/yaml; charset=utf-8",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    svg: "image/svg+xml",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    ogg: "audio/ogg",
    vtt: "text/vtt; charset=utf-8",
  };
  return map[ext] ?? "application/octet-stream";
}

/**
 * One agent stream part → the chat event it persists as (null = not logged).
 * A generator tool's intermediate yields arrive as PRELIMINARY tool-results
 * (graph_walk's hops) and become `tool-progress`; only the last yield is the
 * tool's `tool-output`, and only it reaches messages.jsonl. A step's end
 * carries the context it left behind (`ChatContext`) when the provider
 * reported usage and the model's window is known.
 */
export function chatEventOf(
  part: {
    type: string;
    text?: string;
    toolName?: string;
    toolCallId?: string;
    input?: unknown;
    output?: unknown;
    error?: unknown;
    preliminary?: boolean;
    usage?: { inputTokens?: number; outputTokens?: number };
  },
  contextLimit?: number,
): (Partial<ChatEvent> & { type: ChatEvent["type"] }) | null {
  switch (part.type) {
    case "text-delta":
      return part.text ? { type: "text-delta", delta: part.text } : null;
    case "tool-call":
      return { type: "tool-input", toolName: part.toolName, toolCallId: part.toolCallId, input: part.input };
    case "tool-result":
      return {
        type: part.preliminary ? "tool-progress" : "tool-output",
        toolName: part.toolName,
        toolCallId: part.toolCallId,
        output: part.output,
      };
    case "tool-error":
      return {
        type: "tool-output",
        toolName: part.toolName,
        toolCallId: part.toolCallId,
        output: part.error instanceof Error ? part.error.message : String(part.error),
        isError: true,
      };
    case "finish-step": {
      const input = part.usage?.inputTokens;
      return typeof input === "number" && contextLimit
        ? { type: "step.finish", context: { used: input + (part.usage?.outputTokens ?? 0), limit: contextLimit } }
        : { type: "step.finish" };
    }
    default:
      return null;
  }
}
