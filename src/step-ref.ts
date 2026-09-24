/**
 * A step reference as a workflow names it: a bare type (`clip/shout`) runs
 * the step's ACTIVE version, the one every other workflow runs and the one
 * `edit_step` / `PUT /steps/:type/active` moves; a PINNED reference
 * (`clip/shout@v1`) runs that version whatever is active, so a workflow
 * that pins is held there until its YAML says otherwise — the step twin of
 * `subflow`'s `version:`.
 *
 * Only custom steps have versions; the pin's suffix is a version LABEL
 * (`vN`), never a content hash. Events carry the bare type as `stepType`
 * (everything keyed on a step type — stats, claims, the UI's colors — is
 * blind to pins) and the executed version as `step.start.stepVersion`.
 */
export interface StepRef {
  type: string;
  version?: string;
}

const PIN_RE = /^(.+)@([^@/]+)$/;

/** `clip/shout@v1` → `{ type: "clip/shout", version: "v1" }`; a bare type
 *  has no `version`. Anything but one `@` followed by a version label is a
 *  bare (and therefore unknown) type — the registry says so. */
export function parseStepRef(ref: string): StepRef {
  const m = PIN_RE.exec(ref);
  return m ? { type: m[1]!, version: m[2]! } : { type: ref };
}

/** The bare step type of a reference — what events and stats key on. */
export function baseType(ref: string): string {
  return parseStepRef(ref).type;
}

export function formatStepRef(ref: StepRef): string {
  return ref.version ? `${ref.type}@${ref.version}` : ref.type;
}
