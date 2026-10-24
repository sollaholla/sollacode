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
  expect(script.indexOf("storage-maintenance.cjs")).toBeGreaterThan(
    script.indexOf('if [[ "$healthy" -ne 1 ]]'),
  );
  expect(script).toContain('--settings "$settings_path"');
  expect(script).toContain('/usr/bin/open -n "$app" --args --auto-resume "$launch_marker"');
  expect(script).toContain('"$exe" --auto-resume "$launch_marker"');
  const rollback = script.slice(script.indexOf("rollback() {"));
  expect(rollback.indexOf("stop_marked_launch")).toBeGreaterThan(0);
  expect(rollback.indexOf("stop_marked_launch")).toBeLessThan(
    rollback.indexOf('/bin/mv "$backup_app" "$target_app"'),
  );
});

// Stand-ins for the app: each runs with the app executable as argv[0], so `ps`
// shows the command lines the installer sees. A desktop starts one backend and
// on TERM either stops it and quits, or ignores TERM.
const FAKE_DESKTOP = `
( exec -a "$APP_EXE" /bin/zsh "$DIR/backend.zsh" --max-old-space-size=8192 /app.asar/apps/server/dist/bin.mjs --bootstrap-fd 3 ) &
backend=$!
if [[ "$1" == quit ]]; then trap 'kill -TERM $backend; exit 0' TERM; else trap '' TERM; fi
while true; do sleep 0.1; done
`;
const FAKE_BACKEND = `
: > "$DIR/running/$$"
trap 'exit 0' TERM
while true; do sleep 0.1; done
`;
const ROLLBACK_HARNESS = `
set -eu
export DIR="$1" APP_EXE="$1/Solla Code.app/Contents/MacOS/Solla Code"
expected_executable="$APP_EXE"
launch_marker="--solla-update-launch=$(/usr/bin/uuidgen)"
shutdown_grace_seconds=1
source "$DIR/functions.zsh"
desktops=()
cleanup() {
  local pid
  for pid in "\${desktops[@]}" "$DIR"/running/*(N:t); do
    if [[ "$(/bin/ps -p "$pid" -o command= 2>/dev/null)" == "$APP_EXE "* ]]; then
      /bin/kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  return 0
}
trap cleanup EXIT
trap 'exit 1' TERM INT HUP PIPE
# Started from a subshell that exits at once, so launchd reaps them as it does the app.
start() { desktops+=($( ( exec -a "$APP_EXE" /bin/zsh "$DIR/desktop.zsh" "$@" ) >/dev/null 2>&1 & print $! )) }
start quit --auto-resume "$launch_marker"
start ignore --auto-resume "$launch_marker"
start quit --auto-resume "--solla-update-launch=$(/usr/bin/uuidgen)"
start quit --auto-resume
for _ in {1..100}; do
  ready=("$DIR"/running/*(N))
  (( \${#ready} == 4 )) && break
  sleep 0.1
done
state() {
  local pid
  local -a seen
  for pid in "$@"; do /bin/kill -0 "$pid" 2>/dev/null && seen+=(alive) || seen+=(gone); done
  print -r -- "\${seen[*]}"
}
marked=(\${(f)"$(marked_desktop_pids)"})
stopping=(\${(f)"$(backend_pids_of $desktops[1] $desktops[2])"})
keeping=(\${(f)"$(backend_pids_of $desktops[3] $desktops[4])"})
stop_marked_launch
print "marked \${(on)marked} of \${(on)desktops[1,2]}"
print "stopped $(state $desktops[1] $desktops[2] $stopping)"
print "kept $(state $desktops[3] $desktops[4] $keeping)"
`;

it.effect("rolls back by stopping only the launch carrying this invocation's marker", () =>
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    if (platform !== "darwin") return;

    yield* Effect.promise(async () => {
      const script = await NodeFSP.readFile(updaterScriptPath, "utf8");
      const start = script.indexOf("marked_desktop_pids() {");
      const end = script.indexOf("\n}\n", script.indexOf("stop_marked_launch() {")) + 3;
      const baseDir = await NodeFSP.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "solla-updater-rollback-"),
      );
      try {
        await NodeFSP.writeFile(NodePath.join(baseDir, "functions.zsh"), script.slice(start, end));
        await NodeFSP.writeFile(NodePath.join(baseDir, "desktop.zsh"), FAKE_DESKTOP);
        await NodeFSP.writeFile(NodePath.join(baseDir, "backend.zsh"), FAKE_BACKEND);
        await NodeFSP.mkdir(NodePath.join(baseDir, "running"));
        const result = NodeChildProcess.spawnSync(
          "/bin/zsh",
          ["-c", ROLLBACK_HARNESS, "harness", baseDir],
          { encoding: "utf8", timeout: 30_000 },
        );

        // The installer's own notes come first; the harness reports last.
        const report = result.stdout.trim().split("\n").slice(-3);
        const [marked, of] = (report[0] ?? "").slice("marked ".length).split(" of ");
        expect(result.status, result.stderr).toBe(0);
        expect(report[0]).toMatch(/^marked \d+ \d+ of \d+ \d+$/);
        expect(marked).toBe(of);
        expect(report.slice(1)).toEqual([
          "stopped gone gone gone gone",
          "kept alive alive alive alive",
        ]);
      } finally {
        await NodeFSP.rm(baseDir, { recursive: true, force: true });
      }
    });
  }),
);

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
