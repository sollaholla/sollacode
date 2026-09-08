import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "~/lib/terminalContext";

export type IOSWebKitEnvironment = {
  readonly userAgent: string;
  readonly platform: string;
  readonly maxTouchPoints: number;
};

/**
 * iOS browsers all use WebKit. iPadOS can identify itself as macOS when the
 * user requests a desktop site, so touch capability is part of the check.
 */
export function shouldUseNativeIOSComposer(environment: IOSWebKitEnvironment): boolean {
  if (!/AppleWebKit/i.test(environment.userAgent)) return false;
  if (/iPhone|iPad|iPod/i.test(environment.userAgent)) return true;
  return environment.platform === "MacIntel" && environment.maxTouchPoints > 1;
}

export function composerPromptToNativeText(prompt: string): string {
  return prompt.replaceAll(INLINE_TERMINAL_CONTEXT_PLACEHOLDER, "");
}

/** Convert a textarea offset back into the prompt that also contains chips. */
export function nativeComposerOffsetToPromptOffset(prompt: string, offsetInput: number): number {
  const nativeLength = composerPromptToNativeText(prompt).length;
  const offset = Math.max(0, Math.min(nativeLength, Math.floor(offsetInput)));
  let nativeOffset = 0;

  for (let promptOffset = 0; promptOffset < prompt.length; promptOffset += 1) {
    if (prompt[promptOffset] === INLINE_TERMINAL_CONTEXT_PLACEHOLDER) continue;
    if (nativeOffset === offset) return promptOffset;
    nativeOffset += 1;
  }

  return prompt.length;
}

/** Convert a prompt offset into the visible textarea string. */
export function promptOffsetToNativeComposerOffset(prompt: string, offsetInput: number): number {
  const offset = Math.max(0, Math.min(prompt.length, Math.floor(offsetInput)));
  let nativeOffset = 0;
  for (let promptOffset = 0; promptOffset < offset; promptOffset += 1) {
    if (prompt[promptOffset] !== INLINE_TERMINAL_CONTEXT_PLACEHOLDER) nativeOffset += 1;
  }
  return nativeOffset;
}

/**
 * Apply a native textarea edit without exposing or deleting terminal-context
 * placeholders. Safari remains the sole owner of the visible text and
 * selection; this function only projects its completed value back into the
 * canonical prompt.
 */
export function mergeNativeComposerText(previousPrompt: string, nextNativeText: string): string {
  const previousNativeText = composerPromptToNativeText(previousPrompt);
  if (previousNativeText === nextNativeText) return previousPrompt;

  let prefixLength = 0;
  const sharedLength = Math.min(previousNativeText.length, nextNativeText.length);
  while (
    prefixLength < sharedLength &&
    previousNativeText[prefixLength] === nextNativeText[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < previousNativeText.length - prefixLength &&
    suffixLength < nextNativeText.length - prefixLength &&
    previousNativeText[previousNativeText.length - suffixLength - 1] ===
      nextNativeText[nextNativeText.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }

  const removedNativeEnd = previousNativeText.length - suffixLength;
  const replacement = nextNativeText.slice(prefixLength, nextNativeText.length - suffixLength);
  let nativeOffset = 0;
  let inserted = false;
  let nextPrompt = "";

  for (const character of previousPrompt) {
    if (character === INLINE_TERMINAL_CONTEXT_PLACEHOLDER) {
      nextPrompt += character;
      continue;
    }
    if (!inserted && nativeOffset === prefixLength) {
      nextPrompt += replacement;
      inserted = true;
    }
    if (nativeOffset < prefixLength || nativeOffset >= removedNativeEnd) {
      nextPrompt += character;
    }
    nativeOffset += character.length;
  }

  if (!inserted) nextPrompt += replacement;
  return nextPrompt;
}
