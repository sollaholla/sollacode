// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

/** A host-volume measurement, which can also reflect concurrent background writes. */
export async function availableStorageBytes(path: string) {
  const stats = await NodeFSP.statfs(path);
  return stats.bavail * stats.bsize;
}
