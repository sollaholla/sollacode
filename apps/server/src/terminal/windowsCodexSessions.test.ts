import { describe, expect, it } from "vite-plus/test";
import {
  codexSessionForProcesses,
  parseCodexSessionOwners,
  windowsCodexSessionOwnersCommand,
} from "./windowsCodexSessions.ts";
const a = "01a0a09f-510e-7cc3-b306-c864e84ba591";
const b = "01a0a09f-e862-7ab2-9673-768cb3cc2ad8";
describe("Windows Codex session ownership", () => {
  it("maps concurrent panes to their own process-owned sessions", () => {
    const owners = parseCodexSessionOwners(
      JSON.stringify([
        { pid: 12, sessionId: a },
        { pid: 34, sessionId: b },
      ]),
    );
    expect(codexSessionForProcesses(owners, [10, 11, 12])).toBe(a);
    expect(codexSessionForProcesses(owners, [30, 34])).toBe(b);
    expect(codexSessionForProcesses(owners, [99])).toBeNull();
  });
  it("rejects ambiguous shared processes rather than choosing the latest session", () => {
    expect(
      codexSessionForProcesses(
        [
          { pid: 12, sessionId: a },
          { pid: 12, sessionId: b },
        ],
        [12],
      ),
    ).toBeNull();
  });
  it("rejects malformed records and truncated results", () => {
    expect(parseCodexSessionOwners('[{"pid":12')).toEqual([]);
    expect(
      parseCodexSessionOwners(
        JSON.stringify([
          { pid: -1, sessionId: a },
          { pid: 1, sessionId: "../../other" },
        ]),
      ),
    ).toEqual([]);
  });
  it("quotes paths and only uses resource-owner enumeration", () => {
    const command = windowsCodexSessionOwnersCommand(
      "C:\\Users\\O'Brien\\.codex\\thread-writer-locks",
    );
    expect(command).toContain("O''Brien");
    expect(command).not.toMatch(/RmShutdown|RmRestart|Stop-Process/);
  });
});
