import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyLookups, bindingsFromInputBlock, deriveInputBindings, literalOf, nodeLookups, refsInExpr, stepTypesIn } from "./run-inputs";
import type { FieldDesc } from "./api";
import type { StepData } from "./flow-to-canvas";

const str = (name: string, required = true): FieldDesc => ({ name, kind: "string", required });
const schemas: Record<string, FieldDesc[]> = {
  "media/detect-type": [str("url")],
  "html/extract": [str("url"), { name: "maxChars", kind: "number", required: false, default: 40000 }],
  http: [str("url"), { name: "method", kind: "enum", required: false, enumValues: ["GET", "POST"] }],
  // graph-get's `name` names a node; its sibling `node_type` holds the type (FieldDesc.lookup).
  "graph/graph-get": [str("node_type", false), { ...str("name", false), lookup: { typeField: "node_type" } }],
};
const schemaFor = (t: string) => schemas[t];

const keys = (b: ReturnType<typeof deriveInputBindings>) => b.map((x) => x.inputKey);
const req = (b: ReturnType<typeof deriveInputBindings>) => b.filter((x) => x.field.required).map((x) => x.inputKey);

describe("refsInExpr", () => {
  it("bare reference is required", () => {
    assert.deepEqual(refsInExpr(" input.media_url "), [{ key: "media_url", optional: false }]);
  });
  it("guards make a reference optional", () => {
    for (const expr of [
      "input.ns || 'default'",
      "input.ns ?? 'default'",
      "input?.ns",
      "input.ns ? 'a' : 'b'",
      "input.ns?.deep",
      "other.x || input.ns",
      "other.x ?? input.ns",
    ]) {
      assert.deepEqual(refsInExpr(expr), [{ key: "ns", optional: true }], expr);
    }
  });
  it("reads bracket access", () => {
    assert.deepEqual(refsInExpr('input["media url"]'), [{ key: "media url", optional: false }]);
    assert.deepEqual(refsInExpr("input['x'] || 1"), [{ key: "x", optional: true }]);
  });
  it("does not match other identifiers ending in input", () => {
    assert.deepEqual(refsInExpr("evalInput.owner + subinput.x"), []);
  });
  it("collects every reference in a chain, in order", () => {
    assert.deepEqual(
      refsInExpr("input.title || yt?.title || input.media_url"),
      [
        { key: "title", optional: true },
        { key: "media_url", optional: true },
      ],
    );
  });
});

describe("deriveInputBindings", () => {
  // The shape of content-ingest-agentic-graph v6: an artifacts/dir step with no
  // config leads, and every input is consumed further down.
  const v6: StepData[] = [
    { id: "dir", type: "artifacts/dir", config: {} },
    { id: "register_ns", type: "graph/register-namespace", depends: [], config: { namespace: "{{ input.namespace || 'default' }}" } },
    { id: "detect", type: "media/detect-type", depends: [], config: { url: "{{ input.media_url }}" } },
    {
      id: "page",
      type: "html/extract",
      config: { url: "{{ input.media_url }}", maxChars: "{{ params.maxContentChars }}" },
      options: { onError: { id: "page_failed", type: "pack", config: { fetch_error: "{{ $error.message }}" } } },
    },
    {
      id: "content",
      type: "pack",
      config: { title: "{{ input.title || yt_meta?.body?.title || page?.title || input.media_url }}" },
    },
    {
      id: "docnode",
      type: "graph/create-node",
      config: { node_data: { source_link: "{{ input.media_url }}" }, namespace: "{{ input.namespace || 'default' }}" },
    },
    {
      id: "extract",
      type: "agent",
      config: {
        prompt:
          "media_url: {{ input.media_url }}\nDomain: {{ input.domain || '' }}\nHint: {{ input.context_hint || '(none provided)' }}\n" +
          "Use namespace \"{{ input.namespace || 'default' }}\" on every write.",
        model: "{{ params.model }}",
      },
    },
  ];

  it("finds inputs in every step, not just the first", () => {
    const b = deriveInputBindings(v6, schemaFor);
    assert.deepEqual(keys(b), ["media_url", "namespace", "title", "domain", "context_hint"]);
  });

  it("orders required keys first and marks guarded keys optional", () => {
    const b = deriveInputBindings(v6, schemaFor);
    assert.deepEqual(req(b), ["media_url"]);
    assert.equal(b.find((x) => x.inputKey === "namespace")!.field.required, false);
  });

  it("borrows the schema of the first exact-slot match", () => {
    const b = deriveInputBindings(v6, schemaFor);
    const url = b.find((x) => x.inputKey === "media_url")!.field;
    assert.equal(url.kind, "string");
    assert.equal(url.name, "media_url");
  });

  it("keeps a typed field's kind, default and enum values", () => {
    const steps: StepData[] = [
      { id: "a", type: "html/extract", config: { url: "https://x", maxChars: "{{ input.limit }}" } },
      { id: "b", type: "http", config: { url: "https://x", method: "{{ input.verb }}" } },
    ];
    const b = deriveInputBindings(steps, schemaFor);
    assert.deepEqual(b.map((x) => [x.inputKey, x.field.kind, x.field.required]), [
      ["limit", "number", false],
      ["verb", "enum", false],
    ]);
    assert.equal(b[0]!.field.default, 40000);
    assert.deepEqual(b[1]!.field.enumValues, ["GET", "POST"]);
  });

  it("an optional step slot becomes required if another step needs the key bare", () => {
    const steps: StepData[] = [
      { id: "a", type: "html/extract", config: { url: "https://x", maxChars: "{{ input.limit }}" } },
      { id: "b", type: "pack", config: { note: "limit is {{ input.limit }}" } },
    ];
    assert.deepEqual(req(deriveInputBindings(steps, schemaFor)), ["limit"]);
  });

  it("an unknown schema still surfaces the key, untyped and required when bare", () => {
    const steps: StepData[] = [{ id: "a", type: "custom/thing", config: { url: "{{ input.target }}" } }];
    const b = deriveInputBindings(steps, () => undefined);
    assert.deepEqual(b, [{ inputKey: "target", field: { name: "target", kind: "string", required: true } }]);
  });

  it("ignores prose outside {{ }} and params/step references", () => {
    const steps: StepData[] = [
      { id: "a", type: "agent", config: { prompt: "The workflow's input.media_url field. {{ params.model }} {{ detect.media_type }}" } },
    ];
    assert.deepEqual(deriveInputBindings(steps, schemaFor), []);
  });

  it("walks onError handlers and loop bodies", () => {
    const steps: StepData[] = [
      {
        id: "a",
        type: "http",
        config: { url: "https://x" },
        options: { onError: { id: "a_failed", type: "pack", config: { who: "{{ input.owner }}" } } },
      },
      {
        id: "l",
        type: "loop",
        config: { maxIterations: 3, body: { id: "poll", type: "http", config: { url: "{{ input.pollUrl }}" } } },
      },
    ];
    const b = deriveInputBindings(steps, schemaFor);
    assert.deepEqual(keys(b), ["owner", "pollUrl"]);
    assert.equal(b[1]!.field.kind, "string");
    assert.deepEqual(stepTypesIn(steps), ["http", "pack", "loop"]);
  });

  it("dedupes a key referenced by many steps", () => {
    const steps: StepData[] = [
      { id: "a", type: "pack", config: { x: "{{ input.k }}" } },
      { id: "b", type: "pack", config: { y: "{{ input.k || 1 }}", z: ["{{ input.k }}"] } },
    ];
    assert.deepEqual(keys(deriveInputBindings(steps, schemaFor)), ["k"]);
  });

  it("returns nothing for a flow without input references", () => {
    assert.deepEqual(deriveInputBindings([{ id: "dir", type: "artifacts/dir", config: {} }], schemaFor), []);
  });
});

describe("bindingsFromInputBlock", () => {
  it("maps the declared block to form fields, required unless defaulted or opted out", () => {
    const b = bindingsFromInputBlock({
      url: { type: "string", description: "where" },
      limit: { type: "number", default: 10 },
      dryRun: { type: "boolean", required: false },
    });
    assert.deepEqual(
      b.map((x) => [x.inputKey, x.field.kind, x.field.required, x.field.default, x.field.description]),
      [
        ["url", "string", true, undefined, "where"],
        ["limit", "number", false, 10, undefined],
        ["dryRun", "boolean", false, undefined, undefined],
      ],
    );
  });
});

describe("node lookups", () => {
  // graph-janitor: the mandate and the start, each read by name as a Concept.
  const janitor: StepData[] = [
    { id: "parent", type: "graph/graph-get", config: { node_type: "{{ params.node_type }}", name: "{{ params.parent }}", children: "PARENT_OF" } },
    { id: "mandate", type: "graph/graph-get", config: { node_type: "{{ params.node_type }}", name: "{{ input.concept }}" } },
    { id: "start", type: "graph/graph-get", config: { node_type: "Concept", name: "{{ input.start }}" } },
    { id: "note", type: "pack", config: { note: "sweeping {{ input.start }} for {{ input.concept }} as {{ input.actor }}" } },
  ];
  const params = { node_type: "Concept", parent: "Janitor" };

  it("literalOf: plain text, or a params reference the workflow answers; never an input or an expression", () => {
    assert.equal(literalOf("Concept", null), "Concept");
    assert.equal(literalOf("  ", null), undefined);
    assert.equal(literalOf("{{ params.node_type }}", params), "Concept");
    assert.equal(literalOf("{{ params.node_type }}", {}), undefined);
    assert.equal(literalOf("{{ params.limit }}", { limit: 10 }), undefined);
    assert.equal(literalOf("{{ input.t }}", params), undefined);
    assert.equal(literalOf("{{ params.node_type || 'Concept' }}", params), undefined);
    assert.equal(literalOf(42, params), undefined);
  });

  it("an input that graph-get resolves by name is typed by the literal sibling node_type, written out or through params", () => {
    const l = nodeLookups(janitor, schemaFor, params);
    assert.deepEqual([...l], [["concept", "Concept"], ["start", "Concept"]]);
    // Without params the first one cannot resolve; the literal one still can.
    assert.deepEqual([...nodeLookups(janitor, schemaFor, null)], [["start", "Concept"]]);
  });

  it("no lookup when the type is itself an input or an expression, when the slot is not exactly one input, or when the schema is unknown", () => {
    const steps: StepData[] = [
      { id: "a", type: "graph/graph-get", config: { node_type: "{{ input.t }}", name: "{{ input.x }}" } },
      { id: "b", type: "graph/graph-get", config: { node_type: "Concept", name: "{{ input.y }} (draft)" } },
      { id: "c", type: "graph/graph-get", config: { node_type: "Concept", name: "{{ input.z || 'Law' }}" } },
      { id: "d", type: "custom/get", config: { node_type: "Concept", name: "{{ input.w }}" } },
    ];
    assert.deepEqual([...nodeLookups(steps, schemaFor, params)], []);
  });

  it("the inferred form carries nodeType, whichever step typed the key first; the declared block gets it through applyLookups", () => {
    const b = deriveInputBindings(janitor, schemaFor, params);
    assert.deepEqual(b.map((x) => [x.inputKey, x.field.kind, x.field.nodeType]), [
      ["concept", "string", "Concept"],
      ["start", "string", "Concept"],
      ["actor", "string", undefined],
    ]);
    const block = applyLookups(
      bindingsFromInputBlock({ concept: { type: "string" }, start: { type: "string", description: "where" }, apply: { type: "boolean", default: false } }),
      nodeLookups(janitor, schemaFor, params),
    );
    assert.deepEqual(block.map((x) => [x.inputKey, x.field.nodeType, x.field.description]), [
      ["concept", "Concept", undefined],
      ["start", "Concept", "where"],
      ["apply", undefined, undefined],
    ]);
    // A key some other step typed first still gets its node type.
    const later: StepData[] = [
      { id: "a", type: "http", config: { url: "{{ input.x }}" } },
      { id: "b", type: "graph/graph-get", config: { node_type: "Concept", name: "{{ input.x }}" } },
    ];
    assert.equal(deriveInputBindings(later, schemaFor)[0]!.field.nodeType, "Concept");
    // Only a free-text field is a name: a number stays a number.
    assert.equal(applyLookups([{ inputKey: "n", field: { name: "n", kind: "number", required: true } }], new Map([["n", "Concept"]]))[0]!.field.nodeType, undefined);
  });
});
