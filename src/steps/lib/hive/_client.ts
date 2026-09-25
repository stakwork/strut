// Shared helpers for the hive/* lib steps. Leading-underscore file → imported
// by siblings, skipped by registry discovery (see AGENTS.md). These steps go
// through ctx.services.http (raw REST — no SDK needed, fully recordable),
// same as slack/* and x/*.
import type { StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";

type Ctx = StepContext<StrutCapabilities>;

/** Resolve the Hive pool-manager base URL and org API key: explicit config
 *  wins, else the HIVE_URL / HIVE_API_KEY secrets (UI-managed store → env),
 *  same fallback convention as create-pr's GITHUB_TOKEN. Throws an actionable
 *  error naming the config field as the alternative when either is missing. */
export async function hiveAuth(
  cfg: { hiveUrl?: string; apiKey?: string },
  ctx: Ctx,
): Promise<{ baseUrl: string; apiKey: string }> {
  const baseUrl = cfg.hiveUrl ?? (await ctx?.services?.secrets?.get("HIVE_URL"));
  if (!baseUrl) {
    throw new Error(
      'HIVE_URL secret is not set — add it in the Secrets dialog (the Hive swarm\'s base URL). Alternatively, pass `hiveUrl` in config.',
    );
  }
  const apiKey = cfg.apiKey ?? (await ctx?.services?.secrets?.get("HIVE_API_KEY"));
  if (!apiKey) {
    throw new Error(
      'HIVE_API_KEY secret is not set — add it in the Secrets dialog (an org-scoped Hive API key). Alternatively, pass `apiKey` in config.',
    );
  }
  return { baseUrl: String(baseUrl).replace(/\/+$/, ""), apiKey };
}
