// Who is viewing: the actor `conversation/list` says the list is for. A new
// conversation is theirs (`<viewer>/…`), and a job's captcha is theirs to
// answer when they started the job.
import { createContext, useContext } from "react";

export const ViewerContext = createContext<string | undefined>(undefined);

export const useViewer = () => useContext(ViewerContext);
