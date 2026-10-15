import yaml from "js-yaml";

// YAML for code that can import nothing but `strut` — a seeded custom step
// resolves `strut` and no other package — with the options strut writes its
// own YAML with (workspace.ts): wide lines, so a long command stays on one
// line, and no anchors, so a repeated object is written out each time.

/** `value` as YAML text. */
export function dumpYaml(value: unknown, opts?: yaml.DumpOptions): string {
  return yaml.dump(value, { lineWidth: 120, noRefs: true, ...opts });
}

/** YAML text as a value; throws on text that is not YAML. */
export function loadYaml(text: string): unknown {
  return yaml.load(text);
}
