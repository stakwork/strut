import { Component, createElement, type ErrorInfo, type ReactNode } from "react";
import { REPORT_ERROR_STEP, type StrutClient } from "./client.js";

export interface ErrorReport {
  message: string;
  stack?: string;
  componentStack?: string;
}

/** What a report sends: `app/report-error { message, stack?, componentStack? }`. */
export function toErrorReport(error: unknown, componentStack?: string): ErrorReport {
  const e = error as { message?: unknown; stack?: unknown } | null;
  const message =
    e && typeof e === "object" && typeof e.message === "string" ? e.message
    : typeof error === "string" ? error
    : String(error);
  const report: ErrorReport = { message };
  if (e && typeof e === "object" && typeof e.stack === "string") report.stack = e.stack;
  if (componentStack) report.componentStack = componentStack;
  return report;
}

export type ErrorReporter = (error: unknown, componentStack?: string) => void;

/** Turns a failure into ONE `app/report-error` call through the client (§8):
 *  the same message and stack are reported once a page, at most `max` reports
 *  a page, and the report itself never throws or reports its own failure. */
export function createErrorReporter(client: StrutClient, { max = 20 }: { max?: number } = {}): ErrorReporter {
  const seen = new Set<string>();
  return (error, componentStack) => {
    const report = toErrorReport(error, componentStack);
    const id = `${report.message}\n${report.stack ?? ""}`;
    if (seen.has(id) || seen.size >= max) return;
    seen.add(id);
    void client.run(REPORT_ERROR_STEP, { ...report }).catch(() => undefined);
  };
}

/** `window.onerror` and unhandled rejections → the reporter. Returns the uninstaller. */
export function installWindowErrorReporting(reporter: ErrorReporter, target: Window = window): () => void {
  const onError = (e: ErrorEvent) => reporter(e.error ?? e.message);
  const onRejection = (e: PromiseRejectionEvent) => reporter(e.reason);
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}

export interface ErrorBoundaryProps {
  onError?: ErrorReporter;
  fallback?: (error: Error, reset: () => void) => ReactNode;
  children?: ReactNode;
}

/** Catches a render failure below it: reports it (`onError`), shows the
 *  fallback — a short notice naming the error, since a blank frame tells the
 *  person nothing — and never lets the page go white. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info.componentStack ?? undefined);
  }
  reset = () => this.setState({ error: null });
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return createElement(
      "div",
      { role: "alert", className: "strut-error m-4 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-foreground" },
      createElement("p", { className: "font-medium" }, "This app hit an error."),
      createElement("pre", { className: "mt-2 overflow-auto whitespace-pre-wrap font-mono text-xs text-muted-foreground" }, error.message),
    );
  }
}
