/**
 * An app's files BY PATH (plans/app-files-by-path.md). The build puts every
 * file under the app's `public/` into the document as a table, path → data
 * URL, in a module the entry imports before the app (`installAppFiles`, from
 * `@strut/kit/bootstrap`), so the table is kept here and `fetch` answers its
 * paths before the app's first line runs. `/models/fox.vox` is
 * `public/models/fox.vox`, as on a static host. The page can fetch nothing
 * but a `data:` or `blob:` URL (the document's CSP), so this is how code
 * written for a static host reads its own files unchanged.
 */

let table: Readonly<Record<string, string>> = {};

/** Keep the build's table of the app's `public/`. */
export function setAppFiles(files: Readonly<Record<string, string>>): void {
  table = files;
}

/** The build's call: keep the table and answer its paths in this window's
 *  `fetch`. Returns the uninstall. */
export function installAppFiles(files: Readonly<Record<string, string>>, win: Pick<typeof globalThis, "fetch"> = globalThis): () => void {
  setAppFiles(files);
  return installFileFetch(win);
}

/**
 * A file in the app's `public/` by its path — `"/models/fox.vox"`,
 * `"models/fox.vox"` or `"./models/fox.vox"`, a query or hash ignored — as a
 * data URL; `undefined` when the app has no such file. For what takes a URL
 * and does not fetch: `<img src>`, `new Audio()`, three's `TextureLoader`
 * (`THREE.DefaultLoadingManager.setURLModifier((u) => appFileUrl(u) ?? u)`
 * covers every three loader). `fetch` reads these paths itself.
 */
export function appFileUrl(path: string): string | undefined {
  const bare = path.replace(/[?#].*$/, "");
  const rooted = "/" + bare.replace(/^\.?\/+/, "");
  return Object.hasOwn(table, rooted) ? table[rooted] : undefined;
}

/** The data URL a `fetch` argument names, if it names a file of the table:
 *  a string as written, a `Request` or `URL` by its pathname (the
 *  document's base URL is the host page's, so a path resolves onto the
 *  host's origin). */
function fileOf(input: RequestInfo | URL): string | undefined {
  if (typeof input === "string") return /^[a-z][a-z0-9+.-]*:/i.test(input) ? undefined : appFileUrl(input);
  const href = input instanceof URL ? input.href : input.url;
  let pathname: string;
  try {
    const url = new URL(href);
    if (url.protocol === "data:" || url.protocol === "blob:") return undefined;
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  return appFileUrl(pathname);
}

const READS = new Set(["GET", "HEAD"]);

/**
 * Answer the table's paths in the window's `fetch`: a GET or HEAD of one is
 * a fetch of its data URL; anything else goes to the real `fetch`, which the
 * CSP refuses as it would. Nothing is wrapped while the table is empty.
 * Returns the uninstall.
 */
export function installFileFetch(win: Pick<typeof globalThis, "fetch">): () => void {
  const real = win.fetch;
  if (typeof real !== "function" || !Object.keys(table).length) return () => {};
  const wrapped: typeof fetch = (input, init) => {
    const method = (init?.method ?? (typeof input === "object" && !(input instanceof URL) ? input.method : "GET")).toUpperCase();
    const file = READS.has(method) ? fileOf(input) : undefined;
    if (!file) return real.call(win, input, init);
    const signal = init?.signal ?? (typeof input === "object" && !(input instanceof URL) ? input.signal : undefined);
    return real.call(win, file, { method, ...(signal ? { signal } : {}) });
  };
  win.fetch = wrapped;
  return () => {
    if (win.fetch === wrapped) win.fetch = real;
  };
}
