/** Test setup: a happy-dom window as the global document, registered BEFORE
 *  react-dom is imported (it reads `window` at module load). Import it first
 *  in a test file. */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register({ url: "http://localhost/", width: 800, height: 600 });

/** Tell React the test drives updates through `act()`. */
export function useActEnvironment() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

/** Close the window once a test file is done — its timers would otherwise
 *  keep the process alive. Call it from `after()`. */
export async function teardownDom() {
  await new Promise((r) => setTimeout(r, 20));
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
}
