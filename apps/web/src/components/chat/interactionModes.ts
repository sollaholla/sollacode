import type { ProviderInteractionMode } from "@t3tools/contracts";
import { BotIcon, InfinityIcon, PencilRulerIcon, type LucideIcon } from "lucide-react";

/**
 * Presentation for each interaction mode, shared by the composer footer picker
 * and the compact overflow menu so both offer the same list. Lives outside
 * `ChatComposer` because that module imports the compact menu, and importing
 * back would form a cycle.
 */
export const interactionModeConfig: Record<
  ProviderInteractionMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  default: {
    label: "Build",
    description: "Make changes directly as you ask for them.",
    icon: BotIcon,
  },
  plan: {
    label: "Plan",
    description: "Research and propose an approach before changing anything.",
    icon: PencilRulerIcon,
  },
  agent: {
    label: "Agent",
    description: "Keeps working on its own until it finishes or hits a blocker.",
    icon: InfinityIcon,
  },
};

export const interactionModeOptions = Object.keys(
  interactionModeConfig,
) as ProviderInteractionMode[];
