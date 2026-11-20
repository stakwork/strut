import type { ReactNode } from "react";

export function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">{props.title}</h2>
      {props.children}
    </section>
  );
}

export function Label(props: { children: ReactNode }) {
  return <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{props.children}</div>;
}
