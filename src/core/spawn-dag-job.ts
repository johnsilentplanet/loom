// The DAG variant: a small task graph sharing one scratch workspace (not
// separate git worktrees). Independent tasks run in parallel; dependents
// wait for their dependencies and hand off through files in the shared
// workspace — no git, no merge train, just a scratch directory.

import { randomUUID } from "node:crypto";
import { nowMs } from "./db.ts";
import { provisionScratch, removeScratch } from "./git.ts";
import { runCodingAgent } from "./agent-runner.ts";
import {
  createJob,
  createTask,
  getJob,
  listTasksForJob,
  parseDependsOn,
  updateJob,
  updateTask,
} from "./jobs-store.ts";
import { resolveProject } from "./projects.ts";
import { registerAbort, unregisterAbort } from "./registry.ts";
import type { DagSpec, JobRow, TaskRow } from "./types.ts";

/** Validate a DAG spec: unique names, depends_on referencing known names, no
 *  cycles. Throws with a descriptive message on any violation. */
export function validateDagSpec(spec: DagSpec): void {
  if (!spec.tasks || spec.tasks.length === 0) throw new Error("dag spec has no tasks");
  const names = new Set<string>();
  for (const t of spec.tasks) {
    if (names.has(t.name)) throw new Error(`duplicate task name: ${t.name}`);
    names.add(t.name);
  }
  for (const t of spec.tasks) {
    for (const dep of t.depends_on ?? []) {
      if (!names.has(dep)) throw new Error(`task '${t.name}' depends on unknown task '${dep}'`);
    }
  }
  // Cycle check via DFS.
  const visiting = new Set<string>();
  const done = new Set<string>();
  const byName = new Map(spec.tasks.map((t) => [t.name, t]));
  const visit = (name: string): void => {
    if (done.has(name)) return;
    if (visiting.has(name)) throw new Error(`dependency cycle detected at task '${name}'`);
    visiting.add(name);
    for (const dep of byName.get(name)!.depends_on ?? []) visit(dep);
    visiting.delete(name);
    done.add(name);
  };
  for (const t of spec.tasks) visit(t.name);
}

export type SpawnDagJobInput = {
  project: string;
  spec: DagSpec;
  title?: string;
};

/** Create and run a DAG job to completion, returning the final job row.
 *  Individual task rows are available via listTasksForJob(job.id). */
export async function spawnDagJob(input: SpawnDagJobInput): Promise<JobRow> {
  validateDagSpec(input.spec);
  const project = resolveProject(input.project);
  if (!project) throw new Error(`unknown project: ${input.project}`);

  const job = createJob({
    projectId: project.id,
    kind: "dag",
    title: input.title ?? `dag (${input.spec.tasks.length} tasks)`,
  });

  const abortController = new AbortController();
  registerAbort(job.id, abortController);
  updateJob(job.id, { status: "running", started_at: nowMs(), pid: process.pid });

  const scratch = provisionScratch(project, job.title);
  updateJob(job.id, { workspace_path: scratch });

  // Pre-allocate ids so depends_on can be written correctly on the task's
  // first (and only) insert — no second pass needed.
  const idByName = new Map<string, string>();
  for (const t of input.spec.tasks) idByName.set(t.name, randomUUID());
  for (const t of input.spec.tasks) {
    const depIds = (t.depends_on ?? []).map((n) => idByName.get(n)!);
    createTask({
      id: idByName.get(t.name),
      jobId: job.id,
      name: t.name,
      instructions: t.instructions,
      dependsOn: depIds,
      model: t.model ?? "sonnet",
    });
  }

  try {
    await runGraph(job.id, scratch, abortController);
  } finally {
    unregisterAbort(job.id);
  }

  const tasks = listTasksForJob(job.id);
  const anyCancelled = tasks.some((t) => t.status === "cancelled");
  const anyFailed = tasks.some((t) => t.status === "failed");
  const finalStatus = anyCancelled ? "cancelled" : anyFailed ? "failed" : "done";
  updateJob(job.id, {
    status: finalStatus,
    finished_at: nowMs(),
    error: anyFailed ? "one or more tasks failed" : anyCancelled ? "cancelled" : undefined,
  });

  if (finalStatus === "done") {
    // Scratch workspace has no lasting value once every task is done; the
    // task results (stored in the DB) are the durable artifact.
    removeScratch(scratch);
  }

  return getJob(job.id)!;
}

/** Run every task in the graph: tasks become runnable once all of their
 *  dependencies are 'done'; independent tasks run concurrently. A failed or
 *  cancelled dependency blocks its dependents permanently (they're marked
 *  'cancelled' rather than ever running). */
async function runGraph(jobId: string, scratch: string, jobAbort: AbortController): Promise<void> {
  const running = new Map<string, Promise<void>>();

  // `all` must be the freshly-fetched task list each time this is called —
  // dependency statuses change as sibling tasks complete, so a stale
  // snapshot would never unblock a waiting task.
  const isSatisfied = (t: TaskRow, all: TaskRow[]): "ready" | "waiting" | "blocked" => {
    const deps = parseDependsOn(t);
    let waiting = false;
    for (const depId of deps) {
      const dep = all.find((x) => x.id === depId);
      if (!dep) continue;
      if (dep.status === "failed" || dep.status === "cancelled") return "blocked";
      if (dep.status !== "done") waiting = true;
    }
    return waiting ? "waiting" : "ready";
  };

  const runOne = async (task: TaskRow): Promise<void> => {
    if (jobAbort.signal.aborted) {
      updateTask(task.id, { status: "cancelled", error: "cancelled", finished_at: nowMs() });
      return;
    }
    updateTask(task.id, { status: "running", started_at: nowMs() });
    const taskAbort = new AbortController();
    jobAbort.signal.addEventListener("abort", () => taskAbort.abort());
    registerAbort(`${jobId}:${task.id}`, taskAbort);
    try {
      const run = await runCodingAgent({
        cwd: scratch,
        instructions: task.instructions,
        model: task.model ?? "sonnet",
        abortController: taskAbort,
      });
      if (taskAbort.signal.aborted) {
        updateTask(task.id, { status: "cancelled", error: "cancelled", finished_at: nowMs() });
        return;
      }
      updateTask(task.id, {
        status: run.ok ? "done" : "failed",
        result: JSON.stringify(run),
        error: run.ok ? undefined : run.summary,
        finished_at: nowMs(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateTask(task.id, { status: "failed", error: message, finished_at: nowMs() });
    } finally {
      unregisterAbort(`${jobId}:${task.id}`);
    }
  };

  // Keep scheduling until every task has reached a terminal state.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const current = listTasksForJob(jobId);
    const pendingOrBlocked = current.filter((t) => t.status === "pending" || t.status === "blocked");
    const stillRunning = running.size > 0;

    if (pendingOrBlocked.length === 0 && !stillRunning) break;

    for (const t of pendingOrBlocked) {
      if (running.has(t.id)) continue;
      const verdict = isSatisfied(t, current);
      if (verdict === "blocked") {
        updateTask(t.id, { status: "cancelled", error: "a dependency failed or was cancelled" });
        continue;
      }
      if (verdict === "ready") {
        const p = runOne(t).finally(() => running.delete(t.id));
        running.set(t.id, p);
      }
      // "waiting" => leave it for the next loop iteration.
    }

    if (running.size > 0) {
      await Promise.race([...running.values()]);
    } else {
      // Nothing ready and nothing running, but something's still
      // pending/blocked — that's only possible if isSatisfied keeps
      // returning "waiting" forever, which validateDagSpec's cycle check
      // already rules out. Break defensively rather than spin.
      break;
    }
  }
}
