// Text matching for the memory/* steps: tokens and a light stemmer, typo
// distance, English nicknames, and the name comparison remember uses to
// match or flag a near-duplicate entity. No index and no model: at personal
// scale a scan in process is fast, and nothing here needs a Ladybug
// extension or an embedding model. `npm run bench:memory` measures it.
import { type Query, type Row, normalize } from "./_db.js";

// Words that carry no meaning in a memory question. First-person words are
// here too: recall reads them as "about the user" (SELF) instead.
export const STOP = new Set([
  "a", "an", "the", "and", "or", "of", "in", "on", "at", "to", "for", "from", "by", "with", "as", "is", "are", "was", "were",
  "be", "been", "am", "do", "does", "did", "has", "have", "had", "what", "who", "whom", "whose", "where", "when", "which",
  "how", "why", "that", "this", "these", "those", "it", "its", "there", "about", "know", "tell", "you", "your", "can", "could",
  "would", "should", "s", "t", "re", "ve", "ll", "d", "whats", "wheres", "whos", "any", "some", "all", "just", "now",
  "user", "users", "please", "anything", "something", "i", "me", "my", "mine", "myself", "im", "ive",
]);
export const SELF = new Set(["i", "me", "my", "mine", "myself", "im", "ive"]);

/** Lowercase words of letters and digits in any script, accents folded; a possessive 's is dropped ("Kate's" → "kate"). */
export function words(text: string): string[] {
  return normalize(text).replace(/['’]s\b/g, "").replace(/['’]/g, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** True when the word is not in the Latin script (CJK, Thai, …): such text may have no spaces between words. */
export function unspaced(word: string): boolean {
  return /[^\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}]/u.test(word);
}

/** A light English stemmer: enough that cycling/cycles, designers/design and baked/baking meet. Applied to both sides. */
export function stem(w: string): string {
  if (w.length <= 3 || !/^[a-z]+$/.test(w)) return w;
  let s = w;
  for (const [suffix, repl] of [["ies", "y"], ["ied", "y"], ["ings", ""], ["ing", ""], ["ers", ""], ["er", ""], ["edly", ""], ["ed", ""], ["es", ""], ["ly", ""], ["s", ""]] as const) {
    if (s.endsWith(suffix) && s.length - suffix.length >= 3 && !(suffix === "s" && s.endsWith("ss"))) {
      s = s.slice(0, -suffix.length) + repl;
      break;
    }
  }
  if (s.length > 3 && s.endsWith("e")) s = s.slice(0, -1);
  if (s.length > 3 && s.at(-1) === s.at(-2) && !"aeiouls".includes(s.at(-1)!)) s = s.slice(0, -1);
  return s;
}

/** Optimal-string-alignment distance (edits plus adjacent swaps), giving up past `max`. */
export function distance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let best = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
      best = Math.min(best, v);
    }
    if (best > max) return max + 1;
  }
  return d[a.length]![b.length]!;
}

/** A typo of each other: one edit from five letters, two from nine. Shorter words must match exactly. */
export function typo(a: string, b: string): boolean {
  const n = Math.min(a.length, b.length);
  if (n < 5 || a === b) return false;
  return distance(a, b, n >= 9 ? 2 : 1) <= (n >= 9 ? 2 : 1);
}

// Common English given names and their short forms. One group per name; a
// short form of two names (Chris, Pat, Sam) links to both. John and
// Jonathan are different names.
const NICKNAMES = [
  "alexander alex alec", "alexandra alex alexa sandra", "andrew andy drew", "anthony tony", "benjamin ben benny",
  "catherine katherine kathryn kate katie kathy kat cathy", "charles charlie chuck", "christopher chris kit", "christine chris christina tina",
  "daniel dan danny", "david dave davey", "edward ed eddie ted ned", "elizabeth liz lizzie beth betty eliza libby",
  "james jim jimmy jamie", "jennifer jen jenny", "john johnny jack", "jonathan jon jonny", "joseph joe joey", "margaret maggie meg peggy",
  "matthew matt", "michael mike mikey mick", "nicholas nick nicky", "patrick pat paddy", "patricia pat patty trish",
  "peter pete", "rebecca becky becca", "richard rick ricky rich", "robert rob bob bobby robbie bert", "samuel sam sammy",
  "samantha sam sammy", "stephen steve stevie", "steven steve stevie", "susan sue suzy", "thomas tom tommy", "victoria vicky tori",
  "william will bill billy liam", "henry harry", "abigail abby", "deborah deb debbie", "kimberly kim", "timothy tim timmy",
  "frederick fred freddie", "gregory greg", "jacqueline jackie", "jessica jess jessie", "joshua josh", "lawrence larry",
  "nathaniel nathan nate", "theodore theo ted", "zachary zach zack", "olivia liv", "eleanor ellie nora", "isabella izzy bella",
];
// Short forms that are also everyday words ("the gas bill", "pat dry"):
// expanded only when the query writes them with a capital (Bill, Pat).
export const ORDINARY = new Set(["bill", "will", "rich", "drew", "sue", "rob", "nick", "jack", "pat", "chuck", "kit", "mike"]);
const nick = new Map<string, Set<string>>();
for (const group of NICKNAMES) {
  const names = group.split(" ");
  for (const n of names) {
    const set = nick.get(n) ?? new Set<string>();
    for (const m of names) if (m !== n) set.add(m);
    nick.set(n, set);
  }
}
/** Other forms of a given name: kate → katherine, katie, …; empty for a word that is not one. */
export function nicknames(word: string): Set<string> {
  return nick.get(word) ?? new Set();
}

// ---- Entity names (remember's matching) ----

// Left out when comparing names for `similar` (never for a match). Both
// lists are judgement calls, partly shaped by the benchmark fixture (app,
// grandma, nan): see plans/memory-recall-quality.md.
const TITLES = new Set(["dr", "mr", "mrs", "ms", "miss", "prof", "sir", "grandma", "grandpa", "granny", "nan", "auntie", "aunt", "uncle"]);
const GENERIC = new Set(["the", "a", "of", "and", "inc", "ltd", "llc", "plc", "corp", "corporation", "co", "company", "group", "app", "limited"]);

/**
 * The key two spellings of one name share. Only case, accents that Unicode
 * folds (é → e, not ł), whitespace, `.`, `,`, `-`, apostrophes and `&`/and
 * are ignored; every other character counts, so C# ≠ C++ and Олег ≠ Иван.
 */
export function nameKey(name: string): string {
  return normalize(name).replace(/&/g, " and ").replace(/['’]/g, "").replace(/[\s.,\-]+/g, " ").trim();
}

/** How close two words of a name are, 0 to 1: the same, a nickname, a typo, an abbreviation (not people), an initial (people). */
function same(a: string, b: string, person: boolean): number {
  if (a === b) return 1;
  if (person && nicknames(a).has(b)) return 0.9;
  if (typo(a, b)) return 0.7;
  // Places and organisations: an abbreviation of four letters or more (reno → renovation).
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  if (!person) return s.length >= 4 && l.startsWith(s) ? 0.6 : 0;
  // An initial against a first name (J Smith ~ Jane Smith): similar, never a match.
  return s.length === 1 && l.startsWith(s) ? 0.5 : 0;
}

/**
 * How likely `a` and `b` name the same entity of this type, 0 (not at all)
 * to 1: worth reporting as `similar`, never enough to match by itself. People
 * compare first and last names (a nickname, an initial or a typo of each), or
 * one name against either part of the other (exactly, or as a nickname, and
 * scored lower); anything else compares its words with generic ones (the,
 * inc, corp, app, …) left out, in any order. Words are nameKey's, so symbols
 * still count.
 */
export function similarity(type: string, a: string, b: string): number {
  return similarTo(type, a)(nameKey(b));
}
export const similarName = (type: string, a: string, b: string): boolean => similarity(type, a, b) > 0;

/** `similarity` with `a` prepared once: the returned function takes `b`'s nameKey, for scanning many names. */
function similarTo(type: string, a: string): (bKey: string) => number {
  const person = type === "Person" || type === "Self";
  const strip = (key: string) => {
    const w = key.split(" ").filter(Boolean);
    const kept = w.filter((x) => !(person ? TITLES : GENERIC).has(x));
    return kept.length ? kept : w;
  };
  const x = strip(nameKey(a));
  return (bKey) => {
    const y = strip(bKey);
    if (!x.length || !y.length) return 0;
    if (person) {
      if (x.length === 1 || y.length === 1) {
        // One word is weak evidence: it must be the other's word or a nickname of it, never a typo or an initial.
        const [one, many] = x.length === 1 ? [x[0]!, y] : [y[0]!, x];
        if (one.length < 2) return 0;
        return 0.5 * Math.max(0, ...many.map((w) => (w === one ? 1 : nicknames(one).has(w) ? 0.9 : 0)));
      }
      const first = same(x[0]!, y[0]!, true), last = same(x.at(-1)!, y.at(-1)!, true);
      return first && last ? (first + last) / 2 : 0;
    }
    if (x.length !== y.length) return 0;
    const rest = [...y];
    let total = 0;
    for (const w of x) {
      let best = -1, at = 0;
      rest.forEach((v, i) => {
        const sc = same(w, v, false);
        if (sc > at) [best, at] = [i, sc];
      });
      if (best < 0) return 0;
      total += at;
      rest.splice(best, 1);
    }
    return total / x.length;
  };
}

const ENTITY = "e.ref_id AS ref_id, e.type AS type, e.name AS name, e.aliases AS aliases";

/**
 * The live entity of a type that `name` means. Deliberately in this order:
 * the exact normalised spelling of a name or alias (one equality query, the
 * fast path), then the same `nameKey`; within each, the oldest entity. A
 * graph from before nameKey can hold two entities with one key ("Ann-Lee",
 * "ann lee"): the one spelled as asked wins, else the oldest. When nothing
 * matches, the entities `similarity` flags, closest first.
 */
export async function byName(query: Query, type: string, name: string): Promise<{ match?: Row; similar: Row[] }> {
  const exact = normalize(name);
  const [hit] = await query(
    `MATCH (e:Entity) WHERE e.type = $type AND e.deleted_at IS NULL AND (lower(e.name) = $key OR list_contains(e.aliases, $key))
     RETURN ${ENTITY} ORDER BY e.created_at, e.ref_id LIMIT 1`,
    { type, key: exact },
  );
  if (hit) return { match: hit, similar: [] };
  const rows = await query(
    `MATCH (e:Entity) WHERE e.type = $type AND e.deleted_at IS NULL RETURN ${ENTITY} ORDER BY e.created_at, e.ref_id`,
    { type },
  );
  // Each row's names as keys, each distinct spelling keyed once (an alias is usually the name itself).
  const keys = (r: Row) => [...new Set([r.name as string, ...((r.aliases as string[] | null) ?? [])])].map(nameKey);
  const key = nameKey(name);
  const keyed = rows.map((r) => ({ r, keys: keys(r) }));
  const match = key ? keyed.find((k) => k.keys.includes(key))?.r : undefined;
  if (match) return { match, similar: [] };
  // Closest first; equally close, oldest first (the rows' order, kept by a stable sort).
  const close = similarTo(type, name);
  return {
    similar: keyed.map((k) => ({ r: k.r, score: Math.max(...k.keys.map(close)) }))
      .filter((k) => k.score > 0).sort((p, q) => q.score - p.score).map((k) => k.r),
  };
}
