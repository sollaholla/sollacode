// @effect-diagnostics nodeBuiltinImport:off - builds the expected platform path.
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { resolveDatabaseCompactionLaunch } from "./databaseCompactionLaunch.ts";

describe("resolveDatabaseCompactionLaunch", () => {
  const stateDir = "/Users/me/.solla-code/userdata";
  const scheduled = (path: string) =>
    path === NodePath.join(stateDir, "state.sqlite.compact-request.json");

  it("compacts at an ordinary launch when a compaction is scheduled", () => {
    expect(resolveDatabaseCompactionLaunch({ stateDir, argv: [], exists: scheduled })).toBe(
      "compact",
    );
    expect(
      resolveDatabaseCompactionLaunch({ stateDir, argv: ["--auto-resume"], exists: () => false }),
    ).toBe("none");
  });

  it("defers on a launch made by the app updater, scheduled or not", () => {
    const argv = ["--auto-resume", "--solla-update-launch=4F1C"];
    expect(resolveDatabaseCompactionLaunch({ stateDir, argv, exists: scheduled })).toBe("defer");
    expect(resolveDatabaseCompactionLaunch({ stateDir, argv, exists: () => false })).toBe("defer");
  });
});
