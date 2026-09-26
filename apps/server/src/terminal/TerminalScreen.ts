import headless, { type Terminal, type ITerminalOptions } from "@xterm/headless";
import serialize from "@xterm/addon-serialize/lib/addon-serialize.js";

/** Keeps the parsed screen independently of the byte-capped diagnostic log. */
export class TerminalScreen {
  private readonly terminal: Terminal;
  private readonly serializer = new serialize.SerializeAddon();
  private pending = Promise.resolve();
  private cursorVisible = true;
  private readonly scrollRegions: Record<"normal" | "alternate", [number, number] | null> = {
    normal: null,
    alternate: null,
  };
  private mouseEncoding = 0;
  private cursorStyle = 0;
  private cursorBlink: boolean | null = null;

  constructor(options: ITerminalOptions & { cols: number; rows: number }) {
    this.terminal = new headless.Terminal({ ...options, allowProposedApi: true });
    this.serializer.activate(this.terminal);
    this.terminal.buffer.onBufferChange((buffer) => {
      if (buffer.type === "normal") this.scrollRegions.alternate = null;
    });
    for (const final of ["h", "l"]) {
      this.terminal.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
        for (const mode of params) {
          if (mode === 25) this.cursorVisible = final === "h";
          if (mode === 12) this.cursorBlink = final === "h";
          if (mode === 1006 || mode === 1016) {
            this.mouseEncoding = final === "h" ? mode : 0;
          }
        }
        return false;
      });
    }
    this.terminal.parser.registerCsiHandler({ final: "r" }, (params) => {
      const top = Math.max(Number(params[0]) || 1, 1);
      const bottom = Math.min(Number(params[1]) || this.terminal.rows, this.terminal.rows);
      if (bottom > top) this.scrollRegions[this.terminal.buffer.active.type] = [top, bottom];
      return false;
    });
    this.terminal.parser.registerCsiHandler({ intermediates: " ", final: "q" }, (params) => {
      const style = Number(params[0]) || 0;
      if (style <= 6) this.cursorStyle = style;
      return false;
    });
    this.terminal.parser.registerEscHandler({ final: "c" }, () => {
      this.cursorVisible = true;
      this.clearScrollRegions();
      this.mouseEncoding = 0;
      this.cursorStyle = 0;
      return false;
    });
  }

  private clearScrollRegions(): void {
    this.scrollRegions.normal = null;
    this.scrollRegions.alternate = null;
  }

  write(data: string): Promise<void> {
    if (!data) return this.pending;
    this.pending = this.pending.then(
      () => new Promise<void>((resolve) => this.terminal.write(data, resolve)),
    );
    return this.pending;
  }

  resize(cols: number, rows: number): void {
    this.pending = this.pending.then(() => {
      this.terminal.resize(cols, rows);
      this.clearScrollRegions();
    });
  }

  reset(): void {
    this.pending = this.pending.then(() => {
      this.terminal.reset();
      this.cursorVisible = true;
      this.clearScrollRegions();
      this.mouseEncoding = 0;
      this.cursorStyle = 0;
    });
  }

  /** Capture in stream order, before any writes queued after this call. Never cut ANSI bytes. */
  capture(maxBytes: number): Promise<{ data: string; cols: number; rows: number }> {
    const capture = this.pending.then(() => {
      let scrollback = this.terminal.buffer.normal.baseY;
      let data = this.serializer.serialize({ scrollback });
      while (scrollback > 0 && Buffer.byteLength(data, "utf8") > maxBytes) {
        scrollback = Math.floor(scrollback / 2);
        data = this.serializer.serialize({ scrollback });
      }
      const buffer = this.terminal.buffer.active;
      const scrollRegion = this.scrollRegions[buffer.type];
      // The normal buffer retains its own margins while a TUI uses the
      // alternate buffer. Install them before the serializer switches buffers.
      if (buffer.type === "alternate" && this.scrollRegions.normal) {
        const [top, bottom] = this.scrollRegions.normal;
        data = data.replace("\x1b[?1049h", `\x1b7\x1b[${top};${bottom}r\x1b8\x1b[?1049h`);
      }
      // Both margins and origin mode home the cursor. Restore its absolute
      // position after the modes, translating CUP to origin-relative rows.
      if (scrollRegion || this.terminal.modes.originMode) {
        data += "\x1b[?6l";
        if (scrollRegion) {
          const [top, bottom] = scrollRegion;
          data += `\x1b[${top};${bottom}r`;
        }
        const origin = this.terminal.modes.originMode;
        if (origin) data += "\x1b[?6h";
        const row = buffer.cursorY + 1 - (origin ? (scrollRegion?.[0] ?? 1) - 1 : 0);
        data += `\x1b[${row};${buffer.cursorX + 1}H`;
      }
      data += this.cursorVisible ? "\x1b[?25h" : "\x1b[?25l";
      if (this.cursorBlink !== null) data += `\x1b[?12${this.cursorBlink ? "h" : "l"}`;
      data += `\x1b[${this.cursorStyle} q`;
      if (this.mouseEncoding) data += `\x1b[?${this.mouseEncoding}h`;
      if (this.terminal.modes.synchronizedOutputMode) data += "\x1b[?2026h";
      return { data, cols: this.terminal.cols, rows: this.terminal.rows };
    });
    this.pending = capture.then(() => undefined);
    return capture;
  }

  dispose(): void {
    this.pending = this.pending.then(() => {
      this.serializer.dispose();
      this.terminal.dispose();
    });
  }
}
