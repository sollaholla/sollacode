import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

type TerminalResyncMarker = {
  readonly type: "resync-required";
  readonly reason: "slow-consumer";
};

export type WithoutTerminalResync<A> = Exclude<A, TerminalResyncMarker>;

/**
 * A terminal resync marker ends only the current RPC subscription. Repeating
 * the cold stream establishes a fresh server buffer whose first item is an
 * authoritative snapshot; the marker itself never reaches UI reducers.
 */
export function resubscribeOnTerminalResync<A extends { readonly type: string }, E, R>(
  stream: Stream.Stream<A, E, R>,
): Stream.Stream<WithoutTerminalResync<A>, E, R> {
  return stream.pipe(
    Stream.takeUntil((event) => event.type === "resync-required"),
    Stream.filter((event): event is WithoutTerminalResync<A> => event.type !== "resync-required"),
    Stream.repeat(Schedule.forever),
  );
}
