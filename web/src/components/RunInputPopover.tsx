import { useEffect, useRef, useState } from "preact/hooks";
import { ConfigField } from "./ConfigField";
import { recentRunInput } from "../storage";
import type { InputBinding } from "../run-inputs";

// ── Run Input Popover ──────────────────────────────────────────────────────
//
// A small form anchored under the Run button: the workflow's inputs (inferred
// from every step's `{{ input.X }}` references — see run-inputs.ts) on top,
// its `params` knobs below. Field metadata for inputs is borrowed from the
// consuming step's own schema — the popover is just a typed pass-through.

export function RunInputPopover(props: {
  workflow: string;
  bindings: InputBinding[];
  /** The workflow's `params` defaults (tunable knobs), editable per run. */
  params?: Record<string, unknown> | null;
  /** Bindings came from a declared `input:` contract. Turns on the raw-JSON
   *  escape hatch and type-checks a stored recent-run value before seeding. */
  contract?: boolean;
  onSubmit: (input: Record<string, unknown>, params?: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    seedInputValues(props.workflow, props.bindings, props.contract === true),
  );
  // Raw JSON escape hatch — only for a declared contract. Off by default:
  // the form is the contract. On: one textarea, submitted as parsed JSON,
  // bypassing the fields. A workflow with no contract keeps today's path.
  const [rawMode, setRawMode] = useState(false);
  const [rawText, setRawText] = useState("{}");
  const [rawError, setRawError] = useState<string | null>(null);
  // Editable copy of the workflow's `params` knobs, seeded from defaults.
  // We diff against the defaults on submit and send only overridden keys.
  const paramDefaults = props.params ?? {};
  const paramKeys = Object.keys(paramDefaults);
  const [paramValues, setParamValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const k of paramKeys) init[k] = stringifyParam(paramDefaults[k]);
    return init;
  });
  const ref = useRef<HTMLDivElement>(null);

  // Click outside / Escape to close
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        props.onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    // Defer one tick so the same click that opened the popover doesn't close it
    const t = setTimeout(() => document.addEventListener("mousedown", onDocClick), 0);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [props.onClose]);

  const handleSubmit = () => {
    // Escape hatch: the textarea is the whole input. A parse failure stays
    // in the popover — nothing is submitted, and nothing is persisted.
    if (rawMode) {
      let parsed: unknown;
      try {
        parsed = rawText.trim() === "" ? {} : JSON.parse(rawText);
      } catch {
        setRawError("Input must be a JSON object.");
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setRawError("Input must be a JSON object.");
        return;
      }
      props.onSubmit(parsed as Record<string, unknown>, paramOverrides());
      return;
    }
    // Drop undefined/empty entries so the server sees omitted keys cleanly.
    // A required empty field fails server-side (`Input validation failed`).
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      if (v !== undefined && v !== "") clean[k] = v;
    }
    // A contract form persists only values that match the declared type, so
    // a stale string never comes back to fill a numeric field.
    recentRunInput.set(
      props.workflow,
      props.contract ? valuesMatchingContract(props.bindings, clean) : clean,
    );

    props.onSubmit(clean, paramOverrides());
  };

  /** Params the user actually changed, coerced back to the default's type.
   *  The server shallow-merges these over the workflow's `params` defaults. */
  const paramOverrides = (): Record<string, unknown> | undefined => {
    const overrides: Record<string, unknown> = {};
    for (const k of paramKeys) {
      const edited = paramValues[k] ?? "";
      if (edited === stringifyParam(paramDefaults[k])) continue;
      overrides[k] = coerceParam(edited, paramDefaults[k]);
    }
    return Object.keys(overrides).length > 0 ? overrides : undefined;
  };

  return (
    <div class="run-popover" ref={ref}>
      <div class="run-popover-title">
        <span>Run input</span>
        {props.contract && (
          <button
            type="button"
            class="run-popover-raw-toggle"
            onClick={() => {
              setRawError(null);
              setRawMode((on) => !on);
            }}
          >
            {rawMode ? "Use form" : "Edit JSON"}
          </button>
        )}
      </div>
      <div class="run-popover-body">
        {rawMode ? (
          <div class="run-popover-inputs">
            <textarea
              class="run-popover-raw"
              rows={6}
              value={rawText}
              spellcheck={false}
              onInput={(e) => {
                setRawError(null);
                setRawText((e.target as HTMLTextAreaElement).value);
              }}
            />
            {rawError && <div class="run-popover-raw-error">{rawError}</div>}
          </div>
        ) : props.bindings.length > 0 && (
          <div class="run-popover-inputs">
            <div class="run-popover-subtitle">Inputs</div>
            {props.bindings.map((b) => (
              <ConfigField
                key={b.inputKey}
                field={b.field}
                value={values[b.inputKey]}
                onChange={(v) => setValues((prev) => ({ ...prev, [b.inputKey]: v }))}
              />
            ))}
          </div>
        )}
        {paramKeys.length > 0 && (
          <div class="run-popover-params">
            <div class="run-popover-subtitle">Params</div>
            {paramKeys.map((k) => {
              const isMultiline =
                typeof paramDefaults[k] === "string" &&
                ((paramValues[k] ?? "").length > 40 || (paramValues[k] ?? "").includes("\n"));
              return (
                <label class="run-popover-param" key={k}>
                  <span class="run-popover-param-name">{k}</span>
                  {isMultiline ? (
                    <textarea
                      rows={4}
                      value={paramValues[k]}
                      onInput={(e) =>
                        setParamValues((prev) => ({ ...prev, [k]: (e.target as HTMLTextAreaElement).value }))
                      }
                    />
                  ) : (
                    <input
                      type="text"
                      value={paramValues[k]}
                      onInput={(e) =>
                        setParamValues((prev) => ({ ...prev, [k]: (e.target as HTMLInputElement).value }))
                      }
                    />
                  )}
                </label>
              );
            })}
          </div>
        )}
      </div>
      <div class="run-popover-actions">
        <button class="btn" onClick={props.onClose}>Cancel</button>
        <button class="btn btn-primary" onClick={handleSubmit}>Run</button>
      </div>
    </div>
  );
}

/** Seed the form: contract defaults, then a recent-run value only when it
 *  matches the field's declared type. A stale string for a now-numeric
 *  field falls back to the default (or empty) and is not re-persisted. */
export function seedInputValues(
  workflow: string,
  bindings: InputBinding[],
  contract: boolean,
): Record<string, unknown> {
  const init: Record<string, unknown> = {};
  for (const b of bindings) {
    if (b.field.default !== undefined) init[b.inputKey] = b.field.default;
  }
  const prior = recentRunInput.get(workflow);
  for (const b of bindings) {
    const stored = prior[b.inputKey];
    if (stored === undefined) continue;
    if (contract && !valueMatchesField(b.field.kind, stored)) continue;
    init[b.inputKey] = stored;
  }
  return init;
}

/** The subset of a submitted contract form worth remembering. A value that
 *  failed its type check is dropped, not stored. */
export function valuesMatchingContract(
  bindings: InputBinding[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const b of bindings) {
    const v = values[b.inputKey];
    if (v === undefined || v === "") continue;
    if (!valueMatchesField(b.field.kind, v)) continue;
    out[b.inputKey] = v;
  }
  return out;
}

/** string / finite number / boolean / plain JSON — the contract's types. */
export function valueMatchesField(kind: string, value: unknown): boolean {
  switch (kind) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "json":
      return isPlainJson(value);
    default:
      return true;
  }
}

function isPlainJson(v: unknown): boolean {
  if (v === null) return true;
  const t = typeof v;
  if (t === "string" || t === "boolean") return true;
  if (t === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(isPlainJson);
  if (v && typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(v as Record<string, unknown>).every(isPlainJson);
  }
  return false;
}

/** Render a param default as editable text. Objects/arrays become JSON. */
function stringifyParam(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return JSON.stringify(v, null, 2);
  return String(v);
}

/** Coerce an edited string back to the type of its default value. */
function coerceParam(edited: string, def: unknown): unknown {
  if (typeof def === "number") {
    const n = Number(edited);
    return Number.isNaN(n) ? edited : n;
  }
  if (typeof def === "boolean") return edited === "true";
  if (def != null && typeof def === "object") {
    try {
      return JSON.parse(edited);
    } catch {
      return edited;
    }
  }
  return edited;
}
