// What hive mints for one user: an org-signed user authorization + a
// user-signed standing invocation for `strut-agent`, no attenuations. Used
// by mothership.test.ts and scripts/gateway-smoke.ts.
import { randomBytes, randomUUID } from "node:crypto";
import {
  bytesToHex,
  ed25519PublicKey,
  encodeMacaroon,
  signInvocation,
  signUserAuthorizationSingle,
  type Attenuation,
  type Macaroon,
} from "gatekey";
import { STRUT_AGENT } from "../mothership.js";

export interface MintOptions {
  actor: string;
  orgPriv: Uint8Array;
  userPriv: Uint8Array;
  ceiling?: number;
  maxSteps?: number;
  agents?: string[];
  ttlMs?: number;
  attenuations?: Attenuation[];
}

export function mintDelegation(o: MintOptions) {
  const hex16 = () => randomBytes(16).toString("hex");
  const now = new Date();
  const iat = now.toISOString();
  const exp = new Date(now.getTime() + (o.ttlMs ?? 60 * 86_400_000)).toISOString();
  const agents = o.agents ?? [STRUT_AGENT];
  const delegationId = randomUUID();
  const ua = signUserAuthorizationSingle(
    { user_id: o.actor, user_pubkey: { alg: "ed25519", key: bytesToHex(ed25519PublicKey(o.userPriv)) }, agents, iat, exp, nonce: hex16() },
    o.orgPriv,
  );
  const inv = signInvocation(
    { agents, run_id: delegationId, max_cost_usd: o.ceiling ?? 10_000, max_steps: o.maxSteps ?? 0, iat, exp, nonce: hex16() },
    o.userPriv,
  );
  const m: Macaroon = { v: 1, org_id: "org_test", user_authorization: ua, invocation: inv, attenuations: o.attenuations ?? [] };
  return { macaroon: encodeMacaroon(m), delegationId, exp, m };
}
