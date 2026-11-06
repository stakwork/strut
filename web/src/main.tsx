import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import * as api from "./api";
import { App } from "./app";
import { reportReady } from "./embed";

/** A host signed this tab in with a ticket (./api `ticketSignIn`) that was
 *  refused, or whose session has since ended: only the host can sign the
 *  person in again. Never the Settings key prompt — they have no key. */
function SignInExpired() {
  useEffect(reportReady, []);
  return (
    <div class="app-solo">
      <div class="empty">This sign-in link has expired. Reload the page from the app you opened it in to sign in again.</div>
    </div>
  );
}

function Root({ refused, session }: { refused: boolean; session: api.SessionInfo | null }) {
  const [expired, setExpired] = useState(refused);
  useEffect(() => {
    api.onHostSignInEnd(() => setExpired(true));
    return () => api.onHostSignInEnd(null);
  }, []);
  return expired ? <SignInExpired /> : <App session={session} />;
}

// A host's ticket is traded before anything renders, so it is the page's
// first request and every later one is signed in as its person. Then the
// session says which page this is: a member's is their apps, never the
// shell (./page `pickPage`).
void Promise.all([api.ticketSignIn, api.pageSession]).then(([result, session]) => {
  render(<Root refused={result === "refused"} session={session} />, document.getElementById("app")!);
});
