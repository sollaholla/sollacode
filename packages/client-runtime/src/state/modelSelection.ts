import type { ModelCapabilities, ModelSelection } from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

/**
 * Built-in drivers in the order Solla Code lists them. Server snapshots arrive
 * in no meaningful order, so defaults that took the first ready provider gave
 * a fresh install whichever one sorted first (often Antigravity).
 */
export const DEFAULT_PROVIDER_DRIVER_PREFERENCE: ReadonlyArray<string> = [
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "opencode",
  "antigravity",
  "deepcode",
  "muse",
  "kimi",
];

/** Lower is preferred; drivers this build does not list sort last. */
export function providerDriverPreferenceRank(driver: string): number {
  const index = DEFAULT_PROVIDER_DRIVER_PREFERENCE.indexOf(driver);
  return index === -1 ? DEFAULT_PROVIDER_DRIVER_PREFERENCE.length : index;
}

/** Apply the selection default only when the user chooses a different model or instance. */
export function selectModelWithHighEffort(
  previous: ModelSelection | null | undefined,
  next: ModelSelection,
  capabilities: ModelCapabilities | null | undefined,
): ModelSelection {
  if (previous?.instanceId === next.instanceId && previous.model === next.model) {
    return previous;
  }
  if (!capabilities) return next;

  const descriptors = getProviderOptionDescriptors({
    caps: capabilities,
    selections: next.options,
  }).map((descriptor) =>
    descriptor.type === "select" &&
    ["reasoningEffort", "effort", "reasoning", "variant"].includes(descriptor.id) &&
    descriptor.options.some((option) => option.id === "high")
      ? { ...descriptor, currentValue: "high" }
      : descriptor,
  );
  const options = buildProviderOptionSelectionsFromDescriptors(descriptors);
  return {
    instanceId: next.instanceId,
    model: next.model,
    ...(options ? { options } : {}),
  };
}
