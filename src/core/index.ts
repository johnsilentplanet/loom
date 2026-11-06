// The one shared core library. Both the CLI (src/cli) and the MCP server
// (src/mcp) are thin wrappers over exactly these exports — neither has any
// orchestration logic of its own.

export { subscriptionEnv } from "./auth.ts";
export { installSignalHandlers } from "./registry.ts";
export { createProject, listProjects, getProject, getProjectByName, resolveProject } from "./projects.ts";
export type { CreateProjectInput } from "./projects.ts";
export { spawnCodeJob } from "./spawn-code-job.ts";
export type { SpawnCodeJobInput } from "./spawn-code-job.ts";
export { spawnDagJob, validateDagSpec } from "./spawn-dag-job.ts";
export type { SpawnDagJobInput } from "./spawn-dag-job.ts";
export { getRunStatus } from "./status.ts";
export type { JobStatusView } from "./status.ts";
export { cancelJobTree } from "./cancel.ts";
export type { CancelOutcome } from "./cancel.ts";
export { listJobs, getJob, listTasksForJob } from "./jobs-store.ts";
export type {
  ProjectRow,
  JobRow,
  TaskRow,
  JobKind,
  JobStatus,
  TaskStatus,
  ModelTier,
  DagSpec,
  DagTaskSpec,
  AgentRunSummary,
} from "./types.ts";
