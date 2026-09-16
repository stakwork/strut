import { useEffect, useState } from "preact/hooks";
import * as api from "../api";
import { humanize } from "../helpers";

// Suggestion catalogs for free-text fields (`FieldDesc.suggest`) — fetched
// once per page and shared by every field that asks. The field stays free
// text: the datalist is a hint, not a constraint.
type Suggestion = { value: string; label: string };
const catalogs: Partial<Record<NonNullable<api.FieldDesc["suggest"]>, Promise<Suggestion[]>>> = {};
function loadSuggestions(kind: NonNullable<api.FieldDesc["suggest"]>): Promise<Suggestion[]> {
  return (catalogs[kind] ??= api
    .listLlmModels()
    .then((r) =>
      r.models.map((m) => ({
        value: m.name,
        label: `${m.alias} · ${m.provider}${m.available ? "" : ` (no ${r.keyNames[m.provider] ?? "key"})`}`,
      })),
    )
    .catch(() => []));
}
function useSuggestions(kind: api.FieldDesc["suggest"]): Suggestion[] | null {
  const [items, setItems] = useState<Suggestion[] | null>(null);
  useEffect(() => {
    if (!kind) {
      setItems(null);
      return;
    }
    let cancelled = false;
    loadSuggestions(kind).then((r) => {
      if (!cancelled) setItems(r);
    });
    return () => {
      cancelled = true;
    };
  }, [kind]);
  return items;
}
// ── Config Field Renderer ──────────────────────────────────────────────────

export function ConfigField(props: {
  field: api.FieldDesc;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const { field, value, onChange } = props;
  const label = `${humanize(field.name)}${field.required ? "" : " (optional)"}`;
  // Hooks run unconditionally; only string fields carry a `suggest`.
  const suggestions = useSuggestions(field.kind === "string" ? field.suggest : undefined);

  if (field.kind === "enum" && field.enumValues) {
    return (
      <div class="flyout-field">
        <label title={field.description}>{label}</label>
        <select
          value={value != null ? String(value) : (field.default != null ? String(field.default) : "")}
          onChange={(e) => onChange((e.target as HTMLSelectElement).value)}
        >
          {!field.required && <option value="">--</option>}
          {field.enumValues.map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
      </div>
    );
  }

  if (field.kind === "boolean") {
    const checked = value != null ? Boolean(value) : (field.default != null ? Boolean(field.default) : false);
    return (
      <div class="flyout-field">
        <label class="flyout-checkbox-label" title={field.description}>
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
          />
          {label}
        </label>
      </div>
    );
  }

  if (field.kind === "number") {
    return (
      <div class="flyout-field">
        <label title={field.description}>{label}</label>
        <input
          type="number"
          value={value != null ? String(value) : (field.default != null ? String(field.default) : "")}
          placeholder={field.default != null ? `default: ${field.default}` : undefined}
          onInput={(e) => {
            const raw = (e.target as HTMLInputElement).value;
            onChange(raw === "" ? undefined : Number(raw));
          }}
        />
      </div>
    );
  }

  if (field.kind === "json") {
    const display = value != null
      ? (typeof value === "string" ? value : JSON.stringify(value, null, 2))
      : "";
    return (
      <div class="flyout-field">
        <label title={field.description}>{label}</label>
        <textarea
          value={display}
          rows={4}
          placeholder="JSON or template expression"
          onInput={(e) => {
            const raw = (e.target as HTMLTextAreaElement).value;
            if (raw === "") { onChange(undefined); return; }
            try { onChange(JSON.parse(raw)); } catch { onChange(raw); }
          }}
        />
      </div>
    );
  }

  // Default: string (with a datalist when the field names a suggestion catalog)
  const listId = suggestions ? `suggest-${field.name}` : undefined;
  return (
    <div class="flyout-field">
      <label title={field.description}>{label}</label>
      <input
        type="text"
        list={listId}
        value={value != null ? String(value) : ""}
        placeholder={field.default != null ? `default: ${field.default}` : undefined}
        onInput={(e) => onChange((e.target as HTMLInputElement).value)}
      />
      {suggestions && suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </datalist>
      )}
    </div>
  );
}
