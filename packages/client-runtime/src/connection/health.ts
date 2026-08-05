import * as Effect from "effect/Effect";

import { ConnectionTransientError } from "./model.ts";

// A host waking on battery can be responsive enough to keep its socket open
// before its server event loop is ready to answer an RPC. A genuinely closed
// socket is still detected immediately by the session's independent `closed`
// effect, so this wider deadline only protects slow-but-live connections.
export const FOREGROUND_CONNECTION_PROBE_TIMEOUT = "30 seconds";

export function withForegroundConnectionProbeTimeout<E>(
  probe: Effect.Effect<void, E>,
  targetLabel: string,
): Effect.Effect<void, E | ConnectionTransientError> {
  return probe.pipe(
    Effect.timeoutOrElse({
      duration: FOREGROUND_CONNECTION_PROBE_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new ConnectionTransientError({
            reason: "timeout",
            detail: `${targetLabel} did not respond to a connection health check.`,
          }),
        ),
    }),
  );
}
