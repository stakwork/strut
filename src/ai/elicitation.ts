import { randomBytes } from "node:crypto";

/**
 * Elicitation — the builder asks the user (plans/elicitation.md). The pure
 * half: the ACP form-mode schema subset and its validator, the guard against
 * collecting a secret through a form, the ids, the `[elicitation-response]`
 * message the answer arrives as, and the text a host reads when a turn ends
 * on an ask. Nothing in here touches a store; createStrut wires the rest.
 *
 * Shapes follow the ACP elicitation RFD (adapted from MCP's): `mode`,
 * `message`, `requestedSchema` (a FLAT object of primitives), `action:
 * accept | decline | cancel`, `content`, `elicitationId`. A secret is never
 * form mode: `request_secret` is URL mode, and the value is typed into a
 * strut page that writes the store — the model only ever sees the NAME.
 */

export const ELICITATION_PREFIX = "[elicitation-response]";
export const ELICITATION_TOOLS: ReadonlySet<string> = new Set(["ask_user", "request_secret"]);

/**
 * The chat agent's stop condition: the last step's tool RESULTS include an
 * ask that opened a question — the turn ends there, a complete call with its
 * result, and the answer arrives as the next turn's message. A refused ask
 * (a schema outside the subset, a credential-looking field) returns
 * `{ error }` instead and does NOT end the turn: the model reads the error
 * and tries again, which `hasToolCall` would not allow.
 */
export function stepAsked(step: { toolResults?: ReadonlyArray<{ toolName: string; output: unknown }> } | undefined): boolean {
  return !!step?.toolResults?.some(
    (r) => ELICITATION_TOOLS.has(r.toolName) && (r.output as { status?: unknown } | null)?.status === "asked",
  );
}

export type ElicitationAction = "accept" | "decline" | "cancel";
export const ELICITATION_ACTIONS: readonly ElicitationAction[] = ["accept", "decline", "cancel"];

// ── The requested-schema subset ────────────────────────────────────────────

export interface EnumOption {
  const: string;
  title?: string;
  description?: string;
}

interface Common {
  title?: string;
  description?: string;
}

export interface StringSchema extends Common {
  type: "string";
  default?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: "email" | "uri" | "date" | "date-time";
  /** Single select, plain values … */
  enum?: string[];
  /** … or with titles. Exclusive with `enum`. */
  oneOf?: EnumOption[];
}

export interface NumberSchema extends Common {
  type: "number" | "integer";
  default?: number;
  minimum?: number;
  maximum?: number;
}

export interface BooleanSchema extends Common {
  type: "boolean";
  default?: boolean;
}

/** Multi select: an array of one of a fixed set of strings. */
export interface ArraySchema extends Common {
  type: "array";
  default?: string[];
  items: { type?: "string"; enum?: string[]; anyOf?: EnumOption[] };
  minItems?: number;
  maxItems?: number;
}

export type PrimitiveSchema = StringSchema | NumberSchema | BooleanSchema | ArraySchema;

export interface RequestedSchema {
  type: "object";
  properties: Record<string, PrimitiveSchema>;
  required?: string[];
}

// ── Records ────────────────────────────────────────────────────────────────

interface ElicitationBase {
  elicitationId: string;
  /** ACP's scope binding: the chat (session) + the tool call that asked. */
  toolCallId: string;
  /** The turn that asked. */
  turn: number;
  createdAt: string;
  /** Shown to the user above the form; for a secret, why it is needed. */
  message: string;
}

/** The open elicitation on a chat (`ChatMeta.elicitation`). One per chat. */
export type ElicitationRecord = ElicitationBase &
  (
    | { mode: "form"; requestedSchema: RequestedSchema }
    | {
        mode: "url";
        /** The secret-store NAME. */
        name: string;
        /** RELATIVE to the UI: `?chat=…&elicit=…`. A host resolves it. */
        url: string;
        /** The name is already in the store — the form says "replace". */
        exists: boolean;
      }
  );

/** What a tool hands the host to open one (the host adds id, turn, time, url). */
export type ElicitationRequest = { toolCallId: string; message: string } & (
  | { mode: "form"; requestedSchema: RequestedSchema }
  | { mode: "url"; name: string; exists: boolean }
);

/** What a host hears on the turn callback. Never a value. */
export type ElicitationCallback = { elicitationId: string; mode: "form" | "url"; message: string } & (
  | { requestedSchema: RequestedSchema }
  | { name: string; url: string }
);

/** With the deployment key unset the link IS the authorization to write
 *  one named secret, so the id is never a counter or a timestamp. */
export function newElicitationId(): string {
  return randomBytes(16).toString("base64url");
}

export function secretUrl(chatId: string, elicitationId: string): string {
  return `?chat=${encodeURIComponent(chatId)}&elicit=${encodeURIComponent(elicitationId)}`;
}

export function callbackElicitation(rec: ElicitationRecord): ElicitationCallback {
  const base = { elicitationId: rec.elicitationId, mode: rec.mode, message: rec.message };
  return rec.mode === "form" ? { ...base, requestedSchema: rec.requestedSchema } : { ...base, name: rec.name, url: rec.url };
}

// ── Schema validation ──────────────────────────────────────────────────────

const FORMATS = new Set(["email", "uri", "date", "date-time"]);
const KEYS: Record<PrimitiveSchema["type"], Set<string>> = {
  string: new Set(["type", "title", "description", "default", "minLength", "maxLength", "pattern", "format", "enum", "oneOf"]),
  number: new Set(["type", "title", "description", "default", "minimum", "maximum"]),
  integer: new Set(["type", "title", "description", "default", "minimum", "maximum"]),
  boolean: new Set(["type", "title", "description", "default"]),
  array: new Set(["type", "title", "description", "default", "items", "minItems", "maxItems"]),
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function fail(where: string, what: string): never {
  throw new Error(`${where}: ${what}`);
}

function checkOptions(where: string, raw: unknown, kind: "enum" | "anyOf" | "oneOf"): string[] {
  if (!Array.isArray(raw) || raw.length === 0) fail(where, `${kind} must be a non-empty array`);
  const out: string[] = [];
  for (const o of raw) {
    if (kind === "enum") {
      if (typeof o !== "string") fail(where, "enum values must be strings");
      out.push(o);
    } else {
      if (!isObj(o) || typeof o.const !== "string") fail(where, `${kind} entries must be { const: string, title?: string }`);
      for (const k of Object.keys(o)) if (!["const", "title", "description"].includes(k)) fail(where, `${kind} entry has unsupported keyword "${k}"`);
      out.push(o.const);
    }
  }
  if (new Set(out).size !== out.length) fail(where, `${kind} has duplicate values`);
  return out;
}

function checkCommon(where: string, s: Record<string, unknown>): void {
  if (s.title !== undefined && typeof s.title !== "string") fail(where, "title must be a string");
  if (s.description !== undefined && typeof s.description !== "string") fail(where, "description must be a string");
}

function checkInt(where: string, s: Record<string, unknown>, key: string, min = 0): void {
  const v = s[key];
  if (v === undefined) return;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) fail(where, `${key} must be an integer ≥ ${min}`);
}

function checkProperty(where: string, raw: unknown): PrimitiveSchema {
  if (!isObj(raw)) fail(where, "must be a schema object");
  const type = raw.type;
  if (typeof type !== "string" || !(type in KEYS)) {
    fail(where, `type must be one of string | number | integer | boolean | array (nested objects are not supported)`);
  }
  const allowed = KEYS[type as PrimitiveSchema["type"]];
  for (const k of Object.keys(raw)) if (!allowed.has(k)) fail(where, `unsupported keyword "${k}" for type ${type}`);
  checkCommon(where, raw);
  switch (type) {
    case "string": {
      if (raw.default !== undefined && typeof raw.default !== "string") fail(where, "default must be a string");
      checkInt(where, raw, "minLength");
      checkInt(where, raw, "maxLength");
      if (raw.pattern !== undefined) {
        if (typeof raw.pattern !== "string") fail(where, "pattern must be a string");
        try {
          new RegExp(raw.pattern, "u");
        } catch {
          fail(where, "pattern is not a valid regular expression");
        }
      }
      if (raw.format !== undefined && (typeof raw.format !== "string" || !FORMATS.has(raw.format))) {
        fail(where, "format must be one of email | uri | date | date-time");
      }
      if (raw.enum !== undefined && raw.oneOf !== undefined) fail(where, "use enum or oneOf, not both");
      if (raw.enum !== undefined) checkOptions(where, raw.enum, "enum");
      if (raw.oneOf !== undefined) checkOptions(where, raw.oneOf, "oneOf");
      return raw as unknown as StringSchema;
    }
    case "number":
    case "integer": {
      for (const k of ["default", "minimum", "maximum"]) {
        if (raw[k] !== undefined && (typeof raw[k] !== "number" || !Number.isFinite(raw[k]))) fail(where, `${k} must be a number`);
      }
      if (type === "integer" && raw.default !== undefined && !Number.isInteger(raw.default)) fail(where, "default must be an integer");
      return raw as unknown as NumberSchema;
    }
    case "boolean": {
      if (raw.default !== undefined && typeof raw.default !== "boolean") fail(where, "default must be a boolean");
      return raw as unknown as BooleanSchema;
    }
    default: {
      const items = raw.items;
      if (!isObj(items)) fail(where, "items is required for type array");
      for (const k of Object.keys(items)) if (!["type", "enum", "anyOf"].includes(k)) fail(where, `items has unsupported keyword "${k}"`);
      if (items.type !== undefined && items.type !== "string") fail(where, "items.type must be string");
      if ((items.enum === undefined) === (items.anyOf === undefined)) fail(where, "items needs exactly one of enum | anyOf");
      const opts = items.enum !== undefined ? checkOptions(where, items.enum, "enum") : checkOptions(where, items.anyOf, "anyOf");
      checkInt(where, raw, "minItems");
      checkInt(where, raw, "maxItems");
      if (raw.default !== undefined) {
        if (!Array.isArray(raw.default) || raw.default.some((d) => typeof d !== "string" || !opts.includes(d))) {
          fail(where, "default must be an array of the allowed values");
        }
      }
      return raw as unknown as ArraySchema;
    }
  }
}

/** Check a model's `requestedSchema` against the subset. Throws naming the
 *  offending property, so the tool error tells the model what to change. */
export function validateRequestedSchema(raw: unknown): RequestedSchema {
  const where = "requestedSchema";
  if (!isObj(raw)) fail(where, "must be an object");
  if (raw.type !== "object") fail(where, 'type must be "object"');
  for (const k of Object.keys(raw)) if (!["type", "properties", "required"].includes(k)) fail(where, `unsupported keyword "${k}"`);
  if (!isObj(raw.properties) || Object.keys(raw.properties).length === 0) fail(where, "properties must be a non-empty object");
  const properties: Record<string, PrimitiveSchema> = {};
  for (const [name, s] of Object.entries(raw.properties)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail(`${where}.properties`, `"${name}" is not a valid property name`);
    properties[name] = checkProperty(`${where}.properties.${name}`, s);
  }
  let required: string[] | undefined;
  if (raw.required !== undefined) {
    if (!Array.isArray(raw.required) || raw.required.some((r) => typeof r !== "string")) fail(where, "required must be an array of property names");
    for (const r of raw.required as string[]) if (!(r in properties)) fail(where, `required names unknown property "${r}"`);
    required = raw.required as string[];
  }
  return { type: "object", properties, ...(required ? { required } : {}) };
}

/** The allowed values of a select (single or multi), else undefined. */
export function optionsOf(s: PrimitiveSchema): EnumOption[] | undefined {
  if (s.type === "string") {
    if (s.enum) return s.enum.map((v) => ({ const: v }));
    if (s.oneOf) return s.oneOf;
    return undefined;
  }
  if (s.type === "array") return s.items.enum ? s.items.enum.map((v) => ({ const: v })) : s.items.anyOf;
  return undefined;
}

/** ACP: an agent MUST NOT collect a credential through a form. A property
 *  whose name or title reads like one is refused; `request_secret` is the
 *  door. Returns the offending property name, else undefined. Heuristic. */
export const SECRET_LIKE_RE = /password|secret|token|api[_ -]?key|private[_ -]?key|credential/i;
export function secretLikeProperty(schema: RequestedSchema): string | undefined {
  for (const [name, s] of Object.entries(schema.properties)) {
    if (SECRET_LIKE_RE.test(name) || (s.title && SECRET_LIKE_RE.test(s.title))) return name;
  }
  return undefined;
}

// ── Content validation ─────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

function checkFormat(where: string, format: NonNullable<StringSchema["format"]>, v: string): void {
  switch (format) {
    case "email":
      if (!EMAIL_RE.test(v)) fail(where, "must be an email address");
      return;
    case "uri":
      try {
        new URL(v);
      } catch {
        fail(where, "must be a URL");
      }
      return;
    case "date":
      if (!DATE_RE.test(v) || Number.isNaN(Date.parse(v))) fail(where, "must be a date (YYYY-MM-DD)");
      return;
    case "date-time":
      if (!DATE_TIME_RE.test(v) || Number.isNaN(Date.parse(v))) fail(where, "must be an ISO date-time");
      return;
  }
}

function checkValue(where: string, s: PrimitiveSchema, v: unknown): unknown {
  switch (s.type) {
    case "string": {
      if (typeof v !== "string") fail(where, "must be a string");
      const opts = optionsOf(s);
      if (opts) {
        if (!opts.some((o) => o.const === v)) fail(where, `must be one of ${opts.map((o) => o.const).join(" | ")}`);
        return v;
      }
      if (s.minLength !== undefined && v.length < s.minLength) fail(where, `must be at least ${s.minLength} characters`);
      if (s.maxLength !== undefined && v.length > s.maxLength) fail(where, `must be at most ${s.maxLength} characters`);
      if (s.pattern !== undefined && !new RegExp(s.pattern, "u").test(v)) fail(where, `must match ${s.pattern}`);
      if (s.format) checkFormat(where, s.format, v);
      return v;
    }
    case "number":
    case "integer": {
      if (typeof v !== "number" || !Number.isFinite(v)) fail(where, "must be a number");
      if (s.type === "integer" && !Number.isInteger(v)) fail(where, "must be an integer");
      if (s.minimum !== undefined && v < s.minimum) fail(where, `must be ≥ ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) fail(where, `must be ≤ ${s.maximum}`);
      return v;
    }
    case "boolean":
      if (typeof v !== "boolean") fail(where, "must be true or false");
      return v;
    case "array": {
      if (!Array.isArray(v)) fail(where, "must be an array");
      const allowed = (optionsOf(s) ?? []).map((o) => o.const);
      for (const item of v) if (typeof item !== "string" || !allowed.includes(item)) fail(where, `every item must be one of ${allowed.join(" | ")}`);
      if (new Set(v).size !== v.length) fail(where, "has duplicate items");
      if (s.minItems !== undefined && v.length < s.minItems) fail(where, `pick at least ${s.minItems}`);
      if (s.maxItems !== undefined && v.length > s.maxItems) fail(where, `pick at most ${s.maxItems}`);
      return v;
    }
  }
}

/** Check a submitted `content` against the stored schema. Throws naming the
 *  field (a 400 at the endpoint). Returns the content with only the schema's
 *  properties, in schema order. */
export function validateContent(schema: RequestedSchema, raw: unknown): Record<string, unknown> {
  const content = raw === undefined ? {} : raw;
  if (!isObj(content)) fail("content", "must be an object");
  for (const k of Object.keys(content)) if (!(k in schema.properties)) fail("content", `unknown field "${k}"`);
  const out: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(schema.properties)) {
    const v = content[name];
    if (v === undefined || v === null || v === "") {
      if (schema.required?.includes(name)) fail(`content.${name}`, "is required");
      continue;
    }
    out[name] = checkValue(`content.${name}`, s, v);
  }
  return out;
}

// ── The response message ───────────────────────────────────────────────────

export interface ElicitationResponse {
  elicitationId: string;
  action: ElicitationAction;
  /** The request actor, when there was one — recorded, never checked. */
  by?: string;
  /** Form mode, `accept`: the validated content. */
  content?: Record<string, unknown>;
  /** URL mode: the secret's NAME. The value is never here. */
  secret?: { name: string };
}

/**
 * The user-role message the answer arrives as — one of the wake-up family
 * (`[run-notification]`, `[verify-notification]`): the model reads it as the
 * answer to the tool call it made, by id; the flyout shows a notice card.
 *
 *   [elicitation-response] <id> accept by alice-42
 *   {"repo":"stakwork/strut"}
 *
 *   [elicitation-response] <id> accept by alice-42 — secret SLACK_BOT_TOKEN stored (value not shown)
 *   [elicitation-response] <id> decline
 */
export function formatElicitationResponse(r: ElicitationResponse): string {
  let head = `${ELICITATION_PREFIX} ${r.elicitationId} ${r.action}`;
  if (r.by) head += ` by ${r.by}`;
  if (r.secret) {
    head += r.action === "accept" ? ` — secret ${r.secret.name} stored (value not shown)` : ` — secret ${r.secret.name} not stored`;
    return head;
  }
  return r.action === "accept" ? `${head}\n${JSON.stringify(r.content ?? {})}` : head;
}

// ── The question as text ───────────────────────────────────────────────────

/** One line per field for a host or a person: `env (staging | production, required)`. */
export function describeField(name: string, s: PrimitiveSchema, required: boolean): string {
  const opts = optionsOf(s)?.map((o) => o.const);
  const kind = s.type === "array" ? `any of ${opts!.join(" | ")}` : opts ? opts.join(" | ") : s.type;
  const parts = [kind];
  if (required) parts.push("required");
  if (s.default !== undefined) parts.push(`default ${JSON.stringify(s.default)}`);
  const label = s.title ? `${name} "${s.title}"` : name;
  return `${label} (${parts.join(", ")})${s.description ? ` — ${s.description}` : ""}`;
}

/**
 * The callback's `text` when a turn ends on an ask: a host that predates
 * the `elicitation` field — or anything that only reads text — still sees
 * the question, and a prose reply through POST /chat answers it.
 */
export function renderElicitationText(rec: ElicitationRecord): string {
  if (rec.mode === "url") {
    return [
      `The builder needs the secret ${rec.name}${rec.exists ? " (replacing the stored value)" : ""}: ${rec.message}`,
      `Add it at ${rec.url} — the value goes straight into the secret store. Never paste it into the chat.`,
    ].join("\n");
  }
  const lines = [rec.message];
  for (const [name, s] of Object.entries(rec.requestedSchema.properties)) {
    lines.push(`- ${describeField(name, s, !!rec.requestedSchema.required?.includes(name))}`);
  }
  return lines.join("\n");
}
