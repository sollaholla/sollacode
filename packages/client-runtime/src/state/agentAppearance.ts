import type { VmAgentStatus } from "@t3tools/contracts";

/** Identity belongs to the agent, independent of its name, thread, provider or device. */
export function agentAvatarHue(agentId: string, avatarColor?: number | null): number {
  if (avatarColor != null && Number.isSafeInteger(avatarColor) && avatarColor >= 0) {
    // The golden angle spaces successive persisted colors around the hue wheel.
    return (220 + avatarColor * 137.50776405003785) % 360;
  }
  let hash = 2166136261;
  for (let index = 0; index < agentId.length; index += 1) {
    hash = Math.imul(hash ^ agentId.charCodeAt(index), 16777619);
  }
  // Final avalanche keeps even sequential identifiers visually distinct.
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (((hash ^ (hash >>> 16)) >>> 0) / 0x100000000) * 360;
}

/** A retained "running" snapshot must not claim that a disconnected host is online. */
export function agentPresence(status: VmAgentStatus, environmentConnected: boolean) {
  const online = status === "running" && environmentConnected;
  const detail = !environmentConnected
    ? "Environment disconnected"
    : status === "running"
      ? "Ready for events and notifications"
      : `Agent ${status}`;
  return {
    online,
    label: online ? "Online" : "Offline",
    description: `${online ? "Online" : "Offline"} — ${detail}`,
  };
}

/** A closed, softly rippled circle, fixed to identity rather than presence or animation. */
function agentBodyPath(agentId: string): string {
  const seed = agentAvatarHue(agentId) / 360;
  const phase = seed * Math.PI * 2;
  const lobes = seed < 0.5 ? 3 : 4;
  const amplitude = 1.5 + ((seed * 65536) % 1) * 0.7;
  const step = (Math.PI * 2) / 16;
  const point = (angle: number) => {
    const radius =
      30.5 + amplitude * Math.sin(lobes * angle + phase) + 0.6 * Math.cos(2 * angle - phase);
    const derivative =
      amplitude * lobes * Math.cos(lobes * angle + phase) - 1.2 * Math.sin(2 * angle - phase);
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);
    return {
      x: 40 + radius * cos,
      y: 39 + radius * sin,
      dx: derivative * cos - radius * sin,
      dy: derivative * sin + radius * cos,
    };
  };
  const pair = (x: number, y: number) => `${x.toFixed(2)} ${y.toFixed(2)}`;
  const start = point(0);
  let path = `M${pair(start.x, start.y)}`;
  for (let index = 0; index < 16; index += 1) {
    const from = point(index * step);
    const to = index === 15 ? start : point((index + 1) * step);
    // Match tangents at every join, including the seam, without sharp corners.
    path += `C${pair(from.x + (from.dx * step) / 3, from.y + (from.dy * step) / 3)} ${pair(to.x - (to.dx * step) / 3, to.y - (to.dy * step) / 3)} ${pair(to.x, to.y)}`;
  }
  return `${path}Z`;
}

/**
 * One small, static drawing for web image documents and native SvgXml. Gradients
 * are scoped to each SVG root; no DOM-global IDs, filters, assets or animation.
 * Only numeric geometry and hues enter the markup. Names and IDs are never interpolated.
 */
export function agentAvatarSvg(
  agentId: string,
  online: boolean,
  avatarColor?: number | null,
  blinking = false,
): string {
  const hue = agentAvatarHue(agentId, avatarColor).toFixed(3);
  const saturation = online ? 72 : 24;
  const color = (lightness: number) => `hsl(${hue},${saturation}%,${lightness}%)`;
  const bodyPath = agentBodyPath(agentId);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" width="80" height="80" fill="none">
  <defs>
    <clipPath id="body-clip"><path d="${bodyPath}"/></clipPath>
    <radialGradient id="body" cx=".32" cy=".23" r=".8">
      <stop stop-color="${color(88)}"/>
      <stop offset=".38" stop-color="${color(72)}"/>
      <stop offset=".75" stop-color="${color(57)}"/>
      <stop offset="1" stop-color="${color(39)}"/>
    </radialGradient>
    <radialGradient id="shadow">
      <stop stop-color="#172135" stop-opacity=".24"/>
      <stop offset="1" stop-color="#172135" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="shine">
      <stop stop-color="white" stop-opacity=".58"/>
      <stop offset="1" stop-color="white" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="eyes" x2="0" y2="1">
      <stop stop-color="#293048"/><stop offset="1" stop-color="#141827"/>
    </linearGradient>
  </defs>
  <ellipse cx="40" cy="72" rx="32" ry="6" fill="url(#shadow)"/>
  <path d="${bodyPath}" fill="url(#body)"/>
  <g clip-path="url(#body-clip)">
  <ellipse cx="29" cy="24" rx="18" ry="13" fill="url(#shine)" transform="rotate(-28 29 24)"/>
  <path d="M20 24C24 17 31 13 38 13" stroke="white" stroke-opacity=".35" stroke-width="1.7" stroke-linecap="round"/>
  </g>
  <g transform="translate(0 -4)">
  ${
    blinking
      ? `<path d="M25.5 43Q29 40.5 32.5 43M47.5 43Q51 40.5 54.5 43" stroke="#293048" stroke-width="2.5" stroke-linecap="round"/>`
      : `<ellipse cx="29" cy="42" rx="3.6" ry="4.6" fill="url(#eyes)"/>
  <ellipse cx="51" cy="42" rx="3.6" ry="4.6" fill="url(#eyes)"/>
  <circle cx="28" cy="40.6" r="1.1" fill="white" opacity=".92"/>
  <circle cx="50" cy="40.6" r="1.1" fill="white" opacity=".92"/>`
  }
  <path d="M35 52C37 56 43 56 45 52" stroke="#303044" stroke-width="2.6" stroke-linecap="round"/>
  </g>
</svg>`;
}
