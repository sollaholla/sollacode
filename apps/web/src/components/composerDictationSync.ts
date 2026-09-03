/**
 * Controlled-value reconciliation for the composer's Lexical editor.
 *
 * The editor is a controlled component: every edit is emitted upward, stored in
 * the composer draft store, and handed back as the `value` prop. Applying that
 * value re-runs `$setComposerEditorPrompt`, which calls `root.clear()` and
 * rebuilds every text node from the plain string.
 *
 * That is fine for keystrokes, which are committed synchronously. It is not
 * fine while an input method owns the text. macOS dictation streams words and
 * then makes a post-processing pass that replaces earlier words in place,
 * anchored to the DOM text nodes it originally wrote. If a controlled
 * write-back clears the root (or force-moves the caret) between those two
 * phases, the replacement lands against detached nodes and the word is dropped,
 * leaving the surrounding spaces behind. IME composition and macOS autocorrect
 * have the same shape.
 *
 * So while dictation is in flight we defer reconciliation instead of applying
 * it, and resolve the divergence once the input method has let go.
 */

/** How long after a composition ends we keep treating input as dictation.
 *
 * macOS delivers the post-processing replacement as an `insertReplacementText`
 * beforeinput that can arrive a beat after `compositionend`. The window only
 * ever delays an external write; it never drops one. */
export const COMPOSER_DICTATION_SETTLE_MS = 400;

export type ComposerControlledSyncInput = {
  /** `value` prop as of this render. */
  readonly incomingValue: string;
  /** `cursor` prop, already clamped to a collapsed composer offset. */
  readonly incomingCursor: number;
  /** Text the editor last emitted upward. */
  readonly snapshotValue: string;
  /** Collapsed cursor the editor last emitted upward. */
  readonly snapshotCursor: number;
  readonly contextsChanged: boolean;
  readonly skillsChanged: boolean;
  readonly isFocused: boolean;
  /** A composition is open, or we are inside the post-composition settle window. */
  readonly isDictating: boolean;
  /**
   * `incomingValue` is a value this editor emitted a moment ago rather than
   * anything external, so it is a lagging echo of an edit the editor has
   * already moved past.
   */
  readonly isStaleEcho: boolean;
};

export type ComposerControlledSyncDecision =
  /** Props already match the editor; leave it alone. */
  | { readonly kind: "skip" }
  /** An input method owns the text; re-evaluate once it lets go. */
  | { readonly kind: "defer" }
  | {
      readonly kind: "apply";
      /** Tear down and rebuild the editor content from `incomingValue`. */
      readonly rewrite: boolean;
      /** Force the caret to `incomingCursor`. */
      readonly setSelection: boolean;
    };

export function resolveComposerControlledSync(
  input: ComposerControlledSyncInput,
): ComposerControlledSyncDecision {
  const valueChanged = input.snapshotValue !== input.incomingValue;
  const cursorChanged = input.snapshotCursor !== input.incomingCursor;
  const structureChanged = input.contextsChanged || input.skillsChanged;

  if (!valueChanged && !cursorChanged && !structureChanged) {
    return { kind: "skip" };
  }

  // Dictation owns the text and the caret. Rebuilding nodes or moving the
  // selection underneath it is what deletes words mid-sentence.
  if (input.isDictating) {
    return { kind: "defer" };
  }

  // The editor already moved past this text, so rebuilding it would undo an
  // edit the user has made and hand the input method a set of nodes it never
  // wrote. Chips are the exception: they exist only as nodes, so a structural
  // change still has to be applied.
  if (input.isStaleEcho && !structureChanged) {
    return { kind: "skip" };
  }

  // An unfocused editor has no caret worth restoring, so a cursor-only change
  // is not worth an update.
  if (!valueChanged && !structureChanged && !input.isFocused) {
    return { kind: "skip" };
  }

  const rewrite = valueChanged || structureChanged;
  return { kind: "apply", rewrite, setSelection: rewrite || input.isFocused };
}

export type ComposerDictationFlushInput = {
  readonly contextsChanged: boolean;
  readonly skillsChanged: boolean;
  /** Whether the `value` prop still disagrees with the editor's live text. */
  readonly valueDiverged: boolean;
};

export type ComposerDictationFlushDecision =
  /** Nothing diverged while dictating; fall through to the normal path. */
  | { readonly kind: "none" }
  /** Chips changed while dictating; they can only be rendered by a rewrite. */
  | { readonly kind: "rewrite" }
  /** The editor moved on while the props lagged; the spoken text wins. */
  | { readonly kind: "adopt-editor" };

/**
 * Resolve the divergence that built up while dictation was in flight.
 *
 * The editor is authoritative for text: a `value` that disagrees after
 * dictation is a lagging echo of an earlier edit, and writing it back is
 * exactly the word loss we are fixing. Inline chips are the exception — they
 * only exist as nodes, so a terminal-context or skill change still has to be
 * rebuilt.
 */
export function resolveComposerDictationFlush(
  input: ComposerDictationFlushInput,
): ComposerDictationFlushDecision {
  if (input.contextsChanged || input.skillsChanged) {
    return { kind: "rewrite" };
  }
  if (input.valueDiverged) {
    return { kind: "adopt-editor" };
  }
  return { kind: "none" };
}

/**
 * How long an emitted value stays recognisable as our own echo.
 *
 * Long enough to cover a state round trip through the draft store and back
 * down as a prop, short enough that a deliberate external set - restoring a
 * draft, injecting a transcript, a slash command rewriting the prompt - still
 * applies even when it happens to match something typed earlier.
 */
export const COMPOSER_ECHO_MEMORY_MS = 1_500;

/** Values the editor recently sent upward, oldest first. */
export type ComposerEmittedEcho = {
  readonly value: string;
  readonly at: number;
};

/** Bound the history so a long dictation cannot grow it without limit. */
const COMPOSER_ECHO_MEMORY_ENTRIES = 32;

export function rememberComposerEmittedValue(
  history: readonly ComposerEmittedEcho[],
  value: string,
  now: number,
): readonly ComposerEmittedEcho[] {
  const fresh = history.filter((entry) => now - entry.at < COMPOSER_ECHO_MEMORY_MS);
  return [...fresh, { value, at: now }].slice(-COMPOSER_ECHO_MEMORY_ENTRIES);
}

/**
 * Whether an incoming `value` prop is this editor's own output coming back.
 *
 * The editor emits on every edit, and that value returns as a prop a render
 * later. While the user is still typing - or while an input method is
 * streaming words in and then rewriting them - the value that arrives is one
 * or more edits behind. Writing it back rebuilds the editor from stale text:
 * the visible words revert, and any node the input method was anchored to is
 * replaced, which is how a dictated word disappears and leaves its spaces.
 *
 * The current snapshot is excluded because that is the editor agreeing with
 * its props, not lagging behind them.
 */
export function isComposerStaleEcho(input: {
  readonly history: readonly ComposerEmittedEcho[];
  readonly incomingValue: string;
  readonly snapshotValue: string;
  readonly now: number;
}): boolean {
  if (input.incomingValue === input.snapshotValue) return false;
  return input.history.some(
    (entry) =>
      entry.value === input.incomingValue && input.now - entry.at < COMPOSER_ECHO_MEMORY_MS,
  );
}

/**
 * What to do with a `beforeinput` that replaces existing text.
 *
 * Lexical hands `insertReplacementText` to its rich-text handler, which does:
 *
 * ```js
 * const dataTransfer = eventOrText.dataTransfer;
 * if (dataTransfer != null) {
 *   $insertDataTransferForRichText(dataTransfer, selection, editor);
 * } else if ($isRangeSelection(selection)) {
 *   const data = eventOrText.data;
 *   if (data) selection.insertText(data);
 * }
 * ```
 *
 * By then the selection already covers the word being replaced. So a
 * replacement whose payload is empty replaces that word with nothing: the word
 * disappears and the spaces around it stay, which is exactly what iOS
 * dictation's post-processing pass leaves behind. A replacement that carries no
 * replacement text is not an edit anyone asked for, so it must never reach the
 * editor.
 */
export type ComposerReplacementDecision =
  /** Let Lexical apply it; the payload it will read is present. */
  | { readonly kind: "allow" }
  /** Payload is empty. Drop the event so the target word survives. */
  | { readonly kind: "block" }
  /**
   * The text is in `data`, but a non-null empty `dataTransfer` will win inside
   * Lexical and erase the target. Apply `text` ourselves instead.
   */
  | { readonly kind: "insert"; readonly text: string };

export function resolveComposerReplacement(input: {
  /** `event.dataTransfer`, or null when the event carries none. */
  readonly dataTransferText: string | null;
  /** `event.data`. */
  readonly data: string | null;
}): ComposerReplacementDecision {
  const fromTransfer = input.dataTransferText ?? "";
  const fromData = input.data ?? "";
  if (input.dataTransferText === null) {
    // Lexical reads `data` in this branch, which is the correct behaviour.
    return fromData.length > 0 ? { kind: "allow" } : { kind: "block" };
  }
  if (fromTransfer.length > 0) return { kind: "allow" };
  // A present-but-empty dataTransfer is the destructive case: Lexical prefers
  // it over `data` and inserts nothing.
  return fromData.length > 0 ? { kind: "insert", text: fromData } : { kind: "block" };
}
