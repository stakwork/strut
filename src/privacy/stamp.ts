// The stamp rides on `providerMetadata` of every part a model returns; the AI SDK hands it
// back as `providerOptions` on the assistant prompt parts of the next call. It names the
// stored raw copy of that part. It is never sent to a provider.
export const STAMP = "strutPrivacy";
export type Stamp = { id: string; i: number };

/** Merged INTO the part's metadata: `anthropic`, `cacheControl` and the rest stay. */
export const withStamp = (pm: Record<string, any> | undefined, s: Stamp): Record<string, any> => ({ ...(pm ?? {}), [STAMP]: s });

export function readStamp(opts: Record<string, any> | undefined): Stamp | undefined {
  const s = opts?.[STAMP];
  return s && typeof s.id === "string" && Number.isInteger(s.i) ? { id: s.id, i: s.i } : undefined;
}

export function stripStamp(opts: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!opts || !(STAMP in opts)) return opts;
  const { [STAMP]: _s, ...rest } = opts;
  return Object.keys(rest).length ? rest : undefined;
}

/** `{ ...part, providerOptions }` without the stamp, and without the key when nothing is left. */
export function unstamped<T extends { providerOptions?: any }>(part: T): T {
  const { providerOptions, ...rest } = part;
  const o = stripStamp(providerOptions);
  return (o ? { ...rest, providerOptions: o } : rest) as T;
}
