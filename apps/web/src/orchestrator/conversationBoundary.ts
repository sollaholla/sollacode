/**
 * Telling one conversation from the next inside a single thread.
 *
 * The orchestrator has one permanent thread, so every conversation the user has
 * ever had with it is in the same message list, nose to tail. Nothing marks
 * where one ended and the next began — which is both why the model used to
 * resume a finished exchange, and why the transcript reads as one endless
 * conversation when it is really dozens.
 *
 * There is no "conversation started" event to key off: a voice session opening
 * is a client-side act, and typed messages have no session at all. The signal
 * that is always present is time. People do not leave half-hour gaps in the
 * middle of a thought; a gap that long is someone coming back later, which is a
 * new conversation by any useful definition.
 *
 * Pure and clock-free — the timestamps are the input — so the boundary can be
 * used both to build the model's context and to draw a separator, without the
 * two disagreeing.
 */

/**
 * Silence long enough to call it a new conversation.
 *
 * Half an hour is deliberately generous. A false boundary is worse than a
 * missed one: it tells the model to forget something the user still considers
 * live, and makes them repeat themselves. Someone genuinely returning after a
 * break is usually gone far longer than this.
 */
export const CONVERSATION_GAP_MS = 30 * 60 * 1_000;

/**
 * Whether `createdAt` begins a new conversation after `previousCreatedAt`.
 *
 * The first message of a thread is not a boundary: there is nothing before it
 * to separate from, and a separator above the very first line is noise.
 * Unparseable or out-of-order timestamps are treated as "no boundary" for the
 * same reason — a clock skew must not chop a live conversation in half.
 */
export function isNewConversationBoundary(input: {
  readonly previousCreatedAt: string | null;
  readonly createdAt: string;
  readonly gapMs?: number;
}): boolean {
  if (input.previousCreatedAt === null) return false;
  const previous = Date.parse(input.previousCreatedAt);
  const current = Date.parse(input.createdAt);
  if (Number.isNaN(previous) || Number.isNaN(current)) return false;
  const elapsed = current - previous;
  if (elapsed < 0) return false;
  return elapsed >= (input.gapMs ?? CONVERSATION_GAP_MS);
}

export interface ConversationBoundaryOptions<T> {
  readonly gapMs?: number;
  /**
   * Which entries are allowed to open a conversation. Defaults to any of them.
   *
   * A conversation starts when the *person* comes back, so callers that can tell
   * a user's message from everything else should say so. Without it, an agent
   * that works silently for forty minutes and then logs a step looks exactly
   * like someone returning after lunch, and the turn gets cut in half.
   */
  readonly opensConversation?: (entry: T) => boolean;
}

/**
 * Indexes of the entries that open a new conversation.
 *
 * Returned as a set of indexes rather than a transformed list so a caller can
 * draw a separator above those rows without the shape of its own list being
 * dictated here.
 */
export function findConversationBoundaries<T extends { readonly createdAt: string }>(
  entries: ReadonlyArray<T>,
  options: ConversationBoundaryOptions<T> = {},
): ReadonlySet<number> {
  const boundaries = new Set<number>();
  for (const [index, entry] of entries.entries()) {
    if (options.opensConversation !== undefined && !options.opensConversation(entry)) continue;
    const previous = entries[index - 1];
    if (
      isNewConversationBoundary({
        previousCreatedAt: previous?.createdAt ?? null,
        createdAt: entry.createdAt,
        ...(options.gapMs === undefined ? {} : { gapMs: options.gapMs }),
      })
    ) {
      boundaries.add(index);
    }
  }
  return boundaries;
}

/**
 * Trims history to the conversation in progress.
 *
 * What the model is handed as *memory* should stop at the last boundary: older
 * conversations are not wrong to remember, but they crowd out the exchange the
 * user is actually in, and the budget is small.
 */
export function entriesSinceLastBoundary<T extends { readonly createdAt: string }>(
  entries: ReadonlyArray<T>,
  options: ConversationBoundaryOptions<T> = {},
): ReadonlyArray<T> {
  const boundaries = findConversationBoundaries(entries, options);
  if (boundaries.size === 0) return entries;
  const last = Math.max(...boundaries);
  return entries.slice(last);
}
