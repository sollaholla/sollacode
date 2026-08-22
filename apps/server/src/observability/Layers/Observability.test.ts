import { assert, describe, it } from "@effect/vitest";

import { shouldPersistServerEffectSpan } from "./Observability.ts";

describe("server local trace filtering", () => {
  it("drops fast successful SQL spans while retaining slow and failed work", () => {
    assert.isFalse(
      shouldPersistServerEffectSpan({
        name: "sql.execute",
        durationMs: 2,
        exit: { _tag: "Success" },
      }),
    );
    assert.isTrue(
      shouldPersistServerEffectSpan({
        name: "sql.execute",
        durationMs: 125,
        exit: { _tag: "Success" },
      }),
    );
    assert.isTrue(
      shouldPersistServerEffectSpan({
        name: "sql.execute",
        durationMs: 2,
        exit: { _tag: "Failure", cause: "database unavailable" },
      }),
    );
  });

  it("retains startup and normal operational spans", () => {
    assert.isTrue(
      shouldPersistServerEffectSpan({
        name: "server.startup.database",
        durationMs: 1,
        exit: { _tag: "Success" },
      }),
    );
    assert.isTrue(
      shouldPersistServerEffectSpan({
        name: "orchestration.command.thread.turn.start",
        durationMs: 1,
        exit: { _tag: "Success" },
      }),
    );
  });
});
