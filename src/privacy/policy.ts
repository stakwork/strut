import { refineDate } from "./refine/date.js";
import { refineUrl } from "./refine/url.js";
import type { Span } from "./types.js";

export type PrivacyMode = "hosted" | "strict";

/** What the `privacy` setting means once its short forms are expanded. */
export interface PrivacyPolicy {
  mode: PrivacyMode;
  /** Entity types that are masked. Anything else reaches the provider as written. */
  mask: string[];
  detect: { llm: boolean };
}

/** DATE, TIME, URL and LOC (city level) stay visible: calendar and browsing agents need them. */
export const DEFAULT_MASK = ["PERSON", "NICKNAME", "EMAIL", "PHONE", "ID", "ADDRESS", "POSTAL", "HANDLE", "ORG"];

/** Changing this mid-session starts a new transcript. */
export const policyKey = (p: PrivacyPolicy): string => JSON.stringify([[...p.mask].sort(), p.detect.llm]);

/** For a type the policy does not mask: the parts of the span that still must be. */
export function makeRefine(mask: string[]): (sp: Span, text: string) => Span[] {
  const keep = new Set(mask);
  return (sp, text) => {
    if (sp.type === "DATE") return refineDate(sp, text); // a birth date is masked as a DATE
    return sp.type === "URL" ? refineUrl(sp, text).filter((s) => keep.has(s.type)) : [];
  };
}
