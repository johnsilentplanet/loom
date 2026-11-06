// One coding-agent turn: a single Claude Agent SDK `query()` scoped to a
// working directory, with coding tools and subscription auth enforced.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { subscriptionEnv } from "./auth.ts";
import { buildRepoMap } from "./repo-map.ts";
import type { AgentRunSummary, ModelTier } from "./types.ts";

/** Built-in coding toolset every loom agent gets. Nothing beyond basic
 *  read/write/search/shell — loom does not wire in any MCP tools of its own
 *  for the coding agent itself (that's a job for whatever project/config the
 *  target repo brings, via settingSources: ["project"] below). */
const CODING_TOOLS = ["Read", "Write", "Edit", "Bash", "Grep", "Glob"];

export type RunCodingAgentOptions = {
  cwd: string;
  instructions: string;
  model?: ModelTier;
  abortController?: AbortController;
  /** Called with each chunk of assistant text as it streams in, for callers
   *  that want a live transcript (e.g. CLI progress output). */
  onText?: (text: string) => void;
};

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => {
      return typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text";
    })
    .map((b) => b.text)
    .join("");
}

/**
 * Run exactly one coding-agent turn against `cwd`. Returns once the SDK's
 * terminal `result` message arrives (or the abort controller fires).
 *
 * Subscription auth is enforced the same way everywhere in this codebase:
 * `env: subscriptionEnv()` strips any `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`
 * from the environment handed to the SDK subprocess, so it can only ever
 * authenticate against the local `~/.claude/` subscription session — never
 * key-based billing. This is a hard requirement; do not relax it.
 */
export async function runCodingAgent(opts: RunCodingAgentOptions): Promise<AgentRunSummary> {
  const repoMap = await buildRepoMap(opts.cwd);
  const preamble = repoMap
    ? `Repo file map (tracked files, for orientation — read the actual files you need; this is not their contents):\n${repoMap}\n\n`
    : "";

  const q = query({
    prompt: `${preamble}Task: ${opts.instructions}`,
    options: {
      cwd: opts.cwd,
      env: subscriptionEnv(),
      settingSources: ["project"],
      tools: CODING_TOOLS,
      allowedTools: CODING_TOOLS,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      model: opts.model ?? "sonnet",
      abortController: opts.abortController,
    },
  });

  let sessionId: string | undefined;
  let numTurns = 0;
  let totalCostUsd = 0;
  let finalResult: AgentRunSummary | null = null;

  try {
    for await (const msg of q) {
      if (msg.type === "assistant") {
        sessionId = msg.session_id ?? sessionId;
        const text = extractText(msg.message?.content);
        if (text && opts.onText) opts.onText(text);
      } else if (msg.type === "result") {
        sessionId = msg.session_id ?? sessionId;
        numTurns = msg.num_turns;
        totalCostUsd = msg.total_cost_usd;
        const ok = !msg.is_error && msg.subtype === "success";
        const summary = msg.subtype === "success" ? msg.result : (msg.errors ?? [msg.subtype]).join("; ");
        finalResult = { ok, summary, numTurns, totalCostUsd, sessionId };
      }
    }
  } catch (err) {
    const aborted = opts.abortController?.signal.aborted ?? false;
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      summary: aborted ? "cancelled" : `agent run failed: ${message}`,
      numTurns,
      totalCostUsd,
      sessionId,
    };
  }

  if (finalResult) return finalResult;

  // The stream ended without a `result` message — treat as a failure rather
  // than silently reporting success.
  return {
    ok: false,
    summary: "agent run ended without a result message",
    numTurns,
    totalCostUsd,
    sessionId,
  };
}
