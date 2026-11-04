/**
 * Which two named nodes may be one thing saved twice: the pair rules
 * memory/duplicates offers (`src/steps/lib/memory/duplicates.ts`) and the
 * graph's merge holds the janitor to (`merge.ts`). Pure: names in, pairs out.
 */
import { foldText } from "./world-time.js";

// Unicode-aware, so "Łukasz", "Søren" and Cyrillic names keep every letter.
export const words = (s: string) => foldText(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** Both names carry a surname and the surnames differ. */
const surnamesClash = (a: string[], b: string[]) => a.length > 1 && b.length > 1 && a[a.length - 1] !== b[b.length - 1];

/** Why two names could be one person's: a shared first name, a shared
 *  prefix of at least 3 letters. A short form that shares no prefix (Bob,
 *  Robert) is the node's own other name, `alt_names`. Never when both carry
 *  a surname and the surnames differ. */
function firstNameForm(a: string[], b: string[]): { score: number; why: string } | undefined {
  if (!a.length || !b.length || surnamesClash(a, b)) return undefined;
  const [x, y] = [a[0]!, b[0]!];
  if (x === y) return { score: 60, why: `same first name "${x}"` };
  if (x.length >= 3 && y.length >= 3 && commonPrefix(x, y) >= 3) return { score: 50, why: `first names "${x}" and "${y}" start alike` };
  return undefined;
}

type Side = { ref_id: string; name: string; node_type: string };
export type Candidate = { a: Side; b: Side; reason: string; score: number };

/** A node as the pair rules read it: its name and other names, as words. */
export interface Named {
  side: Side;
  keys: Set<string>;
  words: string[];
}

export function named(side: Side, aliases: readonly string[]): Named {
  return {
    side,
    keys: new Set<string>([side.name, ...aliases].map((n) => words(n).join(" ")).filter(Boolean)),
    words: words(side.name),
  };
}

/** The pair rules over `entities`, strongest first: the user (`isUser`) with a
 *  person holding one of `userNames` that is a full name (score 100, the
 *  only pair with the user in it), then every other pair by shared name
 *  (90, 80 across types) or, between people, by first-name form. Shared by
 *  memory/duplicates and the graph's merge (`src/graph/merge.ts`). */
export function pairsOf(entities: Named[], isUser: (e: Named) => boolean, userNames: Iterable<string>, isPerson: (e: Named) => boolean): Candidate[] {
  const pairs = new Map<string, Candidate>();
  const offer = (a: Side, b: Side, score: number, reason: string) => {
    const key = [a.ref_id, b.ref_id].sort().join("\u0000");
    const prev = pairs.get(key);
    if (!prev || prev.score < score) pairs.set(key, { a, b, reason, score });
  };

  // Only a full name: a Person sharing just the user's first name is
  // usually someone else, and a merge into the user cannot be undone.
  // So a name of one word ("call me Tom") is never matched.
  const user = entities.find(isUser);
  if (user) {
    const names = new Set([...userNames].map((n) => words(n).join(" ")).filter(Boolean));
    for (const full of [...names].filter((n) => n.includes(" "))) {
      for (const e of entities) {
        if (isPerson(e) && e.keys.has(full)) offer(user.side, e.side, 100, `a ${e.side.node_type} named as the user ("${full}")`);
      }
    }
  }

  const others = entities.filter((e) => !isUser(e));
  for (let i = 0; i < others.length; i++) {
    for (let j = i + 1; j < others.length; j++) {
      const [x, y] = [others[i]!, others[j]!];
      const shared = [...x.keys].find((n) => y.keys.has(n));
      // One word shared through an alias ("kate", kept on Katie Moss after a
      // merge) is only a first name: between people it goes through the
      // surname check below, not "same name".
      const firstOnly = !!shared && !shared.includes(" ") && isPerson(x) && isPerson(y) && !(x.words.join(" ") === shared && y.words.join(" ") === shared);
      if (shared && !firstOnly) {
        const same = x.side.node_type === y.side.node_type;
        offer(x.side, y.side, same ? 90 : 80, same ? `same name "${shared}"` : `same name "${shared}" on a ${x.side.node_type} and a ${y.side.node_type}`);
        continue;
      }
      if (!isPerson(x) || !isPerson(y)) continue;
      const form = firstOnly && !surnamesClash(x.words, y.words) ? { score: 60, why: `both go by "${shared}"` } : firstNameForm(x.words, y.words);
      if (form) offer(x.side, y.side, form.score, form.why);
    }
  }

  return [...pairs.values()].sort((p, q) => q.score - p.score);
}

