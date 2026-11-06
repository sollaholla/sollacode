import type { AgentOrbName } from "@t3tools/client-runtime/state/agent-appearance";
import type { ImageSourcePropType } from "react-native";

/** Rendered by scripts/agent-orbs. Metro needs each path written out, so no loop here. */
export const AGENT_ORB_IMAGES: Record<
  AgentOrbName,
  {
    readonly deep: ImageSourcePropType;
    readonly dust: ImageSourcePropType;
    readonly glass: ImageSourcePropType;
  }
> = {
  orion: {
    deep: require("../../assets/agent-orbs/orion-deep.webp"),
    dust: require("../../assets/agent-orbs/orion-dust.webp"),
    glass: require("../../assets/agent-orbs/orion-glass.webp"),
  },
  abyss: {
    deep: require("../../assets/agent-orbs/abyss-deep.webp"),
    dust: require("../../assets/agent-orbs/abyss-dust.webp"),
    glass: require("../../assets/agent-orbs/abyss-glass.webp"),
  },
  ember: {
    deep: require("../../assets/agent-orbs/ember-deep.webp"),
    dust: require("../../assets/agent-orbs/ember-dust.webp"),
    glass: require("../../assets/agent-orbs/ember-glass.webp"),
  },
  aurora: {
    deep: require("../../assets/agent-orbs/aurora-deep.webp"),
    dust: require("../../assets/agent-orbs/aurora-dust.webp"),
    glass: require("../../assets/agent-orbs/aurora-glass.webp"),
  },
  saturn: {
    deep: require("../../assets/agent-orbs/saturn-deep.webp"),
    dust: require("../../assets/agent-orbs/saturn-dust.webp"),
    glass: require("../../assets/agent-orbs/saturn-glass.webp"),
  },
  rosette: {
    deep: require("../../assets/agent-orbs/rosette-deep.webp"),
    dust: require("../../assets/agent-orbs/rosette-dust.webp"),
    glass: require("../../assets/agent-orbs/rosette-glass.webp"),
  },
  maelstrom: {
    deep: require("../../assets/agent-orbs/maelstrom-deep.webp"),
    dust: require("../../assets/agent-orbs/maelstrom-dust.webp"),
    glass: require("../../assets/agent-orbs/maelstrom-glass.webp"),
  },
  nova: {
    deep: require("../../assets/agent-orbs/nova-deep.webp"),
    dust: require("../../assets/agent-orbs/nova-dust.webp"),
    glass: require("../../assets/agent-orbs/nova-glass.webp"),
  },
  siren: {
    deep: require("../../assets/agent-orbs/siren-deep.webp"),
    dust: require("../../assets/agent-orbs/siren-dust.webp"),
    glass: require("../../assets/agent-orbs/siren-glass.webp"),
  },
  solstice: {
    deep: require("../../assets/agent-orbs/solstice-deep.webp"),
    dust: require("../../assets/agent-orbs/solstice-dust.webp"),
    glass: require("../../assets/agent-orbs/solstice-glass.webp"),
  },
  glacier: {
    deep: require("../../assets/agent-orbs/glacier-deep.webp"),
    dust: require("../../assets/agent-orbs/glacier-dust.webp"),
    glass: require("../../assets/agent-orbs/glacier-glass.webp"),
  },
  verdant: {
    deep: require("../../assets/agent-orbs/verdant-deep.webp"),
    dust: require("../../assets/agent-orbs/verdant-dust.webp"),
    glass: require("../../assets/agent-orbs/verdant-glass.webp"),
  },
  tempest: {
    deep: require("../../assets/agent-orbs/tempest-deep.webp"),
    dust: require("../../assets/agent-orbs/tempest-dust.webp"),
    glass: require("../../assets/agent-orbs/tempest-glass.webp"),
  },
  pulsar: {
    deep: require("../../assets/agent-orbs/pulsar-deep.webp"),
    dust: require("../../assets/agent-orbs/pulsar-dust.webp"),
    glass: require("../../assets/agent-orbs/pulsar-glass.webp"),
  },
  cobalt: {
    deep: require("../../assets/agent-orbs/cobalt-deep.webp"),
    dust: require("../../assets/agent-orbs/cobalt-dust.webp"),
    glass: require("../../assets/agent-orbs/cobalt-glass.webp"),
  },
  crimson: {
    deep: require("../../assets/agent-orbs/crimson-deep.webp"),
    dust: require("../../assets/agent-orbs/crimson-dust.webp"),
    glass: require("../../assets/agent-orbs/crimson-glass.webp"),
  },
};
