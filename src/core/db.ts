// SQLite storage. One local file, no external services — loosely modeled on
// a projects/jobs/tasks shape, trimmed to exactly what loom needs.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

function resolveDbPath(): string {
  return process.env.LOOM_DB_PATH ?? join(process.cwd(), "data", "loom.db");
}

function openDb(): Database {
  const path = resolveDbPath();
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL UNIQUE,
      repo_path    TEXT NOT NULL,
      default_base TEXT NOT NULL DEFAULT 'main',
      verify_cmd   TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id             TEXT PRIMARY KEY,
      project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind           TEXT NOT NULL,                     -- 'code' | 'dag'
      title          TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'pending',    -- pending|running|verifying|merging|done|failed|cancelled
      model          TEXT,
      instructions   TEXT,
      workspace_path TEXT,
      branch         TEXT,
      base_branch    TEXT,
      pid            INTEGER,
      result         TEXT,                                -- JSON
      error          TEXT,
      created_at     INTEGER NOT NULL,
      started_at     INTEGER,
      finished_at    INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

    CREATE TABLE IF NOT EXISTS tasks (
      id           TEXT PRIMARY KEY,
      job_id       TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      depends_on   TEXT NOT NULL DEFAULT '[]',            -- JSON string[] of task ids
      instructions TEXT NOT NULL,
      model        TEXT,
      status       TEXT NOT NULL DEFAULT 'pending',        -- pending|blocked|running|done|failed|cancelled
      result       TEXT,                                    -- JSON
      error        TEXT,
      created_at   INTEGER NOT NULL,
      started_at   INTEGER,
      finished_at  INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_job ON tasks(job_id);
  `);
}

let dbSingleton: Database | null = null;

/** Lazily-opened, process-wide SQLite handle. */
export function db(): Database {
  if (!dbSingleton) dbSingleton = openDb();
  return dbSingleton;
}

export function nowMs(): number {
  return Date.now();
}

/** Named bind parameters — the only shape every query in this module uses.
 *  Narrower than `bun:sqlite`'s own `SQLQueryBindings` value union so
 *  `?? null` coalescing (for "clear this column") always type-checks. */
export type Params = Record<string, string | number | bigint | boolean | null>;

// Small typed wrappers around bun:sqlite's query().{get,all,run}(). These
// exist purely to pin down the generic ParamsType as the single-object shape
// every call site here actually uses — leaving it to inference blows up into
// a combinatorial union over SQLQueryBindings and makes `tsc` churn for
// minutes (and can OOM). See bun-types/sqlite.d.ts's `query<ReturnType,
// ParamsType>` overload: passing a non-array ParamsType resolves to
// `Statement<ReturnType, [ParamsType]>`, i.e. exactly one bind argument.

export function dbOne<T>(sql: string, params: Params = {}): T | null {
  return (db().query<T, Params>(sql).get(params) as T | null) ?? null;
}

export function dbAll<T>(sql: string, params: Params = {}): T[] {
  return db().query<T, Params>(sql).all(params) as T[];
}

export function dbRun(sql: string, params: Params = {}): void {
  db().query<unknown, Params>(sql).run(params);
}
