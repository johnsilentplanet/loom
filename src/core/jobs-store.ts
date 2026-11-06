// CRUD for jobs + tasks. Pure persistence — no process orchestration here
// (that lives in spawn-code-job.ts / spawn-dag-job.ts).

import { randomUUID } from "node:crypto";
import { dbAll, dbOne, dbRun, nowMs, type Params } from "./db.ts";
import type { JobKind, JobRow, JobStatus, ModelTier, TaskRow, TaskStatus } from "./types.ts";

export function createJob(input: {
  projectId: string;
  kind: JobKind;
  title: string;
  model?: ModelTier | null;
  instructions?: string | null;
}): JobRow {
  const row: JobRow = {
    id: randomUUID(),
    project_id: input.projectId,
    kind: input.kind,
    title: input.title,
    status: "pending",
    model: input.model ?? null,
    instructions: input.instructions ?? null,
    workspace_path: null,
    branch: null,
    base_branch: null,
    pid: null,
    result: null,
    error: null,
    created_at: nowMs(),
    started_at: null,
    finished_at: null,
  };
  dbRun(
    `INSERT INTO jobs (id, project_id, kind, title, status, model, instructions, created_at)
     VALUES ($id, $project_id, $kind, $title, $status, $model, $instructions, $created_at)`,
    {
      $id: row.id,
      $project_id: row.project_id,
      $kind: row.kind,
      $title: row.title,
      $status: row.status,
      $model: row.model,
      $instructions: row.instructions,
      $created_at: row.created_at,
    },
  );
  return row;
}

export function getJob(id: string): JobRow | null {
  return dbOne<JobRow>(`SELECT * FROM jobs WHERE id = $id`, { $id: id });
}

export function listJobs(filter: { projectId?: string; status?: JobStatus } = {}): JobRow[] {
  const clauses: string[] = [];
  const params: Params = {};
  if (filter.projectId) {
    clauses.push("project_id = $project_id");
    params.$project_id = filter.projectId;
  }
  if (filter.status) {
    clauses.push("status = $status");
    params.$status = filter.status;
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return dbAll<JobRow>(`SELECT * FROM jobs ${where} ORDER BY created_at DESC`, params);
}

type JobPatch = Partial<
  Pick<
    JobRow,
    | "status"
    | "workspace_path"
    | "branch"
    | "base_branch"
    | "pid"
    | "result"
    | "error"
    | "started_at"
    | "finished_at"
  >
>;

export function updateJob(id: string, patch: JobPatch): void {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const set = keys.map((k) => `${k} = $${k}`).join(", ");
  const params: Params = { $id: id };
  // bun:sqlite only binds null/number/string/bigint/boolean — coalesce
  // `undefined` (meaning "clear this field") to `null`.
  for (const k of keys) params[`$${k}`] = (patch as Record<string, string | number | null | undefined>)[k] ?? null;
  dbRun(`UPDATE jobs SET ${set} WHERE id = $id`, params);
}

export function createTask(input: {
  id?: string;
  jobId: string;
  name: string;
  instructions: string;
  dependsOn: string[];
  model?: ModelTier | null;
}): TaskRow {
  const row: TaskRow = {
    id: input.id ?? randomUUID(),
    job_id: input.jobId,
    name: input.name,
    depends_on: JSON.stringify(input.dependsOn),
    instructions: input.instructions,
    model: input.model ?? null,
    status: input.dependsOn.length > 0 ? "blocked" : "pending",
    result: null,
    error: null,
    created_at: nowMs(),
    started_at: null,
    finished_at: null,
  };
  dbRun(
    `INSERT INTO tasks (id, job_id, name, depends_on, instructions, model, status, created_at)
     VALUES ($id, $job_id, $name, $depends_on, $instructions, $model, $status, $created_at)`,
    {
      $id: row.id,
      $job_id: row.job_id,
      $name: row.name,
      $depends_on: row.depends_on,
      $instructions: row.instructions,
      $model: row.model,
      $status: row.status,
      $created_at: row.created_at,
    },
  );
  return row;
}

export function getTask(id: string): TaskRow | null {
  return dbOne<TaskRow>(`SELECT * FROM tasks WHERE id = $id`, { $id: id });
}

export function listTasksForJob(jobId: string): TaskRow[] {
  return dbAll<TaskRow>(`SELECT * FROM tasks WHERE job_id = $job_id ORDER BY created_at ASC`, { $job_id: jobId });
}

type TaskPatch = Partial<Pick<TaskRow, "status" | "result" | "error" | "started_at" | "finished_at">>;

export function updateTask(id: string, patch: TaskPatch): void {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const set = keys.map((k) => `${k} = $${k}`).join(", ");
  const params: Params = { $id: id };
  for (const k of keys) params[`$${k}`] = (patch as Record<string, string | number | null | undefined>)[k] ?? null;
  dbRun(`UPDATE tasks SET ${set} WHERE id = $id`, params);
}

export function parseDependsOn(task: TaskRow): string[] {
  try {
    const arr = JSON.parse(task.depends_on);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export const TERMINAL_JOB_STATUSES: JobStatus[] = ["done", "failed", "cancelled"];
export const TERMINAL_TASK_STATUSES: TaskStatus[] = ["done", "failed", "cancelled"];
