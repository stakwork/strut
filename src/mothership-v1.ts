/**
 * Macaroon v1 (gatekey 0.x, the `gatekey-v1` alias) for the swarms: mcp runs
 * strut against stakgraph's gateway, which reads only v1, from a delegation
 * Hive mints. Delete this file and the alias when the swarms retire.
 *
 * A v1 delegation is an org-signed user authorization plus a user-signed
 * standing invocation for `strut-agent`, no attenuations. Strut appends
 * keyless HMAC links (gatekey's `attenuate`). Their limits must narrow the
 * parent's: every link restates `max_steps: 0` (no call-count cap) and its
 * agent lineage from `strut-agent`. A holder can drop links, which is why
 * Stadeum moved to v2 (src/mothership.ts).
 */

import type { Macaroon } from "gatekey-v1";
import { randomBytes } from "node:crypto";
import { STRUT_AGENT, type Link, type OpenDelegation } from "./mothership.js";

export async function openV1(encoded: string): Promise<OpenDelegation> {
  const gk = await import("gatekey-v1");
  const m: Macaroon = gk.decodeMacaroon(encoded);
  const ua = m.user_authorization;
  const inv = m.invocation;
  if (!ua || typeof ua !== "object" || !inv || typeof inv !== "object") {
    throw new Error("macaroon must carry a user_authorization and an invocation");
  }
  if (!Array.isArray(m.attenuations) || m.attenuations.length > 0) {
    throw new Error("a delegation must carry no attenuations — strut appends its own");
  }
  if (!Array.isArray(inv.agents) || !inv.agents.includes(STRUT_AGENT)) {
    throw new Error(`the invocation must authorize agent "${STRUT_AGENT}"`);
  }
  if (inv.max_steps !== 0) {
    throw new Error(`the invocation's max_steps must be 0 (no call-count cap); got ${String(inv.max_steps)}`);
  }
  if (typeof inv.max_cost_usd !== "number" || !(inv.max_cost_usd > 0)) {
    throw new Error("the invocation's max_cost_usd (the delegation ceiling) must be a positive number");
  }
  if (typeof inv.run_id !== "string" || !inv.run_id) {
    throw new Error("the invocation must carry a run_id (the delegation id)");
  }
  for (const [what, exp] of [["user_authorization", ua.exp], ["invocation", inv.exp]] as const) {
    if (typeof exp !== "string" || !Number.isFinite(Date.parse(exp))) {
      throw new Error(`the ${what}'s exp is not a timestamp`);
    }
  }

  // Each link is keyed by the signature (or HMAC) before it.
  const link = (m: Macaroon, key: Uint8Array): Link => ({
    extend(c) {
      const a = gk.attenuate(key, {
        agents: c.agent ? [STRUT_AGENT, c.agent] : [STRUT_AGENT],
        run_id: c.runId,
        max_cost_usd: c.capUsd,
        max_steps: 0,
        exp: c.exp,
        nonce: randomBytes(16).toString("hex"),
      });
      return link({ ...m, attenuations: [...m.attenuations, a] }, gk.attenuationSigBytes(a));
    },
    encode: () => gk.encodeMacaroon(m),
  });
  return {
    v: 1,
    delegationId: inv.run_id,
    // A valid v1 macaroon's invocation never outlives its authorization.
    exp: Date.parse(ua.exp) <= Date.parse(inv.exp) ? ua.exp : inv.exp,
    ceilingUsd: inv.max_cost_usd,
    root: link(m, gk.invocationSigBytes(inv)),
  };
}
