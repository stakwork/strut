/** `@strut/kit/wallet`: the wallet contract (specs/WALLET.md) — the
 *  `strut/wallet/*` methods, their params and results, the checks every side
 *  runs, the units and Sphinx-address helpers — and its three pieces of
 *  plumbing: the app's client (`createBridgeWallet`), `window.webln` over it,
 *  and the relay strut's UI runs in a native host's web view. No React, no
 *  DOM, no dependency, so a host's page imports it alone. The conformance
 *  vectors are `@strut/kit/wallet/vectors.json`. */
export * from "./protocol.js";
export * from "./client.js";
export * from "./webln.js";
export * from "./relay.js";
