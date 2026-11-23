// What a host mints for one person. v2 (Stadeum, gatekey 1.x): the org's
// block 0 grants the person, the person's block 1 hands strut-agent a
// ceiling, and the proof is strut's key. v1 (Hive, gatekey 0.x): an
// org-signed user authorization + a user-signed standing invocation, no
// attenuations. Used by mothership.test.ts, public-runs.test.ts and
// scripts/gateway-smoke.ts (stakgraph's gateway: v1).
import { randomBytes, randomUUID } from "node:crypto";
import { attenuate, bytesToHex, encodeToken, keyPair, signRoot, type Token } from "gatekey";
import {
  ed25519PublicKey,
  encodeMacaroon,
  signInvocation,
  signUserAuthorizationSingle,
  type Attenuation,
  type Macaroon,
} from "gatekey-v1";
import { STRUT_AGENT } from "../mothership.js";

export interface MintOptions {
  actor: string;
  /** A secp256k1 scalar: the org's key. */
  orgPriv: Uint8Array;
  /** An Ed25519 seed: the person's key. */
  userPriv: Uint8Array;
  ceiling?: number;
  ttlMs?: number;
}

const hex16 = () => randomBytes(16).toString("hex");
const times = (ttlMs = 60 * 86_400_000) => {
  const now = new Date();
  return { iat: now.toISOString(), exp: new Date(now.getTime() + ttlMs).toISOString() };
};

export function mintDelegation(o: MintOptions & { agent?: string }) {
  const { iat, exp } = times(o.ttlMs);
  const delegationId = randomUUID();
  const person = keyPair("ed25519", o.userPriv);
  const grant = signRoot(
    "org_test",
    { run_id: `ua_${randomUUID()}`, user_id: o.actor, agents: [STRUT_AGENT], iat, exp, nonce: hex16() },
    person.pub,
    { alg: "ecdsa-secp256k1-sha256", priv: o.orgPriv },
  );
  const token: Token = attenuate(
    { v: 2, org_id: "org_test", blocks: [grant], proof: bytesToHex(person.priv) },
    { run_id: delegationId, agent: o.agent ?? STRUT_AGENT, max_cost_usd: o.ceiling ?? 10_000, iat, exp, nonce: hex16() },
  );
  return { macaroon: encodeToken(token), delegationId, exp, token };
}

export function mintDelegationV1(o: MintOptions & { maxSteps?: number; agents?: string[]; attenuations?: Attenuation[] }) {
  const { iat, exp } = times(o.ttlMs);
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
