// Project registry: the repos loom is allowed to spawn coding jobs against.

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { dbAll, dbOne, dbRun, nowMs } from "./db.ts";
import type { ProjectRow } from "./types.ts";

export type CreateProjectInput = {
  name: string;
  repoPath: string;
  defaultBase?: string;
  verifyCmd?: string;
};

export function createProject(input: CreateProjectInput): ProjectRow {
  const repoPath = resolve(input.repoPath);
  const existing = getProjectByName(input.name);
  if (existing) {
    throw new Error(`project '${input.name}' already exists (id ${existing.id})`);
  }
  const row: ProjectRow = {
    id: randomUUID(),
    name: input.name,
    repo_path: repoPath,
    default_base: input.defaultBase ?? "main",
    verify_cmd: input.verifyCmd ?? null,
    created_at: nowMs(),
    updated_at: nowMs(),
  };
  dbRun(
    `INSERT INTO projects (id, name, repo_path, default_base, verify_cmd, created_at, updated_at)
     VALUES ($id, $name, $repo_path, $default_base, $verify_cmd, $created_at, $updated_at)`,
    {
      $id: row.id,
      $name: row.name,
      $repo_path: row.repo_path,
      $default_base: row.default_base,
      $verify_cmd: row.verify_cmd,
      $created_at: row.created_at,
      $updated_at: row.updated_at,
    },
  );
  return row;
}

export function listProjects(): ProjectRow[] {
  return dbAll<ProjectRow>(`SELECT * FROM projects ORDER BY created_at ASC`);
}

export function getProject(id: string): ProjectRow | null {
  return dbOne<ProjectRow>(`SELECT * FROM projects WHERE id = $id`, { $id: id });
}

export function getProjectByName(name: string): ProjectRow | null {
  return dbOne<ProjectRow>(`SELECT * FROM projects WHERE name = $name`, { $name: name });
}

/** Resolve a project by id OR name — CLI/MCP callers pass whichever they
 *  have handy. */
export function resolveProject(idOrName: string): ProjectRow | null {
  return getProject(idOrName) ?? getProjectByName(idOrName);
}
