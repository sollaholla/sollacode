import { describe, expect, it } from "vite-plus/test";

import type { RightPanelSurface } from "../rightPanelStore";
import { describeRightPanelCloseConfirmation } from "./rightPanelCloseConfirmation";

const browser = (tabId: string): RightPanelSurface => ({
  id: `browser:${tabId}`,
  kind: "preview",
  resourceId: tabId,
});
const terminal = (id: string, terminalIds: string[] = [id]): RightPanelSurface => ({
  id: `terminal:${id}`,
  kind: "terminal",
  resourceId: id,
  terminalIds,
  activeTerminalId: terminalIds[0]!,
});

describe("describeRightPanelCloseConfirmation", () => {
  it("asks before closing a browser tab with a page in it", () => {
    expect(describeRightPanelCloseConfirmation([browser("tab-1")])).toEqual({
      message: "Close this browser tab? The open page is closed.",
      confirmLabel: "Close",
    });
  });

  it("warns that a terminal's process and history are deleted with it", () => {
    expect(describeRightPanelCloseConfirmation([terminal("t1")])?.message).toBe(
      "Close this terminal? Its running processes and history are deleted.",
    );
  });

  it("counts everything a close-others or close-all would take with it", () => {
    expect(
      describeRightPanelCloseConfirmation([
        browser("a"),
        browser("b"),
        terminal("t1", ["x", "y"]),
        { id: "diff", kind: "diff" },
      ])?.message,
    ).toBe(
      "Close 2 browser tabs and 2 terminals? The open pages are closed and their running processes and history are deleted.",
    );
  });

  it("does not ask for tabs that reopen from their source or hold nothing", () => {
    expect(
      describeRightPanelCloseConfirmation([
        { id: "diff", kind: "diff" },
        { id: "files", kind: "files" },
        { id: "plan", kind: "plan" },
        { id: "browser:new", kind: "preview", resourceId: null },
      ]),
    ).toBeNull();
  });
});
