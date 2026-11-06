import type { AgentOrbName } from "@t3tools/client-runtime/state/agent-appearance";

type OrbName = AgentOrbName | "sovereign";
type OrbLayer = "deep" | "dust" | "glass" | "corona";

// Hashed and fetched only when an orb is shown, so the list costs nothing up front.
const STILLS = import.meta.glob<string>("../../assets/agent-orbs/*.webp", {
  eager: true,
  query: "?url",
  import: "default",
});
const CLIPS = import.meta.glob<string>("../../assets/agent-orbs/*.mp4", {
  eager: true,
  query: "?url",
  import: "default",
});

/** One stacked image of an orb, as rendered by scripts/agent-orbs. */
export function orbLayerUrl(orb: OrbName, layer: OrbLayer): string {
  return STILLS[`../../assets/agent-orbs/${orb}-${layer}.webp`] ?? "";
}

/** The orb's galaxy turning once in 3D, looping seamlessly. */
export function orbClipUrl(orb: OrbName): string {
  return CLIPS[`../../assets/agent-orbs/${orb}.mp4`] ?? "";
}
