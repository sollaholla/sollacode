// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

import { resolveProviderMaintenanceCapabilitiesEffect } from "../providerMaintenance.ts";
import { CodexProviderMaintenance } from "./CodexDriver.ts";

it.layer(NodeServices.layer)("CodexDriver", (it) => {
  it.effect("uses Codex self-update for a standalone installation reached through a symlink", () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-codex-standalone-"));
      const releaseBinDir = NodePath.join(
        root,
        ".codex",
        "packages",
        "standalone",
        "releases",
        "0.146.0-aarch64-apple-darwin",
        "bin",
      );
      const localBinDir = NodePath.join(root, ".local", "bin");
      NodeFS.mkdirSync(releaseBinDir, { recursive: true });
      NodeFS.mkdirSync(localBinDir, { recursive: true });
      const releaseBinary = NodePath.join(releaseBinDir, "codex");
      NodeFS.writeFileSync(releaseBinary, "#!/bin/sh\n");
      NodeFS.chmodSync(releaseBinary, 0o755);
      NodeFS.symlinkSync(releaseBinary, NodePath.join(localBinDir, "codex"));

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
        CodexProviderMaintenance,
        {
          binaryPath: "codex",
          env: { PATH: localBinDir },
        },
      ).pipe(Effect.provideService(HostProcessPlatform, "darwin"));

      expect(capabilities.update).toEqual({
        command: "codex update",
        executable: "codex",
        args: ["update"],
        lockKey: "codex-standalone",
      });
    }),
  );
});
