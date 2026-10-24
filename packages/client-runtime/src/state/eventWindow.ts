import * as Stream from "effect/Stream";

/**
 * How many of the newest events an {@link EventWindow} keeps. A consumer that
 * renders even once every couple of seconds sees every event of a 16 events/s
 * video stream; the window only has to bridge the gap between two renders.
 */
export const DEFAULT_EVENT_WINDOW_CAPACITY = 32;

/**
 * A stream's newest events, for consumers that read an atom rather than
 * subscribe.
 *
 * A stream atom holds only the last element, and elements the stream emits in
 * the same tick (one RPC chunk, a replayed preamble) collapse into one
 * notification, so a reader that reacts to "the current value" never sees the
 * rest. For remote control that meant a viewer joining an already-approved
 * session got `session-updated(approved)` and the retained video chunk
 * together, saw only the chunk, and waited forever for an approval the host
 * had already given. The window is cumulative, so a collapse loses nothing: the
 * latest value always still contains everything the reader has not seen.
 */
export interface EventWindow<A> {
  /** Identifies one run of the stream; a reconnect starts a new epoch. */
  readonly epoch: number;
  /** How many events this run has delivered so far. */
  readonly sequence: number;
  /** The newest events, oldest first, at most the window's capacity. */
  readonly events: ReadonlyArray<A>;
}

let nextEpoch = 1;

/** Re-shapes a stream into cumulative windows; apply it as a subscription atom's `transform`. */
export const toEventWindows =
  (capacity: number = DEFAULT_EVENT_WINDOW_CAPACITY) =>
  <A, E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<EventWindow<A>, E, R> =>
    Stream.suspend(() => {
      // One epoch per run, so a reconnect that replays from the start can be
      // told apart from the run the reader was in the middle of.
      const epoch = nextEpoch++;
      const initial: EventWindow<A> = { epoch, sequence: 0, events: [] };
      return stream.pipe(
        Stream.scan(
          initial,
          (window, event): EventWindow<A> => ({
            epoch,
            sequence: window.sequence + 1,
            events:
              window.events.length >= capacity
                ? [...window.events.slice(window.events.length - capacity + 1), event]
                : [...window.events, event],
          }),
        ),
      );
    });

/** What a reader has already handled; keep it in a ref next to the effect that reads. */
export interface EventCursor {
  readonly epoch: number | null;
  readonly seen: number;
}

export const INITIAL_EVENT_CURSOR: EventCursor = { epoch: null, seen: 0 };

export interface UnseenEvents<A> {
  /** Events not yet handled, oldest first. */
  readonly events: ReadonlyArray<A>;
  /** Store this back as the reader's cursor. */
  readonly cursor: EventCursor;
  /**
   * Events that left the window before the reader got to them. Zero unless the
   * reader went more than a window's worth of events without reading.
   */
  readonly missed: number;
}

export function takeUnseenEvents<A>(
  window: EventWindow<A> | null,
  cursor: EventCursor,
): UnseenEvents<A> {
  if (window === null) return { events: [], cursor, missed: 0 };
  const seen = window.epoch === cursor.epoch ? cursor.seen : 0;
  const firstHeld = window.sequence - window.events.length;
  return {
    events: window.events.slice(Math.max(0, seen - firstHeld)),
    cursor: { epoch: window.epoch, seen: window.sequence },
    missed: Math.max(0, firstHeld - seen),
  };
}
