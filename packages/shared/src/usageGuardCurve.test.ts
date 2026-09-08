import * as Schema from "effect/Schema";
import {
  UsageGuardProviderSettings,
  ProviderInstanceId,
  DEFAULT_SERVER_SETTINGS,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "./serverSettings.ts";
import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_USAGE_GUARD_PROVIDER_SETTINGS as defaults } from "@t3tools/contracts";
import { usageGuardPaceAllowance } from "./usageGuardCurve.ts";

const decodeGuard = Schema.decodeSync(UsageGuardProviderSettings);

describe("cooldown curve", () => {
  for (const cooldownCurve of ["linear", "bump", "late"] as const) {
    it(`${cooldownCurve} allows 10% extra after reset and tightens monotonically to zero`, () => {
      const config = { ...defaults, cooldownCurve };
      expect(usageGuardPaceAllowance(0, config)).toBe(10);
      expect(usageGuardPaceAllowance(100, config)).toBe(0);
      const values = Array.from({ length: 101 }, (_, used) =>
        usageGuardPaceAllowance(used, config),
      );
      expect(values.every((value, index) => index === 0 || value <= values[index - 1]!)).toBe(true);
    });
  }
  it("lets strength tighten sooner and zero allowance disables overshoot", () => {
    expect(usageGuardPaceAllowance(50, { ...defaults, curveStrength: 2 })).toBeLessThan(
      usageGuardPaceAllowance(50, defaults),
    );
    expect(usageGuardPaceAllowance(0, { ...defaults, earlyOvershootPercent: 0 })).toBe(0);
  });
});

it("persists custom curve fields through settings patches and supplies defaults", () => {
  const id = ProviderInstanceId.make("codex");
  const updated = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
    usageGuard: {
      providers: { [id]: { cooldownCurve: "late", curveStrength: 2, earlyOvershootPercent: 12 } },
    },
  });
  const persisted = updated.usageGuard.providers[id];
  expect(persisted).toBeDefined();
  if (persisted === undefined) throw new Error("usage guard provider settings were not persisted");
  const restored = decodeGuard(persisted);
  expect(restored.cooldownCurve).toBe("late");
  expect(restored.curveStrength).toBe(2);
  expect(restored.earlyOvershootPercent).toBe(12);
  expect(decodeGuard({}).earlyOvershootPercent).toBe(10);
  expect(() => decodeGuard({ earlyOvershootPercent: 200 })).toThrow();
});
