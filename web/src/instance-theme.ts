// The server's BRAND (src/instance-theme.ts, `GET /instance/theme`): the
// host-context variables every app this page frames is handed as
// `hostContext.styles.variables` (./app-host `hostContextFor`), per colour
// scheme. Fetched once as the page loads — a frame waits for it, so the
// first paint is branded — and again whenever the tab comes back, on its
// ETag (a 304 when nothing changed). A change tells the open frames, which
// resend their host context (`host-context-changed`). Unreachable: the
// kit's neutral defaults, as before there was a brand.
import { API_BASE } from "./api";

type Variables = Record<string, string>;
interface Brand { version: number; variables: { light: Variables; dark: Variables } }

const NONE: Brand = { version: 0, variables: { light: {}, dark: {} } };
let brand: Brand = NONE;
let etag: string | undefined;
let started: Promise<void> | undefined;
const listeners = new Set<() => void>();
// Every name ever handed to a frame: a token cleared since is sent as "",
// which the kit's applyHostContext reads as "remove".
const handed = new Set<string>();

async function fetchBrand(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/instance/theme`, { headers: etag ? { "if-none-match": etag } : {} });
    if (res.status === 304 || !res.ok) return;
    const next = (await res.json()) as Brand;
    const tag = res.headers.get("etag") ?? undefined;
    if (tag === etag && next.version === brand.version) return;
    etag = tag;
    brand = next;
    for (const fn of listeners) fn();
  } catch {
    // Offline, or a host whose gate hides the route: the defaults.
  }
}

/** Resolves once the brand is known (or known to be unreachable). The first
 *  call fetches it and, from then on, refetches when the tab comes back. */
export function ready(): Promise<void> {
  if (!started) {
    started = fetchBrand();
    if (typeof window !== "undefined") {
      const back = () => { if (document.visibilityState === "visible") void fetchBrand(); };
      window.addEventListener("focus", back);
      document.addEventListener("visibilitychange", back);
    }
  }
  return started;
}

/** Called whenever the brand changes; returns the unsubscribe. */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The variables a frame shown in `theme` is handed — undefined when there
 *  never was a brand, so an unbranded host context is as it always was. */
export function variablesFor(theme: "light" | "dark"): Variables | undefined {
  const current = brand.variables[theme] ?? {};
  if (!Object.keys(current).length && !handed.size) return undefined;
  const out: Variables = {};
  for (const name of handed) out[name] = "";
  for (const [name, value] of Object.entries(current)) {
    out[name] = value;
    handed.add(name);
  }
  return out;
}
