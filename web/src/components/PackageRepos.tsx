import { useEffect, useState } from "preact/hooks";
import * as api from "../api";
import { ago } from "./ClaimsPanel";
import { errorMessage } from "../helpers";
import { ConfirmButton } from "./ConfirmButton";

// ── Repos (the Packages tab; plans/app-repos.md §3) ─────────────────────────
//
// A package this strut works ON as a git checkout: OPEN a repo (its branch
// installed through the `repo` door, a working copy kept), edit its items as
// anything else, then COMMIT — the workspace's edits written into the
// working copy and pushed, a new branch and a pull request by default or the
// followed branch when the person says so — and PULL, where git merges and a
// conflict is named, never installed. Each row: the branch, the commit
// installed, what is edited here, and the two acts. CREATE repo starts one
// from a package's page (`CreateRepo`, below).

const short = (sha: string) => sha.slice(0, 7);
const secs = (iso?: string) => (iso ? Date.parse(iso) / 1000 : undefined);

export function PackageRepos(props: { onChanged?: () => void }) {
  const [repos, setRepos] = useState<api.RepoInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.listRepos().then(setRepos, (err) => setError(errorMessage(err)));
  useEffect(() => {
    void load();
  }, []);
  const changed = () => {
    void load();
    props.onChanged?.();
  };
  return (
    <div class="flyout-section">
      <div class="flyout-section-title">Repos</div>
      {error && <div class="auto-error">{error}</div>}
      {repos === null && !error && <div class="auto-hint">Loading…</div>}
      {repos?.length === 0 && (
        <div class="auto-hint">
          No repo is open here. A git repository that holds a package (strut.yaml at its root, or in a folder) is opened on a branch: its items are installed, edited here, and committed back.
        </div>
      )}
      {repos?.map((r) => <RepoRow key={r.package} repo={r} onChanged={changed} />)}
      <OpenRepo onOpened={changed} />
    </div>
  );
}

function RepoRow(props: { repo: api.RepoInfo; onChanged: () => void }) {
  const r = props.repo;
  const [mode, setMode] = useState<"commit" | "pull" | null>(null);
  // Opening a panel reads the repo again: what is edited here moves as the builder works.
  const open = (m: "commit" | "pull") => {
    setMode(mode === m ? null : m);
    if (mode !== m) props.onChanged();
  };
  const edited: Array<api.RepoItem & { mark?: "new" | "deleted" }> = [
    ...r.added.map((i) => ({ ...i, mark: "new" as const })),
    ...r.forked,
    ...r.deleted.map((i) => ({ ...i, mark: "deleted" as const })),
  ];
  return (
    <div class="auto-card repo-card">
      <div class="auto-card-head">
        <span class="package-name" title={r.workdir}>{r.package}</span>
        <span class="badge" title={`Pull merges ${r.branch}; a straight commit pushes to it`}>{r.branch}</span>
      </div>
      <div class="auto-meta">
        <span class="package-url" title={r.ref}>{r.url}{r.path ? `#${r.path}` : ""}</span>
        <code class="package-digest" title={`The commit installed here: ${r.commit}`}>{short(r.commit)}</code>
        <span title={new Date(r.openedAt).toLocaleString()}>opened {ago(secs(r.openedAt))}</span>
      </div>
      {r.conflict ? (
        <div class="auto-error">
          A pull stopped on a conflict in {r.conflict.join(", ")}. Resolve it in the working copy (<code>{r.workdir}</code>), <code>git add</code> the files, and Pull again.
        </div>
      ) : r.merge ? (
        <div class="auto-hint">A merge waits to be applied: Pull again.</div>
      ) : null}
      {edited.length > 0 ? (
        <div class="package-chips" aria-label="Edited here since the commit installed">
          {edited.map((i) => (
            <span class={`badge ${i.mark === "new" ? "badge-accent" : "badge-warning"}`} key={`${i.kind}:${i.name}`}
              title={i.mark === "deleted" ? `Deleted here: a commit removes the ${i.kind}` : i.mark === "new" ? `New here: a commit adds this ${i.kind} to the repo` : `Edited here: a commit writes this ${i.kind}`}>
              {i.mark ? `${i.mark} ` : ""}{i.name.startsWith(`${r.package}/`) ? i.name.slice(r.package.length + 1) : i.name}
            </span>
          ))}
        </div>
      ) : (
        <div class="auto-hint">Nothing edited here since {short(r.commit)}.</div>
      )}
      <div class="auto-hint">
        A new workflow, step or app goes in the repo when it is named under the package — <code>{r.package}/…</code> — and committed.
      </div>
      {r.originals?.length ? <RetireOriginals repo={r} onChanged={props.onChanged} /> : null}
      <div class="repo-actions">
        <button class={`btn${mode === "commit" ? " btn-primary" : ""}`} disabled={!!r.conflict || !!r.merge} onClick={() => open("commit")}>Commit…</button>
        <button class={`btn${mode === "pull" ? " btn-primary" : ""}`} onClick={() => open("pull")}>Pull</button>
        <ConfirmButton label="Close" class="btn" tone="danger" confirmLabel="Close the repo"
          note="Forgets the repo and removes its working copy (anything not pushed in it goes). The installed items stay."
          onConfirm={() => void api.closeRepo(r.package).then(props.onChanged)} />
      </div>
      {mode === "commit" && <CommitRepo repo={r} onDone={props.onChanged} />}
      {mode === "pull" && <PullRepo repo={r} onDone={props.onChanged} />}
    </div>
  );
}

function CommitRepo(props: { repo: api.RepoInfo; onDone: () => void }) {
  const r = props.repo;
  const [diff, setDiff] = useState<api.RepoDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [straight, setStraight] = useState(false);
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<api.RepoCommitResult | null>(null);
  useEffect(() => {
    api.repoDiff(r.package).then(setDiff, (err) => setDiffError(errorMessage(err)));
  }, [r.package]);
  const commit = async () => {
    setBusy(true);
    setError(null);
    try {
      const done = await api.commitRepo(r.package, { message: message.trim(), ...(straight ? { branch: r.branch } : branch.trim() ? { branch: branch.trim() } : {}) });
      setResult(done);
      props.onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="repo-panel">
      {diffError && <div class="auto-error package-refusal">{diffError}</div>}
      {!diff && !diffError && <div class="auto-hint">Writing the edits into the working copy…</div>}
      {diff && diff.files.length === 0 && <div class="auto-hint">Nothing changed here since {short(r.commit)}: a commit pushes only what the working copy holds and the remote does not.</div>}
      {diff && diff.files.length > 0 && (
        <>
          <ul class="repo-files">
            {diff.files.map((f) => (
              <li key={f.path}>
                <span class={`repo-file-status is-${f.status}`}>{f.status === "added" ? "A" : f.status === "deleted" ? "D" : "M"}</span>
                <code>{f.path}</code>
              </li>
            ))}
          </ul>
          <details class="repo-diff">
            <summary>The diff{diff.truncated ? " (cut)" : ""}</summary>
            <pre>{diff.patch}</pre>
          </details>
        </>
      )}
      <div class="dialog-field">
        <label>Message</label>
        <textarea rows={2} value={message} placeholder="What changed" onInput={(e) => setMessage((e.target as HTMLTextAreaElement).value)} />
      </div>
      <div class="repo-push">
        <label class="listing-check">
          <input type="checkbox" checked={straight} onChange={() => setStraight(!straight)} />
          Push straight to {r.branch}
        </label>
        {!straight && (
          <input type="text" value={branch} placeholder="New branch (default: strut/…)" onInput={(e) => setBranch((e.target as HTMLInputElement).value)} />
        )}
        <div class="auto-hint">
          {straight ? `The commit goes onto ${r.branch} itself; a box serving it deploys it.` : `A new branch, with a pull request into ${r.branch} when the repository is on GitHub.`}
        </div>
      </div>
      <div class="package-publish-actions">
        <button class="btn btn-primary" disabled={busy || !message.trim()} onClick={() => void commit()}>{busy ? "Committing…" : "Commit and push"}</button>
      </div>
      {error && <div class="auto-error package-refusal">{error}</div>}
      {result && (
        <div class="auto-card is-active-version">
          {result.committed ? (
            <>
              <div class="auto-card-head">
                <span class="package-name">Pushed {short(result.commit)}{result.branch ? ` to ${result.branch}` : ""}</span>
              </div>
              {result.pr && <a class="auto-link" href={result.pr.url} target="_blank" rel="noopener noreferrer">Pull request #{result.pr.number}</a>}
              {result.prSkipped && <div class="auto-hint">No pull request: {result.prSkipped}.</div>}
              {result.stamped.length > 0 && <div class="auto-hint">No longer edited here: {result.stamped.map((i) => i.name).join(", ")}.</div>}
            </>
          ) : (
            <div class="auto-hint">Nothing to commit: the remote has all of it.</div>
          )}
        </div>
      )}
    </div>
  );
}

function PullRepo(props: { repo: api.RepoInfo; onDone: () => void }) {
  const r = props.repo;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<api.RepoPullResult | null>(null);
  const pull = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.pullRepo(r.package));
      props.onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="repo-panel">
      <div class="auto-hint">
        What is edited here is committed in the working copy first, then git merges {r.branch} from the remote and the result is installed. A conflict stops before anything is installed.
      </div>
      <div class="package-publish-actions">
        <button class="btn btn-primary" disabled={busy} onClick={() => void pull()}>{busy ? "Pulling…" : `Pull ${r.branch}`}</button>
      </div>
      {error && <div class="auto-error package-refusal">{error}</div>}
      {result?.conflict ? (
        <div class="auto-error">git could not merge {result.conflict.join(", ")}: nothing was installed.</div>
      ) : result ? (
        <div class="auto-card is-active-version">
          <span class="package-name">Installed {short(result.commit)}</span>
          {result.local && <div class="auto-hint">The edits made here went in first as {short(result.local)}; Commit pushes them.</div>}
        </div>
      ) : null}
    </div>
  );
}

function RetireOriginals(props: { repo: api.RepoInfo; onChanged: () => void }) {
  const items = props.repo.originals ?? [];
  const [error, setError] = useState<string | null>(null);
  return (
    <div class="repo-panel">
      <div class="auto-hint">
        Made from {items.map((i) => `the ${i.kind} ${i.name}`).join(", ")}. From now on the package's copies are the ones being edited; the originals can go.
      </div>
      <div class="repo-actions">
        <ConfirmButton label="Retire the originals" class="btn" tone="danger" confirmLabel="Retire them"
          note="Deletes the bare workflows, steps and apps the package was made from. A workflow that calls one by its bare name stops finding it."
          onConfirm={() =>
            void api.retireRepoOriginals(props.repo.package, items).then(
              (r) => (r.failed.length ? setError(r.failed.map((f) => `${f.name}: ${f.error}`).join("; ")) : props.onChanged()),
              (err) => setError(errorMessage(err)),
            )
          } />
      </div>
      {error && <div class="auto-error">{error}</div>}
    </div>
  );
}

function OpenRepo(props: { onOpened: () => void }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [path, setPath] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.openRepo({ url: url.trim(), ...(ref.trim() ? { ref: ref.trim() } : {}), ...(path.trim() ? { path: path.trim() } : {}), ...(secret.trim() ? { tokenSecret: secret.trim() } : {}) });
      setOpen(false);
      setUrl("");
      props.onOpened();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  if (!open) {
    return (
      <div class="package-new">
        <button class="btn" onClick={() => setOpen(true)}>Open repo…</button>
      </div>
    );
  }
  return (
    <div class="listing-form">
      <label>
        Repository
        <input type="text" value={url} placeholder="https://github.com/acme/moonlander" onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
      </label>
      <label>
        Branch
        <input type="text" value={ref} placeholder="its default branch" onInput={(e) => setRef((e.target as HTMLInputElement).value)} />
      </label>
      <label>
        Folder
        <input type="text" value={path} placeholder="the root (or the folder holding strut.yaml)" onInput={(e) => setPath((e.target as HTMLInputElement).value)} />
      </label>
      <label>
        Token secret
        <input type="text" value={secret} placeholder="GITHUB_TOKEN" onInput={(e) => setSecret((e.target as HTMLInputElement).value)} />
      </label>
      <div class="auto-hint">The token is read from that secret (yours first) to fetch and push; only its name is kept.</div>
      <div class="repo-actions">
        <button class="btn btn-primary" disabled={busy || !url.trim()} onClick={() => void submit()}>{busy ? "Opening…" : "Open"}</button>
        <button class="btn" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {error && <div class="auto-error package-refusal">{error}</div>}
    </div>
  );
}

/** Create repo, on a package's page: the picks built and pushed as the
 *  first commit of an EMPTY remote, then opened here. */
export function CreateRepo(props: { pkg: string; request: () => Omit<api.PublishRequest, "channel" | "public">; disabled: boolean; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [path, setPath] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<(api.RepoInfo & { originals: api.RepoItem[] }) | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      setCreated(
        await api.createRepo({
          ...props.request(),
          url: url.trim(),
          ...(branch.trim() ? { branch: branch.trim() } : {}),
          ...(path.trim() ? { path: path.trim() } : {}),
          ...(secret.trim() ? { tokenSecret: secret.trim() } : {}),
        }),
      );
      props.onCreated();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  if (created) {
    return (
      <div class="auto-card is-active-version">
        <span class="package-name">{created.package} is a repo: {created.url}@{created.branch}</span>
        <div class="auto-hint">Its items are installed under {created.package}/ and edited from here on; Commit and Pull are under Repos.</div>
        {created.originals.length > 0 && <RetireOriginals repo={{ ...created, originals: created.originals }} onChanged={() => setCreated({ ...created, originals: [] })} />}
      </div>
    );
  }
  if (!open) {
    return (
      <button class="btn" disabled={props.disabled} title="Push the picks as the first commit of an empty git repository, and work on it from here" onClick={() => setOpen(true)}>
        Create repo…
      </button>
    );
  }
  return (
    <div class="listing-form">
      <label>
        Empty repository
        <input type="text" value={url} placeholder="https://github.com/acme/moonlander" onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
      </label>
      <label>
        Branch
        <input type="text" value={branch} placeholder="main" onInput={(e) => setBranch((e.target as HTMLInputElement).value)} />
      </label>
      <label>
        Folder
        <input type="text" value={path} placeholder="the root" onInput={(e) => setPath((e.target as HTMLInputElement).value)} />
      </label>
      <label>
        Token secret
        <input type="text" value={secret} placeholder="GITHUB_TOKEN" onInput={(e) => setSecret((e.target as HTMLInputElement).value)} />
      </label>
      <div class="auto-hint">The picks are built as {props.pkg}, pushed as the repository's first commit, and opened here: the package's copies are the ones edited from then on.</div>
      <div class="repo-actions">
        <button class="btn btn-primary" disabled={busy || !url.trim()} onClick={() => void submit()}>{busy ? "Creating…" : "Create and push"}</button>
        <button class="btn" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {error && <div class="auto-error package-refusal">{error}</div>}
    </div>
  );
}
