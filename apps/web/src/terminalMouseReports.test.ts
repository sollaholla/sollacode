import { routeTerminalInput } from "./terminalMouseReports";
import { describe, expect, it } from "vite-plus/test";

import {
  stripTerminalMouseReports,
  stripTerminalStatusReportReplies,
  stripTerminalUnbuttonedMouseMotionReports,
} from "./terminalMouseReports";

describe("stripTerminalMouseReports", () => {
  it("strips SGR motion and button reports, including batched ones", () => {
    expect(stripTerminalMouseReports("\x1b[<35;48;1M")).toBe("");
    expect(stripTerminalMouseReports("\x1b[<0;10;5M\x1b[<0;10;5m")).toBe("");
    expect(stripTerminalMouseReports("\x1b[<35;30;30M\x1b[<35;23;31M\x1b[<35;19;32M")).toBe("");
  });

  it("strips legacy, URXVT, and focus-tracking reports", () => {
    expect(stripTerminalMouseReports("\x1b[M !!")).toBe("");
    expect(stripTerminalMouseReports("\x1b[35;48;1M")).toBe("");
    expect(stripTerminalMouseReports("\x1b[I")).toBe("");
    expect(stripTerminalMouseReports("\x1b[O")).toBe("");
  });

  it("keeps ordinary keystrokes and control sequences", () => {
    expect(stripTerminalMouseReports("ls -la\r")).toBe("ls -la\r");
    expect(stripTerminalMouseReports("\x1b[A")).toBe("\x1b[A");
    expect(stripTerminalMouseReports("\x1b[1;5C")).toBe("\x1b[1;5C");
    expect(stripTerminalMouseReports("")).toBe("");
  });

  it("keeps surrounding input when a report is embedded", () => {
    expect(stripTerminalMouseReports("a\x1b[<35;48;1Mb")).toBe("ab");
  });
});

describe("stripTerminalUnbuttonedMouseMotionReports", () => {
  it("drops unbuttoned pointer motion across supported mouse protocols", () => {
    expect(stripTerminalUnbuttonedMouseMotionReports("\x1b[<35;48;1M")).toBe("");
    expect(stripTerminalUnbuttonedMouseMotionReports("\x1b[MC!!")).toBe("");
    expect(stripTerminalUnbuttonedMouseMotionReports("\x1b[35;48;1M")).toBe("");
  });

  it("preserves clicks, releases, drags, wheel events, and focus reports", () => {
    const input = "\x1b[<0;10;5M\x1b[<0;10;5m\x1b[<32;11;5M\x1b[<64;11;5M\x1b[I\x1b[O";
    expect(stripTerminalUnbuttonedMouseMotionReports(input)).toBe(input);
  });

  it("keeps surrounding keyboard input while dropping pointer motion", () => {
    expect(stripTerminalUnbuttonedMouseMotionReports("a\x1b[<35;48;1Mb")).toBe("ab");
  });
});

describe("stripTerminalStatusReportReplies", () => {
  it("drops the OSC 4 palette replies a replayed query provokes", () => {
    // Exactly the shape reported from a phone: unfocusing the pane replays
    // the buffer, xterm re-answers the CLI's old colour queries, and the
    // replies are typed into the live prompt.
    const reply = "\x1b]4;1;rgb:f0f0/7171/7878\x1b\\\x1b]4;2;rgb:9898/d2d2/7979\x1b\\";
    expect(stripTerminalStatusReportReplies(reply)).toBe("");
  });

  it("drops BEL-terminated colour replies and the fg/bg/cursor forms", () => {
    expect(stripTerminalStatusReportReplies("\x1b]4;15;rgb:f0f0/f1f1/f5f5\x07")).toBe("");
    expect(stripTerminalStatusReportReplies("\x1b]11;rgb:1c1c/1c1c/1f1f\x1b\\")).toBe("");
  });

  it("drops device-attribute, cursor-position, and mode reports", () => {
    expect(stripTerminalStatusReportReplies("\x1b[?62;22c")).toBe("");
    expect(stripTerminalStatusReportReplies("\x1b[24;80R")).toBe("");
    expect(stripTerminalStatusReportReplies("\x1b[?2026;2$y")).toBe("");
  });

  it("leaves real typing alone, including text that merely looks like a report", () => {
    expect(stripTerminalStatusReportReplies("ls -la\r")).toBe("ls -la\r");
    // Not an escape sequence: a person can legitimately type this.
    expect(stripTerminalStatusReportReplies("]4;1;rgb:f0f0/7171/7878")).toBe(
      "]4;1;rgb:f0f0/7171/7878",
    );
    // Arrow keys share the CSI prefix and must survive.
    expect(stripTerminalStatusReportReplies("\x1b[A\x1b[1;5C")).toBe("\x1b[A\x1b[1;5C");
  });

  it("keeps surrounding input when a reply is embedded in a keystroke burst", () => {
    expect(stripTerminalStatusReportReplies("a\x1b]4;1;rgb:f0f0/7171/7878\x07b")).toBe("ab");
  });
});

describe("shared terminal reply routing", () => {
  it("answers a live query without transferring geometry ownership", () => {
    expect(routeTerminalInput("\x1b[24;80R", { replaying: false, ownsGeometry: true })).toEqual({
      data: "\x1b[24;80R",
      claimsGeometry: false,
    });
    expect(routeTerminalInput("\x1b[>0;276;0c", { replaying: false, ownsGeometry: true })).toEqual({
      data: "\x1b[>0;276;0c",
      claimsGeometry: false,
    });
  });
  it("drops duplicate mirror and replay answers while retaining user input", () => {
    for (const state of [
      { replaying: false, ownsGeometry: false },
      { replaying: true, ownsGeometry: true },
    ]) {
      expect(routeTerminalInput("\x1b[24;80R", state)).toEqual({ data: "", claimsGeometry: false });
      expect(routeTerminalInput("hi\x1b[24;80R\x1b[A", state)).toEqual({
        data: "hi\x1b[A",
        claimsGeometry: true,
      });
    }
  });
});

it("does not transfer geometry on renderer focus reports", () => {
  expect(routeTerminalInput("\x1b[I", { replaying: false, ownsGeometry: false })).toEqual({
    data: "\x1b[I",
    claimsGeometry: false,
  });
});
