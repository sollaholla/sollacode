/** Read the session estimate without treating it as an account balance or quota. */
export function openCodeUsageWindows(raw: unknown) {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("source" in raw) ||
    raw.source !== "opencode-session" ||
    !("sessionId" in raw) ||
    typeof raw.sessionId !== "string" ||
    !raw.sessionId.trim() ||
    !("sessionCost" in raw) ||
    typeof raw.sessionCost !== "number" ||
    !Number.isFinite(raw.sessionCost) ||
    raw.sessionCost < 0
  )
    return [];
  const cost = raw.sessionCost;
  return [
    {
      key: "session-cost",
      label: "Session cost",
      usedPercent: null,
      resetAt: null,
      detail: cost > 0 && cost < 0.01 ? "$<0.01" : `$${cost.toFixed(2)}`,
      description:
        "OpenCode's estimate for this session, based on model pricing. Your provider's bill may differ.",
    },
  ];
}
