// @effect-diagnostics nodeBuiltinImport:off - reads the checked-in PowerShell helper as a fixture.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  buildWindowsArtifactArgs,
  parseConfiguredWindowsSshTargets,
  parseTailscaleWindowsHosts,
  resolveWindowsSshDestinations,
  resolveWindowsSshUsers,
  runWindowsThenMacRelease,
} from "./windows-ssh-release.ts";

describe("windows SSH desktop release", () => {
  it("discovers only online Windows peers and prefers stable MagicDNS names", () => {
    const status = JSON.stringify({
      Peer: {
        offline: {
          DNSName: "offline.tailnet.example.",
          OS: "windows",
          Online: false,
          TailscaleIPs: ["100.64.0.2"],
        },
        linux: {
          DNSName: "linux.tailnet.example.",
          OS: "linux",
          Online: true,
          TailscaleIPs: ["100.64.0.3"],
        },
        windows: {
          DNSName: "desktop.tailnet.example.",
          OS: "windows",
          Online: true,
          TailscaleIPs: ["100.64.0.4", "fd7a::4"],
        },
      },
    });

    expect(parseTailscaleWindowsHosts(status)).toEqual(["desktop.tailnet.example", "100.64.0.4"]);
    expect(parseTailscaleWindowsHosts("not-json")).toEqual([]);
  });

  it("supports explicit targets, opt-out, and non-personal username discovery", () => {
    expect(parseConfiguredWindowsSshTargets("dev@win-a, win-b")).toEqual(["dev@win-a", "win-b"]);
    expect(parseConfiguredWindowsSshTargets("off")).toEqual([]);
    expect(
      resolveWindowsSshUsers({
        configuredUser: "release-user",
        fullName: "Ada Lovelace",
        loginUser: "ada.local",
      }),
    ).toEqual(["release-user", "ada.local", "ada"]);
    expect(
      resolveWindowsSshDestinations({
        configuredTargets: ["dev@win-a", "win-b"],
        discoveredHosts: ["ignored"],
        users: ["ada", "release-user"],
      }),
    ).toEqual(["dev@win-a", "ada@win-b", "release-user@win-b"]);
  });

  it("requires both Windows-native and WSL-native payloads in the NSIS build", () => {
    expect(
      buildWindowsArtifactArgs({
        artifactBuildScript: "/repo/scripts/build-desktop-artifact.ts",
        outputDirectory: "/repo/release",
        resourceMonitorPrebuild: "/tmp/t3-resource-monitor.exe",
        wslPrebuild: "/tmp/pty.node",
      }),
    ).toEqual([
      "/repo/scripts/build-desktop-artifact.ts",
      "--platform",
      "win",
      "--target",
      "nsis",
      "--arch",
      "x64",
      "--output-dir",
      "/repo/release",
      "--resource-monitor-prebuild",
      "/tmp/t3-resource-monitor.exe",
      "--wsl-prebuild",
      "/tmp/pty.node",
    ]);
  });

  it("finishes Windows before Mac and still schedules Mac after a Windows failure", async () => {
    const calls: string[] = [];
    await runWindowsThenMacRelease({
      windows: async () => {
        calls.push("windows:start", "windows:complete");
        return true;
      },
      mac: async (windowsBuilt) => {
        calls.push(`mac:${String(windowsBuilt)}`);
      },
    });
    expect(calls).toEqual(["windows:start", "windows:complete", "mac:true"]);

    await expect(
      runWindowsThenMacRelease({
        windows: async () => {
          calls.push("windows:failed");
          throw new Error("windows failed");
        },
        onWindowsFailure: (error) => {
          calls.push(`reported:${error instanceof Error ? error.message : String(error)}`);
        },
        mac: async (windowsBuilt) => {
          calls.push(`mac:${String(windowsBuilt)}`);
        },
      }),
    ).rejects.toThrow(
      "Windows release failed, but the macOS release was scheduled: windows failed",
    );
    expect(calls).toEqual([
      "windows:start",
      "windows:complete",
      "mac:true",
      "windows:failed",
      "reported:windows failed",
      "mac:false",
    ]);
  });

  it("reports both release failures after attempting Mac", async () => {
    await expect(
      runWindowsThenMacRelease({
        windows: async () => {
          throw new Error("windows failed");
        },
        mac: async (windowsBuilt) => {
          expect(windowsBuilt).toBe(false);
          throw new Error("mac failed");
        },
      }),
    ).rejects.toThrow(
      "Windows release failed: windows failed\nmacOS release also failed: mac failed",
    );
  });

  it("keeps the remote installer exact-PID scoped and verifies durable runtime health", () => {
    const installerUrl = new URL("./windows-release-install.ps1", import.meta.url);
    const installer = NodeFS.readFileSync(installerUrl, "utf8");
    expect(installer).toContain("$current.ExecutablePath -eq $appExecutable");
    expect(installer).toContain("Stop-Process -Id ([int]$current.ProcessId) -Force");
    expect(installer).not.toMatch(/Stop-Process\s+-Name|taskkill|pkill/i);
    expect(installer).toContain("--auto-resume");
    expect(installer).toContain("ResponseHeadersRead");
    expect(installer).toContain("Start-Sleep -Seconds 10");
    expect(installer).toContain("$stableDeadline = (Get-Date).AddSeconds(30)");
    expect(installer).toContain("$consecutiveStableChecks -lt 6");
    expect(installer).toContain("New-Object -ComObject 'Schedule.Service'");
    expect(installer).toContain("$taskDefinition.Principal.LogonType = 3");
    expect(installer).toContain("-EncodedCommand $encodedLaunchScript");
    expect(installer).toContain("$taskFolder.DeleteTask($taskName, 0)");
    expect(installer).toContain("$explorerSessionIds -contains $rootSessionId");
    expect(installer).not.toContain("New-Object -ComObject Shell.Application");
  });
});
