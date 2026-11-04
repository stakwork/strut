// The Public view dialog's pure parts (components/PublicViewDialog.tsx;
// plans/public-surface.md §2): the link a visitor opens, and how the
// cascade's checked lines merge into the record.
import type { PublicViewNeeds, PublicViewRecord } from "./api";

/** A visitor's link to a public app: the page alone, no credential. */
export function visitorAppLink(name: string, here: string): string {
  const url = new URL(here);
  url.search = "";
  url.hash = "";
  url.searchParams.set("app", name);
  url.searchParams.set("solo", "1");
  url.searchParams.set("public", "1");
  return url.toString();
}

export const sameRecord = (a: PublicViewRecord, b: PublicViewRecord) => JSON.stringify(a) === JSON.stringify(b);
export const emptyRecord = (): PublicViewRecord => ({ concepts: [], workflows: [], steps: [], types: [], apps: [] });

/** The record with the cascade's checked lines merged in. */
export function mergeNeeds(rec: PublicViewRecord, needs: PublicViewNeeds, checked: Set<string>): PublicViewRecord {
  const next: PublicViewRecord = JSON.parse(JSON.stringify(rec));
  const on = (key: string) => checked.has(key);
  if (needs.app) {
    const reads = needs.reads.filter((r) => on(`read:${r.name}`)).map((r) => r.name);
    const at = next.apps.find((a) => a.name === needs.app!.name);
    if (at) at.reads = [...new Set([...(at.reads ?? []), ...reads])];
    else next.apps.push({ name: needs.app.name, ...(reads.length ? { reads } : {}) });
  }
  if (needs.workflow && !needs.workflows.length) next.workflows.push({ name: needs.workflow });
  for (const w of needs.workflows) {
    if (!on(`workflow:${w.name}`)) continue;
    const runs = on(`runs:${w.name}`);
    const at = next.workflows.find((x) => x.name === w.name);
    if (at) at.runs = at.runs || runs || undefined;
    else next.workflows.push({ name: w.name, ...(runs ? { runs: true } : {}) });
  }
  for (const s of needs.steps) if (on(`step:${s.name}`) && !next.steps.includes(s.name)) next.steps.push(s.name);
  for (const c of needs.concepts) if (on(`concept:${c.name}`) && !next.concepts.includes(c.name)) next.concepts.push(c.name);
  for (const w of next.workflows) if (!w.runs) delete w.runs;
  return next;
}

/** The keys a cascade starts with checked. */
export function checkedOf(needs: PublicViewNeeds): Set<string> {
  const out = new Set<string>();
  for (const w of needs.workflows) {
    if (w.checked) out.add(`workflow:${w.name}`);
    if (w.checked && w.runs) out.add(`runs:${w.name}`);
  }
  for (const s of needs.steps) if (s.checked) out.add(`step:${s.name}`);
  for (const r of needs.reads) if (r.checked) out.add(`read:${r.name}`);
  for (const c of needs.concepts) if (c.checked) out.add(`concept:${c.name}`);
  return out;
}

