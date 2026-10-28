// Word search over the memory graph, shared by memory/recall and the memory
// graph's reader (src/graph/memory/backend.ts). Leading underscore → skipped
// by registry discovery.
//
// Plain word matching over names and fact text, ranked by how many words hit.
// Fine at personal scale; Ladybug's full-text and vector indexes replace it later.
import type { StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { type Query, type Row, iso, normalize } from "./_db.js";
import { vocabulary } from "./_ontology.js";
import en from "./_lang-en.js";

const LANGS = new Map([["en", en]]);

/** The stop words of `STRUT_MEMORY_LANG` (secret store, then env; default en). Throws `invalid_config` for an unknown language. */
export async function stopWords(ctx?: StepContext<unknown>): Promise<Set<string>> {
  const code = (await (ctx?.services as Partial<StrutCapabilities> | undefined)?.secrets?.get("STRUT_MEMORY_LANG")) || "en";
  const lang = LANGS.get(code);
  if (!lang) throw new Error(`invalid_config: STRUT_MEMORY_LANG ${code} is not one of ${[...LANGS.keys()].join(", ")}`);
  return new Set(lang.stop);
}

export type MemoryHit = {
  score: number;
  ref_id: string;
  /** The entity's type, or "Fact". */
  node_type: string;
  name: string;
  description: string;
  /** Entities: how many current facts point at it. */
  facts?: number;
};

export type MemorySearch = {
  q: string;
  /** Entity types (as stored) and/or "Fact"; all when absent. */
  types?: Set<string>;
  stop: Set<string>;
  /** Also facts no longer held: superseded or ended (expired_at set). */
  includeExpired?: boolean;
  /** Also facts whose end in the world (invalid_at) has passed. Default true. */
  includeEnded?: boolean;
};

/** Every hit, best first. */
export async function searchMemory(query: Query, s: MemorySearch): Promise<MemoryHit[]> {
  const words = normalize(s.q).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !s.stop.has(w));
  const terms = words.length ? words : [normalize(s.q)];
  const score = (text: string) => terms.reduce((n, w) => n + (normalize(text).includes(w) ? 1 : 0), 0);
  const types = s.types;
  const now = Date.now();
  const hits: MemoryHit[] = [];

  if (!types || [...types].some((t) => t !== "Fact")) {
    // The user's entity also answers to its type's names (user, me, myself).
    const vocab = await vocabulary(query);
    const userType = vocab.userType();
    const userWords = userType ? [userType, ...(vocab.terms.find((t) => t.kind === "entity_type" && t.name === userType)?.aliases ?? [])].join(" ") : "";
    const rows = await query(
      `MATCH (e:Entity) WHERE e.deleted_at IS NULL
       OPTIONAL MATCH (f:Fact)-[]->(e) WHERE f.expired_at IS NULL AND f.deleted_at IS NULL
       RETURN e.ref_id AS ref_id, e.type AS type, e.name AS name, e.summary AS summary, e.aliases AS aliases, count(f) AS facts`,
    );
    for (const r of rows) {
      if (types && !types.has(r.type)) continue;
      const s = score(`${r.name} ${(r.aliases ?? []).join(" ")} ${r.summary ?? ""}${r.type === userType ? ` ${userWords}` : ""}`);
      if (s > 0) hits.push({ score: s + 0.5, ref_id: r.ref_id, node_type: r.type, name: r.name, description: r.summary ?? "", facts: Number(r.facts) });
    }
  }

  if (!types || types.has("Fact")) {
    const rows = await query(
      `MATCH (f:Fact)-[:SUBJECT]->(s:Entity) WHERE f.deleted_at IS NULL
       OPTIONAL MATCH (f)-[:OBJECT]->(o:Entity)
       RETURN f.ref_id AS ref_id, f.text AS text, f.predicate AS predicate, f.valid_at AS valid_at,
              f.invalid_at AS invalid_at, f.expired_at AS expired_at, s.name AS subject, o.name AS object`,
    );
    for (const r of rows) {
      if (r.expired_at != null && !s.includeExpired) continue;
      if (s.includeEnded === false && r.invalid_at != null && Number(r.invalid_at) <= now) continue;
      const n = score(`${r.text} ${r.predicate} ${r.subject} ${r.object ?? ""}`);
      if (n === 0) continue;
      hits.push({ score: n, ref_id: r.ref_id, node_type: "Fact", name: r.text, description: factLine(r) });
    }
  }

  return hits.sort((a, b) => b.score - a.score);
}

/** A fact in one line: subject · predicate → object, with its dates only when
 *  known; a fact no longer held is marked past. */
export function factLine(r: Row): string {
  const since = iso(r.valid_at)?.slice(0, 10);
  const until = iso(r.invalid_at)?.slice(0, 10);
  return `${r.subject} · ${r.predicate}${r.object ? ` → ${r.object}` : ""}${since ? ` · since ${since}` : ""}` +
    `${until ? ` · until ${until}` : ""}${r.expired_at != null ? " · past" : ""}`;
}
