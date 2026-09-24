/** The UI's mirror of src/step-ref.ts: `clip/shout@v1` names a PINNED
 *  version of a custom step; everything keyed on a step type (node colors,
 *  claims, stats) wants the bare type. Schema and source are fetched with
 *  the reference as written — the server resolves the pin. */
export function baseType(ref: string): string {
  const m = /^(.+)@([^@/]+)$/.exec(ref);
  return m ? m[1]! : ref;
}
