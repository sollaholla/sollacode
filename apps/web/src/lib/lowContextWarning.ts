export interface LowContextWarningMatch {
  readonly start: number;
  readonly end: number;
  readonly phrase: string;
}

const LOW_CONTEXT_WARNING_PATTERNS = [
  /(?:I['’]m|I am|we['’]re|we are) (?:running|getting) (?:very )?(?:low on|out of) context\b/gi,
  /(?:I['’]m|I am|we['’]re|we are) (?:nearing|approaching) (?:the )?context (?:window )?limit\b/gi,
  /(?:context(?: window)? is|context(?: window)?['’]s) (?:running |getting )?(?:very )?low\b/gi,
  /(?:running|getting) (?:very )?low on context\b/gi,
  /almost out of context\b/gi,
] as const;

const SENTENCE_BOUNDARY_PATTERN = /(?:^|[.!?]\s+|\n+\s*)(?:warning:\s*|note:\s*)?$/i;
const CONDITIONAL_PREFIX_PATTERN = /\b(?:if|when|whenever|whether|suppose|assuming)\s*$/i;

function isInsideInlineQuote(text: string, index: number): boolean {
  const lineStart = Math.max(text.lastIndexOf("\n", index - 1) + 1, 0);
  const prefix = text.slice(lineStart, index);
  const asciiDoubleQuotes = (prefix.match(/"/g) ?? []).length;
  const curlyOpenQuotes = (prefix.match(/[“]/g) ?? []).length;
  const curlyCloseQuotes = (prefix.match(/[”]/g) ?? []).length;
  return asciiDoubleQuotes % 2 === 1 || curlyOpenQuotes > curlyCloseQuotes;
}

function isClearWarningClause(text: string, start: number): boolean {
  const sentenceStart = Math.max(
    text.lastIndexOf(".", start - 1),
    text.lastIndexOf("!", start - 1),
    text.lastIndexOf("?", start - 1),
    text.lastIndexOf("\n", start - 1),
  );
  const prefix = text.slice(sentenceStart + 1, start);
  return SENTENCE_BOUNDARY_PATTERN.test(prefix) && !CONDITIONAL_PREFIX_PATTERN.test(prefix);
}

/**
 * Finds bounded, direct assistant warnings. Markdown structure is handled by
 * the renderer: code, inline code, and blockquotes are never passed here.
 */
export function findLowContextWarningMatches(text: string): ReadonlyArray<LowContextWarningMatch> {
  const matches: LowContextWarningMatch[] = [];

  for (const pattern of LOW_CONTEXT_WARNING_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const phrase = match[0];
      if (
        start === undefined ||
        phrase.length > 96 ||
        isInsideInlineQuote(text, start) ||
        !isClearWarningClause(text, start)
      ) {
        continue;
      }
      matches.push({ start, end: start + phrase.length, phrase });
    }
  }

  return matches
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .filter(
      (candidate, index, all) =>
        index === 0 || candidate.start >= (all[index - 1]?.end ?? candidate.start),
    );
}

export interface CompactAndContinueSteps {
  readonly startCompaction: () => Promise<void>;
  readonly awaitCompactionComplete: () => Promise<void>;
  readonly sendContinuation: () => Promise<void>;
  readonly onStageChange?: (stage: "compacting" | "continuing") => void;
}

/**
 * The sequencing is deliberately explicit: accepting a compact command is not
 * completion. The follow-up is sent only after the provider reports that its
 * compaction finished successfully.
 */
export async function runCompactAndContinue(steps: CompactAndContinueSteps): Promise<void> {
  steps.onStageChange?.("compacting");
  await steps.startCompaction();
  await steps.awaitCompactionComplete();
  steps.onStageChange?.("continuing");
  await steps.sendContinuation();
}
