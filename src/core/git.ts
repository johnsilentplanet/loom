// Git workspace isolation — one worktree per coding job.
//
// Agents never run in the project's own checked-out working tree. Each code
// job gets its own `git worktree` on its own branch (loom/<slug>-<token>) off
// a clean base; worktrees share the object store but have independent
// working dirs + indexes, so concurrent jobs can't stomp each other's
// HEAD/index. All git runs via `git -C <repo>` so this never depends on (or
// mutates) the process cwd.

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import type { ProjectRow } from "./types.ts";

export type GitResult = { ok: boolean; stdout: string; stderr: string };

const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

/** Run a git command inside `repoPath` synchronously. */
export function git(repoPath: string, args: string[]): GitResult {
  const p = Bun.spawnSync(["git", "-C", repoPath, ...args]);
  return { ok: p.exitCode === 0, stdout: decode(p.stdout).trim(), stderr: decode(p.stderr).trim() };
}

/** Async git — does not block the event loop. Prefer this everywhere a
 *  caller might be awaiting other async work (e.g. an in-flight agent
 *  query()) concurrently. */
export async function gitAsync(repoPath: string, args: string[]): Promise<GitResult> {
  const p = Bun.spawn(["git", "-C", repoPath, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  const exitCode = await p.exited;
  return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

export function worktreeRoot(): string {
  return process.env.LOOM_WORKTREE_ROOT ?? join(homedir(), ".loom", "worktrees");
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "job";
}

export type Worktree = { path: string; branch: string; base: string };

/** Create an isolated git worktree for a coding job, branched off `base`
 *  (defaults to the project's default_base) onto a fresh branch. */
export async function provisionWorktree(
  project: ProjectRow,
  opts: { name: string; base?: string },
): Promise<Worktree> {
  const base = opts.base ?? project.default_base;
  const token = randomUUID().slice(0, 8);
  const slug = slugify(opts.name);
  const branch = `loom/${slug}-${token}`;
  const path = join(worktreeRoot(), `${slugify(project.name)}-${slug}-${token}`);

  mkdirSync(worktreeRoot(), { recursive: true });
  const res = await gitAsync(project.repo_path, ["worktree", "add", "-b", branch, path, base]);
  if (!res.ok) {
    throw new Error(`git worktree add failed (base=${base}): ${res.stderr || res.stdout}`);
  }
  return { path, branch, base };
}

/** A plain scratch directory for the DAG variant — no git, just a shared
 *  working folder the whole task graph hands files through. */
export function provisionScratch(project: ProjectRow, name: string): string {
  const path = join(
    worktreeRoot(),
    `scratch-${slugify(project.name)}-${slugify(name)}-${randomUUID().slice(0, 8)}`,
  );
  mkdirSync(path, { recursive: true });
  return path;
}

/** Tear down a worktree: `git worktree remove --force`, and optionally the
 *  branch. Never targets the project's base branch (defensive — in practice
 *  `branch` is always a `loom/<slug>-<token>` worktree branch, but a
 *  malformed caller must never be able to turn teardown into deleting the
 *  base ref). */
export async function removeWorktree(
  project: ProjectRow,
  wt: Worktree,
  opts: { deleteBranch?: boolean } = {},
): Promise<void> {
  await gitAsync(project.repo_path, ["worktree", "remove", "--force", wt.path]);
  if (opts.deleteBranch) {
    if (wt.branch === project.default_base || wt.branch === wt.base) {
      console.warn(`[git] refusing to delete branch '${wt.branch}' — it looks like a base branch`);
    } else {
      await gitAsync(project.repo_path, ["branch", "-D", wt.branch]);
    }
  }
}

export function removeScratch(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/** Current HEAD sha of a branch (or ref), resolved inside `repoPath`. */
export async function revParse(repoPath: string, ref: string): Promise<string | null> {
  const res = await gitAsync(repoPath, ["rev-parse", ref]);
  return res.ok ? res.stdout : null;
}
