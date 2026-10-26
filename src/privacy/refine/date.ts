import type { Span } from "../types.js";

const BIRTH = /\b(born|dob|d\.o\.b\.?|date of birth|birth\s?date|birthday|bday)\b/i;

/** A DATE is masked only with a birth cue close by ("born", "DOB", "date of birth", "birthday");
 *  appointments, deadlines and weekdays stay readable. */
export function refineDate(sp: Span, text: string): Span[] {
  const near = text.slice(Math.max(0, sp.s - 40), sp.s) + "\u0000" + text.slice(sp.e, sp.e + 12);
  return BIRTH.test(near) ? [{ ...sp, type: "DATE" }] : [];
}
