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
  "cloud",
  "cactus",
  "saucer",
] as const;
export const AGENT_AVATAR_ACCESSORIES = ["none", "goggles", "scarf", "monocle", "bowtie"] as const;
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
 * Fourteen colors, spaced in OKLab so no two sit closer than ~0.1 apart, one for
 * each member of the cast, so a person's first fourteen agents never share a
 * color or a shape.
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
// (acorn→bowtie, sunburst→scarf, pebble→monocle, onion→goggles).
const CAST: readonly CastMember[] = [
  { shape: "mochi", color: 0, eyes: "glint", accessory: "none", glance: [-2.5, -1.5] },
  { shape: "bell", color: 1, eyes: "pill", accessory: "none", glance: [2, 0] },
  { shape: "acorn", color: 2, eyes: "beads", accessory: "monocle", glance: [0, -1] },
  { shape: "lantern", color: 3, eyes: "visor", accessory: "none", glance: [2.5, 0] },
  { shape: "sunburst", color: 7, eyes: "glint", accessory: "goggles", glance: [-2, 0] },
  { shape: "gumdrop", color: 8, eyes: "beads", accessory: "none", glance: [2, -1] },
  { shape: "onion", color: 9, eyes: "glint", accessory: "bowtie", glance: [-1.5, -1] },
  { shape: "capsule", color: 10, eyes: "pill", accessory: "none", glance: [2.5, -1] },
  { shape: "pebble", color: 11, eyes: "glint", accessory: "scarf", glance: [-2, -1] },
  { shape: "dango", color: 12, eyes: "beads", accessory: "none", glance: [1.5, 0] },
  { shape: "star", color: 13, eyes: "glint", accessory: "none", glance: [0, -1.5] },
  { shape: "cloud", color: 5, eyes: "glint", accessory: "none", glance: [2, -1] },
  { shape: "cactus", color: 4, eyes: "pill", accessory: "none", glance: [-2, 0] },
  { shape: "saucer", color: 6, eyes: "glint", accessory: "none", glance: [2, 0] },
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
    // A plump slice of toast: a domed top that overhangs narrower shoulders.
    body: `<path d="M17 73Q11.5 73 11.5 67V49Q4.5 44.5 5 33.5C5.8 20 19 14 30 17Q40 12 50 17C61 14 74.2 20 75 33.5Q75.5 44.5 68.5 49V67Q68.5 73 63 73Z"/>`,
    box: [5, 14, 75, 73],
    face: [40, 44],
    gap: 10.5,
    sides: [11.5, 68.5],
    crown: [40, 14],
    chin: [40, 62],
    neck: [55, 11.5, 68.5],
  },
  gumdrop: {
    // A soft hill with two stubby horns, so it is never read as a ghost.
    body: `<path d="M8 69C6 47 17 15 40 15C63 15 74 47 72 69Q72 74 67 74H13Q8 74 8 69Z"/><path d="M19 33Q15 17 22.5 9.5Q25 7.5 26.5 10Q28 16 34 20Z"/><path d="M61 33Q65 17 57.5 9.5Q55 7.5 53.5 10Q52 16 46 20Z"/>`,
    box: [7.8, 8, 72.2, 74],
    face: [40, 48],
    gap: 11,
    sides: [9, 71],
    crown: [40, 15],
    chin: [40, 66],
    neck: [58, 8, 72],
  },
  bell: {
    // A real bell: a knob to hang from and a clapper peeking under the rim.
    body: `<path d="M40 12C55 12 63 24 63 39V50C63 56 66 60 70 63Q75.5 69 69 70H11Q4.5 69 10 63C14 60 17 56 17 50V39C17 24 25 12 40 12Z"/>`,
    trim: `<circle cx="40" cy="8.5" r="4.8"/><path d="M32.5 70A7.5 7.5 0 0 0 47.5 70Z"/>`,
    box: [6.3, 3.7, 73.7, 77.5],
    face: [40, 42],
    gap: 10,
    sides: [17, 63],
    crown: [40, 12],
    chin: [40, 60],
    neck: [54, 16.7, 63.3],
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
    // Eight sharp-tipped rays over soft valleys: a sun, not a bottle cap.
    body: `<path d="${roundedPolygonPath(starPoints(8, 40, 42, 36, 26.5, -Math.PI / 2), 2.8, 5.5)}"/>`,
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
    face: [40, 42],
    gap: 11,
    sides: [8, 72],
    crown: [44, 4],
    chin: [40, 58],
    neck: [60.5, 10.8, 69.2],
  },
  capsule: {
    // A two-part pill: the seam and darker half say capsule at any size.
    body: `<rect x="15" y="7" width="50" height="68" rx="25"/>`,
    trim: `<path d="M15.1 52H64.9A25 25 0 0 1 15.1 52Z"/>`,
    box: [15, 7, 65, 75],
    face: [40, 31],
    gap: 10,
    sides: [15, 65],
    crown: [40, 7],
    chin: [40, 45],
    neck: [47, 15, 65],
  },
  dango: {
    // Two dumplings on a skewer.
    body: `${circle(40, 53, 25.5)}${circle(40, 20.5, 14)}`,
    trim: `<rect x="38" y="1" width="4" height="8" rx="2"/><rect x="38" y="76" width="4" height="5.5" rx="2"/>`,
    box: [14.5, 1, 65.5, 81.5],
    face: [40, 53],
    gap: 10,
    sides: [14.5, 65.5],
    crown: [40, 6.5],
    chin: [40, 72],
    neck: [64, 17, 63],
  },
  cloud: {
    // Three puffs on a flat base.
    body: `${circle(22, 51, 17)}${circle(42, 36, 22)}${circle(61, 49, 16.5)}<rect x="13" y="48" width="56" height="20" rx="9"/>`,
    box: [5, 14, 77.5, 68],
    face: [41, 44],
    gap: 10,
    sides: [8, 75],
    crown: [42, 14],
    chin: [41, 62],
    neck: [56, 9, 74],
  },
  cactus: {
    // Upturned arms and a little pot.
    body: `<rect x="23" y="9" width="34" height="62" rx="17"/><rect x="7" y="26" width="11" height="26" rx="5.5"/><rect x="7" y="41" width="22" height="11" rx="5.5"/><rect x="62" y="20" width="11" height="26" rx="5.5"/><rect x="51" y="35" width="22" height="11" rx="5.5"/>`,
    trim: `<path d="M21 64H59L56.5 76Q56 78 54 78H26Q24 78 23.5 76Z"/>`,
    box: [7, 9, 73, 78],
    face: [40, 34],
    gap: 7.8,
    sides: [23, 57],
    crown: [40, 9],
    chin: [40, 52],
    neck: [50, 23, 57],
    eyeScale: 0.84,
  },
  saucer: {
    // A dome on a wide disc.
    body: `<path d="M13 54C13 22 26 8 40 8C54 8 67 22 67 54Z"/>`,
    trim: `<ellipse cx="40" cy="57" rx="38" ry="12"/>`,
    box: [2, 8, 78, 69],
    face: [40, 30],
    gap: 9,
    sides: [13, 67],
    crown: [40, 8],
    chin: [40, 48],
    neck: [44, 15, 65],
    eyeScale: 0.9,
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
/** Faces carry the character at 20px, so they are drawn large for the body. */
const FACE_SCALE = 1.4;
const EYE_SPREAD = 1.2;

function eyeCenters(geo: Geo, traits: AgentAvatarTraits, mood: AgentAvatarMood): [P2, P2] {
  const [gx, gy] = traits.glance;
  const shift: P2 =
    mood === "working"
      ? [gx * 0.5, 2]
      : mood === "waiting"
        ? [gx * 0.4, -1]
        : mood === "blocked"
          ? [0, 0.6]
          : mood === "idle"
            ? [gx, gy]
            : [0, mood === "sleeping" ? 1.5 : 0];
  return [
    [geo.face[0] - geo.gap * EYE_SPREAD + shift[0], geo.face[1] + shift[1]],
    [geo.face[0] + geo.gap * EYE_SPREAD + shift[0], geo.face[1] + shift[1]],
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

const dot = (x: number, y: number, r: number, fill: string, opacity = 1) =>
  `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${fill}"${opacity < 1 ? ` fill-opacity="${opacity}"` : ""}/>`;

/** Mouths sit on the face's midline; `lean` nudges the working mouth toward the glance. */
function mouthMarkup(x: number, y: number, mood: AgentAvatarMood, s: number, lean: number): string {
  const line = DETAIL_LINE * s;
  if (mood === "waiting") {
    // A small, patient "hm?", drawn to one side.
    const w = 2.6 * s;
    return stroke(`M${pt([x - w + lean, y + 0.6])}Q${pt([x + lean, y + 1.8 * s])} ${pt([x + w + lean, y - 0.9])}`, line);
  }
  if (mood === "blocked") {
    const w = 4.4 * s;
    return stroke(
      `M${pt([x - w, y + 0.4])}Q${pt([x - w / 2, y - 2.2 * s])} ${pt([x, y + 0.2])}T${pt([x + w, y])}`,
      line,
    );
  }
  if (mood === "happy") {
    // A big open grin: the one filled mouth, so delight reads at 20px.
    const w = 3.9 * s;
    const top = y - 1.6;
    return `<path d="M${pt([x - w, top])}H${f(x + w)}Q${pt([x + w, top + 4.8 * s])} ${pt([x, top + 4.8 * s])}Q${pt([x - w, top + 4.8 * s])} ${pt([x - w, top])}Z" fill="${INK}" stroke="${INK}" stroke-width="1" stroke-linejoin="round"/>`;
  }
  if (mood === "working") {
    // Concentrating: a short line with the tip of the tongue poking out.
    const w = 2.6 * s;
    const mx = x + lean * 0.6;
    return (
      dot(mx + lean * 1.2, y + 1.5 * s, 1.75 * s, "#ff8fa8") +
      stroke(`M${pt([mx - w, y])}H${f(mx + w)}`, line)
    );
  }
  return "";
}

/** Happy shows on the face itself: blushing cheeks under the smile. */
function moodAccent(
  centers: readonly [P2, P2],
  mood: AgentAvatarMood,
  s: number,
  bodyColor: string,
): string {
  if (mood !== "happy") return "";
  const blush = mix(bodyColor, "#ff2f6e", 0.42);
  return centers
    .map((c, index) =>
      dot(c[0] + (index === 0 ? -5.2 : 5.2) * s, c[1] + 5 * s, 2.4 * s, blush, 0.85),
    )
    .join("");
}

/**
 * The status mark. It stays in the same corner of the frame, upright, whatever
 * the character does, and each state has its own shape and color, so a list of
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
        `<circle cx="66" cy="14" r="12.6" fill="#ffc53d" ${keyline}/>` +
        stroke("M61.4 11C61.4 5.8 70.8 5.8 70.8 11C70.8 14.6 66 14.2 66 17.6M66 22h.01", 3.4)
      );
    case "blocked":
      return `<path d="M66 1.6C72.6 10 76.4 14.2 76.4 19A10.4 10.4 0 0 1 55.6 19C55.6 14.2 59.4 10 66 1.6Z" fill="#bfe9ff" ${keyline}/>`;
    case "happy":
      return `<path d="M66 25.2C58 19.4 54.2 15 54.2 10.4C54.2 3.4 62.8 1.6 66 7.6C69.2 1.6 77.8 3.4 77.8 10.4C77.8 15 74 19.4 66 25.2Z" fill="#ff6f9f" ${keyline}/>`;
    case "sleeping": {
      const z = "M57 5H73L57 21H73";
      return stroke(z, 7.2) + stroke(z, 3.8, "#fff");
    }
    default:
      return "";
  }
}

/** Eyes are separate from the rest of the face so a client can move them alone. */
interface FaceParts {
  readonly features: string;
  readonly eyes: string;
}

function faceParts(
  geo: Geo,
  traits: AgentAvatarTraits,
  mood: AgentAvatarMood,
  blinking: boolean,
  bodyColor: string,
  online: boolean,
): FaceParts {
  const s = (geo.eyeScale ?? 1) * FACE_SCALE;
  const centers = eyeCenters(geo, traits, mood);
  const closed = mood === "sleeping" || (blinking && mood !== "happy");
  const midX = (centers[0][0] + centers[1][0]) / 2;
  const lean = traits.glance[0] >= 0 ? 1.2 * s : -1.2 * s;
  const side = (index: number) => (index === 0 ? 1 : -1); // +1 points inward

  if (traits.eyes === "visor") {
    // One rounded band across the face; the eyes are lit cells inside it.
    const y = centers[0][1];
    const x0 = centers[0][0] - 7.5 * s;
    const x1 = centers[1][0] + 7.5 * s;
    const band = `<rect x="${f(x0)}" y="${f(y - 7 * s)}" width="${f(x1 - x0)}" height="${f(14 * s)}" rx="${f(7 * s)}" fill="${INK}"/>`;
    const light = mix(bodyColor, mood === "blocked" ? "#ffc8b8" : "#ffffff", 0.74);
    const cell = (c: P2, index: number) => {
      if (mood === "happy")
        return stroke(
          `M${pt([c[0] - 5, c[1] + 2])}Q${pt([c[0], c[1] - 5])} ${pt([c[0] + 5, c[1] + 2])}`,
          3.6,
          light,
        );
      if (closed)
        return stroke(
          `M${pt([c[0] - 5, c[1] + 0.5])}H${f(c[0] + 5)}`,
          3.2,
          mix(bodyColor, INK, 0.3),
        );
      if (mood === "waiting") {
        return dot(c[0], c[1], 5.6, light);
      }
      const lid: readonly [number, number] | undefined =
        mood === "working"
          ? [-0.6, 0]
          : mood === "blocked"
            ? [-0.8, -0.5 * side(index)]
            : undefined;
      const h = mood === "working" ? 8 : 10;
      const cy = mood === "working" ? c[1] + 1 : c[1];
      return `<path d="${pillPath([c[0], cy], 7.4, h, lid)}" fill="${light}"/>`;
    };
    return {
      features:
        band +
        mouthMarkup(midX, y + 11 * s, mood, s, lean) +
        moodAccent(centers, mood, s, bodyColor),
      eyes: centers.map(cell).join(""),
    };
  }

  const mouth =
    mouthMarkup(midX, geo.face[1] + 9.5 * s, mood, s, lean) +
    moodAccent(centers, mood, s, bodyColor);

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
      // One raised brow: asking, not alarmed.
      const lift = index === 1 ? -2.6 * s : 0.6 * s;
      return stroke(
        `M${pt([c[0] - 3.6 * s, y + lift])}Q${pt([c[0], y - 2.6 * s + lift])} ${pt([c[0] + 3.6 * s, y + lift])}`,
        line,
      );
    }
    // Working has no brow: a level one over a lowered lid reads as a scowl.
    if (mood === "working") return "";
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
    return { features: brows + mouth, eyes: centers.map(eye).join("") };
  }
  if (closed) {
    const eye = (c: P2) => {
      const w = (traits.eyes === "pill" ? 3.8 : traits.eyes === "beads" ? 4.2 : 5) * s;
      if (!online) return stroke(`M${pt([c[0] - w, c[1] + 1])}H${f(c[0] + w)}`, EYE_LINE * s * 0.8);
      const sag = (mood === "sleeping" ? 4 : 2) * s;
      return stroke(
        `M${pt([c[0] - w, c[1]])}Q${pt([c[0], c[1] + sag])} ${pt([c[0] + w, c[1]])}`,
        (mood === "sleeping" ? EYE_LINE : EYE_LINE * 0.8) * s,
      );
    };
    return { features: brows + mouth, eyes: centers.map(eye).join("") };
  }

  // Open eyes. working: lids drop and the eyes look down at the work.
  // blocked: lids slope down outward. waiting: wide and lifted, looking at you.
  const eye = (c: P2, index: number) => {
    const inward = side(index);
    const lid: readonly [number, number] | null =
      mood === "working" ? [-0.3, 0] : mood === "blocked" ? [-0.55, -0.32 * inward] : null;
    if (traits.eyes === "pill") {
      const w = (mood === "waiting" ? 6.2 : 5.8) * s;
      const h = (mood === "waiting" ? 12.2 : 11.6) * s;
      const cut = lid ? ([lid[0] * h * 0.5, lid[1]] as const) : undefined;
      const top = cut ? c[1] + cut[0] : c[1] - h / 2;
      const shine = `<rect x="${f(c[0] - w * 0.32)}" y="${f(top + 1.5 * s)}" width="${f(1.9 * s)}" height="${f((lid ? 2.2 : 3.6) * s)}" rx="${f(0.95 * s)}" fill="#fff"/>`;
      return `<path d="${pillPath(c, w, h, cut)}" fill="${INK}"/>${shine}`;
    }
    if (traits.eyes === "beads") {
      const r = (mood === "waiting" ? 4.1 : 3.8) * s;
      // Beads are small, so their lids drop less to keep the eye readable.
      const k = lid ? lid[0] * r : 0;
      const shape = lid
        ? `<path d="${lidEllipse(c, r, r, k, lid[1])}" fill="${INK}"/>`
        : dot(c[0], c[1], r, INK);
      const top = lid ? c[1] + k : c[1] - r;
      return shape + dot(c[0] - r * 0.32, top + (lid ? 1.3 * s : r * 0.62), 1.05 * s, "#fff");
    }
    // glint: a tall ink oval with a catchlight and a small second sparkle.
    const rx = (mood === "waiting" ? 4.4 : 4.1) * s;
    const ry = (mood === "waiting" ? 6.1 : 5.7) * s;
    const shape = lid
      ? `<path d="${lidEllipse(c, rx, ry, lid[0] * ry, lid[1])}" fill="${INK}"/>`
      : `<ellipse cx="${f(c[0])}" cy="${f(c[1])}" rx="${f(rx)}" ry="${f(ry)}" fill="${INK}"/>`;
    const top = lid ? c[1] + lid[0] * ry : c[1] - ry;
    const big = (mood === "waiting" ? 1.9 : 1.6) * s;
    const glint = dot(c[0] - rx * 0.3, top + (lid ? big + 0.8 * s : ry * 0.55), big, "#fff");
    return shape + glint;
  };
  return { features: brows + mouth, eyes: centers.map(eye).join("") };
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
      // Pushed up on the forehead: one ink band and two solid brass lenses, which survive 20 px.
      const y = geo.face[1] - 18;
      const strap = `<rect x="${f(left - 4)}" y="${f(y - 3.2)}" width="${f(right - left + 8)}" height="6.4" fill="${INK}" clip-path="url(#b)" clip-rule="nonzero"/>`;
      const bridge = `<rect x="${f(geo.face[0] - 4)}" y="${f(y - 1.6)}" width="8" height="3.2" fill="${INK}"/>`;
      const rings = [geo.face[0] - 9.6, geo.face[0] + 9.6]
        .map(
          (x) =>
            `<circle cx="${f(x)}" cy="${f(y)}" r="8.2" fill="${INK}" ${RIM}/>` +
            `<circle cx="${f(x)}" cy="${f(y)}" r="5" fill="${gold}"/>`,
        )
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
      const edge = 5;
      const top = 2.4;
      const belly = 4.2;
      const wrap =
        `<path d="M${pt([l, ny])}Q${pt([cx, ny + 2 * top])} ${pt([r, ny])}` +
        `Q${pt([r + 2.4, ny + edge / 2])} ${pt([r - 0.8, ny + edge])}` +
        `Q${pt([cx, ny + edge + 2 * belly])} ${pt([l + 0.8, ny + edge])}` +
        `Q${pt([l - 2.4, ny + edge / 2])} ${pt([l, ny])}Z" fill="${INK}" ${RIM}/>`;
      const kx = cx + (nr - nl) * 0.2;
      const ky = ny + 7;
      // A soft tail along a curved centreline, flaring a little, finished with
      // one wide gold stripe.
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
        const stripe = `<path d="M${pt(at([a0, ac, a1], 0.76))}L${pt(at([b0, bc, b1], 0.76))}" stroke="${gold}" stroke-width="3.2"/>`;
        return (
          `<path d="M${pt(a0)}Q${pt(ac)} ${pt(a1)}L${pt(b1)}Q${pt(bc)} ${pt(b0)}Z" fill="${INK}" ${RIM} stroke-linejoin="round"/>` +
          stripe
        );
      };
      // Tails hang as far as the frame allows: long on wide bodies, where the
      // fit has height to spare, shorter on tall ones so the body keeps its size.
      const [, by0, , by1] = geo.box;
      const spare = Math.max(0, geo.box[2] - geo.box[0] - (by1 - by0));
      const drop = Math.min(19, Math.max(11, by1 + spare - ky - 1));
      const hang = tail([kx - 1, ky + 1], [kx - 3, ky + drop / 2], [kx + 0.5, ky + drop], 8, 10);
      // A soft square knot, not a ball.
      const knotAt = (dx: number, dy: number): P2 => [kx + dx, ky - 0.5 + dy];
      const knot =
        `<path d="${roundedPolygonPath([knotAt(-4.8, -3.6), knotAt(4.2, -4.3), knotAt(4.9, 3.7), knotAt(-4.1, 4.3)], 2.6)}" fill="${INK}" ${RIM}/>`;
      return {
        front: wrap + hang + knot,
        box: [l - 1.4, ny - 0.6, Math.max(r + 1.4, kx + 7), ky + drop + 1],
      };
    }
    case "monocle": {
      const c = centers[1];
      const radius = 12.2;
      const glass = `<circle cx="${f(c[0])}" cy="${f(c[1])}" r="${f(radius)}" fill="#fff" fill-opacity=".24"/>`;
      // One bold brass ring: anything finer dissolves into the eye at 20 px.
      const ring =
        `<circle cx="${f(c[0])}" cy="${f(c[1])}" r="${f(radius)}" fill="none" stroke="${INK}" stroke-width="5.2"/>` +
        `<circle cx="${f(c[0])}" cy="${f(c[1])}" r="${f(radius)}" fill="none" stroke="${gold}" stroke-width="3.2"/>`;
      const hang: P2 = [c[0] + radius * 0.62, c[1] + radius * 0.78];
      const end: P2 = [Math.min(right - 1.5, c[0] + 15), c[1] + 19];
      const chain =
        `<path d="M${pt(hang)}Q${pt([hang[0] + 1, end[1] + 1])} ${pt(end)}" stroke="${gold}" stroke-width="1.4" stroke-linecap="round" fill="none"/>`;
      return { front: glass + ring + chain, box: null };
    }
    case "bowtie": {
      // Two ink wings and a brass knot, sitting at the bottom of the body.
      const [cx, cy] = [geo.chin[0], geo.chin[1] + 7.5];
      const wing = (dir: number) =>
        `<path d="${roundedPolygonPath(
          [
            [cx + dir * 2, cy - 2.4],
            [cx + dir * 16, cy - 8.6],
            [cx + dir * 16, cy + 8.6],
            [cx + dir * 2, cy + 2.4],
          ],
          2,
        )}" fill="${INK}" ${RIM}/>`;
      return {
        front: wing(-1) + wing(1) + dot(cx, cy, 4.3, gold),
        box: null,
      };
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

const COOL = 250;

// ---------------------------------------------------------------------------

/**
 * How each mood holds the whole body. This is what separates moods at 20px, where
 * a brow is one pixel, and because it is in the drawing it costs nothing to keep.
 */
const MOOD_LEAN: Record<AgentAvatarMood, number> = {
  idle: 0,
  working: 3,
  waiting: 8,
  blocked: -5,
  happy: 0,
  sleeping: 11,
};

function moodPose(mood: AgentAvatarMood): string {
  const lean = MOOD_LEAN[mood];
  if (lean === 0) return "";
  // Shrinks just enough that a tilted corner stays inside the frame. Blocked also
  // slumps toward its feet.
  const k = 1 - Math.abs(lean) * 0.0075;
  const slump = mood === "blocked" ? 0.91 : 1;
  const y = 44 * (1 - k) + 78 * k * (1 - slump);
  return `rotate(${lean} 40 44) translate(${f(40 * (1 - k))} ${f(y)}) scale(${f(k)} ${f(k * slump)}) `;
}

const SVG_OPEN = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" width="80" height="80">`;

function svgRoot(transform: string, content: string, badge = ""): string {
  return `${SVG_OPEN}
<g transform="${transform}">
${content}
</g>
${badge}</svg>`;
}

function avatarParts(
  agentId: string,
  online: boolean,
  avatarColor: number | null | undefined,
  blinking: boolean,
  mood: AgentAvatarMood,
) {
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
  const trimColor = tone(bodyColor, -bodyLight * 0.2, 1 - bodySat * 0.3, COOL, 8);
  const centers = eyeCenters(geo, traits, face);
  const worn = accessoryMarkup(traits.accessory, geo, centers, bodyColor, !online);

  let [x0, y0, x1, y1] = geo.box;
  if (worn.box) {
    x0 = Math.min(x0, worn.box[0]);
    y0 = Math.min(y0, worn.box[1]);
    x1 = Math.max(x1, worn.box[2]);
    y1 = Math.max(y1, worn.box[3]);
  }
  const scale = Math.min(76 / (x1 - x0), 76 / (y1 - y0));
  const tx = 40 - (scale * (x0 + x1)) / 2;
  const ty = 40 - (scale * (y0 + y1)) / 2;
  const [bx0, by0, bx1, by1] = geo.box;
  const span = Math.max(bx1 - bx0, by1 - by0);

  // One flat color and one soft-edged form shadow: a copy of the part in the
  // main color, nudged toward the light, over the part in its shade.
  const shaded = (shape: string, clip: string, color: string) =>
    `<g fill="${tone(color, -0.14, 0.86, COOL, 14)}">${shape}</g>` +
    `<g fill="${color}" clip-path="url(#${clip})" clip-rule="nonzero"><g transform="translate(${f(-span * 0.025)} ${f(-span * 0.042)})">${shape}</g></g>`;
  const defs = `<defs><clipPath id="b">${geo.body}</clipPath>${geo.trim ? `<clipPath id="t">${geo.trim}</clipPath>` : ""}</defs>`;
  const material =
    shaded(geo.body, "b", bodyColor) + (geo.trim ? shaded(geo.trim, "t", trimColor) : "");
  const parts = faceParts(geo, traits, face, blinking, bodyColor, online);
  return {
    transform: `${online ? moodPose(face) : ""}matrix(${f(scale)} 0 0 ${f(scale)} ${f(tx)} ${f(ty)})`,
    body: `${defs}${material}\n${worn.front}\n${parts.features}`,
    eyes: parts.eyes,
    badge: online ? moodBadge(face) : "",
    eyeCenter: [
      (tx + scale * ((centers[0][0] + centers[1][0]) / 2)) / 80,
      (ty + scale * centers[0][1]) / 80,
    ] as const,
  };
}

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
  const parts = avatarParts(agentId, online, avatarColor, blinking, mood);
  return svgRoot(parts.transform, `${parts.body}\n${parts.eyes}`, parts.badge);
}

export interface AgentAvatarLayers {
  readonly body: string;
  readonly eyes: string;
  /** The corner status mark, when this mood has one. */
  readonly badge: string | null;
  /** Between the eyes, as fractions of the frame: where they blink from. */
  readonly eyeCenter: readonly [number, number];
}

/**
 * The same drawing in two images, so a client can blink and glance by moving the
 * eyes alone on the compositor, with nothing re-rendered or repainted.
 */
export function agentAvatarLayers(
  agentId: string,
  online: boolean,
  avatarColor?: number | null,
  mood: AgentAvatarMood = "idle",
): AgentAvatarLayers {
  const parts = avatarParts(agentId, online, avatarColor, false, mood);
  return {
    body: svgRoot(parts.transform, parts.body),
    eyes: svgRoot(parts.transform, parts.eyes),
    badge: parts.badge ? `${SVG_OPEN}${parts.badge}</svg>` : null,
    eyeCenter: parts.eyeCenter,
  };
}
