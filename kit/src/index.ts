/** `@strut/kit` (plans/apps.md §3): the hooks over one tool, `step_run`, the
 *  provider they run under, the client and host contracts an app's bridge
 *  implements and a host's own page supplies, and the folds (also alone as
 *  `@strut/kit/folds`, for a page with no React). React, react-dom and
 *  react-query are peers. The bootstrap — the bridge itself — is
 *  `@strut/kit/bootstrap`; Node-side helpers for the app build are
 *  `@strut/kit/node`. */
export {
  STEP_RUN_TOOL, REPORT_ERROR_STEP, LAUNCH_TIMEOUT_MS, StrutError, appOfToken, createBridgeClient, unwrapToolResult, PUBLIC_VIEW_META, isPublicView, SERVER_NAME_META, serverName, PUBLIC_RUNNABLE_META, publicRunnable, publicRunnableItems, paymentRequiredOf,
  type AppIdentity, type PaymentRequired, type PublicResults, type StrutClient, type ToolCaller, type ToolResult,
} from "./client.js";
export {
  BridgeHost, StaticHost, createStaticHost, DEFAULT_HOST_STATE,
  type BridgeApp, type DisplayMode, type HostContext, type HostState, type StrutHost, type Theme,
} from "./host.js";
export { StrutProvider, createKitQueryClient, useStrutClient, useStrutHost, useStrutWallet, useStrutChannels, useStrutVisitor, useStrutAccount, useStrutCamera, type StrutProviderProps } from "./provider.js";
export { useWallet, useTransaction, TRANSACTION_POLL_MS, type UseWallet, type UseTransaction } from "./wallet-hooks.js";
export * from "./wallet/index.js";
export { useChannel, newChannel, type UseChannel, type UseChannelOptions } from "./channel-hooks.js";
export * from "./channels/index.js";
export { useVisitor, useAccountWidget, type UseVisitor, type UseAccountWidget } from "./visitor-hooks.js";
export * from "./visitor/index.js";
export { useCamera, type UseCamera } from "./camera-hooks.js";
export * from "./camera/index.js";
export {
  RUN_STEPS, JOB_STEPS, LIVE_INTERVAL_MS, RUN_WAIT_MS, RUN_EVENTS_MAX, runKeys, isInFlight, anyInFlight, eventsSettled, fileData,
  useRuns, useRun, useRunEvents, useWorkProducts, useTranscript, useTranscripts, useRunFile, useRunFileUrl, runFileBlob, useLaunch, useUpload, useCancel, useWorkflow, useStep, useToolInput, useAppLink, useShareLink, useHost, useApp, useLocale, useWords, useFormats,
  useNames, PEOPLE_NAMES_STEP,
  useSql, useSqlMutation, SQL_STEPS, type SqlRows, type SqlStatement, type UseSqlOptions, type UseSqlMutation,
  useAssistant, assistantJobs, ASSISTANT_WORKFLOW,
  useJobUpdates, useGraphChanges, GRAPH_CHANGES_STEP, FEED_WAIT_MS,
  useTask, useWorker, useTaskHistory, useWithdraw, useTaskFile, useTaskFileUrl, taskErrorCode, TASK_STEPS, TASK_WAIT_S,
  type WorkerTask, type TaskAttachmentRule, type WorkerInfo, type WorkerType, type WorkerHistoryItem, type WorkerTaskGroup, type TaskReply, type TaskReplyFile, type WorkerBalance, type WorkerPayout, type WorkerPayoutOut, type WithdrawResult, type UseWithdraw, type UseTask, type UseTaskOptions, type TaskHookStatus,
  useAppState, APP_STATE_STEP, APP_STATE_WRITE_MS, reloadAppState,
  type JobUpdate, type GraphChange, type UseJobUpdates, type UseJobUpdatesOptions, type UseGraphChanges, type UseGraphChangesOptions,
  type AssistantMessage, type AssistantJob, type UseAssistant, type UseAssistantOptions,
  type RunSummary, type RunEvent, type RunTranscript, type RunFile, type UseRunFileOptions, type UseRunFileUrl, type WorkflowInfo, type LaunchResult, type UploadResult,
  type UseRunsOptions, type UseRunOptions, type UseRunEventsOptions, type UseWorkProducts, type UseTranscriptOptions, type UseLaunch, type UseLaunchOptions, type UseUpload, type UseCancel, type UseStep, type UseHost,
} from "./hooks.js";
export {
  ErrorBoundary, createErrorReporter, installWindowErrorReporting, toErrorReport,
  type ErrorBoundaryProps, type ErrorReport, type ErrorReporter,
} from "./error-boundary.js";
export { appLink, shareLink, PAGE_CONTEXT, type AppLinkInput } from "./links.js";
export { applyHostContext } from "./apply-host-context.js";
export * from "./folds/index.js";
export * from "./folds/run-graph/layout.js";
