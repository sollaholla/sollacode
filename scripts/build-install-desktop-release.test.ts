// @effect-diagnostics nodeBuiltinImport:off - reads the checked-in t3.json action as a fixture.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  buildInstallerArgs,
  parseProcessTable,
  resolveConfiguredDesktopPid,
  resolveDesktopAppPath,
  resolveDesktopBackendPid,
  resolveDesktopHealthUrl,
  resolveDesktopRuntimePids,
  resolveMacBuildArch,
  resolveReleaseArtifactPath,
  type DesktopReleaseContext,
} from "./build-install-desktop-release.ts";

describe("build-install-desktop-release", () => {
  it("uses safe installed-app defaults when terminal-private desktop variables are absent", () => {
    expect(resolveDesktopAppPath(undefined)).toBe("/Applications/Solla Code.app");
    expect(resolveDesktopHealthUrl(undefined)).toBe("http://127.0.0.1:3773/");
    expect(resolveConfiguredDesktopPid(undefined)).toBeUndefined();

    expect(resolveDesktopAppPath(" /Custom/Solla Code.app ")).toBe("/Custom/Solla Code.app");
    expect(resolveDesktopHealthUrl("http://127.0.0.1:4888")).toBe("http://127.0.0.1:4888/");
    expect(resolveConfiguredDesktopPid("101")).toBe(101);
  });

  it("resolves the architecture-specific zip built for local installation", () => {
    expect(resolveMacBuildArch("arm64")).toBe("arm64");
    expect(resolveMacBuildArch("x64")).toBe("x64");
    expect(() => resolveMacBuildArch("ia32")).toThrow(/do not support architecture/);
    expect(
      resolveReleaseArtifactPath({
        repoRoot: "/repo",
        version: "0.1.177",
        architecture: "arm64",
      }),
    ).toBe("/repo/release/Solla-Code-0.1.177-arm64.zip");
  });

  it("selects only the server backend owned by the captured desktop process", () => {
    const processes = parseProcessTable(`
      101     1 /Applications/Solla Code.app/Contents/MacOS/Solla Code --auto-resume
      202   101 /Applications/Solla Code.app/Contents/MacOS/Solla Code apps/server/dist/bin.mjs --bootstrap-fd 3
      203   999 /Applications/Solla Code.app/Contents/MacOS/Solla Code apps/server/dist/bin.mjs --bootstrap-fd 3
      204   101 /bin/zsh
    `);

    expect(
      resolveDesktopBackendPid({
        processes,
        desktopPid: 101,
        appPath: "/Applications/Solla Code.app",
      }),
    ).toBe(202);
    expect(
      resolveDesktopRuntimePids({
        processes,
        appPath: "/Applications/Solla Code.app",
      }),
    ).toEqual({ desktopPid: 101, backendPid: 202 });
  });

  it("refuses missing or ambiguous desktop backend state", () => {
    const backend = {
      pid: 202,
      parentPid: 101,
      command: "/Applications/Solla Code.app/Contents/MacOS/Solla Code apps/server/dist/bin.mjs",
    };
    expect(() =>
      resolveDesktopBackendPid({
        processes: [],
        desktopPid: 101,
        appPath: "/Applications/Solla Code.app",
      }),
    ).toThrow(/found 0/);
    expect(() =>
      resolveDesktopBackendPid({
        processes: [backend, { ...backend, pid: 203 }],
        desktopPid: 101,
        appPath: "/Applications/Solla Code.app",
      }),
    ).toThrow(/found 2/);
    expect(() =>
      resolveDesktopRuntimePids({
        processes: [
          {
            pid: 101,
            parentPid: 1,
            command: "/Applications/Solla Code.app/Contents/MacOS/Solla Code",
          },
          backend,
          { ...backend, pid: 203 },
        ],
        appPath: "/Applications/Solla Code.app",
      }),
    ).toThrow(/pair, found 2/);
  });

  it("passes exact captured processes and auto-resume installer inputs", () => {
    const context: DesktopReleaseContext = {
      appPath: "/Applications/Solla Code.app",
      artifactPath: "/repo/release/Solla-Code-0.1.177-arm64.zip",
      backendPid: 202,
      desktopPid: 101,
      healthUrl: "http://127.0.0.1:3773/",
      installerPath: "/repo/apps/desktop/resources/app-update/install-solla-code-update.sh",
      logPath: "/repo/release/desktop-release-install.log",
    };

    expect(buildInstallerArgs(context)).toEqual([
      context.installerPath,
      "--mode",
      "install",
      "--artifact",
      context.artifactPath,
      "--target",
      context.appPath,
      "--wait-pid",
      "101",
      "--wait-backend-pid",
      "202",
      "--health-url",
      context.healthUrl,
      "--log-path",
      context.logPath,
    ]);
  });

  it("keeps the checked-in action wired to the release installer", () => {
    const projectFileUrl = new URL("../t3.json", import.meta.url);
    const projectFile = JSON.parse(NodeFS.readFileSync(projectFileUrl, "utf8")) as {
      scripts?: ReadonlyArray<{ name?: string; command?: string; icon?: string }>;
    };
    expect(projectFile.scripts).toContainEqual({
      name: "Build & Relaunch Release",
      command: "env -u ELECTRON_RUN_AS_NODE node scripts/build-install-desktop-release.ts",
      icon: "build",
    });
  });
});
