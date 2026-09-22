import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import * as api from "../api";
import { ClockIcon, CloseIcon } from "../icons";
import { ConfigField } from "./ConfigField";
import type { InputBinding } from "../run-inputs";
import {
  DAYS,
  DAY_LABEL,
  NOW_TOKEN,
  TODAY_TOKEN,
  cleanInput,
  emptyTriggerForm,
  formFromTrigger,
  isTemplate,
  lastOutputToken,
  relativeTime,
  timeZoneOptions,
  triggerFromForm,
  type Repeat,
  type TriggerForm,
} from "../automation-form";
import { humanize } from "../helpers";

// ── Automations panel (a Workflow flyout tab) ──────────────────────────────
//
// Run this workflow on a schedule (plans/automations.md). Two states: the
// LIST of this workflow's automations, and the EDITOR for one (reported up
// through `onEditingChange`, so the flyout's footer yields to the editor's
// own action bar). An automation is workflow metadata — saving, pausing or
// deleting one never publishes a version. The form holds no calendar math: the sentence and the "next runs"
// list under it come from the server, which is what a person checks a rule
// against.

const REPEATS: { value: Repeat; label: string }[] = [
  { value: "interval", label: "Every few minutes or hours" },
  { value: "day", label: "Every day" },
  { value: "week", label: "On certain days of the week" },
  { value: "month", label: "Every month" },
  { value: "once", label: "Just once" },
];

const NTH: { value: TriggerForm["nth"]; label: string }[] = [
  { value: 1, label: "first" },
  { value: 2, label: "second" },
  { value: 3, label: "third" },
  { value: 4, label: "fourth" },
  { value: "last", label: "last" },
];

const DAY_NAME: Record<api.Day, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^\/[^:]*: /, "");

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function AutomationsPanel(props: {
  workflow: string;
  /** Resolve the workflow's run inputs (same inference as the Run popover). */
  loadBindings: () => Promise<InputBinding[]>;
  onOpenRun: (workflow: string, runId: string) => void;
  /** The set changed — the parent refreshes the sidebar's clock badges. */
  onChanged: () => void;
  onEditingChange?: (editing: boolean) => void;
}) {
  const [list, setList] = useState<api.AutomationView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** null = list; "new" or an automation = editor. */
  const [editing, setEditing] = useState<api.AutomationView | "new" | null>(null);
  useEffect(() => {
    props.onEditingChange?.(editing != null);
    return () => props.onEditingChange?.(false);
  }, [editing]);

  const refresh = useCallback(async () => {
    try {
      setList(await api.listAutomations(props.workflow));
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  }, [props.workflow]);

  useEffect(() => {
    void refresh();
    // A running automation settles on its own: keep the list honest.
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
    } catch (err) {
      setError(message(err));
    }
    await refresh();
    props.onChanged();
  };

  return (
    <>
      {editing ? (
        <AutomationEditor
          key={editing === "new" ? "new" : editing.id}
          workflow={props.workflow}
          automation={editing === "new" ? null : editing}
          loadBindings={props.loadBindings}
          onSaved={async () => {
            setEditing(null);
            await refresh();
            props.onChanged();
          }}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <div class="flyout-body">
          <div class="flyout-section">
            <span class="auto-hint">
              Run this workflow on a schedule. Schedules are settings, not versions — adding, changing or pausing one never
              publishes the workflow. They only fire while strut is running.
            </span>
          </div>
          {error && <div class="auto-error">{error}</div>}
          {list === null && !error && <div class="auto-hint">Loading…</div>}
          {list?.length === 0 && <div class="auto-empty">No automations yet.</div>}
          {list?.map((a) => (
            <div class={`auto-card${a.enabled ? "" : " is-paused"}`} key={a.id}>
              <div class="auto-card-head">
                <button class="auto-name" onClick={() => setEditing(a)} title="Edit">{a.name}</button>
                <label class="auto-toggle" title={a.enabled ? "Pause" : "Resume"}>
                  <input
                    type="checkbox"
                    checked={a.enabled}
                    onChange={(e) => act(() => api.updateAutomation(props.workflow, a.id, { enabled: (e.target as HTMLInputElement).checked }))}
                  />
                  <span>{a.enabled ? "On" : "Paused"}</span>
                </label>
              </div>
              <div class="auto-summary"><ClockIcon size={12} /> {a.summary}</div>
              <div class="auto-meta">
                {a.enabled && a.nextRunAt && <span title={when(a.nextRunAt)}>Next run {relativeTime(a.nextRunAt)}</span>}
                {a.enabled && !a.nextRunAt && <span>No more runs scheduled</span>}
                {a.lastRun && (
                  <button class="auto-link" onClick={() => props.onOpenRun(props.workflow, a.lastRun!.runId)}>
                    Last run <span class={`badge badge-${a.lastRun.status === "success" ? "ok" : a.lastRun.status === "running" ? "accent" : a.lastRun.status === "error" ? "danger" : "warning"}`}>{a.lastRun.status}</span>
                  </button>
                )}
              </div>
              {a.lastFireError && <div class="auto-error">The last scheduled run could not start: {a.lastFireError}</div>}
              <div class="auto-card-actions">
                <button class="btn" disabled={a.running} title={a.running ? "Its previous run is still going" : "Run once, right now"}
                  onClick={() => act(() => api.fireAutomation(props.workflow, a.id))}>Run now</button>
                <button class="btn" onClick={() => setEditing(a)}>Edit</button>
                <button class="btn btn-danger" onClick={() => { if (confirm(`Delete "${a.name}"?`)) void act(() => api.deleteAutomation(props.workflow, a.id)); }}>Delete</button>
              </div>
            </div>
          ))}
          <button class="btn btn-primary auto-new" onClick={() => setEditing("new")}>New automation</button>
        </div>
      )}
    </>
  );
}

// ── Editor ─────────────────────────────────────────────────────────────────

function AutomationEditor(props: {
  workflow: string;
  automation: api.AutomationView | null;
  loadBindings: () => Promise<InputBinding[]>;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const existing = props.automation;
  const [name, setName] = useState(existing?.name ?? "");
  const [form, setForm] = useState<TriggerForm>(() => (existing ? formFromTrigger(existing.trigger) : emptyTriggerForm()));
  const [input, setInput] = useState<Record<string, unknown>>(() => ({ ...(existing?.input ?? {}) }));
  const [bindings, setBindings] = useState<InputBinding[] | null>(null);
  const [preview, setPreview] = useState<{ summary: string; next: string[] } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** Keys of the last successful run's output — what "from the last run" offers. */
  const [lastKeys, setLastKeys] = useState<string[]>([]);

  const set = (patch: Partial<TriggerForm>) => setForm((f) => ({ ...f, ...patch }));
  const zones = useMemo(() => timeZoneOptions(form.tz), [form.tz]);
  const built = useMemo(() => triggerFromForm(form), [form]);

  useEffect(() => {
    props.loadBindings().then(setBindings).catch(() => setBindings([]));
  }, []);

  // What could `last.output` hold? Look at the newest successful run.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const runs = await api.listRuns(props.workflow);
        const out = runs.find((r) => r.status === "success")?.output;
        if (!cancelled && out && typeof out === "object" && !Array.isArray(out)) setLastKeys(Object.keys(out as object));
      } catch {
        // no suggestions — the field still accepts a typed token
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.workflow]);

  // Live preview, debounced: the sentence + the next five runs, from the server.
  const seq = useRef(0);
  useEffect(() => {
    if ("problem" in built) {
      setPreview(null);
      setPreviewError(built.problem);
      return;
    }
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      try {
        const p = await api.previewAutomation(built.trigger);
        if (mine === seq.current) {
          setPreview(p);
          setPreviewError(null);
        }
      } catch (err) {
        if (mine === seq.current) {
          setPreview(null);
          setPreviewError(message(err));
        }
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [built]);

  // Input keys: what the workflow reads, plus anything already stored.
  const keys = useMemo(() => {
    const fromBindings = (bindings ?? []).map((b) => b.inputKey);
    return [...new Set([...fromBindings, ...Object.keys(input)])];
  }, [bindings, input]);

  const save = async () => {
    if ("problem" in built) return;
    if (!name.trim()) {
      setSaveError("Give it a name.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const draft = { name: name.trim(), trigger: built.trigger, input: cleanInput(input) };
      if (existing) await api.updateAutomation(props.workflow, existing.id, draft);
      else await api.createAutomation(props.workflow, draft);
      props.onSaved();
    } catch (err) {
      setSaveError(message(err));
      setSaving(false);
    }
  };

  const toggleDay = (list: api.Day[], day: api.Day) => (list.includes(day) ? list.filter((d) => d !== day) : [...list, day]);
  const dayChips = (selected: api.Day[], onChange: (next: api.Day[]) => void) => (
    <div class="auto-days">
      {DAYS.map((d) => (
        <button type="button" key={d} class={`auto-day${selected.includes(d) ? " is-on" : ""}`} onClick={() => onChange(toggleDay(selected, d))}>
          {DAY_LABEL[d]}
        </button>
      ))}
    </div>
  );

  const times = (
    <div class="flyout-field">
      <label>At</label>
      <div class="auto-times">
        {form.at.map((t, i) => (
          <span class="auto-time" key={i}>
            <input type="time" value={t} onInput={(e) => set({ at: form.at.map((x, j) => (j === i ? (e.target as HTMLInputElement).value : x)) })} />
            {form.at.length > 1 && (
              <button type="button" class="auto-x" aria-label="Remove time" onClick={() => set({ at: form.at.filter((_, j) => j !== i) })}><CloseIcon size={10} /></button>
            )}
          </span>
        ))}
        <button type="button" class="auto-link" onClick={() => set({ at: [...form.at, "17:00"] })}>+ another time</button>
      </div>
    </div>
  );

  return (
    <>
      <div class="flyout-body">
        <div class="flyout-field">
          <label>Name</label>
          <input type="text" value={name} placeholder="e.g. Morning digest" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </div>

        <div class="flyout-section-title">When</div>
        <div class="flyout-field">
          <label>Repeat</label>
          <select value={form.repeat} onChange={(e) => set({ repeat: (e.target as HTMLSelectElement).value as Repeat })}>
            {REPEATS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>

        {form.repeat === "interval" && (
          <>
            <div class="flyout-field">
              <label>Every</label>
              <div class="auto-row">
                <input type="number" min={1} value={form.gap} onInput={(e) => set({ gap: Number((e.target as HTMLInputElement).value) })} />
                <select value={form.gapUnit} onChange={(e) => set({ gapUnit: (e.target as HTMLSelectElement).value as TriggerForm["gapUnit"] })}>
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                </select>
              </div>
            </div>
            <label class="auto-check">
              <input type="checkbox" checked={form.limitDays} onChange={(e) => set({ limitDays: (e.target as HTMLInputElement).checked })} />
              Only on certain days
            </label>
            {form.limitDays && dayChips(form.intervalDays, (intervalDays) => set({ intervalDays }))}
            <label class="auto-check">
              <input type="checkbox" checked={form.limitHours} onChange={(e) => set({ limitHours: (e.target as HTMLInputElement).checked })} />
              Only between certain hours
            </label>
            {form.limitHours && (
              <div class="auto-row auto-between">
                <input type="time" value={form.between[0]} onInput={(e) => set({ between: [(e.target as HTMLInputElement).value, form.between[1]] })} />
                <span>and</span>
                <input type="time" value={form.between[1]} onInput={(e) => set({ between: [form.between[0], (e.target as HTMLInputElement).value] })} />
              </div>
            )}
          </>
        )}

        {form.repeat === "week" && (
          <div class="flyout-field">
            <label>On</label>
            {dayChips(form.weekDays, (weekDays) => set({ weekDays }))}
          </div>
        )}

        {form.repeat === "month" && (
          <div class="flyout-field">
            <label>On</label>
            <select value={form.monthMode} onChange={(e) => set({ monthMode: (e.target as HTMLSelectElement).value as TriggerForm["monthMode"] })}>
              <option value="day">A day of the month</option>
              <option value="last">The last day of the month</option>
              <option value="weekday">A weekday (e.g. the last Friday)</option>
            </select>
            {form.monthMode === "day" && (
              <div class="auto-row auto-sub">
                <span>Day</span>
                <select value={String(form.monthDay)} onChange={(e) => set({ monthDay: Number((e.target as HTMLSelectElement).value) })}>
                  {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={String(d)}>{d}</option>)}
                </select>
              </div>
            )}
            {form.monthMode === "weekday" && (
              <div class="auto-row auto-sub">
                <span>The</span>
                <select value={String(form.nth)} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; set({ nth: v === "last" ? "last" : (Number(v) as 1 | 2 | 3 | 4) }); }}>
                  {NTH.map((n) => <option key={String(n.value)} value={String(n.value)}>{n.label}</option>)}
                </select>
                <select value={form.weekday} onChange={(e) => set({ weekday: (e.target as HTMLSelectElement).value as api.Day })}>
                  {DAYS.map((d) => <option key={d} value={d}>{DAY_NAME[d]}</option>)}
                </select>
              </div>
            )}
          </div>
        )}

        {(form.repeat === "day" || form.repeat === "week" || form.repeat === "month") && times}

        {form.repeat === "once" && (
          <div class="flyout-field">
            <label>On</label>
            <input type="datetime-local" value={form.onceAt} onInput={(e) => set({ onceAt: (e.target as HTMLInputElement).value })} />
          </div>
        )}

        <div class="flyout-field">
          <label>Time zone</label>
          <select value={form.tz} onChange={(e) => set({ tz: (e.target as HTMLSelectElement).value })}>
            {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
          </select>
        </div>

        <div class="auto-preview">
          {preview ? (
            <>
              <div class="auto-preview-summary">{preview.summary}</div>
              <div class="auto-preview-title">Next runs</div>
              {preview.next.length === 0 && <div class="auto-hint">This schedule has no runs ahead of it.</div>}
              <ol class="auto-next">
                {preview.next.map((iso) => <li key={iso}>{when(iso)} <span class="auto-rel">{relativeTime(iso)}</span></li>)}
              </ol>
            </>
          ) : (
            <div class="auto-hint">{previewError ?? "…"}</div>
          )}
        </div>

        <div class="flyout-section-title">With these inputs</div>
        {bindings === null && <div class="auto-hint">Loading…</div>}
        {bindings !== null && keys.length === 0 && <div class="auto-hint">This workflow takes no inputs.</div>}
        {keys.map((key) => {
          const binding = bindings?.find((b) => b.inputKey === key);
          const field: api.FieldDesc = binding?.field ?? ({ name: key, kind: "string", required: false } as api.FieldDesc);
          const value = input[key];
          const setValue = (v: unknown) => setInput((prev) => ({ ...prev, [key]: v }));
          return (
            <div class="auto-input" key={key}>
              {isTemplate(value) ? (
                <div class="flyout-field">
                  <label>{humanize(key)}</label>
                  <div class="auto-token">
                    <input type="text" class="auto-token-input" value={value} onInput={(e) => setValue((e.target as HTMLInputElement).value)} />
                    <button type="button" class="auto-x" aria-label="Use a fixed value" title="Use a fixed value" onClick={() => setValue(undefined)}><CloseIcon size={10} /></button>
                  </div>
                </div>
              ) : (
                <ConfigField field={{ ...field, name: key }} value={value} onChange={setValue} />
              )}
              <select class="auto-insert" value="" onChange={(e) => { const v = (e.target as HTMLSelectElement).value; if (v) setValue(v); }}>
                <option value="">Fill in automatically…</option>
                <option value={NOW_TOKEN}>Time of this run</option>
                <option value={TODAY_TOKEN}>Today's date</option>
                {lastKeys.length > 0 && (
                  <optgroup label="From the last run's output">
                    {lastKeys.map((k) => <option key={k} value={lastOutputToken(k)}>{humanize(k)}</option>)}
                  </optgroup>
                )}
              </select>
            </div>
          );
        })}
        {keys.some((k) => isTemplate(input[k]) && String(input[k]).includes("last.")) && (
          <div class="auto-hint">
            “From the last run” reads this automation's latest successful run. On the very first run there is none, so that
            input is left out.
          </div>
        )}
        {saveError && <div class="auto-error">{saveError}</div>}
      </div>
      <div class="flyout-actions">
        <button class="btn" onClick={props.onCancel}>Cancel</button>
        <button class="btn btn-primary" disabled={saving || "problem" in built} onClick={save}>{existing ? "Save" : "Create"}</button>
      </div>
    </>
  );
}
