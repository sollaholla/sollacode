import type { Terminal } from "@xterm/xterm";

export const CONPTY_CURSOR_SETTLE_MS = 80;

interface CursorPosition {
  x: number;
  y: number;
  buffer: "normal" | "alternate";
}

/** Confirm stray cursor moves at Windows synchronized-frame ends. */
export class ConptyCursorStabilizer {
  private stable: CursorPosition | null = null;
  private pending: { position: CursorPosition; since: number } | null = null;

  reset(): void {
    this.stable = null;
    this.pending = null;
  }

  resolve(input: { position: CursorPosition; framed: boolean; now: number }): {
    position: CursorPosition;
    retryAfter: number | null;
  } {
    const { position, framed, now } = input;
    if (
      !this.stable ||
      !framed ||
      position.buffer !== this.stable.buffer ||
      (position.y === this.stable.y && Math.abs(position.x - this.stable.x) <= 2)
    ) {
      this.stable = position;
      this.pending = null;
      return { position, retryAfter: null };
    }
    if (
      !this.pending ||
      this.pending.position.y !== position.y ||
      this.pending.position.x !== position.x
    ) {
      this.pending = { position, since: now };
    }
    const remaining = CONPTY_CURSOR_SETTLE_MS - (now - this.pending.since);
    if (remaining <= 0) {
      this.stable = position;
      this.pending = null;
      return { position, retryAfter: null };
    }
    return {
      // Text changes (including typing and particles) do not hide the caret.
      // Its next committed position arrives in the unframed ConPTY postamble.
      position: this.stable,
      retryAfter: remaining,
    };
  }
}

interface CursorRenderer {
  renderRows(start: number, end: number): void;
}

// xterm 6.0 has no public cursor-presentation hook. Keep this one synchronous
// renderer boundary isolated and covered by real DOM/WebGL browser checks.
// Parsing, terminal replies, selection and input retain the real buffer state.
interface XtermRenderBoundary {
  _core: {
    _bufferService: { buffer: { x: number; y: number; ybase: number; ydisp: number } };
    coreService: { isCursorHidden: boolean };
    _renderService: {
      _renderer: { value: CursorRenderer | undefined };
      setRenderer(renderer: CursorRenderer): void;
    };
  };
}

/** Stabilize only the painted ConPTY cursor; terminal data is never rewritten. */
export function installConptyCursorStability(
  terminal: Terminal,
  isCodex: () => boolean,
): { dispose(): void; reset(): void } {
  const core = (terminal as unknown as XtermRenderBoundary)._core;
  const service = core._renderService;
  const stabilizer = new ConptyCursorStabilizer();
  const renderers = new Map<CursorRenderer, CursorRenderer["renderRows"]>();
  let inFrame = false;
  let framedCursor = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const cancelTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const reset = () => {
    cancelTimer();
    stabilizer.reset();
    inFrame = false;
    framedCursor = false;
  };
  const commitInputCursor = () => {
    const active = terminal.buffer.active;
    stabilizer.resolve({
      position: { x: active.cursorX, y: active.cursorY, buffer: active.type },
      framed: false,
      now: performance.now(),
    });
    cancelTimer();
  };
  const hooks = [
    ...(["h", "l"] as const).map((final) =>
      terminal.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
        for (const mode of params) {
          if (mode === 2026) {
            inFrame = final === "h";
            if (!inFrame) framedCursor = true;
          }
          if (mode === 25 && final === "h" && !inFrame) {
            framedCursor = false;
            // The next frame may arrive before the browser paints. Remember
            // the real input position now so rapid typing never holds an old one.
            commitInputCursor();
          }
        }
        return false;
      }),
    ),
    ...["H", "f", "A", "B", "C", "D", "E", "F", "G", "d", "`"].map((final) =>
      terminal.parser.registerCsiHandler({ final }, () => {
        if (!inFrame) framedCursor = false;
        return false;
      }),
    ),
    terminal.parser.registerEscHandler({ final: "c" }, () => {
      reset();
      return false;
    }),
    terminal.onResize(reset),
    terminal.buffer.onBufferChange(reset),
    terminal.onWriteParsed(() => {
      if (!inFrame && !framedCursor) commitInputCursor();
    }),
  ];

  const wrapRenderer = (renderer: CursorRenderer | undefined) => {
    if (!renderer || renderers.has(renderer)) return;
    const original = renderer.renderRows;
    renderers.set(renderer, original);
    renderer.renderRows = function (start, end) {
      if (disposed || !isCodex() || terminal.options.windowsPty?.backend !== "conpty") {
        stabilizer.reset();
        cancelTimer();
        return original.call(this, start, end);
      }
      if (core.coreService.isCursorHidden) return original.call(this, start, end);
      const active = terminal.buffer.active;
      const result = stabilizer.resolve({
        position: {
          x: active.cursorX,
          y: active.cursorY,
          buffer: active.type,
        },
        framed: framedCursor,
        now: performance.now(),
      });
      cancelTimer();
      if (result.retryAfter !== null) {
        timer = setTimeout(() => {
          timer = undefined;
          if (!disposed) terminal.refresh(0, terminal.rows - 1);
        }, result.retryAfter);
      }
      const buffer = core._bufferService.buffer;
      const { x, y } = buffer;
      const painted = result.position;
      try {
        buffer.x = painted.x;
        buffer.y = painted.y;
        // Include both cursor rows so DOM and WebGL erase the previous cell.
        const oldRow = buffer.ybase + y - buffer.ydisp;
        const newRow = buffer.ybase + painted.y - buffer.ydisp;
        original.call(
          this,
          Math.max(0, Math.min(start, oldRow, newRow)),
          Math.min(terminal.rows - 1, Math.max(end, oldRow, newRow)),
        );
      } finally {
        buffer.x = x;
        buffer.y = y;
      }
    };
  };
  const originalSetRenderer = service.setRenderer;
  service.setRenderer = function (renderer) {
    wrapRenderer(renderer);
    originalSetRenderer.call(this, renderer);
  };
  wrapRenderer(service._renderer.value);

  return {
    reset,
    dispose() {
      disposed = true;
      cancelTimer();
      hooks.forEach((hook) => hook.dispose());
      service.setRenderer = originalSetRenderer;
      renderers.forEach((original, renderer) => {
        renderer.renderRows = original;
      });
      renderers.clear();
    },
  };
}
