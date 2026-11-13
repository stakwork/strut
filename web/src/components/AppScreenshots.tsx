import { useEffect, useRef, useState } from "preact/hooks";
import * as api from "../api";
import { errorMessage } from "../helpers";
import { useFileScope } from "../use-artifact-url";
import {
  SCREENSHOT_MAX_BYTES,
  SCREENSHOT_TYPES,
  SCREENSHOTS_MAX,
  SHOT_VIEWPORTS,
  savedNote,
  type ShotViewport,
} from "../app-screenshots";

// ── An app's screenshots (the Versions flyout) ─────────────────────────────
//
// What the package store shows of the app: the list `app.yaml` names, edited
// here and saved as a new version of the app (src/apps/screenshots.ts). A
// screenshot is taken by looking at the app as a person opening it sees it
// (`app/look`, in this strut's own browser), or uploaded. Built on the
// NEWEST version, so a held app's drafts are kept: the save is a draft too.

interface Item {
  key: string;
  /** A file the version already has. */
  file?: string;
  /** A new image's base64 bytes and type. */
  data?: string;
  type?: string;
  caption: string;
}

let nextKey = 0;
const keyOf = () => `s${++nextKey}`;

export function AppScreenshots(props: {
  name: string;
  /** The version the list is read from and a save builds on: the newest. */
  version: string;
  /** After a save: the caller reads the app and its versions again. */
  onSaved: () => void | Promise<void>;
}) {
  const { name } = props;
  // A save that matched an earlier version (no new one) shows that version:
  // what was saved, and what the next save builds on.
  const [saved, setSaved] = useState<{ base: string; version: string } | null>(null);
  const version = saved?.base === props.version ? saved.version : props.version;
  const [items, setItems] = useState<Item[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"" | "take" | "save">("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [viewport, setViewport] = useState<ShotViewport>("desktop");
  const upload = useRef<HTMLInputElement>(null);
  const scopePath = api.appFilesScope(name, version);
  const scope = useFileScope(scopePath);

  const load = () => {
    setItems(null);
    setLoadError("");
    setDirty(false);
    setError("");
    api.getAppScreenshots(name, version).then(
      (r) => setItems(r.screenshots.map((s) => ({ key: keyOf(), file: s.file, caption: s.caption ?? "" }))),
      (err) => setLoadError(errorMessage(err)),
    );
  };
  useEffect(load, [name, version]);

  const change = (next: Item[]) => {
    setItems(next);
    setDirty(true);
    setNote("");
    setError("");
  };
  const add = (more: Item[]) => {
    if (!items) return;
    const room = SCREENSHOTS_MAX - items.length;
    if (more.length > room) setError(`At most ${SCREENSHOTS_MAX} screenshots: ${room ? `${room} more fit` : "take one off first"}.`);
    if (room > 0) change([...items, ...more.slice(0, room)]);
  };

  const take = async () => {
    setBusy("take");
    setError("");
    setNote("");
    try {
      const shot = await api.takeAppScreenshot(name, { version, viewport: SHOT_VIEWPORTS[viewport].size });
      add([{ key: keyOf(), data: shot.data, type: shot.type, caption: "" }]);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy("");
    }
  };

  const uploaded = async (files: FileList | null) => {
    if (!files?.length) return;
    const read: Item[] = [];
    for (const f of Array.from(files)) {
      if (!SCREENSHOT_TYPES.includes(f.type)) {
        setError(`${f.name}: a PNG, JPEG, WebP or GIF image`);
        continue;
      }
      if (f.size > SCREENSHOT_MAX_BYTES) {
        setError(`${f.name}: ${(f.size / 1e6).toFixed(1)} MB, over the 2 MB a screenshot may be`);
        continue;
      }
      const bytes = new Uint8Array(await f.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      read.push({ key: keyOf(), data: btoa(bin), type: f.type, caption: "" });
    }
    if (read.length) add(read);
    if (upload.current) upload.current.value = "";
  };

  const save = async () => {
    if (!items) return;
    setBusy("save");
    setError("");
    try {
      const made = await api.saveAppScreenshots(
        name,
        version,
        items.map((it) => {
          const caption = it.caption.trim() ? { caption: it.caption.trim() } : {};
          return it.file ? { file: it.file, ...caption } : { data: it.data!, type: it.type!, ...caption };
        }),
      );
      setDirty(false);
      setSaved({ base: made.changed ? made.version : props.version, version: made.version });
      setNote(savedNote(made));
      await props.onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy("");
    }
  };

  const move = (i: number, by: number) => {
    if (!items) return;
    const next = [...items];
    const [it] = next.splice(i, 1);
    next.splice(i + by, 0, it!);
    change(next);
  };
  const srcOf = (it: Item) =>
    it.data ? `data:${it.type};base64,${it.data}` : scope ? api.artifactUrl(`${scopePath}/${it.file}`, scope.token) : undefined;

  return (
    <section class="app-shots">
      <div class="app-shots-head">
        <span class="app-shots-title">Screenshots</span>
        <span class="app-shots-of">of {version}</span>
      </div>
      <div class="auto-hint">What the package store shows of this app. They reach the store when its package is published again.</div>
      {loadError && <div class="auto-error">{loadError}</div>}
      {!items && !loadError && <div class="empty">Loading…</div>}
      {items && (
        <>
          {items.length === 0 && <div class="app-shots-empty">None yet. Take one of the app as it looks now, or upload an image.</div>}
          <ol class="app-shots-list">
            {items.map((it, i) => (
              <li key={it.key} class="app-shot-row">
                {it.file ? (
                  <a class="app-shot-thumb" href={srcOf(it)} target="_blank" rel="noopener noreferrer" title="Open full size">
                    {srcOf(it) && <img src={srcOf(it)} alt={it.caption || `Screenshot ${i + 1}`} />}
                  </a>
                ) : (
                  <span class="app-shot-thumb"><img src={srcOf(it)} alt={it.caption || `Screenshot ${i + 1}`} /></span>
                )}
                <div class="app-shot-body">
                  <input
                    class="app-shot-caption"
                    type="text"
                    maxLength={200}
                    placeholder="Caption (optional)"
                    value={it.caption}
                    disabled={!!busy}
                    onInput={(e) => change(items.map((x) => (x.key === it.key ? { ...x, caption: (e.target as HTMLInputElement).value } : x)))}
                  />
                  <span class="app-shot-file">{it.file ?? "new"}</span>
                </div>
                <div class="app-shot-actions">
                  <button class="btn btn-sm" disabled={!!busy || i === 0} onClick={() => move(i, -1)} aria-label="Move up" title="Move up">↑</button>
                  <button class="btn btn-sm" disabled={!!busy || i === items.length - 1} onClick={() => move(i, 1)} aria-label="Move down" title="Move down">↓</button>
                  <button class="btn btn-sm" disabled={!!busy} onClick={() => change(items.filter((x) => x.key !== it.key))} aria-label="Remove" title="Remove">✕</button>
                </div>
              </li>
            ))}
          </ol>
          <div class="app-shots-add">
            <select class="app-shots-viewport" value={viewport} disabled={!!busy} onChange={(e) => setViewport((e.target as HTMLSelectElement).value as ShotViewport)} aria-label="Screen size">
              {Object.entries(SHOT_VIEWPORTS).map(([id, v]) => <option key={id} value={id}>{v.label}</option>)}
            </select>
            <button class="btn btn-sm" disabled={!!busy || items.length >= SCREENSHOTS_MAX} onClick={() => void take()}>
              {busy === "take" ? "Taking…" : "Take a screenshot"}
            </button>
            <button class="btn btn-sm" disabled={!!busy || items.length >= SCREENSHOTS_MAX} onClick={() => upload.current?.click()}>Upload…</button>
            <input ref={upload} type="file" accept={SCREENSHOT_TYPES.join(",")} multiple hidden onChange={(e) => void uploaded((e.target as HTMLInputElement).files)} />
          </div>
          {busy === "take" && <div class="auto-hint">Opening the app in this server's browser, as a person would see it…</div>}
          {error && <div class="auto-error">{error}</div>}
          {note && <div class="app-shots-note">{note}</div>}
          {dirty && (
            <div class="app-shots-save">
              <button class="btn btn-sm" disabled={!!busy} onClick={() => { setNote(""); load(); }}>Discard</button>
              <button class="btn btn-sm btn-primary" disabled={!!busy} onClick={() => void save()}>
                {busy === "save" ? "Saving…" : "Save as a new version"}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
