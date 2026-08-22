import { describe, expect, it } from "vite-plus/test";

import {
  inspectWindowsSubprocessFromRows,
  parseWindowsCimProcessOutput,
  WINDOWS_PROCESS_FIELD_SEP,
  windowsProcessSnapshotCommand,
} from "./windowsSubprocess.ts";

const sep = WINDOWS_PROCESS_FIELD_SEP;

describe("windows subprocess snapshot", () => {
  it("embeds every terminal pid in one PowerShell walk", () => {
    const command = windowsProcessSnapshotCommand([100, 200, 0, 300]);
    expect(command).toContain("[int]100");
    expect(command).toContain("[int]200");
    expect(command).toContain("[int]300");
    expect(command).not.toContain("[int]0");
    expect(command).toContain("Get-CimInstance Win32_Process");
  });

  it("parses unit-separated CIM rows including command lines with pipes", () => {
    expect(
      parseWindowsCimProcessOutput(
        [
          `101${sep}100${sep}node.exe${sep}node C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js`,
          `102${sep}101${sep}codex.exe${sep}codex | more`,
          "not-a-row",
        ].join("\n"),
      ),
    ).toEqual([
      {
        pid: 101,
        parentPid: 100,
        name: "node.exe",
        commandLine: "node C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
      },
      {
        pid: 102,
        parentPid: 101,
        name: "codex.exe",
        commandLine: "codex | more",
      },
    ]);
  });

  it("labels a Windows Codex npm shim as codex instead of node", () => {
    const inspect = inspectWindowsSubprocessFromRows(50, [
      {
        pid: 60,
        parentPid: 50,
        name: "cmd.exe",
        commandLine: "C:\\Windows\\system32\\cmd.exe /d /s /c C:\\npm\\codex.cmd",
      },
      {
        pid: 70,
        parentPid: 60,
        name: "node.exe",
        commandLine:
          "node.exe C:\\Users\\ada\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
      },
    ]);
    expect(inspect.hasRunningSubprocess).toBe(true);
    expect(inspect.childCommand).toBe("codex");
    expect(inspect.processIds).toEqual(expect.arrayContaining([50, 60, 70]));
  });

  it("keeps a non-agent first child label", () => {
    expect(
      inspectWindowsSubprocessFromRows(8, [
        {
          pid: 9,
          parentPid: 8,
          name: "vim.exe",
          commandLine: "vim.exe notes.txt",
        },
      ]).childCommand,
    ).toBe("vim");
  });

  it("reports no child when the terminal pid has no descendants", () => {
    expect(inspectWindowsSubprocessFromRows(8, []).hasRunningSubprocess).toBe(false);
  });
});
