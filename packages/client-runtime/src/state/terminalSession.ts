import type {
  EnvironmentId,
  TerminalAttachStreamEvent,
  TerminalLayoutStreamEvent,
  TerminalMetadataStreamEvent,
  TerminalSessionSnapshot,
  TerminalSummary,
  TerminalThreadLayout,
  ThreadId,
} from "@t3tools/contracts";
import { terminalSubprocessIsWorking } from "@t3tools/shared/terminalProvider";

export interface TerminalStreamCursor {
  /** Local snapshot identity; preserved by output appends and replaced on resubscription. */
  readonly generation: object;
  readonly offset: number;
}

export interface TerminalSessionState {
  readonly replayGeometry?: { readonly cols: number; readonly rows: number } | undefined;
  readonly replayComplete?: boolean | undefined;
  readonly streamCursor?: TerminalStreamCursor | undefined;
  readonly summary: TerminalSummary | null;
  readonly buffer: string;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly hasRunningSubprocess: boolean;
  readonly working: boolean;
  readonly updatedAt: string | null;
  readonly version: number;
}

export interface TerminalBufferState {
  readonly replayGeometry?: { readonly cols: number; readonly rows: number } | undefined;
  readonly replayComplete?: boolean | undefined;
  readonly bufferBytes?: number;
  readonly streamCursor?: TerminalStreamCursor | undefined;
  readonly buffer: string;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly updatedAt: string | null;
  readonly version: number;
}

export interface KnownTerminalSessionTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly terminalId: string;
}

export interface KnownTerminalSession {
  readonly target: KnownTerminalSessionTarget;
  readonly state: TerminalSessionState;
}

export function selectRunningSubprocessTerminalIds(
  sessions: ReadonlyArray<KnownTerminalSession>,
): ReadonlyArray<string> {
  return sessions
    .filter((session) => session.state.hasRunningSubprocess)
    .map((session) => session.target.terminalId);
}

export const EMPTY_TERMINAL_BUFFER_STATE = Object.freeze<TerminalBufferState>({
  buffer: "",
  status: "closed",
  error: null,
  updatedAt: null,
  version: 0,
});

export const EMPTY_TERMINAL_SESSION_STATE = Object.freeze<TerminalSessionState>({
  summary: null,
  buffer: "",
  status: "closed",
  error: null,
  hasRunningSubprocess: false,
  working: false,
  updatedAt: null,
  version: 0,
});

export const DEFAULT_MAX_TERMINAL_BUFFER_BYTES = 512 * 1024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function trimBufferToBytes(buffer: string, maxBufferBytes: number): string {
  if (maxBufferBytes <= 0) {
    return "";
  }

  const encoded = textEncoder.encode(buffer);
  if (encoded.byteLength <= maxBufferBytes) {
    return buffer;
  }

  let start = encoded.byteLength - maxBufferBytes;
  while (start < encoded.length) {
    const byte = encoded[start];
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) {
      break;
    }
    start += 1;
  }

  return textDecoder.decode(encoded.subarray(start));
}

/** Trim only the discarded prefix instead of encoding the entire retained history per PTY read. */
function appendTerminalBuffer(current: TerminalBufferState, data: string, maxBytes: number) {
  const joined = current.buffer + data;
  let bytes =
    (current.bufferBytes ?? textEncoder.encode(current.buffer).byteLength) +
    textEncoder.encode(data).byteLength;
  const last = current.buffer.charCodeAt(current.buffer.length - 1);
  const first = data.charCodeAt(0);
  if (last >= 0xd800 && last <= 0xdbff && first >= 0xdc00 && first <= 0xdfff) bytes -= 2;
  let start = 0;
  while (bytes > Math.max(0, maxBytes) && start < joined.length) {
    const point = joined.codePointAt(start)!;
    bytes -= point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    start += point > 0xffff ? 2 : 1;
  }
  return {
    buffer: joined.slice(start),
    bufferBytes: bytes,
    replayComplete: current.replayComplete !== false && start === 0,
  };
}

export function terminalBufferStateFromSnapshot(
  snapshot: TerminalSessionSnapshot,
  maxBufferBytes: number,
): TerminalBufferState {
  // A serialized screen is already bounded by dropping whole scrollback rows.
  // Cutting it again can discard its modes or half of a cursor command.
  const buffer = snapshot.screen?.data ?? trimBufferToBytes(snapshot.history, maxBufferBytes);
  return {
    buffer,
    replayGeometry: snapshot.screen
      ? { cols: snapshot.screen.cols, rows: snapshot.screen.rows }
      : undefined,
    replayComplete: true,
    streamCursor: { generation: {}, offset: buffer.length },
    bufferBytes: textEncoder.encode(buffer).byteLength,
    status: snapshot.status,
    error: null,
    updatedAt: snapshot.updatedAt,
    version: 1,
  };
}

function latestTimestamp(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

export function combineTerminalSessionState(
  summary: TerminalSummary | null,
  buffer: TerminalBufferState,
): TerminalSessionState {
  return {
    summary,
    buffer: buffer.buffer,
    replayGeometry: buffer.replayGeometry,
    replayComplete: buffer.replayComplete,
    streamCursor: buffer.streamCursor,
    status: buffer.version > 0 ? buffer.status : (summary?.status ?? buffer.status),
    error: buffer.error,
    hasRunningSubprocess: summary?.hasRunningSubprocess ?? false,
    working: terminalSubprocessIsWorking({
      hasRunningSubprocess: summary?.hasRunningSubprocess ?? false,
      command: summary?.label,
      ...(summary?.working !== undefined ? { working: summary.working } : {}),
    }),
    updatedAt: latestTimestamp(summary?.updatedAt ?? null, buffer.updatedAt),
    version: buffer.version,
  };
}

export function applyTerminalAttachStreamEvent(
  current: TerminalBufferState,
  event: TerminalAttachStreamEvent,
  maxBufferBytes = DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
): TerminalBufferState {
  switch (event.type) {
    case "snapshot":
    case "restarted":
      return {
        ...terminalBufferStateFromSnapshot(event.snapshot, maxBufferBytes),
        version: current.version + 1,
      };
    case "output":
      return {
        ...current,
        ...appendTerminalBuffer(current, event.data, maxBufferBytes),
        streamCursor: {
          generation: current.streamCursor?.generation ?? {},
          offset: (current.streamCursor?.offset ?? current.buffer.length) + event.data.length,
        },
        status: current.status === "closed" ? "running" : current.status,
        error: null,
        version: current.version + 1,
      };
    case "cleared":
      return {
        ...current,
        buffer: "",
        bufferBytes: 0,
        replayComplete: true,
        streamCursor: { generation: {}, offset: 0 },
        error: null,
        version: current.version + 1,
      };
    case "exited":
      return {
        ...current,
        status: "exited",
        error: null,
        version: current.version + 1,
      };
    case "closed":
      return {
        ...current,
        status: "closed",
        error: null,
        version: current.version + 1,
      };
    case "error":
      return {
        ...current,
        status: "error",
        error: event.message,
        version: current.version + 1,
      };
    case "activity":
      return current;
  }
}

export function applyTerminalLayoutStreamEvent(
  current: ReadonlyArray<TerminalThreadLayout>,
  event: TerminalLayoutStreamEvent,
): ReadonlyArray<TerminalThreadLayout> {
  if (event.type === "snapshot") {
    return event.layouts;
  }
  const next = current.filter((layout) => layout.threadId !== event.layout.threadId);
  return [...next, event.layout];
}

export function applyTerminalMetadataStreamEvent(
  current: ReadonlyArray<TerminalSummary>,
  event: TerminalMetadataStreamEvent,
): ReadonlyArray<TerminalSummary> {
  if (event.type === "snapshot") {
    return event.terminals;
  }
  if (event.type === "remove") {
    return current.filter(
      (terminal) =>
        terminal.threadId !== event.threadId || terminal.terminalId !== event.terminalId,
    );
  }
  const next = current.filter(
    (terminal) =>
      terminal.threadId !== event.terminal.threadId ||
      terminal.terminalId !== event.terminal.terminalId,
  );
  return [...next, event.terminal];
}
