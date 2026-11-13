/**
 * The STAFF's routes for the task store (plans/human-steps.md §6): task
 * types, workers, grants, and the tasks with their leases. Full scope only,
 * reads included — the deployment key or an admin's session — like the
 * earnings: a peer's read, a member's session and a visitor are refused.
 * Names with a `/` (a task type `acme/pet-match`) travel as one encoded
 * segment (`acme%2Fpet-match`), as a workflow's do.
 *
 * - `GET /tasks/types` → `{ types }`
 * - `PUT /tasks/types/:name { app, answer, leaseSeconds?, withinHours?, enabled?, paySats?, holdHours? }`
 *   → `{ type }`: the whole type (a PUT: what is left out is the default)
 * - `DELETE /tasks/types/:name` → `{ name, revoked }`: refused (409) while
 *   a task of the type is open; its live grants are revoked
 * - `GET /tasks/workers[?status=]` → `{ workers }`, each with its `balance`
 * - `PUT /tasks/workers/:actor { status?, note? }` → `{ worker }`
 * - `PUT /tasks/workers/:actor/grants/:type` → `{ worker }`
 * - `DELETE /tasks/workers/:actor/grants/:type[?why=]` → `{ worker }`
 * - `GET /tasks[?type=&status=&workflow=&runId=&before=&limit=]` → `{ tasks }`,
 *   newest first, each with its leases (an answer's `earning` with it)
 * - `GET /tasks/:id` → `{ task }`
 * - `POST /tasks/:id/take-back { worker?, why }` → `{ task, earnings }`: the
 *   earnings the task's answers made (or `worker`'s) taken back while held
 *   (plans/human-steps.md §8.1); `409 released` when every one asked for is
 *   past its hold
 */
import type { Context, Hono } from "hono";
import { TASK_STATUSES, type TaskStatus } from "./task-store.js";
import { WORKER_STATUSES, type WorkerStatus } from "./worker-store.js";
import { TaskError, type TaskErrorCode, type TasksCapability, type TasksService } from "./tasks.js";

export interface TaskRoutesDeps {
  isFull: (c: Context) => Promise<boolean>;
  /** Who made a change: the type's `changedBy`, a grant's `by`. */
  actorOf: (c: Context) => Promise<string | undefined>;
  tasks: TasksCapability;
  /** A person's take-back (§8.1): the service's, never on a capability.
   *  Absent (a host's own store): the route answers 501. */
  takeBack?: TasksService["takeBack"];
}

const STATUS: Partial<Record<TaskErrorCode, 400 | 404 | 409>> = {
  bad_request: 400,
  bad_schema: 400,
  unknown_type: 404,
  unknown_worker: 404,
  unknown_task: 404,
  in_use: 409,
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
        ...(b["paySats"] !== undefined ? { paySats: b["paySats"] as number } : {}),
        ...(b["holdHours"] !== undefined ? { holdHours: b["holdHours"] as number } : {}),
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
    answer(c, async () => ({ worker: await tasks.grant(c.req.param("actor"), c.req.param("type"), (await by(c)).by) })),
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
      return {
        tasks: await tasks.list({
          ...(q["type"] ? { type: q["type"] } : {}),
          ...(q["status"] ? { status: q["status"] as TaskStatus } : {}),
          ...(q["workflow"] ? { workflow: q["workflow"] } : {}),
          ...(q["runId"] ? { runId: q["runId"] } : {}),
          ...(before !== undefined ? { before } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
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

  app.get("/tasks/:id", async (c) => {
    const refused = await refuse(c);
    if (refused) return refused;
    const task = await tasks.task(c.req.param("id"));
    return task ? c.json({ task }) : c.json({ error: `no task ${c.req.param("id")}`, code: "unknown_task" }, 404);
  });
}
