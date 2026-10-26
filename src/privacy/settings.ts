import { z } from "zod";
import { DEFAULT_MASK, type PrivacyPolicy } from "./policy.js";

const mode = z.enum(["hosted", "strict"]);
const full = z.object({
  mode,
  mask: z.array(z.string().regex(/^[A-Z_]+$/, "entity types are upper case, like PERSON")).optional(),
  detect: z.object({ llm: z.boolean().default(false) }).optional(),
}).strict();

/** `privacy: off | hosted | strict | { mode, mask?, detect?: { llm } }` */
export const privacySchema = z.union([z.enum(["off", "hosted", "strict"]), full]);

export type PrivacySetting = { mode: "off" } | PrivacyPolicy;

/** Short forms → the one shape the wrapper reads. A value that does not parse is kept as it is
 *  (readPolicy refuses it at the call: a bad setting must never read as "off"). */
export function normalizePrivacy(v: unknown): unknown {
  const r = privacySchema.safeParse(v);
  if (!r.success) return v;
  const d = r.data;
  if (d === "off") return { mode: "off" };
  if (typeof d === "string") return { mode: d, mask: [...DEFAULT_MASK], detect: { llm: false } };
  return { mode: d.mode, mask: d.mask ? [...d.mask] : [...DEFAULT_MASK], detect: { llm: d.detect?.llm ?? false } };
}

/** The policy in force, or null when off/unset. Throws on a value that is neither. */
export function readPolicy(v: unknown): PrivacyPolicy | null {
  if (v == null) return null;
  const n = normalizePrivacy(v) as { mode?: string };
  if (n && typeof n === "object" && n.mode === "off") return null;
  if (!n || typeof n !== "object" || !("mask" in n) || !privacySchema.safeParse(v).success) {
    throw new Error("privacy_setting_invalid: `privacy` must be off, hosted, strict or { mode, mask?, detect? }");
  }
  return n as PrivacyPolicy;
}
