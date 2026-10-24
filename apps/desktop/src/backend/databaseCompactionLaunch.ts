// @effect-diagnostics nodeBuiltinImport:off - the splash and the backend start config both need this answer synchronously.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { databaseCompactionRequestPath, isUpdateLaunch } from "@t3tools/shared/databaseCompaction";

/**
 * What the primary backend's next start does with a database compaction
 * scheduled from Settings → Storage:
 *
 * - "defer": this launch was made by the app updater. Its health check rolls
 *   the update back if the backend is not answering within about two minutes,
 *   so compaction waits for the next ordinary start.
 * - "compact": a compaction is scheduled and will run before the backend
 *   answers, so the splash says so and readiness is given longer.
 * - "none": nothing is scheduled.
 */
export type DatabaseCompactionLaunch = "defer" | "compact" | "none";

export function resolveDatabaseCompactionLaunch(input: {
  readonly stateDir: string;
  readonly argv: ReadonlyArray<string>;
  readonly exists?: (path: string) => boolean;
}): DatabaseCompactionLaunch {
  if (isUpdateLaunch(input.argv)) return "defer";
  const exists = input.exists ?? NodeFS.existsSync;
  const requestPath = databaseCompactionRequestPath(NodePath.join(input.stateDir, "state.sqlite"));
  return exists(requestPath) ? "compact" : "none";
}
