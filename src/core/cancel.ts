// Cancel a running job tree. Kills in-flight tasks, leaves completed ones
// alone.
//
// Two paths, tried in order:
//  1. In-process: if this process is the one running the job (e.g. the MCP
//     server that spawned it, or a CLI invocation that's still attached),
//     abort its AbortController(s) directly via the registry.
//  2. Cross-process: otherwise, signal the pid recorded on the job row.
//     That process installs the same SIGINT/SIGTERM handler (registry.ts),
//     which aborts every AbortController it's running and lets the job
//     pipeline persist "cancelled" status for whatever hadn't finished yet.
//
// Either way, any task that is still pending/blocked (never started) is
// marked 'cancelled' immediately here, since no AbortController exists for
// work that never began.

import { nowMs } from "./db.ts";
import { TERMINAL_JOB_STATUSES, getJob, listTasksForJob, updateJob, updateTask } from "./jobs-store.ts";
import { abortLocal, pidAlive } from "./registry.ts";

export type CancelOutcome = { ok: boolean; message: string };

export async function cancelJobTree(jobId: string): Promise<CancelOutcome> {
  const job = getJob(jobId);
  if (!job) return { ok: false, message: `job ${jobId} not found` };
  if (TERMINAL_JOB_STATUSES.includes(job.status)) {
    return { ok: false, message: `job ${jobId} is already ${job.status}` };
  }

  const abortedLocally = abortLocal(jobId) > 0;
  if (!abortedLocally) {
    if (job.pid && job.pid !== process.pid && pidAlive(job.pid)) {
      try {
        process.kill(job.pid, "SIGTERM");
      } catch {
        // process may have raced us to exit; fall through to marking state.
      }
    }
  }

  // Not-yet-started tasks have no AbortController to fire — mark them
  // cancelled directly so a DAG job's status reflects intent immediately.
  for (const task of listTasksForJob(jobId)) {
    if (task.status === "pending" || task.status === "blocked") {
      updateTask(task.id, { status: "cancelled", error: "cancelled", finished_at: nowMs() });
    }
  }

  // For a single "code" job with no owning process left alive, mark it
  // cancelled directly (nothing will ever update it otherwise).
  if (job.kind === "code" && !abortedLocally && (!job.pid || !pidAlive(job.pid))) {
    updateJob(jobId, { status: "cancelled", error: "cancelled (no owning process found)", finished_at: nowMs() });
  }

  return { ok: true, message: `cancel requested for job ${jobId}` };
}
