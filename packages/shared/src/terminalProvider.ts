import { ProviderDriverKind } from "@t3tools/contracts";

import { visibleTerminalText } from "./terminalText.ts";

const COMMAND_TO_DRIVER: Readonly<Record<string, ProviderDriverKind>> = {
  claude: ProviderDriverKind.make("claudeAgent"),
  grok: ProviderDriverKind.make("grok"),
  codex: ProviderDriverKind.make("codex"),
  cursor: ProviderDriverKind.make("cursor"),
  "cursor-agent": ProviderDriverKind.make("cursor"),
  opencode: ProviderDriverKind.make("opencode"),
};

/** Enough of the latest frame to see interrupt hints without older turns. */
const AGENT_CLI_BUSY_TAIL_CHARS = 2_500;

/** Hold working through Claude alt-screen frames that omit the footer for a beat. */
export const AGENT_CLI_WORKING_IDLE_MS = 2_000;

/**
 * A mid-turn TUI animates its status line several times a second, so its
 * output only goes quiet when the turn is over. After this much silence the
 * pane is idle no matter what the last frame says — stripped history keeps
 * stale busy markers forever (partial repaints update the status row in
 * place, so the old "esc to interrupt" line is never overwritten there).
 */
export const AGENT_CLI_OUTPUT_STALE_MS = 10_000;

/**
 * Markers a TUI only paints while a turn is in flight. Each must be specific
 * enough to never appear in transcript prose: bare star glyphs and the word
 * "thinking" both occur in ordinary agent output, so neither alone counts.
 */
const AGENT_CLI_BUSY_MARKERS: ReadonlyArray<RegExp> = [
  /esc(?:ape)?\s+to\s+(?:interrupt|cancel|stop)/gi,
  /(?:ctrl|control)[+\-][a-z]\s+to\s+(?:interrupt|cancel|stop|run in background)/gi,
  /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g,
  // Star-glyph spinner status lines: "✻ Thinking…", "✶ Puttering… (2m 4s)".
  /[✢✳✶✻✽✿❋✸]\s*\p{L}+(?:…|\.{3})/gu,
];

/**
 * Frames a TUI paints exactly when a turn has ended or never started: the
 * Claude turn-complete status row and the home splashes. A busy marker only
 * counts when it was painted after the latest one of these — partial
 * repaints leave older busy frames in the stripped tail forever.
 */
const AGENT_CLI_IDLE_MARKERS: ReadonlyArray<RegExp> = [
  /\bworked for\s+\d/gi,
  /what's new/gi,
  /what do you want to get done/gi,
];

function lastMarkerIndex(text: string, markers: ReadonlyArray<RegExp>): number {
  let last = -1;
  for (const marker of markers) {
    for (const match of text.matchAll(marker)) {
      if (match.index > last) {
        last = match.index;
      }
    }
  }
  return last;
}

/** Map a terminal's running command (the pane label) to a provider driver. */
export function terminalCommandProviderDriver(
  command: string | null | undefined,
): ProviderDriverKind | null {
  if (command === null || command === undefined) {
    return null;
  }
  const normalized = command.trim().toLowerCase();
  return COMMAND_TO_DRIVER[normalized] ?? null;
}

/** True when the latest frame of an agent TUI is mid-turn, not sitting idle. */
export function agentCliLooksBusy(history: string): boolean {
  const tail = visibleTerminalText(history, AGENT_CLI_BUSY_TAIL_CHARS).text;
  if (tail.trim().length === 0) {
    return false;
  }
  const lastBusy = lastMarkerIndex(tail, AGENT_CLI_BUSY_MARKERS);
  if (lastBusy === -1) {
    return false;
  }
  return lastBusy > lastMarkerIndex(tail, AGENT_CLI_IDLE_MARKERS);
}

/**
 * Stay working through short idle-looking redraws; drop working only after
 * the TUI has looked idle for `idleAfterMs`. A frame that still carries busy
 * markers stops counting as busy once the pane has been silent for
 * `outputStaleAfterMs` — frozen markers cannot end a turn on their own.
 */
export function nextAgentCliWorkingState(input: {
  readonly currentlyWorking: boolean;
  readonly looksBusy: boolean;
  readonly lastBusyAtMs: number | null;
  readonly nowMs: number;
  readonly idleAfterMs?: number;
  /** Last time the pane produced output; null/undefined skips the gate. */
  readonly lastOutputAtMs?: number | null;
  readonly outputStaleAfterMs?: number;
}): { readonly working: boolean; readonly lastBusyAtMs: number | null } {
  const idleAfterMs = input.idleAfterMs ?? AGENT_CLI_WORKING_IDLE_MS;
  const outputStale =
    input.lastOutputAtMs !== undefined &&
    input.lastOutputAtMs !== null &&
    input.nowMs - input.lastOutputAtMs >= (input.outputStaleAfterMs ?? AGENT_CLI_OUTPUT_STALE_MS);
  if (input.looksBusy && !outputStale) {
    return { working: true, lastBusyAtMs: input.nowMs };
  }
  if (!input.currentlyWorking) {
    return { working: false, lastBusyAtMs: null };
  }
  if (input.lastBusyAtMs !== null && input.nowMs - input.lastBusyAtMs < idleAfterMs) {
    return { working: true, lastBusyAtMs: input.lastBusyAtMs };
  }
  return { working: false, lastBusyAtMs: null };
}

/**
 * UI "working" for a pane. A vim or `npm test` child is working. An agent CLI
 * is working only while its TUI is mid-turn — the home screen is not.
 */
export function terminalSubprocessIsWorking(input: {
  readonly hasRunningSubprocess: boolean;
  readonly command: string | null | undefined;
  readonly history?: string | null;
  readonly working?: boolean;
}): boolean {
  if (input.working !== undefined) {
    return input.working;
  }
  if (!input.hasRunningSubprocess) {
    return false;
  }
  if (terminalCommandProviderDriver(input.command) === null) {
    return true;
  }
  return agentCliLooksBusy(input.history ?? "");
}
