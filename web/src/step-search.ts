// ── Step search ────────────────────────────────────────────────────────────
//
// One matcher for every place a person looks for a step type: the sidebar's
// Steps filter and the Add Step picker. The query is split into words and
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
