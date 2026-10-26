import type { StepContext } from "./host.js";
import { liveSession } from "./middleware.js";
import { isSideEffecting } from "./tool-policy.js";

const PLACEHOLDER = /\[[A-Z]{2,10}_\d{1,4}[a-z]?\]/g;

/** The tool wrapper: a tool input that still holds a placeholder the session never issued (the model
 *  made one up: restoring left it as written) must not reach a tool that acts. Read-only tools: warned. */
export function guardTools(tools: Record<string, any>, ctx?: StepContext): void {
  for (const [name, t] of Object.entries(tools)) {
    const orig = t?.execute;
    if (typeof orig !== "function" || t.__privacyGuard) continue;
    t.__privacyGuard = true;
    t.execute = async (input: unknown, opts: unknown) => {
      const st = liveSession(ctx);
      if (st) {
        const bad = [...new Set(JSON.stringify(input ?? null).match(PLACEHOLDER) ?? [])].filter((p) => !Object.hasOwn(st.map, p));
        if (bad.length) {
          if (isSideEffecting(name, ctx)) return `Error: unknown placeholder ${bad[0]}; use only names you were given. Nothing was done.`;
          console.warn(`[privacy] tool "${name}" was called with unknown placeholder(s) ${bad.join(", ")}`);
        }
      }
      return (orig as (i: unknown, o: unknown) => Promise<unknown>)(input, opts);
    };
  }
}
