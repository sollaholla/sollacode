import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_TERMINAL_LIST_PREVIEW_CHARS,
  encodeTerminalWrite,
  visibleTerminalText,
} from "./terminalText.ts";

describe("visibleTerminalText", () => {
  it("strips CSI color and leaves the printed text", () => {
    expect(visibleTerminalText("\u001b[31merror\u001b[0m: failed").text).toBe("error: failed");
  });

  it("turns carriage-return overwrites into newlines", () => {
    expect(visibleTerminalText("one\r\ntwo\rthree").text).toBe("one\ntwo\nthree");
  });

  it("keeps the tail when the buffer is longer than the window", () => {
    const result = visibleTerminalText("abcdefghij", 4);
    expect(result).toEqual({ text: "ghij", truncated: true });
  });

  it("keeps the list preview small enough to include on every pane", () => {
    expect(DEFAULT_TERMINAL_LIST_PREVIEW_CHARS).toBeLessThan(2_000);
    expect(DEFAULT_TERMINAL_LIST_PREVIEW_CHARS).toBeGreaterThan(200);
  });
});

describe("encodeTerminalWrite", () => {
  it("appends CR when submit is requested", () => {
    expect(encodeTerminalWrite("ls", true)).toBe("ls\r");
  });

  it("does not double a terminator the caller already typed", () => {
    expect(encodeTerminalWrite("ls\n", true)).toBe("ls\n");
    expect(encodeTerminalWrite("ls\r", true)).toBe("ls\r");
  });

  it("sends a lone CR when submitting an empty line", () => {
    expect(encodeTerminalWrite("", true)).toBe("\r");
    expect(encodeTerminalWrite("", false)).toBe("");
  });
});
