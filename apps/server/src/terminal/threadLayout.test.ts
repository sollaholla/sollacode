import type { TerminalLayoutGroup } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { reconcileTerminalThreadLayoutGroups, terminalIdsInThreadLayout } from "./threadLayout.ts";

describe("terminal thread layout reconciliation", () => {
  const staleGroups: TerminalLayoutGroup[] = [
    {
      id: "group-main",
      name: "Main",
      terminalIds: ["term-1", "term-3"],
      layout: {
        kind: "split",
        direction: "horizontal",
        children: [
          { kind: "terminal", terminalId: "term-1" },
          { kind: "terminal", terminalId: "term-3" },
        ],
        sizes: [0.7, 0.3],
      },
    },
  ];

  it("prunes closed panes and appends sessions missing from an old document", () => {
    const reconciled = reconcileTerminalThreadLayoutGroups(staleGroups, ["term-1", "term-2"]);

    expect(reconciled).toEqual([
      {
        id: "group-main",
        name: "Main",
        terminalIds: ["term-1"],
      },
      {
        id: "group-term-2",
        terminalIds: ["term-2"],
      },
    ]);
    expect(terminalIdsInThreadLayout(reconciled)).toEqual(["term-1", "term-2"]);
  });

  it("retains surviving nested topology while removing a closed pane", () => {
    const groups: TerminalLayoutGroup[] = [
      {
        id: "group-main",
        terminalIds: ["term-1", "term-2", "term-3"],
        layout: {
          kind: "split",
          direction: "horizontal",
          children: [
            { kind: "terminal", terminalId: "term-1" },
            {
              kind: "split",
              direction: "vertical",
              children: [
                { kind: "terminal", terminalId: "term-2" },
                { kind: "terminal", terminalId: "term-3" },
              ],
            },
          ],
        },
      },
    ];

    expect(reconcileTerminalThreadLayoutGroups(groups, ["term-1", "term-3"])).toEqual([
      {
        id: "group-main",
        terminalIds: ["term-1", "term-3"],
        layout: {
          kind: "split",
          direction: "horizontal",
          children: [
            { kind: "terminal", terminalId: "term-1" },
            { kind: "terminal", terminalId: "term-3" },
          ],
        },
      },
    ]);
  });

  it("returns the existing document when its membership and topology are current", () => {
    expect(reconcileTerminalThreadLayoutGroups(staleGroups, ["term-1", "term-3"])).toBe(
      staleGroups,
    );
  });
});
