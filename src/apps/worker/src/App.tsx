import { WorkerPage } from "strut/views";

// strut/worker (plans/human-steps.md §5): any task type whose app is
// `strut/worker`, drawn by strut/views' WorkerPage — the ask, the photos the
// type takes, the answer's fields. An app with a view of its own starts from
// the same pieces: WorkerTask, TaskPhotos and TaskForm.
export default function App() {
  return <WorkerPage title="Work" intro="Sign in, then do the tasks that show up here. Each one pays what it says." />;
}
