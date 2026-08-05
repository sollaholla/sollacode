import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ConnectionSignalMailbox from "./signalMailbox.ts";

describe("ConnectionSignalMailbox", () => {
  it.effect("coalesces duplicate signals while preserving distinct wakeup classes", () =>
    Effect.gen(function* () {
      const mailbox = yield* ConnectionSignalMailbox.make();

      yield* Effect.all(
        [
          mailbox.offer({ _tag: "ApplicationActive" }),
          mailbox.offer({ _tag: "CredentialsChanged" }),
          mailbox.offer({ _tag: "ApplicationActive" }),
          mailbox.offer({ _tag: "RetryRequested" }),
          mailbox.offer({ _tag: "CredentialsChanged" }),
          mailbox.offer({ _tag: "IntentChanged" }),
        ],
        { concurrency: "unbounded", discard: true },
      );

      expect(yield* mailbox.snapshot).toEqual({
        intentChanged: true,
        retryRequested: true,
        credentialsChanged: true,
        applicationActive: true,
      });
      expect(yield* mailbox.take).toEqual({ _tag: "IntentChanged" });
      expect(yield* mailbox.take).toEqual({ _tag: "RetryRequested" });
      expect(yield* mailbox.take).toEqual({ _tag: "CredentialsChanged" });
      expect(yield* mailbox.take).toEqual({ _tag: "ApplicationActive" });
      expect(yield* mailbox.snapshot).toEqual({
        intentChanged: false,
        retryRequested: false,
        credentialsChanged: false,
        applicationActive: false,
      });
    }),
  );
});
