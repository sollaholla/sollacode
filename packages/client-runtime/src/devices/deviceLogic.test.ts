import type { DevicePlatformCatalog, DeviceSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeDevice,
  deviceDraftProblem,
  initialDeviceDraft,
  orderDevicesForOpening,
  selectDeviceModel,
} from "./deviceLogic.ts";

const catalog: DevicePlatformCatalog = {
  platform: "ios",
  models: [
    { id: "iphone-17-pro", name: "iPhone 17 Pro", kind: "phone" },
    { id: "iphone-15", name: "iPhone 15", kind: "phone" },
  ],
  systems: [
    { id: "ios-26", name: "iOS 26.5", modelIds: ["iphone-17-pro"] },
    { id: "ios-18", name: "iOS 18.5", modelIds: ["iphone-15"] },
  ],
  detail: null,
};

const device = (overrides: Partial<DeviceSummary>): DeviceSummary =>
  ({
    platform: "ios",
    id: "id",
    name: "iPhone 17 Pro",
    model: "iPhone 17 Pro",
    system: "iOS 26.5",
    kind: "phone",
    state: "off",
    ...overrides,
  }) as DeviceSummary;

describe("device logic", () => {
  it("starts on the newest model and the newest system that runs it", () => {
    expect(initialDeviceDraft(catalog)).toEqual({
      platform: "ios",
      modelId: "iphone-17-pro",
      systemId: "ios-26",
      name: "iPhone 17 Pro",
      nameEdited: false,
    });
  });

  it("moves to a system that runs the new model, and the name follows until edited", () => {
    const next = selectDeviceModel(catalog, initialDeviceDraft(catalog), "iphone-15");
    expect([next.systemId, next.name]).toEqual(["ios-18", "iPhone 15"]);
    const named = { ...initialDeviceDraft(catalog), name: "Demo", nameEdited: true };
    expect(selectDeviceModel(catalog, named, "iphone-15").name).toBe("Demo");
  });

  it("explains what's missing before a device can be added", () => {
    const draft = initialDeviceDraft(catalog);
    expect(deviceDraftProblem(catalog, draft)).toBeNull();
    expect(deviceDraftProblem(catalog, { ...draft, systemId: "ios-18" })).toBe(
      "Choose a system version.",
    );
    expect(deviceDraftProblem(catalog, { ...draft, name: " " })).toBe("Give it a name.");
    expect(deviceDraftProblem({ ...catalog, detail: "Install Xcode." }, draft)).toBe(
      "Install Xcode.",
    );
  });

  it("lists running devices first, then phones before tablets", () => {
    const ordered = orderDevicesForOpening([
      device({ id: "tablet", kind: "tablet" }),
      device({ id: "phone" }),
      device({ id: "running-tablet", kind: "tablet", state: "on" }),
      device({ id: "starting", state: "starting" }),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual([
      "starting",
      "running-tablet",
      "phone",
      "tablet",
    ]);
  });

  it("describes a device without repeating its name", () => {
    expect(describeDevice(device({}))).toBe("iOS 26.5");
    expect(describeDevice(device({ name: "Demo" }))).toBe("iPhone 17 Pro · iOS 26.5");
  });
});
