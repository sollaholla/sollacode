// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import { expect, it } from "@effect/vitest";

const updaterScriptPath = NodeURL.fileURLToPath(
  new URL(
    "../../../../../desktop/resources/app-update/install-solla-code-update.ps1",
    import.meta.url,
  ),
);

it("relaunches Windows independently of the updater console", async () => {
  const script = await NodeFSP.readFile(updaterScriptPath, "utf8");

  expect(script).toContain("DETACHED_PROCESS");
  expect(script).toContain("CREATE_NEW_PROCESS_GROUP");
  expect(script).toContain("CreateProcessW");
  expect(script).toContain('Write-Output "Windows updater process $PID started."');
  expect(script).toContain(
    '$launchedPid = Start-DetachedProcess -Path $Target -Arguments "--auto-resume"',
  );
  expect(script).not.toContain('Start-Process -FilePath $Target -ArgumentList "--auto-resume"');
  expect(script.trimEnd().endsWith("exit 0")).toBe(true);
});
