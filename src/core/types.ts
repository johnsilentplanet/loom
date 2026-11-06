// Shared types for the loom core library. Both the CLI and the MCP server
// are thin wrappers over this module — nothing here knows about either.

/** SDK model alias. Loom never pins a full model id — it hands the alias
 *  straight to the Agent SDK's `model` option and lets the subscription
 *  session resolve it. */
export type ModelTier = "sonnet" | "opus" | "haiku";

export type ProjectRow = {
  id: string;
  name: string;
  repo_path: string;
  default_base: string;
  verify_cmd: string | null;
  created_at: number;
  updated_at: number;
};

export type JobKind = "code" | "dag";

export type JobStatus =
  | "pending"
  | "running"
  | "verifying"
  | "merging"
  | "done"
  | "failed"
  | "cancelled";

export type JobRow = {
  id: string;
  project_id: string;
  kind: JobKind;
  title: string;
  status: JobStatus;
  model: ModelTier | null;
  instructions: string | null;
  workspace_path: string | null;
  branch: string | null;
  base_branch: string | null;
  pid: number | null;
  result: string | null; // JSON
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
};

export type TaskStatus =
  | "pending"
  | "blocked"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

export type TaskRow = {
  id: string;
  job_id: string;
  name: string;
  depends_on: string; // JSON string[]
  instructions: string;
  model: ModelTier | null;
  status: TaskStatus;
  result: string | null; // JSON
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
};

/** Input shape for the DAG variant — one node per coding task. */
export type DagTaskSpec = {
  name: string;
  instructions: string;
  depends_on?: string[];
  model?: ModelTier;
};

export type DagSpec = {
  tasks: DagTaskSpec[];
};

/** Structured result recorded on a job/task when its agent run finishes. */
export type AgentRunSummary = {
  ok: boolean;
  summary: string;
  numTurns: number;
  totalCostUsd: number;
  sessionId?: string;
};
