/**
 * The STAFF's routes for the task store (plans/human-steps.md §6): task
 * types, workers, grants, and the tasks with their leases. Full scope only,
 * reads included — the deployment key or an admin's session — like the
 * earnings: a peer's read, a member's session and a visitor are refused.
 * Names with a `/` (a task type `acme/pet-match`) travel as one encoded
 * segment (`acme%2Fpet-match`), as a workflow's do.
 *
 * - `GET /tasks/types` → `{ types }`
 * - `PUT /tasks/types/:name { app, answer, leaseSeconds?, withinHours?, enabled?, open?, paySats?, holdHours?, tests?, copies? }`
 *   → `{ type }`: the whole type (a PUT: what is left out is the default;
 *   open, `tests` and `copies` off). A paid open type with fewer ready
 *   tests than its K is refused, `409 needs_tests` (ruling 9)
 * - `DELETE /tasks/types/:name` → `{ name, revoked }`: refused (409) while
 *   a task of the type is open; its live grants are revoked
 * - `GET /tasks/workers[?status=]` → `{ workers }`, each with its `balance`
 *   and its `standing` per type with tests
 * - `GET /tasks/workers/:actor` → `{ worker, holding?, week, recent }`: the
 *   same for one, with their live lease, the last 7 days by type and their
 *   newest 50 leases (plans/human-steps.md §9.4)
 * - `PUT /tasks/workers/:actor { status?, note? }` → `{ worker }`
 * - `PUT /tasks/workers/:actor/grants/:type [{ qualify?: false }]` →
 *   `{ worker, notice? }`: a grant of a type with tests records its K
 * - `DELETE /tasks/workers/:actor/grants/:type[?why=]` → `{ worker }`
 * - `GET /tasks/stats[?type=]` → the queue (plans/human-steps.md §9.4): per
 *   type waiting, working, the oldest waiting, due within a day, workers
 *   granted, holding and asking, what is wrong with its app
 *   (`appProblem`), and per hour, day and week what was answered,
 *   expired, cancelled, disputed, skipped and lost, with time to answer
 *   and work time (p50, p90); across types the workers by status, holding
 *   and asking. Computed on read
 * - `GET /tasks[?type=&status=&workflow=&runId=&by=&review=&test=&before=&limit=]` → `{ tasks }`,
 *   newest first, each with its leases (an answer's `earning` and its
 *   verdict, `review`, with it; a copies task's answers and whether each
 *   agreed on its leases);
 *   `by` the tasks an actor answered (any of a copies task's answers);
 *   `review=none|ok|rejected` the real tasks with an answer not reviewed,
 *   or marked so (that actor's, with `by`): the review queue;
 *   `test=true` the test instances alone, `false` the real tasks;
 *   `status=disputed` the copies tasks whose answers did not agree
 * - `GET /tasks/:id` → `{ task, run }`: `run` the run's status now and what
 *   it waits on (`{ status, waitingOn? }`), null for a test instance or a
 *   run not on file
 * - `GET /tasks/:id/files/<path>` → one of the task's files, as `run/files`
 *   answers one; `404 not_listed` for a path not on its list
 * - `POST /tasks/:id/take-back { worker?, why }` → `{ task, earnings }`: the
 *   earnings the task's answers made (or `worker`'s) taken back while held
 *   (plans/human-steps.md §8.1); `409 released` when every one asked for is
 *   past its hold
 * - `PUT /tasks/:id/review { worker?, verdict, why? }` → `{ task, worker,
 *   lease, review, earning? }`: a person's verdict on one answer, `ok` or
 *   `rejected` (which says why) (plans/human-steps.md §9.6). `worker` only
 *   when the task has several answers. A mark: the run is not touched. It
 *   can change until the answer's hold ends, then `409 final`
 *
 * The TEST routes (plans/human-steps.md §7.1) — the only answers that hold
 * a test's expected answer, or what its grader said:
 *
 * - `GET /tasks/tests[?type=&retired=]` → `{ tests }`, each with how often
 *   it was served, passed, failed and graded `error`
 * - `GET /tasks/tests/:id` → `{ test, instances }`
 * - `POST /tasks/tests { type, show?, files?, expected, grade? }` → `{ test }`
 * - `PUT /tasks/tests/:id/files/<path>` (the raw bytes) → `{ test }`
 * - `POST /tasks/:id/test { expected?, grade? }` → `{ test }`: made from a
 *   real task
 * - `PUT /tasks/tests/:id { show?, expected?, grade? }` → `{ test }`; `409
 *   in_use` once it was served
 * - `DELETE /tasks/tests/:id` → `{ test }`, retired
 */
import type { Context, Hono } from "hono";
import { TASK_STATUSES, VERDICTS, type TaskStatus, type Verdict } from "./task-store.js";
import { WORKER_STATUSES, type WorkerStatus } from "./worker-store.js";
import { TaskError, type TaskErrorCode, type TasksCapability, type TasksService } from "./tasks.js";
import { TEST_FILE_MAX_BYTES } from "./test-files.js";

export interface TaskRoutesDeps {
  isFull: (c: Context) => Promise<boolean>;
  /** Who made a change: the type's `changedBy`, a grant's `by`. */
  actorOf: (c: Context) => Promise<string | undefined>;
  tasks: TasksCapability;
  /** A person's take-back (§8.1): the service's, never on a capability.
   *  Absent (a host's own store): the route answers 501. */
  takeBack?: TasksService["takeBack"];
  /** A person's verdict on an answer (§9.6): the service's, never on a
   *  capability. Absent (a host's own store): the route answers 501. */
  review?: TasksService["review"];
  /** The staff's tests (§7.1): the service's, never on a capability.
   *  Absent (a host's own store): the test routes answer 501. */
  tests?: TasksService["tests"];
  /** §9.4: what is wrong with the app a type names (`taskAppProblem`), for
   *  the queue. Absent: not checked. */
  appProblem?: (app: string) => Promise<string | undefined>;
  /** §9.4: a task's run now — its status and what it waits on — or null
   *  when there is none on file. Absent: every task's `run` is null. */
  runOf?: (workflow: string, runId: string) => Promise<{ status: string; waitingOn?: string[] } | null>;
}

const STATUS: Partial<Record<TaskErrorCode, 400 | 404 | 409>> = {
  bad_request: 400,
  bad_schema: 400,
  unknown_type: 404,
  unknown_worker: 404,
  unknown_task: 404,
  unknown_test: 404,
  not_listed: 404,
  no_file: 404,
  no_answer: 404,
  in_use: 409,
  final: 409,
  needs_tests: 409,
};

export function taskRoutes(app: Hono<any>, deps: TaskRoutesDeps): void {
  const { tasks } = deps;
  const refuse = async (c: Context) =>
    (await deps.isFull(c)) ? null : c.json({ error: "forbidden: task types and workers are an admin's: the deployment key or an admin's session" }, 403);
  /** The route's answer, or its refusal as the task store said it. */
  const answer = async (c: Context, fn: () => Promise<Record<string, unknown>>) => {
    const refused = await refuse(c);
    if (refused) return refused;
    try {
      return c.json(await fn());
    } catch (err) {
      if (err instanceof TaskError) return c.json({ error: err.message, code: err.code }, STATUS[err.code] ?? 400);
      throw err;
    }
  };
  const body = async (c: Context): Promise<Record<string, unknown>> => {
    const v = (await c.req.json().catch(() => undefined)) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new TaskError("bad_request", "the body is a JSON object");
    return v as Record<string, unknown>;
  };
  const by = async (c: Context) => {
    const actor = await deps.actorOf(c);
    return actor === undefined ? {} : { by: actor };
  };

  app.get("/tasks/types", (c) => answer(c, async () => ({ types: await tasks.types() })));

  app.put("/tasks/types/:name", (c) =>
    answer(c, async () => {
      const b = await body(c);
      const input = {
        app: b["app"] as string,
        answer: b["answer"],
        ...(b["leaseSeconds"] !== undefined ? { leaseSeconds: b["leaseSeconds"] as number } : {}),
        ...(b["withinHours"] !== undefined ? { withinHours: b["withinHours"] as number } : {}),
        ...(b["enabled"] !== undefined ? { enabled: b["enabled"] as boolean } : {}),
        ...(b["open"] !== undefined ? { open: b["open"] as boolean } : {}),
        ...(b["paySats"] !== undefined ? { paySats: b["paySats"] as number } : {}),
        ...(b["holdHours"] !== undefined ? { holdHours: b["holdHours"] as number } : {}),
        ...(b["tests"] !== undefined ? { tests: b["tests"] as Record<string, unknown> | null } : {}),
        ...(b["copies"] !== undefined ? { copies: b["copies"] as Record<string, unknown> | null } : {}),
      };
      return { type: await tasks.setType(c.req.param("name"), input, (await by(c)).by) };
    }),
  );

  app.delete("/tasks/types/:name", (c) => answer(c, async () => tasks.deleteType(c.req.param("name"), (await by(c)).by)));

  app.get("/tasks/workers", (c) =>
    answer(c, async () => {
      const status = c.req.query("status") || undefined;
      if (status !== undefined && !WORKER_STATUSES.includes(status as WorkerStatus)) throw new TaskError("bad_request", `status is one of ${WORKER_STATUSES.join(", ")}`);
      return { workers: await tasks.workers(status ? { status: status as WorkerStatus } : {}) };
    }),
  );

  /** A route a host's own store may predate: 501 when it lacks `method`. */
  const lacks = async (c: Context, method: keyof TasksCapability, what: string) =>
    typeof tasks[method] === "function" ? null : ((await refuse(c)) ?? c.json({ error: `this server's task store is its host's: it has no ${what}`, code: "not_available" }, 501));

  app.get("/tasks/workers/:actor", async (c) => {
    const missing = await lacks(c, "worker", "one-worker read");
    if (missing) return missing;
    return answer(c, async () => {
      const actor = c.req.param("actor");
      const worker = await tasks.worker(actor);
      if (!worker) throw new TaskError("unknown_worker", `no worker ${actor} here`);
      // What they hold and did (§9.4), where the store answers it.
      const activity = typeof tasks.activity === "function" ? await tasks.activity(actor) : undefined;
      return { worker, ...(activity ?? {}) };
    });
  });

  // The queue (§9.4), before `/tasks/:id`.
  app.get("/tasks/stats", async (c) => {
    const missing = await lacks(c, "stats", "queue counts");
    if (missing) return missing;
    return answer(c, async () => {
      const type = c.req.query("type") || undefined;
      const stats = await tasks.stats(type ? { type } : {});
      if (deps.appProblem) {
        const problems = new Map<string, string | undefined>();
        for (const app of new Set(stats.types.map((t) => t.app))) problems.set(app, await deps.appProblem(app));
        for (const t of stats.types) {
          const problem = problems.get(t.app);
          if (problem) t.appProblem = problem;
        }
      }
      return stats as unknown as Record<string, unknown>;
    });
  });

  app.put("/tasks/workers/:actor", (c) =>
    answer(c, async () => {
      const b = await body(c);
      for (const k of Object.keys(b)) if (k !== "status" && k !== "note") throw new TaskError("bad_request", `a worker's change is status and note, not ${k}`);
      const change = {
        ...(b["status"] !== undefined ? { status: b["status"] as WorkerStatus } : {}),
        ...(b["note"] !== undefined ? { note: b["note"] as string | null } : {}),
      };
      return { worker: await tasks.setWorker(c.req.param("actor"), change, (await by(c)).by) };
    }),
  );

  app.put("/tasks/workers/:actor/grants/:type", (c) =>
    answer(c, async () => {
      // An empty body is a grant as it always was; `{ qualify: false }`
      // starts it with no qualifying, for a worker staff know (§7.5).
      const text = (await c.req.text()).trim();
      let parsed: unknown = {};
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TaskError("bad_request", "a grant's body is empty, or { qualify: false }");
      for (const k of Object.keys(parsed)) if (k !== "qualify") throw new TaskError("bad_request", `a grant's body is { qualify }, not ${k}`);
      const q = (parsed as { qualify?: unknown }).qualify;
      if (q !== undefined && typeof q !== "boolean") throw new TaskError("bad_request", "qualify is true or false");
      const { notice, ...worker } = await tasks.grant(c.req.param("actor"), c.req.param("type"), (await by(c)).by, q === undefined ? {} : { qualify: q });
      return { worker, ...(notice ? { notice } : {}) };
    }),
  );

  app.delete("/tasks/workers/:actor/grants/:type", (c) =>
    answer(c, async () => {
      const why = c.req.query("why") || undefined;
      return { worker: await tasks.revoke(c.req.param("actor"), c.req.param("type"), { ...(await by(c)), ...(why !== undefined ? { why } : {}) }) };
    }),
  );

  app.get("/tasks", (c) =>
    answer(c, async () => {
      const q = c.req.query();
      if (q["status"] && !TASK_STATUSES.includes(q["status"] as TaskStatus)) throw new TaskError("bad_request", `status is one of ${TASK_STATUSES.join(", ")}`);
      const num = (k: string) => {
        const v = q[k];
        if (v === undefined || v === "") return undefined;
        const n = Number(v);
        if (!Number.isSafeInteger(n) || n <= 0) throw new TaskError("bad_request", `${k} is a whole number above 0`);
        return n;
      };
      const before = num("before");
      const limit = num("limit");
      if (q["test"] && q["test"] !== "true" && q["test"] !== "false") throw new TaskError("bad_request", "test is true or false");
      const review = q["review"] || undefined;
      if (review !== undefined && review !== "none" && !VERDICTS.includes(review as Verdict)) throw new TaskError("bad_request", `review is none, ${VERDICTS.join(" or ")}`);
      return {
        tasks: await tasks.list({
          ...(q["test"] ? { test: q["test"] === "true" } : {}),
          ...(q["type"] ? { type: q["type"] } : {}),
          ...(q["status"] ? { status: q["status"] as TaskStatus } : {}),
          ...(q["workflow"] ? { workflow: q["workflow"] } : {}),
          ...(q["runId"] ? { runId: q["runId"] } : {}),
          ...(q["by"] ? { by: q["by"] } : {}),
          ...(review !== undefined ? { review: review as "none" | Verdict } : {}),
          ...(before !== undefined ? { before } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      };
    }),
  );

  // ── tests (§7.1): the service's, before `/tasks/:id` ────────────────
  /** A test route's answer: 501 where the store is a host's. */
  const testAnswer = (c: Context, fn: (t: NonNullable<TaskRoutesDeps["tests"]>) => Promise<Record<string, unknown>>) =>
    deps.tests ? answer(c, () => fn(deps.tests!)) : refuse(c).then((r) => r ?? c.json({ error: "this server's task store is its host's: tests are not available here", code: "not_available" }, 501));
  const only = (b: Record<string, unknown>, keys: string[], what: string) => {
    for (const k of Object.keys(b)) if (!keys.includes(k)) throw new TaskError("bad_request", `${what} is ${keys.join(", ")}, not ${k}`);
  };

  app.get("/tasks/tests", (c) =>
    testAnswer(c, async (t) => {
      const retired = c.req.query("retired");
      if (retired && retired !== "true" && retired !== "false") throw new TaskError("bad_request", "retired is true or false");
      const type = c.req.query("type") || undefined;
      return { tests: await t.list({ ...(type ? { type } : {}), ...(retired ? { retired: retired === "true" } : {}) }) };
    }),
  );

  app.post("/tasks/tests", (c) =>
    testAnswer(c, async (t) => {
      const b = await body(c);
      only(b, ["type", "show", "files", "expected", "grade"], "a test");
      return {
        test: await t.create(
          {
            type: b["type"] as string,
            expected: b["expected"],
            ...(b["show"] !== undefined ? { show: b["show"] } : {}),
            ...(b["files"] !== undefined ? { files: b["files"] as string[] } : {}),
            ...(b["grade"] !== undefined ? { grade: b["grade"] as never } : {}),
          },
          (await by(c)).by,
        ),
      };
    }),
  );

  app.get("/tasks/tests/:id", (c) =>
    testAnswer(c, async (t) => {
      const got = await t.get(c.req.param("id"));
      if (!got) throw new TaskError("unknown_test", `no test ${c.req.param("id")}`);
      return got;
    }),
  );

  app.put("/tasks/tests/:id/files/*", (c) =>
    testAnswer(c, async (t) => {
      const id = c.req.param("id");
      const marker = `/tasks/tests/${id}/files/`;
      const at = c.req.path.indexOf(marker);
      let path: string;
      try {
        path = c.req.path.slice(at + marker.length).split("/").map(decodeURIComponent).join("/");
      } catch {
        throw new TaskError("bad_request", "the file's path is not well encoded");
      }
      const length = Number(c.req.header("content-length") ?? "0");
      if (length > TEST_FILE_MAX_BYTES) throw new TaskError("bad_request", `a test's file is at most ${TEST_FILE_MAX_BYTES} bytes`);
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      return { test: await t.putFile(id, path, bytes) };
    }),
  );

  app.put("/tasks/tests/:id", (c) =>
    testAnswer(c, async (t) => {
      const b = await body(c);
      only(b, ["show", "expected", "grade"], "a test's change");
      return {
        test: await t.update(c.req.param("id"), {
          ...(b["show"] !== undefined ? { show: b["show"] } : {}),
          ...(b["expected"] !== undefined ? { expected: b["expected"] } : {}),
          ...(b["grade"] !== undefined ? { grade: b["grade"] as never } : {}),
        }),
      };
    }),
  );

  app.delete("/tasks/tests/:id", (c) => testAnswer(c, async (t) => ({ test: await t.retire(c.req.param("id"), (await by(c)).by) })));

  app.post("/tasks/:id/test", (c) =>
    testAnswer(c, async (t) => {
      const b = await body(c);
      only(b, ["expected", "grade"], "a test from a task");
      return {
        test: await t.fromTask(
          c.req.param("id"),
          { ...(b["expected"] !== undefined ? { expected: b["expected"] } : {}), ...(b["grade"] !== undefined ? { grade: b["grade"] as never } : {}) },
          (await by(c)).by,
        ),
      };
    }),
  );

  // A person takes back what an answer earned while it is held (§8.1):
  // until item 4 grades tests, an admin is who catches a bad answer.
  app.post("/tasks/:id/take-back", async (c) => {
    const refused = await refuse(c);
    if (refused) return refused;
    if (!deps.takeBack) return c.json({ error: "this server's task store is its host's: take-back is not available here", code: "not_available" }, 501);
    try {
      const b = await body(c);
      for (const k of Object.keys(b)) if (k !== "worker" && k !== "why") throw new TaskError("bad_request", `a take-back is worker and why, not ${k}`);
      if (b["worker"] !== undefined && typeof b["worker"] !== "string") throw new TaskError("bad_request", "worker is an actor");
      const task = c.req.param("id");
      const earnings = await deps.takeBack({
        task,
        why: b["why"] as string,
        ...(b["worker"] !== undefined ? { worker: b["worker"] as string } : {}),
        ...(await by(c)),
      });
      // Past its hold an earning is the worker's: nothing was taken.
      if (earnings.some((e) => e.result === "released") && !earnings.some((e) => e.result === "taken")) {
        return c.json({ error: "released: past its hold, this answer's earning is the worker's", code: "released", task, earnings }, 409);
      }
      return c.json({ task, earnings });
    } catch (err) {
      if (err instanceof TaskError) return c.json({ error: err.message, code: err.code }, STATUS[err.code] ?? 400);
      throw err;
    }
  });

  // A person's verdict on one answer (§9.6): a mark, never an undo of the
  // run, which has gone on.
  app.put("/tasks/:id/review", async (c) => {
    const refused = await refuse(c);
    if (refused) return refused;
    if (!deps.review) return c.json({ error: "this server's task store is its host's: review is not available here", code: "not_available" }, 501);
    try {
      const b = await body(c);
      for (const k of Object.keys(b)) if (k !== "worker" && k !== "verdict" && k !== "why") throw new TaskError("bad_request", `a review is worker, verdict and why, not ${k}`);
      if (b["worker"] !== undefined && typeof b["worker"] !== "string") throw new TaskError("bad_request", "worker is an actor");
      if (b["why"] !== undefined && typeof b["why"] !== "string") throw new TaskError("bad_request", "why is a sentence");
      const out = await deps.review({
        task: c.req.param("id"),
        verdict: b["verdict"] as Verdict,
        ...(b["why"] !== undefined ? { why: b["why"] as string } : {}),
        ...(b["worker"] !== undefined ? { worker: b["worker"] as string } : {}),
        ...(await by(c)),
      });
      return c.json(out);
    } catch (err) {
      if (err instanceof TaskError) return c.json({ error: err.message, code: err.code }, STATUS[err.code] ?? 400);
      throw err;
    }
  });

  // One of a task's files, read by staff without a lease (§9.4).
  app.get("/tasks/:id/files/*", async (c) => {
    const missing = await lacks(c, "taskFile", "file read for staff");
    if (missing) return missing;
    return answer(c, async () => {
      const id = c.req.param("id");
      const marker = `/tasks/${id}/files/`;
      let path: string;
      try {
        path = c.req.path.slice(c.req.path.indexOf(marker) + marker.length).split("/").map(decodeURIComponent).join("/");
      } catch {
        throw new TaskError("bad_request", "the file's path is not well encoded");
      }
      return (await tasks.taskFile(id, path)) as unknown as Record<string, unknown>;
    });
  });

  app.get("/tasks/:id", async (c) => {
    const refused = await refuse(c);
    if (refused) return refused;
    const task = await tasks.task(c.req.param("id"));
    if (!task) return c.json({ error: `no task ${c.req.param("id")}`, code: "unknown_task" }, 404);
    // The run as it stands now (§9.4); a test instance has none.
    const run = task.workflow && deps.runOf ? await deps.runOf(task.workflow, task.runId).catch(() => null) : null;
    return c.json({ task, run });
  });
}
