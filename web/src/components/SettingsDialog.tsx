// ── Settings Dialog ─────────────────────────────────────────────────────────
// Browser-local preferences (storage.ts). Today: dictation — which strut STT
// models the mic in the AI chat streams to, plus an inline hotwords list to
// experiment with contextual biasing (plans/local-desktop-and-stt.md §4.2).
// Model *installation* is a server fact (`/audio/models`); "enabled" is this
// browser's choice to use it.

import { useEffect, useState } from "preact/hooks";
import * as api from "../api";
import { dictationSupported } from "../dictation";
import type { SttSettings } from "../storage";

const MB = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

export function SettingsDialog(props: {
  settings: SttSettings;
  onChange: (next: SttSettings) => void;
  onClose: () => void;
}) {
  const { settings } = props;
  const [catalog, setCatalog] = useState<api.SttModelsResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null); // model id being downloaded
  const [progress, setProgress] = useState("");
  const [hotwords, setHotwords] = useState(settings.hotwords);
  const [apiKey, setApiKeyState] = useState(api.getApiKey());
  const [actor, setActor] = useState("");
  const [signing, setSigning] = useState(false);
  const [connError, setConnError] = useState("");
  const keySource = api.apiKeySource();
  const session = api.getSession();

  // Everything on screen was fetched with the old credential (or refused
  // for it), so a change reloads.
  const saveApiKey = (value: string) => {
    const v = value.trim();
    if (v === api.getApiKey()) return;
    api.setApiKey(v);
    location.reload();
  };
  const signIn = async () => {
    setSigning(true);
    setConnError("");
    try {
      await api.signIn(apiKey.trim(), actor.trim() || undefined);
      location.reload();
    } catch (e) {
      setConnError(e instanceof Error ? e.message : String(e));
      setSigning(false);
    }
  };
  const signOut = async () => {
    await api.signOut();
    location.reload();
  };

  const refresh = async () => {
    try {
      setCatalog(await api.listSttModels());
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    refresh();
  }, []);

  const models = catalog?.models ?? [];
  const byId = (id: string | null) => models.find((m) => m.id === id);
  const finalsDefault = models.find((m) => m.default === "model");
  const partialsDefault = models.find((m) => m.default === "partialModel");
  const installed = models.filter((m) => m.installed);
  const enabledModel = settings.enabled ? byId(settings.model) : undefined;
  const missing = settings.enabled && (!enabledModel?.installed || (settings.partialModel && !byId(settings.partialModel)?.installed));

  const download = async (id: string) => {
    setBusy(id);
    setProgress("");
    try {
      await api.downloadSttModel(id, (p) => {
        if (p.phase === "download") setProgress(`${Math.round((100 * p.received) / p.total)}%`);
        else setProgress(p.phase === "extract" ? "extracting…" : "done");
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setProgress("");
    }
  };

  // The recommended pair: hotword-capable finals model + fast partials model.
  const enable = async () => {
    if (!finalsDefault) return;
    if (!finalsDefault.installed) await download(finalsDefault.id);
    if (partialsDefault && !partialsDefault.installed) await download(partialsDefault.id);
    const fresh = await api.listSttModels().catch(() => null);
    const ok = fresh?.models.find((m) => m.id === finalsDefault.id)?.installed;
    if (!ok) return;
    props.onChange({
      ...settings,
      enabled: true,
      model: finalsDefault.id,
      partialModel: fresh?.models.find((m) => m.id === partialsDefault?.id)?.installed ? partialsDefault!.id : null,
    });
  };

  const saveHotwords = (value = hotwords) => {
    if (value !== settings.hotwords) props.onChange({ ...settings, hotwords: value });
  };

  const totalToFetch = [finalsDefault, partialsDefault]
    .filter((m): m is api.SttModelStatus => !!m && !m.installed)
    .reduce((n, m) => n + m.bytes, 0);

  return (
    <div
      class="dialog-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div class="dialog settings-dialog">
        <div class="dialog-title">Settings</div>

        <div class="settings-section-title">Connection</div>
        {session ? (
          <>
            <div class="dialog-hint">
              Signed in{session.actor ? ` as ${session.actor}` : ""}: the server set a session
              cookie this page cannot read, and nothing in this browser holds the key. Runs
              and publishes from here are stamped with that name.
            </div>
            <div class="settings-row">
              <span class="settings-status is-on">● signed in</span>
              <span class="settings-detail">until {new Date(session.exp).toLocaleString()}</span>
              <button class="btn" onClick={signOut}>
                Sign out
              </button>
            </div>
          </>
        ) : (
          <>
            <div class="dialog-hint">
              Needed when the server sets <code>STRUT_API_KEY</code>: nothing is served without
              it. <b>Sign in</b> trades the key for a session cookie (12 hours by default) and
              forgets it; <b>Keep key</b> stores it in this browser and sends it as a bearer
              token on every request instead. An artifact link carries a read token for that
              run's files either way, never the key.
              {keySource === "url" && " This session's key came from the launch URL."}
              {keySource === "settings" && " A key is kept in this browser."}
            </div>
            <div class="dialog-field">
              <label>API key</label>
              <input
                type="password"
                value={apiKey}
                placeholder="STRUT_API_KEY (blank in dev)"
                autocomplete="off"
                onInput={(e) => setApiKeyState((e.target as HTMLInputElement).value)}
              />
            </div>
            <div class="dialog-field">
              <label>Your name (optional — who runs and publishes are stamped with)</label>
              <input
                type="text"
                value={actor}
                placeholder="evan"
                autocomplete="off"
                onInput={(e) => setActor((e.target as HTMLInputElement).value)}
              />
            </div>
            <div class="settings-row">
              <button class="btn btn-primary" disabled={!apiKey.trim() || signing} onClick={signIn}>
                {signing ? "Signing in…" : "Sign in"}
              </button>
              <button class="btn" disabled={apiKey.trim() === api.getApiKey()} onClick={() => saveApiKey(apiKey)}>
                {apiKey.trim() ? "Keep key in this browser" : "Forget key"}
              </button>
            </div>
            {connError && <div class="settings-warn">{connError}</div>}
          </>
        )}

        <div class="settings-section-title">Dictation</div>
        <div class="dialog-hint">
          Speak into the AI chat. Recognition runs inside strut (sherpa-onnx, on the
          server's CPU); nothing leaves the deployment. Models download once into{" "}
          <code>{catalog?.modelDir ?? "the model dir"}</code>.
        </div>

        {catalog && !catalog.available && (
          <div class="settings-warn">
            The server can't load the speech engine: <code>sherpa-onnx-node</code> isn't
            installed there.
          </div>
        )}
        {!dictationSupported() && (
          <div class="settings-warn">This browser can't capture audio (no microphone API).</div>
        )}

        <div class="settings-row">
          {settings.enabled && enabledModel && !missing ? (
            <>
              <span class="settings-status is-on">● enabled</span>
              <span class="settings-detail">
                {settings.model}
                {settings.partialModel ? ` + ${settings.partialModel}` : ""}
              </span>
              <button class="btn" onClick={() => props.onChange({ ...settings, enabled: false })}>
                Disable
              </button>
            </>
          ) : (
            <>
              <span class="settings-status">○ off</span>
              <span class="settings-detail">
                {finalsDefault
                  ? totalToFetch > 0
                    ? `downloads ${MB(totalToFetch)}`
                    : "models installed"
                  : catalog
                    ? "no catalog"
                    : "loading…"}
              </span>
              <button
                class="btn btn-primary"
                disabled={!catalog || !catalog.available || !finalsDefault || busy !== null}
                onClick={enable}
              >
                {busy ? `Downloading ${busy} ${progress}` : "Enable dictation"}
              </button>
            </>
          )}
        </div>

        {settings.enabled && installed.length > 1 && (
          <details class="settings-advanced">
            <summary>Models</summary>
            <div class="dialog-field">
              <label>Finals model (hotword-capable ones bias toward your hotwords)</label>
              <select
                value={settings.model ?? ""}
                onChange={(e) =>
                  props.onChange({ ...settings, model: (e.target as HTMLSelectElement).value })
                }
              >
                {installed.map((m) => (
                  <option value={m.id} key={m.id}>
                    {m.id}
                    {m.hotwords ? "" : " (no hotwords)"}
                  </option>
                ))}
              </select>
            </div>
            <div class="dialog-field">
              <label>Live partials model</label>
              <select
                value={settings.partialModel ?? ""}
                onChange={(e) => {
                  const v = (e.target as HTMLSelectElement).value;
                  props.onChange({ ...settings, partialModel: v || null });
                }}
              >
                <option value="">none — finals model does both</option>
                {installed
                  .filter((m) => m.id !== settings.model)
                  .map((m) => (
                    <option value={m.id} key={m.id}>
                      {m.id} (~{m.chunkMs} ms)
                    </option>
                  ))}
              </select>
            </div>
          </details>
        )}

        <div class="settings-models">
          {models.map((m) => (
            <div class="settings-model" key={m.id}>
              <div class="settings-model-head">
                <span class="settings-model-id">{m.id}</span>
                <span class="settings-model-meta">
                  {MB(m.bytes)} · partials ~{m.chunkMs} ms · {m.hotwords ? "hotwords" : "no hotwords"}
                </span>
                {m.installed ? (
                  <span class="settings-model-installed">installed</span>
                ) : (
                  <button
                    class="btn"
                    disabled={busy !== null || !catalog?.available}
                    onClick={() => download(m.id)}
                  >
                    {busy === m.id ? progress || "…" : "Download"}
                  </button>
                )}
              </div>
              <div class="settings-model-desc">{m.description}</div>
            </div>
          ))}
        </div>

        <div class="settings-section-title">Hotwords</div>
        <div class="dialog-hint">
          Phrases the recognizer should favor: names, products, acronyms. One per line,
          optional <code>:score</code> (1.5–3 works; 5 over-biases). Casing must match
          what the model would emit, so list proper nouns both ways. Sent with every
          dictation from this browser.
        </div>
        <div class="dialog-field">
          <textarea
            rows={5}
            value={hotwords}
            placeholder={"Sphinx\nsphinx\nStakwork :2"}
            onInput={(e) => setHotwords((e.target as HTMLTextAreaElement).value)}
            onBlur={(e) => saveHotwords((e.target as HTMLTextAreaElement).value)}
          />
        </div>

        {error && <div style="color:var(--danger);font-size:12px;margin-bottom:8px;">{error}</div>}
        <div class="dialog-actions">
          <button
            class="btn"
            onClick={() => {
              saveHotwords();
              props.onClose();
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
