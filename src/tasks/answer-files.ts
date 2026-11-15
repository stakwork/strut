/**
 * Files from a worker (plans/human-steps.md §5.6, item 8): a photo of a
 * court paper, a signed form — an answer that is a file. A task type opts
 * in with an `attachments` rule, an admin's as its answer schema and pay are;
 * `task/submit { attachments }` carries them in the chat's shape, decoded by
 * the chat's parser and held to its caps (src/ai/attachments.ts), then to the
 * type's rule; they are saved in the task's RUN's artifacts as
 * `tasks/<task id>/<name>`, where the `human` step's output names them and a
 * later agent's `attachments` list puts them on its prompt.
 */
import type { ArtifactsCapability } from "../capabilities.js";
import type { RunAttachment } from "../core.js";
import { freeName, MAX_ATTACHMENTS, parseAttachments, type Attachment } from "../ai/attachments.js";
import { RuleProblem } from "./task-tests.js";

/** A task type's rule for the files an answer carries (§5.6.1). */
export interface AttachmentRule {
  /** How many one answer may carry: 1 to `MAX_ATTACHMENTS`. */
  max: number;
  /** How many it must carry: 0 to `max`. */
  min: number;
  /** The media types it takes; `image/*` is a family. */
  types: string[];
}

/** What a model can see: images and PDFs. */
export const DEFAULT_ATTACHMENT_TYPES: readonly string[] = Object.freeze(["image/*", "application/pdf"]);
const DEFAULT_RULE: Readonly<AttachmentRule> = Object.freeze({ max: 1, min: 0, types: [...DEFAULT_ATTACHMENT_TYPES] });
const RULE_KEYS = new Set(Object.keys(DEFAULT_RULE));
const TYPES_MAX = 20;
const MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9.+-]*\/(?:\*|[a-z0-9][a-z0-9.+-]*)$/;

/** A type's `attachments` as saved: undefined (null or absent) takes no
 *  files; an object is the defaults (one file, none required, images and
 *  PDFs) with what staff set over them, every field checked. */
export function attachmentRuleOf(raw: unknown): AttachmentRule | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new RuleProblem("bad_request", "attachments is { max, min, types } — the files an answer carries — or null for none");
  for (const k of Object.keys(raw)) {
    if (!RULE_KEYS.has(k)) throw new RuleProblem("bad_request", `attachments.${k} is not an attachments rule (${[...RULE_KEYS].join(", ")})`);
  }
  const set = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)) as Partial<AttachmentRule>;
  const r = { ...DEFAULT_RULE, ...set };
  if (!Number.isSafeInteger(r.max) || r.max < 1 || r.max > MAX_ATTACHMENTS) throw new RuleProblem("bad_request", `attachments.max is a whole number from 1 to ${MAX_ATTACHMENTS}`);
  if (!Number.isSafeInteger(r.min) || r.min < 0 || r.min > r.max) throw new RuleProblem("bad_request", `attachments.min is a whole number from 0 to attachments.max (${r.max})`);
  if (!Array.isArray(r.types) || !r.types.length || r.types.length > TYPES_MAX) throw new RuleProblem("bad_request", `attachments.types is a list of 1 to ${TYPES_MAX} media types`);
  const types = r.types.map((t) => (typeof t === "string" ? t.trim().toLowerCase() : t));
  const bad = types.find((t) => typeof t !== "string" || !MEDIA_TYPE_RE.test(t));
  if (bad !== undefined) throw new RuleProblem("bad_request", `attachments.types: ${JSON.stringify(bad)} is not a media type (\`image/jpeg\`, or \`image/*\` for a family)`);
  return { max: r.max, min: r.min, types: [...new Set(types as string[])] };
}

/** Whether `mediaType` is one of `types` (`image/*` matching any image). */
export function takesType(types: readonly string[], mediaType: string): boolean {
  return types.some((t) => (t.endsWith("/*") ? mediaType.startsWith(t.slice(0, -1)) : t === mediaType));
}

/** An answer's `attachments` decoded and checked (§5.6.2): the chat's parser
 *  and caps, then the type's rule. Throws the first problem, as a sentence;
 *  nothing has been written. A type with no rule takes none. */
export function answerAttachments(type: string, rule: AttachmentRule | undefined, raw: unknown): Attachment[] {
  if (raw === undefined || raw === null || (Array.isArray(raw) && !raw.length)) {
    if (rule && rule.min > 0) throw new Error(`task type ${type} needs ${rule.min === 1 ? "a file" : `at least ${rule.min} files`} with each answer`);
    return [];
  }
  if (!rule) throw new Error(`task type ${type} takes no files with an answer`);
  const list = parseAttachments(raw);
  if (list.length > rule.max) throw new Error(`task type ${type} takes at most ${rule.max === 1 ? "one file" : `${rule.max} files`} with an answer; this one has ${list.length}`);
  if (list.length < rule.min) throw new Error(`task type ${type} needs at least ${rule.min} files with each answer; this one has ${list.length}`);
  const off = list.find((a) => !takesType(rule.types, a.mediaType));
  if (off) throw new Error(`task type ${type} takes ${rule.types.join(", ")}; ${off.name} is ${off.mediaType}`);
  return list;
}

/** The folder of a task's answers' files, under its run's artifacts. */
export function answerFilesDir(task: string): string {
  return `tasks/${task}`;
}

/** One `${runId}/${task}` saved at a time in this process, so two copies'
 *  answers never pick the same name. */
const saving = new Map<string, Promise<unknown>>();

/** An answer's files written into the task's run's artifacts (§5.6.3), as
 *  `tasks/<task id>/<name>`: a name already there numbered (`photo-2.jpg`),
 *  so an answer never overwrites another's. Returns what the lease and the
 *  `human` step record: never the bytes. */
export async function saveAnswerAttachments(artifacts: ArtifactsCapability, runId: string, task: string, list: Attachment[]): Promise<RunAttachment[]> {
  const key = `${runId}/${task}`;
  const before = saving.get(key) ?? Promise.resolve();
  const mine = before.catch(() => {}).then(async () => {
    const dir = `${answerFilesDir(task)}/`;
    const taken = new Set((await artifacts.list(runId)).filter((p) => p.startsWith(dir)).map((p) => p.slice(dir.length)));
    const saved: RunAttachment[] = [];
    for (const a of list) {
      const path = `${dir}${freeName(a.name, taken)}`;
      await artifacts.write(runId, path, a.bytes);
      saved.push({ name: a.name, mediaType: a.mediaType, size: a.bytes.length, path });
    }
    return saved;
  });
  saving.set(key, mine);
  try {
    return await mine;
  } finally {
    if (saving.get(key) === mine) saving.delete(key);
  }
}

/** The rule in a line, for the `task/set-type` card: "1 to 4 files (image/*)". */
export function attachmentRuleLine(rule: AttachmentRule): string {
  const n = rule.min === rule.max ? `${rule.max}` : `${rule.min} to ${rule.max}`;
  return `${n} ${rule.max === 1 ? "file" : "files"} (${rule.types.join(", ")}) with each answer`;
}
