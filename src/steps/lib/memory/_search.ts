// The word-scoring behind memory search, shared by memory/recall and the
// read-only memory graph (src/graph/memory/backend.ts), so both rank alike.
// Plain word matching over names and fact text, by how many words hit. Fine at
// personal scale; leading underscore: skipped by registry discovery.
import type { StepContext } from "../../../core.js";
import type { StrutCapabilities } from "../../../capabilities.js";
import { iso, normalize, type Query } from "./_db.js";
import en from "./_lang-en.js";

const LANGS = new Map([["en", en]]);

/** The stop words of `STRUT_MEMORY_LANG` (secret store, then env, like STRUT_MEMORY_DB).
 *  Throws `invalid_config: …` for a language there is no data for. */
export async function memoryStopWords(ctx: StepContext<unknown> | { services?: unknown }): Promise<Set<string>> {
  const code = (await (ctx.services as Partial<StrutCapabilities> | undefined)?.secrets?.get("STRUT_MEMORY_LANG")) || "en";
  const lang = LANGS.get(code);
  if (!lang) throw new Error(`invalid_config: STRUT_MEMORY_LANG ${code} is not one of ${[...LANGS.keys()].join(", ")}`);
  return new Set(lang.stop);
}

export interface Scored {
  score: number;
  kind: "entity" | "fact" | "episode";
  row: Record<string, any>;
}

export interface ScoreOptions {
  q: string;
  stop: Set<string>;
  /** Score entities; `entityTypes` narrows them to these exact types. */
  entities: boolean;
  entityTypes?: Set<string>;
  facts: boolean;
  /** Also facts no longer held: superseded or ended. */
  includeExpired?: boolean;
  episodes?: boolean;
}

/** Every entity, fact (and episode) of `query` that matches, best first. Deleted rows never match. */
export async function scoreMemory(query: Query, o: ScoreOptions): Promise<Scored[]> {
  const words = normalize(o.q).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !o.stop.has(w));
  const terms = words.length ? words : [normalize(o.q)];
  const score = (text: string) => terms.reduce((n, w) => n + (normalize(text).includes(w) ? 1 : 0), 0);
  const hits: Scored[] = [];

  if (o.entities) {
    const rows = await query(
      `MATCH (e:Entity) WHERE e.deleted_at IS NULL
       OPTIONAL MATCH (f:Fact)-[]->(e) WHERE f.expired_at IS NULL AND f.deleted_at IS NULL
       RETURN e.ref_id AS ref_id, e.type AS type, e.name AS name, e.summary AS summary, e.aliases AS aliases, count(f) AS facts`,
    );
    for (const r of rows) {
      if (o.entityTypes && !o.entityTypes.has(r.type)) continue;
      const s = score(`${r.name} ${(r.aliases ?? []).join(" ")} ${r.summary ?? ""}`);
      if (s > 0) hits.push({ score: s + 0.5, kind: "entity", row: r });
    }
  }

  if (o.facts) {
    const rows = await query(
      `MATCH (f:Fact)-[:SUBJECT]->(s:Entity) WHERE f.deleted_at IS NULL
       OPTIONAL MATCH (f)-[:OBJECT]->(o:Entity)
       RETURN f.ref_id AS ref_id, f.text AS text, f.predicate AS predicate, f.valid_at AS valid_at,
              f.invalid_at AS invalid_at, f.expired_at AS expired_at, s.name AS subject, o.name AS object`,
    );
    for (const r of rows) {
      if (r.expired_at != null && !o.includeExpired) continue;
      const s = score(`${r.text} ${r.predicate} ${r.subject} ${r.object ?? ""}`);
      if (s > 0) hits.push({ score: s, kind: "fact", row: r });
    }
  }

  if (o.episodes) {
    const rows = await query("MATCH (ep:Episode) WHERE ep.deleted_at IS NULL RETURN ep.ref_id AS ref_id, ep.content AS content");
    for (const r of rows) {
      const s = score(String(r.content ?? ""));
      if (s > 0) hits.push({ score: s, kind: "episode", row: r });
    }
  }
  return hits.sort((a, b) => b.score - a.score);
}

/** A fact as one line: subject · predicate → object, with dates only when known; past when no longer held. */
export function factDescription(r: Record<string, any>): string {
  const since = iso(r.valid_at)?.slice(0, 10);
  const until = iso(r.invalid_at)?.slice(0, 10);
  return `${r.subject} · ${r.predicate}${r.object ? ` → ${r.object}` : ""}${since ? ` · since ${since}` : ""}` +
    `${until ? ` · until ${until}` : ""}${r.expired_at != null ? " · past" : ""}`;
}
