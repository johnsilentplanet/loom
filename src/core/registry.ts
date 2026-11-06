// In-process registry of live AbortControllers, keyed by job id (and, for
// DAG jobs, also by "<jobId>:<taskId>"). This is what makes cancel instant
// when the cancelling process is the same process that's running the job
// (e.g. the MCP server, or a CLI run that's still attached); for a job
// running in a *different* process, cancel.ts falls back to signalling the
// owning pid (see jobs.pid) and that process's own signal handler drains
// this same registry.

const active = new Map<string, AbortController>();

export function registerAbort(key: string, controller: AbortController): void {
  active.set(key, controller);
}

export function unregisterAbort(key: string): void {
  active.delete(key);
}

/** Abort every controller whose key is `key` or starts with `key:`. Returns
 *  the number of controllers aborted. */
export function abortLocal(key: string): number {
  let n = 0;
  for (const [k, controller] of active) {
    if (k === key || k.startsWith(`${key}:`)) {
      controller.abort();
      n++;
    }
  }
  return n;
}

/** Install SIGINT/SIGTERM handlers that abort every in-flight run in this
 *  process before exiting. Call once per process (CLI entrypoint, MCP
 *  server entrypoint). Idempotent. */
let installed = false;
export function installSignalHandlers(): void {
  if (installed) return;
  installed = true;
  const onSignal = () => {
    for (const controller of active.values()) controller.abort();
    // Give in-flight tasks a brief moment to notice the abort and persist a
    // "cancelled" status before the process goes away.
    setTimeout(() => process.exit(0), 300);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

/** Best-effort liveness check for a pid recorded in the jobs table. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
