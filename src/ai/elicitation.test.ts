import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ELICITATION_PREFIX,
  callbackElicitation,
  describeField,
  formatElicitationResponse,
  newElicitationId,
  optionsOf,
  renderElicitationText,
  secretLikeProperty,
  secretUrl,
  validateContent,
  validateRequestedSchema,
  type ElicitationRecord,
  type RequestedSchema,
} from "./elicitation.js";

// One of every shape the ACP subset allows.
const FULL = {
  type: "object",
  properties: {
    repo: { type: "string", title: "Repository", minLength: 3, maxLength: 100, pattern: "^[\\w.-]+/[\\w.-]+$" },
    env: { type: "string", enum: ["staging", "production"], default: "staging" },
    region: { type: "string", oneOf: [{ const: "us", title: "United States" }, { const: "eu", title: "Europe" }] },
    contact: { type: "string", format: "email" },
    docs: { type: "string", format: "uri" },
    since: { type: "string", format: "date" },
    at: { type: "string", format: "date-time" },
    count: { type: "integer", minimum: 1, maximum: 10, default: 3 },
    ratio: { type: "number", minimum: 0, maximum: 1 },
    dryRun: { type: "boolean", default: true },
    channels: { type: "array", items: { type: "string", enum: ["a", "b", "c"] }, minItems: 1, maxItems: 2 },
    tags: { type: "array", items: { anyOf: [{ const: "x", title: "X" }, { const: "y" }] } },
  },
  required: ["repo", "env"],
};

describe("validateRequestedSchema", () => {
  it("accepts every shape of the subset", () => {
    const s = validateRequestedSchema(FULL);
    assert.deepEqual(Object.keys(s.properties), Object.keys(FULL.properties));
    assert.deepEqual(s.required, ["repo", "env"]);
  });

  const bad: [string, unknown, RegExp][] = [
    ["not an object", "x", /must be an object/],
    ["wrong root type", { type: "array", properties: {} }, /type must be "object"/],
    ["no properties", { type: "object", properties: {} }, /non-empty/],
    ["a nested object", { type: "object", properties: { a: { type: "object", properties: {} } } }, /properties\.a: type must be one of/],
    ["an unknown keyword", { type: "object", properties: { a: { type: "string", nullable: true } } }, /properties\.a: unsupported keyword "nullable"/],
    ["an unknown root keyword", { type: "object", properties: { a: { type: "string" } }, additionalProperties: false }, /unsupported keyword "additionalProperties"/],
    ["a bad format", { type: "object", properties: { a: { type: "string", format: "ipv4" } } }, /format must be one of/],
    ["a bad pattern", { type: "object", properties: { a: { type: "string", pattern: "(" } } }, /not a valid regular expression/],
    ["enum and oneOf together", { type: "object", properties: { a: { type: "string", enum: ["x"], oneOf: [{ const: "x" }] } } }, /not both/],
    ["an empty enum", { type: "object", properties: { a: { type: "string", enum: [] } } }, /non-empty array/],
    ["a duplicate enum", { type: "object", properties: { a: { type: "string", enum: ["x", "x"] } } }, /duplicate/],
    ["an array without items", { type: "object", properties: { a: { type: "array" } } }, /items is required/],
    ["array items of numbers", { type: "object", properties: { a: { type: "array", items: { type: "number", enum: [1] } } } }, /items.type must be string/],
    ["array items without options", { type: "object", properties: { a: { type: "array", items: { type: "string" } } } }, /exactly one of enum \| anyOf/],
    ["an array default outside its options", { type: "object", properties: { a: { type: "array", items: { enum: ["x"] }, default: ["z"] } } }, /default must be an array of the allowed values/],
    ["a required name that is not a property", { type: "object", properties: { a: { type: "string" } }, required: ["b"] }, /unknown property "b"/],
    ["a bad property name", { type: "object", properties: { "a b": { type: "string" } } }, /not a valid property name/],
    ["a mistyped default", { type: "object", properties: { a: { type: "integer", default: 1.5 } } }, /default must be an integer/],
    ["a mistyped minimum", { type: "object", properties: { a: { type: "number", minimum: "0" } } }, /minimum must be a number/],
  ];
  for (const [name, schema, re] of bad) {
    it(`rejects ${name}, naming it`, () => {
      assert.throws(() => validateRequestedSchema(schema), re);
    });
  }
});

describe("secretLikeProperty", () => {
  const withProp = (name: string, extra: object = {}): RequestedSchema =>
    ({ type: "object", properties: { [name]: { type: "string", ...extra } } }) as RequestedSchema;
  it("flags a credential-looking name or title", () => {
    assert.equal(secretLikeProperty(withProp("apiKey")), "apiKey");
    assert.equal(secretLikeProperty(withProp("slack_bot_token")), "slack_bot_token");
    assert.equal(secretLikeProperty(withProp("value", { title: "GitHub personal access token" })), "value");
    assert.equal(secretLikeProperty(withProp("pw", { title: "Password" })), "pw");
  });
  it("lets ordinary fields through", () => {
    assert.equal(secretLikeProperty(withProp("repo")), undefined);
    assert.equal(secretLikeProperty(validateRequestedSchema(FULL)), undefined);
  });
});

describe("validateContent", () => {
  const schema = validateRequestedSchema(FULL);
  it("accepts a full answer and returns only the schema's fields, in order", () => {
    const out = validateContent(schema, {
      env: "production",
      repo: "stakwork/strut",
      region: "eu",
      contact: "a@b.co",
      docs: "https://x.y/z",
      since: "2026-09-22",
      at: "2026-09-22T10:00:00Z",
      count: 4,
      ratio: 0.5,
      dryRun: false,
      channels: ["a", "c"],
      tags: ["x"],
    });
    assert.deepEqual(Object.keys(out), Object.keys(FULL.properties));
    assert.equal(out.env, "production");
  });
  it("treats missing content as empty, so required fields fail by name", () => {
    assert.throws(() => validateContent(schema, undefined), /content\.repo: is required/);
    assert.throws(() => validateContent(schema, { repo: "a/b", env: "" }), /content\.env: is required/);
  });
  it("skips optional empty fields", () => {
    assert.deepEqual(validateContent(schema, { repo: "a/b", env: "staging", ratio: null, contact: "" }), { repo: "a/b", env: "staging" });
  });
  const bad: [string, object, RegExp][] = [
    ["an unknown field", { repo: "a/b", env: "staging", extra: 1 }, /unknown field "extra"/],
    ["a wrong type", { repo: 5, env: "staging" }, /content\.repo: must be a string/],
    ["a pattern miss", { repo: "nope", env: "staging" }, /content\.repo: must match/],
    ["a value outside the enum", { repo: "a/b", env: "dev" }, /content\.env: must be one of staging \| production/],
    ["a value outside the oneOf", { repo: "a/b", env: "staging", region: "asia" }, /content\.region: must be one of us \| eu/],
    ["a bad email", { repo: "a/b", env: "staging", contact: "nope" }, /must be an email/],
    ["a bad uri", { repo: "a/b", env: "staging", docs: "not a url" }, /must be a URL/],
    ["a bad date", { repo: "a/b", env: "staging", since: "22/09/2026" }, /must be a date/],
    ["a bad date-time", { repo: "a/b", env: "staging", at: "2026-09-22" }, /must be an ISO date-time/],
    ["a non-integer", { repo: "a/b", env: "staging", count: 2.5 }, /must be an integer/],
    ["a number out of range", { repo: "a/b", env: "staging", count: 11 }, /must be ≤ 10/],
    ["a non-boolean", { repo: "a/b", env: "staging", dryRun: "yes" }, /must be true or false/],
    ["an array item outside its options", { repo: "a/b", env: "staging", channels: ["a", "z"] }, /every item must be one of a \| b \| c/],
    ["too many array items", { repo: "a/b", env: "staging", channels: ["a", "b", "c"] }, /pick at most 2/],
    ["too few array items", { repo: "a/b", env: "staging", channels: [] }, /pick at least 1/],
    ["duplicate array items", { repo: "a/b", env: "staging", channels: ["a", "a"] }, /duplicate/],
    ["a non-object", "x", /content: must be an object/],
  ];
  for (const [name, content, re] of bad) {
    it(`rejects ${name}, naming the field`, () => {
      assert.throws(() => validateContent(schema, content), re);
    });
  }
});

describe("formatElicitationResponse", () => {
  it("renders the form answer with who answered and the content as JSON", () => {
    assert.equal(
      formatElicitationResponse({ elicitationId: "e1", action: "accept", by: "alice-42", content: { repo: "a/b" } }),
      `${ELICITATION_PREFIX} e1 accept by alice-42\n{"repo":"a/b"}`,
    );
    assert.equal(formatElicitationResponse({ elicitationId: "e1", action: "accept" }), `${ELICITATION_PREFIX} e1 accept\n{}`);
  });
  it("renders a decline / cancel without content", () => {
    assert.equal(formatElicitationResponse({ elicitationId: "e1", action: "decline" }), `${ELICITATION_PREFIX} e1 decline`);
    assert.equal(formatElicitationResponse({ elicitationId: "e1", action: "cancel", by: "bob" }), `${ELICITATION_PREFIX} e1 cancel by bob`);
  });
  it("renders a secret by NAME only", () => {
    const stored = formatElicitationResponse({ elicitationId: "e1", action: "accept", by: "alice-42", secret: { name: "SLACK_BOT_TOKEN" } });
    assert.equal(stored, `${ELICITATION_PREFIX} e1 accept by alice-42 — secret SLACK_BOT_TOKEN stored (value not shown)`);
    assert.equal(
      formatElicitationResponse({ elicitationId: "e1", action: "decline", secret: { name: "SLACK_BOT_TOKEN" } }),
      `${ELICITATION_PREFIX} e1 decline — secret SLACK_BOT_TOKEN not stored`,
    );
  });
});

describe("the question as text", () => {
  const base = { elicitationId: "e1", toolCallId: "t1", turn: 2, createdAt: "2026-09-22T00:00:00Z" };
  it("describes each field on one line", () => {
    const s = validateRequestedSchema(FULL);
    assert.equal(describeField("repo", s.properties.repo!, true), 'repo "Repository" (string, required)');
    assert.equal(describeField("env", s.properties.env!, true), 'env (staging | production, required, default "staging")');
    assert.equal(describeField("channels", s.properties.channels!, false), "channels (any of a | b | c)");
    assert.equal(describeField("count", s.properties.count!, false), "count (integer, default 3)");
  });
  it("renders a form as the message plus its fields", () => {
    const rec: ElicitationRecord = {
      ...base,
      mode: "form",
      message: "Which repo?",
      requestedSchema: { type: "object", properties: { repo: { type: "string", description: "owner/name" } }, required: ["repo"] },
    };
    assert.equal(renderElicitationText(rec), "Which repo?\n- repo (string, required) — owner/name");
  });
  it("renders a secret request with the name, the reason and the link — never a value", () => {
    const rec: ElicitationRecord = { ...base, mode: "url", message: "to post to #alerts", name: "SLACK_BOT_TOKEN", url: secretUrl("c1", "e1"), exists: true };
    const text = renderElicitationText(rec);
    assert.ok(text.startsWith("The builder needs the secret SLACK_BOT_TOKEN (replacing the stored value): to post to #alerts"));
    assert.ok(text.includes("?chat=c1&elicit=e1"));
  });
  it("projects a record onto the callback without the scope fields", () => {
    const rec: ElicitationRecord = { ...base, mode: "url", message: "why", name: "K", url: "?chat=c1&elicit=e1", exists: false };
    assert.deepEqual(callbackElicitation(rec), { elicitationId: "e1", mode: "url", message: "why", name: "K", url: "?chat=c1&elicit=e1" });
    const form: ElicitationRecord = { ...base, mode: "form", message: "q", requestedSchema: { type: "object", properties: { a: { type: "boolean" } } } };
    assert.deepEqual(callbackElicitation(form), { elicitationId: "e1", mode: "form", message: "q", requestedSchema: form.requestedSchema });
  });
});

describe("ids and options", () => {
  it("ids are random, url-safe and long enough to be a capability", () => {
    const ids = new Set(Array.from({ length: 50 }, newElicitationId));
    assert.equal(ids.size, 50);
    for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  });
  it("the secret link is relative and escapes its parts", () => {
    assert.equal(secretUrl("c 1", "e/1"), "?chat=c%201&elicit=e%2F1");
  });
  it("optionsOf unifies enum, oneOf, items.enum and items.anyOf", () => {
    const s = validateRequestedSchema(FULL);
    assert.deepEqual(optionsOf(s.properties.env!), [{ const: "staging" }, { const: "production" }]);
    assert.deepEqual(optionsOf(s.properties.region!)?.map((o) => o.title), ["United States", "Europe"]);
    assert.deepEqual(optionsOf(s.properties.channels!)?.map((o) => o.const), ["a", "b", "c"]);
    assert.deepEqual(optionsOf(s.properties.tags!), [{ const: "x", title: "X" }, { const: "y" }]);
    assert.equal(optionsOf(s.properties.repo!), undefined);
    assert.equal(optionsOf(s.properties.count!), undefined);
  });
});
