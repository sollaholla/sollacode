import type { VmAgentStatus } from "@t3tools/contracts";

/**
 * Solla agent avatars: a galaxy sealed in a glass sphere. The orbs are rendered
 * ahead of time by scripts/agent-orbs, as stacked images, so a client turns the
 * inside behind still glass. This module only says which orb an agent is, and
 * draws the corner mark that says what it is doing.
 */
export type AgentAvatarMood =
  | "idle"
  | "working"
  | "waiting"
  | "blocked"
  | "happy"
  | "speaking"
  | "sleeping";

/**
 * Every agent orb and the color it reads as. An agent's stored `avatarColor`
 * indexes this list, so never reorder it; add new orbs at the end.
 */
export const AGENT_ORBS = [
  { name: "orion", color: "#ff2f86" },
  { name: "abyss", color: "#23c9a6" },
  { name: "ember", color: "#e63bd0" },
  { name: "aurora", color: "#32f0b0" },
  { name: "saturn", color: "#ff8a3a" },
  { name: "rosette", color: "#ff5a8a" },
  { name: "maelstrom", color: "#a74cff" },
  { name: "nova", color: "#18d0c0" },
  { name: "siren", color: "#ff5aa0" },
  { name: "solstice", color: "#ff7a2a" },
  { name: "glacier", color: "#58b8ff" },
  { name: "verdant", color: "#5ae05a" },
  { name: "tempest", color: "#6a7aff" },
  { name: "pulsar", color: "#ffb020" },
  { name: "cobalt", color: "#3a8cff" },
  { name: "crimson", color: "#ff3040" },
] as const;

export type AgentOrb = (typeof AGENT_ORBS)[number];
export type AgentOrbName = AgentOrb["name"];

/** Black glass and gold: the orchestrator's alone, never an agent's. */
export const ORCHESTRATOR_ORB = "sovereign";

function agentIdentitySeed(agentId: string): number {
  let hash = 2166136261;
  for (let index = 0; index < agentId.length; index += 1) {
    hash = Math.imul(hash ^ agentId.charCodeAt(index), 16777619);
  }
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

const hasStoredColor = (avatarColor?: number | null): avatarColor is number =>
  avatarColor != null && Number.isSafeInteger(avatarColor) && avatarColor >= 0;

/**
 * A stable angle per agent: the golden angle spaces persisted colors, a hash
 * covers agents without one. Motion uses it as its timing seed.
 */
export function agentAvatarHue(agentId: string, avatarColor?: number | null): number {
  if (hasStoredColor(avatarColor)) {
    return (220 + avatarColor * 137.50776405003785) % 360;
  }
  return (agentIdentitySeed(agentId) / 0x100000000) * 360;
}

/** Which orb an agent is: its stored index, or a stable pick from its id. */
export function agentOrb(agentId: string, avatarColor?: number | null): AgentOrb {
  const index = hasStoredColor(avatarColor) ? avatarColor : agentIdentitySeed(agentId);
  return AGENT_ORBS[index % AGENT_ORBS.length]!;
}

/** Presence describes the last observed agent lifecycle, independent of client connectivity. */
export function agentPresence(status: VmAgentStatus) {
  const online = status === "running";
  const detail = online ? "Ready for events and notifications" : `Agent ${status}`;
  return {
    online,
    label: online ? "Online" : "Offline",
    description: `${online ? "Online" : "Offline"} — ${detail}`,
  };
}

const INK = "#17161c";

const f = (value: number) => String(Math.round(value * 100) / 100);

const stroke = (d: string, width: number, color = INK) =>
  `<path d="${d}" stroke="${color}" stroke-width="${f(width)}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;

const dot = (x: number, y: number, r: number, fill: string) =>
  `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${fill}"/>`;

/**
 * The status mark. It stays in the same corner of the frame, upright, whatever
 * the orb does, and each state has its own shape and color, so a list of
 * 20 px avatars can be read by the corner alone.
 */
function moodBadge(mood: AgentAvatarMood): string {
  const keyline = `stroke="${INK}" stroke-width="1.8"`;
  switch (mood) {
    case "working": {
      // The dots sit on the 20 px grid (4 units a pixel), so they stay three dots there.
      const dots = [54, 62, 70].map((x) => dot(x, 10, 2.3, INK)).join("");
      return `<rect x="46" y="1.6" width="32" height="16.8" rx="8.4" fill="#fff" ${keyline}/>${dots}`;
    }
    case "waiting":
      return (
        `<circle cx="65" cy="15" r="14" fill="#ffc53d" ${keyline}/>` +
        stroke("M59.6 11.4C59.6 4.8 70.6 4.8 70.6 11.2C70.6 15.2 65 14.8 65 19M65 24h.01", 4.4)
      );
    case "blocked":
      return `<path d="M66 1.6C72.6 10 76.4 14.2 76.4 19A10.4 10.4 0 0 1 55.6 19C55.6 14.2 59.4 10 66 1.6Z" fill="#bfe9ff" ${keyline}/>`;
    case "happy":
      // Finished: a white check on green. The keyline holds it on the green bodies too.
      return (
        `<circle cx="65" cy="15" r="14" fill="#16a34a" ${keyline}/>` +
        stroke("M58 15.4L63 20.4L72.4 9.6", 4.4, "#fff")
      );
    case "sleeping": {
      const z = "M57 5H73L57 21H73";
      return stroke(z, 7.2) + stroke(z, 3.8, "#fff");
    }
    default:
      return "";
  }
}

/**
 * The mark as a small image document, or null when the mood has none. An orb
 * offline is asleep whatever its mood says. Only fixed shapes enter the markup.
 */
export function agentMoodBadgeSvg(mood: AgentAvatarMood, online: boolean): string | null {
  const mark = moodBadge(online ? mood : "sleeping");
  return mark
    ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" width="80" height="80">${mark}</svg>`
    : null;
}
