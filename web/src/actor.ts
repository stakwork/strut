// ── Actor ids in the UI ─────────────────────────────────────────────────────
//
// An actor id is an opaque string strut stores and forwards whole
// (`evanfeenstra-s8fhs8efhs8ehf`: a name, a dash, a host-assigned suffix).
// The UI shows the part before the first dash; the full id stays in storage,
// on the wire, and in tooltips.

/** The display name of an actor id: everything before the first `-`. */
export function displayActor(actor: string): string {
  const head = actor.split("-", 1)[0]!.trim();
  return head || actor;
}
