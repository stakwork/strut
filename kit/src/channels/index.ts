/** `@strut/kit/channels`: the channels contract (plans/app-channels.md) —
 *  the `strut/channels/*` bridge methods, the frames strut sends, the fold a
 *  page keeps of a channel — and its two pieces of plumbing: the app's
 *  client (`createBridgeChannels`) and the relay a browser host runs
 *  (`relayChannels`). No React, no DOM, no dependency, so a host's page
 *  imports it alone. */
export * from "./protocol.js";
export * from "./client.js";
export * from "./relay.js";
