// The app's OWN badge: shadows the kit's @/components/ui/badge (shadcn's model).
import type { ReactNode } from "react";

export const OVERRIDE_MARK = "hello-fixture-badge-override";

export function Badge({ children }: { children: ReactNode }) {
  return <span data-mark={OVERRIDE_MARK} className="rounded-full border px-2 py-0.5 text-xs">{children}</span>;
}
