import type { ThreadSnapshot } from "./events";
import { phoneticSimilarity, soundsLike } from "./phonetics";

/**
 * Resolving what the user *said* to the thread they *meant*.
 *
 * Routing used to require the model to hand back an exact thread id, which in
 * practice meant an exact title: "the Solla Code thread" resolved to nothing,
 * and the orchestrator either asked which thread for every single message or
 * guessed. Neither is what someone talking out loud expects.
 *
 * So matching happens here, over a normalized form of everything that
 * identifies a thread — its title, its project, and the folder that project
 * lives in — in ordered tiers. The first tier with any hit wins, which keeps a
 * real exact match from ever being beaten by a fuzzy one. A tier that produces
 * exactly one thread is a confident answer and is acted on without asking; a
 * tier that produces several is genuine ambiguity and is the *only* case where
 * routing stops to ask.
 *
 * Pure and dependency-free so the interesting cases — two threads on the same
 * project, a project name used instead of a title, a name said with the wrong
 * punctuation — are cheap to pin down in tests.
 */

/**
 * Words people say around a thread's name that carry no identity.
 *
 * "the Solla Code thread" and "Solla Code" have to reach the same place. These
 * are only ever dropped *in addition* to matching the raw form, so a thread
 * genuinely called "Agent" is still findable.
 */
const FILLER_WORDS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "my",
  "our",
  "that",
  "this",
  "thread",
  "threads",
  "chat",
  "chats",
  "conversation",
  "tab",
  "tabs",
  "agent",
  "agents",
  "session",
  "sessions",
  "project",
  "one",
  "please",
]);

/**
 * Lowercases and reduces every separator to a single space, so "t3-fork",
 * "T3 Fork" and "t3_fork" are one string. Speech has no punctuation, which is
 * exactly why exact-title matching kept failing.
 */
export function normalizeReference(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’“”]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function referenceTokens(value: string): ReadonlyArray<string> {
  const normalized = normalizeReference(value);
  return normalized.length === 0 ? [] : normalized.split(" ");
}

/** Tokens with filler removed — but never down to nothing. */
function contentTokens(value: string): ReadonlyArray<string> {
  const tokens = referenceTokens(value);
  const stripped = tokens.filter((token) => !FILLER_WORDS.has(token));
  return stripped.length > 0 ? stripped : tokens;
}

function contentPhrase(value: string): string {
  return contentTokens(value).join(" ");
}

/** Dice coefficient over character bigrams: 1 is identical, 0 shares nothing. */
export function similarity(left: string, right: string): number {
  const a = normalizeReference(left).replace(/ /g, "");
  const b = normalizeReference(right).replace(/ /g, "");
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;

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

/**
 * Above this, two differently-spelled strings are treated as the same name.
 * Tuned so "vera medcal" still finds "Vera Medical" while "rover" does not
 * match "Vera Medical" — a wrong confident match is far worse than an ask.
 */
const FUZZY_THRESHOLD = 0.62;

export type MatchTier =
  | "thread-id"
  | "exact-title"
  | "exact-title-relaxed"
  | "title-prefix"
  | "title-contains"
  | "title-tokens"
  | "sounds-like-title"
  | "project"
  | "workspace"
  | "fuzzy-title";

/** Ordered strongest to weakest. The first tier with any hit decides. */
const TIER_ORDER: ReadonlyArray<MatchTier> = [
  "thread-id",
  "exact-title",
  "exact-title-relaxed",
  "title-prefix",
  "title-contains",
  "title-tokens",
  "sounds-like-title",
  "project",
  "workspace",
  "fuzzy-title",
];

/**
 * Tiers we are willing to act on without asking, when they are unambiguous.
 *
 * `sounds-like-title` is on this list on purpose. Every word here arrived
 * through a transcriber that has never seen the user's product names and spells
 * them by ear, so an exact match on the spoken form is as much confirmation as
 * this input channel can ever provide — holding out for matching letters would
 * mean asking "did you mean CareGen?" every single time someone says CareGen.
 */
const CONFIDENT_TIERS: ReadonlySet<MatchTier> = new Set([
  "thread-id",
  "exact-title",
  "exact-title-relaxed",
  "title-prefix",
  "title-contains",
  "title-tokens",
  "sounds-like-title",
  "project",
  "workspace",
]);

function tierFor(query: string, thread: ThreadSnapshot): MatchTier | null {
  const rawQuery = query.trim();
  if (rawQuery.length === 0) return null;
  if (rawQuery === thread.threadId) return "thread-id";

  const normalizedQuery = normalizeReference(rawQuery);
  const normalizedTitle = normalizeReference(thread.title);
  if (normalizedQuery.length === 0) return null;
  if (normalizedQuery === normalizedTitle) return "exact-title";

  const queryPhrase = contentPhrase(rawQuery);
  const titlePhrase = contentPhrase(thread.title);
  if (queryPhrase === titlePhrase) return "exact-title-relaxed";

  if (normalizedTitle.startsWith(normalizedQuery) || normalizedQuery.startsWith(normalizedTitle)) {
    return "title-prefix";
  }
  if (normalizedTitle.includes(normalizedQuery) || normalizedQuery.includes(normalizedTitle)) {
    return "title-contains";
  }

  // Every meaningful word the user said appears in the title, in any order.
  const queryWords = contentTokens(rawQuery);
  const titleWords = new Set(referenceTokens(thread.title));
  if (queryWords.length > 0 && queryWords.every((word) => titleWords.has(word))) {
    return "title-tokens";
  }

  // Same name, spelled by ear. The transcriber has never seen "CareGen" and
  // writes what it heard — "CaraGen", "Karagen", "Care Gen" — none of which
  // share enough letters to reach the fuzzy tier below. They are all the same
  // sound, and sound is what the user actually said.
  if (soundsLike(queryPhrase, titlePhrase)) return "sounds-like-title";

  // The user named the project rather than the thread — common when a project
  // has one obvious thread, and the reason project is exposed at all.
  const projectPhrase = contentPhrase(thread.projectName);
  if (projectPhrase.length > 0) {
    if (queryPhrase === projectPhrase) return "project";
    const projectWords = new Set(referenceTokens(thread.projectName));
    if (queryWords.length > 0 && queryWords.every((word) => projectWords.has(word))) {
      return "project";
    }
  }

  // Failing that, the folder it lives in — people say "the t3 fork one".
  const workspacePhrase = contentPhrase(thread.workspaceName);
  if (workspacePhrase.length > 0 && queryPhrase === workspacePhrase) return "workspace";
  if (workspacePhrase.length > 0 && soundsLike(queryPhrase, workspacePhrase)) return "workspace";

  if (spokenSimilarity(rawQuery, thread.title) >= FUZZY_THRESHOLD) return "fuzzy-title";
  if (
    thread.projectName.length > 0 &&
    spokenSimilarity(rawQuery, thread.projectName) >= FUZZY_THRESHOLD
  ) {
    return "fuzzy-title";
  }

  return null;
}

/**
 * How alike two names are, allowing for the transcriber having guessed.
 *
 * The better of the written and spoken scores. A near-miss can be near in
 * either direction — a dropped letter is an orthographic slip, a swapped vowel
 * is a phonetic one — and being penalised on the axis that happens not to apply
 * is what put real matches under the threshold.
 */
export function spokenSimilarity(left: string, right: string): number {
  return Math.max(similarity(left, right), phoneticSimilarity(left, right));
}

export interface ResolvedThreadMatch {
  readonly kind: "resolved";
  readonly thread: ThreadSnapshot;
  readonly matchedOn: MatchTier;
  /** True when the tier is strong enough to act on without confirming. */
  readonly confident: boolean;
}

export interface AmbiguousThreadMatch {
  readonly kind: "ambiguous";
  readonly matchedOn: MatchTier;
  readonly candidates: ReadonlyArray<ThreadSnapshot>;
}

export interface NoThreadMatch {
  readonly kind: "not-found";
  /** Closest few, so the orchestrator can offer them instead of just failing. */
  readonly suggestions: ReadonlyArray<ThreadSnapshot>;
}

export type ThreadResolution = ResolvedThreadMatch | AmbiguousThreadMatch | NoThreadMatch;

const MAX_SUGGESTIONS = 3;

/**
 * Maps a spoken reference to a thread.
 *
 * `projectHint` is what the user said about the project when they named one
 * separately ("the Vera Medical one, the API thread"). It only ever *narrows*
 * an otherwise ambiguous set — it can never turn no match into a match, so a
 * wrong hint degrades to asking rather than to routing somewhere wrong.
 */
export function resolveThreadReference(
  world: ReadonlyMap<string, ThreadSnapshot>,
  query: string,
  options: { readonly projectHint?: string } = {},
): ThreadResolution {
  const threads = [...world.values()];
  if (query.trim().length === 0) {
    return { kind: "not-found", suggestions: threads.slice(0, MAX_SUGGESTIONS) };
  }

  const byTier = new Map<MatchTier, Array<ThreadSnapshot>>();
  for (const thread of threads) {
    const tier = tierFor(query, thread);
    if (tier === null) continue;
    const bucket = byTier.get(tier);
    if (bucket === undefined) byTier.set(tier, [thread]);
    else bucket.push(thread);
  }

  for (const tier of TIER_ORDER) {
    const matched = byTier.get(tier);
    if (matched === undefined || matched.length === 0) continue;

    let candidates: ReadonlyArray<ThreadSnapshot> = matched;
    if (candidates.length > 1 && options.projectHint !== undefined) {
      const narrowed = narrowByProject(candidates, options.projectHint);
      if (narrowed.length > 0) candidates = narrowed;
    }

    const first = candidates[0];
    if (candidates.length === 1 && first !== undefined) {
      return {
        kind: "resolved",
        thread: first,
        matchedOn: tier,
        confident: CONFIDENT_TIERS.has(tier),
      };
    }

    return { kind: "ambiguous", matchedOn: tier, candidates };
  }

  const suggestions = threads
    .map((thread) => ({
      thread,
      score: Math.max(
        spokenSimilarity(query, thread.title),
        spokenSimilarity(query, thread.projectName),
      ),
    }))
    .filter((entry) => entry.score > 0.2)
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_SUGGESTIONS)
    .map((entry) => entry.thread);

  return { kind: "not-found", suggestions };
}

function narrowByProject(
  candidates: ReadonlyArray<ThreadSnapshot>,
  projectHint: string,
): ReadonlyArray<ThreadSnapshot> {
  const hintWords = contentTokens(projectHint);
  if (hintWords.length === 0) return [];
  return candidates.filter((thread) => {
    const projectWords = new Set([
      ...referenceTokens(thread.projectName),
      ...referenceTokens(thread.workspaceName),
    ]);
    return hintWords.every((word) => projectWords.has(word));
  });
}

/**
 * How to tell two same-named threads apart out loud.
 *
 * Several threads on one project is the case that made titles insufficient —
 * "Vera Medical" twice is unanswerable, "Vera Medical, working, on Opus" is not.
 */
export function describeCandidate(thread: ThreadSnapshot): string {
  const parts = [`"${thread.title}"`];
  if (thread.projectName.length > 0 && thread.projectName !== thread.title) {
    parts.push(`in ${thread.projectName}`);
  }
  parts.push(thread.isWorking ? "currently working" : "idle");
  if (thread.model !== "unknown") parts.push(`on ${thread.model}`);
  return parts.join(", ");
}

// ── Projects ─────────────────────────────────────────────────────

export interface ProjectReference {
  readonly projectId: string;
  readonly environmentId: string;
  readonly name: string;
  readonly workspaceName: string;
}

export type ProjectResolution =
  | { readonly kind: "resolved"; readonly project: ProjectReference }
  | { readonly kind: "ambiguous"; readonly candidates: ReadonlyArray<ProjectReference> }
  | { readonly kind: "not-found"; readonly suggestions: ReadonlyArray<ProjectReference> };

/**
 * Same tiered idea as threads, over project names and their folders.
 *
 * Needed because starting a new thread requires a project, and the user names
 * it the way they say it out loud — "the t3 fork one", not a uuid.
 */
export function resolveProjectReference(
  projects: ReadonlyArray<ProjectReference>,
  query: string,
): ProjectResolution {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { kind: "not-found", suggestions: projects.slice(0, MAX_SUGGESTIONS) };
  }

  const normalized = normalizeReference(trimmed);
  const phrase = contentPhrase(trimmed);
  const words = contentTokens(trimmed);

  const tiers: ReadonlyArray<(project: ProjectReference) => boolean> = [
    (project) => normalizeReference(project.name) === normalized,
    (project) => contentPhrase(project.name) === phrase,
    (project) => normalizeReference(project.workspaceName) === normalized,
    (project) => normalizeReference(project.name).includes(normalized),
    (project) => words.every((word) => new Set(referenceTokens(project.name)).has(word)),
    // Heard right, spelled by ear — see `sounds-like-title` above.
    (project) => soundsLike(phrase, contentPhrase(project.name)),
    (project) => soundsLike(phrase, contentPhrase(project.workspaceName)),
    (project) =>
      spokenSimilarity(trimmed, project.name) >= FUZZY_THRESHOLD ||
      spokenSimilarity(trimmed, project.workspaceName) >= FUZZY_THRESHOLD,
  ];

  for (const matches of tiers) {
    const candidates = projects.filter(matches);
    const first = candidates[0];
    if (candidates.length === 1 && first !== undefined) {
      return { kind: "resolved", project: first };
    }
    if (candidates.length > 1) return { kind: "ambiguous", candidates };
  }

  const suggestions = projects
    .map((project) => ({ project, score: spokenSimilarity(trimmed, project.name) }))
    .filter((entry) => entry.score > 0.2)
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_SUGGESTIONS)
    .map((entry) => entry.project);

  return { kind: "not-found", suggestions };
}
