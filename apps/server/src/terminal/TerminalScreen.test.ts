import { Terminal } from "@xterm/headless";
import { describe, expect, it } from "vite-plus/test";
import { TerminalScreen } from "./TerminalScreen.ts";

const write = (terminal: Terminal, data: string) =>
  new Promise<void>((resolve) => terminal.write(data, resolve));

function cells(terminal: Terminal) {
  const buffer = terminal.buffer.active;
  return Array.from({ length: terminal.rows }, (_, row) => {
    const line = buffer.getLine(buffer.baseY + row);
    return Array.from({ length: terminal.cols }, (_, col) => {
      const cell = line?.getCell(col);
      return [cell?.getChars(), cell?.getFgColor(), cell?.getBgColor(), cell?.getWidth()];
    });
  });
}

describe("TerminalScreen", () => {
  it("does not carry normal-screen margins into the alternate screen", async () => {
    const options = { cols: 24, rows: 8, allowProposedApi: true };
    const screen = new TerminalScreen(options);
    const live = new Terminal(options);
    const viewer = new Terminal(options);
    try {
      const initial = "\x1b[2;5r\x1b[?1049h\x1b[Hready";
      await Promise.all([screen.write(initial), write(live, initial)]);
      await write(viewer, (await screen.capture(4096)).data);
      const next = "\x1b[8;1Hbottom\r\nnext";
      await Promise.all([write(live, next), write(viewer, next)]);
      expect(cells(viewer)).toEqual(cells(live));
    } finally {
      screen.dispose();
      live.dispose();
      viewer.dispose();
    }
  });

  it("continues drawing with the same margins, origin, input modes and cursor", async () => {
    const options = { cols: 24, rows: 8, allowProposedApi: true };
    const screen = new TerminalScreen(options);
    const live = new Terminal(options);
    const viewer = new Terminal(options);
    try {
      const initial =
        "header\x1b[2;7r\x1b[?6h\x1b[?1h\x1b[?2004h\x1b[?1004h\x1b[?1002h\x1b[?1006h\x1b[?25l\x1b[3;4H\x1b[32m界🙂 ready";
      await Promise.all([screen.write(initial), write(live, initial)]);
      await write(viewer, (await screen.capture(4096)).data);
      expect(cells(viewer)).toEqual(cells(live));
      expect(viewer.buffer.active.cursorX).toBe(live.buffer.active.cursorX);
      expect(viewer.buffer.active.cursorY).toBe(live.buffer.active.cursorY);
      expect(viewer.modes).toEqual(live.modes);
      const next = "\x1b[6;1Hnext\r\nscroll\x1b[2;3H!";
      await Promise.all([write(live, next), write(viewer, next)]);
      expect(cells(viewer)).toEqual(cells(live));
      expect(viewer.buffer.active.cursorX).toBe(live.buffer.active.cursorX);
      expect(viewer.buffer.active.cursorY).toBe(live.buffer.active.cursorY);
    } finally {
      screen.dispose();
      live.dispose();
      viewer.dispose();
    }
  });

  it("restores incremental TUI cells and cursor after the raw history has rolled over", async () => {
    const options = { cols: 60, rows: 12, scrollback: 50, allowProposedApi: true };
    const screen = new TerminalScreen(options);
    const live = new Terminal(options);
    const viewer = new Terminal(options);
    try {
      const initial =
        "\x1b[?1049h\x1b[2J\x1b[H\x1b[38;2;90;180;230mCodex terminal\x1b[0m\x1b[10;1H> ";
      screen.write(initial);
      await write(live, initial);
      for (let i = 0; i < 300; i++) {
        const frame = `\x1b[5;1H\x1b[2Kworking ${i}\x1b[10;3H`;
        screen.write(frame);
        await write(live, frame);
      }
      const snapshot = await screen.capture(512);
      await write(viewer, snapshot.data);
      expect(cells(viewer)).toEqual(cells(live));
      expect(viewer.buffer.active.cursorX).toBe(live.buffer.active.cursorX);
      expect(viewer.buffer.active.cursorY).toBe(live.buffer.active.cursorY);
      expect(viewer.buffer.active.type).toBe("alternate");
      expect(snapshot.data).not.toContain("working 298");
      expect(snapshot.data.length).toBeLessThan(512);
    } finally {
      screen.dispose();
      live.dispose();
      viewer.dispose();
    }
  });

  it("captures before later output and preserves split color commands", async () => {
    const screen = new TerminalScreen({ cols: 40, rows: 8 });
    screen.write("\x1b[38;2;90;");
    screen.write("180;230mfirst\x1b[?25l\x1b[?1006h\x1b[?1000h\x1b[6 q\x1b[?2026h");
    const first = screen.capture(4096);
    screen.write("\r\x1b[2Ksecond\x1b[?25h\x1b[?2026l");
    const second = screen.capture(4096);
    expect((await first).data).toContain("first");
    expect((await first).data).not.toContain("second");
    expect((await first).data).toContain("\x1b[?25l");
    expect((await first).data).toContain("\x1b[?1006h");
    expect((await first).data).toContain("\x1b[6 q");
    expect((await first).data).toContain("\x1b[?2026h");
    expect((await second).data).toContain("second");
    expect((await second).data).toContain("\x1b[?25h");
    expect((await second).data).not.toContain("\x1b[?2026h");
    screen.dispose();
  });

  it("orders resize with output and retains a complete colored viewport at a small budget", async () => {
    const screen = new TerminalScreen({ cols: 60, rows: 12, scrollback: 100 });
    screen.write("\x1b[31mold log\r\n".repeat(150));
    screen.resize(40, 8);
    screen.write("\x1b[?1049h\x1b[2J\x1b[H\x1b[32mready\x1b[8;3H");
    const snapshot = await screen.capture(256);
    expect(snapshot.cols).toBe(40);
    expect(snapshot.rows).toBe(8);
    const viewer = new Terminal({ cols: 40, rows: 8, allowProposedApi: true });
    await write(viewer, snapshot.data);
    expect(viewer.buffer.active.getLine(0)?.translateToString(true)).toBe("ready");
    expect(viewer.buffer.active.cursorY).toBe(7);
    expect(viewer.buffer.active.cursorX).toBe(2);
    screen.reset();
    expect((await screen.capture(4096)).data).not.toContain("ready");
    viewer.dispose();
    screen.dispose();
  });
});
