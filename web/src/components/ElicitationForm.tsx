import { useState } from "preact/hooks";
import * as api from "../api";
import { ConfigField } from "./ConfigField";
import { CloseIcon } from "../icons";
import { contentToSubmit, fieldsOf, initialContent, missingRequired } from "../elicitation";

// ── The builder's open question ────────────────────────────────────────────
// Rendered at the end of the transcript while `meta.elicitation` is set
// (plans/elicitation.md). Form mode: the fields, Submit / Decline, and ✕ for
// cancel. URL mode — a secret — is the "page the link opens": a password
// field whose value posts to the /secret endpoint and lands in the store
// under the recorded NAME; the chat only ever hears "stored". Every answer
// goes through the server, which re-validates and starts the next turn.

export function ElicitationForm(props: {
  chatId: string;
  elicitation: api.Elicitation;
  /** The answer was accepted by the server: reload the transcript. */
  onAnswered: () => void;
}) {
  const { chatId, elicitation: e } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [content, setContent] = useState<Record<string, unknown>>(() => (e.mode === "form" ? initialContent(e.requestedSchema) : {}));
  const [value, setValue] = useState("");

  const finish = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await run();
      props.onAnswered();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  const act = (action: api.ElicitationAction) =>
    finish(() =>
      api.answerElicitation(chatId, e.elicitationId, {
        action,
        ...(action === "accept" && e.mode === "form" ? { content: contentToSubmit(e.requestedSchema, content) } : {}),
      }),
    );
  const dismiss = (
    <button type="button" class="flyout-close" onClick={() => act("cancel")} disabled={busy} aria-label="Dismiss" title="Dismiss (the builder may ask again later)">
      <CloseIcon />
    </button>
  );

  if (e.mode === "url") {
    return (
      <form
        class="chat-ask chat-ask-secret"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (value) finish(() => api.storeElicitedSecret(chatId, e.elicitationId, value));
        }}
      >
        <div class="chat-ask-head">
          <span class="chat-ask-title">
            {e.exists ? "Replace secret" : "Add secret"} <code class="chat-ask-name">{e.name}</code>
          </span>
          {dismiss}
        </div>
        <div class="chat-ask-message">{e.message}</div>
        <div class="flyout-field">
          <label>Value</label>
          <input
            type="password"
            autocomplete="off"
            value={value}
            onInput={(ev) => setValue((ev.target as HTMLInputElement).value)}
            placeholder="Paste the secret"
            autoFocus
          />
        </div>
        <div class="chat-ask-hint">
          Stored directly under this name. The builder only learns that it was stored — the value never enters the chat.
        </div>
        {error && <div class="chat-ask-error">{error}</div>}
        <div class="chat-ask-actions">
          <button type="button" class="btn" onClick={() => act("decline")} disabled={busy}>Decline</button>
          <button type="submit" class="btn btn-primary" disabled={busy || !value}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </form>
    );
  }

  const fields = fieldsOf(e.requestedSchema);
  const missing = missingRequired(e.requestedSchema, content);
  return (
    <form
      class="chat-ask"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (!missing.length) act("accept");
      }}
    >
      <div class="chat-ask-head">
        <span class="chat-ask-title">The builder asks</span>
        {dismiss}
      </div>
      <div class="chat-ask-message">{e.message}</div>
      {fields.map((f) => (
        <ConfigField key={f.name} field={f} value={content[f.name]} onChange={(v) => setContent((c) => ({ ...c, [f.name]: v }))} />
      ))}
      {error && <div class="chat-ask-error">{error}</div>}
      <div class="chat-ask-actions">
        <button type="button" class="btn" onClick={() => act("decline")} disabled={busy}>Decline</button>
        <button
          type="submit"
          class="btn btn-primary"
          disabled={busy || missing.length > 0}
          title={missing.length ? `Fill in: ${missing.join(", ")}` : undefined}
        >
          {busy ? "Sending…" : "Submit"}
        </button>
      </div>
    </form>
  );
}
