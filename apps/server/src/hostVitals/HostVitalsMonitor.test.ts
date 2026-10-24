import * as NodeOS from "node:os";

import { describe, expect, it } from "vite-plus/test";

import {
  parseLinuxBattery,
  parsePmsetBattery,
  parseWindowsBattery,
  readStorage,
} from "./HostVitalsMonitor.ts";

describe("parsePmsetBattery", () => {
  it("reads a laptop running on battery", () => {
    expect(
      parsePmsetBattery(
        "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4653155)\t87%; discharging; 5:23 remaining present: true\n",
      ),
    ).toEqual({ percent: 87, pluggedIn: false });
  });

  it("reads a laptop on the charger, charging or fully charged", () => {
    expect(
      parsePmsetBattery(
        "Now drawing from 'AC Power'\n -InternalBattery-0 (id=4653155)\t42%; charging; 1:10 remaining present: true\n",
      ),
    ).toEqual({ percent: 42, pluggedIn: true });
    expect(
      parsePmsetBattery(
        "Now drawing from 'AC Power'\n -InternalBattery-0 (id=4653155)\t100%; charged; 0:00 remaining present: true\n",
      ),
    ).toEqual({ percent: 100, pluggedIn: true });
  });

  it("reports no battery for a desktop that only names its power source", () => {
    expect(parsePmsetBattery("Now drawing from 'AC Power'\n")).toBeNull();
    expect(parsePmsetBattery("")).toBeNull();
  });
});

describe("parseWindowsBattery", () => {
  it("reads one battery, as an object or a single-element list", () => {
    expect(parseWindowsBattery('{"EstimatedChargeRemaining":64,"BatteryStatus":1}')).toEqual({
      percent: 64,
      pluggedIn: false,
    });
    expect(parseWindowsBattery('[{"EstimatedChargeRemaining":100,"BatteryStatus":2}]')).toEqual({
      percent: 100,
      pluggedIn: true,
    });
  });

  it("reports no battery for empty or malformed output", () => {
    expect(parseWindowsBattery("")).toBeNull();
    expect(parseWindowsBattery("not json")).toBeNull();
    expect(parseWindowsBattery('{"BatteryStatus":2}')).toBeNull();
  });
});

describe("parseLinuxBattery", () => {
  it("treats only Discharging as unplugged", () => {
    expect(parseLinuxBattery({ capacity: "55\n", status: "Discharging\n" })).toEqual({
      percent: 55,
      pluggedIn: false,
    });
    expect(parseLinuxBattery({ capacity: "100\n", status: "Full\n" })).toEqual({
      percent: 100,
      pluggedIn: true,
    });
    expect(parseLinuxBattery({ capacity: "", status: "Full" })).toBeNull();
  });
});

describe("readStorage", () => {
  it("reports the volume holding a directory, with free no larger than total", async () => {
    const storage = await readStorage(NodeOS.tmpdir());
    expect(storage).not.toBeNull();
    expect(storage!.totalBytes).toBeGreaterThan(0);
    expect(storage!.freeBytes).toBeLessThanOrEqual(storage!.totalBytes);
  });

  it("reports null rather than throwing for a missing directory", async () => {
    expect(await readStorage("/nonexistent/host-vitals-missing")).toBeNull();
  });
});
