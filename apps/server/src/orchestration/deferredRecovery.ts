import type { ProviderDriverKind } from "@t3tools/contracts";

import { isDeepCodeContextOverflow } from "../provider/deepcodeContext.ts";

export type DeferredRecoveryKind = "context-overflow-retry" | "progress-timeout-retry";

/**
 * Failures a fresh attempt repairs on its own, so surfacing them would only
 * flash a pause the system immediately contradicts:
 *
 * - context-overflow-retry: DeepCode retries the same turn with a smaller
 *   working context;
 * - progress-timeout-retry: a stalled Muse turn restarts on a fresh host, and a
 *   finished-but-unverified delivery resumes to recover its saved response
 *   instead of redoing work.
 *
 * Both get a tight budget: a second identical stall is deterministic, not a
 * wobble. When it runs out the thread pauses like any other failure.
 */
export function classifyDeferredRecoveryFailure(input: {
  readonly driver: ProviderDriverKind;
  readonly message: string;
}): DeferredRecoveryKind | null {
  const driverName = String(input.driver);
  if (driverName === "deepcode" && isDeepCodeContextOverflow(input.message)) {
    return "context-overflow-retry";
  }
  if (driverName === "muse" && /\[muse-progress-timeout\]/i.test(input.message)) {
    return "progress-timeout-retry";
  }
  return null;
}
