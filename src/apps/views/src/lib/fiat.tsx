import { createContext, useContext, useMemo, type ReactNode } from "react";
import { FIAT_CURRENCIES, formatFiat, satsToFiat, useAppState, useBtcPrice, useLocale, type FiatCurrency } from "@strut/kit";

// The worker's fiat display (plans/worker-peel-style.md): sats stay the money,
// and a currency the worker picks puts its value beside them, "125 sats · $0.12",
// from `btc/price`. Their pick is kept by strut per viewer (`useAppState`), so
// it follows them across visits and devices. "off" is sats only, and so is a
// price that cannot be had: nothing says so, nothing breaks.

export type FiatChoice = FiatCurrency | "off";
export const FIAT_CHOICES: readonly FiatChoice[] = ["off", ...FIAT_CURRENCIES];

/** `msat` as fiat text (`$0.12`), or undefined when there is none to show. */
type FiatOf = (msat: number) => string | undefined;

const none: FiatOf = () => undefined;
const FiatContext = createContext<FiatOf>(none);

/** What a worker picked: `[choice, set]`. Anything not a currency here is "off". */
export function useFiatChoice(): [FiatChoice, (c: FiatChoice) => void] {
  const [raw, set] = useAppState<string>("fiat", "off");
  const choice = (FIAT_CHOICES as readonly string[]).includes(raw) ? (raw as FiatChoice) : "off";
  return [choice, set];
}

/** Draws `children` with fiat beside every amount below, in the worker's currency. */
export function FiatProvider({ children }: { children: ReactNode }) {
  const [choice] = useFiatChoice();
  const locale = useLocale();
  const price = useBtcPrice(choice === "off" ? null : choice);
  const perBtc = price.perBtc;
  const of = useMemo<FiatOf>(
    () => (choice === "off" || !perBtc ? none : (msat) => formatFiat(satsToFiat(msat / 1000, perBtc), choice, locale)),
    [choice, perBtc, locale],
  );
  return <FiatContext.Provider value={of}>{children}</FiatContext.Provider>;
}

/** The fiat text for an amount, when the worker chose one and a price is known. */
export function useFiatOf(): FiatOf {
  return useContext(FiatContext);
}
