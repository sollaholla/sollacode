import { useAtomValue } from "@effect/atom-react";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

import {
  stripTerminalMouseReports,
  stripTerminalUnbuttonedMouseMotionReports,
} from "../terminalMouseReports";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  BanIcon,
  FilesIcon,
  Globe,
  Maximize2Icon,
  Minimize2Icon,
  Plus,
  SquareSplitHorizontal,
  SquareSplitVertical,
  Trash2,
  XIcon,
} from "lucide-react";
import {
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import { Terminal, type ITheme } from "@xterm/xterm";
import {
  type DragEvent as ReactDragEvent,
  Fragment,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { useOpenInPreferredEditor } from "../editorPreferences";
import {
  collectWrappedTerminalLinkLine,
  extractTerminalLinks,
  isTerminalLinkActivation,
  resolvePathLinkTarget,
  resolveWrappedTerminalLinkRange,
  wrappedTerminalLinkRangeIntersectsBufferLine,
} from "../terminal-links";
import {
  isDiffToggleShortcut,
  isTerminalClearShortcut,
  isTerminalCloseShortcut,
  isTerminalNewShortcut,
  isTerminalSplitShortcut,
  isTerminalSplitVerticalShortcut,
  isTerminalToggleShortcut,
  terminalDeleteShortcutData,
  terminalNavigationShortcutData,
} from "../keybindings";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  isBrowserPaneId,
  MAX_TERMINALS_PER_GROUP,
  type TerminalPaneLayout,
  type ThreadTerminalGroup,
} from "../types";
import {
  layoutLeafIds,
  listDropPlacementForPoint,
  MIN_PANE_FRACTION,
  normalizeGroupLayout,
  type ListDropPlacement,
  type PaneDropZone,
  paneDropZoneForPoint,
} from "../terminalPaneLayout";
import { readLocalApi } from "~/localApi";
import { clientOwnsTerminalGeometry, terminalClientId } from "../terminalClientIdentity";
import { useAttachedTerminalSession, useKnownTerminalSessions } from "../state/terminalSessions";
import { TerminalSessionIcon } from "./chat/TerminalSessionIcon";
import {
  emptyTerminalDictationState,
  resolveTerminalDictationInput,
  type TerminalDictationState,
} from "./terminal/dictationInput";
import { TerminalMobileKeyBar } from "./terminal/TerminalMobileKeyBar";
import { resolveTerminalKeyboardInset } from "./terminal/terminalKeyboardInset";
import { TerminalLaunchPad, type TerminalLaunchProvider } from "./terminal/TerminalLaunchPad";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { terminalCommandProviderDriver } from "@t3tools/shared/terminalProvider";
import { serverEnvironment } from "../state/server";
import { previewEnvironment } from "../state/preview";
import { terminalEnvironment } from "../state/terminal";
import {
  DEFAULT_TERMINAL_SIDEBAR_WIDTH,
  MAX_TERMINAL_SIDEBAR_WIDTH,
  MIN_TERMINAL_SIDEBAR_WIDTH,
  type TerminalGroupListPlacement,
  type TerminalSidebarPlacement,
  useTerminalUiStateStore,
} from "../terminalUiStateStore";
import { openTerminalLinkInPreview } from "./preview/openTerminalLinkInPreview";
import { useAtomCommand } from "../state/use-atom-command";
import {
  canResolveOsFilePaths,
  classifyTerminalFileDrop,
  collectTerminalDropInput,
  resolveOsFilePath,
  TERMINAL_GROUP_DRAG_MIME,
  TERMINAL_PANE_DRAG_MIME,
  terminalFileDropPreviewsEqual,
  type TerminalFileDropPreview,
} from "../lib/terminalFileDrop";

const MIN_DRAWER_HEIGHT = 180;
const MAX_DRAWER_HEIGHT_RATIO = 0.75;
const MULTI_CLICK_SELECTION_ACTION_DELAY_MS = 260;
const EMPTY_TERMINAL_IDS: readonly string[] = [];
/**
 * Quiet window after the last viewport change before the cell grid and PTY
 * are committed. While the burst is in flight the last raster is CSS-scaled
 * to the new pane so WebGL does not clear on every divider tick.
 */
export const TERMINAL_PTY_RESIZE_SETTLE_MS = 100;
/**
 * Same-geometry PTY nudges within this window are skipped. Attach, reveal,
 * and window-focus all ask for a SIGWINCH; without a cooldown they stack
 * into a resize loop that fullscreen programs cannot catch up with.
 */
export const TERMINAL_PTY_NUDGE_COOLDOWN_MS = 1000;
/**
 * A pane that received live output this recently is repainting itself, so a
 * reveal/focus nudge must not walk the PTY through a detour: each SIGWINCH
 * makes a fullscreen TUI re-init (mouse modes + 2J clear + full repaint),
 * which smears across delivery ticks as visible flicker with the cursor
 * sweeping home → frame → input box. Only a first attach onto frozen
 * replayed history, or a long-idle frame, still needs the forced repaint.
 */
export const TERMINAL_LIVE_OUTPUT_NUDGE_SKIP_MS = 10_000;
/**
 * Initial history is parsed by xterm asynchronously. Keep the viewport pinned
 * briefly while that replay drains, then hand scroll ownership back to the
 * user. The write-complete callback performs one final authoritative scroll.
 */
export const TERMINAL_INITIAL_FOLLOW_TAIL_MS = 1_500;
export const TERMINAL_INITIAL_FOLLOW_TAIL_TICK_MS = 50;
/**
 * Replayed history can provoke one more PTY repaint after xterm finishes
 * parsing the retained buffer. Keep each pane covered until those follow-up
 * writes have been quiet for this long, with a ceiling for busy sessions.
 */
export const TERMINAL_REPLAY_OVERLAY_QUIET_MS = 1_500;
export const TERMINAL_REPLAY_OVERLAY_MAX_SETTLE_MS = 4_000;

export function shouldDetourPtyOnNudge(input: {
  force: boolean;
  nowMs: number;
  lastLiveOutputAtMs: number;
}): boolean {
  return (
    input.force || input.nowMs - input.lastLiveOutputAtMs >= TERMINAL_LIVE_OUTPUT_NUDGE_SKIP_MS
  );
}
/**
 * Resets xterm's mouse/focus tracking modes locally (never sent to the PTY).
 * Replayed bytes can leave tracking enabled after the program that wanted it
 * is gone, which makes xterm type mouse reports into the shell as garbage.
 */
const TERMINAL_STALE_TRACKING_RESET =
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l";
function dataTransferHasType(types: readonly string[], mime: string): boolean {
  return types.includes(mime);
}

type SidebarDropTarget =
  | {
      kind: "terminal";
      groupId: string;
      terminalId: string;
      placement: ListDropPlacement;
    }
  | {
      kind: "group";
      groupId: string;
      placement: ListDropPlacement | "into";
    };

function SidebarDropLine({ placement }: { placement: ListDropPlacement }) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-primary",
        placement === "before" ? "top-0" : "bottom-0",
      )}
    />
  );
}

function maxDrawerHeight(): number {
  if (typeof window === "undefined") return DEFAULT_THREAD_TERMINAL_HEIGHT;
  return Math.max(MIN_DRAWER_HEIGHT, Math.floor(window.innerHeight * MAX_DRAWER_HEIGHT_RATIO));
}

function clampDrawerHeight(height: number): number {
  const safeHeight = Number.isFinite(height) ? height : DEFAULT_THREAD_TERMINAL_HEIGHT;
  const maxHeight = maxDrawerHeight();
  return Math.min(Math.max(Math.round(safeHeight), MIN_DRAWER_HEIGHT), maxHeight);
}

function writeSystemMessage(terminal: Terminal, message: string): void {
  terminal.write(`\r\n[terminal] ${message}\r\n`);
}

function writeTerminalBuffer(terminal: Terminal, buffer: string, onParsed?: () => void): void {
  // reset() clears the surface and tracking modes without the RIS flash of
  // writing `\u001bc` as a PTY chunk (that briefly shows an empty frame).
  terminal.reset();
  if (buffer.length > 0) {
    terminal.write(buffer, onParsed);
  } else {
    onParsed?.();
  }
}

function fitTerminalSafely(fitAddon: FitAddon): boolean {
  try {
    fitAddon.fit();
    return true;
  } catch {
    return false;
  }
}

function proposeTerminalDimensions(fitAddon: FitAddon): { cols: number; rows: number } | null {
  try {
    const proposed = fitAddon.proposeDimensions();
    if (!proposed || proposed.cols < 1 || proposed.rows < 1) {
      return null;
    }
    if (!Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) {
      return null;
    }
    return { cols: proposed.cols, rows: proposed.rows };
  } catch {
    return null;
  }
}

export function fitAndRefreshTerminalViewport(
  terminal: Terminal,
  fitAddon: FitAddon,
): { cols: number; rows: number } | null {
  const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
  const previousCols = terminal.cols;
  const previousRows = terminal.rows;
  const proposed = proposeTerminalDimensions(fitAddon);
  if (proposed) {
    if (proposed.cols !== terminal.cols || proposed.rows !== terminal.rows) {
      try {
        // FitAddon.fit() clears the renderer before resize, which flashes a
        // blank frame on every divider tick. resize() updates the grid in
        // place and lets the current buffer paint into the new canvas.
        terminal.resize(proposed.cols, proposed.rows);
      } catch {
        if (!fitTerminalSafely(fitAddon)) {
          return null;
        }
      }
    }
  } else if (!fitTerminalSafely(fitAddon)) {
    return null;
  }
  const geometryChanged = terminal.cols !== previousCols || terminal.rows !== previousRows;
  if (wasAtBottom && geometryChanged) {
    terminal.scrollToBottom();
  }
  return terminal.cols > 0 && terminal.rows > 0
    ? { cols: terminal.cols, rows: terminal.rows }
    : null;
}

/**
 * Smallest geometry worth reporting to the shared PTY. Split and drawer
 * animations pass through near-zero panes, and committing those transient
 * sizes is destructive on Windows: ConPTY rewraps its entire buffer to the
 * new width and re-emits it, so a 1–2 column resize turns the whole
 * scrollback into a one-character-per-line stream that is then frozen into
 * shared history. Below the floor the local grid still fits the pane; the
 * PTY just keeps its last sane size until layout settles.
 */
export const MIN_REPORTABLE_PTY_COLS = 10;
export const MIN_REPORTABLE_PTY_ROWS = 4;

export function isReportablePtyGeometry(geometry: { cols: number; rows: number }): boolean {
  return geometry.cols >= MIN_REPORTABLE_PTY_COLS && geometry.rows >= MIN_REPORTABLE_PTY_ROWS;
}

/**
 * How long after the user's last interaction this window may keep driving
 * the shared PTY's geometry. The PTY is shared by every client viewing the
 * thread; if all of them fit-and-report their own pane, the last writer
 * wins and every other viewer renders a mismatched grid — full-screen
 * programs then overprint garbage (their absolute cursor addresses assume
 * the PTY's grid). So only the client the user is actually using resizes;
 * everyone else adopts the server-reported grid and scales it to fit.
 */
export const TERMINAL_GEOMETRY_DRIVER_IDLE_MS = 30_000;

export function isGeometryDriverState(input: {
  hasFocus: boolean;
  lastUserActivityAt: number;
  nowMs: number;
}): boolean {
  return (
    input.hasFocus && input.nowMs - input.lastUserActivityAt <= TERMINAL_GEOMETRY_DRIVER_IDLE_MS
  );
}

let terminalUserActivityAt = 0;
let terminalUserActivityTrackingInstalled = false;

function ensureTerminalUserActivityTracking(): void {
  if (terminalUserActivityTrackingInstalled || typeof window === "undefined") {
    return;
  }
  terminalUserActivityTrackingInstalled = true;
  const record = () => {
    terminalUserActivityAt = Date.now();
  };
  window.addEventListener("keydown", record, { capture: true, passive: true });
  window.addEventListener("pointerdown", record, { capture: true, passive: true });
  window.addEventListener("wheel", record, { capture: true, passive: true });
}

function clientIsGeometryDriver(): boolean {
  return isGeometryDriverState({
    hasFocus: typeof document !== "undefined" && document.hasFocus(),
    lastUserActivityAt: terminalUserActivityAt,
    nowMs: Date.now(),
  });
}

export type TerminalResizeSyncPlan = "skip" | "commit" | "preview";

export function planTerminalResizeSync(input: {
  hasCommittedViewport: boolean;
  colsChanged: boolean;
  rowsChanged: boolean;
}): TerminalResizeSyncPlan {
  if (!input.colsChanged && !input.rowsChanged) {
    return "skip";
  }
  return input.hasCommittedViewport ? "preview" : "commit";
}

export function terminalViewportPreviewScale(
  fitted: { width: number; height: number },
  current: { width: number; height: number },
): { x: number; y: number } | null {
  if (fitted.width <= 0 || fitted.height <= 0 || current.width <= 0 || current.height <= 0) {
    return null;
  }
  const x = current.width / fitted.width;
  const y = current.height / fitted.height;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  if (Math.abs(x - 1) < 0.01 && Math.abs(y - 1) < 0.01) {
    return null;
  }
  return { x, y };
}

export function applyTerminalViewportPreviewScale(
  element: HTMLElement,
  scale: { x: number; y: number } | null,
): void {
  if (scale === null) {
    element.style.transform = "";
    element.style.willChange = "";
    return;
  }
  element.style.transformOrigin = "0 0";
  element.style.willChange = "transform";
  element.style.transform = `scale(${scale.x}, ${scale.y})`;
}

export type TerminalBufferWritePlan =
  | { kind: "append"; data: string }
  | { kind: "replace"; data: string };

function kmpLongestPrefixSuffix(pattern: string): number[] {
  const lps = Array.from({ length: pattern.length }, () => 0);
  let length = 0;
  let i = 1;
  while (i < pattern.length) {
    if (pattern[i] === pattern[length]) {
      length += 1;
      lps[i] = length;
      i += 1;
    } else if (length > 0) {
      length = lps[length - 1] ?? 0;
    } else {
      lps[i] = 0;
      i += 1;
    }
  }
  return lps;
}

/**
 * Longest suffix of `left` that is a prefix of `right`. Used to recover the
 * overlap after the client trims a prefix off the live PTY history.
 */
export function longestSuffixPrefixOverlap(left: string, right: string): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const lps = kmpLongestPrefixSuffix(right);
  let matched = 0;
  const start = Math.max(0, left.length - right.length);
  for (let i = start; i < left.length; ) {
    if (left[i] === right[matched]) {
      i += 1;
      matched += 1;
      if (matched === right.length) {
        return right.length;
      }
    } else if (matched > 0) {
      matched = lps[matched - 1] ?? 0;
    } else {
      i += 1;
    }
  }
  return matched;
}

const MIN_TRUNCATION_OVERLAP_CHARS = 32;
const OVERLAP_ANCHOR_CHARS = 64;
const MAX_OVERLAP_ANCHOR_ATTEMPTS = 8;

/**
 * Fast path for the steady state at the history byte cap: `right` is `left`
 * with some prefix trimmed off plus a small appended tail, so anchoring
 * `right`'s first characters inside `left` and verifying the overlap directly
 * avoids building a KMP table over the whole capped buffer on every output
 * chunk. Returns the same longest overlap KMP would find whenever that
 * overlap is at least the anchor length and verifies within the attempt
 * budget; returns null (caller falls back to KMP) otherwise.
 */
function anchoredSuffixPrefixOverlap(left: string, right: string): number | null {
  if (right.length < OVERLAP_ANCHOR_CHARS) {
    return null;
  }
  const needle = right.slice(0, OVERLAP_ANCHOR_CHARS);
  let from = Math.max(0, left.length - right.length);
  for (let attempt = 0; attempt < MAX_OVERLAP_ANCHOR_ATTEMPTS; attempt += 1) {
    const at = left.indexOf(needle, from);
    if (at < 0) {
      return null;
    }
    if (right.startsWith(left.slice(at))) {
      return left.length - at;
    }
    from = at + 1;
  }
  return null;
}

/**
 * Decide whether the next xterm write is a live tail or a true reset.
 *
 * Client history is byte-capped from the start. Treating that trim as a
 * full rewrite replays hundreds of kilobytes of TUI frames (often starting
 * mid-escape-sequence) and is what made the viewport flicker and show
 * garbage at the top.
 */
export function terminalBufferWritePlan(
  previous: string,
  current: string,
): TerminalBufferWritePlan {
  if (current === previous) {
    return { kind: "append", data: "" };
  }
  if (previous.length === 0 || current.length === 0) {
    return { kind: "replace", data: current };
  }
  if (current.startsWith(previous)) {
    return { kind: "append", data: current.slice(previous.length) };
  }
  const overlap =
    anchoredSuffixPrefixOverlap(previous, current) ?? longestSuffixPrefixOverlap(previous, current);
  const minLength = Math.min(previous.length, current.length);
  if (overlap >= MIN_TRUNCATION_OVERLAP_CHARS && overlap * 2 >= minLength) {
    return { kind: "append", data: current.slice(overlap) };
  }
  return { kind: "replace", data: current };
}

export function shouldNudgePtyAfterBufferWrite(input: {
  previousVersion: number;
  currentLength: number;
}): boolean {
  return input.previousVersion === 0 && input.currentLength > 0;
}

export function terminalReplayOverlayDisposition(input: {
  previousVersion: number;
  currentVersion: number;
  currentLength: number;
}): "unchanged" | "reveal-now" | "reveal-after-write" {
  if (input.previousVersion !== 0 || input.currentVersion === 0) {
    return "unchanged";
  }
  return input.currentLength > 0 ? "reveal-after-write" : "reveal-now";
}

export function shouldShowInitialTerminalReplayOverlay(locallyOpening: boolean): boolean {
  return !locallyOpening;
}

interface TerminalReplayOverlayTimerApi {
  setTimeout: (callback: () => void, delayMs: number) => number;
  clearTimeout: (timeoutId: number) => void;
}

export function createTerminalReplayOverlayGate(
  reveal: () => void,
  timerApi: TerminalReplayOverlayTimerApi,
  quietMs = TERMINAL_REPLAY_OVERLAY_QUIET_MS,
  maxSettleMs = TERMINAL_REPLAY_OVERLAY_MAX_SETTLE_MS,
): {
  markInitialReplayParsed: () => void;
  beginCatchUpWrite: () => void;
  endCatchUpWrite: () => void;
  revealImmediately: () => void;
  dispose: () => void;
} {
  let quietTimeoutId: number | null = null;
  let maxTimeoutId: number | null = null;
  let pendingCatchUpWrites = 0;
  let initialReplayParsed = false;
  let finished = false;

  const clearQuietTimeout = () => {
    if (quietTimeoutId === null) return;
    timerApi.clearTimeout(quietTimeoutId);
    quietTimeoutId = null;
  };
  const clearTimers = () => {
    clearQuietTimeout();
    if (maxTimeoutId !== null) {
      timerApi.clearTimeout(maxTimeoutId);
      maxTimeoutId = null;
    }
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimers();
    reveal();
  };
  const armQuietWindow = () => {
    if (finished || !initialReplayParsed || pendingCatchUpWrites > 0) return;
    clearQuietTimeout();
    quietTimeoutId = timerApi.setTimeout(finish, quietMs);
  };

  return {
    markInitialReplayParsed: () => {
      if (finished || initialReplayParsed) return;
      initialReplayParsed = true;
      maxTimeoutId = timerApi.setTimeout(finish, maxSettleMs);
      armQuietWindow();
    },
    beginCatchUpWrite: () => {
      if (finished) return;
      pendingCatchUpWrites += 1;
      clearQuietTimeout();
    },
    endCatchUpWrite: () => {
      if (finished) return;
      pendingCatchUpWrites = Math.max(0, pendingCatchUpWrites - 1);
      armQuietWindow();
    },
    revealImmediately: finish,
    dispose: () => {
      if (finished) return;
      finished = true;
      clearTimers();
    },
  };
}

export function hasRenderableTerminalViewportSize(size: {
  width: number;
  height: number;
}): boolean {
  return size.width > 0 && size.height > 0;
}

interface TerminalLayoutFrameApi {
  request: (callback: () => void) => number;
  cancel: (frameId: number) => void;
}

interface TerminalFollowTailTimerApi {
  setInterval: (callback: () => void, delayMs: number) => number;
  clearInterval: (intervalId: number) => void;
  setTimeout: (callback: () => void, delayMs: number) => number;
  clearTimeout: (timeoutId: number) => void;
}

export function createTerminalInitialFollowTail(
  scrollToBottom: () => void,
  timerApi: TerminalFollowTailTimerApi,
  durationMs = TERMINAL_INITIAL_FOLLOW_TAIL_MS,
): { start: () => void; settle: () => void; dispose: () => void } {
  let intervalId: number | null = null;
  let timeoutId: number | null = null;
  let disposed = false;

  const stop = () => {
    if (intervalId !== null) {
      timerApi.clearInterval(intervalId);
      intervalId = null;
    }
    timeoutId = null;
  };

  return {
    start: () => {
      if (disposed) return;
      scrollToBottom();
      if (intervalId === null) {
        intervalId = timerApi.setInterval(scrollToBottom, TERMINAL_INITIAL_FOLLOW_TAIL_TICK_MS);
      }
      if (timeoutId !== null) {
        timerApi.clearTimeout(timeoutId);
      }
      timeoutId = timerApi.setTimeout(stop, durationMs);
    },
    settle: () => {
      if (!disposed) scrollToBottom();
    },
    dispose: () => {
      disposed = true;
      if (timeoutId !== null) {
        timerApi.clearTimeout(timeoutId);
        timeoutId = null;
      }
      stop();
    },
  };
}

export function isMissingTerminalSessionError(message: string | null): boolean {
  return message?.includes("Unknown terminal thread") === true;
}

export function createMissingTerminalSessionRecovery(options: {
  announce: () => void;
  reopen: () => Promise<boolean>;
  refresh: () => void;
}): {
  recover: () => Promise<boolean>;
  isActive: () => boolean;
  reset: () => void;
  dispose: () => void;
} {
  let attempted = false;
  let disposed = false;
  let inFlight: Promise<boolean> | null = null;

  return {
    recover: () => {
      if (disposed) return Promise.resolve(false);
      if (inFlight !== null) return inFlight;
      if (attempted) return Promise.resolve(true);

      attempted = true;
      options.announce();
      inFlight = options
        .reopen()
        .then((reopened) => {
          if (disposed) return false;
          if (!reopened) {
            attempted = false;
            return false;
          }
          options.refresh();
          return true;
        })
        .catch(() => {
          attempted = false;
          return false;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
    isActive: () => attempted || inFlight !== null,
    reset: () => {
      if (inFlight === null) attempted = false;
    },
    dispose: () => {
      disposed = true;
    },
  };
}

export function createTerminalLayoutScheduler(
  syncLayout: () => void,
  frameApi: TerminalLayoutFrameApi,
): { schedule: () => void; dispose: () => void } {
  let frameId: number | null = null;
  return {
    schedule: () => {
      if (frameId !== null) return;
      frameId = frameApi.request(() => {
        frameId = null;
        syncLayout();
      });
    },
    dispose: () => {
      if (frameId === null) return;
      frameApi.cancel(frameId);
      frameId = null;
    },
  };
}

function runtimeEnvSignature(runtimeEnv: Record<string, string> | undefined): string {
  if (!runtimeEnv) return "";
  return JSON.stringify(
    Object.entries(runtimeEnv)
      .filter(([key, value]) => key.length > 0 && typeof value === "string")
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey)),
  );
}

function normalizeComputedColor(value: string | null | undefined, fallback: string): string {
  const normalizedValue = value?.trim().toLowerCase();
  if (
    !normalizedValue ||
    normalizedValue === "transparent" ||
    normalizedValue === "rgba(0, 0, 0, 0)" ||
    normalizedValue === "rgba(0 0 0 / 0)"
  ) {
    return fallback;
  }
  return value ?? fallback;
}

function terminalThemeFromApp(mountElement?: HTMLElement | null): ITheme {
  const isDark = document.documentElement.classList.contains("dark");
  const fallbackBackground = isDark ? "rgb(14, 18, 24)" : "rgb(255, 255, 255)";
  const fallbackForeground = isDark ? "rgb(237, 241, 247)" : "rgb(28, 33, 41)";
  const drawerSurface =
    mountElement?.closest(".thread-terminal-drawer") ??
    document.querySelector(".thread-terminal-drawer") ??
    document.body;
  const drawerStyles = getComputedStyle(drawerSurface);
  const bodyStyles = getComputedStyle(document.body);
  const background = normalizeComputedColor(
    drawerStyles.backgroundColor,
    normalizeComputedColor(bodyStyles.backgroundColor, fallbackBackground),
  );
  const foreground = normalizeComputedColor(
    drawerStyles.color,
    normalizeComputedColor(bodyStyles.color, fallbackForeground),
  );

  if (isDark) {
    return {
      background,
      foreground,
      // Gold caret and selection on the page black; the ANSI ramp is muted
      // and evenly weighted so a busy build log reads as one texture.
      cursor: "rgb(217, 169, 58)",
      cursorAccent: "rgb(5, 5, 5)",
      selectionBackground: "rgba(217, 169, 58, 0.28)",
      selectionInactiveBackground: "rgba(217, 169, 58, 0.16)",
      scrollbarSliderBackground: "rgba(255, 255, 255, 0.10)",
      scrollbarSliderHoverBackground: "rgba(217, 169, 58, 0.45)",
      scrollbarSliderActiveBackground: "rgba(217, 169, 58, 0.6)",
      black: "rgb(28, 28, 31)",
      red: "rgb(240, 113, 120)",
      green: "rgb(152, 210, 121)",
      yellow: "rgb(224, 175, 104)",
      blue: "rgb(122, 162, 247)",
      magenta: "rgb(187, 154, 247)",
      cyan: "rgb(125, 207, 255)",
      white: "rgb(200, 204, 212)",
      brightBlack: "rgb(96, 100, 110)",
      brightRed: "rgb(255, 143, 150)",
      brightGreen: "rgb(181, 232, 154)",
      brightYellow: "rgb(245, 205, 138)",
      brightBlue: "rgb(157, 188, 255)",
      brightMagenta: "rgb(210, 186, 255)",
      brightCyan: "rgb(163, 224, 255)",
      brightWhite: "rgb(240, 241, 245)",
    };
  }

  return {
    background,
    foreground,
    cursor: "rgb(176, 124, 20)",
    cursorAccent: "rgb(255, 255, 255)",
    selectionBackground: "rgba(217, 169, 58, 0.28)",
    selectionInactiveBackground: "rgba(217, 169, 58, 0.16)",
    scrollbarSliderBackground: "rgba(0, 0, 0, 0.15)",
    scrollbarSliderHoverBackground: "rgba(0, 0, 0, 0.25)",
    scrollbarSliderActiveBackground: "rgba(0, 0, 0, 0.3)",
    black: "rgb(44, 53, 66)",
    red: "rgb(191, 70, 87)",
    green: "rgb(60, 126, 86)",
    yellow: "rgb(146, 112, 35)",
    blue: "rgb(72, 102, 163)",
    magenta: "rgb(132, 86, 149)",
    cyan: "rgb(53, 127, 141)",
    white: "rgb(210, 215, 223)",
    brightBlack: "rgb(112, 123, 140)",
    brightRed: "rgb(212, 95, 112)",
    brightGreen: "rgb(85, 148, 111)",
    brightYellow: "rgb(173, 133, 45)",
    brightBlue: "rgb(91, 124, 194)",
    brightMagenta: "rgb(153, 107, 172)",
    brightCyan: "rgb(70, 149, 164)",
    brightWhite: "rgb(236, 240, 246)",
  };
}

function getTerminalSelectionRect(mountElement: HTMLElement): DOMRect | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const commonAncestor = range.commonAncestorContainer;
  const selectionRoot =
    commonAncestor instanceof Element ? commonAncestor : commonAncestor.parentElement;
  if (!(selectionRoot instanceof Element) || !mountElement.contains(selectionRoot)) {
    return null;
  }

  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0,
  );
  if (rects.length > 0) {
    return rects[rects.length - 1] ?? null;
  }

  const boundingRect = range.getBoundingClientRect();
  return boundingRect.width > 0 || boundingRect.height > 0 ? boundingRect : null;
}

export function resolveTerminalSelectionActionPosition(options: {
  bounds: { left: number; top: number; width: number; height: number };
  selectionRect: { right: number; bottom: number } | null;
  pointer: { x: number; y: number } | null;
  viewport?: { width: number; height: number } | null;
}): { x: number; y: number } {
  const { bounds, selectionRect, pointer, viewport } = options;
  const viewportWidth =
    viewport?.width ??
    (typeof window === "undefined" ? bounds.left + bounds.width + 8 : window.innerWidth);
  const viewportHeight =
    viewport?.height ??
    (typeof window === "undefined" ? bounds.top + bounds.height + 8 : window.innerHeight);
  const drawerLeft = Math.round(bounds.left);
  const drawerTop = Math.round(bounds.top);
  const drawerRight = Math.round(bounds.left + bounds.width);
  const drawerBottom = Math.round(bounds.top + bounds.height);
  const preferredX =
    selectionRect !== null
      ? Math.round(selectionRect.right)
      : pointer === null
        ? Math.round(bounds.left + bounds.width - 140)
        : Math.max(drawerLeft, Math.min(Math.round(pointer.x), drawerRight));
  const preferredY =
    selectionRect !== null
      ? Math.round(selectionRect.bottom + 4)
      : pointer === null
        ? Math.round(bounds.top + 12)
        : Math.max(drawerTop, Math.min(Math.round(pointer.y), drawerBottom));
  return {
    x: Math.max(8, Math.min(preferredX, Math.max(viewportWidth - 8, 8))),
    y: Math.max(8, Math.min(preferredY, Math.max(viewportHeight - 8, 8))),
  };
}

export function terminalSelectionActionDelayForClickCount(clickCount: number): number {
  return clickCount >= 2 ? MULTI_CLICK_SELECTION_ACTION_DELAY_MS : 0;
}

export function shouldHandleTerminalSelectionMouseUp(
  selectionGestureActive: boolean,
  button: number,
): boolean {
  return selectionGestureActive && button === 0;
}

interface TerminalViewportProps {
  threadRef: ScopedThreadRef;
  threadId: ThreadId;
  terminalId: string;
  terminalLabel: string;
  cwd: string;
  worktreePath?: string | null;
  runtimeEnv?: Record<string, string>;
  onSessionExited: () => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  focusRequestId: number;
  autoFocus: boolean;
  surfaceVisible: boolean;
  locallyOpening: boolean;
  resizeEpoch: number;
  /**
   * Bump when the pane returns to view (thread switch, drawer reopen).
   * Full-screen programs only repaint on SIGWINCH, so a reveal walks the PTY
   * through a one-column resize detour even when the geometry is unchanged.
   */
  nudgeEpoch?: number;
  drawerHeight: number;
  keybindings: ResolvedKeybindingsConfig;
}

interface TerminalLaunchLocation {
  readonly cwd: string;
  readonly worktreePath?: string | null;
  readonly runtimeEnv?: Record<string, string>;
}

export function TerminalViewport({
  threadRef,
  threadId,
  terminalId,
  terminalLabel,
  cwd,
  worktreePath,
  runtimeEnv,
  onSessionExited,
  onAddTerminalContext,
  focusRequestId,
  autoFocus,
  surfaceVisible,
  locallyOpening,
  resizeEpoch,
  nudgeEpoch = 0,
  drawerHeight,
  keybindings,
}: TerminalViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  /**
   * How much of the pane the phone keyboard is sitting on top of.
   *
   * The prompt, the line being typed and the mobile key bar all live at the
   * bottom of this pane, which is exactly what the keyboard covers - so
   * without this the only part of the terminal you are using is the part you
   * cannot see.
   */
  const [keyboardInset, setKeyboardInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const isTouch = window.matchMedia("(pointer: coarse)").matches;
    const sync = () => {
      const pane = paneRef.current;
      const textarea = terminalRef.current?.textarea ?? null;
      if (!pane) return;
      const rect = pane.getBoundingClientRect();
      setKeyboardInset(
        resolveTerminalKeyboardInset({
          paneBottom: rect.bottom,
          visualViewportHeight: viewport.height,
          visualViewportOffsetTop: viewport.offsetTop,
          terminalFocused: textarea !== null && document.activeElement === textarea,
          isPortrait: window.matchMedia("(orientation: portrait)").matches,
          isTouch,
        }),
      );
    };
    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    // Focus moves without the viewport changing size (tapping between the
    // terminal and the composer while the keyboard is already up), and the
    // inset belongs to whichever of them currently owns it.
    document.addEventListener("focusin", sync);
    document.addEventListener("focusout", sync);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
      document.removeEventListener("focusin", sync);
      document.removeEventListener("focusout", sync);
    };
  }, []);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const scheduleTerminalLayoutRef = useRef<(() => void) | null>(null);
  const nudgeTerminalLayoutRef = useRef<((options?: { force?: boolean }) => void) | null>(null);
  const initialFollowTailRef = useRef<ReturnType<typeof createTerminalInitialFollowTail> | null>(
    null,
  );
  const missingSessionRecoveryRef = useRef<ReturnType<
    typeof createMissingTerminalSessionRecovery
  > | null>(null);
  /** Last time live (non-replay) PTY output was written into this viewport. */
  const lastLiveOutputAtRef = useRef(0);
  const environmentId = threadRef.environmentId;
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const openInPreferredEditor = useOpenInPreferredEditor(
    environmentId,
    serverConfig?.availableEditors ?? [],
  );
  const openTerminalPath = useEffectEvent((target: string) => openInPreferredEditor(target));
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const runTerminalWrite = useAtomCommand(terminalEnvironment.write, {
    reportFailure: false,
  });
  const runTerminalResize = useAtomCommand(terminalEnvironment.resize, {
    reportFailure: false,
  });
  const runTerminalOpen = useAtomCommand(terminalEnvironment.open, {
    reportFailure: false,
  });
  const hasHandledExitRef = useRef(false);
  const selectionPointerRef = useRef<{ x: number; y: number } | null>(null);
  const selectionGestureActiveRef = useRef(false);
  const selectionActionRequestIdRef = useRef(0);
  const selectionActionMenuOpenRef = useRef(false);
  const selectionActionTimerRef = useRef<number | null>(null);
  const keybindingsRef = useRef(keybindings);
  const runtimeEnvKey = useMemo(() => runtimeEnvSignature(runtimeEnv), [runtimeEnv]);
  const handleSessionExited = useEffectEvent(() => {
    onSessionExited();
  });
  const handleAddTerminalContext = useEffectEvent((selection: TerminalContextSelection) => {
    onAddTerminalContext(selection);
  });
  const readTerminalLabel = useEffectEvent(() => terminalLabel);
  const terminalSession = useAttachedTerminalSession({
    environmentId,
    terminal: {
      threadId,
      terminalId,
      cwd,
      ...(worktreePath !== undefined ? { worktreePath } : {}),
      ...(runtimeEnv ? { env: runtimeEnv } : {}),
    },
  });
  const refreshTerminalSession = useEffectEvent(() => {
    terminalSession.refresh();
  });
  const writeTerminal = useEffectEvent((data: string) =>
    runTerminalWrite({
      environmentId,
      input: { threadId, terminalId, data, clientId: terminalClientId() },
    }),
  );
  const [fileDropPreview, setFileDropPreview] = useState<TerminalFileDropPreview | null>(null);
  const openTerminalSession = useEffectEvent(() => {
    const geometry = fitAddonRef.current?.proposeDimensions();
    // A pane opened mid-animation can fit a degenerate grid; spawn at the
    // default size instead and let the settled layout commit the real one.
    const usable = geometry && isReportablePtyGeometry(geometry) ? geometry : null;
    return runTerminalOpen({
      environmentId,
      input: {
        threadId,
        terminalId,
        cwd,
        worktreePath: worktreePath ?? null,
        cols: usable ? usable.cols : 80,
        rows: usable ? usable.rows : 24,
        ...(runtimeEnv ? { env: runtimeEnv } : {}),
        clientId: terminalClientId(),
      },
    });
  });
  const resizeTerminal = useEffectEvent((cols: number, rows: number) =>
    runTerminalResize({
      environmentId,
      input: { threadId, terminalId, cols, rows, clientId: terminalClientId() },
    }),
  );
  const terminalBuffer = terminalSession.buffer;
  const terminalError = terminalSession.error;
  const terminalStatus = terminalSession.status;
  const terminalVersion = terminalSession.version;
  const terminalHasRunningSubprocess = terminalSession.hasRunningSubprocess;
  // TerminalViewport is keyed by terminal id. Preserve whether this instance
  // was born from a local open even after metadata confirms it and removes the
  // id from the pending-open set.
  const locallyOpeningAtMountRef = useRef(locallyOpening);
  const [replayOverlayVisible, setReplayOverlayVisible] = useState(() =>
    shouldShowInitialTerminalReplayOverlay(locallyOpeningAtMountRef.current),
  );
  const replayOverlayRevealFrameRef = useRef<number | null>(null);
  const replayOverlayGateRef = useRef<ReturnType<typeof createTerminalReplayOverlayGate> | null>(
    null,
  );
  const scheduleReplayOverlayReveal = useEffectEvent(() => {
    if (replayOverlayRevealFrameRef.current !== null) {
      return;
    }
    replayOverlayRevealFrameRef.current = window.requestAnimationFrame(() => {
      replayOverlayRevealFrameRef.current = null;
      setReplayOverlayVisible(false);
    });
  });
  const replaceReplayOverlayGate = useEffectEvent((showOverlay: boolean) => {
    replayOverlayGateRef.current?.dispose();
    if (replayOverlayRevealFrameRef.current !== null) {
      window.cancelAnimationFrame(replayOverlayRevealFrameRef.current);
      replayOverlayRevealFrameRef.current = null;
    }
    setReplayOverlayVisible(showOverlay);
    const gate = createTerminalReplayOverlayGate(scheduleReplayOverlayReveal, {
      setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimeout: (timeoutId) => window.clearTimeout(timeoutId),
    });
    replayOverlayGateRef.current = gate;
    return gate;
  });
  const surfaceVisibleRef = useRef(surfaceVisible);
  surfaceVisibleRef.current = surfaceVisible;
  const visibilityRestorePendingRef = useRef(false);
  const beginVisibilityRestore = useEffectEvent(() => {
    if (visibilityRestorePendingRef.current) return;
    visibilityRestorePendingRef.current = true;
    replaceReplayOverlayGate(true);
  });
  const settleVisibilityRestore = useEffectEvent(() => {
    if (!visibilityRestorePendingRef.current) return;
    if (!surfaceVisibleRef.current || document.visibilityState === "hidden") return;
    visibilityRestorePendingRef.current = false;
    replayOverlayGateRef.current?.markInitialReplayParsed();
  });
  const terminalHasRunningSubprocessRef = useRef(terminalHasRunningSubprocess);
  terminalHasRunningSubprocessRef.current = terminalHasRunningSubprocess;
  // What the live input-method buffer has already contributed to the PTY.
  const terminalDictationStateRef = useRef<TerminalDictationState>(emptyTerminalDictationState);
  const serverCols = terminalSession.summary?.cols;
  const serverRows = terminalSession.summary?.rows;
  const serverGeometryRef = useRef<{ cols: number; rows: number } | null>(null);
  serverGeometryRef.current =
    serverCols !== undefined && serverRows !== undefined
      ? { cols: serverCols, rows: serverRows }
      : null;
  const serverGeometryOwner = terminalSession.summary?.geometryOwner;
  const serverGeometryOwnerRef = useRef<string | undefined>(undefined);
  serverGeometryOwnerRef.current = serverGeometryOwner;
  useEffect(() => {
    // Another client resized the shared PTY or geometry ownership moved
    // (someone typed on another machine, or this one took over). Re-run
    // layout: mirrors adopt the authoritative grid scaled into their pane,
    // a new owner commits its local fit. The scheduler coalesces to a
    // no-op when nothing actually changed.
    scheduleTerminalLayoutRef.current?.();
  }, [serverCols, serverRows, serverGeometryOwner]);
  const previousSessionRef = useRef({
    buffer: terminalBuffer,
    error: terminalError,
    status: terminalStatus,
    version: terminalVersion,
  });

  useEffect(() => {
    keybindingsRef.current = keybindings;
  }, [keybindings]);

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount) return;

    ensureTerminalUserActivityTracking();
    const localApi = readLocalApi();

    const fitAddon = new FitAddon();
    const terminal = new Terminal({
      cursorBlink: true,
      lineHeight: 1,
      fontSize: 12,
      scrollback: 5_000,
      smoothScrollDuration: 0,
      allowTransparency: false,
      cursorStyle: "bar",
      cursorWidth: 2,
      fontWeight: "400",
      fontWeightBold: "600",
      fontFamily:
        '"JetBrains Mono Variable", "JetBrains Mono", "SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
      theme: terminalThemeFromApp(mount),
    });
    terminal.loadAddon(fitAddon);
    terminal.open(mount);
    // The DOM renderer repaints per write chunk, which makes alt-screen TUIs
    // (their scrolling redraws a full frame over the wire) flicker badly.
    // WebGL renders atomically per frame; on context loss or unsupported
    // WebGL the DOM renderer keeps working.
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
      });
      terminal.loadAddon(webglAddon);
    } catch {
      // WebGL unavailable — fall back to the DOM renderer.
    }
    fitTerminalSafely(fitAddon);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    replaceReplayOverlayGate(
      shouldShowInitialTerminalReplayOverlay(locallyOpeningAtMountRef.current),
    );
    previousSessionRef.current = {
      buffer: "",
      status: "closed",
      error: null,
      version: 0,
    };
    const initialFollowTail = createTerminalInitialFollowTail(() => terminal.scrollToBottom(), {
      setInterval: (callback, delayMs) => window.setInterval(callback, delayMs),
      clearInterval: (intervalId) => window.clearInterval(intervalId),
      setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimeout: (timeoutId) => window.clearTimeout(timeoutId),
    });
    initialFollowTailRef.current = initialFollowTail;
    const missingSessionRecovery = createMissingTerminalSessionRecovery({
      announce: () => writeSystemMessage(terminal, "Terminal session not found — restarting it…"),
      reopen: async () => (await openTerminalSession())._tag === "Success",
      refresh: refreshTerminalSession,
    });
    missingSessionRecoveryRef.current = missingSessionRecovery;

    let lastReportedGeometry: string | null = null;
    // Divider drags stream a resize per animation frame. Refitting the WebGL
    // canvas on each tick clears it, and a trailing one-column PTY detour
    // makes the program draw twice more. Stretch the last raster to the new
    // pane during the burst, then commit the cell grid and PTY size once.
    let settleCommitPending = false;
    let settleCommitTimer: number | null = null;
    let ptyNudgeInFlight = false;
    let lastNudgeAt = 0;
    let lastNudgedGeometry: string | null = null;
    let lastFittedCss: { width: number; height: number } | null = null;
    const xtermElement = (): HTMLElement | null => {
      // Scale the screen (grid canvases), not `.xterm`. The wrapper is
      // width/height 100% of the pane, so scaling it would compound the
      // layout change instead of stretching the last raster.
      const element = mount.querySelector(".xterm-screen");
      return element instanceof HTMLElement ? element : null;
    };
    const clearPreviewScale = () => {
      const element = xtermElement();
      if (element) applyTerminalViewportPreviewScale(element, null);
    };
    /**
     * This client may resize the shared PTY only when it is both the
     * actively-used window (focus + recent input) and the server-side
     * geometry owner (last client to open/type/resize this terminal).
     * Everyone else mirrors: two active machines viewing the same terminal
     * must not ping-pong the PTY between their pane grids.
     */
    const clientDrivesPtyGeometry = () =>
      clientIsGeometryDriver() &&
      clientOwnsTerminalGeometry(serverGeometryOwnerRef.current, terminalClientId());
    /**
     * Passive-viewer path: render at the server's authoritative PTY grid
     * and uniformly scale the raster into this pane. Returns false when no
     * server grid is known yet, letting the caller fall back to a local fit.
     */
    const adoptServerGeometry = (): boolean => {
      const server = serverGeometryRef.current;
      if (!server || !isReportablePtyGeometry(server)) return false;
      // Mirroring hands geometry back to the owner; if ownership later
      // returns here, the next commit must re-report even an identical fit.
      lastReportedGeometry = null;
      const bounds = mount.getBoundingClientRect();
      if (!hasRenderableTerminalViewportSize(bounds)) return true;
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return true;
      if (activeTerminal.cols !== server.cols || activeTerminal.rows !== server.rows) {
        try {
          activeTerminal.resize(server.cols, server.rows);
        } catch {
          return true;
        }
      }
      const element = xtermElement();
      if (element) {
        element.style.transform = "";
        const screen = element.getBoundingClientRect();
        const scale =
          screen.width > 0 && screen.height > 0
            ? Math.min(bounds.width / screen.width, bounds.height / screen.height, 1)
            : 1;
        applyTerminalViewportPreviewScale(
          element,
          Math.abs(scale - 1) < 0.01 ? null : { x: scale, y: scale },
        );
      }
      lastFittedCss = { width: bounds.width, height: bounds.height };
      return true;
    };
    const reportPtyGeometry = (geometry: { cols: number; rows: number }) => {
      const geometryKey = `${geometry.cols}x${geometry.rows}`;
      const now = Date.now();
      lastReportedGeometry = geometryKey;
      lastNudgedGeometry = geometryKey;
      lastNudgeAt = now;
      void resizeTerminal(geometry.cols, geometry.rows).then((result) => {
        if (result._tag === "Failure" && lastReportedGeometry === geometryKey) {
          // Let a later activation/layout signal retry a transiently rejected
          // resize instead of permanently deduplicating the failed geometry.
          lastReportedGeometry = null;
        }
      });
    };
    const commitTerminalLayout = (reportPty: boolean) => {
      const bounds = mount.getBoundingClientRect();
      if (!hasRenderableTerminalViewportSize(bounds)) return;
      const activeTerminal = terminalRef.current;
      const activeFitAddon = fitAddonRef.current;
      if (!activeTerminal || !activeFitAddon) return;
      clearPreviewScale();
      const geometry = fitAndRefreshTerminalViewport(activeTerminal, activeFitAddon);
      if (!geometry) return;
      lastFittedCss = { width: bounds.width, height: bounds.height };
      if (!reportPty) return;
      // A mid-animation pane can fit a degenerate grid; keep that local.
      if (!isReportablePtyGeometry(geometry)) return;
      // Only the actively-used geometry owner resizes the shared PTY.
      if (!clientDrivesPtyGeometry()) return;
      const geometryKey = `${geometry.cols}x${geometry.rows}`;
      if (geometryKey === lastReportedGeometry) return;
      reportPtyGeometry(geometry);
    };
    const armSettleCommit = () => {
      if (settleCommitTimer !== null) window.clearTimeout(settleCommitTimer);
      settleCommitTimer = window.setTimeout(() => {
        settleCommitTimer = null;
        if (!settleCommitPending) return;
        settleCommitPending = false;
        commitTerminalLayout(true);
      }, TERMINAL_PTY_RESIZE_SETTLE_MS);
    };
    const syncTerminalLayout = () => {
      if (ptyNudgeInFlight) return;
      if (!clientDrivesPtyGeometry() && adoptServerGeometry()) return;
      const bounds = mount.getBoundingClientRect();
      if (!hasRenderableTerminalViewportSize(bounds)) return;
      const activeTerminal = terminalRef.current;
      const activeFitAddon = fitAddonRef.current;
      if (!activeTerminal || !activeFitAddon) return;
      const proposed = proposeTerminalDimensions(activeFitAddon);
      if (proposed === null) {
        commitTerminalLayout(true);
        return;
      }
      const plan = planTerminalResizeSync({
        hasCommittedViewport: lastFittedCss !== null,
        colsChanged: proposed.cols !== activeTerminal.cols,
        rowsChanged: proposed.rows !== activeTerminal.rows,
      });
      if (plan === "skip") {
        return;
      }
      if (plan === "preview" && lastFittedCss) {
        const element = xtermElement();
        const scale = terminalViewportPreviewScale(lastFittedCss, bounds);
        if (element) applyTerminalViewportPreviewScale(element, scale);
        settleCommitPending = true;
        armSettleCommit();
        return;
      }
      commitTerminalLayout(true);
    };
    const layoutScheduler = createTerminalLayoutScheduler(syncTerminalLayout, {
      request: (callback) => window.requestAnimationFrame(callback),
      cancel: (frameId) => window.cancelAnimationFrame(frameId),
    });
    scheduleTerminalLayoutRef.current = layoutScheduler.schedule;
    // Reattached and revealed terminals replay history that full-screen
    // programs never repaint on their own: the PTY only signals them on a size
    // change, and re-fitting to the same geometry sends nothing. Walking the
    // PTY through a one-column detour guarantees a SIGWINCH at the final,
    // correct size — the same thing a manual window resize did by accident.
    nudgeTerminalLayoutRef.current = (options?: { force?: boolean }) => {
      const force = options?.force === true;
      const run = (attempt: number) => {
        if (ptyNudgeInFlight) return;
        // A passive viewer never walks the PTY through a detour — the
        // repaint it needs comes from the replayed buffer, and a detour
        // would fight the driving client's geometry.
        if (!clientDrivesPtyGeometry() && adoptServerGeometry()) return;
        const bounds = mount.getBoundingClientRect();
        if (!hasRenderableTerminalViewportSize(bounds)) {
          if (attempt < 12) {
            window.setTimeout(() => run(attempt + 1), 32);
          }
          return;
        }
        const activeTerminal = terminalRef.current;
        const activeFitAddon = fitAddonRef.current;
        if (!activeTerminal || !activeFitAddon) return;
        clearPreviewScale();
        const geometry = fitAndRefreshTerminalViewport(activeTerminal, activeFitAddon);
        if (!geometry) return;
        lastFittedCss = { width: bounds.width, height: bounds.height };
        // Never walk the PTY through a detour from a degenerate mid-animation
        // grid; a later layout signal retries once the pane has real bounds.
        if (!isReportablePtyGeometry(geometry)) {
          if (attempt < 12) {
            window.setTimeout(() => run(attempt + 1), 32);
          }
          return;
        }
        const geometryKey = `${geometry.cols}x${geometry.rows}`;
        const now = Date.now();
        if (
          geometryKey === lastNudgedGeometry &&
          now - lastNudgeAt < TERMINAL_PTY_NUDGE_COOLDOWN_MS
        ) {
          lastReportedGeometry = geometryKey;
          return;
        }
        // A live-painting TUI needs no forced repaint; the detour SIGWINCH
        // would only make it clear and redraw the whole frame on screen.
        if (
          !shouldDetourPtyOnNudge({
            force,
            nowMs: now,
            lastLiveOutputAtMs: lastLiveOutputAtRef.current,
          })
        ) {
          lastReportedGeometry = geometryKey;
          return;
        }
        lastReportedGeometry = geometryKey;
        lastNudgedGeometry = geometryKey;
        lastNudgeAt = now;
        ptyNudgeInFlight = true;
        // Same-size resize is a no-op in node-pty, so a one-row detour is
        // what actually delivers SIGWINCH. Rows, not columns: ConPTY
        // (Windows) rewraps its whole buffer on any width change and
        // re-emits the rewrapped lines into shared history, garbling long
        // lines for every attached viewer. A row change forces the same
        // repaint everywhere without touching wrap. Wait a frame between
        // the two sizes so the program observes both changes.
        // Detour upward at the floor so the intermediate size is never
        // dropped by the server's degenerate-resize clamp.
        const detourRows =
          geometry.rows > MIN_REPORTABLE_PTY_ROWS ? geometry.rows - 1 : geometry.rows + 1;
        void resizeTerminal(geometry.cols, detourRows)
          .then(
            () =>
              new Promise<void>((resolve) => {
                window.setTimeout(resolve, 32);
              }),
          )
          .then(() => resizeTerminal(geometry.cols, geometry.rows))
          .finally(() => {
            ptyNudgeInFlight = false;
          });
      };
      run(0);
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            layoutScheduler.schedule();
          });
    resizeObserver?.observe(mount);

    const clearSelectionAction = () => {
      selectionActionRequestIdRef.current += 1;
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
        selectionActionTimerRef.current = null;
      }
    };

    const readSelectionAction = (): {
      position: { x: number; y: number };
      clipboardText: string;
      selection: TerminalContextSelection;
    } | null => {
      const activeTerminal = terminalRef.current;
      const mountElement = containerRef.current;
      if (!activeTerminal || !mountElement || !activeTerminal.hasSelection()) {
        return null;
      }
      const selectionText = activeTerminal.getSelection();
      const selectionPosition = activeTerminal.getSelectionPosition();
      const normalizedText = selectionText.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
      if (!selectionPosition || normalizedText.length === 0) {
        return null;
      }
      const lineStart = selectionPosition.start.y + 1;
      const lineCount = normalizedText.split("\n").length;
      const lineEnd = Math.max(lineStart, lineStart + lineCount - 1);
      const bounds = mountElement.getBoundingClientRect();
      const selectionRect = getTerminalSelectionRect(mountElement);
      const position = resolveTerminalSelectionActionPosition({
        bounds,
        selectionRect:
          selectionRect === null
            ? null
            : { right: selectionRect.right, bottom: selectionRect.bottom },
        pointer: selectionPointerRef.current,
      });
      return {
        position,
        clipboardText: selectionText,
        selection: {
          terminalId,
          terminalLabel: readTerminalLabel(),
          lineStart,
          lineEnd,
          text: normalizedText,
        },
      };
    };

    const showSelectionAction = async () => {
      if (!localApi) {
        clearSelectionAction();
        return;
      }
      if (selectionActionMenuOpenRef.current) {
        return;
      }
      const nextAction = readSelectionAction();
      if (!nextAction) {
        clearSelectionAction();
        return;
      }
      const requestId = ++selectionActionRequestIdRef.current;
      selectionActionMenuOpenRef.current = true;
      const clicked = await localApi.contextMenu
        .show(
          [
            { id: "add-to-chat", label: "Add to chat" },
            { id: "copy", label: "Copy" },
          ],
          nextAction.position,
        )
        .finally(() => {
          selectionActionMenuOpenRef.current = false;
        });
      if (requestId !== selectionActionRequestIdRef.current || clicked === null) {
        return;
      }
      switch (clicked) {
        case "add-to-chat":
          handleAddTerminalContext(nextAction.selection);
          terminalRef.current?.clearSelection();
          terminalRef.current?.focus();
          return;
        case "copy":
          try {
            await writeTextToClipboard(nextAction.clipboardText, "terminal selection");
          } catch (error) {
            if (requestId !== selectionActionRequestIdRef.current) {
              return;
            }
            const activeTerminal = terminalRef.current;
            if (activeTerminal) {
              writeSystemMessage(
                activeTerminal,
                error instanceof Error ? error.message : "Unable to copy terminal selection",
              );
            }
          }
          if (requestId === selectionActionRequestIdRef.current) {
            terminalRef.current?.focus();
          }
          return;
      }
    };

    const sendTerminalInput = async (data: string, fallbackError: string) => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;
      const result = await writeTerminal(data);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        writeSystemMessage(activeTerminal, error instanceof Error ? error.message : fallbackError);
      }
    };

    terminal.attachCustomKeyEventHandler((event) => {
      const currentKeybindings = keybindingsRef.current;
      const options = { context: { terminalFocus: true, terminalOpen: true } };
      if (
        isTerminalToggleShortcut(event, currentKeybindings, options) ||
        isTerminalSplitShortcut(event, currentKeybindings, options) ||
        isTerminalSplitVerticalShortcut(event, currentKeybindings, options) ||
        isTerminalNewShortcut(event, currentKeybindings, options) ||
        isTerminalCloseShortcut(event, currentKeybindings, options) ||
        isDiffToggleShortcut(event, currentKeybindings, options)
      ) {
        return false;
      }

      const navigationData = terminalNavigationShortcutData(event);
      if (navigationData !== null) {
        event.preventDefault();
        event.stopPropagation();
        void sendTerminalInput(navigationData, "Failed to move cursor");
        return false;
      }

      const deleteData = terminalDeleteShortcutData(event);
      if (deleteData !== null) {
        event.preventDefault();
        event.stopPropagation();
        void sendTerminalInput(deleteData, "Failed to delete terminal input");
        return false;
      }

      if (!isTerminalClearShortcut(event)) return true;
      event.preventDefault();
      event.stopPropagation();
      void sendTerminalInput("\u000c", "Failed to clear terminal");
      return false;
    });

    const terminalLinksDisposable = terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const activeTerminal = terminalRef.current;
        if (!activeTerminal) {
          callback(undefined);
          return;
        }

        const wrappedLine = collectWrappedTerminalLinkLine(bufferLineNumber, (bufferLineIndex) =>
          activeTerminal.buffer.active.getLine(bufferLineIndex),
        );
        if (!wrappedLine) {
          callback(undefined);
          return;
        }

        const links = extractTerminalLinks(wrappedLine.text)
          .map((match) => ({
            match,
            range: resolveWrappedTerminalLinkRange(wrappedLine, match),
          }))
          .filter(({ range }) =>
            wrappedTerminalLinkRangeIntersectsBufferLine(range, bufferLineNumber),
          );
        if (links.length === 0) {
          callback(undefined);
          return;
        }

        callback(
          links.map(({ match, range }) => ({
            text: match.text,
            range,
            activate: (event: MouseEvent) => {
              if (!isTerminalLinkActivation(event)) return;

              const latestTerminal = terminalRef.current;
              if (!latestTerminal) return;

              if (match.kind === "url") {
                if (!localApi) {
                  writeSystemMessage(
                    latestTerminal,
                    "Opening links is unavailable in this browser.",
                  );
                  return;
                }
                const fallbackToBrowser = () => {
                  void localApi.shell.openExternal(match.text).catch((error: unknown) => {
                    writeSystemMessage(
                      latestTerminal,
                      error instanceof Error ? error.message : "Unable to open link",
                    );
                  });
                };
                void openTerminalLinkInPreview({
                  url: match.text,
                  position: { x: event.clientX, y: event.clientY },
                  threadRef,
                  openPreview,
                  localApi,
                  fallbackToBrowser,
                });
                return;
              }

              const target = resolvePathLinkTarget(match.text, cwd);
              void (async () => {
                const result = await openTerminalPath(target);
                if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
                  return;
                }
                const error = squashAtomCommandFailure(result);
                writeSystemMessage(
                  latestTerminal,
                  error instanceof Error ? error.message : "Unable to open path",
                );
              })();
            },
          })),
        );
      },
    });

    // Stale tracking modes can flood one failed write per mouse-move; echoing
    // each rejection into the terminal buries the prompt. Print a repeated
    // failure once per quiet window instead.
    let lastInputFailure: { message: string; at: number } | null = null;
    const reportInputFailure = (message: string) => {
      const now = Date.now();
      if (
        lastInputFailure &&
        lastInputFailure.message === message &&
        now - lastInputFailure.at < 5_000
      ) {
        lastInputFailure.at = now;
        return;
      }
      lastInputFailure = { message, at: now };
      writeSystemMessage(terminal, message);
    };
    const inputDisposable = terminal.onData((data) => {
      // While an input method holds text in the textarea, xterm's own diff is
      // unreliable: iOS dictation rewrites words it already committed, and
      // xterm answers by re-sending the entire buffer. Reconcile against the
      // textarea, which holds exactly what has been dictated so far.
      const dictation = resolveTerminalDictationInput({
        payload: data,
        textareaValue: terminal.textarea?.value ?? "",
        state: terminalDictationStateRef.current,
      });
      terminalDictationStateRef.current = dictation.state;
      if (dictation.payload.length === 0) {
        return;
      }
      // Preserve actionable TUI mouse input, but never forward no-button
      // pointer motion. Multiple attached clients can otherwise produce a
      // write/repaint loop quickly enough to make the whole terminal UI
      // unresponsive, including its split and stop controls.
      const actionableData = stripTerminalUnbuttonedMouseMotionReports(dictation.payload);
      // A bare shell never wants mouse/focus reports; dropping them here is
      // the backstop for tracking modes the local resets could not reach.
      const payload = terminalHasRunningSubprocessRef.current
        ? actionableData
        : stripTerminalMouseReports(actionableData);
      if (payload.length === 0) {
        return;
      }
      void (async () => {
        const result = await writeTerminal(payload);
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        const error = squashAtomCommandFailure(result);
        const message = error instanceof Error ? error.message : "Terminal write failed";
        // The server no longer knows this session (e.g. it restarted under
        // us). Respawn once instead of rejecting every keystroke forever.
        if (isMissingTerminalSessionError(message)) {
          const recovered = await missingSessionRecoveryRef.current?.recover();
          if (recovered === true) return;
          reportInputFailure(message);
          handleSessionExited();
          return;
        }
        reportInputFailure(message);
      })();
    });

    const selectionDisposable = terminal.onSelectionChange(() => {
      if (terminalRef.current?.hasSelection()) {
        return;
      }
      clearSelectionAction();
    });

    const handleMouseUp = (event: MouseEvent) => {
      const shouldHandle = shouldHandleTerminalSelectionMouseUp(
        selectionGestureActiveRef.current,
        event.button,
      );
      selectionGestureActiveRef.current = false;
      if (!shouldHandle) {
        return;
      }
      selectionPointerRef.current = { x: event.clientX, y: event.clientY };
      const delay = terminalSelectionActionDelayForClickCount(event.detail);
      selectionActionTimerRef.current = window.setTimeout(() => {
        selectionActionTimerRef.current = null;
        window.requestAnimationFrame(() => {
          void showSelectionAction();
        });
      }, delay);
    };
    const handlePointerDown = (event: PointerEvent) => {
      clearSelectionAction();
      selectionGestureActiveRef.current = event.button === 0;
    };
    window.addEventListener("mouseup", handleMouseUp);
    mount.addEventListener("pointerdown", handlePointerDown);

    const themeObserver = new MutationObserver(() => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;
      activeTerminal.options.theme = terminalThemeFromApp(containerRef.current);
      activeTerminal.refresh(0, activeTerminal.rows - 1);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    layoutScheduler.schedule();
    const fitTimer = window.setTimeout(layoutScheduler.schedule, 30);

    // The PTY is shared across devices (phone, other windows) and the last
    // resize wins, so returning focus to this window re-asserts this
    // viewport's geometry with a repaint. Hidden panes bail on the
    // renderable-size check inside the nudge.
    const handleWindowFocusNudge = () => {
      // Re-assert this viewport's PTY size after another device may have
      // resized it. Do not walk a 1-column detour: Claude's alt-screen
      // renderer full-paints on every SIGWINCH, which flashes the pane.
      if (!terminalHasRunningSubprocessRef.current) return;
      // Focus alone does not make this window the geometry driver, and a
      // non-owner never re-asserts its grid; wait for real user input into
      // this terminal so an idle mirror never yanks the PTY's grid.
      if (!clientDrivesPtyGeometry()) {
        adoptServerGeometry();
        return;
      }
      const bounds = mount.getBoundingClientRect();
      if (!hasRenderableTerminalViewportSize(bounds)) return;
      const activeTerminal = terminalRef.current;
      const activeFitAddon = fitAddonRef.current;
      if (!activeTerminal || !activeFitAddon) return;
      clearPreviewScale();
      const geometry = fitAndRefreshTerminalViewport(activeTerminal, activeFitAddon);
      if (!geometry) return;
      lastFittedCss = { width: bounds.width, height: bounds.height };
      reportPtyGeometry(geometry);
    };
    window.addEventListener("focus", handleWindowFocusNudge);
    // Becoming the driver happens on the first real interaction after a
    // focus switch; re-run layout then so this pane reclaims its fit (the
    // scheduler coalesces to a no-op when nothing changed).
    const handleUserActivityLayout = () => {
      layoutScheduler.schedule();
    };
    window.addEventListener("keydown", handleUserActivityLayout, {
      capture: true,
      passive: true,
    });
    window.addEventListener("pointerdown", handleUserActivityLayout, {
      capture: true,
      passive: true,
    });

    return () => {
      window.clearTimeout(fitTimer);
      window.removeEventListener("focus", handleWindowFocusNudge);
      window.removeEventListener("keydown", handleUserActivityLayout, { capture: true });
      window.removeEventListener("pointerdown", handleUserActivityLayout, { capture: true });
      if (settleCommitTimer !== null) window.clearTimeout(settleCommitTimer);
      settleCommitPending = false;
      clearPreviewScale();
      resizeObserver?.disconnect();
      layoutScheduler.dispose();
      inputDisposable.dispose();
      selectionDisposable.dispose();
      terminalLinksDisposable.dispose();
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
      }
      window.removeEventListener("mouseup", handleMouseUp);
      mount.removeEventListener("pointerdown", handlePointerDown);
      themeObserver.disconnect();
      if (scheduleTerminalLayoutRef.current === layoutScheduler.schedule) {
        scheduleTerminalLayoutRef.current = null;
      }
      nudgeTerminalLayoutRef.current = null;
      if (initialFollowTailRef.current === initialFollowTail) {
        initialFollowTailRef.current = null;
      }
      if (replayOverlayRevealFrameRef.current !== null) {
        window.cancelAnimationFrame(replayOverlayRevealFrameRef.current);
        replayOverlayRevealFrameRef.current = null;
      }
      replayOverlayGateRef.current?.dispose();
      replayOverlayGateRef.current = null;
      visibilityRestorePendingRef.current = false;
      initialFollowTail.dispose();
      if (missingSessionRecoveryRef.current === missingSessionRecovery) {
        missingSessionRecoveryRef.current = null;
      }
      missingSessionRecovery.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      terminal.dispose();
    };
  }, [cwd, environmentId, runtimeEnvKey, terminalId, threadId, worktreePath]);

  useEffect(() => {
    const handleDocumentVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        beginVisibilityRestore();
        return;
      }
      settleVisibilityRestore();
    };
    document.addEventListener("visibilitychange", handleDocumentVisibilityChange);
    if (document.visibilityState === "hidden") {
      beginVisibilityRestore();
    }
    return () => {
      document.removeEventListener("visibilitychange", handleDocumentVisibilityChange);
    };
  }, [environmentId, terminalId, threadId]);

  useEffect(() => {
    if (!surfaceVisible) {
      beginVisibilityRestore();
      return;
    }
    settleVisibilityRestore();
  }, [surfaceVisible]);

  const staleTrackingResetDoneRef = useRef(false);
  useEffect(() => {
    const terminal = terminalRef.current;
    const current = {
      buffer: terminalBuffer,
      error: terminalError,
      status: terminalStatus,
      version: terminalVersion,
    };
    if (!terminal) {
      previousSessionRef.current = current;
      return;
    }

    const previous = previousSessionRef.current;
    if (current.version === previous.version) {
      return;
    }

    const writePlan = terminalBufferWritePlan(previous.buffer, current.buffer);
    const replayOverlayDisposition = terminalReplayOverlayDisposition({
      previousVersion: previous.version,
      currentVersion: current.version,
      currentLength: current.buffer.length,
    });
    const shouldFollowInitialTail = shouldNudgePtyAfterBufferWrite({
      previousVersion: previous.version,
      currentLength: current.buffer.length,
    });
    const initialFollowTail = initialFollowTailRef.current;
    const replayOverlayGate = replayOverlayGateRef.current;
    const isCatchUpWrite = previous.version > 0 && writePlan.data.length > 0;
    if (shouldFollowInitialTail) {
      initialFollowTail?.start();
    }
    if (isCatchUpWrite) {
      replayOverlayGate?.beginCatchUpWrite();
    }
    const settleReplayWrite =
      shouldFollowInitialTail || replayOverlayDisposition === "reveal-after-write" || isCatchUpWrite
        ? () => {
            if (shouldFollowInitialTail) {
              initialFollowTail?.settle();
            }
            if (replayOverlayDisposition === "reveal-after-write") {
              replayOverlayGate?.markInitialReplayParsed();
            } else if (isCatchUpWrite) {
              replayOverlayGate?.endCatchUpWrite();
            }
          }
        : undefined;
    if (previous.version > 0 && writePlan.data.length > 0) {
      lastLiveOutputAtRef.current = Date.now();
    }
    if (writePlan.kind === "append") {
      if (writePlan.data.length > 0) {
        terminal.write(writePlan.data, settleReplayWrite);
      }
    } else {
      writeTerminalBuffer(terminal, writePlan.data, settleReplayWrite);
      // Full replay re-enables tracking modes baked into TUI history. Reset
      // locally after those bytes; a live program that still wants mouse
      // tracking will send DECSET again on the next SIGWINCH/repaint.
      terminal.write(TERMINAL_STALE_TRACKING_RESET);
      staleTrackingResetDoneRef.current = true;
    }
    if (replayOverlayDisposition === "reveal-now") {
      replayOverlayGate?.revealImmediately();
    }
    terminal.clearSelection();

    if (shouldFollowInitialTail) {
      // First attach paints history produced for another geometry. Live
      // output — including history that was only prefix-trimmed — must not
      // SIGWINCH: the program then redraws, the buffer trims again, and the
      // viewport flickers forever.
      window.requestAnimationFrame(() => {
        nudgeTerminalLayoutRef.current?.({ force: true });
      });
    }

    if (
      current.error !== null &&
      current.error !== previous.error &&
      !isMissingTerminalSessionError(current.error)
    ) {
      writeSystemMessage(terminal, current.error);
    }

    if (current.status === "running") {
      hasHandledExitRef.current = false;
    } else if (
      (current.status === "closed" || current.status === "exited") &&
      current.status !== previous.status &&
      !hasHandledExitRef.current
    ) {
      hasHandledExitRef.current = true;
      writeSystemMessage(
        terminal,
        current.status === "closed" ? "Terminal closed" : "Process exited",
      );
      window.setTimeout(() => {
        if (hasHandledExitRef.current) {
          handleSessionExited();
        }
      }, 0);
    }

    previousSessionRef.current = current;
  }, [autoFocus, terminalBuffer, terminalError, terminalStatus, terminalVersion]);

  // A pane whose session no longer exists server-side was explicitly closed
  // (possibly on another machine): the server refuses to resurrect closed
  // sessions on attach, so the lookup failure is the close notification for
  // viewers that missed the live "closed" event (asleep, reconnecting,
  // restarted). Close the pane instead of leaving a dead error surface —
  // that is what kept pane layouts permanently diverged between machines.
  useEffect(() => {
    const recovery = missingSessionRecoveryRef.current;
    if (terminalStatus !== "error" || !isMissingTerminalSessionError(terminalError)) {
      recovery?.reset();
      return;
    }
    // Attaching is passive viewing: a pane closed on another client must stay
    // closed. Only explicit keyboard input may resurrect a stale session. If
    // that user-driven reopen is refreshing this failed subscription, let it
    // finish before deciding the stale pane is gone.
    if (recovery?.isActive() && terminalSession.isPending) return;
    handleSessionExited();
  }, [terminalError, terminalSession.isPending, terminalStatus, terminalVersion]);

  // With only a shell in the foreground, any mouse/focus tracking modes left
  // over from replayed TUI bytes are stale: xterm would type mouse reports
  // into the prompt as garbage on every cursor move. Reset the modes locally
  // once per idle episode (declared after the replay effect so the reset
  // queues behind replayed bytes). A program that wants tracking re-enables
  // it itself, and the guard re-arms whenever a subprocess is running.
  useEffect(() => {
    if (terminalStatus !== "running" || terminalHasRunningSubprocess) {
      staleTrackingResetDoneRef.current = false;
      return;
    }
    if (staleTrackingResetDoneRef.current) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    staleTrackingResetDoneRef.current = true;
    terminal.write(TERMINAL_STALE_TRACKING_RESET);
  }, [terminalHasRunningSubprocess, terminalStatus, terminalVersion]);

  useEffect(() => {
    if (!autoFocus || replayOverlayVisible) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    const frame = window.requestAnimationFrame(() => {
      terminal.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [autoFocus, focusRequestId, replayOverlayVisible]);

  useEffect(() => {
    scheduleTerminalLayoutRef.current?.();
  }, [drawerHeight, environmentId, resizeEpoch, terminalId, threadId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      nudgeTerminalLayoutRef.current?.();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [nudgeEpoch]);
  const updateFileDropPreview = (preview: TerminalFileDropPreview | null) => {
    setFileDropPreview((current) =>
      terminalFileDropPreviewsEqual(current, preview) ? current : preview,
    );
  };
  const classifyCurrentFileDrop = (types: Iterable<string>) =>
    classifyTerminalFileDrop(Array.from(types), {
      canResolveOsFilePaths: canResolveOsFilePaths(),
    });
  const handleFileDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    const preview = classifyCurrentFileDrop(event.dataTransfer.types);
    if (preview.kind === "ignore") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = preview.kind === "accept" ? "copy" : "none";
    updateFileDropPreview(preview);
  };
  const handleFileDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    updateFileDropPreview(null);
  };
  const handleFileDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    const preview = classifyCurrentFileDrop(event.dataTransfer.types);
    if (preview.kind === "ignore") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    updateFileDropPreview(null);
    if (preview.kind !== "accept") {
      return;
    }
    const input = collectTerminalDropInput({
      types: Array.from(event.dataTransfer.types),
      files: Array.from(event.dataTransfer.files),
      getData: (type) => event.dataTransfer.getData(type),
      resolveFilePath: (file) => resolveOsFilePath(file, window.desktopBridge?.getPathForFile),
      canResolveOsFilePaths: canResolveOsFilePaths(),
    });
    if (input === null || input.length === 0) {
      const activeTerminal = terminalRef.current;
      if (activeTerminal) {
        writeSystemMessage(activeTerminal, "Could not read a file path from that drop.");
      }
      return;
    }
    void (async () => {
      const result = await writeTerminal(input);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const activeTerminal = terminalRef.current;
        if (!activeTerminal) {
          return;
        }
        const error = squashAtomCommandFailure(result);
        writeSystemMessage(
          activeTerminal,
          error instanceof Error ? error.message : "Failed to type the dropped path",
        );
      }
    })();
  };

  useEffect(() => {
    if (fileDropPreview === null) {
      return;
    }
    const clear = () => setFileDropPreview(null);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, [fileDropPreview]);

  return (
    <div
      ref={paneRef}
      className="relative flex h-full w-full flex-col overflow-hidden rounded-[4px] bg-background"
      // Padding rather than a transform: the xterm container is `flex-1`, so
      // this shrinks the terminal itself and the fit addon reflows to the
      // smaller box. Moving the pane instead would leave rows rendered under
      // the keyboard and simply hide them.
      style={keyboardInset > 0 ? { paddingBottom: keyboardInset } : undefined}
      onDragEnter={handleFileDragOver}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
    >
      <div
        ref={containerRef}
        className="min-h-0 w-full flex-1 overflow-hidden rounded-[4px] bg-background"
      />
      <TerminalMobileKeyBar
        onReadClipboard={() => navigator.clipboard.readText()}
        onSend={(data) => {
          // An interrupt, a history recall or a paste all change the line out
          // from under whatever the dictation buffer last contributed, so stop
          // reconciling against it.
          terminalDictationStateRef.current = emptyTerminalDictationState;
          // Deliberately no focus() here. These bytes go straight to the PTY,
          // so the terminal does not need the caret - and focusing it on a
          // phone raises the software keyboard, which is the opposite of what
          // this bar is for. Whatever had focus keeps it: the keyboard stays
          // down if it was down, and up if it was up.
          void writeTerminal(data);
        }}
      />
      <div
        aria-hidden={!replayOverlayVisible}
        aria-live="polite"
        className={cn(
          "absolute inset-0 z-20 flex items-center justify-center rounded-[4px] bg-background transition-opacity duration-150",
          replayOverlayVisible ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        data-terminal-replay-overlay={replayOverlayVisible ? "visible" : "hidden"}
        role="status"
      >
        <div className="flex max-w-56 items-center gap-3 rounded-[10px] border border-[var(--line)] bg-[var(--card)] px-4 py-3">
          <TerminalSessionIcon className="size-4 text-primary" working={false} />
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">Restoring terminal</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Catching up with session history…
            </p>
          </div>
        </div>
      </div>
      {fileDropPreview && fileDropPreview.kind !== "ignore" ? (
        <TerminalFileDropOverlay preview={fileDropPreview} />
      ) : null}
    </div>
  );
}

interface ThreadTerminalDrawerProps {
  mode?: "drawer" | "panel";
  /**
   * Overrides the keyboard-shortcut owner attribute. The terminal-mode main
   * surface renders in panel mode but its layout lives in the drawer store,
   * so its shortcuts must route through the drawer actions.
   */
  focusOwner?: "drawer" | "right-panel";
  /** Show a per-pane title bar with a drag handle for swapping panes. */
  showPaneHeaders?: boolean;
  /**
   * `tabs` is opt-in fullscreen chrome: one visible pane and a top tab strip.
   * The default `split` layout keeps the nested pane workspace.
   */
  paneLayout?: "split" | "tabs";
  tabStripTrailing?: ReactNode;
  threadRef: ScopedThreadRef;
  threadId: ThreadId;
  cwd: string;
  worktreePath?: string | null;
  runtimeEnv?: Record<string, string>;
  visible?: boolean;
  /** Bumped by the container when the surface returns to view; see TerminalViewport.nudgeEpoch. */
  nudgeEpoch?: number;
  height: number;
  terminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
  focusRequestId: number;
  onSplitTerminal: (terminalId: string) => void;
  onSplitTerminalVertical: (terminalId: string) => void;
  /** Add a pane to the layout; the drawer picks the split direction from the active pane's shape. */
  onNewTerminal: (direction?: "horizontal" | "vertical") => void;
  /** Launch pad: open several panes at once, typing each non-null command into its shell. */
  onLaunchTerminals?: ((commands: ReadonlyArray<string | null>) => void) | undefined;
  /** Installed provider CLIs offered by the launch pad. */
  launchProviders?: ReadonlyArray<TerminalLaunchProvider> | undefined;
  /** Dock the thread's browser as a pane; absent hides the Browser option. */
  onAddBrowserPane?: ((direction?: "horizontal" | "vertical") => void) | undefined;
  /** Renders the browser surface inside a docked pane. */
  renderBrowserPane?: (() => ReactNode) | undefined;
  splitShortcutLabel?: string | undefined;
  splitVerticalShortcutLabel?: string | undefined;
  newShortcutLabel?: string | undefined;
  closeShortcutLabel?: string | undefined;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  onHeightChange: (height: number) => void;
  /**
   * Drag-drop one pane onto another: a center drop swaps them, an edge drop
   * splits the target pane and places the dragged terminal on that side.
   */
  onMoveTerminal?: (
    groupId: string,
    terminalId: string,
    targetTerminalId: string,
    zone: PaneDropZone,
  ) => void;
  /** Sidebar list: drop a terminal before/after another, or onto a group. */
  onMoveTerminalToGroup?: (
    terminalId: string,
    destinationGroupId: string,
    placement: TerminalSidebarPlacement,
  ) => void;
  /** Sidebar list: drop a group before/after another group. */
  onReorderTerminalGroups?: (groupId: string, placement: TerminalGroupListPlacement) => void;
  /** Terminal-mode fullscreen toggle; absent hides the control. */
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
  /** Persist dragged fractions for the split node at `path`; absent disables the dividers. */
  onSplitSizesChange?: (groupId: string, path: number[], sizes: number[]) => void;
  /** Rename a group from its sidebar header; absent disables renaming. */
  onRenameGroup?: (groupId: string, name: string) => void;
  /** Width of the group sidebar in pixels. */
  sidebarWidth?: number;
  /** Persist a dragged sidebar width; absent keeps the sidebar fixed. */
  onSidebarWidthChange?: (width: number) => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  keybindings: ResolvedKeybindingsConfig;
  /** Prefer server-provided tab titles when present (e.g. active subprocess name). */
  terminalLabelsById?: ReadonlyMap<string, string>;
  /** Prefer per-session launch locations when the server already knows a terminal. */
  terminalLaunchLocationsById?: ReadonlyMap<string, TerminalLaunchLocation>;
}

interface TerminalActionButtonProps {
  label: string;
  className: string;
  onClick: () => void;
  children: ReactNode;
}

/** Full-pane overlay while dragging files, images, or text onto a terminal. */
function TerminalFileDropOverlay({ preview }: { preview: TerminalFileDropPreview }) {
  const accepted = preview.kind === "accept";
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-1 z-30 flex items-center justify-center rounded-sm border-2",
        accepted
          ? "border-primary/70 bg-primary/15 text-foreground"
          : "border-destructive/70 bg-destructive/15 text-foreground",
      )}
    >
      <div className="flex max-w-sm flex-col items-center gap-1 px-3 text-center">
        {accepted ? (
          <FilesIcon className="size-5 text-primary" />
        ) : (
          <BanIcon className="size-5 text-destructive" />
        )}
        <span className="text-sm font-medium">{preview.title}</span>
        <span className="text-xs text-muted-foreground">{preview.description}</span>
      </div>
    </div>
  );
}

/**
 * Drop preview while dragging a pane: the center highlights the whole target
 * (swap), an edge highlights the half the dragged terminal would occupy
 * after splitting the target on that side.
 */
function TerminalPaneDropOverlay({ zone }: { zone: PaneDropZone }) {
  const zoneClassName =
    zone === "center"
      ? "inset-1"
      : zone === "left"
        ? "inset-y-1 left-1 w-1/2"
        : zone === "right"
          ? "inset-y-1 right-1 w-1/2"
          : zone === "top"
            ? "inset-x-1 top-1 h-1/2"
            : "inset-x-1 bottom-1 h-1/2";
  return (
    <div
      className={cn(
        "pointer-events-none absolute z-20 rounded-sm border-2 border-primary/60 bg-primary/15",
        zoneClassName,
      )}
    />
  );
}

interface TerminalPaneHeaderProps {
  terminalLabel: string;
  working: boolean;
  driverKind: ReturnType<typeof terminalCommandProviderDriver>;
  draggable: boolean;
  canSplit: boolean;
  splitHorizontalLabel: string;
  splitVerticalLabel: string;
  newTerminalLabel: string;
  closeTerminalLabel: string;
  fullscreen?: boolean;
  /** The focused pane: gold header so the selection reads at a glance. */
  active?: boolean;
  /** Fullscreen only means something with several panes; disabled with one. */
  fullscreenDisabled?: boolean;
  onDragStart?: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragEnd?: () => void;
  onSplitHorizontal: () => void;
  onSplitVertical: () => void;
  onNew: () => void;
  /** Present when a browser pane can be docked; turns the plus into a menu. */
  onNewBrowser?: (() => void) | undefined;
  onClose: () => void;
  onToggleFullscreen?: () => void;
}

const FULLSCREEN_NEEDS_PANES_LABEL = "Fullscreen needs more than one terminal";

/**
 * The plus control: a plain "new terminal" button, or a Terminal/Browser
 * menu when the layout can also dock the thread's browser.
 */
function NewPaneButton({
  className,
  iconClassName,
  label,
  onNewTerminal,
  onNewBrowser,
}: {
  className: string;
  iconClassName: string;
  label: string;
  onNewTerminal: () => void;
  onNewBrowser?: (() => void) | undefined;
}) {
  if (!onNewBrowser) {
    return (
      <TerminalActionButton className={className} onClick={onNewTerminal} label={label}>
        <Plus className={iconClassName} />
      </TerminalActionButton>
    );
  }
  return (
    <Menu>
      <MenuTrigger
        render={<button type="button" className={className} aria-label={label} title={label} />}
      >
        <Plus className={iconClassName} />
      </MenuTrigger>
      <MenuPopup align="end" sideOffset={6} className="min-w-40">
        <MenuItem onClick={onNewTerminal}>
          <SquareSplitHorizontal className="size-3.5" />
          Terminal
        </MenuItem>
        <MenuItem onClick={onNewBrowser}>
          <Globe className="size-3.5" />
          Browser
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** Pane title bar for the terminal main surface: shows the tab heading and doubles as the swap drag handle. */
function TerminalPaneHeader({
  terminalLabel,
  working,
  driverKind,
  draggable,
  canSplit,
  splitHorizontalLabel,
  splitVerticalLabel,
  newTerminalLabel,
  closeTerminalLabel,
  fullscreen = false,
  active = false,
  fullscreenDisabled = false,
  onDragStart,
  onDragEnd,
  onSplitHorizontal,
  onSplitVertical,
  onNew,
  onNewBrowser,
  onClose,
  onToggleFullscreen,
}: TerminalPaneHeaderProps) {
  const actionClassName =
    "rounded-md p-0.5 text-foreground/55 transition-colors hover:bg-surface-hover hover:text-foreground";
  const disabledSplitClassName = "cursor-not-allowed opacity-45 hover:bg-transparent";
  return (
    <div
      className={cn(
        "flex h-6 shrink-0 items-center gap-1.5 border-b px-2 text-[11px] select-none transition-colors",
        active
          ? "border-gold-500/40 bg-gold-500/12 text-gold-200"
          : "border-[var(--line)] bg-surface-row text-foreground/75",
        draggable && "cursor-grab active:cursor-grabbing",
      )}
      draggable={draggable}
      {...(onDragStart ? { onDragStart } : {})}
      {...(onDragEnd ? { onDragEnd } : {})}
      title={
        draggable
          ? `${terminalLabel} — drop on a pane to swap, or on its edge to split it`
          : terminalLabel
      }
    >
      <TerminalSessionIcon
        className="size-3"
        working={working}
        driverKind={driverKind}
        displayName={terminalLabel}
      />
      <span className="min-w-0 truncate">{terminalLabel}</span>
      <div
        className="ml-auto flex shrink-0 items-center gap-0.5"
        onMouseDown={(event) => event.stopPropagation()}
        onDragStart={(event) => event.preventDefault()}
      >
        <TerminalActionButton
          className={cn(actionClassName, !canSplit && disabledSplitClassName)}
          onClick={onSplitHorizontal}
          label={splitHorizontalLabel}
        >
          <SquareSplitHorizontal className="size-3" />
        </TerminalActionButton>
        <TerminalActionButton
          className={cn(actionClassName, !canSplit && disabledSplitClassName)}
          onClick={onSplitVertical}
          label={splitVerticalLabel}
        >
          <SquareSplitVertical className="size-3" />
        </TerminalActionButton>
        <NewPaneButton
          className={actionClassName}
          iconClassName="size-3"
          label={newTerminalLabel}
          onNewTerminal={onNew}
          onNewBrowser={onNewBrowser}
        />
        <TerminalActionButton
          className={actionClassName}
          onClick={onClose}
          label={closeTerminalLabel}
        >
          <Trash2 className="size-3" />
        </TerminalActionButton>
        {onToggleFullscreen ? (
          <TerminalActionButton
            className={cn(actionClassName, fullscreenDisabled && disabledSplitClassName)}
            onClick={fullscreenDisabled ? () => {} : onToggleFullscreen}
            label={
              fullscreenDisabled
                ? FULLSCREEN_NEEDS_PANES_LABEL
                : fullscreen
                  ? "Exit terminal fullscreen"
                  : "Enter terminal fullscreen"
            }
          >
            {fullscreen ? (
              <Minimize2Icon className="size-3" />
            ) : (
              <Maximize2Icon className="size-3" />
            )}
          </TerminalActionButton>
        ) : null}
      </div>
    </div>
  );
}

function TerminalActionButton({ label, className, onClick, children }: TerminalActionButtonProps) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        render={<button type="button" className={className} onClick={onClick} aria-label={label} />}
      >
        {children}
      </PopoverTrigger>
      <PopoverPopup
        tooltipStyle
        side="bottom"
        sideOffset={6}
        align="center"
        className="pointer-events-none select-none"
      >
        {label}
      </PopoverPopup>
    </Popover>
  );
}

export default function ThreadTerminalDrawer({
  mode = "drawer",
  focusOwner,
  showPaneHeaders = false,
  paneLayout = "split",
  tabStripTrailing,
  threadRef,
  threadId,
  cwd,
  worktreePath,
  runtimeEnv,
  visible = true,
  nudgeEpoch,
  height,
  terminalIds,
  activeTerminalId,
  terminalGroups,
  activeTerminalGroupId,
  focusRequestId,
  onSplitTerminal,
  onSplitTerminalVertical,
  onNewTerminal,
  onLaunchTerminals,
  launchProviders,
  onAddBrowserPane,
  renderBrowserPane,
  splitShortcutLabel,
  splitVerticalShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  onActiveTerminalChange,
  onCloseTerminal,
  onHeightChange,
  onMoveTerminal,
  onMoveTerminalToGroup,
  onReorderTerminalGroups,
  fullscreen = false,
  onToggleFullscreen,
  onSplitSizesChange,
  onRenameGroup,
  sidebarWidth,
  onSidebarWidthChange,
  onAddTerminalContext,
  keybindings,
  terminalLabelsById,
  terminalLaunchLocationsById,
}: ThreadTerminalDrawerProps) {
  const isPanel = mode === "panel";
  const terminalThreadStateKey = scopedThreadKey(threadRef);
  const locallyOpeningTerminalIds = useTerminalUiStateStore(
    (state) =>
      state.pendingOpenTerminalIdsByThreadKey[terminalThreadStateKey] ?? EMPTY_TERMINAL_IDS,
  );
  const locallyOpeningTerminalIdSet = useMemo(
    () => new Set(locallyOpeningTerminalIds),
    [locallyOpeningTerminalIds],
  );
  const controlledDrawerHeight = clampDrawerHeight(height);
  const [drawerHeightState, setDrawerHeightState] = useState(() => ({
    threadId,
    height: controlledDrawerHeight,
  }));
  const drawerHeight =
    drawerHeightState.threadId === threadId ? drawerHeightState.height : controlledDrawerHeight;
  const setDrawerHeight = useCallback(
    (update: SetStateAction<number>) => {
      setDrawerHeightState((current) => {
        const currentHeight =
          current.threadId === threadId ? current.height : controlledDrawerHeight;
        const nextHeight = typeof update === "function" ? update(currentHeight) : update;
        return nextHeight === currentHeight && current.threadId === threadId
          ? current
          : { threadId, height: nextHeight };
      });
    },
    [controlledDrawerHeight, threadId],
  );
  const setDrawerHeightFromWindowResize = useEffectEvent((nextHeight: number) => {
    setDrawerHeight(nextHeight);
  });
  const [resizeEpoch, setResizeEpoch] = useState(0);
  const drawerHeightRef = useRef(drawerHeight);
  const lastSyncedHeightRef = useRef(controlledDrawerHeight);
  const onHeightChangeRef = useRef(onHeightChange);
  const resizeStateRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);
  const didResizeDuringDragRef = useRef(false);
  const [groupRenameDraft, setGroupRenameDraft] = useState<{
    groupId: string;
    name: string;
  } | null>(null);
  const [sidebarWidthDraft, setSidebarWidthDraft] = useState<number | null>(null);
  const sidebarResizeRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);
  const clampSidebarWidth = (width: number) =>
    Math.min(MAX_TERMINAL_SIDEBAR_WIDTH, Math.max(MIN_TERMINAL_SIDEBAR_WIDTH, width));
  const effectiveSidebarWidth = clampSidebarWidth(
    sidebarWidthDraft ?? sidebarWidth ?? DEFAULT_TERMINAL_SIDEBAR_WIDTH,
  );
  const handleSidebarResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!onSidebarWidthChange) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    sidebarResizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: effectiveSidebarWidth,
    };
  };
  const handleSidebarResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = sidebarResizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    // The sidebar sits on the right edge, so dragging its left edge leftward
    // widens it.
    setSidebarWidthDraft(clampSidebarWidth(drag.startWidth + (drag.startX - event.clientX)));
  };
  const handleSidebarResizePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = sidebarResizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    sidebarResizeRef.current = null;
    setSidebarWidthDraft(null);
    onSidebarWidthChange?.(clampSidebarWidth(drag.startWidth + (drag.startX - event.clientX)));
  };
  const commitGroupRename = () => {
    if (groupRenameDraft === null) return;
    onRenameGroup?.(groupRenameDraft.groupId, groupRenameDraft.name);
    setGroupRenameDraft(null);
  };

  const normalizedTerminalIds = useMemo(() => {
    const normalizedIds: string[] = [];
    const seen = new Set<string>();
    for (const id of terminalIds) {
      const trimmedId = id.trim();
      if (trimmedId.length === 0 || seen.has(trimmedId)) continue;
      seen.add(trimmedId);
      normalizedIds.push(trimmedId);
    }
    return normalizedIds;
  }, [terminalIds]);

  const resolvedActiveTerminalId =
    normalizedTerminalIds.length === 0
      ? ""
      : normalizedTerminalIds.includes(activeTerminalId)
        ? activeTerminalId
        : (normalizedTerminalIds[0] ?? "");

  const resolvedTerminalGroups = useMemo(() => {
    if (normalizedTerminalIds.length === 0) {
      return [];
    }
    const validTerminalIdSet = new Set(normalizedTerminalIds);
    const assignedTerminalIds = new Set<string>();
    const usedGroupIds = new Set<string>();
    const nextGroups: ThreadTerminalGroup[] = [];

    const assignUniqueGroupId = (groupId: string): string => {
      if (!usedGroupIds.has(groupId)) {
        usedGroupIds.add(groupId);
        return groupId;
      }
      let suffix = 2;
      while (usedGroupIds.has(`${groupId}-${suffix}`)) {
        suffix += 1;
      }
      const uniqueGroupId = `${groupId}-${suffix}`;
      usedGroupIds.add(uniqueGroupId);
      return uniqueGroupId;
    };

    for (const terminalGroup of terminalGroups) {
      const nextTerminalIds: string[] = [];
      const seenGroupTerminalIds = new Set<string>();
      for (const id of terminalGroup.terminalIds) {
        const terminalId = id.trim();
        if (terminalId.length === 0) continue;
        if (seenGroupTerminalIds.has(terminalId)) continue;
        seenGroupTerminalIds.add(terminalId);
        if (!validTerminalIdSet.has(terminalId)) continue;
        if (assignedTerminalIds.has(terminalId)) continue;
        nextTerminalIds.push(terminalId);
      }
      if (nextTerminalIds.length === 0) continue;

      for (const terminalId of nextTerminalIds) {
        assignedTerminalIds.add(terminalId);
      }

      const baseGroupId =
        terminalGroup.id.trim().length > 0
          ? terminalGroup.id.trim()
          : `group-${nextTerminalIds[0] ?? normalizedTerminalIds[0] ?? ""}`;
      nextGroups.push({
        id: assignUniqueGroupId(baseGroupId),
        terminalIds: nextTerminalIds,
        ...(terminalGroup.splitDirection === "vertical"
          ? { splitDirection: "vertical" as const }
          : {}),
        ...(terminalGroup.paneSizes && terminalGroup.paneSizes.length === nextTerminalIds.length
          ? { paneSizes: [...terminalGroup.paneSizes] }
          : {}),
        ...(terminalGroup.layout ? { layout: terminalGroup.layout } : {}),
      });
    }

    for (const terminalId of normalizedTerminalIds) {
      if (assignedTerminalIds.has(terminalId)) continue;
      nextGroups.push({
        id: assignUniqueGroupId(`group-${terminalId}`),
        terminalIds: [terminalId],
      });
    }

    const terminalOrderIndex = new Map(
      normalizedTerminalIds.map((id, index) => [id, index] as const),
    );
    nextGroups.sort((left, right) => {
      const rank = (ids: readonly string[]) =>
        Math.min(...ids.map((id) => terminalOrderIndex.get(id) ?? Number.POSITIVE_INFINITY));
      return rank(left.terminalIds) - rank(right.terminalIds);
    });

    return nextGroups;
  }, [normalizedTerminalIds, terminalGroups]);

  const resolvedActiveGroupIndex = useMemo(() => {
    const indexById = resolvedTerminalGroups.findIndex(
      (terminalGroup) => terminalGroup.id === activeTerminalGroupId,
    );
    if (indexById >= 0) return indexById;
    const indexByTerminal = resolvedTerminalGroups.findIndex((terminalGroup) =>
      terminalGroup.terminalIds.includes(resolvedActiveTerminalId),
    );
    return indexByTerminal >= 0 ? indexByTerminal : 0;
  }, [activeTerminalGroupId, resolvedActiveTerminalId, resolvedTerminalGroups]);

  const visibleTerminalIds =
    resolvedTerminalGroups[resolvedActiveGroupIndex]?.terminalIds ??
    (normalizedTerminalIds.length > 0 ? [resolvedActiveTerminalId] : []);
  const activeTerminalGroup = resolvedTerminalGroups[resolvedActiveGroupIndex];
  const activeGroupIdResolved = activeTerminalGroup?.id ?? "";
  const activeGroupLayout = useMemo(
    () =>
      activeTerminalGroup
        ? normalizeGroupLayout(activeTerminalGroup.layout, activeTerminalGroup.terminalIds, {
            ...(activeTerminalGroup.splitDirection !== undefined
              ? { splitDirection: activeTerminalGroup.splitDirection }
              : {}),
            ...(activeTerminalGroup.paneSizes !== undefined
              ? { paneSizes: activeTerminalGroup.paneSizes }
              : {}),
          })
        : undefined,
    [activeTerminalGroup],
  );
  const [splitSizesDraft, setSplitSizesDraft] = useState<{
    groupId: string;
    pathKey: string;
    sizes: number[];
  } | null>(null);
  const splitSizesDraftRef = useRef(splitSizesDraft);
  splitSizesDraftRef.current = splitSizesDraft;
  const splitDividerDragRef = useRef<{
    pointerId: number;
    path: number[];
    pathKey: string;
    index: number;
    direction: "horizontal" | "vertical";
    startCoord: number;
    startSizes: number[];
    containerSpan: number;
  } | null>(null);
  const handleSplitDividerPointerDown =
    (path: number[], index: number, direction: "horizontal" | "vertical", sizes: number[]) =>
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const container = event.currentTarget.parentElement;
      if (!container) return;
      const bounds = container.getBoundingClientRect();
      const containerSpan = direction === "vertical" ? bounds.height : bounds.width;
      if (containerSpan <= 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      splitDividerDragRef.current = {
        pointerId: event.pointerId,
        path,
        pathKey: path.join("."),
        index,
        direction,
        startCoord: direction === "vertical" ? event.clientY : event.clientX,
        startSizes: [...sizes],
        containerSpan,
      };
    };
  const handleSplitDividerPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = splitDividerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const coord = drag.direction === "vertical" ? event.clientY : event.clientX;
    const deltaFraction = (coord - drag.startCoord) / drag.containerSpan;
    const sizes = [...drag.startSizes];
    const nearSize = sizes[drag.index] ?? 0;
    const farSize = sizes[drag.index + 1] ?? 0;
    const pairTotal = nearSize + farSize;
    if (pairTotal <= MIN_PANE_FRACTION * 2) return;
    const nextNearSize = Math.min(
      Math.max(nearSize + deltaFraction, MIN_PANE_FRACTION),
      pairTotal - MIN_PANE_FRACTION,
    );
    sizes[drag.index] = nextNearSize;
    sizes[drag.index + 1] = pairTotal - nextNearSize;
    setSplitSizesDraft({ groupId: activeGroupIdResolved, pathKey: drag.pathKey, sizes });
  };
  const handleSplitDividerPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = splitDividerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    splitDividerDragRef.current = null;
    const draft = splitSizesDraftRef.current;
    if (draft && draft.groupId === activeGroupIdResolved && draft.pathKey === drag.pathKey) {
      onSplitSizesChange?.(activeGroupIdResolved, drag.path, draft.sizes);
    }
    setSplitSizesDraft(null);
  };
  const draggedTerminalIdRef = useRef<string | null>(null);
  const draggedGroupIdRef = useRef<string | null>(null);
  const [paneDropTarget, setPaneDropTarget] = useState<{
    terminalId: string;
    zone: PaneDropZone;
  } | null>(null);
  const [sidebarDropTarget, setSidebarDropTargetState] = useState<SidebarDropTarget | null>(null);
  const sidebarDropTargetRef = useRef<SidebarDropTarget | null>(null);
  const setSidebarDropTarget = (update: SetStateAction<SidebarDropTarget | null>) => {
    setSidebarDropTargetState((current) => {
      const next = typeof update === "function" ? update(current) : update;
      sidebarDropTargetRef.current = next;
      return next;
    });
  };
  const canDragSidebarTerminals = onMoveTerminalToGroup !== undefined;
  // Groups still exist in the data (a group is the set of panes a split shows
  // together) but the list never shows them: one flat list of terminals,
  // no headers, no group drag. Grouping was a concept nobody asked for.
  const canDragSidebarGroups = false;
  const clearSidebarDrag = () => {
    draggedGroupIdRef.current = null;
    setSidebarDropTarget(null);
  };
  const groupCanAcceptTerminal = (group: ThreadTerminalGroup, terminalId: string) =>
    group.terminalIds.includes(terminalId) || group.terminalIds.length < MAX_TERMINALS_PER_GROUP;
  const beginTerminalDrag = (event: ReactDragEvent, terminalId: string) => {
    draggedTerminalIdRef.current = terminalId;
    draggedGroupIdRef.current = null;
    event.dataTransfer.setData(TERMINAL_PANE_DRAG_MIME, terminalId);
    event.dataTransfer.effectAllowed = "move";
  };
  const beginGroupDrag = (event: ReactDragEvent, groupId: string) => {
    draggedGroupIdRef.current = groupId;
    draggedTerminalIdRef.current = null;
    event.dataTransfer.setData(TERMINAL_GROUP_DRAG_MIME, groupId);
    event.dataTransfer.effectAllowed = "move";
  };
  const commitSidebarDrop = () => {
    const target = sidebarDropTargetRef.current;
    const draggedTerminalId = draggedTerminalIdRef.current;
    const draggedGroupId = draggedGroupIdRef.current;
    draggedTerminalIdRef.current = null;
    clearSidebarDrag();
    if (!target) {
      return;
    }
    if (draggedTerminalId && onMoveTerminalToGroup) {
      if (target.kind === "terminal") {
        onMoveTerminalToGroup(draggedTerminalId, target.groupId, {
          type: target.placement,
          terminalId: target.terminalId,
        });
        return;
      }
      onMoveTerminalToGroup(draggedTerminalId, target.groupId, { type: "end" });
      return;
    }
    if (draggedGroupId && onReorderTerminalGroups && target.kind === "group") {
      if (target.placement === "into" || target.groupId === draggedGroupId) {
        return;
      }
      onReorderTerminalGroups(draggedGroupId, {
        type: target.placement,
        groupId: target.groupId,
      });
    }
  };
  const isTabLayout = paneLayout === "tabs";
  const hasTerminalSidebar = !isTabLayout && normalizedTerminalIds.length > 1;
  const isSplitView = !isTabLayout && visibleTerminalIds.length > 1;
  const showGroupHeaders = false;
  const hasReachedSplitLimit = visibleTerminalIds.length >= MAX_TERMINALS_PER_GROUP;
  const terminalLabelById = useMemo(() => {
    const next = new Map<string, string>();
    for (const terminalId of normalizedTerminalIds) {
      next.set(terminalId, terminalLabelsById?.get(terminalId) ?? getTerminalLabel(terminalId));
    }
    return next;
  }, [normalizedTerminalIds, terminalLabelsById]);
  const knownSessions = useKnownTerminalSessions({
    environmentId: threadRef.environmentId,
    threadId,
  });
  const terminalAppearanceById = useMemo(() => {
    const next = new Map<
      string,
      { working: boolean; driverKind: ReturnType<typeof terminalCommandProviderDriver> }
    >();
    for (const session of knownSessions) {
      next.set(session.target.terminalId, {
        working: session.state.working,
        driverKind: terminalCommandProviderDriver(session.state.summary?.label),
      });
    }
    return next;
  }, [knownSessions]);
  const resolveTerminalLaunchLocation = useCallback(
    (terminalId: string): TerminalLaunchLocation => {
      return (
        terminalLaunchLocationsById?.get(terminalId) ?? {
          cwd,
          ...(worktreePath !== undefined ? { worktreePath } : {}),
          ...(runtimeEnv ? { runtimeEnv } : {}),
        }
      );
    },
    [cwd, runtimeEnv, terminalLaunchLocationsById, worktreePath],
  );
  const splitTerminalActionLabel = hasReachedSplitLimit
    ? `Split Terminal Horizontally (max ${MAX_TERMINALS_PER_GROUP} panes)`
    : splitShortcutLabel
      ? `Split Terminal Horizontally (${splitShortcutLabel})`
      : "Split Terminal Horizontally";
  const splitTerminalVerticalActionLabel = hasReachedSplitLimit
    ? `Split Terminal Vertically (max ${MAX_TERMINALS_PER_GROUP} panes)`
    : splitVerticalShortcutLabel
      ? `Split Terminal Vertically (${splitVerticalShortcutLabel})`
      : "Split Terminal Vertically";
  const canAddPane =
    isPanel || (activeTerminalGroup?.terminalIds.length ?? 0) < MAX_TERMINALS_PER_GROUP;
  // A lone pane already fills the workspace, so fullscreen has nothing to do.
  const canToggleFullscreen = normalizedTerminalIds.length > 1;
  const newTerminalActionLabel = !canAddPane
    ? `New Terminal (max ${MAX_TERMINALS_PER_GROUP} panes)`
    : newShortcutLabel
      ? `New Terminal (${newShortcutLabel})`
      : "New Terminal";
  const closeTerminalActionLabel = closeShortcutLabel
    ? `Close Terminal (${closeShortcutLabel})`
    : "Close Terminal";
  const canSplitTerminal = useCallback(
    (terminalId: string) => {
      const group = resolvedTerminalGroups.find((candidate) =>
        candidate.terminalIds.includes(terminalId),
      );
      return (group?.terminalIds.length ?? 0) < MAX_TERMINALS_PER_GROUP;
    },
    [resolvedTerminalGroups],
  );
  const splitHorizontalLabelFor = useCallback(
    (terminalId: string) =>
      canSplitTerminal(terminalId)
        ? splitShortcutLabel
          ? `Split Terminal Horizontally (${splitShortcutLabel})`
          : "Split Terminal Horizontally"
        : `Split Terminal Horizontally (max ${MAX_TERMINALS_PER_GROUP} panes)`,
    [canSplitTerminal, splitShortcutLabel],
  );
  const splitVerticalLabelFor = useCallback(
    (terminalId: string) =>
      canSplitTerminal(terminalId)
        ? splitVerticalShortcutLabel
          ? `Split Terminal Vertically (${splitVerticalShortcutLabel})`
          : "Split Terminal Vertically"
        : `Split Terminal Vertically (max ${MAX_TERMINALS_PER_GROUP} panes)`,
    [canSplitTerminal, splitVerticalShortcutLabel],
  );
  const onSplitTerminalAction = useCallback(
    (terminalId: string) => {
      if (!canSplitTerminal(terminalId)) return;
      onSplitTerminal(terminalId);
    },
    [canSplitTerminal, onSplitTerminal],
  );
  const onSplitTerminalVerticalAction = useCallback(
    (terminalId: string) => {
      if (!canSplitTerminal(terminalId)) return;
      onSplitTerminalVertical(terminalId);
    },
    [canSplitTerminal, onSplitTerminalVertical],
  );
  // Side by side when the active pane is wide, stacked when it is tall, so a
  // fresh pane lands where there is room instead of always slicing one axis.
  const resolveNewPaneDirection = useCallback((): "horizontal" | "vertical" => {
    const pane =
      typeof document === "undefined"
        ? null
        : document.querySelector<HTMLElement>(
            `[data-terminal-pane-id="${CSS.escape(resolvedActiveTerminalId)}"]`,
          );
    if (!pane) return "horizontal";
    const rect = pane.getBoundingClientRect();
    return rect.width >= rect.height * 1.2 ? "horizontal" : "vertical";
  }, [resolvedActiveTerminalId]);
  const onNewTerminalAction = useCallback(() => {
    if (!canAddPane) return;
    onNewTerminal(resolveNewPaneDirection());
  }, [canAddPane, onNewTerminal, resolveNewPaneDirection]);
  const onNewBrowserAction = useMemo(
    () =>
      onAddBrowserPane
        ? () => {
            onAddBrowserPane(resolveNewPaneDirection());
          }
        : undefined,
    [onAddBrowserPane, resolveNewPaneDirection],
  );
  const paneHeaderProps = (terminalId: string) => ({
    terminalLabel: terminalLabelById.get(terminalId) ?? "Terminal",
    working: terminalAppearanceById.get(terminalId)?.working === true,
    driverKind: terminalAppearanceById.get(terminalId)?.driverKind ?? null,
    canSplit: canSplitTerminal(terminalId),
    splitHorizontalLabel: splitHorizontalLabelFor(terminalId),
    splitVerticalLabel: splitVerticalLabelFor(terminalId),
    newTerminalLabel: newTerminalActionLabel,
    closeTerminalLabel: `Close ${terminalLabelById.get(terminalId) ?? "terminal"}${
      terminalId === resolvedActiveTerminalId && closeShortcutLabel
        ? ` (${closeShortcutLabel})`
        : ""
    }`,
    ...(onToggleFullscreen !== undefined
      ? { fullscreen, onToggleFullscreen, fullscreenDisabled: !canToggleFullscreen }
      : {}),
    onSplitHorizontal: () => onSplitTerminalAction(terminalId),
    onSplitVertical: () => onSplitTerminalVerticalAction(terminalId),
    onNew: onNewTerminalAction,
    onNewBrowser: onNewBrowserAction,
    active: terminalId === resolvedActiveTerminalId,
    onClose: () => onCloseTerminal(terminalId),
  });

  useEffect(() => {
    onHeightChangeRef.current = onHeightChange;
  }, [onHeightChange]);

  useEffect(() => {
    drawerHeightRef.current = drawerHeight;
  }, [drawerHeight]);

  const syncHeight = useCallback((nextHeight: number) => {
    const clampedHeight = clampDrawerHeight(nextHeight);
    if (lastSyncedHeightRef.current === clampedHeight) return;
    lastSyncedHeightRef.current = clampedHeight;
    onHeightChangeRef.current(clampedHeight);
  }, []);

  useEffect(() => {
    lastSyncedHeightRef.current = controlledDrawerHeight;
  }, [controlledDrawerHeight, threadId]);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    didResizeDuringDragRef.current = false;
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: drawerHeightRef.current,
    };
  }, []);

  const handleResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      event.preventDefault();
      const clampedHeight = clampDrawerHeight(
        resizeState.startHeight + (resizeState.startY - event.clientY),
      );
      if (clampedHeight === drawerHeightRef.current) {
        return;
      }
      didResizeDuringDragRef.current = true;
      drawerHeightRef.current = clampedHeight;
      setDrawerHeight(clampedHeight);
    },
    [setDrawerHeight],
  );

  const handleResizePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      resizeStateRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!didResizeDuringDragRef.current) {
        return;
      }
      syncHeight(drawerHeightRef.current);
      setResizeEpoch((value) => value + 1);
    },
    [syncHeight],
  );

  useEffect(() => {
    if (!visible) {
      return;
    }

    const onWindowResize = () => {
      const clampedHeight = clampDrawerHeight(drawerHeightRef.current);
      const changed = clampedHeight !== drawerHeightRef.current;
      if (changed) {
        setDrawerHeightFromWindowResize(clampedHeight);
        drawerHeightRef.current = clampedHeight;
      }
      if (!resizeStateRef.current) {
        syncHeight(clampedHeight);
      }
      setResizeEpoch((value) => value + 1);
    };
    window.addEventListener("resize", onWindowResize);
    return () => {
      window.removeEventListener("resize", onWindowResize);
    };
  }, [syncHeight, visible]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    setResizeEpoch((value) => value + 1);
  }, [visible]);

  useEffect(() => {
    return () => {
      syncHeight(drawerHeightRef.current);
    };
  }, [syncHeight]);

  if (normalizedTerminalIds.length === 0) {
    return (
      <aside
        data-terminal-owner={focusOwner ?? (isPanel ? "right-panel" : "drawer")}
        className={cn(
          "thread-terminal-drawer relative flex min-w-0 flex-col overflow-hidden bg-background",
          isPanel ? "h-full flex-1" : "shrink-0 border-t border-[var(--line)]",
        )}
        style={isPanel ? undefined : { height: `${drawerHeight}px` }}
      >
        {!isPanel ? (
          <div
            className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handleResizePointerEnd}
            onPointerCancel={handleResizePointerEnd}
          />
        ) : null}
        {isTabLayout ? (
          <div className="flex h-8 shrink-0 items-center justify-end gap-0.5 border-b border-[var(--line)] px-1.5">
            {tabStripTrailing}
          </div>
        ) : null}
        {onLaunchTerminals ? (
          <TerminalLaunchPad
            providers={launchProviders ?? []}
            maxTerminals={MAX_TERMINALS_PER_GROUP}
            onLaunch={onLaunchTerminals}
            onAddBrowser={onNewBrowserAction}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 py-6 text-center text-sm text-muted-foreground">
            <p>No terminal sessions for this thread yet.</p>
            <button
              type="button"
              className="rounded-[10px] border border-[var(--line)] bg-surface-row px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-hover"
              onClick={onNewTerminalAction}
            >
              {newTerminalActionLabel}
            </button>
          </div>
        )}
      </aside>
    );
  }

  const activeTerminalLaunchLocation = resolveTerminalLaunchLocation(resolvedActiveTerminalId);

  const renderTerminalPane = (terminalId: string): ReactNode => {
    const terminalLaunchLocation = resolveTerminalLaunchLocation(terminalId);
    const dropZone = paneDropTarget?.terminalId === terminalId ? paneDropTarget.zone : null;
    return (
      <div
        data-terminal-pane-id={terminalId}
        data-active={terminalId === resolvedActiveTerminalId ? "true" : undefined}
        className={`relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[8px] border transition-[border-color,box-shadow] ${
          terminalId === resolvedActiveTerminalId
            ? "border-gold-500/70 shadow-[0_0_0_1px_rgba(217,169,58,0.28),0_0_28px_-6px_rgba(217,169,58,0.55)]"
            : "border-[var(--line)]"
        }`}
        onMouseDown={() => {
          if (terminalId !== resolvedActiveTerminalId) {
            onActiveTerminalChange(terminalId);
          }
        }}
        {...(onMoveTerminal
          ? {
              onDragOver: (event: ReactDragEvent<HTMLDivElement>) => {
                if (!event.dataTransfer.types.includes(TERMINAL_PANE_DRAG_MIME)) {
                  return;
                }
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                if (draggedTerminalIdRef.current === terminalId) {
                  setPaneDropTarget((current) => (current === null ? current : null));
                  return;
                }
                const bounds = event.currentTarget.getBoundingClientRect();
                const zone = paneDropZoneForPoint({
                  x: event.clientX - bounds.left,
                  y: event.clientY - bounds.top,
                  width: bounds.width,
                  height: bounds.height,
                });
                setPaneDropTarget((current) =>
                  current?.terminalId === terminalId && current.zone === zone
                    ? current
                    : { terminalId, zone },
                );
              },
              onDragLeave: (event: ReactDragEvent<HTMLDivElement>) => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  return;
                }
                setPaneDropTarget((current) =>
                  current?.terminalId === terminalId ? null : current,
                );
              },
              onDrop: (event: ReactDragEvent<HTMLDivElement>) => {
                const draggedTerminalId =
                  event.dataTransfer.getData(TERMINAL_PANE_DRAG_MIME) ||
                  draggedTerminalIdRef.current;
                const zone =
                  paneDropTarget?.terminalId === terminalId ? paneDropTarget.zone : "center";
                draggedTerminalIdRef.current = null;
                setPaneDropTarget(null);
                if (!draggedTerminalId || draggedTerminalId === terminalId) {
                  return;
                }
                event.preventDefault();
                onMoveTerminal(activeGroupIdResolved, draggedTerminalId, terminalId, zone);
              },
            }
          : {})}
      >
        {showPaneHeaders ? (
          <TerminalPaneHeader
            {...paneHeaderProps(terminalId)}
            draggable={onMoveTerminal !== undefined}
            onDragStart={(event) => {
              beginTerminalDrag(event, terminalId);
            }}
            onDragEnd={() => {
              draggedTerminalIdRef.current = null;
              setPaneDropTarget(null);
              clearSidebarDrag();
            }}
          />
        ) : null}
        {isBrowserPaneId(terminalId) ? (
          <div className="min-h-0 flex-1 overflow-hidden">
            {renderBrowserPane ? (
              renderBrowserPane()
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                Browser is not available here.
              </div>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 p-1">
            <TerminalViewport
              threadRef={threadRef}
              threadId={threadId}
              terminalId={terminalId}
              terminalLabel={terminalLabelById.get(terminalId) ?? "Terminal"}
              cwd={terminalLaunchLocation.cwd}
              {...(terminalLaunchLocation.worktreePath !== undefined
                ? { worktreePath: terminalLaunchLocation.worktreePath }
                : {})}
              {...(terminalLaunchLocation.runtimeEnv
                ? { runtimeEnv: terminalLaunchLocation.runtimeEnv }
                : {})}
              onSessionExited={() => onCloseTerminal(terminalId)}
              onAddTerminalContext={onAddTerminalContext}
              focusRequestId={focusRequestId}
              autoFocus={terminalId === resolvedActiveTerminalId}
              surfaceVisible={visible}
              locallyOpening={locallyOpeningTerminalIdSet.has(terminalId)}
              resizeEpoch={resizeEpoch}
              {...(nudgeEpoch !== undefined ? { nudgeEpoch } : {})}
              drawerHeight={drawerHeight}
              keybindings={keybindings}
            />
          </div>
        )}
        {dropZone ? <TerminalPaneDropOverlay zone={dropZone} /> : null}
      </div>
    );
  };

  const renderLayoutNode = (node: TerminalPaneLayout, path: number[]): ReactNode => {
    if (node.kind === "terminal") {
      return renderTerminalPane(node.terminalId);
    }
    const pathKey = path.join(".");
    const draftSizes =
      splitSizesDraft &&
      splitSizesDraft.groupId === activeGroupIdResolved &&
      splitSizesDraft.pathKey === pathKey &&
      splitSizesDraft.sizes.length === node.children.length
        ? splitSizesDraft.sizes
        : null;
    const sizes =
      draftSizes ??
      (node.sizes && node.sizes.length === node.children.length
        ? node.sizes
        : node.children.map(() => 1 / node.children.length));
    return (
      <div
        className={`flex h-full min-h-0 w-full min-w-0 overflow-hidden ${
          node.direction === "vertical" ? "flex-col" : "flex-row"
        }`}
      >
        {node.children.map((child, index) => {
          const childKey =
            child.kind === "terminal"
              ? child.terminalId
              : `split:${layoutLeafIds(child)[0] ?? index}`;
          return (
            <Fragment key={childKey}>
              {index > 0 ? (
                // Dragging only makes sense when the container can persist
                // the fractions; otherwise render a plain separator instead
                // of a divider that snaps back.
                <div
                  className={`z-10 shrink-0 bg-border/70 ${
                    node.direction === "vertical" ? "h-1 w-full" : "h-full w-1"
                  } ${
                    onSplitSizesChange
                      ? `transition-colors hover:bg-gold-500/70 ${
                          node.direction === "vertical" ? "cursor-row-resize" : "cursor-col-resize"
                        }`
                      : ""
                  }`}
                  {...(onSplitSizesChange
                    ? {
                        onPointerDown: handleSplitDividerPointerDown(
                          path,
                          index - 1,
                          node.direction,
                          sizes,
                        ),
                        onPointerMove: handleSplitDividerPointerMove,
                        onPointerUp: handleSplitDividerPointerEnd,
                        onPointerCancel: handleSplitDividerPointerEnd,
                      }
                    : {})}
                />
              ) : null}
              <div
                className="flex min-h-0 min-w-0"
                style={{ flexGrow: sizes[index] ?? 1, flexShrink: 1, flexBasis: 0 }}
              >
                {renderLayoutNode(child, [...path, index])}
              </div>
            </Fragment>
          );
        })}
      </div>
    );
  };

  return (
    <aside
      data-terminal-owner={focusOwner ?? (isPanel ? "right-panel" : "drawer")}
      className={cn(
        "thread-terminal-drawer relative flex min-w-0 flex-col overflow-hidden bg-background",
        isPanel ? "h-full flex-1" : "shrink-0 border-t border-[var(--line)]",
      )}
      style={isPanel ? undefined : { height: `${drawerHeight}px` }}
    >
      {!isPanel ? (
        <div
          className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerEnd}
          onPointerCancel={handleResizePointerEnd}
        />
      ) : null}

      {isTabLayout ? (
        <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-[var(--line)] px-1.5">
          <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
            {normalizedTerminalIds.map((terminalId) => {
              const isActive = terminalId === resolvedActiveTerminalId;
              const label = terminalLabelById.get(terminalId) ?? "Terminal";
              const appearance = terminalAppearanceById.get(terminalId);
              return (
                <div
                  key={terminalId}
                  className={cn(
                    // A tab is text with a gold hairline beneath the active one;
                    // no boxes, so switching reads as instant.
                    "group relative flex h-full max-w-48 min-w-0 shrink-0 items-center gap-1 px-2.5 text-[11.5px] font-medium transition-colors after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:transition-colors",
                    isActive
                      ? "bg-gold-500/10 text-gold-700 after:bg-gold-500 dark:text-gold-200"
                      : "text-muted-foreground after:bg-transparent hover:text-foreground",
                  )}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    onClick={() => onActiveTerminalChange(terminalId)}
                  >
                    <TerminalSessionIcon
                      className="size-3"
                      working={appearance?.working === true}
                      driverKind={appearance?.driverKind ?? null}
                      displayName={label}
                    />
                    <span className="truncate">{label}</span>
                  </button>
                  {normalizedTerminalIds.length > 1 ? (
                    <button
                      type="button"
                      className="rounded-md p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-surface-hover hover:text-foreground group-hover:opacity-100 pointer-coarse:opacity-100"
                      aria-label={`Close ${label}`}
                      onClick={() => onCloseTerminal(terminalId)}
                    >
                      <XIcon className="size-2.5" />
                    </button>
                  ) : null}
                </div>
              );
            })}
            <NewPaneButton
              className="mx-0.5 rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
              iconClassName="size-3.25"
              label={newTerminalActionLabel}
              onNewTerminal={onNewTerminalAction}
              onNewBrowser={onNewBrowserAction}
            />
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {tabStripTrailing}
            {onToggleFullscreen ? (
              <TerminalActionButton
                className={cn(
                  "rounded-md p-1 text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground",
                  !canToggleFullscreen && "cursor-not-allowed opacity-45 hover:bg-transparent",
                )}
                onClick={canToggleFullscreen ? onToggleFullscreen : () => {}}
                label={
                  !canToggleFullscreen
                    ? FULLSCREEN_NEEDS_PANES_LABEL
                    : fullscreen
                      ? "Exit terminal fullscreen"
                      : "Enter terminal fullscreen"
                }
              >
                {fullscreen ? (
                  <Minimize2Icon className="size-3.25" />
                ) : (
                  <Maximize2Icon className="size-3.25" />
                )}
              </TerminalActionButton>
            ) : null}
          </div>
        </div>
      ) : null}

      {!hasTerminalSidebar && !isTabLayout && !showPaneHeaders && (
        <div className="pointer-events-none absolute right-2 top-2 z-20">
          <div className="pointer-events-auto inline-flex items-center gap-0.5 rounded-full border border-[var(--line)] bg-[var(--card)] px-1 py-0.5">
            <TerminalActionButton
              className={`rounded-full p-1 text-foreground/70 transition-colors ${
                hasReachedSplitLimit
                  ? "cursor-not-allowed opacity-45 hover:bg-transparent"
                  : "hover:bg-surface-hover hover:text-foreground"
              }`}
              onClick={() => onSplitTerminalAction(resolvedActiveTerminalId)}
              label={splitTerminalActionLabel}
            >
              <SquareSplitHorizontal className="size-3.25" />
            </TerminalActionButton>
            <div className="h-3.5 w-px bg-[var(--line)]" />
            <TerminalActionButton
              className={`rounded-full p-1 text-foreground/70 transition-colors ${
                hasReachedSplitLimit
                  ? "cursor-not-allowed opacity-45 hover:bg-transparent"
                  : "hover:bg-surface-hover hover:text-foreground"
              }`}
              onClick={() => onSplitTerminalVerticalAction(resolvedActiveTerminalId)}
              label={splitTerminalVerticalActionLabel}
            >
              <SquareSplitVertical className="size-3.25" />
            </TerminalActionButton>
            <div className="h-3.5 w-px bg-[var(--line)]" />
            <NewPaneButton
              className="rounded-full p-1 text-foreground/70 transition-colors hover:bg-surface-hover hover:text-foreground"
              iconClassName="size-3.25"
              label={newTerminalActionLabel}
              onNewTerminal={onNewTerminalAction}
              onNewBrowser={onNewBrowserAction}
            />
            <div className="h-3.5 w-px bg-[var(--line)]" />
            <TerminalActionButton
              className="rounded-full p-1 text-foreground/70 transition-colors hover:bg-surface-hover hover:text-foreground"
              onClick={() => onCloseTerminal(resolvedActiveTerminalId)}
              label={closeTerminalActionLabel}
            >
              <Trash2 className="size-3.25" />
            </TerminalActionButton>
            {onToggleFullscreen ? (
              <>
                <div className="h-3.5 w-px bg-[var(--line)]" />
                <TerminalActionButton
                  className={cn(
                    "rounded-full p-1 text-foreground/70 transition-colors hover:bg-surface-hover hover:text-foreground",
                    !canToggleFullscreen && "cursor-not-allowed opacity-45 hover:bg-transparent",
                  )}
                  onClick={canToggleFullscreen ? onToggleFullscreen : () => {}}
                  label={
                    !canToggleFullscreen
                      ? FULLSCREEN_NEEDS_PANES_LABEL
                      : fullscreen
                        ? "Exit terminal fullscreen"
                        : "Enter terminal fullscreen"
                  }
                >
                  {fullscreen ? (
                    <Minimize2Icon className="size-3.25" />
                  ) : (
                    <Maximize2Icon className="size-3.25" />
                  )}
                </TerminalActionButton>
              </>
            ) : null}
          </div>
        </div>
      )}

      <div className="min-h-0 w-full flex-1 p-1.5">
        <div className={`flex h-full min-h-0 ${hasTerminalSidebar ? "gap-1.5" : ""}`}>
          <div className="min-w-0 flex-1">
            {isSplitView && activeGroupLayout ? (
              renderLayoutNode(activeGroupLayout, [])
            ) : (
              <div
                data-terminal-pane-id={resolvedActiveTerminalId}
                className="flex h-full min-h-0 flex-col overflow-hidden rounded-[8px] border border-[var(--line)]"
              >
                {showPaneHeaders && resolvedActiveTerminalId ? (
                  <TerminalPaneHeader
                    {...paneHeaderProps(resolvedActiveTerminalId)}
                    draggable={false}
                  />
                ) : null}
                <div className="min-h-0 flex-1 p-1">
                  <TerminalViewport
                    key={resolvedActiveTerminalId}
                    threadRef={threadRef}
                    threadId={threadId}
                    terminalId={resolvedActiveTerminalId}
                    terminalLabel={terminalLabelById.get(resolvedActiveTerminalId) ?? "Terminal"}
                    cwd={activeTerminalLaunchLocation.cwd}
                    {...(activeTerminalLaunchLocation.worktreePath !== undefined
                      ? { worktreePath: activeTerminalLaunchLocation.worktreePath }
                      : {})}
                    {...(activeTerminalLaunchLocation.runtimeEnv
                      ? { runtimeEnv: activeTerminalLaunchLocation.runtimeEnv }
                      : {})}
                    onSessionExited={() => onCloseTerminal(resolvedActiveTerminalId)}
                    onAddTerminalContext={onAddTerminalContext}
                    focusRequestId={focusRequestId}
                    autoFocus
                    surfaceVisible={visible}
                    locallyOpening={locallyOpeningTerminalIdSet.has(resolvedActiveTerminalId)}
                    resizeEpoch={resizeEpoch}
                    {...(nudgeEpoch !== undefined ? { nudgeEpoch } : {})}
                    drawerHeight={drawerHeight}
                    keybindings={keybindings}
                  />
                </div>
              </div>
            )}
          </div>

          {hasTerminalSidebar && (
            <aside
              className="relative flex shrink-0 flex-col border-r border-[var(--line)]"
              style={{ width: `${effectiveSidebarWidth}px` }}
            >
              {onSidebarWidthChange ? (
                <div
                  className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize"
                  onPointerDown={handleSidebarResizePointerDown}
                  onPointerMove={handleSidebarResizePointerMove}
                  onPointerUp={handleSidebarResizePointerEnd}
                  onPointerCancel={handleSidebarResizePointerEnd}
                />
              ) : null}

              <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
                {resolvedTerminalGroups.map((terminalGroup, groupIndex) => {
                  const isGroupActive =
                    terminalGroup.terminalIds.includes(resolvedActiveTerminalId);
                  const groupActiveTerminalId = isGroupActive
                    ? resolvedActiveTerminalId
                    : (terminalGroup.terminalIds[0] ?? resolvedActiveTerminalId);
                  const groupDrop =
                    sidebarDropTarget?.kind === "group" &&
                    sidebarDropTarget.groupId === terminalGroup.id
                      ? sidebarDropTarget
                      : null;

                  return (
                    <div
                      key={terminalGroup.id}
                      className={cn(
                        "relative pb-0.5",
                        groupDrop?.placement === "into" && "rounded bg-primary/10",
                      )}
                      onDragOver={
                        canDragSidebarTerminals || canDragSidebarGroups
                          ? (event) => {
                              const draggingTerminal = dataTransferHasType(
                                event.dataTransfer.types,
                                TERMINAL_PANE_DRAG_MIME,
                              );
                              const draggingGroup = dataTransferHasType(
                                event.dataTransfer.types,
                                TERMINAL_GROUP_DRAG_MIME,
                              );
                              if (draggingGroup && canDragSidebarGroups) {
                                if (draggedGroupIdRef.current === terminalGroup.id) {
                                  return;
                                }
                                event.preventDefault();
                                event.dataTransfer.dropEffect = "move";
                                const bounds = event.currentTarget.getBoundingClientRect();
                                const placement = listDropPlacementForPoint(
                                  event.clientY - bounds.top,
                                  bounds.height,
                                );
                                setSidebarDropTarget((current) =>
                                  current?.kind === "group" &&
                                  current.groupId === terminalGroup.id &&
                                  current.placement === placement
                                    ? current
                                    : { kind: "group", groupId: terminalGroup.id, placement },
                                );
                                return;
                              }
                              if (!draggingTerminal || !canDragSidebarTerminals) {
                                return;
                              }
                              const incomingTerminalId = draggedTerminalIdRef.current;
                              if (
                                !incomingTerminalId ||
                                !groupCanAcceptTerminal(terminalGroup, incomingTerminalId)
                              ) {
                                return;
                              }
                              if (event.currentTarget !== event.target) {
                                return;
                              }
                              event.preventDefault();
                              event.dataTransfer.dropEffect = "move";
                              setSidebarDropTarget((current) =>
                                current?.kind === "group" &&
                                current.groupId === terminalGroup.id &&
                                current.placement === "into"
                                  ? current
                                  : {
                                      kind: "group",
                                      groupId: terminalGroup.id,
                                      placement: "into",
                                    },
                              );
                            }
                          : undefined
                      }
                      onDrop={
                        canDragSidebarTerminals || canDragSidebarGroups
                          ? (event) => {
                              event.preventDefault();
                              commitSidebarDrop();
                            }
                          : undefined
                      }
                      onDragLeave={
                        canDragSidebarTerminals || canDragSidebarGroups
                          ? (event) => {
                              if (
                                event.currentTarget.contains(event.relatedTarget as Node | null)
                              ) {
                                return;
                              }
                              setSidebarDropTarget((current) =>
                                current?.kind === "group" && current.groupId === terminalGroup.id
                                  ? null
                                  : current,
                              );
                            }
                          : undefined
                      }
                    >
                      {groupDrop && groupDrop.placement !== "into" ? (
                        <SidebarDropLine placement={groupDrop.placement} />
                      ) : null}
                      {showGroupHeaders &&
                        (groupRenameDraft?.groupId === terminalGroup.id ? (
                          <input
                            autoFocus
                            value={groupRenameDraft.name}
                            aria-label="Group name"
                            className="w-full rounded-md border border-[var(--gold-line)] bg-background px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-foreground outline-none"
                            onChange={(event) =>
                              setGroupRenameDraft({
                                groupId: terminalGroup.id,
                                name: event.target.value,
                              })
                            }
                            onKeyDown={(event) => {
                              event.stopPropagation();
                              if (event.key === "Enter") commitGroupRename();
                              else if (event.key === "Escape") setGroupRenameDraft(null);
                            }}
                            onBlur={commitGroupRename}
                          />
                        ) : (
                          <button
                            type="button"
                            className={cn(
                              "relative flex w-full items-center rounded-md px-1.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] transition-colors",
                              isGroupActive
                                ? "text-gold-600 dark:text-gold-400"
                                : "text-muted-foreground/80 hover:bg-surface-hover hover:text-foreground",
                              canDragSidebarGroups && "cursor-grab active:cursor-grabbing",
                            )}
                            draggable={canDragSidebarGroups}
                            onDragStart={
                              canDragSidebarGroups
                                ? (event) => {
                                    beginGroupDrag(event, terminalGroup.id);
                                  }
                                : undefined
                            }
                            onDragEnd={clearSidebarDrag}
                            onClick={() => onActiveTerminalChange(groupActiveTerminalId)}
                            onDragOver={
                              canDragSidebarTerminals
                                ? (event) => {
                                    if (
                                      !dataTransferHasType(
                                        event.dataTransfer.types,
                                        TERMINAL_PANE_DRAG_MIME,
                                      )
                                    ) {
                                      return;
                                    }
                                    const incomingTerminalId = draggedTerminalIdRef.current;
                                    if (
                                      !incomingTerminalId ||
                                      !groupCanAcceptTerminal(terminalGroup, incomingTerminalId)
                                    ) {
                                      return;
                                    }
                                    event.preventDefault();
                                    event.stopPropagation();
                                    event.dataTransfer.dropEffect = "move";
                                    setSidebarDropTarget((current) =>
                                      current?.kind === "group" &&
                                      current.groupId === terminalGroup.id &&
                                      current.placement === "into"
                                        ? current
                                        : {
                                            kind: "group",
                                            groupId: terminalGroup.id,
                                            placement: "into",
                                          },
                                    );
                                  }
                                : undefined
                            }
                            {...(onRenameGroup
                              ? {
                                  onDoubleClick: () =>
                                    setGroupRenameDraft({
                                      groupId: terminalGroup.id,
                                      name: terminalGroup.name ?? "",
                                    }),
                                  title: canDragSidebarGroups
                                    ? "Drag to reorder groups. Double-click to rename."
                                    : "Double-click to rename",
                                }
                              : canDragSidebarGroups
                                ? { title: "Drag to reorder groups" }
                                : {})}
                          >
                            <span className="truncate">
                              {terminalGroup.name ?? `Group ${groupIndex + 1}`}
                            </span>
                          </button>
                        ))}

                      <div
                        className={
                          showGroupHeaders ? "ml-1.5 border-l border-[var(--line)] pl-1.5" : ""
                        }
                      >
                        {terminalGroup.terminalIds.map((terminalId) => {
                          const isActive = terminalId === resolvedActiveTerminalId;
                          const closeTerminalLabel = `Close ${
                            terminalLabelById.get(terminalId) ?? "terminal"
                          }${isActive && closeShortcutLabel ? ` (${closeShortcutLabel})` : ""}`;
                          const rowDrop =
                            sidebarDropTarget?.kind === "terminal" &&
                            sidebarDropTarget.terminalId === terminalId
                              ? sidebarDropTarget
                              : null;
                          return (
                            <div
                              key={terminalId}
                              className={cn(
                                "group relative flex h-6 items-center gap-1.5 rounded-md border px-1.5 text-[11.5px] transition-colors",
                                isActive
                                  ? "border-gold-500/60 bg-gold-500/15 font-medium text-gold-800 shadow-[inset_2px_0_0_0_var(--gold-500)] dark:text-gold-100"
                                  : "border-transparent text-muted-foreground hover:bg-surface-hover hover:text-foreground",
                                canDragSidebarTerminals && "cursor-grab active:cursor-grabbing",
                              )}
                              draggable={canDragSidebarTerminals}
                              onDragStart={
                                canDragSidebarTerminals
                                  ? (event) => {
                                      beginTerminalDrag(event, terminalId);
                                    }
                                  : undefined
                              }
                              onDragEnd={() => {
                                draggedTerminalIdRef.current = null;
                                clearSidebarDrag();
                              }}
                              onDragOver={
                                canDragSidebarTerminals
                                  ? (event) => {
                                      if (
                                        !dataTransferHasType(
                                          event.dataTransfer.types,
                                          TERMINAL_PANE_DRAG_MIME,
                                        )
                                      ) {
                                        return;
                                      }
                                      const incomingTerminalId = draggedTerminalIdRef.current;
                                      if (
                                        !incomingTerminalId ||
                                        incomingTerminalId === terminalId ||
                                        !groupCanAcceptTerminal(terminalGroup, incomingTerminalId)
                                      ) {
                                        return;
                                      }
                                      event.preventDefault();
                                      event.stopPropagation();
                                      event.dataTransfer.dropEffect = "move";
                                      const bounds = event.currentTarget.getBoundingClientRect();
                                      const placement = listDropPlacementForPoint(
                                        event.clientY - bounds.top,
                                        bounds.height,
                                      );
                                      setSidebarDropTarget((current) =>
                                        current?.kind === "terminal" &&
                                        current.terminalId === terminalId &&
                                        current.placement === placement
                                          ? current
                                          : {
                                              kind: "terminal",
                                              groupId: terminalGroup.id,
                                              terminalId,
                                              placement,
                                            },
                                      );
                                    }
                                  : undefined
                              }
                              onDrop={
                                canDragSidebarTerminals
                                  ? (event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      commitSidebarDrop();
                                    }
                                  : undefined
                              }
                            >
                              {rowDrop ? <SidebarDropLine placement={rowDrop.placement} /> : null}
                              {showGroupHeaders && (
                                <span className="text-[10px] text-muted-foreground/80">└</span>
                              )}
                              <button
                                type="button"
                                className="flex min-w-0 flex-1 items-center gap-1 text-left"
                                onClick={() => onActiveTerminalChange(terminalId)}
                              >
                                <TerminalSessionIcon
                                  className="size-3"
                                  working={terminalAppearanceById.get(terminalId)?.working === true}
                                  driverKind={
                                    terminalAppearanceById.get(terminalId)?.driverKind ?? null
                                  }
                                  displayName={terminalLabelById.get(terminalId) ?? "Terminal"}
                                />
                                <span className="truncate">
                                  {terminalLabelById.get(terminalId) ?? "Terminal"}
                                </span>
                              </button>
                              {normalizedTerminalIds.length > 1 && (
                                <Popover>
                                  <PopoverTrigger
                                    openOnHover
                                    render={
                                      <button
                                        type="button"
                                        draggable={false}
                                        className="inline-flex size-4 items-center justify-center rounded-md text-xs font-medium leading-none text-muted-foreground opacity-0 transition hover:bg-surface-hover hover:text-foreground group-hover:opacity-100 pointer-coarse:opacity-100"
                                        onClick={() => onCloseTerminal(terminalId)}
                                        onMouseDown={(event) => event.stopPropagation()}
                                        aria-label={closeTerminalLabel}
                                      />
                                    }
                                  >
                                    <XIcon className="size-2.5" />
                                  </PopoverTrigger>
                                  <PopoverPopup
                                    tooltipStyle
                                    side="bottom"
                                    sideOffset={6}
                                    align="center"
                                    className="pointer-events-none select-none"
                                  >
                                    {closeTerminalLabel}
                                  </PopoverPopup>
                                </Popover>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </aside>
          )}
        </div>
      </div>
    </aside>
  );
}
