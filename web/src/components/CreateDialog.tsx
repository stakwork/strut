
// ── Create Workflow Dialog ──────────────────────────────────────────────────

import { useState } from "preact/hooks";
import yaml from "js-yaml";

const EXAMPLE_YAML = `name: my-workflow
steps:
  - id: greet
    type: log
    config:
      message: "Hello from strut!"
  - id: fetch
    type: http
    config:
      url: https://httpbin.org/json
  - id: done
    type: log
    config:
      message: "Fetched: {{ fetch.body }}"
`;

const SEGMENT = /^[a-z][a-z0-9-]{0,63}$/;
const NEW = "__new";

export function CreateDialog(props: {
  onClose: () => void;
  onCreate: (name: string, yamlStr: string, description: string) => void;
  /** This strut's publisher name: the first segment of a package. */
  publisher?: string;
  /** The packages here, as segments under the publisher. */
  packages?: string[];
  /** The selected package: what the workflow goes into unless changed. */
  defaultPackage?: string | null;
}) {
  const [desc, setDesc] = useState("");
  // The PACKAGE the workflow goes into (plans/packages-ux.md §1): one of
  // the packages here, a new one, or none — a bare name.
  const [pkg, setPkg] = useState(props.defaultPackage ?? "");
  const [newPkg, setNewPkg] = useState("");
  const [yamlStr, setYamlStr] = useState(EXAMPLE_YAML);
  const [error, setError] = useState("");

  const handleSubmit = () => {
    try {
      const data = yaml.load(yamlStr) as any;
      if (!data?.name) { setError("YAML must have a 'name' field"); return; }
      if (!data?.steps || !Array.isArray(data.steps)) { setError("YAML must have a 'steps' array"); return; }
      if (!/^[a-zA-Z][a-zA-Z0-9_-]*(\/[a-zA-Z][a-zA-Z0-9_-]*)*$/.test(data.name)) { setError("Name must be alphanumeric (hyphens/underscores ok; a slash makes a folder)"); return; }
      const seg = pkg === NEW ? newPkg.trim() : pkg;
      if (seg && !SEGMENT.test(seg)) { setError("A package name is lowercase: letters, digits and hyphens"); return; }
      if (seg && !props.publisher) { setError("Set the publisher name first (Packages), so the package has a prefix"); return; }
      // The stored name carries the package; the YAML must say it too (the
      // runner keys run storage off the workflow's name).
      const name = seg ? `${props.publisher}/${seg}/${data.name}` : data.name;
      const out = name === data.name ? yamlStr : yaml.dump({ ...data, name }, { lineWidth: 120, noRefs: true });
      props.onCreate(name, out, desc);
    } catch (e) {
      setError(`Invalid YAML: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div class="dialog-backdrop" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div class="dialog">
        <div class="dialog-title">Create Workflow</div>
        <div class="dialog-field">
          <label>Description</label>
          <input type="text" value={desc} onInput={(e) => setDesc((e.target as HTMLInputElement).value)} placeholder="What this workflow does" />
        </div>
        <div class="dialog-field">
          <label>Package</label>
          <select value={pkg} onChange={(e) => setPkg((e.target as HTMLSelectElement).value)}>
            <option value="">None</option>
            {(props.packages ?? []).map((p) => <option key={p} value={p}>{p}</option>)}
            <option value={NEW}>New package…</option>
          </select>
          {pkg === NEW && (
            <input type="text" value={newPkg} placeholder="tools" style="margin-top:6px"
              onInput={(e) => setNewPkg((e.target as HTMLInputElement).value)} />
          )}
          <div class="dialog-hint">The YAML's name is its path inside the package; a slash makes a folder.</div>
        </div>
        <div class="dialog-field">
          <label>Workflow (YAML)</label>
          <textarea value={yamlStr} onInput={(e) => { setYamlStr((e.target as HTMLTextAreaElement).value); setError(""); }} rows={16} />
          <div class="dialog-hint">Define a name and a steps list of tools. Tools: http, log, if, loop, subflow, llm. Use depends: to set DAG edges.</div>
        </div>
        {error && <div style="color:var(--danger);font-size:12px;margin-bottom:8px;">{error}</div>}
        <div class="dialog-actions">
          <button class="btn" onClick={props.onClose}>Cancel</button>
          <button class="btn btn-primary" onClick={handleSubmit}>Create</button>
        </div>
      </div>
    </div>
  );
}

