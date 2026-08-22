import { visibleTerminalText } from "@t3tools/shared/terminalText";

import type { ThreadSnapshot } from "./events";

export interface OrchestratorTerminalRecord {
  readonly environmentId: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly terminalId: string;
  readonly label: string;
  readonly status: string;
  readonly hasRunningSubprocess: boolean;
  readonly cwd: string;
}

export interface OrchestratorTerminalRead {
  readonly terminal: OrchestratorTerminalRecord;
  readonly output: string;
  readonly truncated: boolean;
}

export function compactTerminals(
  terminals: ReadonlyArray<OrchestratorTerminalRecord>,
): ReadonlyArray<{
  readonly terminalId: string;
  readonly label: string;
  readonly status: string;
  readonly hasRunningSubprocess: boolean;
}> {
  return terminals.map((terminal) => ({
    terminalId: terminal.terminalId,
    label: terminal.label,
    status: terminal.status,
    hasRunningSubprocess: terminal.hasRunningSubprocess,
  }));
}

export function terminalsForThread(
  terminals: ReadonlyArray<OrchestratorTerminalRecord>,
  thread: Pick<ThreadSnapshot, "environmentId" | "threadId">,
): ReadonlyArray<OrchestratorTerminalRecord> {
  return terminals.filter(
    (terminal) =>
      terminal.environmentId === thread.environmentId && terminal.threadId === thread.threadId,
  );
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function matchesName(terminal: OrchestratorTerminalRecord, query: string): boolean {
  const needle = normalize(query);
  if (needle.length === 0) return false;
  return (
    normalize(terminal.terminalId) === needle ||
    normalize(terminal.label) === needle ||
    normalize(terminal.label).includes(needle) ||
    normalize(terminal.terminalId).includes(needle)
  );
}

export type TerminalResolution =
  | {
      readonly ok: true;
      readonly terminal: OrchestratorTerminalRecord;
      readonly confident: boolean;
    }
  | {
      readonly ok: false;
      readonly kind: "missing" | "ambiguous" | "none";
      readonly heard: string;
      readonly candidates: ReadonlyArray<OrchestratorTerminalRecord>;
    };

/**
 * Pick the terminal the user meant. A lone running pane in the (optional)
 * thread is enough; names match ids and labels ("claude", "term-1").
 */
export function resolveTerminalReference(
  terminals: ReadonlyArray<OrchestratorTerminalRecord>,
  input: {
    readonly query?: string;
    readonly threadId?: string;
  },
): TerminalResolution {
  let candidates = terminals;
  if (input.threadId !== undefined) {
    candidates = candidates.filter((terminal) => terminal.threadId === input.threadId);
  }

  const query = input.query?.trim() ?? "";
  if (query.length > 0) {
    const named = candidates.filter((terminal) => matchesName(terminal, query));
    if (named.length === 1) {
      return { ok: true, terminal: named[0]!, confident: true };
    }
    if (named.length > 1) {
      return { ok: false, kind: "ambiguous", heard: query, candidates: named };
    }
    if (candidates.length === 0) {
      return { ok: false, kind: "none", heard: query, candidates: [] };
    }
    return { ok: false, kind: "missing", heard: query, candidates };
  }

  if (candidates.length === 1) {
    return { ok: true, terminal: candidates[0]!, confident: true };
  }

  const running = candidates.filter((terminal) => terminal.status === "running");
  if (running.length === 1) {
    return { ok: true, terminal: running[0]!, confident: true };
  }
  if (candidates.length === 0) {
    return { ok: false, kind: "none", heard: query, candidates: [] };
  }
  return { ok: false, kind: "ambiguous", heard: query, candidates };
}

export function presentTerminalRead(
  terminal: OrchestratorTerminalRecord,
  history: string,
): OrchestratorTerminalRead {
  const presented = visibleTerminalText(history);
  return {
    terminal,
    output: presented.text,
    truncated: presented.truncated,
  };
}

export function describeTerminalAloud(terminal: OrchestratorTerminalRecord): string {
  const activity = terminal.hasRunningSubprocess
    ? `running ${terminal.label}`
    : terminal.status === "running"
      ? "an idle shell"
      : terminal.status;
  return `${terminal.threadTitle}'s ${terminal.label} (${activity})`;
}
