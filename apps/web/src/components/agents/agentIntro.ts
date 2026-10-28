import {
  AGENT_AVATAR_SHAPES,
  agentAvatarTraits,
  type AgentAvatarMood,
} from "@t3tools/client-runtime/state/agent-appearance";

/** The intro offers the designed cast: one character per body shape. */
export const AGENT_INTRO_CAST: ReadonlyArray<number> = AGENT_AVATAR_SHAPES.map((_, index) => index);

/** Characters that pop in on the welcome step, in order. */
export const AGENT_INTRO_WELCOME_CAST: ReadonlyArray<number> = [0, 4, 2, 3, 1, 5, 10];

/** A character's suggested name: its shape, capitalized ("Mochi", "Lantern"). */
export function agentIntroDefaultName(avatarColor: number): string {
  const shape = agentAvatarTraits("agent-intro", avatarColor).shape;
  return shape.charAt(0).toUpperCase() + shape.slice(1);
}

export interface AgentIntroStarter {
  readonly label: string;
  readonly purpose: string;
}

/** One-tap purposes for a first agent; each is something agents do well. */
export const AGENT_INTRO_STARTERS: ReadonlyArray<AgentIntroStarter> = [
  {
    label: "Research scout",
    purpose: "Research topics I give you in the browser and send me a short summary with links.",
  },
  {
    label: "Release watcher",
    purpose:
      "Each morning, check the projects and libraries I care about for new releases and tell me what changed.",
  },
  {
    label: "PR babysitter",
    purpose:
      "Watch my open pull requests, summarize new review comments, and tell me when checks fail.",
  },
  {
    label: "Daily digest",
    purpose: "Every weekday morning, summarize what happened in my projects yesterday.",
  },
];

/**
 * The preview character's face on the naming step: curious while you type,
 * busy while it is being created, worried on an error, delighted when ready.
 */
export function agentIntroPreviewMood(input: {
  readonly name: string;
  readonly purpose: string;
  readonly typing: boolean;
  readonly busy: boolean;
  readonly failed: boolean;
}): AgentAvatarMood {
  if (input.busy) return "working";
  if (input.failed) return "blocked";
  if (input.name.trim().length > 0 && input.purpose.trim().length > 0) return "happy";
  return input.typing ? "waiting" : "idle";
}
