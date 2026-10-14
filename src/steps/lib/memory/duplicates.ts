import { z } from "zod";
import { defineStep } from "../../../core.js";
import { memoryDb, normalize } from "./_db.js";
import { vocabulary } from "./_ontology.js";

// A few short forms that share no prefix with the full name. Only what the
// prefix rule misses (Kate/Katie, Jon/Jonathan are already caught).
const NICKNAMES: Record<string, string[]> = {
  bob: ["robert"], rob: ["robert"], bill: ["william"], will: ["william"], liz: ["elizabeth"], beth: ["elizabeth"],
  jim: ["james"], mike: ["michael"], dick: ["richard"], rick: ["richard"], tom: ["thomas"], tony: ["anthony"],
  peggy: ["margaret"], meg: ["margaret"], jack: ["john"], ted: ["edward"], ned: ["edward"], sasha: ["alexander", "alexandra"],
};

const words = (s: string) => normalize(s).split(/[^a-z0-9]+/).filter(Boolean);

/** The name in a name fact's sentence: what follows "name is", "named",
 *  "called" or "call me" ("The user's name is Tom Smith." → tom smith). */
function nameIn(text: string): string[] {
  const m = /\b(?:name is|named|called|call me)\s+(.+)$/i.exec(text);
  return m ? words(m[1]!) : [];
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** Why two names could be one person's: a shared first name, a shared
 *  prefix of at least 3 letters, or a known nickname. Never when both carry
 *  a surname and the surnames differ. */
function firstNameForm(a: string[], b: string[]): { score: number; why: string } | undefined {
  if (!a.length || !b.length) return undefined;
  if (a.length > 1 && b.length > 1 && a[a.length - 1] !== b[b.length - 1]) return undefined;
  const [x, y] = [a[0]!, b[0]!];
  if (x === y) return { score: 60, why: `same first name "${x}"` };
  if ((NICKNAMES[x] ?? []).includes(y) || (NICKNAMES[y] ?? []).includes(x)) return { score: 55, why: `"${x}" is short for "${y}"` };
  if (x.length >= 3 && y.length >= 3 && commonPrefix(x, y) >= 3) return { score: 50, why: `first names "${x}" and "${y}" start alike` };
  return undefined;
}

type Side = { ref_id: string; name: string; node_type: string };

// Deterministic candidates for the duplicates janitor: it proposes, a model
// (or a person) decides. Personal scale, so every pair is compared in memory.
export default defineStep({
  type: "memory/duplicates",
  description:
    "List entities that may be saved twice, strongest first, each pair with the reason it matched: the same name or " +
    "alias on two entities (also of different types), a Person with the user's full name, or one name the " +
    "first-name form of the other ('Kate' and 'Katie Moss'). Candidates only: call memory/get on both before merging.",
  input: z.object({
    limit: z.number().optional().default(20),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    const query = await memoryDb(ctx);
    const rows = await query(
      `MATCH (e:Entity) WHERE e.deleted_at IS NULL
       RETURN e.ref_id AS ref_id, e.type AS type, e.name AS name, e.aliases AS aliases ORDER BY e.created_at, e.ref_id`,
    );
    const entities = rows.map((r) => ({
      side: { ref_id: r.ref_id as string, name: r.name as string, node_type: r.type as string },
      keys: new Set<string>([r.name, ...((r.aliases ?? []) as string[])].map((n) => words(n).join(" "))),
      words: words(r.name),
    }));

    const pairs = new Map<string, { a: Side; b: Side; reason: string; score: number }>();
    const offer = (a: Side, b: Side, score: number, reason: string) => {
      const key = [a.ref_id, b.ref_id].sort().join("\u0000");
      const prev = pairs.get(key);
      if (!prev || prev.score < score) pairs.set(key, { a, b, reason, score });
    };

    // Behaviour comes from the ontology rows, never a type's name: the user
    // is the type with role "user", and people are the other types whose
    // names are matched the way the user's are.
    const vocab = await vocabulary(query);
    const userType = vocab.userType();
    const isUser = (e: (typeof entities)[number]) => vocab.role(e.side.node_type) === "user";
    const isPerson = (e: (typeof entities)[number]) => !!userType && !isUser(e) && vocab.naming(e.side.node_type) === vocab.naming(userType);

    // The user, by the names they gave: their current name facts (a
    // predicate with role "alias"), the name kept on the fact, else read from
    // its sentence. Only a full name: a Person sharing just the user's first
    // name is usually someone else, and a merge into the user cannot be undone.
    const user = entities.find(isUser);
    if (user) {
      const facts = await query(
        `MATCH (f:Fact)-[:SUBJECT]->(s:Entity) WHERE s.ref_id = $id AND f.predicate IN $predicates
           AND f.expired_at IS NULL AND f.deleted_at IS NULL
         RETURN f.value AS value, f.text AS text`,
        { id: user.side.ref_id, predicates: vocab.predicatesWithRole("alias") },
      );
      const names = new Set(facts.map((f) => (f.value ? words(f.value) : nameIn(f.text)).join(" ")).filter(Boolean));
      for (const full of names) {
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
        if (shared) {
          const same = x.side.node_type === y.side.node_type;
          offer(x.side, y.side, same ? 90 : 80, same ? `same name "${shared}"` : `same name "${shared}" on a ${x.side.node_type} and a ${y.side.node_type}`);
          continue;
        }
        if (!isPerson(x) || !isPerson(y)) continue;
        const form = firstNameForm(x.words, y.words);
        if (form) offer(x.side, y.side, form.score, form.why);
      }
    }

    return [...pairs.values()]
      .sort((p, q) => q.score - p.score)
      .slice(0, Math.max(1, cfg.limit))
      .map(({ a, b, reason }) => ({ a, b, reason }));
  },
});
