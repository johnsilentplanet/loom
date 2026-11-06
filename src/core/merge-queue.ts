// The "merge train" — a serialized merge queue, one chain per project.
//
// Multiple coding jobs can verify in parallel (each in its own worktree),
// but only one merge into a project's base branch may happen at a time:
// `git merge` mutates the canonical checkout, so two concurrent merges into
// the same repo would race on its working tree and index. `withMergeTrain`
// chains callers for the same project id so each merge waits for the
// previous one (success or failure) to finish before it starts.

const chains = new Map<string, Promise<unknown>>();

export async function withMergeTrain<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(projectId) ?? Promise.resolve();
  // Swallow the previous result/error — we only want the ordering, never to
  // propagate someone else's failure into this call.
  const chained = prev.catch(() => undefined).then(fn);
  // Store a version that never rejects so the NEXT caller's wait never
  // throws either; the real result/error still flows to this caller via
  // `chained`.
  chains.set(projectId, chained.catch(() => undefined));
  return chained;
}
