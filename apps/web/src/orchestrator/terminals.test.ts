import { describe, expect, it } from "vite-plus/test";

import {
  compactTerminals,
  describeTerminalAloud,
  presentTerminalRead,
  resolveTerminalReference,
  terminalsForThread,
  type OrchestratorTerminalRecord,
} from "./terminals";

const claude: OrchestratorTerminalRecord = {
  environmentId: "env-1",
  threadId: "thread-a",
  threadTitle: "Rover",
  terminalId: "term-1",
  label: "claude",
  status: "running",
  hasRunningSubprocess: true,
  cwd: "/tmp/rover",
};

const shell: OrchestratorTerminalRecord = {
  environmentId: "env-1",
  threadId: "thread-a",
  threadTitle: "Rover",
  terminalId: "term-2",
  label: "Terminal 2",
  status: "running",
  hasRunningSubprocess: false,
  cwd: "/tmp/rover",
};

const other: OrchestratorTerminalRecord = {
  environmentId: "env-1",
  threadId: "thread-b",
  threadTitle: "Vera",
  terminalId: "term-1",
  label: "grok",
  status: "running",
  hasRunningSubprocess: true,
  cwd: "/tmp/vera",
};

describe("resolveTerminalReference", () => {
  it("picks the only pane without a name", () => {
    const result = resolveTerminalReference([claude], {});
    expect(result).toEqual({ ok: true, terminal: claude, confident: true });
  });

  it("matches a label the user said", () => {
    const result = resolveTerminalReference([claude, shell, other], { query: "claude" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.terminal).toBe(claude);
  });

  it("narrows to a thread when two panes share an id", () => {
    const result = resolveTerminalReference([claude, other], {
      query: "term-1",
      threadId: "thread-b",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.terminal).toBe(other);
  });

  it("asks when two panes fit equally well", () => {
    const result = resolveTerminalReference([claude, shell], {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("ambiguous");
  });
});

describe("terminalsForThread", () => {
  it("keeps only the thread's own panes", () => {
    expect(
      terminalsForThread([claude, shell, other], { environmentId: "env-1", threadId: "thread-a" }),
    ).toEqual([claude, shell]);
  });
});

describe("presentTerminalRead", () => {
  it("strips color codes from the buffer", () => {
    const result = presentTerminalRead(claude, "\u001b[31mfail\u001b[0m now");
    expect(result.output).toBe("fail now");
    expect(result.truncated).toBe(false);
  });
});

describe("compactTerminals", () => {
  it("drops cwd and titles from the list-threads view", () => {
    expect(compactTerminals([claude])).toEqual([
      {
        terminalId: "term-1",
        label: "claude",
        status: "running",
        hasRunningSubprocess: true,
      },
    ]);
  });
});

describe("describeTerminalAloud", () => {
  it("names the thread and the running command", () => {
    expect(describeTerminalAloud(claude)).toBe("Rover's claude (running claude)");
  });
});
