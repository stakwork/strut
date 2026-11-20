// The first line of the two lists of answers: which list, and its filters.
import type { ReactNode } from "react";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import type { Place } from "../lib/view";
import type { TaskType } from "../lib/types";
import { Segmented } from "./bits";

/** The two lists' first line: which view, and the filters that view has. */
export function AnswersHead(props: { view: "groups" | "tasks"; hasGroups: boolean; go: (p: Place) => void; type: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <h2 className="text-base font-semibold">Answers</h2>
      {props.hasGroups && (
        <Segmented
          label="How the answers are listed"
          value={props.view}
          onChange={(v) => props.go({ tab: v, ...(props.type ? { type: props.type } : {}) })}
          options={[
            { value: "groups", label: "By group" },
            { value: "tasks", label: "One by one" },
          ]}
        />
      )}
      <div className="ml-auto flex flex-wrap items-center gap-2">{props.children}</div>
    </div>
  );
}

/** The task type the list is of. */
export function TypeSelect(props: { types?: TaskType[] | undefined; value: string; onChange: (type: string) => void }) {
  return (
    <NativeSelect aria-label="Task type" value={props.value} onChange={(e) => props.onChange(e.target.value)}>
      <NativeSelectOption value="">Every task type</NativeSelectOption>
      {(props.types ?? []).map((t) => (
        <NativeSelectOption key={t.name} value={t.name}>
          {t.name}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}
