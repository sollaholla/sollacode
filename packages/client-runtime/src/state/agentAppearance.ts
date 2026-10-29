import type { VmAgentStatus } from "@t3tools/contracts";

/**
 * Solla agent avatars. One vivid body that fills the frame, an ink face that
 * carries every mood, and an optional ink accessory. Web draws the SVG as an
 * image document and mobile through SvgXml, so ids are scoped to each root.
 */
export type AgentAvatarMood = "idle" | "working" | "waiting" | "blocked" | "happy" | "sleeping";

export const AGENT_AVATAR_SHAPES = [
  "mochi",
  "gumdrop",
  "bell",
  "acorn",
  "lantern",
  "sunburst",
  "pebble",
  "onion",
  "capsule",
  "dango",
  "star",
] as const;
export const AGENT_AVATAR_ACCESSORIES = ["none", "goggles", "scarf", "monocle"] as const;
export const AGENT_AVATAR_EYES = ["glint", "pill", "beads", "visor"] as const;

export type AgentAvatarShape = (typeof AGENT_AVATAR_SHAPES)[number];
export type AgentAvatarAccessory = (typeof AGENT_AVATAR_ACCESSORIES)[number];
export type AgentAvatarEyes = (typeof AGENT_AVATAR_EYES)[number];

export interface AgentAvatarTraits {
  readonly hue: number;
  readonly color: string;
  readonly shape: AgentAvatarShape;
  readonly eyes: AgentAvatarEyes;
  readonly accessory: AgentAvatarAccessory;
  /** Where the agent glances when idle, in face units. */
  readonly glance: readonly [number, number];
}

/**
 * Fourteen colors, spaced in OKLab so no two sit closer than ~0.1 apart. The
 * cast takes eleven; slots 4–6 are the three left over, which is exactly where
 * the second-round mochi, bell and acorn land (cast color + 4), so a person's
 * first fourteen agents never share a color.
 */
const PALETTE = [
  "#fe6652", // coral
  "#3eb1fe", // sky
  "#bf7f43", // toffee
  "#9968fb", // violet
  "#fad035", // sunflower
  "#fe81bc", // candy
  "#c1a5fe", // lilac
  "#fe9730", // tangerine
  "#1dcd83", // jade
  "#df63e8", // orchid
  "#1dbec3", // teal
  "#f9508e", // rose
  "#92d62e", // lime
  "#507eff", // cobalt
] as const;

interface CastMember {
  readonly shape: AgentAvatarShape;
  readonly color: number;
  readonly eyes: AgentAvatarEyes;
  readonly accessory: AgentAvatarAccessory;
  readonly glance: readonly [number, number];
}

/** A person's first agents are a designed cast; later ones remix it. */
// Accessories alternate so neighbours in a list never wear the same one. Later
// rounds move each worn accessory on by one and leave a bare character bare
// (acorn→goggles, sunburst→scarf, pebble→monocle).
const CAST: readonly CastMember[] = [
  { shape: "mochi", color: 0, eyes: "glint", accessory: "none", glance: [-2.5, -1.5] },
  { shape: "bell", color: 1, eyes: "pill", accessory: "none", glance: [2, 0] },
  { shape: "acorn", color: 2, eyes: "beads", accessory: "monocle", glance: [0, -1] },
  { shape: "lantern", color: 3, eyes: "visor", accessory: "none", glance: [2.5, 0] },
  { shape: "sunburst", color: 7, eyes: "glint", accessory: "goggles", glance: [-2, 0] },
  { shape: "gumdrop", color: 8, eyes: "beads", accessory: "none", glance: [2, -1] },
  { shape: "onion", color: 9, eyes: "glint", accessory: "monocle", glance: [-1.5, -1] },
  { shape: "capsule", color: 10, eyes: "pill", accessory: "none", glance: [2.5, -1] },
  { shape: "pebble", color: 11, eyes: "glint", accessory: "scarf", glance: [-2, -1] },
  { shape: "dango", color: 12, eyes: "beads", accessory: "none", glance: [1.5, 0] },
  { shape: "star", color: 13, eyes: "glint", accessory: "none", glance: [0, -1.5] },
];

function agentIdentitySeed(agentId: string): number {
  let hash = 2166136261;
  for (let index = 0; index < agentId.length; index += 1) {
    hash = Math.imul(hash ^ agentId.charCodeAt(index), 16777619);
  }
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/**
 * A stable angle per agent: the golden angle spaces persisted colors, a hash
 * covers agents without one. Motion uses it as its timing seed.
 */
export function agentAvatarHue(agentId: string, avatarColor?: number | null): number {
  if (avatarColor != null && Number.isSafeInteger(avatarColor) && avatarColor >= 0) {
    return (220 + avatarColor * 137.50776405003785) % 360;
  }
  return (agentIdentitySeed(agentId) / 0x100000000) * 360;
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

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgbToHex(rgb: readonly number[]): string {
  return `#${rgb
    .map((channel) =>
      Math.max(0, Math.min(255, Math.round(channel)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function mix(hex: string, other: string, amount: number): string {
  const a = hexToRgb(hex);
  const b = hexToRgb(other);
  return rgbToHex(a.map((channel, index) => channel + (b[index]! - channel) * amount));
}

function hueOf(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((channel) => channel / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h =
    max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
}

const WORN_ACCESSORIES = AGENT_AVATAR_ACCESSORIES.filter((accessory) => accessory !== "none");

export function agentAvatarTraits(agentId: string, avatarColor?: number | null): AgentAvatarTraits {
  const persisted = avatarColor != null && Number.isSafeInteger(avatarColor) && avatarColor >= 0;
  const index = persisted ? avatarColor : agentIdentitySeed(agentId);
  const base = CAST[index % CAST.length]!;
  const round = Math.floor(index / CAST.length);
  const color = PALETTE[(base.color + round * 4) % PALETTE.length]!;
  const accessory =
    round === 0 || base.accessory === "none"
      ? base.accessory
      : WORN_ACCESSORIES[
          (WORN_ACCESSORIES.indexOf(base.accessory) + round) % WORN_ACCESSORIES.length
        ]!;
  const flip = round % 2 === 1 ? -1 : 1;
  return {
    hue: hueOf(color),
    color,
    shape: base.shape,
    eyes: base.eyes,
    accessory,
    glance: [base.glance[0] * flip, base.glance[1]],
  };
}

// ---------------------------------------------------------------------------
// Geometry, drawn in a canonical 80 space; body and extras are then fitted
// together to fill the frame.

type P2 = readonly [number, number];
type Box = readonly [number, number, number, number];

const f = (value: number) => String(Math.round(value * 100) / 100);
const pt = (p: P2) => `${f(p[0])} ${f(p[1])}`;

interface Geo {
  readonly body: string;
  /** Optional second tone drawn over the body (acorn cap, lantern bands). */
  readonly trim?: string;
  readonly box: Box;
  readonly face: P2;
  readonly gap: number;
  readonly sides: readonly [number, number];
  /** Top of the head. */
  readonly crown: P2;
  readonly chin: P2;
  /** Scarf line: its top y, and the body's left and right edges there. */
  readonly neck: readonly [number, number, number];
  readonly eyeScale?: number;
}

const circle = (cx: number, cy: number, r: number) =>
  `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}"/>`;

function toward(from: P2, to: P2, distance: number): P2 {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy);
  const t = Math.min(distance / length, 0.5);
  return [from[0] + dx * t, from[1] + dy * t];
}

/** Rounds every corner; odd corners (a star's valleys) may take their own radius. */
function roundedPolygonPath(points: readonly P2[], radius: number, valley = radius): string {
  let d = "";
  points.forEach((vertex, index) => {
    const prev = points[(index + points.length - 1) % points.length]!;
    const next = points[(index + 1) % points.length]!;
    const r = index % 2 === 0 ? radius : valley;
    d += `${index === 0 ? "M" : "L"}${pt(toward(vertex, prev, r))}Q${pt(vertex)} ${pt(toward(vertex, next, r))}`;
  });
  return `${d}Z`;
}

function starPoints(
  count: number,
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  phase: number,
): P2[] {
  const points: P2[] = [];
  for (let index = 0; index < count * 2; index += 1) {
    const radius = index % 2 === 0 ? outer : inner;
    const angle = phase + (index / (count * 2)) * Math.PI * 2;
    points.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]);
  }
  return points;
}

const SHAPES: Record<AgentAvatarShape, Geo> = {
  mochi: {
    body: `<path d="M40 13C59 13 70 18 72 35C74 49 74 62 66 68C59 73 49 74 40 74C31 74 21 73 14 68C6 62 6 49 8 35C10 18 21 13 40 13Z"/>`,
    box: [7, 13, 73, 74],
    face: [40, 45],
    gap: 11,
    sides: [8, 72],
    crown: [40, 13],
    chin: [40, 64],
    neck: [56, 7.5, 72.4],
  },
  gumdrop: {
    body: `<path d="M8 69C6 45 18 10 40 10C62 10 74 45 72 69Q72 74 67 74H13Q8 74 8 69Z"/>`,
    box: [7.8, 10, 72.2, 74],
    face: [40, 48],
    gap: 11,
    sides: [9, 71],
    crown: [40, 10],
    chin: [40, 66],
    neck: [58, 8, 72],
  },
  bell: {
    body: `<path d="M40 9C56 9 64 22 64 38V51C64 57 67 61 71 65Q75 71 69 72H11Q5 71 9 65C13 61 16 57 16 51V38C16 22 24 9 40 9Z"/>`,
    box: [7.4, 9, 72.6, 72],
    face: [40, 42],
    gap: 10,
    sides: [16, 64],
    crown: [40, 9],
    chin: [40, 60],
    neck: [54, 15.7, 64.2],
  },
  acorn: {
    body: `<path d="M40 75C24 75 13 63 13 47V37H67V47C67 63 56 75 40 75Z"/>`,
    trim: `<path d="M8 37C8 23 22 15 40 15C58 15 72 23 72 37Q72 42 67 42H13Q8 42 8 37Z"/><path d="M37.6 16.5C37.6 14 38.9 12 42.2 10.7Q44.6 10.2 44.6 12.3C42.4 13.4 41.6 14.7 41.6 16.5Z"/>`,
    box: [8, 10.6, 72, 75],
    face: [40, 55],
    gap: 10,
    sides: [13, 67],
    crown: [40, 15],
    chin: [40, 70],
    neck: [61.5, 16.3, 63.7],
  },
  lantern: {
    body: `<rect x="13" y="19" width="54" height="50" rx="19"/>`,
    trim: `<rect x="23" y="12" width="34" height="9" rx="4"/><rect x="23" y="67" width="34" height="8" rx="4"/>`,
    box: [13, 12, 67, 75],
    face: [40, 44],
    gap: 10.5,
    sides: [13, 67],
    crown: [40, 12],
    chin: [40, 62],
    neck: [55.5, 13.8, 66.2],
  },
  sunburst: {
    // Nine sharp-tipped rays over soft valleys: a sun, not a bottle cap.
    body: `<path d="${roundedPolygonPath(starPoints(9, 40, 42, 36, 27.5, -Math.PI / 2), 2.8, 5.5)}"/>`,
    box: [5.5, 7, 74.5, 75],
    face: [40, 43],
    gap: 10,
    sides: [11, 69],
    crown: [40, 7],
    chin: [40, 63],
    neck: [54, 11.5, 68.5],
  },
  pebble: {
    // A wide river stone, tipped up to the right: never mistaken for mochi.
    body: `<path d="M5.7 54.2C3 40.5 11.6 28.3 27.1 23.4C42.7 18.5 62.8 18 71.2 29.1C77.4 38.4 76.4 55.6 66.4 63.9C57.2 71.1 33.5 75 20 71.6C11.7 69.6 7 64.2 5.7 54.2Z"/>`,
    box: [5.2, 20.1, 75.1, 72.8],
    face: [40, 45.5],
    gap: 11.5,
    sides: [6, 75],
    crown: [44, 20],
    chin: [40, 66],
    neck: [56, 6, 72.2],
  },
  onion: {
    // The sprout leans and curls, so it is not a plain drop.
    body: `<path d="M44.5 4.2Q47.6 3.4 47 6.6Q45.4 12.4 50 17C64 24 72 37 72 50C72 64 58 75 40 75C22 75 8 64 8 50C8 37 16 24 30 17Q39.5 12.5 44.5 4.2Z"/>`,
    box: [8, 4, 72, 75],
    face: [40, 50],
    gap: 11,
    sides: [8, 72],
    crown: [44, 4],
    chin: [40, 69],
    neck: [60.5, 10.8, 69.2],
  },
  capsule: {
    body: `<rect x="15" y="7" width="50" height="68" rx="25"/>`,
    box: [15, 7, 65, 75],
    face: [40, 37],
    gap: 10,
    sides: [15, 65],
    crown: [40, 7],
    chin: [40, 58],
    neck: [48, 15, 65],
  },
  dango: {
    body: `${circle(40, 52, 24)}${circle(40, 21, 13)}`,
    box: [16, 8, 64, 76],
    face: [40, 52],
    gap: 9.5,
    sides: [16, 64],
    crown: [40, 8],
    chin: [40, 70],
    neck: [61, 17.8, 62.2],
  },
  star: {
    body: `<path d="${roundedPolygonPath(starPoints(5, 40, 44, 37, 21, -Math.PI / 2), 9)}"/>`,
    box: [8.3, 10.8, 71.7, 71.5],
    face: [40, 46],
    gap: 9,
    sides: [18, 62],
    crown: [40, 9],
    chin: [40, 60],
    neck: [53.5, 19, 61],
    eyeScale: 0.9,
  },
};

// ---------------------------------------------------------------------------
// Faces. Ink features with a white catchlight. Idle and asleep have no mouth;
// it appears only when a mood has something to say: focus, a question, worry,
// delight.

const INK = "#17161c";
const GOLD = "#ffc23d";

const stroke = (d: string, width: number, color = INK) =>
  `<path d="${d}" stroke="${color}" stroke-width="${f(width)}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;

/** Two face weights: closed eyes at eye weight, brows, lids and mouths at detail weight. */
const EYE_LINE = 3.6;
const DETAIL_LINE = 2.5;

function eyeCenters(geo: Geo, traits: AgentAvatarTraits, mood: AgentAvatarMood): [P2, P2] {
  const [gx, gy] = traits.glance;
  const shift: P2 =
    mood === "working"
      ? [gx * 0.5, 2]
      : mood === "waiting"
        ? [0, -2.2]
        : mood === "blocked"
          ? [0, 0.6]
          : mood === "idle"
            ? [gx, gy]
            : [0, mood === "sleeping" ? 1.5 : 0];
  return [
    [geo.face[0] - geo.gap + shift[0], geo.face[1] + shift[1]],
    [geo.face[0] + geo.gap + shift[0], geo.face[1] + shift[1]],
  ];
}

/** The part of an ellipse below the lid line y = c.y + k + m·(x − c.x). */
function lidEllipse(c: P2, rx: number, ry: number, k: number, m: number): string {
  const a = 1 / (rx * rx) + (m * m) / (ry * ry);
  const b = (2 * k * m) / (ry * ry);
  const disc = Math.sqrt(Math.max(0, b * b - 4 * a * ((k * k) / (ry * ry) - 1)));
  const u1 = (-b - disc) / (2 * a);
  const u2 = (-b + disc) / (2 * a);
  const p1: P2 = [c[0] + u1, c[1] + k + m * u1];
  const p2: P2 = [c[0] + u2, c[1] + k + m * u2];
  return `M${pt(p1)}L${pt(p2)}A${f(rx)} ${f(ry)} 0 ${k < 0 ? 1 : 0} 1 ${pt(p1)}Z`;
}

/** An upright pill, cut by a lid line through its straight section when given one. */
function pillPath(c: P2, w: number, h: number, lid?: readonly [number, number]): string {
  const r = w / 2;
  const limit = h / 2 - r;
  const bottom = `V${f(c[1] + limit)}A${f(r)} ${f(r)} 0 0 1 ${pt([c[0] - r, c[1] + limit])}`;
  if (!lid) {
    return `M${pt([c[0] - r, c[1] - limit])}A${f(r)} ${f(r)} 0 0 1 ${pt([c[0] + r, c[1] - limit])}${bottom}Z`;
  }
  const clamp = (y: number) => c[1] + Math.max(-limit, Math.min(limit, y));
  return `M${pt([c[0] - r, clamp(lid[0] - lid[1] * r)])}L${pt([c[0] + r, clamp(lid[0] + lid[1] * r)])}${bottom}Z`;
}

/** A thin crescent of bounced body light along the bottom of an open eye. */
function bounce(c: P2, rx: number, ry: number, color: string): string {
  const a = (28 * Math.PI) / 180;
  const right: P2 = [c[0] + rx * Math.cos(a), c[1] + ry * Math.sin(a)];
  const left: P2 = [c[0] - rx * Math.cos(a), c[1] + ry * Math.sin(a)];
  return `<path d="M${pt(right)}A${f(rx)} ${f(ry)} 0 0 1 ${pt(left)}Q${pt([c[0], c[1] + ry * 1.12])} ${pt(right)}Z" fill="${color}" fill-opacity=".38"/>`;
}

const dot = (x: number, y: number, r: number, fill: string, opacity = 1) =>
  `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${fill}"${opacity < 1 ? ` fill-opacity="${opacity}"` : ""}/>`;

/** Mouths sit on the face's midline; `lean` nudges the working mouth toward the glance. */
function mouthMarkup(x: number, y: number, mood: AgentAvatarMood, s: number, lean: number): string {
  const line = DETAIL_LINE * s;
  if (mood === "waiting") {
    return `<ellipse cx="${f(x)}" cy="${f(y)}" rx="${f(2.1 * s)}" ry="${f(2.5 * s)}" fill="none" stroke="${INK}" stroke-width="${f(line)}"/>`;
  }
  if (mood === "blocked") {
    const w = 4.4 * s;
    return stroke(
      `M${pt([x - w, y + 0.4])}Q${pt([x - w / 2, y - 2.2 * s])} ${pt([x, y + 0.2])}T${pt([x + w, y])}`,
      line,
    );
  }
  if (mood === "happy") {
    const w = 3.8 * s;
    return stroke(`M${pt([x - w, y - 1])}Q${pt([x, y + 3.6 * s])} ${pt([x + w, y - 1])}`, line);
  }
  if (mood === "working") {
    // Concentrating: lips pursed, drawn a little toward the work.
    return `<ellipse cx="${f(x + lean * 0.6)}" cy="${f(y)}" rx="${f(1.6 * s)}" ry="${f(1.15 * s)}" fill="${INK}"/>`;
  }
  return "";
}

function eyesMarkup(
  geo: Geo,
  traits: AgentAvatarTraits,
  mood: AgentAvatarMood,
  blinking: boolean,
  bodyColor: string,
): string {
  const s = geo.eyeScale ?? 1;
  const centers = eyeCenters(geo, traits, mood);
  const closed = mood === "sleeping" || (blinking && mood !== "happy");
  const midX = (centers[0][0] + centers[1][0]) / 2;
  const lean = traits.glance[0] >= 0 ? 1.2 * s : -1.2 * s;
  const side = (index: number) => (index === 0 ? 1 : -1); // +1 points inward

  if (traits.eyes === "visor") {
    // One rounded band across the face; the eyes are lit cells inside it.
    const y = centers[0][1];
    const x0 = centers[0][0] - 9 * s;
    const x1 = centers[1][0] + 9 * s;
    const band = `<rect x="${f(x0)}" y="${f(y - 8 * s)}" width="${f(x1 - x0)}" height="${f(16 * s)}" rx="${f(8 * s)}" fill="${INK}"/>`;
    const sheen = `<path d="M${pt([x0 + 6 * s, y - 5.7 * s])}H${f(x1 - 6 * s)}" stroke="#fff" stroke-opacity=".16" stroke-width="${f(1.1 * s)}" stroke-linecap="round"/>`;
    const light = mix(bodyColor, mood === "blocked" ? "#ffc8b8" : "#ffffff", 0.74);
    const core = "#ffffff";
    const cell = (c: P2, index: number) => {
      if (mood === "happy")
        return stroke(
          `M${pt([c[0] - 4, c[1] + 1.6])}Q${pt([c[0], c[1] - 4])} ${pt([c[0] + 4, c[1] + 1.6])}`,
          2.8,
          light,
        );
      if (closed)
        return stroke(
          `M${pt([c[0] - 4, c[1] + 0.5])}H${f(c[0] + 4)}`,
          2.4,
          mix(bodyColor, INK, 0.3),
        );
      if (mood === "waiting") {
        return dot(c[0], c[1], 4.2, light) + dot(c[0] - 0.9, c[1] - 0.9, 1.6, core, 0.9);
      }
      const lid: readonly [number, number] | undefined =
        mood === "working"
          ? [-0.6, 0]
          : mood === "blocked"
            ? [-0.8, -0.5 * side(index)]
            : undefined;
      const h = mood === "working" ? 6.4 : 7.4;
      const cy = mood === "working" ? c[1] + 1 : c[1];
      return (
        `<path d="${pillPath([c[0], cy], 5.6, h, lid)}" fill="${light}"/>` +
        `<rect x="${f(c[0] - 1.6)}" y="${f(cy - (lid ? 0 : 2.2))}" width="1.6" height="${f(lid ? 1.6 : 2.6)}" rx=".8" fill="${core}" fill-opacity=".9"/>`
      );
    };
    return (
      band + sheen + centers.map(cell).join("") + mouthMarkup(midX, y + 12.5 * s, mood, s, lean)
    );
  }

  const mouth = mouthMarkup(midX, geo.face[1] + 9.5 * s, mood, s, lean);

  // Brows: beads always wear them; the others show them to focus, ask or worry.
  const brow = (c: P2, index: number) => {
    const inward = side(index);
    const top = traits.eyes === "pill" ? 9.6 : traits.eyes === "beads" ? 7.6 : 9;
    const y = c[1] - top * s;
    const line = DETAIL_LINE * s;
    if (mood === "blocked") {
      return stroke(
        `M${pt([c[0] - 4.2 * inward * s, y + 1.2 * s])}L${pt([c[0] + 3.4 * inward * s, y - 2 * s])}`,
        line,
      );
    }
    if (mood === "waiting") {
      return stroke(
        `M${pt([c[0] - 3.8 * s, y - 1.2 * s])}Q${pt([c[0], y - 4.6 * s])} ${pt([c[0] + 3.8 * s, y - 1.2 * s])}`,
        line,
      );
    }
    if (mood === "working") {
      // Low and level, sitting just above the lowered lid.
      const by = y + (traits.eyes === "beads" ? 0.6 : 3.2) * s;
      const half = (traits.eyes === "pill" ? 3.4 : 3.9) * s;
      return stroke(`M${pt([c[0] - half, by])}H${f(c[0] + half)}`, line);
    }
    if (traits.eyes !== "beads") return "";
    if (closed)
      return stroke(
        `M${pt([c[0] - 3.4 * s, y + 0.6 * s])}Q${pt([c[0], y - 0.8 * s])} ${pt([c[0] + 3.4 * s, y + 0.6 * s])}`,
        line,
      );
    const lift = mood === "happy" ? -1.6 * s : 0;
    return stroke(
      `M${pt([c[0] - 3.6 * s, y + lift])}Q${pt([c[0] - inward * 0.6, y - 3 * s + lift])} ${pt([c[0] + 3.6 * s, y + lift])}`,
      line,
    );
  };
  const brows = centers.map(brow).join("");

  if (mood === "happy") {
    const eye = (c: P2) => {
      const w = (traits.eyes === "pill" ? 3.6 : traits.eyes === "beads" ? 4.2 : 5.2) * s;
      const h = (traits.eyes === "pill" ? 7.4 : 6.2) * s;
      return stroke(
        `M${pt([c[0] - w, c[1] + 2])}Q${pt([c[0], c[1] + 2 - h * 1.25])} ${pt([c[0] + w, c[1] + 2])}`,
        EYE_LINE * s,
      );
    };
    return brows + centers.map(eye).join("") + mouth;
  }
  if (closed) {
    const eye = (c: P2) => {
      const w = (traits.eyes === "pill" ? 3.8 : traits.eyes === "beads" ? 4.2 : 5) * s;
      const sag = (mood === "sleeping" ? 3 : 3.6) * s;
      return stroke(
        `M${pt([c[0] - w, c[1]])}Q${pt([c[0], c[1] + sag])} ${pt([c[0] + w, c[1]])}`,
        EYE_LINE * s,
      );
    };
    return brows + centers.map(eye).join("") + mouth;
  }

  // Open eyes. working: lids drop and the eyes look down at the work.
  // blocked: lids slope down outward. waiting: wide and lifted, looking at you.
  const rim = mix(bodyColor, "#ffffff", 0.25);
  const eye = (c: P2, index: number) => {
    const inward = side(index);
    const lid: readonly [number, number] | null =
      mood === "working" ? [-0.32, 0] : mood === "blocked" ? [-0.55, -0.32 * inward] : null;
    if (traits.eyes === "pill") {
      const w = (mood === "waiting" ? 6.6 : 5.8) * s;
      const h = (mood === "waiting" ? 13 : 11.6) * s;
      const cut = lid ? ([lid[0] * h * 0.5, lid[1]] as const) : undefined;
      const top = cut ? c[1] + cut[0] : c[1] - h / 2;
      const shine = `<rect x="${f(c[0] - w * 0.32)}" y="${f(top + 1.5 * s)}" width="${f(1.9 * s)}" height="${f((lid ? 2.2 : 3.6) * s)}" rx="${f(0.95 * s)}" fill="#fff"/>`;
      return `<path d="${pillPath(c, w, h, cut)}" fill="${INK}"/>${shine}`;
    }
    if (traits.eyes === "beads") {
      const r = (mood === "waiting" ? 4.5 : 3.8) * s;
      // Beads are small, so their lids drop less to keep the eye readable.
      const k = lid ? lid[0] * r * (mood === "working" ? 0.6 : 1) : 0;
      const shape = lid
        ? `<path d="${lidEllipse(c, r, r, k, lid[1])}" fill="${INK}"/>`
        : dot(c[0], c[1], r, INK) + bounce(c, r, r, rim);
      const top = lid ? c[1] + k : c[1] - r;
      return shape + dot(c[0] - r * 0.32, top + (lid ? 1.3 * s : r * 0.62), 1.05 * s, "#fff");
    }
    // glint: a tall ink oval with a catchlight and a small second sparkle.
    const rx = (mood === "waiting" ? 4.7 : 4.1) * s;
    const ry = (mood === "waiting" ? 6.5 : 5.7) * s;
    const shape = lid
      ? `<path d="${lidEllipse(c, rx, ry, lid[0] * ry, lid[1])}" fill="${INK}"/>`
      : `<ellipse cx="${f(c[0])}" cy="${f(c[1])}" rx="${f(rx)}" ry="${f(ry)}" fill="${INK}"/>` +
        bounce(c, rx, ry, rim);
    const top = lid ? c[1] + lid[0] * ry : c[1] - ry;
    const big = (mood === "waiting" ? 1.9 : 1.6) * s;
    const glint = dot(c[0] - rx * 0.3, top + (lid ? big + 0.8 * s : ry * 0.55), big, "#fff");
    const small = lid ? "" : dot(c[0] + rx * 0.36, c[1] - ry * 0.02, 0.8 * s, "#fff", 0.9);
    return shape + glint + small;
  };
  return brows + centers.map(eye).join("") + mouth;
}

// ---------------------------------------------------------------------------
// Accessories: ink pieces with one small gold note each. A faint light rim
// keeps them on dark backgrounds; a soft sheen along each top edge gives them
// form without gloss.

const RIM = 'stroke="#fff" stroke-opacity=".16" stroke-width="1.1"';

const sheen = (d: string, width: number, opacity = 0.24) =>
  `<path d="${d}" stroke="#fff" stroke-opacity="${opacity}" stroke-width="${f(width)}" stroke-linecap="round" fill="none"/>`;

/** An arc of a circle, as a path, from angle a0 to a1 in degrees (0 = east, clockwise). */
function arc(c: P2, r: number, a0: number, a1: number): string {
  const at = (a: number): P2 => [
    c[0] + Math.cos((a * Math.PI) / 180) * r,
    c[1] + Math.sin((a * Math.PI) / 180) * r,
  ];
  return `M${pt(at(a0))}A${f(r)} ${f(r)} 0 0 1 ${pt(at(a1))}`;
}

const lerp = (a: P2, b: P2, t: number): P2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

interface Worn {
  readonly front: string;
  readonly box: Box | null;
}

/**
 * `muted` greys the gold notes so an offline avatar dims all over; pass
 * `!online` from the caller.
 */
function accessoryMarkup(
  accessory: AgentAvatarAccessory,
  geo: Geo,
  centers: readonly [P2, P2],
  bodyColor: string,
  muted = false,
): Worn {
  const [left, right] = geo.sides;
  const gold = muted ? mix(GOLD, "#8a8790", 0.62) : GOLD;
  switch (accessory) {
    case "goggles": {
      // Pushed up on the forehead: ink rims, brass bezels, tinted glass.
      const y = geo.face[1] - 18;
      const lens = mix(bodyColor, INK, 0.3);
      const glare = mix(bodyColor, "#ffffff", 0.75);
      const strap = `<rect x="${f(left - 4)}" y="${f(y - 3.2)}" width="${f(right - left + 8)}" height="6.4" fill="${INK}" clip-path="url(#b)" clip-rule="nonzero"/>`;
      const bridge = `<rect x="${f(geo.face[0] - 4)}" y="${f(y - 1.6)}" width="8" height="3.2" fill="${INK}"/>`;
      const rings = [geo.face[0] - 9.6, geo.face[0] + 9.6]
        .map((x) => {
          const c: P2 = [x, y];
          return (
            `<circle cx="${f(x)}" cy="${f(y)}" r="7.6" fill="${INK}" ${RIM}/>` +
            `<circle cx="${f(x)}" cy="${f(y)}" r="4.9" fill="${lens}" stroke="${gold}" stroke-width="1.1"/>` +
            `<path d="${arc(c, 4.3, 180, 300)}Q${pt([x - 0.6, y - 0.6])} ${pt([x - 4.3, y])}Z" fill="${glare}"/>` +
            sheen(arc(c, 6.3, 205, 290), 1.1, 0.2)
          );
        })
        .join("");
      return { front: strap + bridge + rings, box: null };
    }
    case "scarf": {
      // Wrapped round the neck: puffy in front, foreshortened where it turns
      // behind the body, knotted off-centre with two long gold-tipped tails.
      const [ny, nl, nr] = geo.neck;
      const cx = (nl + nr) / 2;
      const l = nl - 1.3;
      const r = nr + 1.3;
      const edge = 6.5;
      const top = 2.6;
      const belly = 5.4;
      const wrap =
        `<path d="M${pt([l, ny])}Q${pt([cx, ny + 2 * top])} ${pt([r, ny])}` +
        `Q${pt([r + 2.4, ny + edge / 2])} ${pt([r - 0.8, ny + edge])}` +
        `Q${pt([cx, ny + edge + 2 * belly])} ${pt([l + 0.8, ny + edge])}` +
        `Q${pt([l - 2.4, ny + edge / 2])} ${pt([l, ny])}Z" fill="${INK}" ${RIM}/>`;
      // Where the two turns of the wrap overlap, plus a soft roll along the top.
      const fold = `<path d="M${pt([l + 4, ny + 3.6])}Q${pt([cx, ny + 3.6 + 2 * (top + 1.6)])} ${pt([r - 4, ny + 3.6])}" stroke="#fff" stroke-opacity=".1" stroke-width="1" fill="none"/>`;
      const roll = sheen(
        `M${pt([l + 3, ny + 1.3])}Q${pt([cx, ny + 2 * top + 1.3])} ${pt([r - 3, ny + 1.3])}`,
        1.3,
        0.24,
      );
      const kx = cx + (nr - nl) * 0.2;
      const ky = ny + 7;
      // A soft tail along a curved centreline, flaring a little, finished
      // with two knitted gold stripes and a short fringe.
      const tail = (start: P2, ctrl: P2, end: P2, w0: number, w1: number) => {
        const unit = (a: P2, b: P2): P2 => {
          const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
          return [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
        };
        const side = (p: P2, dir: P2, half: number, sign: number): P2 => [
          p[0] - dir[1] * half * sign,
          p[1] + dir[0] * half * sign,
        ];
        const d0 = unit(start, ctrl);
        const dc = unit(start, end);
        const d1 = unit(ctrl, end);
        const wc = (w0 + w1) / 2;
        const edge = (sign: number): [P2, P2, P2] => [
          side(start, d0, w0 / 2, sign),
          side(ctrl, dc, wc / 2, sign),
          side(end, d1, w1 / 2, sign),
        ];
        const [a0, ac, a1] = edge(1);
        const [b0, bc, b1] = edge(-1);
        const at = (e: [P2, P2, P2], t: number): P2 =>
          lerp(lerp(e[0], e[1], t), lerp(e[1], e[2], t), t);
        const stripes = [0.66, 0.8]
          .map(
            (t) =>
              `<path d="M${pt(at([a0, ac, a1], t))}L${pt(at([b0, bc, b1], t))}" stroke="${gold}" stroke-width="1.5"/>`,
          )
          .join("");
        const fringe = [0.18, 0.5, 0.82]
          .map((t) => {
            const p = lerp(a1, b1, t);
            return `M${pt(p)}l${f(d1[0] * 2.6)} ${f(d1[1] * 2.6)}`;
          })
          .join("");
        return (
          `<path d="${fringe}" stroke="#fff" stroke-opacity=".16" stroke-width="2.5" stroke-linecap="round"/>` +
          `<path d="${fringe}" stroke="${INK}" stroke-width="1.4" stroke-linecap="round"/>` +
          `<path d="M${pt(a0)}Q${pt(ac)} ${pt(a1)}L${pt(b1)}Q${pt(bc)} ${pt(b0)}Z" fill="${INK}" ${RIM} stroke-linejoin="round"/>` +
          stripes
        );
      };
      // Tails hang as far as the frame allows: long on wide bodies, where the
      // fit has height to spare, shorter on tall ones so the body keeps its size.
      const [, by0, , by1] = geo.box;
      const spare = Math.max(0, geo.box[2] - geo.box[0] - (by1 - by0));
      const drop = Math.min(19, Math.max(11, by1 + spare - ky - 1));
      const swing = tail(
        [kx + 1.5, ky + 1],
        [kx + 7.5, ky + 4.5],
        [kx + 12.5, ky + drop - 4.5],
        5.6,
        7,
      );
      const hang = tail([kx - 1, ky + 1], [kx - 3, ky + drop / 2], [kx + 0.5, ky + drop], 6, 7.6);
      // A soft square knot with one crease, not a ball.
      const knotAt = (dx: number, dy: number): P2 => [kx + dx, ky - 0.5 + dy];
      const knot =
        `<path d="${roundedPolygonPath([knotAt(-4.8, -3.6), knotAt(4.2, -4.3), knotAt(4.9, 3.7), knotAt(-4.1, 4.3)], 2.6)}" fill="${INK}" ${RIM}/>` +
        sheen(
          `M${pt(knotAt(-2.8, -2.4))}Q${pt(knotAt(0, -3.4))} ${pt(knotAt(2.4, -2.8))}`,
          1.2,
          0.3,
        ) +
        `<path d="M${pt(knotAt(-0.6, -3.2))}Q${pt(knotAt(0.6, 0))} ${pt(knotAt(0, 3.4))}" stroke="#fff" stroke-opacity=".14" stroke-width=".9" fill="none"/>`;
      return {
        front: wrap + fold + roll + swing + hang + knot,
        box: [l - 1.4, ny - 0.6, Math.max(r + 1.4, kx + 17.5), ky + drop + 3.2],
      };
    }
    case "monocle": {
      const c = centers[1];
      const radius = 9.4;
      const glass = `<circle cx="${f(c[0])}" cy="${f(c[1])}" r="${f(radius)}" fill="#fff" fill-opacity=".16"/>`;
      const ring =
        `<circle cx="${f(c[0])}" cy="${f(c[1])}" r="${f(radius)}" fill="none" stroke="${INK}" stroke-width="3.2"/>` +
        `<circle cx="${f(c[0])}" cy="${f(c[1])}" r="${f(radius - 2.1)}" fill="none" stroke="${gold}" stroke-width=".9"/>` +
        sheen(arc(c, radius - 3.6, 200, 250), 1.4, 0.75);
      const hang: P2 = [c[0] + radius * 0.62, c[1] + radius * 0.78];
      const end: P2 = [Math.min(right - 1.5, c[0] + 15), c[1] + 19];
      const chain =
        `<path d="M${pt(hang)}Q${pt([hang[0] + 1, end[1] + 1])} ${pt(end)}" stroke="${gold}" stroke-width="1.4" stroke-linecap="round" fill="none"/>` +
        `<circle cx="${f(end[0])}" cy="${f(end[1])}" r="1.6" fill="${gold}"/>`;
      return { front: glass + ring + chain, box: null };
    }
    default:
      return { front: "", box: null };
  }
}

// ---------------------------------------------------------------------------
// Material. Every body is the same soft, matte vinyl lit by one warm key light
// from the upper left: a lifted edge where the light lands, a cool form shadow
// turning away from it, a gold bounce off the floor and a soft contact shadow.
// Light and shade are tones of the body color, never white or black washes, so
// the body keeps one bold color at 20px.

function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map((channel) => channel / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return [hueOf(hex), s, l];
}

function fromHsl(h: number, s: number, l: number): string {
  const sat = Math.max(0, Math.min(1, s));
  const lit = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * lit - 1)) * sat;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = lit - c / 2;
  return rgbToHex([r, g, b].map((channel) => (channel + m) * 255));
}

/**
 * Shift a color's lightness, scale its saturation, and turn its hue up to
 * `turn` degrees toward `toward`. Greys barely turn, so they stay grey.
 */
function tone(hex: string, dl: number, sat: number, toward: number, turn: number): string {
  const [h, s, l] = toHsl(hex);
  const delta = ((((toward - h) % 360) + 540) % 360) - 180;
  const step = Math.sign(delta) * Math.min(Math.abs(delta), turn) * Math.min(1, s * 2);
  return fromHsl(h + step, s * sat, l + dl);
}

const WARM = 48;
const COOL = 250;

function stops(list: ReadonlyArray<readonly [number, string, number]>): string {
  return list
    .map(
      ([offset, color, opacity]) =>
        `<stop${offset ? ` offset="${f(offset)}"` : ""} stop-color="${color}"${opacity < 1 ? ` stop-opacity="${f(opacity)}"` : ""}/>`,
    )
    .join("");
}

// ---------------------------------------------------------------------------

/**
 * One small, static drawing for web image documents and native SvgXml. Ids are
 * scoped to each SVG root; no filters, text, images or animation. Only computed
 * numbers and colors enter the markup — never names or ids.
 */
export function agentAvatarSvg(
  agentId: string,
  online: boolean,
  avatarColor?: number | null,
  blinking = false,
  mood: AgentAvatarMood = "idle",
): string {
  const traits = agentAvatarTraits(agentId, avatarColor);
  const face: AgentAvatarMood = online ? mood : "sleeping";
  const geo = SHAPES[traits.shape];
  // Offline is unlit vinyl: a cool grey that keeps a whisper of its color.
  const bodyColor = online
    ? traits.color
    : mix(fromHsl(COOL - 20, 0.07, toHsl(traits.color)[2] * 0.62 + 0.12), traits.color, 0.14);
  // Trim is a deeper dye of the body; vivid bodies give up more chroma so a
  // band never turns electric.
  const [, bodySat, bodyLight] = toHsl(bodyColor);
  const trimColor = tone(bodyColor, -bodyLight * 0.3, 1 - bodySat * 0.45, COOL, 8);
  const centers = eyeCenters(geo, traits, face);
  const worn = accessoryMarkup(traits.accessory, geo, centers, bodyColor, !online);

  let [x0, y0, x1, y1] = geo.box;
  for (const box of [worn.box]) {
    if (!box) continue;
    x0 = Math.min(x0, box[0]);
    y0 = Math.min(y0, box[1]);
    x1 = Math.max(x1, box[2]);
    y1 = Math.max(y1, box[3]);
  }
  const scale = Math.min(76 / (x1 - x0), 76 / (y1 - y0));
  const tx = 40 - (scale * (x0 + x1)) / 2;
  const ty = 40 - (scale * (y0 + y1)) / 2;
  const [bx0, by0, bx1, by1] = geo.box;
  const cx = (bx0 + bx1) / 2;
  const w = bx1 - bx0;
  const h = by1 - by0;
  const span = Math.max(w, h);

  // The edge the light lands on: each part sits on a lifted copy of itself,
  // stepped twice so the edge softens instead of reading as an outline.
  const d = Math.max(0.9, span * 0.024);
  const frame = `x="${f(bx0 - 2)}" y="${f(by0 - 2)}" width="${f(w + 4)}" height="${f(h + 4)}"`;
  const edgeAxis = `x1="${f(bx0 + w * 0.1)}" y1="${f(by0)}" x2="${f(cx + w * 0.1)}" y2="${f(by0 + h * 0.6)}"`;
  const key = `cx="${f(cx - w * 0.2)}" cy="${f(by0 + h * 0.2)}" r="${f(span * 0.95)}"`;
  const floor = `x1="0" y1="${f(by0 + h * 0.8)}" x2="0" y2="${f(by1)}"`;

  /** Gradients for one part: lit edge, key light with form shadow, floor bounce. */
  const lighting = (color: string, [edge, light, under]: readonly [string, string, string]) => {
    const lift = online ? tone(color, 0.12, 0.95, WARM, 8) : tone(color, 0.06, 1, WARM, 0);
    const shade = tone(color, -0.18, 0.72, COOL, 14);
    const bounce = online ? tone(color, 0.1, 1, WARM, 12) : tone(color, 0.04, 1, WARM, 0);
    return (
      `<linearGradient id="${edge}" gradientUnits="userSpaceOnUse" ${edgeAxis}>${stops([
        [0, lift, 1],
        [1, color, 1],
      ])}</linearGradient>` +
      `<radialGradient id="${light}" gradientUnits="userSpaceOnUse" ${key}>${stops([
        [0, lift, online ? 0.5 : 0.3],
        [0.34, lift, 0],
        [0.56, shade, 0],
        [0.88, shade, 0.5],
        [1, shade, 0.62],
      ])}</radialGradient>` +
      `<linearGradient id="${under}" gradientUnits="userSpaceOnUse" ${floor}>${stops([
        [0, bounce, 0],
        [1, bounce, 0.5],
      ])}</linearGradient>`
    );
  };
  const shifted = (shape: string, clip: string, fill: string, k: number, opacity: string) =>
    `<g fill="${fill}"${opacity} clip-path="url(#${clip})" clip-rule="nonzero"><g transform="translate(${f(d * k * 0.5)} ${f(d * k)})">${shape}</g></g>`;
  const paint = (
    shape: string,
    clip: string,
    fill: string,
    [edge, light, under]: readonly [string, string, string],
  ) =>
    `<g fill="url(#${edge})">${shape}</g>` +
    shifted(shape, clip, fill, 0.5, ' opacity=".55"') +
    shifted(shape, clip, fill, 1, "") +
    `<rect ${frame} fill="url(#${light})" clip-path="url(#${clip})" clip-rule="nonzero"/>` +
    `<rect ${frame} fill="url(#${under})" clip-path="url(#${clip})" clip-rule="nonzero"/>`;

  const bodyIds = ["me", "mk", "mf"] as const;
  const aoColor = tone(bodyColor, -0.3, 0.7, COOL, 18);
  const trimIds = ["te", "tk", "tf"] as const;
  const defs = [
    `<clipPath id="b">${geo.body}${geo.trim ?? ""}</clipPath>`,
    geo.trim
      ? `<clipPath id="mc">${geo.body}</clipPath><clipPath id="mt">${geo.trim}</clipPath>`
      : "",
    lighting(bodyColor, bodyIds),
    geo.trim ? lighting(trimColor, trimIds) : "",
    // Soft contact shadow; it only shows where the body meets the floor.
    `<radialGradient id="mg">${stops([
      [0, "#0a0806", 0.34],
      [0.5, "#0a0806", 0.14],
      [1, "#0a0806", 0],
    ])}</radialGradient>`,
    // Occlusion where the body presses into the floor.
    `<radialGradient id="mo">${stops([
      [0, aoColor, 0.26],
      [1, aoColor, 0],
    ])}</radialGradient>`,
  ].join("");

  const ground = `<ellipse cx="${f(cx)}" cy="${f(by1)}" rx="${f(w * 0.44)}" ry="${f(Math.max(2.6, h * 0.05))}" fill="url(#mg)"/>`;
  const occlusion = `<ellipse cx="${f(cx)}" cy="${f(by1 + h * 0.03)}" rx="${f(w * 0.42)}" ry="${f(h * 0.11)}" fill="url(#mo)" clip-path="url(#b)" clip-rule="nonzero"/>`;
  // Trim (a cap, a band) shades the body just beneath it.
  const trimShadow = geo.trim
    ? `<g fill="${tone(trimColor, -0.12, 0.7, COOL, 10)}" clip-path="url(#mc)" clip-rule="nonzero">${[
        0.7, 1.6, 2.8,
      ]
        .map((dy) => `<g opacity=".2" transform="translate(0 ${f(dy)})">${geo.trim}</g>`)
        .join("")}</g>`
    : "";
  const material =
    paint(geo.body, geo.trim ? "mc" : "b", bodyColor, bodyIds) +
    (geo.trim ? trimShadow + paint(geo.trim, "mt", trimColor, trimIds) : "");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" width="80" height="80">
<defs>${defs}</defs>
<g transform="matrix(${f(scale)} 0 0 ${f(scale)} ${f(tx)} ${f(ty)})">
${ground}
${material}${occlusion}
${eyesMarkup(geo, traits, face, blinking, bodyColor)}
${worn.front}
</g>
</svg>`;
}
