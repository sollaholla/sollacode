import { describe, expect, it } from "vite-plus/test";
import { BUILT_IN_PROVIDER_DRIVER_KINDS } from "@t3tools/shared/providerDrivers";
import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";

describe("BUILT_IN_DRIVERS", () => {
  it("registers exactly the drivers the shared list names", () => {
    // The clients build their provider pickers from that list. Registering a
    // driver here without adding it there ships a provider nobody can select;
    // the reverse offers one the server cannot create.
    expect([...BUILT_IN_DRIVERS.map((driver) => String(driver.driverKind))].sort()).toEqual(
      [...BUILT_IN_PROVIDER_DRIVER_KINDS].sort(),
    );
  });

  it("gives every driver a display name", () => {
    for (const driver of BUILT_IN_DRIVERS) {
      expect(driver.metadata.displayName.trim().length).toBeGreaterThan(0);
    }
  });
});
