// @effect-diagnostics nodeBuiltinImport:off - Also read by the detached installer.
import * as NodeFSP from "node:fs/promises";
import * as Schema from "effect/Schema";
import { fromLenientJson } from "@t3tools/shared/schemaJson";

const decode = Schema.decodeUnknownSync(
  fromLenientJson(
    Schema.Struct({
      automaticStorageCleanupEnabled: Schema.optionalKey(Schema.Boolean),
    }),
  ),
);

/** Missing settings use the default; unreadable or malformed settings stop cleanup. */
export async function storageCleanupEnabled(settingsPath: string): Promise<boolean> {
  try {
    return (
      decode(await NodeFSP.readFile(settingsPath, "utf8")).automaticStorageCleanupEnabled ?? true
    );
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  }
}
