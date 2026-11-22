import { useQuery } from "@tanstack/react-query";
import { useStrutClient } from "./provider.js";
import type { FiatCurrency } from "./lib/fiat.js";

/** The step behind `useBtcPrice` (grant it in app.yaml). */
export const BTC_PRICE_STEP = "btc/price";
export const BTC_PRICE_REFETCH_MS = 60_000;

/** The live price of one bitcoin in `currency` (`btc/price`), shared by every
 *  component asking for the same currency and read again each minute. `null`
 *  asks nothing. A failure leaves `perBtc` null and `error` set; it never throws. */
export function useBtcPrice(currency: FiatCurrency | null): { perBtc: number | null; at?: string; isLoading: boolean; error?: string } {
  const client = useStrutClient();
  const q = useQuery({
    queryKey: ["strut", "btc-price", currency],
    queryFn: () => client.run<{ perBtc: number; at: string }>(BTC_PRICE_STEP, { currency }),
    enabled: currency !== null,
    staleTime: BTC_PRICE_REFETCH_MS,
    refetchInterval: BTC_PRICE_REFETCH_MS,
    retry: false,
  });
  const perBtc = typeof q.data?.perBtc === "number" ? q.data.perBtc : null;
  return {
    perBtc,
    ...(perBtc !== null && q.data?.at ? { at: q.data.at } : {}),
    isLoading: currency !== null && q.isLoading,
    ...(q.error ? { error: q.error instanceof Error ? q.error.message : String(q.error) } : {}),
  };
}
