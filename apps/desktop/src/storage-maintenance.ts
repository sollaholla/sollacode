// @effect-diagnostics nodeBuiltinImport:off - Standalone post-install entry point.
// @effect-diagnostics globalDate:off - Detached Node CLI has no Effect runtime.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { cleanupReleaseArtifacts } from "./storage/releaseRetention.ts";
import { storageCleanupEnabled } from "./storage/storageCleanupSettings.ts";
import { openStoragePaths } from "./storage/openStoragePaths.ts";
import { availableStorageBytes } from "./storage/availableStorage.ts";

const { values } = NodeUtil.parseArgs({
  options: { artifact: { type: "string" }, settings: { type: "string" } },
});
const artifactPath = values.artifact;
if (!artifactPath) throw new Error("--artifact is required");
const settingsPath =
  values.settings ??
  NodePath.join(
    process.env.T3CODE_HOME || NodePath.join(NodeOS.homedir(), ".solla-code"),
    "userdata",
    "settings.json",
  );

async function maintainRelease(artifact: string) {
  const beforeBytes = await availableStorageBytes(NodePath.dirname(artifact));
  const removed = await cleanupReleaseArtifacts({
    artifactPath: artifact,
    nowMs: Date.now(),
    isEnabled: () => storageCleanupEnabled(settingsPath),
    openPaths: openStoragePaths,
  });
  const afterBytes = await availableStorageBytes(NodePath.dirname(artifact));
  process.stdout.write(
    `${JSON.stringify({ event: "release storage cleanup", removed, availableBytesDelta: afterBytes - beforeBytes })}\n`,
  );
}

void maintainRelease(artifactPath).catch((error: unknown) => {
  // Cleanup is best effort and must never turn a healthy installation into a rollback.
  process.stderr.write(`Release cleanup skipped: ${String(error)}\n`);
});
