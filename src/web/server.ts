// Minimal local web dashboard — read-only "Runs" view over loom's existing
// SQLite store. No framework, no build step: Bun's built-in HTTP server
// serves a tiny JSON API (backed by src/core, same logic the CLI/MCP use)
// plus one dependency-free HTML+JS page that polls it.
//
// Binds to 127.0.0.1 by default — this is a local dev tool, not meant to be
// exposed publicly without the operator explicitly choosing a different
// LOOM_HOST. Port defaults to 4177 (distinct from orbit3's 3000, since both
// may run on the same host during development).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getRunStatus, listJobs, listProjects } from "../core/index.ts";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");

export type WebServerOptions = {
  port?: number;
  hostname?: string;
};

export function resolvePort(opts: WebServerOptions = {}): number {
  if (opts.port !== undefined) return opts.port;
  const raw = process.env.LOOM_PORT;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4177;
}

export function resolveHostname(opts: WebServerOptions = {}): string {
  return opts.hostname ?? process.env.LOOM_HOST ?? "127.0.0.1";
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function notFound(message = "not found"): Response {
  return new Response(message, { status: 404 });
}

/** Routes the tiny JSON API. Every handler is a direct pass-through to
 *  src/core — no status/job logic is reimplemented here. */
function handleApi(url: URL): Response | null {
  if (url.pathname === "/api/projects") {
    return json(listProjects());
  }

  if (url.pathname === "/api/jobs") {
    const projectId = url.searchParams.get("project") ?? undefined;
    return json(listJobs(projectId ? { projectId } : {}));
  }

  const statusMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/status$/);
  if (statusMatch) {
    const view = getRunStatus(statusMatch[1]!);
    if (!view) return notFound(`job not found: ${statusMatch[1]}`);
    return json(view);
  }

  return null;
}

export function startWebServer(opts: WebServerOptions = {}) {
  const port = resolvePort(opts);
  const hostname = resolveHostname(opts);

  return Bun.serve({
    port,
    hostname,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname.startsWith("/api/")) {
        try {
          return handleApi(url) ?? notFound();
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(Bun.file(join(PUBLIC_DIR, "index.html")));
      }

      return notFound();
    },
  });
}
