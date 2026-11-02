// Identity keys for Causes (hive's published formula). Pure; underscore file, not a step.
import { createHash } from "node:crypto";

const STOP = new Set(
  ("a an the and or but if then of to in on at by for with from into onto as is are was were be been being it its this that " +
    "these those when where which who whom whose than so such not no do does did doing done have has had having will would " +
    "should could can may might must shall also just very more most other some any each every both either neither own same " +
    "too again further once here there why how all few i you he she we they them his her their our your my me us").split(" "),
);

function stem(t: string): string {
  if (t.endsWith("ies") && t.length > 5) t = t.slice(0, -3) + "y";
  if (t.endsWith("ing") && t.length > 5) t = t.slice(0, -3);
  if (t.endsWith("ed") && t.length > 4) t = t.slice(0, -2);
  if (t.endsWith("es") && t.length > 4) t = t.slice(0, -2);
  if (t.endsWith("s") && !t.endsWith("ss") && t.length > 3) t = t.slice(0, -1);
  return t;
}

export function normalise(statement: string): string {
  const text = statement
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/"[^"]*"/g, " ");
  // Tokens are runs of non-whitespace-separated words; any containing a digit is dropped, then non-letters split.
  const tokens: string[] = [];
  for (const raw of text.split(/[^a-z0-9]+/)) {
    if (!raw || /\d/.test(raw)) continue;
    if (STOP.has(raw)) continue;
    const t = stem(raw);
    if (t.length > 1) tokens.push(t);
  }
  return tokens.sort().join(" ");
}

const h = (s: string) => "ck1_" + createHash("sha256").update(s).digest("hex").slice(0, 16);

export function causeKey(cause_type = "correction", mechanism = "other", statement: string): string {
  return h(`${cause_type}\n${mechanism}\n${normalise(statement)}`);
}

export function parentKey(mechanism = "other"): string {
  return h(`parent\n${mechanism}`);
}
