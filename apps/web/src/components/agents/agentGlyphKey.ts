/**
 * Which glyph a custom agent's sidebar row shows.
 *
 * Agents carry no icon of their own, so the glyph is decoration derived from
 * the name: a small keyword map first, then a stable hash into a neutral set
 * so two agents with unrelated names rarely share one. Nothing here is state —
 * the row's trailing slot still shows the agent's real status.
 */
export type AgentGlyphKey =
  | "paw"
  | "heart"
  | "user"
  | "pencil"
  | "globe"
  | "monitor"
  | "bot"
  | "cpu"
  | "rocket"
  | "compass"
  | "flask"
  | "wrench";

const KEYWORD_GLYPHS: ReadonlyArray<readonly [RegExp, AgentGlyphKey]> = [
  [/\b(paw|pet|dog|cat|puppy|kitten)/i, "paw"],
  [/(medic|health|clinic|care|nurse|doctor)/i, "heart"],
  [/(assistant|chief of staff|personal|concierge|secretary)/i, "user"],
  [/(doodle|draw|sketch|paint|\bart\b|design)/i, "pencil"],
  [/(world|\bmap\b|globe|travel|planet|earth)/i, "globe"],
  [/(computer|\bmac\b|desktop|laptop|machine|\bpc\b|server)/i, "monitor"],
];

const FALLBACK_GLYPHS: ReadonlyArray<AgentGlyphKey> = [
  "bot",
  "cpu",
  "rocket",
  "compass",
  "flask",
  "wrench",
];

export function resolveAgentGlyphKey(name: string): AgentGlyphKey {
  for (const [pattern, key] of KEYWORD_GLYPHS) {
    if (pattern.test(name)) return key;
  }
  let hash = 0;
  for (const character of name) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  }
  return FALLBACK_GLYPHS[hash % FALLBACK_GLYPHS.length] ?? "bot";
}
