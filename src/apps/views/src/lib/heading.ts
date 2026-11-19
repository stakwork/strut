// The worker page's header (components/WorkerTask.tsx `WorkerPage`), pure so
// a test reads it without a page.

/** The worker page's header: the page's own title, else the server's name
 *  (the employer) with "Tasks" under it, else "Tasks" with what the work is
 *  under it. A `line` given — "" for none — is the second line whatever the
 *  first. */
export function workerHeading(o: { named?: string | undefined; line?: string | undefined; server?: string | undefined; words: { title: string; subtitle: string } }): { title: string; subtitle: string } {
  const server = o.named === undefined ? o.server?.trim() || undefined : undefined;
  return {
    title: o.named ?? server ?? o.words.title,
    subtitle: o.line ?? (server ? o.words.title : o.words.subtitle),
  };
}
