// The slice of vitest's `expect` and `it.each` the run graph's tests use,
// over node:test and node:assert/strict — so the tests ported from hive
// (src/__tests__/unit/lib/strut-run-graph/) read as they did there. Test-only.
import assert from "node:assert/strict";
import { it as nodeIt } from "node:test";

/** Does `actual` hold every key of `expected`, recursively (arrays whole)? */
function matches(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object" || Array.isArray(expected)) {
    try {
      assert.deepEqual(actual, expected);
      return true;
    } catch {
      return false;
    }
  }
  if (actual === null || typeof actual !== "object") return false;
  return Object.entries(expected).every(([k, v]) => matches((actual as Record<string, unknown>)[k], v));
}

function matchers(actual: any, negate: boolean) {
  const check = (pass: boolean, message: string) => assert.ok(negate ? !pass : pass, negate ? `not: ${message}` : message);
  return {
    toBe: (e: unknown) => (negate ? assert.notStrictEqual(actual, e) : assert.strictEqual(actual, e)),
    toEqual: (e: unknown) => (negate ? assert.notDeepEqual(actual, e) : assert.deepEqual(actual, e)),
    toBeNull: () => check(actual === null, `${String(actual)} is null`),
    toHaveLength: (n: number) => check(actual?.length === n, `length ${actual?.length} is ${n}`),
    toContain: (x: unknown) => check(actual.includes(x), `${JSON.stringify(actual)} contains ${JSON.stringify(x)}`),
    toHaveProperty: (k: string) => check(actual != null && k in actual, `has ${k}`),
    toMatchObject: (e: unknown) => check(matches(actual, e), `${JSON.stringify(actual)} matches ${JSON.stringify(e)}`),
    toBeGreaterThan: (n: number) => check(actual > n, `${actual} > ${n}`),
    toBeLessThan: (n: number) => check(actual < n, `${actual} < ${n}`),
    toBeLessThanOrEqual: (n: number) => check(actual <= n, `${actual} <= ${n}`),
    toBeCloseTo: (n: number, digits = 2) => check(Math.abs(actual - n) < 10 ** -digits / 2, `${actual} ≈ ${n}`),
  };
}

export function expect(actual: unknown) {
  return { ...matchers(actual, false), not: matchers(actual, true) };
}

/** `it`, with vitest's `it.each(rows)(name, fn)` (`%s` filled in order). */
export const it = Object.assign(
  (name: string, fn: () => unknown) => nodeIt(name, fn as () => void),
  {
    each: (rows: unknown[][]) => (name: string, fn: (...args: any[]) => unknown) => {
      for (const row of rows) {
        let i = 0;
        nodeIt(name.replace(/%s/g, () => String(row[i++])), () => fn(...row) as void);
      }
    },
  },
);
