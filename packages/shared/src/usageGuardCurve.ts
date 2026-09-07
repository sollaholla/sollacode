import type { UsageGuardProviderSettings } from "@t3tools/contracts";

/** Permitted pace overshoot fades to zero as the actual budget is consumed. */
export function usageGuardPaceAllowance(
  usedPercent: number,
  config: Pick<
    UsageGuardProviderSettings,
    "cooldownCurve" | "earlyOvershootPercent" | "curveStrength"
  >,
): number {
  const used = Math.max(0, Math.min(1, usedPercent / 100));
  const shaped =
    config.cooldownCurve === "linear"
      ? used
      : config.cooldownCurve === "late"
        ? used * used * used
        : used * used * (3 - 2 * used);
  return (config.earlyOvershootPercent ?? 10) * Math.pow(1 - shaped, config.curveStrength ?? 1);
}
