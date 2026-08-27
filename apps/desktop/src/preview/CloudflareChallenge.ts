const normalizedHeaderValue = (value: unknown): string | null => {
  if (typeof value === "string") return value.trim().toLowerCase();
  if (typeof value === "number") return String(value);
  return null;
};

export const isCfMitigatedChallenge = (headers: unknown): boolean => {
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) return false;

  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "cf-mitigated") continue;
    return normalizedHeaderValue(value) === "challenge";
  }

  return false;
};

export const classifyPreviewNetworkResponse = (
  status: number,
  headers: unknown,
): {
  readonly record: boolean;
  readonly failed: boolean;
  readonly cfMitigated: boolean;
} => {
  const cfMitigated = isCfMitigatedChallenge(headers);
  const failed = status >= 400;
  return { record: failed || cfMitigated, failed, cfMitigated };
};
