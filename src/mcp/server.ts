#!/usr/bin/env bun
// Loom's MCP server — exposes the same core operations as the CLI, as MCP
// tools over stdio, so loom can be wired into a Claude Code / Claude Desktop
// MCP config directly. Like the CLI, this is a thin wrapper: every tool
// handler is a one-line call into src/core.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  cancelJobTree,
  createProject,
  getRunStatus,
  installSignalHandlers,
  listJobs,
  listProjects,
  listTasksForJob,
  spawnCodeJob,
  spawnDagJob,
  type DagSpec,
} from "../core/index.ts";

const server = new McpServer({ name: "loom", version: "0.0.1" });

server.registerTool(
  "create_project",
  {
    title: "Register a project",
    description:
      "Register a git repo as a loom project: name, absolute repo path, default base branch, and an optional verify command run inside a worktree before any merge.",
    inputSchema: {
      name: z.string().describe("Unique project name"),
      repoPath: z.string().describe("Absolute path to the git repo"),
      defaultBase: z.string().optional().describe("Base branch to fork worktrees from (default: main)"),
      verifyCmd: z.string().optional().describe("Shell command run inside the worktree to gate merges"),
    },
  },
  async ({ name, repoPath, defaultBase, verifyCmd }) => {
    const project = createProject({ name, repoPath, defaultBase, verifyCmd });
    return { content: [{ type: "text", text: JSON.stringify(project, null, 2) }] };
  },
);

server.registerTool(
  "list_projects",
  {
    title: "List registered projects",
    description: "List every project registered with loom.",
    inputSchema: {},
  },
  async () => {
    return { content: [{ type: "text", text: JSON.stringify(listProjects(), null, 2) }] };
  },
);

server.registerTool(
  "spawn_code_job",
  {
    title: "Spawn a single coding job",
    description:
      "Spawn one coding agent against a registered project: isolated git worktree, one agent run, verify, serialized merge into the base branch on success. Blocks until the job reaches a terminal state and returns its final status.",
    inputSchema: {
      project: z.string().describe("Project id or name"),
      instructions: z.string().describe("Free-text instructions for the coding agent"),
      model: z.enum(["sonnet", "opus", "haiku"]).optional().describe("Model tier (default: sonnet)"),
      title: z.string().optional().describe("Short title for the job (default: derived from instructions)"),
    },
  },
  async ({ project, instructions, model, title }) => {
    const job = await spawnCodeJob({ project, instructions, model, title });
    return { content: [{ type: "text", text: JSON.stringify(job, null, 2) }] };
  },
);

server.registerTool(
  "spawn_dag_job",
  {
    title: "Spawn a DAG of coding tasks",
    description:
      "Spawn a small task graph against a registered project: tasks share one scratch workspace (no git), independent tasks run in parallel, dependents wait. Blocks until the job reaches a terminal state and returns its final status plus every task's status.",
    inputSchema: {
      project: z.string().describe("Project id or name"),
      title: z.string().optional().describe("Short title for the job"),
      tasks: z
        .array(
          z.object({
            name: z.string().describe("Unique task name within this graph"),
            instructions: z.string().describe("Free-text instructions for this task's agent"),
            depends_on: z.array(z.string()).optional().describe("Names of tasks that must finish first"),
            model: z.enum(["sonnet", "opus", "haiku"]).optional(),
          }),
        )
        .describe("The task graph"),
    },
  },
  async ({ project, title, tasks }) => {
    const spec: DagSpec = { tasks };
    const job = await spawnDagJob({ project, spec, title });
    const taskRows = listTasksForJob(job.id);
    return { content: [{ type: "text", text: JSON.stringify({ job, tasks: taskRows }, null, 2) }] };
  },
);

server.registerTool(
  "get_run_status",
  {
    title: "Get job status",
    description: "Fetch one job's current status, and its task tree for DAG jobs.",
    inputSchema: { jobId: z.string().describe("Job id returned by spawn_code_job / spawn_dag_job") },
  },
  async ({ jobId }) => {
    const view = getRunStatus(jobId);
    if (!view) {
      return { content: [{ type: "text", text: `job not found: ${jobId}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(view, null, 2) }] };
  },
);

server.registerTool(
  "list_run_jobs",
  {
    title: "List jobs",
    description: "List jobs, optionally filtered by project id.",
    inputSchema: { projectId: z.string().optional() },
  },
  async ({ projectId }) => {
    return {
      content: [{ type: "text", text: JSON.stringify(listJobs(projectId ? { projectId } : {}), null, 2) }],
    };
  },
);

server.registerTool(
  "cancel_job_tree",
  {
    title: "Cancel a job tree",
    description: "Cancel a running job tree: aborts in-flight tasks, leaves already-completed tasks alone.",
    inputSchema: { jobId: z.string().describe("Job id to cancel") },
  },
  async ({ jobId }) => {
    const outcome = await cancelJobTree(jobId);
    return { content: [{ type: "text", text: outcome.message }], isError: !outcome.ok };
  },
);

async function main(): Promise<void> {
  installSignalHandlers();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
