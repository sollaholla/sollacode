/**
 * Matching names by how they sound rather than how they are spelled.
 *
 * Everything the orchestrator hears has been through a transcriber, and a
 * transcriber guesses spelling from sound. It has never seen the user's product
 * names, so it writes what it heard using ordinary English orthography:
 * "CareGen" comes back as "CaraGen", "Karagen", "Care Gen". To the user those
 * are the same word said once; to a string comparison they are three different
 * names, and the thread they meant is simply not found.
 *
 * The existing bigram similarity in `threadRouting.ts` is orthographic — it
 * scores shared letter pairs — so it catches a dropped letter but not a vowel
 * swapped for one that sounds identical. "caragen" and "caregen" only just clear
 * its threshold; "karagen" does not clear it at all, despite being the same
 * sound. This module closes that gap by reducing both sides to the consonant
 * skeleton an English speaker would actually pronounce, then comparing those.
 *
 * Deliberately not a full Metaphone: the whole value is in a handful of
 * substitutions — the letters transcribers actually confuse — and every rule
 * beyond those adds a way for two genuinely different names to collide, which
 * is the one failure mode worth avoiding. Routing to the wrong thread is much
 * worse than asking.
 *
 * Pure and dependency-free, so the confusions worth being sure about are cheap
 * to pin down in tests.
 */

/**
 * Digraphs that are one sound, applied before anything else.
 *
 * Order matters: the longer forms have to go first, or "sch" is eaten by "ch".
 * `x` stands for the "sh"/"ch" sound and `0` for "th" — arbitrary single
 * characters, chosen only because they cannot be confused with a real letter
 * still awaiting translation.
 */
const DIGRAPHS: ReadonlyArray<readonly [RegExp, string]> = [
  [/sch/g, "sk"],
  [/tch/g, "x"],
  [/ph/g, "f"],
  [/ck/g, "k"],
  [/sh/g, "x"],
  [/ch/g, "x"],
  [/th/g, "0"],
  [/dg/g, "j"],
  [/qu/g, "kw"],
  [/wh/g, "w"],
  // Silent in every position that matters here: "night", "through", "sign".
  [/gh/g, ""],
];

/** Silent openings — "know", "gnome", "write", "psalm". */
const SILENT_PREFIXES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^kn/, "n"],
  [/^gn/, "n"],
  [/^pn/, "n"],
  [/^wr/, "r"],
  [/^ps/, "s"],
  [/^x/, "s"],
];

const VOWELS = /[aeiouy]/;

/**
 * The consonant skeleton of one word.
 *
 * Vowels are dropped after the first letter, which is the whole point: vowels
 * are what a transcriber guesses at and what varies between "Cara" and "Care".
 * A leading vowel is kept, because losing it would make "Ann" and "Nan" the
 * same word, and the first sound is the one people hear most reliably.
 *
 * Returns "" for anything with no letters, which never matches anything —
 * silence should not resolve to a thread.
 */
export function phoneticKey(word: string): string {
  let value = word.toLowerCase().replace(/[^a-z]/g, "");
  if (value.length === 0) return "";

  for (const [pattern, replacement] of SILENT_PREFIXES) {
    value = value.replace(pattern, replacement);
  }
  for (const [pattern, replacement] of DIGRAPHS) {
    value = value.replace(pattern, replacement);
  }

  // Soft/hard c and g, which is exactly the ambiguity "CareGen" lives in: the
  // g is pronounced "j", so a transcriber writing "Karajen" is not wrong.
  value = value.replace(/c(?=[eiy])/g, "s").replace(/c/g, "k");
  value = value.replace(/g(?=[eiy])/g, "j").replace(/g/g, "k");
  // Sounds people write two ways without hearing a difference.
  value = value
    .replace(/z/g, "s")
    .replace(/q/g, "k")
    .replace(/x(?=[^aeiou])/g, "ks");

  const first = value[0] ?? "";
  const head = VOWELS.test(first) ? "a" : first;
  const tail = value.slice(1).replace(/[aeiouy]/g, "");

  // Doubled consonants are never two sounds — "Solla" and "Sola" are one name.
  return (head + tail).replace(/(.)\1+/g, "$1");
}

/**
 * The phonetic form of a whole phrase, one key per word.
 *
 * Encoded word by word rather than as one run-together string because the
 * rules that depend on position — a silent opening, a kept leading vowel —
 * apply to each word the user said, not to the sentence.
 */
export function phoneticPhrase(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .map((word) => phoneticKey(word))
    .filter((key) => key.length > 0)
    .join(" ");
}

/**
 * Whether two phrases are the same sound.
 *
 * Word boundaries are dropped before comparing: where a transcriber puts the
 * spaces in an unfamiliar name is a coin toss — "CareGen", "Care Gen" and
 * "care-gen" are one name said once — and no user ever hears the difference.
 *
 * Empty on either side is never a match: an unpronounceable query (digits,
 * punctuation, silence) must fall through to the other tiers rather than
 * matching every thread whose title is equally unpronounceable.
 */
export function soundsLike(left: string, right: string): boolean {
  const a = phoneticPhrase(left).replace(/ /g, "");
  if (a.length === 0) return false;
  return a === phoneticPhrase(right).replace(/ /g, "");
}

/**
 * Dice coefficient over the phonetic skeletons, for near-misses.
 *
 * The same measure `threadRouting.ts` uses on raw letters, applied to sound
 * instead — so a name that was heard *almost* right ("Aurora Studio" as "Arora
 * Studeo") scores on the part that was heard right, rather than being
 * penalised for vowels nobody pronounced distinctly in the first place.
 */
export function phoneticSimilarity(left: string, right: string): number {
  const a = phoneticPhrase(left).replace(/ /g, "");
  const b = phoneticPhrase(right).replace(/ /g, "");
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigrams = new Map<string, number>();
  for (let index = 0; index < a.length - 1; index += 1) {
    const gram = a.slice(index, index + 2);
    bigrams.set(gram, (bigrams.get(gram) ?? 0) + 1);
  }

  let shared = 0;
  for (let index = 0; index < b.length - 1; index += 1) {
    const gram = b.slice(index, index + 2);
    const remaining = bigrams.get(gram) ?? 0;
    if (remaining > 0) {
      bigrams.set(gram, remaining - 1);
      shared += 1;
    }
  }

  return (2 * shared) / (a.length - 1 + (b.length - 1));
}
