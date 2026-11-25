/**
 * Seeded apps that were renamed, old name → new. 2026-11-25: the admin's
 * app titled Workers was `strut/staff` and the worker's app titled Tasks
 * was `strut/worker`; each name now says what its title does. A box that
 * ran the old names carries them over at boot (./renamed-boot.ts), and a
 * link made before opens the new name: the web UI's `?app=` (`renamedAppUrl`),
 * `GET /public/apps/<name>`, and an invite's token. Pure: the web imports it.
 */
export const RENAMED_APPS: Readonly<Record<string, string>> = {
  "strut/staff": "strut/workers",
  "strut/worker": "strut/tasks",
};

/** The name an app goes by now. */
export function renamedApp(name: string): string {
  return Object.hasOwn(RENAMED_APPS, name) ? RENAMED_APPS[name]! : name;
}

/** `href` with an old name in `?app=` or `?back=` (a hop's Back) put to its
 *  new one; null when it names none. */
export function renamedAppUrl(href: string): string | null {
  const url = new URL(href);
  let changed = false;
  for (const key of ["app", "back"]) {
    const name = url.searchParams.get(key);
    if (name === null || renamedApp(name) === name) continue;
    url.searchParams.set(key, renamedApp(name));
    changed = true;
  }
  return changed ? url.href : null;
}
