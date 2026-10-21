/** The kit's BOOTSTRAP (plans/apps.md §2.4) — what the app build puts before
 *  the app bundle in the served document. It connects the MCP Apps client
 *  (`@modelcontextprotocol/ext-apps`: never a hand-rolled postMessage), which
 *  sends `ui/initialize`; applies the host context to the document; reads the
 *  app's file token off the `<meta>` the file route wrote (§7.2); mounts
 *  `<StrutProvider><ErrorBoundary><App/></ErrorBoundary></StrutProvider>`;
 *  reports its size (`ui/notifications/size-changed`, the SDK's observer);
 *  and turns a render failure or a `window.onerror` into `app/report-error`. */
import { App, type AppOptions } from "@modelcontextprotocol/ext-apps";
import { createElement, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { QueryClient } from "@tanstack/react-query";
import { applyHostContext } from "./apply-host-context.js";
import { createBridgeClient, type StrutClient } from "./client.js";
import { ErrorBoundary, createErrorReporter, installWindowErrorReporting, type ErrorReporter } from "./error-boundary.js";
import { BridgeHost } from "./host.js";
import { StrutProvider } from "./provider.js";

/** The bridge transport the SDK's `App` connects over (`PostMessageTransport` by default). */
export type Transport = NonNullable<Parameters<App["connect"]>[0]>;

/** The `<meta name>` the served document carries the app's file token in. */
export const TOKEN_META = "strut-app-token";

/** The file token off the document's `<meta name="strut-app-token">`. */
export function readToken(doc: Document = document): string | undefined {
  const content = doc.querySelector(`meta[name="${TOKEN_META}"]`)?.getAttribute("content");
  return content || undefined;
}

export interface BootstrapOptions {
  /** What `ui/initialize` names the app as. */
  appInfo?: { name: string; version: string };
  /** The document to mount into (the page's by default). */
  document?: Document;
  /** Where to mount: `#root` (created when missing). */
  root?: HTMLElement;
  /** The bridge transport: `PostMessageTransport(window.parent)` by default. */
  transport?: Transport;
  /** How long to wait for the host's `ui/initialize` answer. */
  connectTimeoutMs?: number;
  /** The file token; read from the `<meta>` when omitted. */
  token?: string;
  queryClient?: QueryClient;
  /** Report errors here as well as through `app/report-error`. */
  onError?: ErrorReporter;
  /** Passed to the SDK's `App` (size reports are the bootstrap's to start and stop). */
  appOptions?: Omit<AppOptions, "autoResize">;
}

export interface Mounted {
  app: App;
  client: StrutClient;
  host: BridgeHost;
  reactRoot: Root;
  /** Whether the host answered `ui/initialize`; a page opened with no host
   *  mounts anyway, and its calls fail. */
  connected: boolean;
  /** Unmount the app and close the bridge. */
  unmount(): Promise<void>;
}

/** Connect, apply, mount, report. Resolves once the app is rendered. */
export async function bootstrap(AppComponent: ComponentType, options: BootstrapOptions = {}): Promise<Mounted> {
  const doc = options.document ?? document;
  const token = options.token ?? readToken(doc);
  const app = new App(options.appInfo ?? { name: "strut-app", version: "0" }, {}, { ...options.appOptions, autoResize: false });
  const host = new BridgeHost(app);
  const client = createBridgeClient(app, token);
  const report = createErrorReporter(client);
  const reporter: ErrorReporter = (error, componentStack) => {
    report(error, componentStack);
    options.onError?.(error, componentStack);
  };
  const uninstall = installWindowErrorReporting(reporter, doc.defaultView ?? window);
  host.subscribe(() => applyHostContext(host.getState().context, doc));

  let connected = false;
  let stopSizeReports = () => {};
  try {
    await app.connect(options.transport, { timeout: options.connectTimeoutMs ?? 15_000 });
    host.connected();
    connected = true;
    // The SDK's observer: `ui/notifications/size-changed` now and on every resize.
    stopSizeReports = app.setupSizeChangedNotifications();
  } catch (error) {
    console.warn("[strut] no MCP Apps host answered ui/initialize; mounting without one", error);
  }

  const container = options.root ?? doc.getElementById("root") ?? doc.body.appendChild(Object.assign(doc.createElement("div"), { id: "root" }));
  const reactRoot = createRoot(container);
  reactRoot.render(
    createElement(
      StrutProvider,
      { client, host, queryClient: options.queryClient },
      createElement(ErrorBoundary, { onError: reporter }, createElement(AppComponent)),
    ),
  );

  return {
    app, client, host, reactRoot, connected,
    async unmount() {
      stopSizeReports();
      uninstall();
      reactRoot.unmount();
      await app.close().catch(() => undefined);
    },
  };
}
