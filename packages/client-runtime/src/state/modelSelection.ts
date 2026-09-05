import type { ModelCapabilities, ModelSelection } from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

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
