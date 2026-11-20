// Answers (plans/human-steps.md §9.5, §9.6): what was asked of people and
// what they answered, with the verdict on each, in one tab. One by one
// (./Tasks: every task, newest first) or, once a workflow named a group with
// task/reply's group, by group (./Groups: a set of answers read and reviewed
// as one). A task opens its own page; a group its grid.
import type { Place, Shown } from "../lib/view";
import type { TaskStats, TaskType, Worker } from "../lib/types";
import { GroupList, GroupPage } from "./Groups";
import { TaskDetail, TaskList } from "./Tasks";

export interface AnswersProps {
  go: (p: Place) => void;
  place: Place;
  shown: Shown;
  /** A workflow named a group here: the answers can be read by group. */
  hasGroups: boolean;
  types?: TaskType[] | undefined;
  workers?: Worker[] | undefined;
  /** The queue's counts, for what is left to review. */
  stats?: TaskStats | undefined;
}

export function Answers(props: AnswersProps) {
  if (props.place.task) return <TaskDetail {...props} id={props.place.task} />;
  if (props.place.group) return <GroupPage {...props} group={props.place.group} />;
  return props.place.tab === "groups" ? <GroupList {...props} /> : <TaskList {...props} />;
}
