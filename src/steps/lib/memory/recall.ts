import { z } from "zod";
import { defineStep } from "../../../core.js";
import { type Row, iso, memoryDb, normalize } from "./_db.js";
import { ORDINARY, SELF, STOP, nicknames, stem, typo, unspaced, words } from "./_match.js";

// Ranked word matching, scanned in process (fine at personal scale; see
// plans/memory-recall-quality.md and `npm run bench:memory`). A query word
// meets a node's word as the same stem, an abbreviation, a typo or a
// nickname, weighted by how rare the word is. A word naming a predicate (the
// ontology's names and aliases: job → works_at) counts on facts of that
// predicate; "I/me/my" favours facts about the user; "X … with Y" also
// returns the facts that share Y's object for that predicate (who works
// with Kate → her colleagues). People's names are never stemmed (Jones is
// not Jon). Text with no spaces between words (CJK) also matches as a
// substring.
const EXACT = 1, PREFIX = 0.8, NICK = 0.9, TYPO = 0.6, PREDICATE = 0.8;

type Doc = { hit: Record<string, unknown>; stems: Set<string>; names: Set<string>; text: string; entity: boolean; predicate?: string;
  subject?: string; object?: string; self: boolean; at: number; title: Set<string> };
// How a query word may meet a node's word: as its key (stem), a nickname (names only) or a substring (unspaced text).
type Meaning = [key: string, weight: number, how: "word" | "nick" | "sub"];

export default defineStep({
  type: "memory/recall",
  description:
    "Search long-term memory. Returns small results: ref_id, name, node_type, a short description, and an edges count. " +
    "Facts come back as their sentence. Words match across forms, small typos and nicknames (Kate, Katherine). " +
    "Call memory/get on a ref_id for the full node. " +
    "For anything about the user themselves, memory/get with type 'Self' returns everything known about them.",
  input: z.object({
    q: z.string().describe("Plain words, e.g. 'Kate cooking' or 'my name'."),
    type: z.string().optional().describe("Comma-separated filter: entity types (Person, Topic, …) and/or 'Fact'."),
    limit: z.number().optional().default(10),
    include_expired: z.boolean().optional().default(false).describe("Also return facts that were superseded."),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    const query = await memoryDb(ctx);
    const types = cfg.type ? new Set(cfg.type.split(",").map((t) => t.trim())) : undefined;
    const all = words(cfg.q);
    const aboutSelf = all.some((w) => SELF.has(w));
    // Nothing but stop words ("who is it"): nothing to look for. A substring of them would find "the" in Katherine.
    const terms = [...new Set(all.filter((w) => !STOP.has(w)))];
    if (!terms.length) return [];
    // Words written with a capital: an everyday word that is also a short name (Bill, Will) means the name only then.
    const capitals = new Set(cfg.q.split(/[^\p{L}\p{N}'’]+/u).filter((t) => /^\p{Lu}/u.test(t)).flatMap((t) => words(t)));
    const docs: Doc[] = [];

    // Entities, with the text of their name facts ("Kate's full name is Katherine Moss") as more names.
    const entities = await query(
      `MATCH (e:Entity) WHERE e.deleted_at IS NULL
       OPTIONAL MATCH (f:Fact)-[]->(e) WHERE f.expired_at IS NULL AND f.deleted_at IS NULL
       RETURN e.ref_id AS ref_id, e.type AS type, e.name AS name, e.summary AS summary, e.aliases AS aliases, e.created_at AS at, count(f) AS facts,
              collect(CASE WHEN f.predicate = 'name' THEN f.text END) AS names`,
    );
    const selfIds = new Set(entities.filter((r) => r.type === "Self").map((r) => r.ref_id as string));
    // People's names, kept as written: stemming them would make Jones Jon and Fisher fish.
    const people = new Set(entities.filter((r) => r.type === "Person" || r.type === "Self")
      .flatMap((r) => words([r.name, ...(r.aliases ?? [])].join(" "))));
    const key = (w: string) => (people.has(w) ? w : stem(w));
    // Every word seen, with its key: typos are judged on words as written, then scored on the key.
    const seen = new Map<string, string>();
    const index = (text: string) => new Set(words(text).map((w) => {
      const k = key(w);
      seen.set(w, k);
      return k;
    }));
    if (!types || [...types].some((t) => t !== "Fact")) {
      for (const r of entities) {
        if (types && !types.has(r.type)) continue;
        const names = [r.name, ...(r.aliases ?? []), ...(r.names ?? []).filter(Boolean)].join(" ");
        docs.push({
          hit: { ref_id: r.ref_id, name: r.name, node_type: r.type, description: r.summary ?? "", edges: { FACTS: Number(r.facts) } },
          stems: index(`${names} ${r.summary ?? ""}`), names: new Set(words(names)), text: normalize(`${names} ${r.summary ?? ""}`), entity: true, self: r.type === "Self", at: Number(r.at), title: new Set(words(r.name)),
        });
      }
    }

    const facts: Row[] = types && !types.has("Fact") ? [] : await query(
      `MATCH (f:Fact)-[:SUBJECT]->(s:Entity) WHERE f.deleted_at IS NULL ${cfg.include_expired ? "" : "AND f.expired_at IS NULL"}
       OPTIONAL MATCH (f)-[:OBJECT]->(o:Entity)
       RETURN f.ref_id AS ref_id, f.text AS text, f.predicate AS predicate, f.valid_at AS valid_at, f.expired_at AS expired_at,
              s.ref_id AS s_id, s.name AS subject, s.aliases AS s_aliases, o.ref_id AS o_id, o.name AS object, o.aliases AS o_aliases`,
    );
    for (const r of facts) {
      const since = iso(r.valid_at)?.slice(0, 10);
      const description = `${r.subject} · ${r.predicate}${r.object ? ` → ${r.object}` : ""}${since ? ` · since ${since}` : ""}${r.expired_at != null ? " · superseded" : ""}`;
      const names = [r.subject, ...(r.s_aliases ?? []), r.object ?? "", ...(r.o_aliases ?? [])].join(" ");
      docs.push({
        hit: { ref_id: r.ref_id, name: r.text, node_type: "Fact", description, edges: {} },
        stems: index(`${r.text} ${String(r.predicate).replace(/_/g, " ")} ${names}`), names: new Set(words(names)), text: normalize(`${r.text} ${names}`),
        entity: false, predicate: r.predicate, subject: r.s_id, object: r.o_id ?? undefined,
        self: selfIds.has(r.s_id) || selfIds.has(r.o_id), at: Number(r.valid_at), title: new Set(),
      });
    }

    // Query words that name a predicate: its name's words and its aliases, as stems.
    const vocab = await query("MATCH (o:Ontology) WHERE o.kind = 'predicate' RETURN o.name AS name, o.aliases AS aliases");
    const predicateOf = new Map<string, Set<string>>();
    for (const p of vocab) {
      for (const w of words([p.name, ...(p.aliases ?? [])].join(" ").replace(/_/g, " "))) {
        if (STOP.has(w) || w.length < 3) continue;
        const set = predicateOf.get(stem(w)) ?? new Set<string>();
        predicateOf.set(stem(w), set.add(p.name));
      }
    }

    // How rare each stem is: a word on every node says little.
    const df = new Map<string, number>();
    for (const d of docs) for (const s of d.stems) df.set(s, (df.get(s) ?? 0) + 1);
    const idf = (s: string) => Math.log(1 + docs.length / (df.get(s) ?? 0.5));

    const subIdfs = new Map<string, number>();
    const subIdf = (w: string) => {
      let v = subIdfs.get(w);
      if (v === undefined) subIdfs.set(w, (v = Math.log(1 + docs.length / (docs.filter((d) => d.text.includes(w)).length || 0.5))));
      return v;
    };

    // Each query word's possible meanings, scored by the best one a node has.
    const meanings = terms.map((w) => {
      const s = key(w);
      const out: Meaning[] = [[s, EXACT, "word"]];
      if (unspaced(w)) out.push([w, EXACT, "sub"]);
      if (!ORDINARY.has(w) || capitals.has(w)) for (const n of nicknames(w)) out.push([n, NICK, "nick"]);
      for (const [raw, v] of seen) {
        if (v === s) continue;
        // The query word as the start of a longer one (renovat → renovation), never the other way round.
        if (s.length >= 5 && v.startsWith(s)) out.push([v, PREFIX, "word"]);
        else if (typo(raw, w)) out.push([v, TYPO, "word"]);
      }
      return { word: w, out, predicates: predicateOf.get(stem(w)) };
    });

    const scored: { doc: Doc; score: number }[] = [];
    for (const d of docs) {
      let score = 0;
      for (const m of meanings) {
        let best = 0;
        for (const [k, weight, how] of m.out) {
          if (how === "nick" ? d.names.has(k) : how === "sub" ? d.text.includes(k) : d.stems.has(k)) {
            best = Math.max(best, weight * (how === "sub" ? subIdf(k) : idf(how === "nick" ? key(k) : k)));
          }
        }
        if (d.predicate && m.predicates?.has(d.predicate)) best = Math.max(best, PREDICATE * idf(stem(m.word)) + 0.5);
        score += best;
      }
      if (!score) continue;
      if (aboutSelf && d.self) score *= 1.5;
      // An entity named by the query: more of its name matched ranks it above longer names (Lisbon over
      // Lisbon trip). Nickname hits count for the node, not for this.
      if (d.entity) {
        const hit = [...d.title].filter((w) => meanings.some((m) => m.out.some(([k, , how]) => how !== "nick" && (k === key(w) || k === w))));
        score += 0.5 + hit.length / Math.max(1, d.title.size);
      }
      scored.push({ doc: d, score });
    }

    // "who works with Kate": the facts sharing the object of the named entity's facts of that predicate.
    if (all.includes("with") && (!types || types.has("Fact"))) {
      const cued = new Set(meanings.flatMap((m) => [...(m.predicates ?? [])]));
      const named = new Set(scored.filter((s) => s.doc.entity).map((s) => s.doc.hit.ref_id as string));
      if (aboutSelf) for (const id of selfIds) named.add(id);
      const sharing = new Map<string, Doc[]>();
      for (const d of docs) {
        if (!d.predicate || !d.object || !cued.has(d.predicate)) continue;
        const k = `${d.predicate}\u0000${d.object}`;
        const list = sharing.get(k);
        if (list) list.push(d);
        else sharing.set(k, [d]);
      }
      const anchors = [...sharing.values()].flat().filter((d) => named.has(d.subject!));
      const top = scored.reduce((n, s) => Math.max(n, s.score), 0);
      const byDoc = new Map(scored.map((s) => [s.doc, s]));
      for (const a of anchors) {
        for (const d of sharing.get(`${a.predicate}\u0000${a.object}`)!) {
          if (d === a || named.has(d.subject!)) continue;
          const at = byDoc.get(d);
          if (at) at.score = Math.max(at.score, top + 0.1);
          else {
            const s = { doc: d, score: top + 0.1 };
            scored.push(s);
            byDoc.set(d, s);
          }
        }
      }
    }

    // Ties go to the newer node: the most recent of two equal answers is more likely current.
    const newer = (a: Doc, b: Doc) => b.at - a.at || String(b.hit.ref_id).localeCompare(String(a.hit.ref_id));
    return scored.sort((a, b) => b.score - a.score || newer(a.doc, b.doc)).slice(0, Math.max(1, cfg.limit)).map((s) => s.doc.hit);
  },
});
