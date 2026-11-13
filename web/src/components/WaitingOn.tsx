import { waitingParts } from "../waiting";

/** What a waiting run or a parked step waits on: a task opens strut/staff on
 *  it (./waiting.ts), for a viewer the app is listed to. */
export function WaitingOn(props: { on: readonly string[] | undefined; staffListed?: boolean; onOpenApp?: (name: string, input?: string) => void }) {
  const parts = waitingParts(props.on, !!props.staffListed && !!props.onOpenApp);
  if (!parts.length) return <>something outside the run</>;
  return (
    <>
      {parts.map((p, i) => (
        <span key={p.text}>
          {i > 0 && ", "}
          {p.app ? (
            <button type="button" class="link-button" title="Open this task in Tasks and workers" onClick={() => props.onOpenApp!(p.app!.name, p.app!.input)}>
              {p.text}
            </button>
          ) : (
            p.text
          )}
        </span>
      ))}
    </>
  );
}
