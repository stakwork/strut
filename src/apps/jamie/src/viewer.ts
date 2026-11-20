// Who is viewing: the actor `conversation/list` says the list is for. A new
// conversation is theirs (`<viewer>/…`), and a job's captcha is theirs to
// answer when they started the job. And whether the thread is one they only
// READ — an admin reading someone else's (plans/jamie-app.md §2.3) — whose
// cards then decide nothing.
import { createContext, useContext } from "react";

export const ViewerContext = createContext<string | undefined>(undefined);

export const useViewer = () => useContext(ViewerContext);

export const ReadOnlyContext = createContext(false);

export const useReadOnly = () => useContext(ReadOnlyContext);
