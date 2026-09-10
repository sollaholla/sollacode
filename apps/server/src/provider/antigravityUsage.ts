// @effect-diagnostics globalDate:off - Both uses reformat a timestamp the CLI already
// printed; neither reads the current time, so there is no clock to inject.
import { antigravityUsageModelFamily } from "@t3tools/shared/model";

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;

/**
 * Native `agy --print /usage` prints one TSV row per model-family quota:
 * `Gemini Models\tWeekly Limit Remaining\t0%\t2026-09-11T18:30:48Z`
 *
 * The percent is remaining, not used. A 0% remaining Gemini row is a full
 * window, not an empty one.
 */
const USAGE_LINE =
  /^([^\t]+)\t([^\t]*(?:Limit|Quota) Remaining)\t(\d+(?:\.\d+)?)%\t(\d{4}-\d{2}-\d{2}T\S+)/;

export interface AntigravityUsageWindow {
  readonly key: string;
  readonly family: string;
  readonly label: string;
  readonly remainingPercent: number;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
  readonly windowDurationMs: number | null;
}

export interface AntigravityAccountUsage {
  readonly windows: ReadonlyArray<AntigravityUsageWindow>;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function slugFamilyLabel(label: string): string {
  return (
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "models"
  );
}

function usageFamilyFromLabel(familyLabel: string): { key: string; family: string; label: string } {
  const mapped = antigravityUsageModelFamily(familyLabel);
  if (mapped === "gemini") {
    return { key: "gemini", family: "gemini", label: "Gemini" };
  }
  if (mapped === "claude-gpt") {
    return { key: "claude-gpt", family: "claude-gpt", label: "Claude and GPT" };
  }
  const slug = slugFamilyLabel(familyLabel);
  return { key: slug, family: slug, label: familyLabel.trim() };
}

function windowDurationMs(windowLabel: string): number | null {
  const lower = windowLabel.toLowerCase();
  if (/\bweek/.test(lower)) return 7 * DAY_MS;
  if (/\b(daily|one[_\s-]?day|1[_\s-]?day)\b/.test(lower)) return DAY_MS;
  if (/\b5[_\s-]?hour/.test(lower)) return 5 * HOUR_MS;
  return null;
}

function isoTimestamp(value: string): string | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function parseAntigravityAccountUsage(stdout: string): AntigravityAccountUsage | null {
  const windows: AntigravityUsageWindow[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = USAGE_LINE.exec(line);
    if (!match) continue;
    const remainingPercent = clampPercent(Number(match[3]));
    const family = usageFamilyFromLabel(match[1] ?? "");
    if (seen.has(family.key)) continue;
    seen.add(family.key);
    windows.push({
      key: family.key,
      family: family.family,
      label: family.label,
      remainingPercent,
      usedPercent: clampPercent(100 - remainingPercent),
      resetsAt: isoTimestamp(match[4] ?? ""),
      windowDurationMs: windowDurationMs(match[2] ?? ""),
    });
  }
  return windows.length > 0 ? { windows } : null;
}

export function antigravityUsageWindowsFromAccountUsage(raw: unknown): AntigravityUsageWindow[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
  const rows = (raw as { windows?: unknown }).windows;
  if (!Array.isArray(rows)) return [];
  const windows: AntigravityUsageWindow[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const key = typeof record.key === "string" ? record.key.trim() : "";
    const family = typeof record.family === "string" ? record.family.trim() : key;
    const label = typeof record.label === "string" ? record.label.trim() : "";
    if (!key || !label) continue;
    const remaining =
      typeof record.remainingPercent === "number" && Number.isFinite(record.remainingPercent)
        ? clampPercent(record.remainingPercent)
        : null;
    const used =
      typeof record.usedPercent === "number" && Number.isFinite(record.usedPercent)
        ? clampPercent(record.usedPercent)
        : remaining === null
          ? null
          : clampPercent(100 - remaining);
    if (used === null) continue;
    const resetsAt =
      typeof record.resetsAt === "string" && Number.isFinite(Date.parse(record.resetsAt))
        ? new Date(Date.parse(record.resetsAt)).toISOString()
        : null;
    const duration =
      typeof record.windowDurationMs === "number" &&
      Number.isFinite(record.windowDurationMs) &&
      record.windowDurationMs > 0
        ? record.windowDurationMs
        : null;
    windows.push({
      key,
      family: family || key,
      label,
      remainingPercent: remaining ?? clampPercent(100 - used),
      usedPercent: used,
      resetsAt,
      windowDurationMs: duration,
    });
  }
  return windows;
}
