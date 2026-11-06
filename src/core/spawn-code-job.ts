// The core "code" job pipeline: isolated worktree -> one agent run -> verify
// -> serialized merge into the project's base branch.
//
// On verify failure (or merge conflict) the branch is left unmerged in its
// worktree for inspection and the job is recorded as "failed" — no deploy
// step, no smoke test, no auto-rollback. That is deliberately out of scope
// here; this is coding + merge only.

import { nowMs } from "./db.ts";
import { gitAsync, provisionWorktree, removeWorktree } from "./git.ts";
import { withMergeTrain } from "./merge-queue.ts";
import { runCodingAgent } from "./agent-runner.ts";
import { createJob, getJob, updateJob } from "./jobs-store.ts";
import { resolveProject } from "./projects.ts";
import { registerAbort, unregisterAbort } from "./registry.ts";
import type { JobRow, ModelTier } from "./types.ts";

export type SpawnCodeJobInput = {
  project: string; // id or name
  instructions: string;
  model?: ModelTier;
  title?: string;
};

/** Run a project's verify_cmd (if any) inside `cwd` via `sh -c`. No verify
 *  command configured => trivially passes. */
async function runVerify(cwd: string, verifyCmd: string | null): Promise<{ ok: boolean; output: string }> {
  if (!verifyCmd) return { ok: true, output: "(no verify_cmd configured)" };
  const p = Bun.spawn(["sh", "-c", verifyCmd], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const exitCode = await p.exited;
  const output = `${stdout}\n${stderr}`.trim();
  return { ok: exitCode === 0, output };
}

/** Create and synchronously run a single-agent coding job end to end.
 *  Returns the final job row. The job is persisted throughout, so a
 *  `status` lookup from another process sees live progress. */
export async function spawnCodeJob(input: SpawnCodeJobInput): Promise<JobRow> {
  const project = resolveProject(input.project);
  if (!project) throw new Error(`unknown project: ${input.project}`);

  const job = createJob({
    projectId: project.id,
    kind: "code",
    title: input.title ?? input.instructions.slice(0, 80),
    model: input.model ?? "sonnet",
    instructions: input.instructions,
  });

  const abortController = new AbortController();
  registerAbort(job.id, abortController);
  updateJob(job.id, { status: "running", started_at: nowMs(), pid: process.pid });

  try {
    const wt = await provisionWorktree(project, { name: job.title });
    updateJob(job.id, { workspace_path: wt.path, branch: wt.branch, base_branch: wt.base });

    if (abortController.signal.aborted) throw new AbortCancelled();

    const run = await runCodingAgent({
      cwd: wt.path,
      instructions: input.instructions,
      model: input.model ?? "sonnet",
      abortController,
    });

    if (abortController.signal.aborted) throw new AbortCancelled();

    if (!run.ok) {
      updateJob(job.id, {
        status: "failed",
        error: `agent run failed: ${run.summary}`,
        result: JSON.stringify(run),
        finished_at: nowMs(),
      });
      return getJob(job.id)!;
    }

    // Nothing to verify/merge if the agent made no commits.
    const diff = await gitAsync(wt.path, ["status", "--porcelain"]);
    if (diff.stdout.length > 0) {
      // Agent left uncommitted changes — commit them so they ride the merge.
      await gitAsync(wt.path, ["add", "-A"]);
      await gitAsync(wt.path, ["commit", "-m", `loom: ${job.title}`]);
    }
    const ahead = await gitAsync(wt.path, ["rev-list", "--count", `${wt.base}..HEAD`]);
    if (ahead.ok && ahead.stdout === "0") {
      updateJob(job.id, {
        status: "failed",
        error: "agent made no commits — nothing to verify or merge",
        result: JSON.stringify(run),
        finished_at: nowMs(),
      });
      return getJob(job.id)!;
    }

    updateJob(job.id, { status: "verifying" });
    const verify = await runVerify(wt.path, project.verify_cmd);
    if (!verify.ok) {
      updateJob(job.id, {
        status: "failed",
        error: `verify failed:\n${verify.output.slice(0, 4000)}`,
        result: JSON.stringify(run),
        finished_at: nowMs(),
      });
      return getJob(job.id)!; // branch + worktree left in place for inspection
    }

    if (abortController.signal.aborted) throw new AbortCancelled();

    updateJob(job.id, { status: "merging" });
    const mergeOutcome = await withMergeTrain(project.id, async () => {
      const merge = await gitAsync(project.repo_path, ["merge", "--no-ff", "--no-edit", wt.branch]);
      if (!merge.ok) {
        await gitAsync(project.repo_path, ["merge", "--abort"]);
        return { ok: false as const, error: `merge conflict: ${merge.stderr || merge.stdout}` };
      }
      const sha = await gitAsync(project.repo_path, ["rev-parse", "HEAD"]);
      return { ok: true as const, sha: sha.ok ? sha.stdout : null };
    });

    if (!mergeOutcome.ok) {
      updateJob(job.id, {
        status: "failed",
        error: mergeOutcome.error,
        result: JSON.stringify(run),
        finished_at: nowMs(),
      });
      return getJob(job.id)!; // branch + worktree left in place for inspection
    }

    await removeWorktree(project, wt, { deleteBranch: true });
    updateJob(job.id, {
      status: "done",
      result: JSON.stringify({ ...run, mergedSha: mergeOutcome.sha }),
      finished_at: nowMs(),
    });
    return getJob(job.id)!;
  } catch (err) {
    if (err instanceof AbortCancelled || abortController.signal.aborted) {
      updateJob(job.id, { status: "cancelled", error: "cancelled", finished_at: nowMs() });
      return getJob(job.id)!;
    }
    const message = err instanceof Error ? err.message : String(err);
    updateJob(job.id, { status: "failed", error: message, finished_at: nowMs() });
    return getJob(job.id)!;
  } finally {
    unregisterAbort(job.id);
  }
}

class AbortCancelled extends Error {
  constructor() {
    super("cancelled");
  }
}
