import { WorkerPage } from "strut/views";

// strut/worker (plans/human-steps.md §5): the server's one work link. Its
// dashboard lists the task types of EVERY app the worker can open here
// (`everyApp`); a type whose app is `strut/worker` is drawn here by strut/views'
// WorkerPage — the ask, the photos the type takes, the answer's fields — and
// a type another app draws opens that app on it, Back returning here. An app
// with a view of its own starts from the same pieces: WorkerTask, TaskPhotos
// and TaskForm. Its words are WorkerPage's own, in the worker's language
// (plans/i18n.md): no title or intro here, which would be English alone.
export default function App() {
  return <WorkerPage everyApp />;
}
