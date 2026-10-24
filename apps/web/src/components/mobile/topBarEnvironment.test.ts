import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveTopBarEnvironmentId } from "./topBarEnvironment";

const env = (id: string) => id as EnvironmentId;

describe("resolveTopBarEnvironmentId", () => {
  it("uses the environment in the route for threads and agents", () => {
    expect(
      resolveTopBarEnvironmentId({ routeEnvironmentId: "remote-1", draftEnvironmentId: null }),
    ).toBe("remote-1");
  });

  it("falls back to the draft's environment on a draft route", () => {
    expect(
      resolveTopBarEnvironmentId({
        routeEnvironmentId: undefined,
        draftEnvironmentId: env("draft-env"),
      }),
    ).toBe("draft-env");
  });

  it("is null on routes that show no thread, so home and settings show no chip", () => {
    expect(
      resolveTopBarEnvironmentId({ routeEnvironmentId: undefined, draftEnvironmentId: null }),
    ).toBeNull();
  });
});
