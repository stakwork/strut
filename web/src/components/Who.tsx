import { useEffect, useState } from "preact/hooks";
import { getPeople } from "../api";
import { actorLabel, createNameCache } from "../names";

// ── Who an actor is, as the UI shows them (plans/people-and-hosts.md §1) ───
// Their name where one is kept, else what showed before; the whole actor in
// the tooltip. One cache for the page (../names): each actor asked once.

const names = createNameCache(getPeople);

/** What shows for each actor, read again as names come back. */
export function useActorLabel(...actors: Array<string | undefined>): (actor: string) => string {
  const [, setRev] = useState(0);
  useEffect(() => names.subscribe(() => setRev((n) => n + 1)), []);
  useEffect(() => names.want(actors), [actors.join("\n")]);
  return (actor) => actorLabel(actor, names.nameOf(actor));
}

/** An actor as the UI shows them: their name, else the text before the
 *  first `-`, the whole actor in the tooltip. */
export function Who(props: { actor: string }) {
  const label = useActorLabel(props.actor);
  return <span title={props.actor}>{label(props.actor)}</span>;
}
