// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

const updaterScriptPath = NodeURL.fileURLToPath(
  new URL(
    "../../../../../desktop/resources/app-update/install-solla-code-update.sh",
    import.meta.url,
  ),
);

it("relaunches macOS from the installed bundle path, not a name, id, or recycled PID", async () => {
  const script = await NodeFSP.readFile(updaterScriptPath, "utf8");

  expect(script).toContain("launch_solla_code_app");
  expect(script).toContain('/usr/bin/open -n "$app" --args --auto-resume');
  expect(script).toContain("lsregister");
  expect(script).toContain('"$exe" --auto-resume');
  expect(script).toContain("/usr/bin/nohup");
  expect(script).toContain("&!");
  expect(script).toContain('/bin/kill -TERM "$wait_pid"');
  expect(script).toContain('/bin/kill -KILL "$wait_pid"');
  expect(script).toContain('/bin/kill -KILL "$wait_backend_pid"');
  expect(script).toContain('current_desktop_command="$(/bin/ps -p "$wait_pid"');
  expect(script).toContain('current_backend_command="$(/bin/ps -p "$wait_backend_pid"');
  expect(script).not.toContain("tell application id");
  expect(script).not.toContain("open -na");
  expect(script).not.toContain("open -a ");
  expect(script).not.toContain("open -b ");
  expect(script).not.toContain("pgrep");
  expect(script).not.toContain("pkill");
});

const plist = (version: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.sollacode.app</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
</dict>
</plist>
`;

async function makeFakeApp(path: string, version: string): Promise<void> {
  const executable = NodePath.join(path, "Contents", "MacOS", "Solla Code");
  await NodeFSP.mkdir(NodePath.dirname(executable), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(path, "Contents", "Info.plist"), plist(version));
  await NodeFSP.writeFile(executable, "#!/bin/zsh\nexit 0\n");
  await NodeFSP.chmod(executable, 0o755);
}

it.effect("rejects a stale macOS update invocation without targeting the replacement app", () =>
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    if (platform !== "darwin") return;

    yield* Effect.promise(async () => {
      const script = await NodeFSP.readFile(updaterScriptPath, "utf8");
      expect(script).not.toContain("tell application id");
      expect(script).not.toContain("open -na");
      expect(script).toContain('/bin/kill -TERM "$wait_pid"');

      const baseDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "solla-updater-stale-"));
      try {
        const artifactPath = NodePath.join(baseDir, "Solla Code 2.0.0.app");
        const targetPath = NodePath.join(baseDir, "Solla Code.app");
        const logPath = NodePath.join(baseDir, "update.log");
        await makeFakeApp(artifactPath, "2.0.0");
        await makeFakeApp(targetPath, "1.0.0");

        const result = NodeChildProcess.spawnSync(
          "/bin/zsh",
          [
            updaterScriptPath,
            "--mode",
            "install",
            "--artifact",
            artifactPath,
            "--target",
            targetPath,
            "--wait-pid",
            "999999",
            "--wait-backend-pid",
            "999998",
            "--health-url",
            "http://127.0.0.1:3773/",
            "--log-path",
            logPath,
          ],
          { encoding: "utf8" },
        );

        expect(result.status).toBe(75);
        expect(await NodeFSP.readFile(logPath, "utf8")).toContain(
          "The Solla Code desktop process that requested this update is no longer running.",
        );
        expect(
          await NodeFSP.readFile(NodePath.join(targetPath, "Contents", "Info.plist"), "utf8"),
        ).toContain("<string>1.0.0</string>");
        expect(await NodeFSP.readdir(baseDir)).not.toContain(
          ".Solla Code.app.update-staged-999999",
        );
      } finally {
        await NodeFSP.rm(baseDir, { recursive: true, force: true });
      }
    });
  }),
);
