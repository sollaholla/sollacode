// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  applyTerminalViewportPreviewScale,
  canSplitTerminalGroup,
  createMissingTerminalSessionRecovery,
  createTerminalInitialFollowTail,
  createTerminalLayoutScheduler,
  createTerminalReplayOverlayGate,
  fitAndRefreshTerminalViewport,
  hasRenderableTerminalViewportSize,
  isGeometryDriverState,
  isMissingTerminalSessionError,
  isReportablePtyGeometry,
  TERMINAL_GEOMETRY_DRIVER_IDLE_MS,
  TERMINAL_REPLAY_OVERLAY_QUIET_MS,
  TERMINAL_REPLAY_OVERLAY_MAX_SETTLE_MS,
  longestSuffixPrefixOverlap,
  planTerminalResizeSync,
  resolveTerminalSelectionActionPosition,
  shouldHandleTerminalSelectionMouseUp,
  shouldFollowInitialTerminalTail,
  shouldShowInitialTerminalReplayOverlay,
  terminalBufferWritePlan,
  terminalReplayOverlayDisposition,
  terminalSelectionActionDelayForClickCount,
  terminalWriteParsesStaleQueries,
  terminalViewportPreviewScale,
  terminalLayoutChangeClaimsGeometry,
} from "./ThreadTerminalDrawer";

describe("terminal viewport layout", () => {
  it("returns the remeasured grid in the same commit before reporting to the host", () => {
    const terminal = {
      cols: 80,
      rows: 24,
      buffer: { active: { viewportY: 0, baseY: 0 } },
      resize: vi.fn((cols: number, rows: number) => {
        terminal.cols = cols;
        terminal.rows = rows;
      }),
      scrollToBottom: vi.fn(),
    };
    const fitAddon = {
      proposeDimensions: vi
        .fn()
        .mockReturnValueOnce({ cols: 66, rows: 18 })
        .mockReturnValue({ cols: 66, rows: 16 }),
    };
    expect(
      fitAndRefreshTerminalViewport(
        terminal as unknown as Terminal,
        fitAddon as unknown as FitAddon,
      ),
    ).toEqual({ cols: 66, rows: 16 });
    expect(terminal.resize.mock.calls).toEqual([
      [66, 18],
      [66, 16],
    ]);
    expect(terminal.scrollToBottom).toHaveBeenCalledOnce();
  });
  it("starts a remote-view drag from the already scaled raster", () => {
    expect(
      terminalViewportPreviewScale({ width: 400, height: 200 }, { width: 600, height: 200 }, 0.5),
    ).toEqual({ x: 0.75, y: 0.5 });
  });
  it("claims a remote grid only when the local pane changes after user input", () => {
    const input = {
      previous: { width: 800, height: 400 },
      current: { width: 900, height: 400 },
      hasFocus: true,
      lastUserActivityAt: 1_000_000,
      nowMs: 1_000_100,
    };
    expect(terminalLayoutChangeClaimsGeometry(input)).toBe(true);
    // Initial attachment, metadata refresh, a background device and late
    // unrelated layout changes never take ownership from the active device.
    expect(terminalLayoutChangeClaimsGeometry({ ...input, previous: null })).toBe(false);
    expect(terminalLayoutChangeClaimsGeometry({ ...input, current: input.previous })).toBe(false);
    expect(terminalLayoutChangeClaimsGeometry({ ...input, hasFocus: false })).toBe(false);
    expect(terminalLayoutChangeClaimsGeometry({ ...input, nowMs: 1_002_000 })).toBe(false);
    expect(terminalLayoutChangeClaimsGeometry({ ...input, current: { width: 0, height: 0 } })).toBe(
      false,
    );
  });
  it("loads xterm CSS from the app shell instead of the lazy drawer chunk", () => {
    const drawer = NodeFS.readFileSync(
      NodeURL.fileURLToPath(new URL("./ThreadTerminalDrawer.tsx", import.meta.url)),
      "utf8",
    );
    const main = NodeFS.readFileSync(
      NodeURL.fileURLToPath(new URL("../main.tsx", import.meta.url)),
      "utf8",
    );
    expect(drawer).not.toMatch(/@xterm\/xterm\/css\/xterm\.css/);
    expect(main).toMatch(/@xterm\/xterm\/css\/xterm\.css/);
  });

  it("does not fit a hidden terminal down to zero-sized geometry", () => {
    expect(hasRenderableTerminalViewportSize({ width: 900, height: 600 })).toBe(true);
    expect(hasRenderableTerminalViewportSize({ width: 0, height: 600 })).toBe(false);
    expect(hasRenderableTerminalViewportSize({ width: 900, height: 0 })).toBe(false);
  });

  it("never reports a mid-animation degenerate grid to the shared PTY", () => {
    // A 1–2 column resize makes ConPTY rewrap and re-emit its whole buffer
    // as a one-character-per-line stream that is frozen into shared history.
    expect(isReportablePtyGeometry({ cols: 1, rows: 24 })).toBe(false);
    expect(isReportablePtyGeometry({ cols: 80, rows: 2 })).toBe(false);
    expect(isReportablePtyGeometry({ cols: 10, rows: 4 })).toBe(true);
    expect(isReportablePtyGeometry({ cols: 80, rows: 24 })).toBe(true);
  });

  it("only the focused, recently-active client drives PTY geometry", () => {
    const nowMs = 1_000_000;
    // Focused and just interacted: drives.
    expect(
      isGeometryDriverState({ hasFocus: true, lastUserActivityAt: nowMs - 5_000, nowMs }),
    ).toBe(true);
    // Unfocused mirrors never resize the shared PTY, however recent the input.
    expect(isGeometryDriverState({ hasFocus: false, lastUserActivityAt: nowMs, nowMs })).toBe(
      false,
    );
    // A focused-but-idle window (user is on the other machine) stops driving.
    expect(
      isGeometryDriverState({
        hasFocus: true,
        lastUserActivityAt: nowMs - TERMINAL_GEOMETRY_DRIVER_IDLE_MS - 1,
        nowMs,
      }),
    ).toBe(false);
    // Fresh page load with no interaction yet: passive until first input.
    expect(isGeometryDriverState({ hasFocus: true, lastUserActivityAt: 0, nowMs })).toBe(false);
  });

  it("resizes the grid in place without clearing or refreshing the whole screen", () => {
    const terminal = {
      cols: 80,
      rows: 24,
      buffer: { active: { viewportY: 10, baseY: 10 } },
      refresh: vi.fn(),
      resize: vi.fn((cols: number, rows: number) => {
        terminal.cols = cols;
        terminal.rows = rows;
      }),
      scrollToBottom: vi.fn(),
    };
    const fitAddon = {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => ({ cols: 132, rows: 38 })),
    };

    expect(
      fitAndRefreshTerminalViewport(
        terminal as unknown as Terminal,
        fitAddon as unknown as FitAddon,
      ),
    ).toEqual({ cols: 132, rows: 38 });
    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(terminal.resize).toHaveBeenCalledWith(132, 38);
    expect(terminal.refresh).not.toHaveBeenCalled();
    expect(terminal.scrollToBottom).toHaveBeenCalledOnce();
  });

  it("does not refresh or scroll the viewport when fit leaves the grid unchanged", () => {
    const terminal = {
      cols: 80,
      rows: 24,
      buffer: { active: { viewportY: 10, baseY: 10 } },
      refresh: vi.fn(),
      scrollToBottom: vi.fn(),
    };
    const fitAddon = { fit: vi.fn() };

    expect(
      fitAndRefreshTerminalViewport(
        terminal as unknown as Terminal,
        fitAddon as unknown as FitAddon,
      ),
    ).toEqual({ cols: 80, rows: 24 });
    expect(terminal.refresh).not.toHaveBeenCalled();
    expect(terminal.scrollToBottom).not.toHaveBeenCalled();
  });

  it("coalesces resize and activation signals into one repaint frame", () => {
    const pendingFrames = new Map<number, () => void>();
    let nextFrameId = 1;
    const syncLayout = vi.fn();
    const cancel = vi.fn((frameId: number) => pendingFrames.delete(frameId));
    const scheduler = createTerminalLayoutScheduler(syncLayout, {
      request: (callback) => {
        const frameId = nextFrameId++;
        pendingFrames.set(frameId, callback);
        return frameId;
      },
      cancel,
    });

    scheduler.schedule();
    scheduler.schedule();
    expect(pendingFrames.size).toBe(1);
    const firstFrame = pendingFrames.get(1);
    pendingFrames.delete(1);
    firstFrame?.();
    expect(syncLayout).toHaveBeenCalledOnce();

    scheduler.schedule();
    expect(pendingFrames.size).toBe(1);
    scheduler.dispose();
    expect(cancel).toHaveBeenCalledWith(2);
  });

  it("follows initial history to the bottom for a bounded window", () => {
    const intervals = new Map<number, () => void>();
    const timeouts = new Map<number, () => void>();
    let nextTimerId = 1;
    const scrollToBottom = vi.fn();
    const followTail = createTerminalInitialFollowTail(
      scrollToBottom,
      {
        setInterval: (callback) => {
          const timerId = nextTimerId++;
          intervals.set(timerId, callback);
          return timerId;
        },
        clearInterval: (timerId) => intervals.delete(timerId),
        setTimeout: (callback) => {
          const timerId = nextTimerId++;
          timeouts.set(timerId, callback);
          return timerId;
        },
        clearTimeout: (timerId) => timeouts.delete(timerId),
      },
      1_500,
    );

    followTail.start();
    expect(scrollToBottom).toHaveBeenCalledOnce();
    expect(intervals.size).toBe(1);
    intervals.values().next().value?.();
    expect(scrollToBottom).toHaveBeenCalledTimes(2);

    followTail.settle();
    expect(scrollToBottom).toHaveBeenCalledTimes(3);
    timeouts.values().next().value?.();
    expect(intervals.size).toBe(0);

    followTail.dispose();
    followTail.start();
    expect(scrollToBottom).toHaveBeenCalledTimes(3);
  });

  it("commits the first viewport and previews later grid changes", () => {
    expect(
      planTerminalResizeSync({
        hasCommittedViewport: false,
        colsChanged: true,
        rowsChanged: false,
      }),
    ).toBe("commit");
    expect(
      planTerminalResizeSync({
        hasCommittedViewport: true,
        colsChanged: true,
        rowsChanged: true,
      }),
    ).toBe("preview");
    expect(
      planTerminalResizeSync({
        hasCommittedViewport: true,
        colsChanged: false,
        rowsChanged: false,
      }),
    ).toBe("skip");
  });

  it("scales the last raster toward the new pane and clears the preview at identity", () => {
    expect(
      terminalViewportPreviewScale({ width: 800, height: 400 }, { width: 1000, height: 500 }),
    ).toEqual({ x: 1.25, y: 1.25 });
    expect(
      terminalViewportPreviewScale({ width: 800, height: 400 }, { width: 802, height: 401 }),
    ).toBeNull();

    const element = { style: { transform: "", transformOrigin: "", willChange: "" } };
    applyTerminalViewportPreviewScale(element as HTMLElement, { x: 1.25, y: 0.5 });
    expect(element.style.transform).toBe("scale(1.25, 0.5)");
    applyTerminalViewportPreviewScale(element as HTMLElement, null);
    expect(element.style.transform).toBe("");
    expect(element.style.willChange).toBe("");
  });
});

describe("terminalWriteParsesStaleQueries", () => {
  const live = {
    writeKind: "append" as const,
    dataLength: 12,
    previousVersion: 7,
    surfaceVisible: true,
    documentHidden: false,
    visibilityRestorePending: false,
  };

  it("lets a live append to a visible pane answer its queries", () => {
    // Muse Code sends `ESC[6n` and exits when nothing answers within seconds;
    // its reply is emitted while this very chunk is parsed.
    expect(terminalWriteParsesStaleQueries(live)).toBe(false);
  });

  it("treats full replays and the initial attach as already-answered history", () => {
    expect(terminalWriteParsesStaleQueries({ ...live, writeKind: "replace" })).toBe(true);
    expect(terminalWriteParsesStaleQueries({ ...live, previousVersion: 0 })).toBe(true);
  });

  it("treats catch-up while hidden or restoring as history", () => {
    expect(terminalWriteParsesStaleQueries({ ...live, surfaceVisible: false })).toBe(true);
    expect(terminalWriteParsesStaleQueries({ ...live, documentHidden: true })).toBe(true);
    expect(terminalWriteParsesStaleQueries({ ...live, visibilityRestorePending: true })).toBe(true);
  });

  it("never opens a window for an empty write", () => {
    expect(terminalWriteParsesStaleQueries({ ...live, writeKind: "replace", dataLength: 0 })).toBe(
      false,
    );
  });
});

describe("terminalBufferWritePlan", () => {
  it("appends when the new buffer is a prefix extension of the previous one", () => {
    expect(terminalBufferWritePlan("hello", "hello world")).toEqual({
      kind: "append",
      data: " world",
    });
  });

  it("appends the tail after a prefix trim instead of replaying the whole buffer", () => {
    const kept = "BBBB".repeat(40);
    const previous = `${"AAAA".repeat(10)}${kept}`;
    const current = `${kept}${"CCCC".repeat(8)}`;
    expect(longestSuffixPrefixOverlap(previous, current)).toBe(kept.length);
    expect(terminalBufferWritePlan(previous, current)).toEqual({
      kind: "append",
      data: "CCCC".repeat(8),
    });
  });

  it("recovers a large capped-buffer trim as an append via the anchored fast path", () => {
    // Unique per-position content, like real interleaved TUI frames: the
    // anchored overlap must find the exact alignment without a KMP pass.
    const previous = Array.from({ length: 20_000 }, (_, index) => `line-${index};`).join("");
    const appended = "[?25l[H fresh frame [?25h";
    const current = previous.slice(5_000) + appended;
    expect(terminalBufferWritePlan(previous, current)).toEqual({
      kind: "append",
      data: appended,
    });
  });

  it("replaces when the buffers do not share a truncation overlap", () => {
    expect(terminalBufferWritePlan("old prompt $ ", "brand new session\n")).toEqual({
      kind: "replace",
      data: "brand new session\n",
    });
  });

  it("replaces an empty previous buffer with the snapshot", () => {
    expect(terminalBufferWritePlan("", "snapshot")).toEqual({
      kind: "replace",
      data: "snapshot",
    });
  });

  it("follows the initial replay tail without changing live-output scroll position", () => {
    expect(shouldFollowInitialTerminalTail({ previousVersion: 0, currentLength: 120 })).toBe(true);
    expect(shouldFollowInitialTerminalTail({ previousVersion: 4, currentLength: 120 })).toBe(false);
    expect(shouldFollowInitialTerminalTail({ previousVersion: 0, currentLength: 0 })).toBe(false);
  });
});

describe("terminalReplayOverlayDisposition", () => {
  it("keeps the overlay up while the first terminal snapshot is pending", () => {
    expect(
      terminalReplayOverlayDisposition({
        previousVersion: 0,
        currentVersion: 0,
        currentLength: 0,
      }),
    ).toBe("unchanged");
  });

  it("waits for xterm to parse restored history before revealing the pane", () => {
    expect(
      terminalReplayOverlayDisposition({
        previousVersion: 0,
        currentVersion: 1,
        currentLength: 120_000,
      }),
    ).toBe("reveal-after-write");
  });

  it("reveals immediately after an empty initial snapshot", () => {
    expect(
      terminalReplayOverlayDisposition({
        previousVersion: 0,
        currentVersion: 1,
        currentLength: 0,
      }),
    ).toBe("reveal-now");
  });

  it("does not cover subsequent live output", () => {
    expect(
      terminalReplayOverlayDisposition({
        previousVersion: 3,
        currentVersion: 4,
        currentLength: 120_000,
      }),
    ).toBe("unchanged");
  });
});

describe("shouldShowInitialTerminalReplayOverlay", () => {
  it("does not cover a locally-created terminal that has no history to restore", () => {
    expect(shouldShowInitialTerminalReplayOverlay(true)).toBe(false);
  });

  it("covers an existing terminal until retained history has settled", () => {
    expect(shouldShowInitialTerminalReplayOverlay(false)).toBe(true);
  });
});

describe("createTerminalReplayOverlayGate", () => {
  function createHarness() {
    let nextTimerId = 1;
    const timers = new Map<number, { callback: () => void; delayMs: number }>();
    const reveal = vi.fn();
    const gate = createTerminalReplayOverlayGate(
      reveal,
      {
        setTimeout: (callback, delayMs) => {
          const timerId = nextTimerId++;
          timers.set(timerId, { callback, delayMs });
          return timerId;
        },
        clearTimeout: (timerId) => timers.delete(timerId),
      },
      1_500,
      4_000,
    );
    return { gate, reveal, timers };
  }

  it("keeps a pane covered for a quiet window after its initial replay parses", () => {
    const { gate, reveal, timers } = createHarness();
    gate.markInitialReplayParsed();

    expect([...timers.values()].map(({ delayMs }) => delayMs).sort()).toEqual([1_500, 4_000]);
    expect(reveal).not.toHaveBeenCalled();

    const quietTimer = [...timers.entries()].find(([, timer]) => timer.delayMs === 1_500);
    quietTimer?.[1].callback();
    expect(reveal).toHaveBeenCalledOnce();
    expect(timers.size).toBe(0);
  });

  it("restarts the quiet window around per-pane catch-up writes", () => {
    const { gate, reveal, timers } = createHarness();
    gate.markInitialReplayParsed();
    const firstQuietTimerId = [...timers.entries()].find(
      ([, timer]) => timer.delayMs === 1_500,
    )?.[0];

    gate.beginCatchUpWrite();
    expect(firstQuietTimerId === undefined || timers.has(firstQuietTimerId)).toBe(false);
    expect([...timers.values()].map(({ delayMs }) => delayMs)).toEqual([4_000]);

    gate.endCatchUpWrite();
    const nextQuietTimer = [...timers.values()].find((timer) => timer.delayMs === 1_500);
    nextQuietTimer?.callback();
    expect(reveal).toHaveBeenCalledOnce();
  });

  it("tracks output received while hidden before a pane is revealed", () => {
    const { gate, reveal, timers } = createHarness();
    gate.beginCatchUpWrite();
    gate.markInitialReplayParsed();

    expect([...timers.values()].map(({ delayMs }) => delayMs)).toEqual([4_000]);
    gate.endCatchUpWrite();
    expect([...timers.values()].map(({ delayMs }) => delayMs).sort()).toEqual([1_500, 4_000]);

    const quietTimer = [...timers.values()].find((timer) => timer.delayMs === 1_500);
    quietTimer?.callback();
    expect(reveal).toHaveBeenCalledOnce();
  });

  it("reveals at the ceiling when a busy pane never reaches a quiet window", () => {
    const { gate, reveal, timers } = createHarness();
    gate.markInitialReplayParsed();
    gate.beginCatchUpWrite();

    const maxTimer = [...timers.values()].find((timer) => timer.delayMs === 4_000);
    maxTimer?.callback();
    expect(reveal).toHaveBeenCalledOnce();
    expect(timers.size).toBe(0);
  });

  it("does not reveal a disposed pane", () => {
    const { gate, reveal, timers } = createHarness();
    gate.markInitialReplayParsed();
    const callbacks = [...timers.values()].map(({ callback }) => callback);
    gate.dispose();

    callbacks.forEach((callback) => callback());
    expect(reveal).not.toHaveBeenCalled();
  });
});

describe("missing terminal session recovery", () => {
  it("reopens once, refreshes the failed attach, and deduplicates concurrent recovery", async () => {
    let finishReopen: ((reopened: boolean) => void) | undefined;
    const reopen = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishReopen = resolve;
        }),
    );
    const announce = vi.fn();
    const refresh = vi.fn();
    const recovery = createMissingTerminalSessionRecovery({ announce, reopen, refresh });

    const first = recovery.recover();
    const second = recovery.recover();
    expect(first).toBe(second);
    expect(announce).toHaveBeenCalledOnce();
    expect(reopen).toHaveBeenCalledOnce();
    expect(recovery.isActive()).toBe(true);

    finishReopen?.(true);
    await expect(first).resolves.toBe(true);
    expect(refresh).toHaveBeenCalledOnce();
    expect(recovery.isActive()).toBe(true);
    await expect(recovery.recover()).resolves.toBe(true);
    expect(reopen).toHaveBeenCalledOnce();

    recovery.reset();
    expect(recovery.isActive()).toBe(false);
    const third = recovery.recover();
    expect(reopen).toHaveBeenCalledTimes(2);
    finishReopen?.(false);
    await expect(third).resolves.toBe(false);
  });

  it("recognizes only missing-session lookup failures", () => {
    expect(
      isMissingTerminalSessionError("Unknown terminal thread: thread-1, terminal: term-4"),
    ).toBe(true);
    expect(isMissingTerminalSessionError("Terminal write failed")).toBe(false);
    expect(isMissingTerminalSessionError(null)).toBe(false);
  });
});

describe("resolveTerminalSelectionActionPosition", () => {
  it("prefers the selection rect over the last pointer position", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: { right: 260, bottom: 140 },
        pointer: { x: 520, y: 200 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 260,
      y: 144,
    });
  });

  it("falls back to the pointer position when no selection rect is available", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 180, y: 130 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 180,
      y: 130,
    });
  });

  it("clamps the pointer fallback into the terminal drawer bounds", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 720, y: 340 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 600,
      y: 270,
    });

    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 40, y: 20 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 100,
      y: 50,
    });
  });

  it("delays multi-click selection actions so triple-click selection can complete", () => {
    expect(terminalSelectionActionDelayForClickCount(1)).toBe(0);
    expect(terminalSelectionActionDelayForClickCount(2)).toBe(260);
    expect(terminalSelectionActionDelayForClickCount(3)).toBe(260);
  });

  it("only handles mouseup when the selection gesture started in the terminal", () => {
    expect(shouldHandleTerminalSelectionMouseUp(true, 0)).toBe(true);
    expect(shouldHandleTerminalSelectionMouseUp(false, 0)).toBe(false);
    expect(shouldHandleTerminalSelectionMouseUp(true, 1)).toBe(false);
  });
});

describe("right panel terminals", () => {
  // The panel shows one terminal per tab. A split would put a second terminal
  // behind a tab that can only name and close one of them, so the panel turns
  // the capability off rather than hiding the buttons and leaving the shortcut
  // and drag-to-edge paths live.
  it("refuses to split when splitting is turned off, whatever the pane count", () => {
    expect(canSplitTerminalGroup({ allowSplit: false, groupSize: 0 })).toBe(false);
    expect(canSplitTerminalGroup({ allowSplit: false, groupSize: 1 })).toBe(false);
    expect(canSplitTerminalGroup({ allowSplit: false, groupSize: 5 })).toBe(false);
  });

  it("still splits where it is allowed, up to the pane limit", () => {
    expect(canSplitTerminalGroup({ allowSplit: true, groupSize: 1 })).toBe(true);
    expect(canSplitTerminalGroup({ allowSplit: true, groupSize: 5 })).toBe(true);
    // The terminals view keeps its splits; only the ceiling stops it.
    expect(canSplitTerminalGroup({ allowSplit: true, groupSize: 6 })).toBe(false);
  });

  it("mounts the right panel as tabs with splitting off", () => {
    const chatView = NodeFS.readFileSync(
      NodeURL.fileURLToPath(new URL("./ChatView.tsx", import.meta.url)),
      "utf8",
    );
    const mount = chatView.slice(
      chatView.indexOf('<ThreadTerminalDrawerMount\n      mode="panel"'),
    );
    const panelMount = mount.slice(0, mount.indexOf("/>"));
    expect(panelMount).toContain('paneLayout="tabs"');
    expect(panelMount).toContain("allowSplit={false}");
    // The tab list is the thread's terminals, not a per-surface subset: that is
    // what keeps the panel and the terminals view showing the same shells.
    expect(panelMount).toContain("terminalIds={panelTerminalIds}");
  });
});

it("does not hide parsed terminal output behind a multi-second loading delay", () => {
  expect(TERMINAL_REPLAY_OVERLAY_QUIET_MS).toBeLessThanOrEqual(100);
  expect(TERMINAL_REPLAY_OVERLAY_MAX_SETTLE_MS).toBeLessThanOrEqual(500);
});

describe("terminal stream cursor writes", () => {
  const generation = {};
  it("preserves repeated control bytes even when capped text is identical", () => {
    const frame = "\x1b[1B".repeat(32);
    expect(
      terminalBufferWritePlan(frame, frame, {
        previous: { generation, offset: frame.length },
        current: { generation, offset: frame.length + 4 },
      }),
    ).toEqual({ kind: "append", data: "\x1b[1B" });
  });
  it("appends coalesced output after most of the retained buffer was trimmed", () => {
    expect(
      terminalBufferWritePlan("abcdefghij", "ij12345678", {
        previous: { generation, offset: 10 },
        current: { generation, offset: 18 },
      }),
    ).toEqual({ kind: "append", data: "12345678" });
  });
  it("replaces on a new snapshot even when its text shares the old prefix", () => {
    expect(
      terminalBufferWritePlan("abc", "abcdef", {
        previous: { generation, offset: 3 },
        current: { generation: {}, offset: 6 },
      }),
    ).toEqual({ kind: "replace", data: "abcdef" });
  });
});
