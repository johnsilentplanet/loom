// Status lookups: one job plus (for DAG jobs) its task tree.

import { getJob, listTasksForJob } from "./jobs-store.ts";
import type { JobRow, TaskRow } from "./types.ts";

export type JobStatusView = {
  job: JobRow;
  tasks: TaskRow[]; // empty for "code" jobs
};

export function getRunStatus(jobId: string): JobStatusView | null {
  const job = getJob(jobId);
  if (!job) return null;
  const tasks = job.kind === "dag" ? listTasksForJob(jobId) : [];
  return { job, tasks };
}
