/**
 * What the step editor should SAVE as `depends`, given what the step had and
 * what the checkboxes now say.
 *
 * `depends` has three meanings (AGENTS.md "DAG execution via `depends`"):
 * omitted = implicitly depends on the previous step in the array, `[]` =
 * explicitly none (runs in parallel), a list = those steps. The checkbox UI
 * shows "none" for the first two, so the save must not collapse them:
 *
 *  - checked ids → that list
 *  - nothing checked, and the step HAD an explicit `depends` (an empty array,
 *    or deps the user just unchecked) → `[]`: the user said "no dependencies",
 *    never "wait for whatever comes before me"
 *  - nothing checked, and the step never had `depends` → omitted, unchanged
 */
export function dependsForSave(
  original: string | string[] | undefined | null,
  edited: string[],
): string[] | undefined {
  if (edited.length > 0) return edited;
  return original != null ? [] : undefined;
}
