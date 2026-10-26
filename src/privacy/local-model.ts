import type { ModelCallInfo } from "./host.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** A model on this machine never sends anything off it, so nothing needs masking.
 *  A call routed through a gateway is not local even when the gateway is: it forwards. */
export function isLocalModel(info: Pick<ModelCallInfo, "provider" | "baseUrl" | "routed">): boolean {
  if (/^(local|ollama|llamacpp)\b/i.test(info.provider)) return true;
  if (!info.baseUrl || info.routed) return false;
  try { return LOOPBACK.has(new URL(info.baseUrl).hostname); } catch { return false; }
}
