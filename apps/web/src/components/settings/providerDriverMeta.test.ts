import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";
import { BUILT_IN_PROVIDER_DRIVER_KINDS } from "@t3tools/shared/providerDrivers";
import { DRIVER_OPTIONS, getDriverOption } from "./providerDriverMeta";

describe("PROVIDER_CLIENT_DEFINITIONS", () => {
  it("offers every driver the server ships", () => {
    // A driver the server registers but Settings does not list cannot be added
    // at all: the Add provider dialog reads exactly this list, so a missing
    // entry is an invisible provider rather than a cosmetic gap. Deep Code
    // shipped that way and had to be reported before anyone noticed.
    const listed = new Set(DRIVER_OPTIONS.map((definition) => String(definition.value)));
    expect([...BUILT_IN_PROVIDER_DRIVER_KINDS].filter((kind) => !listed.has(kind))).toEqual([]);
  });

  it("gives each listed driver a label and an icon", () => {
    for (const definition of DRIVER_OPTIONS) {
      expect(definition.label.trim().length).toBeGreaterThan(0);
      expect(getDriverOption(definition.value)?.icon).toBeDefined();
    }
  });

  it("returns nothing for a driver this build does not ship", () => {
    expect(getDriverOption(ProviderDriverKind.make("nimbus-quill"))).toBeUndefined();
  });
});
