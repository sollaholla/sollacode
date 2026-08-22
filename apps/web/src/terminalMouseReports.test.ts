import { describe, expect, it } from "vite-plus/test";

import {
  stripTerminalMouseReports,
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
