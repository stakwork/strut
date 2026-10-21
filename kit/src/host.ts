/** The HOST behind the page (plans/apps.md §7.1): what `ui/initialize`
 *  handed the app (theme, display mode, locale, time zone), what the model or
 *  a link opened it with (`ui/notifications/tool-input`), and the two
 *  requests the page may make of its host — `ui/message` and `ui/open-link`.
 *  In an app the host is the MCP Apps bridge (`BridgeHost`); a host's own
 *  page supplies one (`createStaticHost`), as it supplies the client. */

export type Theme = "light" | "dark";
export type DisplayMode = "inline" | "fullscreen" | "pip";

/** The host context the kit reads — MCP Apps' `McpUiHostContext`, open to
 *  whatever else the host sends. */
export interface HostContext {
  theme?: Theme;
  displayMode?: DisplayMode;
  availableDisplayModes?: DisplayMode[];
  locale?: string;
  timeZone?: string;
  styles?: { variables?: Record<string, string | undefined>; css?: { fonts?: string } };
  [k: string]: unknown;
}

export interface HostState {
  /** `ui/initialize` answered. */
  connected: boolean;
  theme: Theme;
  displayMode: DisplayMode;
  availableDisplayModes: DisplayMode[];
  locale?: string;
  timeZone?: string;
  /** The latest `ui/notifications/tool-input` arguments. */
  toolInput?: Record<string, unknown>;
  /** The host context as last merged. */
  context: HostContext;
}

export interface StrutHost {
  getState(): HostState;
  subscribe(listener: () => void): () => void;
  /** A message to the host's conversation (`ui/message`). */
  sendMessage(text: string): Promise<void>;
  /** A link the host opens (`ui/open-link`). */
  openLink(url: string): Promise<void>;
  /** Ask for another display mode; resolves to the one granted. */
  requestDisplayMode(mode: DisplayMode): Promise<DisplayMode>;
}

export const DEFAULT_HOST_STATE: HostState = {
  connected: false,
  theme: "light",
  displayMode: "inline",
  availableDisplayModes: ["inline"],
  context: {},
};

/** The slice of the MCP Apps `App` a `BridgeHost` drives. The callback
 *  parameters are `any` because the SDK's `McpUiStyles` is a record that
 *  REQUIRES every variable key, which no host context carries whole. */
export interface BridgeApp {
  getHostContext(): HostContext | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  set onhostcontextchanged(cb: ((params: any) => void) | undefined);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  set ontoolinput(cb: ((params: any) => void) | undefined);
  sendMessage(params: { role: "user"; content: Array<{ type: "text"; text: string }> }): Promise<unknown>;
  openLink(params: { url: string }): Promise<unknown>;
  requestDisplayMode(params: { mode: DisplayMode }): Promise<{ mode: DisplayMode }>;
}

/** A host store: one state, listeners, and a merge. */
class HostStore {
  protected state: HostState;
  private listeners = new Set<() => void>();
  constructor(initial?: Partial<HostState>) {
    this.state = { ...DEFAULT_HOST_STATE, ...initial };
  }
  getState = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  protected set(patch: Partial<HostState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
  /** Merge a host context (initial or changed) into the state. */
  applyContext(ctx: HostContext | undefined, connected = this.state.connected) {
    const context = { ...this.state.context, ...(ctx ?? {}) };
    this.set({
      connected,
      context,
      theme: context.theme ?? this.state.theme,
      displayMode: context.displayMode ?? this.state.displayMode,
      availableDisplayModes: context.availableDisplayModes ?? this.state.availableDisplayModes,
      locale: context.locale ?? this.state.locale,
      timeZone: context.timeZone ?? this.state.timeZone,
    });
  }
  setToolInput(args: Record<string, unknown> | undefined) {
    this.set({ toolInput: args });
  }
}

/** The bridge: host state fed by the MCP Apps `App`'s notifications, the
 *  requests sent through it. Construct BEFORE `app.connect()`, so a
 *  `tool-input` that arrives with the handshake is kept. */
export class BridgeHost extends HostStore implements StrutHost {
  constructor(private readonly app: BridgeApp) {
    super();
    app.onhostcontextchanged = (ctx: HostContext) => this.applyContext(ctx);
    app.ontoolinput = (params: { arguments?: Record<string, unknown> }) => this.setToolInput(params.arguments ?? {});
  }
  /** After `connect()`: take the initialize result's context. */
  connected() {
    this.applyContext(this.app.getHostContext(), true);
  }
  async sendMessage(text: string) {
    await this.app.sendMessage({ role: "user", content: [{ type: "text", text }] });
  }
  async openLink(url: string) {
    await this.app.openLink({ url });
  }
  async requestDisplayMode(mode: DisplayMode) {
    const r = await this.app.requestDisplayMode({ mode });
    this.applyContext({ displayMode: r.mode });
    return r.mode;
  }
}

/** A host for a page with no bridge — a host app's own page, a test: the
 *  state you give it, updated through `update`, and the two requests as
 *  callbacks (a warning when the page sends one nobody handles). */
export class StaticHost extends HostStore implements StrutHost {
  constructor(
    initial?: Partial<HostState>,
    private readonly handlers: Partial<Pick<StrutHost, "sendMessage" | "openLink" | "requestDisplayMode">> = {},
  ) {
    super({ connected: true, ...initial });
  }
  update(patch: Partial<HostState> & { context?: HostContext }) {
    const { context, ...rest } = patch;
    if (context) this.applyContext(context);
    if (Object.keys(rest).length) this.set(rest);
  }
  setToolInput(args: Record<string, unknown> | undefined) {
    super.setToolInput(args);
  }
  async sendMessage(text: string) {
    if (this.handlers.sendMessage) return this.handlers.sendMessage(text);
    console.warn("[strut] sendMessage with no host to receive it:", text);
  }
  async openLink(url: string) {
    if (this.handlers.openLink) return this.handlers.openLink(url);
    if (typeof window !== "undefined") window.open(url, "_blank", "noopener");
  }
  async requestDisplayMode(mode: DisplayMode) {
    if (this.handlers.requestDisplayMode) return this.handlers.requestDisplayMode(mode);
    return this.state.displayMode;
  }
}

export function createStaticHost(
  initial?: Partial<HostState>,
  handlers?: Partial<Pick<StrutHost, "sendMessage" | "openLink" | "requestDisplayMode">>,
): StaticHost {
  return new StaticHost(initial, handlers);
}
