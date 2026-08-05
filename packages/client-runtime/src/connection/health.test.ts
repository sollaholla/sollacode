import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  FOREGROUND_CONNECTION_PROBE_TIMEOUT,
  withForegroundConnectionProbeTimeout,
} from "./health.ts";

describe("foreground connection health probe", () => {
  it.effect("allows a waking low-power host more than fifteen seconds to respond", () =>
    Effect.gen(function* () {
      const fiber = yield* withForegroundConnectionProbeTimeout(
        Effect.sleep("20 seconds"),
        "Local Mac",
      ).pipe(Effect.forkChild);

      yield* TestClock.adjust("15 seconds");
      expect(fiber.pollUnsafe()).toBeUndefined();

      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(`times out an unresponsive probe after ${FOREGROUND_CONNECTION_PROBE_TIMEOUT}`, () =>
    Effect.gen(function* () {
      const fiber = yield* withForegroundConnectionProbeTimeout(Effect.never, "Local Mac").pipe(
        Effect.forkChild,
      );

      yield* TestClock.adjust(FOREGROUND_CONNECTION_PROBE_TIMEOUT);
      const failure = yield* Fiber.join(fiber).pipe(Effect.flip);

      expect(failure.reason).toBe("timeout");
      expect(failure.message).toContain("Local Mac");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
