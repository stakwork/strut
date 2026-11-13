// What a waiting run waits on, as links (plans/human-steps.md §9.1): the run
// overview's "Waiting on" line and a parked step's flyout turn `task:<id>`
// into `strut/staff` opened on that task (`?app=strut/staff&input=task%3D<id>`),
// for a viewer the app is listed to — an admin; anyone else reads the text.
// Pure, so the root test run tests it.

/** The app a waiting run's task opens in. */
export const STAFF_APP = "strut/staff";

export interface WaitingPart {
  text: string;
  /** The app and its input when the part opens one. */
  app?: { name: string; input: string };
}

export function waitingParts(on: readonly string[] | undefined, staffListed: boolean): WaitingPart[] {
  return (on ?? []).map((text) => {
    const m = /^task:(.+)$/.exec(text);
    return m && staffListed ? { text, app: { name: STAFF_APP, input: new URLSearchParams({ task: m[1]! }).toString() } } : { text };
  });
}
