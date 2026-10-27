import { describe, expect, it } from "vite-plus/test";

import {
  parseServeSimServerState,
  parseSimulators,
  serveSimViewerUrl,
  simctlDeviceState,
  simulatorCatalog,
  type SimctlList,
} from "./iosSimulators.ts";

const IOS_26 = "com.apple.CoreSimulator.SimRuntime.iOS-26-5";
const IOS_18 = "com.apple.CoreSimulator.SimRuntime.iOS-18-5";
const WATCH = "com.apple.CoreSimulator.SimRuntime.watchOS-11-5";
const type = (name: string, productFamily: string) => ({
  identifier: `com.apple.CoreSimulator.SimDeviceType.${name.replaceAll(" ", "-")}`,
  name,
  productFamily,
});

const list: SimctlList = {
  devicetypes: [type("Apple Watch Ultra 2", "Apple Watch")],
  runtimes: [
    {
      identifier: IOS_18,
      name: "iOS 18.5",
      version: "18.5",
      platform: "iOS",
      isAvailable: true,
      supportedDeviceTypes: [
        type("iPhone 16 Pro", "iPhone"),
        type("iPad Air 11-inch (M2)", "iPad"),
      ],
    },
    {
      identifier: IOS_26,
      name: "iOS 26.5",
      version: "26.5",
      platform: "iOS",
      isAvailable: true,
      supportedDeviceTypes: [
        type("iPhone 17 Pro", "iPhone"),
        type("iPad Pro 13-inch (M5)", "iPad"),
        type("iPhone 17", "iPhone"),
        type("iPhone 16 Pro", "iPhone"),
      ],
    },
    {
      identifier: WATCH,
      name: "watchOS 11.5",
      version: "11.5",
      platform: "watchOS",
      isAvailable: true,
      supportedDeviceTypes: [type("Apple Watch Ultra 2", "Apple Watch")],
    },
  ],
  devices: {
    [IOS_18]: [
      {
        udid: "B",
        name: "Old Phone",
        state: "Shutdown",
        isAvailable: true,
        deviceTypeIdentifier: type("iPhone 16 Pro", "iPhone").identifier,
      },
    ],
    [IOS_26]: [
      {
        udid: "A",
        name: "My iPhone",
        state: "Booted",
        isAvailable: true,
        deviceTypeIdentifier: type("iPhone 17 Pro", "iPhone").identifier,
      },
      {
        udid: "C",
        name: "Tablet",
        state: "Shutting Down",
        isAvailable: true,
        deviceTypeIdentifier: type("iPad Pro 13-inch (M5)", "iPad").identifier,
      },
      {
        udid: "D",
        name: "Broken",
        state: "Shutdown",
        isAvailable: false,
        deviceTypeIdentifier: type("iPhone 17", "iPhone").identifier,
      },
    ],
    [WATCH]: [
      {
        udid: "W",
        name: "Watch",
        state: "Shutdown",
        isAvailable: true,
        deviceTypeIdentifier: type("Apple Watch Ultra 2", "Apple Watch").identifier,
      },
    ],
  },
};

describe("iOS simulators", () => {
  it("lists available iPhones and iPads, newest iOS first", () => {
    expect(parseSimulators(list)).toEqual([
      {
        platform: "ios",
        id: "A",
        name: "My iPhone",
        model: "iPhone 17 Pro",
        system: "iOS 26.5",
        kind: "phone",
        state: "on",
      },
      {
        platform: "ios",
        id: "C",
        name: "Tablet",
        model: "iPad Pro 13-inch (M5)",
        system: "iOS 26.5",
        kind: "tablet",
        state: "stopping",
      },
      {
        platform: "ios",
        id: "B",
        name: "Old Phone",
        model: "iPhone 16 Pro",
        system: "iOS 18.5",
        kind: "phone",
        state: "off",
      },
    ]);
  });

  it("folds simctl states into four", () => {
    expect(
      ["Booted", "Booting", "Creating", "Shutting Down", "Shutdown"].map(simctlDeviceState),
    ).toEqual(["on", "starting", "starting", "stopping", "off"]);
  });

  it("offers each model once, phones first, and which iOS versions run it", () => {
    const catalog = simulatorCatalog(list);
    expect(catalog.models.map((model) => model.name)).toEqual([
      "iPhone 17 Pro",
      "iPhone 17",
      "iPhone 16 Pro",
      "iPad Pro 13-inch (M5)",
      "iPad Air 11-inch (M2)",
    ]);
    expect(catalog.systems.map((system) => [system.name, system.modelIds.length])).toEqual([
      ["iOS 26.5", 4],
      ["iOS 18.5", 2],
    ]);
    expect(catalog.detail).toBeNull();
    expect(simulatorCatalog({}).detail).toMatch(/Xcode/u);
  });

  it("reads serve-sim's state file and builds the viewer URL", () => {
    const state = parseServeSimServerState(
      JSON.stringify({ pid: 12, port: 3201, device: "A-B", url: "http://127.0.0.1:3201" }),
    );
    expect(state).toEqual({ pid: 12, port: 3201, device: "A-B" });
    expect(serveSimViewerUrl(state!)).toBe("http://127.0.0.1:3201/?device=A-B");
    expect(parseServeSimServerState('{"pid": 12')).toBeNull();
    expect(parseServeSimServerState('{"pid": "12", "port": 1, "device": "A"}')).toBeNull();
  });
});
