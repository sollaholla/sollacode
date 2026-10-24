import type { HostVitals } from "@t3tools/contracts";

export type VitalSeverity = "normal" | "warning" | "critical";

const GB = 1_000_000_000;

/** Decimal units, matching what macOS, Windows and phones report for a disk. */
export function formatStorageBytes(bytes: number): string {
  if (bytes >= 1_000 * GB) return `${(bytes / (1_000 * GB)).toFixed(1)} TB`;
  if (bytes >= 10 * GB) return `${Math.round(bytes / GB)} GB`;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/**
 * Absolute free space, not a percentage: what stops a machine is running out
 * of bytes, and 3% of a 4 TB drive is plenty while 3% of a laptop is not.
 */
export function storageSeverity(storage: NonNullable<HostVitals["storage"]>): VitalSeverity {
  if (storage.freeBytes < 5 * GB) return "critical";
  if (storage.freeBytes < 20 * GB) return "warning";
  return "normal";
}

/** A charging or full battery is never a concern, however low the number. */
export function batterySeverity(battery: NonNullable<HostVitals["battery"]>): VitalSeverity {
  if (battery.pluggedIn) return "normal";
  if (battery.percent < 10) return "critical";
  if (battery.percent < 20) return "warning";
  return "normal";
}

export function describeStorage(storage: NonNullable<HostVitals["storage"]>): string {
  const used =
    storage.totalBytes > 0
      ? Math.round(((storage.totalBytes - storage.freeBytes) / storage.totalBytes) * 100)
      : 0;
  return `${formatStorageBytes(storage.freeBytes)} free of ${formatStorageBytes(storage.totalBytes)} (${used}% used)`;
}

export function describeBattery(battery: NonNullable<HostVitals["battery"]>): string {
  return `${battery.percent}%, ${battery.pluggedIn ? "plugged in" : "on battery"}`;
}
