/** The UI's mirror of src/step-ref.ts: `clip/shout@v1` names a PINNED
 *  version of a custom step; everything keyed on a step type (node colors,
 *  claims, stats) wants the bare type. Schema and source are fetched with
 *  the reference as written — the server resolves the pin. */
export interface StepRef {
  type: string;
  version?: string;
}

export function parseStepRef(ref: string): StepRef {
  const m = /^(.+)@([^@/]+)$/.exec(ref);
  return m ? { type: m[1]!, version: m[2]! } : { type: ref };
}

export function baseType(ref: string): string {
  return parseStepRef(ref).type;
}

export function formatStepRef(ref: StepRef): string {
  return ref.version ? `${ref.type}@${ref.version}` : ref.type;
}
