import { create } from "zustand";

/**
 * Turns a transcript selection into a markdown blockquote in the composer and
 * parks the cursor on an empty line beneath it, so the user can start typing a
 * reply to what they quoted without any further clicks.
 */

/** Trailing blank line the cursor lands on, after the quote block. */
const QUOTE_TRAILER = "\n\n";

export function formatQuoteBlock(selection: string): string {
  // Normalise line endings first so CRLF input cannot produce stray `> \r` rows.
  const normalized = selection.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
  if (normalized.length === 0) return "";
  return (
    normalized
      .split("\n")
      // A blank line inside a quote must stay `>` rather than `> `, otherwise the
      // trailing space renders as an unwanted hard break in some markdown parsers.
      .map((line) => (line.trim().length === 0 ? ">" : `> ${line}`))
      .join("\n")
  );
}

/**
 * Appends a quote to whatever is already drafted. Returns the new prompt and
 * the cursor offset, which is always the very end — the blank line under the
 * quote.
 */
export function buildQuotedPrompt(input: { readonly prompt: string; readonly selection: string }): {
  readonly prompt: string;
  readonly cursor: number;
} {
  const quote = formatQuoteBlock(input.selection);
  if (quote.length === 0) {
    return { prompt: input.prompt, cursor: input.prompt.length };
  }
  const existing = input.prompt.replace(/\s+$/, "");
  // Separate an existing draft from the quote by a blank line so the two do not
  // merge into one paragraph.
  const prefix = existing.length > 0 ? `${existing}\n\n` : "";
  const prompt = `${prefix}${quote}${QUOTE_TRAILER}`;
  return { prompt, cursor: prompt.length };
}

interface ComposerQuoteState {
  /** Selection awaiting insertion, consumed by the active composer. */
  readonly pending: string | null;
  requestQuote: (selection: string) => void;
  takeQuote: () => string | null;
}

export const useComposerQuoteStore = create<ComposerQuoteState>((set, get) => ({
  pending: null,
  requestQuote: (selection) => {
    if (selection.trim().length === 0) return;
    set({ pending: selection });
  },
  takeQuote: () => {
    const { pending } = get();
    if (pending === null) return null;
    // Cleared on read so a remount cannot re-insert the same quote.
    set({ pending: null });
    return pending;
  },
}));

/** Reads the current document selection, ignoring selections inside inputs. */
export function readDocumentSelection(): string {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return "";
  return selection.toString();
}
