// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off globalFetch:off - a standalone workflow step
/**
 * Reruns workflow jobs that GitHub cancelled without ever starting.
 *
 * A job no runner picked up ends `cancelled` with no steps after 15 minutes,
 * and the run then counts as failed even though nothing was wrong with it. Any
 * job that really failed is left for a person, since rerunning could hide it.
 * Run by `.github/workflows/rerun-unassigned-jobs.yml`.
 */
import * as NodePath from "node:path";

const MAX_RERUNS = 16;
const POLL_MS = 60_000;

export interface WorkflowJob {
  readonly name: string;
  readonly conclusion: string | null;
  readonly steps?: ReadonlyArray<unknown>;
}

export type RerunDecision =
  | { readonly action: "rerun"; readonly jobs: ReadonlyArray<string> }
  | { readonly action: "stop"; readonly reason: string };

export function decideRerun(jobs: ReadonlyArray<WorkflowJob>): RerunDecision {
  const failed = jobs.filter((job) => job.conclusion === "failure");
  if (failed.length > 0) {
    return {
      action: "stop",
      reason: `These jobs really failed: ${failed.map((job) => job.name).join(", ")}`,
    };
  }
  const unassigned = jobs.filter(
    (job) => job.conclusion === "cancelled" && (job.steps?.length ?? 0) === 0,
  );
  if (unassigned.length === 0) return { action: "stop", reason: "No job is waiting for a runner." };
  return { action: "rerun", jobs: unassigned.map((job) => job.name) };
}

async function main(): Promise<number> {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.RUN_ID;
  if (!token || !repository || !runId)
    throw new Error("GITHUB_TOKEN, GITHUB_REPOSITORY and RUN_ID are required.");
  const api = async (path: string, method = "GET"): Promise<unknown> => {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/actions/runs/${runId}${path}`,
      {
        method,
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      },
    );
    if (!response.ok) throw new Error(`${method} ${path} returned ${String(response.status)}.`);
    return response.status === 201 ? null : response.json();
  };
  for (let reruns = 0; reruns < MAX_RERUNS; reruns += 1) {
    const { jobs } = (await api("/jobs?filter=latest&per_page=100")) as {
      readonly jobs: ReadonlyArray<WorkflowJob>;
    };
    const decision = decideRerun(jobs);
    if (decision.action === "stop") {
      console.log(decision.reason);
      return 0;
    }
    console.log(`Rerun ${String(reruns + 1)}: ${decision.jobs.join(", ")}`);
    await api("/rerun-failed-jobs", "POST");
    await new Promise((done) => setTimeout(done, POLL_MS));
    for (;;) {
      const run = (await api("")) as {
        readonly status: string;
        readonly conclusion: string | null;
      };
      if (run.status === "completed") {
        if (run.conclusion === "failure") break;
        console.log(`The run finished: ${String(run.conclusion)}.`);
        return 0;
      }
      await new Promise((done) => setTimeout(done, POLL_MS));
    }
  }
  console.error(`Still no runner after ${String(MAX_RERUNS)} reruns.`);
  return 1;
}

if (process.argv[1] && NodePath.resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = await main();
}
