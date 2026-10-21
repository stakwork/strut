/** `@strut/kit` (plans/apps.md §3): the hooks over one tool, `step_run`, the
 *  provider they run under, the client and host contracts an app's bridge
 *  implements and a host's own page supplies, and the folds (also alone as
 *  `@strut/kit/folds`, for a page with no React). React, react-dom and
 *  react-query are peers. The bootstrap — the bridge itself — is
 *  `@strut/kit/bootstrap`; Node-side helpers for the app build are
 *  `@strut/kit/node`. */
export {
  STEP_RUN_TOOL, REPORT_ERROR_STEP, StrutError, createBridgeClient, unwrapToolResult,
  type StrutClient, type ToolCaller, type ToolResult,
} from "./client.js";
export {
  BridgeHost, StaticHost, createStaticHost, DEFAULT_HOST_STATE,
  type BridgeApp, type DisplayMode, type HostContext, type HostState, type StrutHost, type Theme,
} from "./host.js";
export { StrutProvider, createKitQueryClient, useStrutClient, useStrutHost, type StrutProviderProps } from "./provider.js";
export {
  RUN_STEPS, LIVE_INTERVAL_MS, RUN_WAIT_MS, runKeys, isInFlight, anyInFlight, eventsSettled,
  useRuns, useRun, useRunEvents, useLaunch, useCancel, useWorkflow, useStep, useToolInput, useHost,
  type RunSummary, type RunEvent, type WorkflowInfo, type LaunchResult,
  type UseRunsOptions, type UseRunOptions, type UseRunEventsOptions, type UseLaunch, type UseCancel, type UseStep, type UseHost,
} from "./hooks.js";
export {
  ErrorBoundary, createErrorReporter, installWindowErrorReporting, toErrorReport,
  type ErrorBoundaryProps, type ErrorReport, type ErrorReporter,
} from "./error-boundary.js";
export { applyHostContext } from "./apply-host-context.js";
export * from "./folds/index.js";
