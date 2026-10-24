import { describe, expect, it } from "vite-plus/test";

import {
  batterySeverity,
  describeBattery,
  describeStorage,
  formatStorageBytes,
  storageSeverity,
} from "./HostVitalsChip.logic.ts";

const GB = 1_000_000_000;

describe("formatStorageBytes", () => {
  it("keeps a decimal digit only where it is informative", () => {
    expect(formatStorageBytes(250_000_000)).toBe("250 MB");
    expect(formatStorageBytes(4.2 * GB)).toBe("4.2 GB");
    expect(formatStorageBytes(66.4 * GB)).toBe("66 GB");
    expect(formatStorageBytes(1_500 * GB)).toBe("1.5 TB");
  });
});

describe("storageSeverity", () => {
  it("goes critical below 5 GB and warns below 20 GB", () => {
    expect(storageSeverity({ freeBytes: 0.25 * GB, totalBytes: 926 * GB })).toBe("critical");
    expect(storageSeverity({ freeBytes: 19 * GB, totalBytes: 926 * GB })).toBe("warning");
    expect(storageSeverity({ freeBytes: 20 * GB, totalBytes: 926 * GB })).toBe("normal");
  });

  it("does not depend on the size of the drive", () => {
    expect(storageSeverity({ freeBytes: 150 * GB, totalBytes: 4_000 * GB })).toBe("normal");
    expect(storageSeverity({ freeBytes: 7 * GB, totalBytes: 256 * GB })).toBe("warning");
  });
});

describe("batterySeverity", () => {
  it("only worries about a battery that is discharging", () => {
    expect(batterySeverity({ percent: 5, pluggedIn: true })).toBe("normal");
    expect(batterySeverity({ percent: 5, pluggedIn: false })).toBe("critical");
    expect(batterySeverity({ percent: 15, pluggedIn: false })).toBe("warning");
    expect(batterySeverity({ percent: 80, pluggedIn: false })).toBe("normal");
  });
});

describe("descriptions", () => {
  it("spell out what the compact chip abbreviates", () => {
    expect(describeStorage({ freeBytes: 66 * GB, totalBytes: 926 * GB })).toBe(
      "66 GB free of 926 GB (93% used)",
    );
    expect(describeBattery({ percent: 87, pluggedIn: false })).toBe("87%, on battery");
  });
});
