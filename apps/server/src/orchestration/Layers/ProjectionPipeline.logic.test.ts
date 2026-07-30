import { describe, expect, it } from "vite-plus/test";

import { settledTurnStateForSessionStatus } from "./ProjectionPipeline.ts";

describe("settledTurnStateForSessionStatus", () => {
  it("distinguishes unexpected provider exit from explicit user interruption", () => {
    expect(settledTurnStateForSessionStatus("stopped")).toBe("incomplete");
    expect(settledTurnStateForSessionStatus("interrupted")).toBe("interrupted");
  });

  it("preserves normal completion and terminal failure states", () => {
    expect(settledTurnStateForSessionStatus("ready")).toBe("completed");
    expect(settledTurnStateForSessionStatus("idle")).toBe("completed");
    expect(settledTurnStateForSessionStatus("error")).toBe("error");
    expect(settledTurnStateForSessionStatus("starting")).toBeNull();
    expect(settledTurnStateForSessionStatus("running")).toBeNull();
  });

  it("does not rewrite a restart-incomplete turn when a surviving adapter later syncs ready", () => {
    let turnState: "running" | "completed" | "interrupted" | "incomplete" | "error" = "running";
    for (const sessionStatus of ["stopped", "ready"] as const) {
      if (turnState !== "running") continue;
      turnState = settledTurnStateForSessionStatus(sessionStatus) ?? turnState;
    }

    expect(turnState).toBe("incomplete");
  });
});
