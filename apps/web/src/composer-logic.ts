import { splitPromptIntoComposerSegments } from "./composer-editor-mentions";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "./lib/terminalContext";

export type ComposerTriggerKind = "path" | "slash-command" | "skill";
export type ComposerSlashCommand = "model" | "plan" | "default" | "refresh-plan";

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

export function shouldSubmitComposerOnEnter(input: {
  isMobileViewport: boolean;
  shiftKey: boolean;
}): boolean {
  return !input.isMobileViewport && !input.shiftKey;
}

export function isEnabledComposerSubmitButton(
  button: Pick<HTMLButtonElement, "disabled"> | null,
): button is HTMLButtonElement {
  return button !== null && !button.disabled;
}

/**
 * The single guard both composer submit paths must honour. The send button
 * reads it through its `disabled` attribute; the Enter key must consult it
 * directly, because while a turn is running the primary action is Stop and no
 * submit button exists whose disabled state could be inspected instead.
 *
 * Voice transcription counts as blocking for its whole lifetime: it writes the
 * transcript into the draft asynchronously, so submitting mid-transcription
 * sends a half-written message — and mid-turn that lands inside the agent's
 * own output.
 */
export function isComposerSubmitBlocked(input: {
  noProviderAvailable: boolean;
  isSendDisabled: boolean;
  pushToTalkStatus: "recording" | "loading" | "transcribing" | null;
}): boolean {
  return input.noProviderAvailable || input.isSendDisabled || input.pushToTalkStatus !== null;
}

const isInlineTokenSegment = (
  segment:
    | { type: "text"; text: string }
    | { type: "mention" }
    | { type: "skill" }
    | { type: "terminal-context" },
): boolean => segment.type !== "text";

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function isWhitespace(char: string): boolean {
  return (
    char === " " ||
    char === "\n" ||
    char === "\t" ||
    char === "\r" ||
    char === INLINE_TERMINAL_CONTEXT_PLACEHOLDER
  );
}

function tokenStartForCursor(text: string, cursor: number): number {
  let index = cursor - 1;
  while (index >= 0 && !isWhitespace(text[index] ?? "")) {
    index -= 1;
  }
  return index + 1;
}

export function expandCollapsedComposerCursor(text: string, cursorInput: number): number {
  const collapsedCursor = clampCursor(text, cursorInput);
  const segments = splitPromptIntoComposerSegments(text);
  if (segments.length === 0) {
    return collapsedCursor;
  }

  let remaining = collapsedCursor;
  let expandedCursor = 0;

  for (const segment of segments) {
    if (segment.type === "mention") {
      const expandedLength = segment.source.length;
      if (remaining <= 1) {
        return expandedCursor + (remaining === 0 ? 0 : expandedLength);
      }
      remaining -= 1;
      expandedCursor += expandedLength;
      continue;
    }
    if (segment.type === "skill") {
      const expandedLength = segment.name.length + 1;
      if (remaining <= 1) {
        return expandedCursor + (remaining === 0 ? 0 : expandedLength);
      }
      remaining -= 1;
      expandedCursor += expandedLength;
      continue;
    }
    if (segment.type === "terminal-context") {
      if (remaining <= 1) {
        return expandedCursor + remaining;
      }
      remaining -= 1;
      expandedCursor += 1;
      continue;
    }

    const segmentLength = segment.text.length;
    if (remaining <= segmentLength) {
      return expandedCursor + remaining;
    }
    remaining -= segmentLength;
    expandedCursor += segmentLength;
  }

  return expandedCursor;
}

function collapsedSegmentLength(
  segment:
    | { type: "text"; text: string }
    | { type: "mention" }
    | { type: "skill" }
    | { type: "terminal-context" },
): number {
  if (segment.type === "text") {
    return segment.text.length;
  }
  return 1;
}

function clampCollapsedComposerCursorForSegments(
  segments: ReadonlyArray<
    | { type: "text"; text: string }
    | { type: "mention" }
    | { type: "skill" }
    | { type: "terminal-context" }
  >,
  cursorInput: number,
): number {
  const collapsedLength = segments.reduce(
    (total, segment) => total + collapsedSegmentLength(segment),
    0,
  );
  if (!Number.isFinite(cursorInput)) {
    return collapsedLength;
  }
  return Math.max(0, Math.min(collapsedLength, Math.floor(cursorInput)));
}

export function clampCollapsedComposerCursor(text: string, cursorInput: number): number {
  return clampCollapsedComposerCursorForSegments(
    splitPromptIntoComposerSegments(text),
    cursorInput,
  );
}

export function collapseExpandedComposerCursor(text: string, cursorInput: number): number {
  const expandedCursor = clampCursor(text, cursorInput);
  const segments = splitPromptIntoComposerSegments(text);
  if (segments.length === 0) {
    return expandedCursor;
  }

  let remaining = expandedCursor;
  let collapsedCursor = 0;

  for (const segment of segments) {
    if (segment.type === "mention") {
      const expandedLength = segment.source.length;
      if (remaining === 0) {
        return collapsedCursor;
      }
      if (remaining <= expandedLength) {
        return collapsedCursor + 1;
      }
      remaining -= expandedLength;
      collapsedCursor += 1;
      continue;
    }
    if (segment.type === "skill") {
      const expandedLength = segment.name.length + 1;
      if (remaining === 0) {
        return collapsedCursor;
      }
      if (remaining <= expandedLength) {
        return collapsedCursor + 1;
      }
      remaining -= expandedLength;
      collapsedCursor += 1;
      continue;
    }
    if (segment.type === "terminal-context") {
      if (remaining <= 1) {
        return collapsedCursor + remaining;
      }
      remaining -= 1;
      collapsedCursor += 1;
      continue;
    }

    const segmentLength = segment.text.length;
    if (remaining <= segmentLength) {
      return collapsedCursor + remaining;
    }
    remaining -= segmentLength;
    collapsedCursor += segmentLength;
  }

  return collapsedCursor;
}

export function isCollapsedCursorAdjacentToInlineToken(
  text: string,
  cursorInput: number,
  direction: "left" | "right",
): boolean {
  const segments = splitPromptIntoComposerSegments(text);
  if (!segments.some(isInlineTokenSegment)) {
    return false;
  }

  const cursor = clampCollapsedComposerCursorForSegments(segments, cursorInput);
  let collapsedOffset = 0;

  for (const segment of segments) {
    if (isInlineTokenSegment(segment)) {
      if (direction === "left" && cursor === collapsedOffset + 1) {
        return true;
      }
      if (direction === "right" && cursor === collapsedOffset) {
        return true;
      }
    }
    collapsedOffset += collapsedSegmentLength(segment);
  }

  return false;
}

export const isCollapsedCursorAdjacentToMention = isCollapsedCursorAdjacentToInlineToken;

export function detectComposerTrigger(text: string, cursorInput: number): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const linePrefix = text.slice(lineStart, cursor);

  if (linePrefix.startsWith("/")) {
    const commandMatch = /^\/(\S*)$/.exec(linePrefix);
    if (commandMatch) {
      const commandQuery = commandMatch[1] ?? "";
      return {
        kind: "slash-command",
        query: commandQuery,
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }
  }

  const tokenStart = tokenStartForCursor(text, cursor);
  const token = text.slice(tokenStart, cursor);
  if (token.startsWith("$")) {
    return {
      kind: "skill",
      query: token.slice(1),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  if (!token.startsWith("@")) {
    return null;
  }

  return {
    kind: "path",
    query: token.slice(1),
    rangeStart: tokenStart,
    rangeEnd: cursor,
  };
}

export function parseStandaloneComposerSlashCommand(
  text: string,
): Exclude<ComposerSlashCommand, "model"> | null {
  // "refresh-plan" is listed before "plan" so the alternation cannot match the
  // shorter name first and read `/refresh-plan` as a mode switch.
  const match = /^\/(refresh-plan|plan|default)\s*$/i.exec(text.trim());
  if (!match) {
    return null;
  }
  const command = match[1]?.toLowerCase();
  if (command === "refresh-plan") return "refresh-plan";
  if (command === "plan") return "plan";
  return "default";
}

export function replaceTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  const nextText = `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`;
  return { text: nextText, cursor: safeStart + replacement.length };
}

export interface ComposerFileIntake {
  readonly imageFiles: File[];
  readonly referencedPaths: string[];
  readonly error: string | null;
}

/**
 * A path from Electron belongs to the desktop client's filesystem. It is only
 * meaningful to the provider hosted by that same primary desktop environment;
 * SSH, relay, and desktop-local secondary environments (including WSL) have a
 * different path namespace.
 */
export function canReferenceLocalComposerFiles(input: {
  readonly hasDesktopPathResolver: boolean;
  readonly environmentTargetKind: string | null;
}): boolean {
  return input.hasDesktopPathResolver && input.environmentTargetKind === "PrimaryConnectionTarget";
}

/**
 * Splits dropped or picked files into what uploads and what attaches by
 * reference.
 *
 * Only images upload as attachments — providers accept nothing else. Any other
 * file attaches by reference instead: its OS path goes into the prompt as a
 * file link the agent opens from disk. That needs a resolvable path in the
 * provider's filesystem namespace, which is only true for the same-machine
 * desktop environment.
 */
export function classifyComposerFileIntake(
  files: readonly File[],
  options: {
    readonly resolvePath: (file: File) => string | null;
    readonly imageSlotsUsed: number;
    readonly maxImages: number;
  },
): ComposerFileIntake {
  const imageFiles: File[] = [];
  const referencedPaths: string[] = [];
  let error: string | null = null;
  let slots = options.imageSlotsUsed;
  for (const file of files) {
    if (!file.type.startsWith("image/")) {
      const path = options.resolvePath(file);
      if (path !== null) {
        referencedPaths.push(path);
      } else {
        error = `'${file.name}' can't be uploaded. It can only be added as a path reference from the desktop app when this chat runs on the same computer.`;
      }
      continue;
    }
    if (slots >= options.maxImages) {
      error = `You can attach up to ${options.maxImages} images per message.`;
      break;
    }
    imageFiles.push(file);
    slots += 1;
  }
  return { imageFiles, referencedPaths, error };
}
