import { z } from "zod";
import { defineStep } from "../../../core.js";
import { EntityRef, type EntityRefT, type Query, canonical, editAliases, memoryDb, memoryWrite, newRefId, normalize, supersede } from "./_db.js";
import { fitNote, resolve, termName, vocabulary, type Resolved as Term, type Vocabulary } from "./_ontology.js";

const FactInput = z.object({
  subject: EntityRef,
  predicate: z.string().min(1).describe("A predicate from graph/get-ontology, e.g. name, lives_in, works_on, prefers. A new one is kept as proposed."),
  text: z.string().describe("The fact as one plain sentence, e.g. \"The user's name is Tom.\""),
  object: EntityRef.optional().describe("The other entity, when the fact links two (Kate works_on Project X)."),
  supersede: z
    .boolean()
    .optional()
    .default(false)
    .describe("Replace the subject's current facts with this predicate. Automatic for one-value predicates such as name or lives_in."),
  valid_at: z.string().optional().describe("When it became true, only if the words say: an ISO date; '2026-09' or '2026' for a month or year."),
  invalid_at: z.string().optional().describe("When it stopped being true, only if the words say; same form as valid_at."),
  ended: z.boolean().optional().default(false).describe(
    "It is no longer true (\"I used to …\"): stored as past, superseding nothing; the same fact held now is ended.",
  ),
  value: z.string().optional().describe(
    "Only for a predicate with role mishearing (graph/get-ontology): the wrong text dictation writes for the subject, e.g. 'stack work'.",
  ),
  form: z.string().optional().describe(
    "Only with value: the written form the wrong text stands for when it is not the subject's name, e.g. 'BTC' on Bitcoin.",
  ),
});

/** An ISO date as epoch ms; a bare year or year-month means its first day, a time with no offset is UTC.
 *  Undefined when it is not a date, or not one on the calendar. */
function worldTime(given: string): number | undefined {
  const s = given.trim();
  const m = /^(\d{4})(?:-(\d{2}))?$/.exec(s);
  const date = m ? `${m[1]}-${m[2] ?? "01"}-01` : s.length > 10 && !/(Z|[+-]\d{2}(:?\d{2})?)$/i.test(s) ? `${s}Z` : s;
  if (!/^\d{4}-\d{2}-\d{2}/.test(date)) return undefined;
  // Date.parse rolls 2026-02-30 over to March: the calendar date, read on its
  // own, must come back as given. An offset may move the instant to another day.
  const day = date.slice(0, 10);
  const check = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(check) || new Date(check).toISOString().slice(0, 10) !== day) return undefined;
  const ms = Date.parse(date);
  return Number.isNaN(ms) ? undefined : ms;
}

type Resolved = { ref_id: string; type: string; name: string; status: "matched" | "created"; similar?: { ref_id: string; name: string }[] };

// A person's one-word alias ("kate", left by merging a Kate into Kate O'Brien) is only a first
// name: recall still finds her by it, but a write resolves it only to someone so named.
// A person is a type named as the user is, as in memory/duplicates.
const aliasResolves = (vocab: Vocabulary, type: string, key: string) => {
  const user = vocab.userType();
  return key.includes(" ") || !user || vocab.naming(type) !== vocab.naming(user);
};

// Matching, cheapest first: an explicit ref_id, the one entity of the user type, then the
// exact normalised name or (many-word) alias within the type, a name before an alias, then the oldest.
// Fuzzy and model matching come later; until then a new entity reports close names as `similar`.
async function find(query: Query, type: string, name: string): Promise<Resolved | undefined> {
  const vocab = await vocabulary(query);
  if (vocab.role(type) === "user") {
    const [hit] = await query("MATCH (e:Entity) WHERE e.type = $type AND e.deleted_at IS NULL RETURN e.ref_id AS ref_id, e.type AS type, e.name AS name LIMIT 1", { type });
    return hit && { ...(hit as Resolved), status: "matched" };
  }
  const key = normalize(name);
  const rows = (await query(
    `MATCH (e:Entity) WHERE e.type = $type AND e.deleted_at IS NULL AND (lower(e.name) = $key OR list_contains(e.aliases, $key))
     RETURN e.ref_id AS ref_id, e.type AS type, e.name AS name ORDER BY e.created_at`,
    { type, key },
  )) as Resolved[];
  const hit = rows.find((e) => normalize(e.name) === key) ?? (aliasResolves(vocab, type, key) ? rows[0] : undefined);
  return hit && { ...hit, status: "matched" };
}

async function resolveEntity(query: Query, ref: EntityRefT, type: string, createdBy: string, now: number): Promise<Resolved> {
  if (ref.ref_id) {
    const id = await canonical(query, ref.ref_id);
    const [hit] = await query("MATCH (e:Entity) WHERE e.ref_id = $id AND e.deleted_at IS NULL RETURN e.ref_id AS ref_id, e.type AS type, e.name AS name", { id });
    if (hit) return { ...(hit as Resolved), status: "matched" };
  }
  const hit = await find(query, type, ref.name);
  if (hit) return hit;

  const key = normalize(ref.name);
  const firstWord = key.split(" ")[0] ?? key;
  const similar = firstWord.length >= 3
    ? await query(
        `MATCH (e:Entity) WHERE e.type = $type AND e.deleted_at IS NULL AND (lower(e.name) CONTAINS $w OR list_contains(e.aliases, $key))
         RETURN e.ref_id AS ref_id, e.name AS name LIMIT 3`,
        { type, w: firstWord, key },
      )
    : [];
  const ref_id = newRefId();
  await query(
    `CREATE (:Entity {ref_id: $ref_id, type: $type, name: $name, summary: '', attributes: '{}', aliases: [$key],
             created_by: $by, created_at: $now, updated_at: $now})`,
    { ref_id, type, name: ref.name, key, by: createdBy, now },
  );
  return { ref_id, type, name: ref.name, status: "created", ...(similar.length ? { similar: similar as Resolved["similar"] } : {}) };
}

export default defineStep({
  type: "memory/remember",
  description:
    "Store something in long-term memory. Always pass the episode (what was said, as said). " +
    "List the entities it is about in `mentions`, and any facts worth keeping in `facts`. " +
    "Types and predicates are resolved through graph/get-ontology (aliases such as full_name → name); an unknown one is " +
    "kept as proposed and reported. A one-value predicate (name, lives_in) supersedes the current fact by itself. " +
    "Entities are matched by type and name, so the same person is never stored twice. " +
    "A name given as a name fact's object is never an entity: it becomes another name of the subject, unless another " +
    "entity already goes by it (that one is listed as `similar`, to merge if it is the same) or someone else says it " +
    "of the user. " +
    "A predicate with role mishearing (how dictation mishears its subject) takes the wrong text as `value`, and as " +
    "`form` the written form it stands for when that is not the subject's name; no object. It is never a name: " +
    "nothing is found or merged by it. " +
    "First-person words (I, my, me) mean the speaker: the user unless `speaker` says someone else, so Kate's " +
    "\"I moved to Leeds\" is a fact about Kate. Give a fact's dates only when the words do (\"since September\", " +
    "\"in 2024\"); saying the same fact again adds this episode as a source and fills in a missing date.",
  input: z.object({
    episode: z.string().describe("What was said or observed, in the speaker's words. Stored as the source of the facts."),
    speaker: EntityRef.optional().describe("Who said it, when not the user: e.g. Kate, in a message from Kate. Left out, it is the user."),
    source: z.string().optional().describe("Where it came from: a message id, chat id, run id or URL."),
    kind: z.enum(["message", "chat", "run", "note", "event"]).optional().default("chat"),
    created_by: z.string().optional().default("agent").describe("Who is writing: 'agent' or 'user'."),
    mentions: z.array(EntityRef).optional().default([]).describe("Entities the episode is about."),
    facts: z.array(FactInput).optional().default([]),
  }),
  output: z.any(),
  async run(cfg, ctx) {
    // Names that would be stored empty are refused before anything is written.
    const refs = [...(cfg.speaker ? [cfg.speaker] : []), ...cfg.mentions, ...cfg.facts.flatMap((f) => (f.object ? [f.subject, f.object] : [f.subject]))];
    const junk = [
      ...refs.filter((r) => !termName("entity_type", r.type)).map((r) => `type ${JSON.stringify(r.type)}`),
      ...cfg.facts.filter((f) => !termName("predicate", f.predicate)).map((f) => `predicate ${JSON.stringify(f.predicate)}`),
    ];
    if (junk.length) return { error: `invalid_input: ${junk.join(", ")} has no letters or digits` };
    const time = (s?: string) => (s === undefined ? null : worldTime(s));
    const dates = cfg.facts.map((f) => ({ valid_at: time(f.valid_at), invalid_at: time(f.invalid_at) }));
    const bad = cfg.facts.flatMap((f, i) => {
      const d = dates[i]!;
      return [
        ...(["valid_at", "invalid_at"] as const).filter((k) => d[k] === undefined).map((k) => `${k} ${JSON.stringify(f[k])} is not a date`),
        ...(d.valid_at != null && d.invalid_at != null && d.invalid_at < d.valid_at ? [`fact ${JSON.stringify(f.text)} ends before it starts`] : []),
      ];
    });
    if (bad.length) return { error: `invalid_input: ${bad.join(", ")}` };
    // A mishearing is a value on its subject, never an entity or a name: checked before anything is written.
    const known = await vocabulary(await memoryDb(ctx));
    const mishearing = (predicate: string) => known.term("predicate", predicate)?.role === "mishearing";
    const misheard = cfg.facts.flatMap((f) => {
      if (!mishearing(f.predicate)) return f.value !== undefined || f.form !== undefined ? [`${f.predicate} takes no value or form`] : [];
      return [...(!f.value?.trim() ? [`${f.predicate} needs the misheard text as value`] : []), ...(f.object ? [`${f.predicate} takes no object`] : [])];
    });
    if (misheard.length) return { error: `invalid_input: ${misheard.join(", ")}` };
    return memoryWrite(ctx, async (query) => {
      const now = Date.now();
      const by = cfg.created_by;
      const ontology = { resolved: [] as string[], proposed: [] as string[], notes: [] as string[] };
      const noteTerm = (r: Term) => {
        const label = `${r.term.kind === "entity_type" ? "type" : "predicate"} ${r.term.name}`;
        if (r.proposed) ontology.proposed.push(label);
        else if (r.given !== r.term.name) ontology.resolved.push(`${r.given} → ${r.term.name}`);
      };
      // A type that is only another spelling of the user's ("UserType", "User", "user type", "user-type")
      // means the user type (Self): mapped quietly, never proposed as a new type. Left to the
      // vocabulary alone, "UserType" is not an alias of Self, so the user's facts were stored on a node of
      // a new proposed type with no user role, and memory lookups of the user (user: true) found nothing.
      // Compared without case, spaces, underscores and hyphens, to the user type's name, its aliases, and user / usertype.
      const squash = (t: string) => t.toLowerCase().replace(/[\s_-]+/g, "");
      const typeOf = async (ref: EntityRefT) => {
        const v = await vocabulary(query);
        const userType = v.userType();
        const userTerm = userType ? v.terms.find((t) => t.kind === "entity_type" && t.name === userType) : undefined;
        const userNames = userTerm ? [userTerm.name, ...userTerm.aliases, "user", "usertype"].map(squash) : [];
        const r = await resolve(query, "entity_type", userNames.includes(squash(ref.type)) ? userType! : ref.type, by);
        noteTerm(r);
        return r.term.name;
      };

      // Resolved once per ref_id, so one entity given once by ref_id and once
      // by name is listed and linked once; `given` saves resolving again.
      // `listed` is what the episode mentions.
      const byId = new Map<string, Resolved>();
      const given = new Map<string, Resolved>();
      const listed = new Set<string>();
      const entity = async (ref: EntityRefT, list = true) => {
        const type = await typeOf(ref);
        const k = ref.ref_id ?? `${type}:${normalize(ref.name)}`;
        let e = given.get(k);
        if (!e) {
          const found = await resolveEntity(query, ref, type, by, now);
          e = byId.get(found.ref_id) ?? found;
          byId.set(e.ref_id, e);
          given.set(k, e);
        }
        if (list) listed.add(e.ref_id);
        return e;
      };

      // The episode mentions a speaker who is someone else; it mentions the
      // user only through a fact about them.
      const speaker = cfg.speaker ? await entity(cfg.speaker, false) : undefined;
      let vocab = await vocabulary(query);
      if (speaker && vocab.role(speaker.type) !== "user") listed.add(speaker.ref_id);
      const episodeId = newRefId();
      await query(
        `CREATE (:Episode {ref_id: $id, kind: $kind, source: $source, content: $content, occurred_at: $now,
                 created_by: $by, created_at: $now, updated_at: $now})`,
        { id: episodeId, kind: cfg.kind, source: cfg.source ?? "", content: cfg.episode, now, by },
      );
      const fromEpisode = (f: string) =>
        query("MATCH (x:Fact), (e:Episode) WHERE x.ref_id = $f AND e.ref_id = $e CREATE (x)-[:FROM_EPISODE]->(e)", { f, e: episodeId });

      // A name given as a name fact's object is not an entity, so the same name in mentions makes none either.
      const naming = (f: (typeof cfg.facts)[number]) => !!f.object && vocab.term("predicate", f.predicate)?.role === "alias";
      const typed = (r: EntityRefT) => `${vocab.term("entity_type", r.type)?.name ?? termName("entity_type", r.type)}:${normalize(r.name)}`;
      const names = new Set(cfg.facts.filter(naming).map((f) => typed(f.object!)));
      for (const ref of cfg.mentions) if (ref.ref_id || !names.has(typed(ref))) await entity(ref);
      const facts = [];
      for (const [i, f] of cfg.facts.entries()) {
        const valid = dates[i]!.valid_at ?? null;
        const invalid = dates[i]!.invalid_at ?? null;
        // A fact whose end is given and not in the future is past, as if `ended`.
        const past = f.ended || (invalid !== null && invalid <= now);
        const subject = await entity(f.subject);
        // Read again: resolving a type may have proposed one.
        vocab = await vocabulary(query);
        const fromOther = (e?: Resolved) => !!speaker && !!e && e.ref_id !== speaker.ref_id && vocab.role(e.type) === "user";
        // A name (a predicate with role alias) given as an object is never an
        // entity of its own. It becomes another name for the subject, unless
        // someone else says it of the user, or another entity of a related
        // type already goes by it (reported as `similar`, for a merge); the
        // user is one entity, so sharing a name with someone never stops it.
        let alias = naming(f) && !fromOther(subject) ? normalize(f.object!.name) : undefined;
        let similar: { ref_id: string; name: string }[] = [];
        if (alias && vocab.role(subject.type) === "user") await editAliases(query, subject.ref_id, [alias], now);
        else if (alias) {
          const lineage = vocab.terms.filter((t) => t.kind === "entity_type").map((t) => t.name)
            .filter((t) => vocab.ancestors(subject.type).includes(t) || vocab.ancestors(t).includes(subject.type))
            // Sharing a name with the user is not being them.
            .filter((t) => vocab.role(t) !== "user");
          const byAlias = aliasResolves(vocab, subject.type, alias);
          similar = ((await query(
            `MATCH (e:Entity) WHERE e.deleted_at IS NULL AND e.ref_id <> $id AND e.type IN $types
               AND (lower(e.name) = $key OR list_contains(e.aliases, $key))
             RETURN e.ref_id AS ref_id, e.name AS name ORDER BY e.created_at`,
            { id: subject.ref_id, types: [subject.type, ...lineage], key: alias },
          )) as typeof similar).filter((e) => byAlias || normalize(e.name) === alias).slice(0, 3);
          if (similar.length) alias = undefined;
          // A name replaced later stays an alias: an old name still finds them.
          else await editAliases(query, subject.ref_id, [alias], now);
        }
        const object = f.object && !naming(f) ? await entity(f.object) : undefined;
        const p = await resolve(query, "predicate", f.predicate, by, { subject: subject.type, object: object?.type });
        noteTerm(p);
        vocab = await vocabulary(query);
        const note = fitNote(vocab, p.term, subject.type, object?.type);
        if (note) ontology.notes.push(note);
        const predicate = p.term.name;
        // Kept as given. With no form, the name given is the form: it may be an alias the
        // subject was found by (BTC, on Bitcoin). NULL when it is the subject's name.
        const form = f.form?.trim() || f.subject.name.trim();
        const heard = p.term.role === "mishearing"
          ? { value: f.value!.trim(), form: normalize(form) !== normalize(subject.name) ? form : null }
          : undefined;
        // Said about the user (subject or object) by someone else: kept, and shown, not taken as the user's own word.
        const flag = fromOther(subject) || fromOther(object) ? { about_user_from: { ref_id: speaker!.ref_id, name: speaker!.name } } : {};
        const also = similar.length ? { similar } : {};

        // The same fact already held now, or, for a past one, held before:
        // add this episode as another source and fill in a date it was
        // missing, never one that would end it before it began. Said to be
        // past while held now, it stops being held.
        // A mishearing is the same when its text and form are, whatever its sentence.
        const same = async (held: boolean) => (await query(
          `MATCH (x:Fact)-[:SUBJECT]->(s:Entity) WHERE s.ref_id = $s AND x.predicate = $p AND ${heard ? "x.value IS NOT NULL" : "x.text = $t"}
             AND x.expired_at IS ${held ? "NULL" : "NOT NULL"} AND x.deleted_at IS NULL
           OPTIONAL MATCH (x)-[:OBJECT]->(o:Entity)
           WITH x, o WHERE ${object ? "o.ref_id = $o" : "o IS NULL"}
           RETURN x.ref_id AS ref_id, x.valid_at AS valid_at, x.invalid_at AS invalid_at, x.value AS value, x.form AS form`,
          { s: subject.ref_id, p: predicate, ...(heard ? {} : { t: f.text }), ...(object ? { o: object.ref_id } : {}) },
        )).find((x) => !heard || (normalize(x.value) === normalize(heard.value) && normalize(x.form ?? subject.name) === normalize(heard.form ?? subject.name)));
        const held = await same(true);
        const hit = held ?? (past ? await same(false) : undefined);
        if (hit) {
          await fromEpisode(hit.ref_id);
          // A name fact from before names were kept on the fact learns its name now.
          if (alias) await query("MATCH (x:Fact) WHERE x.ref_id = $f AND x.value IS NULL SET x.value = $value", { f: hit.ref_id, value: f.object!.name });
          const was = { valid: hit.valid_at == null ? null : Number(hit.valid_at), invalid: hit.invalid_at == null ? null : Number(hit.invalid_at) };
          const ending = !!held && past;
          const v = was.valid ?? (valid !== null && (was.invalid === null || valid <= was.invalid) ? valid : null);
          // Ending a held fact takes the end given now, and drops a planned
          // end still to come; otherwise only a missing one is filled.
          const end = ending ? invalid ?? (was.invalid !== null && was.invalid > now ? null : was.invalid) : was.invalid ?? invalid;
          const inv = end !== null && v !== null && end < v ? was.invalid : end;
          const filled = [...(v !== was.valid ? ["valid_at"] : []), ...(inv !== was.invalid ? ["invalid_at"] : [])];
          // A filled end that has passed stops the fact being held, as `ended` does.
          const expire = !!held && (ending || (inv !== null && inv <= now));
          if (filled.length || expire) {
            await query(
              `MATCH (x:Fact) WHERE x.ref_id = $f SET x.valid_at = $v, x.invalid_at = $inv, x.updated_at = $now
               ${expire ? ", x.expired_at = $now" : ""}`,
              { f: hit.ref_id, v, inv, now },
            );
          }
          facts.push({
            ref_id: hit.ref_id, text: f.text, predicate, status: "existing",
            ...(filled.length ? { filled } : {}), ...(expire ? { ended: true } : {}), ...flag, ...also,
          });
          continue;
        }

        // A current fact replaces the subject's current ones (one-value
        // predicate, or asked to), unless it began before one of them: then
        // it is history, ended when the earliest of those began.
        const replaces = !past && (f.supersede || p.term.cardinality === "one");
        const current = replaces
          ? await query(
              `MATCH (x:Fact)-[:SUBJECT]->(s:Entity) WHERE s.ref_id = $s AND x.predicate = $p
                 AND x.expired_at IS NULL AND x.deleted_at IS NULL
               RETURN x.ref_id AS ref_id, x.valid_at AS valid_at`,
              { s: subject.ref_id, p: predicate },
            )
          : [];
        const later = valid === null ? [] : current.map((r) => (r.valid_at == null ? null : Number(r.valid_at))).filter((t): t is number => t !== null && t > valid);
        const history = later.length > 0;
        const ended = past || history;

        const factId = newRefId();
        await query(
          `CREATE (:Fact {ref_id: $id, predicate: $p, text: $t, confidence: 1.0, valid_at: $valid, invalid_at: $invalid,
                   expired_at: $expired, created_by: $by, created_at: $now, updated_at: $now, value: $value, form: $form})`,
          { id: factId, p: predicate, t: f.text, value: alias ? f.object!.name : heard?.value ?? null, form: heard?.form ?? null, valid, invalid: history ? Math.min(...later, ...(invalid !== null ? [invalid] : [])) : invalid, expired: ended ? now : null, now, by },
        );
        await query("MATCH (x:Fact), (s:Entity) WHERE x.ref_id = $f AND s.ref_id = $s CREATE (x)-[:SUBJECT]->(s)", { f: factId, s: subject.ref_id });
        if (object) await query("MATCH (x:Fact), (o:Entity) WHERE x.ref_id = $f AND o.ref_id = $o CREATE (x)-[:OBJECT]->(o)", { f: factId, o: object.ref_id });
        await fromEpisode(factId);

        const superseded = ended ? [] : current.map((r) => r.ref_id as string);
        await supersede(query, factId, valid, superseded, now);
        facts.push({
          ref_id: factId, text: f.text, predicate, status: "created",
          ...(superseded.length ? { superseded } : {}), ...(ended ? { ended: true } : {}), ...flag, ...also,
        });
      }

      // A speaker left out is the user, when the user has an entity (made by
      // this remember or before); otherwise the episode's speaker stays NULL,
      // which means the user too.
      const userType = (await vocabulary(query)).userType();
      const said = speaker ?? (userType ? await find(query, userType, "") : undefined);
      if (said) await query("MATCH (ep:Episode) WHERE ep.ref_id = $ep SET ep.speaker = $s", { ep: episodeId, s: said.ref_id });
      for (const e of listed) {
        await query("MATCH (ep:Episode), (e:Entity) WHERE ep.ref_id = $ep AND e.ref_id = $e CREATE (ep)-[:MENTIONS]->(e)", { ep: episodeId, e });
      }
      const terms = Object.fromEntries(Object.entries(ontology).filter(([, v]) => v.length));
      return {
        episode: episodeId, ...(said ? { speaker: { ref_id: said.ref_id, name: said.name } } : {}),
        entities: [...listed].map((id) => byId.get(id)!), facts, ...(Object.keys(terms).length ? { ontology: terms } : {}),
      };
    });
  },
});
