// Repo file map — a bounded structural outline of a workspace, front-loaded
// into a coding agent's prompt.
//
// Why: an agent otherwise burns many sequential turns on read -> grep -> read
// discovery just to learn where things live. Handing it a compact directory
// outline up front lets it jump straight to the relevant files.
//
// This is a STRUCTURAL map, not file dumps. It stays small and predictable
// regardless of repo size — files are grouped by directory, capped per
// directory and in total, and overflow is summarized with counts.

import { gitAsync } from "./git.ts";

export type RepoMapOptions = {
  /** Hard cap on individual files listed across the whole map. Once hit,
   *  remaining directories are summarized as a one-line count. */
  maxFiles?: number;
  /** Max files listed per directory before the rest fold into a
   *  "(+N more)" line. */
  maxPerDir?: number;
};

const DEFAULTS: Required<RepoMapOptions> = { maxFiles: 240, maxPerDir: 16 };

/** Format a list of repo-relative file paths into a bounded directory
 *  outline. Pure — no I/O. Returns "" for an empty list. */
export function formatRepoMap(files: string[], opts: RepoMapOptions = {}): string {
  const { maxFiles, maxPerDir } = { ...DEFAULTS, ...opts };
  const clean = files.map((f) => f.trim()).filter((f) => f.length > 0);
  if (clean.length === 0) return "";

  const byDir = new Map<string, string[]>();
  for (const f of clean) {
    const slash = f.lastIndexOf("/");
    const dir = slash === -1 ? "." : f.slice(0, slash);
    const base = slash === -1 ? f : f.slice(slash + 1);
    let bucket = byDir.get(dir);
    if (!bucket) {
      bucket = [];
      byDir.set(dir, bucket);
    }
    bucket.push(base);
  }

  const dirs = [...byDir.keys()].sort();
  const lines: string[] = [];
  let filesShown = 0;
  let dirIdx = 0;

  for (; dirIdx < dirs.length; dirIdx++) {
    if (filesShown >= maxFiles) break;
    const dir = dirs[dirIdx]!;
    const entries = byDir.get(dir)!.sort();
    lines.push(`${dir === "." ? "(root)" : dir}/`);
    const take = Math.min(entries.length, maxPerDir);
    for (let i = 0; i < take; i++) {
      lines.push(`  ${entries[i]}`);
      filesShown++;
    }
    if (entries.length > take) {
      lines.push(`  … (+${entries.length - take} more)`);
    }
  }

  const remainingDirs = dirs.length - dirIdx;
  if (remainingDirs > 0) {
    lines.push(`… (+${remainingDirs} more director${remainingDirs === 1 ? "y" : "ies"})`);
  }

  return lines.join("\n");
}

/** Build a bounded repo map for `cwd` from `git ls-files` (tracked files
 *  only). Returns "" when the directory isn't a git repo or has no tracked
 *  files. */
export async function buildRepoMap(cwd: string, opts: RepoMapOptions = {}): Promise<string> {
  const res = await gitAsync(cwd, ["ls-files"]);
  if (!res.ok || res.stdout.length === 0) return "";
  return formatRepoMap(res.stdout.split("\n"), opts);
}
