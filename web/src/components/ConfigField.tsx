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
// A node-name typeahead (`FieldDesc.nodeType`, set by run-inputs.ts for an
// input a graph read resolves by name): the names of that type matching what
// was typed so far, via graph-search, debounced. Free text stays — a name the
// search does not know is submitted as typed — so a graphless deployment just
// gets no suggestions.
function useNodeSuggestions(nodeType: string | undefined, text: string): Suggestion[] | null {
  const [items, setItems] = useState<Suggestion[] | null>(null);
  useEffect(() => {
    if (!nodeType) {
      setItems(null);
      return;
    }
    const q = text.trim();
    if (!q) {
      setItems([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api.searchNodes(nodeType, q).then((hits) => {
        if (cancelled) return;
        setItems(hits.map((h) => ({ value: h.name, label: h.description ? `${h.name} — ${h.description.slice(0, 80)}` : h.name })));
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [nodeType, text]);
  return items;
}
// ── Config Field Renderer ──────────────────────────────────────────────────

// A select with `FieldDesc.other` (the builder's questions) ends in
// "Other…", which opens a text box: the typed text IS the value, so a value
// not among the options means the user answered in their own words. The
// sentinel is the select's own; it never reaches the value.
const OTHER = "\u0000other";

export function ConfigField(props: {
  field: api.FieldDesc;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const { field, value, onChange } = props;
  const label = `${field.label ?? humanize(field.name)}${field.required ? "" : " (optional)"}`;
  // Hooks run unconditionally; only string fields carry a `suggest` or a `nodeType`.
  const suggestions = useSuggestions(field.kind === "string" ? field.suggest : undefined);
  const nodeSuggestions = useNodeSuggestions(field.kind === "string" ? field.nodeType : undefined, typeof value === "string" ? value : "");
  // "Other…" chosen but nothing typed yet — indistinguishable from "no pick" by value alone.
  const [otherOpen, setOtherOpen] = useState(false);

  if (field.kind === "enum" && field.enumValues) {
    const current = value != null ? String(value) : (field.default != null ? String(field.default) : "");
    const own = !!field.other && (otherOpen || (current !== "" && !field.enumValues.includes(current)));
    return (
      <div class="flyout-field">
        <label title={field.description}>{label}</label>
        <select
          value={own ? OTHER : current}
          onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            setOtherOpen(v === OTHER);
            onChange(v === OTHER ? "" : v);
          }}
        >
          {!field.required && <option value="">--</option>}
          {field.enumValues.map((v) => (
            <option key={v} value={v}>{field.enumLabels?.[v] ?? v}</option>
          ))}
          {field.other && <option value={OTHER}>Other…</option>}
        </select>
        {own && (
          <input
            type="text"
            value={field.enumValues.includes(current) ? "" : current}
            placeholder="Your own answer"
            autoFocus
            onInput={(e) => onChange((e.target as HTMLInputElement).value)}
          />
        )}
      </div>
    );
  }

  // A checkbox list: the value is the picked subset, in `enumValues` order —
  // plus, with `other`, the user's own words as one last item.
  if (field.kind === "multi" && field.enumValues) {
    const items = Array.isArray(value) ? (value as string[]) : Array.isArray(field.default) ? (field.default as string[]) : [];
    const picked = new Set<string>(items);
    const ownText = items.find((v) => !field.enumValues!.includes(v)) ?? "";
    const own = !!field.other && (otherOpen || ownText !== "");
    const emit = (next: Set<string>, text: string) =>
      onChange([...field.enumValues!.filter((x) => next.has(x)), ...(text ? [text] : [])]);
    return (
      <div class="flyout-field">
        <label title={field.description}>{label}</label>
        <div class="flyout-multi">
          {field.enumValues.map((v) => (
            <label key={v} class="flyout-checkbox-label">
              <input
                type="checkbox"
                checked={picked.has(v)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if ((e.target as HTMLInputElement).checked) next.add(v);
                  else next.delete(v);
                  emit(next, ownText);
                }}
              />
              {field.enumLabels?.[v] ?? v}
            </label>
          ))}
          {field.other && (
            <label class="flyout-checkbox-label">
              <input
                type="checkbox"
                checked={own}
                onChange={(e) => {
                  const on = (e.target as HTMLInputElement).checked;
                  setOtherOpen(on);
                  if (!on) emit(picked, "");
                }}
              />
              Other…
            </label>
          )}
          {own && (
            <input
              type="text"
              value={ownText}
              placeholder="Your own answer"
              autoFocus
              onInput={(e) => emit(picked, (e.target as HTMLInputElement).value)}
            />
          )}
        </div>
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

  // Default: string (with a datalist when the field names a suggestion
  // catalog, or the names of the node type it looks up)
  const options = nodeSuggestions ?? suggestions;
  const listId = options ? `suggest-${field.name}` : undefined;
  const placeholder = field.default != null ? `default: ${field.default}` : field.nodeType ? `${field.nodeType} name` : undefined;
  return (
    <div class="flyout-field">
      <label title={field.description}>{label}</label>
      <input
        type="text"
        list={listId}
        value={value != null ? String(value) : ""}
        placeholder={placeholder}
        autocomplete={field.nodeType ? "off" : undefined}
        onInput={(e) => onChange((e.target as HTMLInputElement).value)}
      />
      {options && options.length > 0 && (
        <datalist id={listId}>
          {options.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </datalist>
      )}
    </div>
  );
}
