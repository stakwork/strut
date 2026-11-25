# An app's files by path

Status: BUILT (2026-11-24). Evan ruled all four as recommended. Two
details changed while building it:
- The table module installs itself, imported by the entry BEFORE the app,
  instead of reaching the kit through `bootstrap()`. The app's own modules
  run before `bootstrap()` is called, so a top-level `fetch` of a path would
  otherwise miss the table.
- The build's source check warned on every `fetch` of a written-out
  string, so `fetch("/level.json")` would have been told it fails. Now a
  URL with a scheme warns as before, and a written-out path warns only when
  no file of `public/` answers it, which also catches a mistyped path.

## The ask

A web project names its own files by path. A 3D game's level file says
`"model": "/models/fox.vox"` and its loader calls `fetch(url)`. A catalog
page's `products.json` says `"image": "/images/chair.webp"`. On a static
host, a file at `public/models/fox.vox` answers `/models/fox.vox`, and
nothing else is needed.

A strut app cannot do this. Its page can fetch only a `data:` URL (a file
it imported) or a `blob:` URL it made. So every file the data names also
needs an import line, and a table from path to import. When a game of this
shape (a Vite project: React, three, Rapier, eight `.vox` models named in
`level.json`) was ported to a strut app on 2026-11-24, that table was the
only real change: a new `models.ts` with eight imports, and one line in
the loader. Adding a model then means editing two files, and an agent that
swaps models by editing the level data has to know about the second one.

The ask: a file in the app's `public/` folder is the app's file by path,
as on any static host. `fetch("/models/fox.vox")` reads
`public/models/fox.vox`.

A stand-in was tried on that port the same day. A generated table of
`public/` plus a `fetch` wrapper sat in the page, and the loader went back
to its original `fetch(url)` with no `models.ts`. The document came out the
same size (4.17 MB). In a sandboxed srcdoc frame every model loaded,
`fetch(new Request("/models/coin.vox"))` returned the file, and the game
played with no errors.

## What strut already has

- **Imports.** `import fox from "../public/models/fox.vox"` is a data URL
  inlined in the document (`ASSET_LOADERS`, src/apps/build.ts; plans/apps.md
  §2.3). The page may fetch it (`connect-src data: blob:`).
- **A run's files** reach a page as `blob:` URLs through `run/files`
  (`useRunFileUrl`), and a task's through `useTaskFileUrl`. Both are for
  files a run made, not files the app ships.
- **The app file route**, `GET /apps/:name/:version/files/<path>`, serves a
  version's files to a HOST holding the file token. The page itself never
  reaches it: the document's CSP names no host.
- plans/apps.md §2.3 already says "Files under `public/` and anything
  imported by path are inlined". The build inlines only what is imported, so
  that sentence describes what this plan builds.

None of these maps a path to a file, so this plan adds that.

## Proposal

1. **The build puts `public/` in the document as a table of paths.** Each
   file under `public/` becomes an entry, `"/models/fox.vox"` → its data
   URL, in a module the entry imports before the app. That module hands the
   table to the kit (`installAppFiles`, from `@strut/kit/bootstrap`). These
   files are left out:
   - files whose name starts with `.`, as the build skips today;
   - the images `app.yaml` lists under `screenshots:`, which the store
     shows and the page never uses.

   A binary file that the app also imports goes through the same module as
   the import, so the document holds its bytes once. Every file in the
   table is a data URL, whatever its type. A `.json` the page fetches by
   path is bytes, as it would be from a server. An `import` of the same file
   still gives its value.
   The file limits stay as they are (2,000 files, 20 MB of source), and so
   does the warning past 6 MB. That warning gains one clause naming what
   `public/` added to the document.
2. **The kit answers those paths.**
   - `appFileUrl(path)` (from `@strut/kit`) returns the data URL, or
     `undefined` when no such file exists. It is plain, not a hook, because
     the table is fixed for a version. `"/models/fox.vox"` and
     `"models/fox.vox"` both name `public/models/fox.vox`.
   - The kit wraps the page's `fetch`. A path in the table is read
     from its data URL. Any other request goes to the real `fetch`, which
     the CSP refuses as it does today. A string argument is matched as
     written. A `Request` (or `URL`) is matched by its pathname, since the
     document's base URL is the host page's.

   So code written for a static host works unchanged wherever it fetches.
   That includes three's file-based loaders (`FileLoader`, and with it
   `GLTFLoader`, drei's `useGLTF`, `AudioLoader`) and `ImageBitmapLoader`.
   What does not go through `fetch` takes `appFileUrl`: `<img src>`,
   `new Audio()`, and three's `TextureLoader`, which draws through an
   `<img>`. One line covers every three loader:
   `THREE.DefaultLoadingManager.setURLModifier((u) => appFileUrl(u) ?? u)`.
3. **The pages say it.**
   - The `App` Concept page's "Files are imports" paragraph gains: a file in
     `public/` is also the app's file by path, in `fetch` and `appFileUrl`,
     and everything in `public/` ships in the document.
   - The `Game` page's "Models, textures and other files" section drops
     "`"/models/ship.glb"` fails" and shows the by-path form beside the
     import, with the `setURLModifier` line.
   - `docs/apps.md` describes the table and the `fetch` wrapper.
   - plans/apps.md §2.3 points here.
4. **`app/look`'s `saveAs` example** becomes `screenshots/home.png`, the
   folder a person's screenshots already go to (src/apps/screenshots.ts),
   instead of `public/screenshots/home.png`. A shot saved under `public/`
   and never listed under `screenshots:` would otherwise ship in the
   document.

No host changes. The table is in the document, so strut's UI, Hive, Peel,
the public view and another strut's UI all serve it as they serve the
document today.

### Tests

- `src/apps/build.test.ts`:
  - a file under `public/` is in the table under its path;
  - a file both imported and in the table is in the document once;
  - a listed screenshot and a dotfile are not in the table;
  - a `.json` in the table is a data URL, while its import is its value.
- The kit: `appFileUrl` with and without a leading `/`. The `fetch` wrapper
  with a string, a `Request` and a `URL`. A path not in the table reaches
  the real `fetch`.
- End to end, by hand: the game above, with `models.ts` deleted and its
  loader back to `fetch(url)`, builds and plays in a sandboxed srcdoc
  frame. Holding W reaches the first coin, and `collected` goes to 1.

## Not in this plan

- **Loading on demand.** Everything in `public/` still ships in the one
  document, so a game with large textures or sound reaches the 6 MB warning
  the same way it does today. If games outgrow that, the next step is a step
  that reads one file of the app's version through the bridge (as
  `run/files` reads a run's), behind the same `appFileUrl` and `fetch`
  wrapper, so the page's code does not change.
- **`url(/bg.png)` in the app's CSS.** The build could rewrite these to data
  URLs when it compiles the styles. That can come later.
- **Another app's `public/`.** An app imported by name (`acme/ui`) brings its
  `src/` only, as today.

## Rulings (all as recommended, 2026-11-24)

1. **Which files ship.** Recommended: all of `public/` except dotfiles and
   listed screenshots. That is the static-host rule people and models
   already know, and no seeded app has a `public/` folder, so none grows. A
   person's app with files in `public/` that it never imported grows by
   those files, and the build's size warning says so. The alternative is an
   opt-in list in `app.yaml` (`files: ["public/models/**"]`): nothing
   changes for an app that does not use it, but it is one more key to learn.
2. **The `fetch` wrapper.** Recommended: yes. Code written for a static
   host (and three's model loaders) then works unchanged, and a model's
   reflex `fetch("/data.json")` stops failing, as the kit's `ALIASES`
   already accept the specifiers models write by reflex. The alternative is
   `appFileUrl` alone: no global wrapper, but every by-path read changes.
3. **Inline now, on demand later.** Recommended: inline. The page stays one
   document, which works in every host and offline in Peel, and there is no
   new step to grant. The alternative is to build loading on demand through
   the bridge first, which also lifts the 6 MB budget but adds a step, its
   grants on every door, and a round trip per file.
4. **The path forms.** Recommended: `/x` and `x` both mean `public/x`. A
   `Request` is matched by pathname, so under a host served at a sub-path
   (mcp's `/lab`) only the `/x` form matches there. The Concept pages
   write `/x`.
