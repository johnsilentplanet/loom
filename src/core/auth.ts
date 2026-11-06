// Single source of the subscription-auth invariant.
//
// The Claude Agent SDK must NEVER pick up an API key from the environment —
// auth comes only from the local `claude login` subscription session in
// `~/.claude/`. Every query() in this codebase builds its env through this
// function so the invariant has exactly one home. Do not introduce an
// ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN fallback anywhere.
//
// This is defense-in-depth, not the whole story: the SDK reads the
// subscription token from `~/.claude/` independently of any `settingSources`
// option. Stripping these two env vars just guarantees that if one is ever
// set in the host environment (shell profile, CI, a stray `.env`), it can
// never silently switch a run from subscription billing to key billing.

export function subscriptionEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "ANTHROPIC_API_KEY" || k === "ANTHROPIC_AUTH_TOKEN") continue;
    if (typeof v === "string") env[k] = v;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "loom/0.0.1";
  return env;
}
