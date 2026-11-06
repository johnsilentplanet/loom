#!/usr/bin/env bun
// Loom CLI — a thin wrapper over src/core. No orchestration logic lives
// here; every command is a one-line call into the core library.

import { readFileSync } from "node:fs";
import {
  cancelJobTree,
  createProject,
  getRunStatus,
  installSignalHandlers,
  listJobs,
  listProjects,
  spawnCodeJob,
  spawnDagJob,
  type DagSpec,
  type ModelTier,
} from "../core/index.ts";

function usage(): void {
  console.log(`loom — a standalone, Claude-powered coding-agent DAG runner.

Usage:
  loom project add <name> <repoPath> [--base <branch>] [--verify '<cmd>']
  loom project list
  loom spawn <project> "<instructions>" [--model sonnet|opus|haiku] [--title <title>]
  loom dag <project> <graph.json>
  loom status <jobId>
  loom jobs [--project <project>]
  loom cancel <jobId>
`);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  return args[i + 1];
}

function stripFlags(args: string[], names: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i]!.replace(/^--/, "")) && args[i]!.startsWith("--")) {
      i++; // skip the value too
      continue;
    }
    out.push(args[i]!);
  }
  return out;
}

function isModelTier(v: string | undefined): v is ModelTier {
  return v === "sonnet" || v === "opus" || v === "haiku";
}

function printJob(job: { id: string; status: string; title: string; error: string | null }): void {
  console.log(`job ${job.id} [${job.status}] ${job.title}`);
  if (job.error) console.log(`  error: ${job.error}`);
}

async function main(): Promise<void> {
  installSignalHandlers();
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    usage();
    return;
  }

  if (cmd === "project") {
    const [sub, ...args] = rest;
    if (sub === "add") {
      const positional = stripFlags(args, ["base", "verify"]);
      const [name, repoPath] = positional;
      if (!name || !repoPath) throw new Error("usage: loom project add <name> <repoPath> [--base <branch>] [--verify '<cmd>']");
      const project = createProject({
        name,
        repoPath,
        defaultBase: flag(args, "base"),
        verifyCmd: flag(args, "verify"),
      });
      console.log(`created project ${project.id} (${project.name}) -> ${project.repo_path}`);
      return;
    }
    if (sub === "list") {
      for (const p of listProjects()) {
        console.log(`${p.id}  ${p.name}  ${p.repo_path}  base=${p.default_base}  verify=${p.verify_cmd ?? "(none)"}`);
      }
      return;
    }
    throw new Error(`unknown 'project' subcommand: ${sub}`);
  }

  if (cmd === "spawn") {
    const positional = stripFlags(rest, ["model", "title"]);
    const [project, instructions] = positional;
    if (!project || !instructions) {
      throw new Error('usage: loom spawn <project> "<instructions>" [--model sonnet|opus|haiku] [--title <title>]');
    }
    const modelFlag = flag(rest, "model");
    if (modelFlag && !isModelTier(modelFlag)) throw new Error(`invalid --model: ${modelFlag}`);
    const job = await spawnCodeJob({
      project,
      instructions,
      model: isModelTier(modelFlag) ? modelFlag : undefined,
      title: flag(rest, "title"),
    });
    printJob(job);
    process.exitCode = job.status === "done" ? 0 : 1;
    return;
  }

  if (cmd === "dag") {
    const [project, graphPath] = rest;
    if (!project || !graphPath) throw new Error("usage: loom dag <project> <graph.json>");
    const raw = readFileSync(graphPath, "utf8");
    const spec = JSON.parse(raw) as DagSpec;
    const job = await spawnDagJob({ project, spec });
    printJob(job);
    const status = getRunStatus(job.id);
    for (const t of status?.tasks ?? []) {
      console.log(`  task ${t.name} [${t.status}]${t.error ? ` — ${t.error}` : ""}`);
    }
    process.exitCode = job.status === "done" ? 0 : 1;
    return;
  }

  if (cmd === "status") {
    const [jobId] = rest;
    if (!jobId) throw new Error("usage: loom status <jobId>");
    const view = getRunStatus(jobId);
    if (!view) throw new Error(`job not found: ${jobId}`);
    printJob(view.job);
    for (const t of view.tasks) {
      console.log(`  task ${t.name} [${t.status}]${t.error ? ` — ${t.error}` : ""}`);
    }
    return;
  }

  if (cmd === "jobs") {
    const projectFlag = flag(rest, "project");
    for (const job of listJobs(projectFlag ? { projectId: projectFlag } : {})) {
      printJob(job);
    }
    return;
  }

  if (cmd === "cancel") {
    const [jobId] = rest;
    if (!jobId) throw new Error("usage: loom cancel <jobId>");
    const outcome = await cancelJobTree(jobId);
    console.log(outcome.message);
    process.exitCode = outcome.ok ? 0 : 1;
    return;
  }

  usage();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
