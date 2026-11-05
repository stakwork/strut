import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import * as api from "./api";
import * as brand from "./instance-theme";
import { App } from "./app";

// The server's brand, fetched beside the ticket trade: a frame waits for it.
void brand.ready();

/** A host signed this tab in with a ticket (./api `ticketSignIn`) that was
 *  refused, or whose session has since ended: only the host can sign the
 *  person in again. Never the Settings key prompt — they have no key. */
function SignInExpired() {
  return (
    <div class="app-solo">
      <div class="empty">This sign-in link has expired. Reload the page from the app you opened it in to sign in again.</div>
    </div>
  );
}

function Root({ refused }: { refused: boolean }) {
  const [expired, setExpired] = useState(refused);
  useEffect(() => {
    api.onHostSignInEnd(() => setExpired(true));
    return () => api.onHostSignInEnd(null);
  }, []);
  return expired ? <SignInExpired /> : <App />;
}

// A host's ticket is traded before anything renders, so it is the page's
// first request and every later one is signed in as its person.
void api.ticketSignIn.then((result) => {
  render(<Root refused={result === "refused"} />, document.getElementById("app")!);
});
