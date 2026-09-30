// ── Step + workflow search ─────────────────────────────────────────────────
//
// One matcher for every place a person looks for a step type or a workflow:
// the sidebar's filters, the Add Step picker and `GET /workflows?q=` (the
// web UI imports this file, so the API and the sidebar cannot disagree). The query is split into words and
// EVERY word must appear in the type or its description ("slack post" finds
// slack/post-message). Matches rank by how many words hit the type name
// (a name hit beats a description hit); ties keep the input order.

export function searchSteps<T extends { type: string; description?: string }>(entries: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return entries;
  const scored: Array<{ entry: T; score: number }> = [];
  for (const entry of entries) {
    const type = entry.type.toLowerCase();
    const desc = entry.description?.toLowerCase() ?? "";
    let score = 0;
    let all = true;
    for (const w of words) {
      if (type.includes(w)) score += 2;
      else if (desc.includes(w)) score += 1;
      else { all = false; break; }
    }
    if (all) scored.push({ entry, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.entry);
}

/** Workflows by name, category and description — the sidebar's Workflows
 *  filter and `GET /workflows?q=`. */
export function searchWorkflows<T extends { name: string; category?: string; description?: string }>(workflows: T[], query: string): T[] {
  return searchSteps(
    workflows.map((wf) => ({ type: wf.name, description: [wf.category, wf.description].filter(Boolean).join(" "), wf })),
    query,
  ).map((m) => m.wf);
}
