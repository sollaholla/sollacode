import {
  isAgentBuilderThreadId,
  isOrchestratorThreadId,
  type AgentCallParticipant,
  type AgentCallRoster,
  type AgentCallRosterEntry,
  type OrchestrationThreadShell,
  type ThreadId,
  type VmAgent,
} from "@t3tools/contracts";

/**
 * Merged calls: who a call's voice can transfer to or bring onto the call
 * (the roster), which chats on the call the person's words go to, and what
 * those chats are told about the call. Pure; AgentCallLive does the I/O.
 */

/** Delegated work runs in these threads; they answer only the agent that delegated. */
const DELEGATION_WORKER_THREAD_PREFIX = "delegation-worker:";
const ROSTER_MAX_ENTRIES = 30;
const ROSTER_MAX_CHATS = 12;
/** Total characters of names the voice's instructions carry. */
const ROSTER_MAX_NAME_CHARS = 1_500;
/** A chat title longer than this is cut: nobody says more of it aloud. */
const ROSTER_NAME_MAX_CHARS = 100;

/** Speech as it compares: case, accents and apostrophe style ignored; punctuation kept. */
const foldSpeech = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[‘’ʼ]/gu, "'")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();

/**
 * A name, or what was said, as words: `foldSpeech` without punctuation (an
 * apostrophe inside a word stays), so "Fix: login (Safari)" is said as
 * "fix login safari", the way the web's `foldCallName` hears it.
 */
export const spokenKey = (text: string) =>
  foldSpeech(text)
    .replace(/(?<![\p{L}\p{N}])'|'(?![\p{L}\p{N}])/gu, " ")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/ +/gu, " ")
    .trim();

const cleanName = (text: string) =>
  text.replace(/\s+/gu, " ").trim().slice(0, ROSTER_NAME_MAX_CHARS).trim();

/** Why a thread can never be on a call, or null when it can. */
export function unjoinableThreadReason(threadId: string): string | null {
  if (isOrchestratorThreadId(threadId)) return "The orchestrator can't join a call.";
  if (isAgentBuilderThreadId(threadId)) return "Agent Builder can't join a call.";
  if (threadId.startsWith(DELEGATION_WORKER_THREAD_PREFIX))
    return "A delegated worker's chat can't join a call.";
  return null;
}

/**
 * Who a call's voice is told it can transfer the person to or add: the
 * host's other agents that are not stopped, then the person's most recently
 * active chats (not archived, internal, side chats or agents' own chats).
 * Bounded in entries and characters; a name that sounds like one already
 * listed, or like the agent called, is dropped, so agents win.
 */
export function callRoster(input: {
  readonly agent: Pick<VmAgent, "vmAgentId" | "name">;
  readonly agents: ReadonlyArray<Pick<VmAgent, "vmAgentId" | "name" | "status" | "threadId">>;
  readonly threads: ReadonlyArray<
    Pick<OrchestrationThreadShell, "id" | "title" | "archivedAt" | "isSideChat" | "updatedAt">
  >;
}): AgentCallRoster {
  const entries: AgentCallRosterEntry[] = [];
  const seen = new Set([spokenKey(input.agent.name)]);
  let chars = 0;
  const offer = (entry: AgentCallRosterEntry) => {
    const key = spokenKey(entry.name);
    if (
      !key ||
      seen.has(key) ||
      entries.length >= ROSTER_MAX_ENTRIES ||
      chars + entry.name.length > ROSTER_MAX_NAME_CHARS
    )
      return false;
    seen.add(key);
    entries.push(entry);
    chars += entry.name.length;
    return true;
  };
  for (const other of input.agents)
    if (other.vmAgentId !== input.agent.vmAgentId && other.status !== "stopped" && other.threadId)
      offer({ name: cleanName(other.name), threadId: other.threadId, vmAgentId: other.vmAgentId });
  const agentThreads = new Set(input.agents.map((other) => other.threadId));
  const chats = input.threads
    .filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.isSideChat !== true &&
        !agentThreads.has(thread.id) &&
        unjoinableThreadReason(thread.id) === null,
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  let added = 0;
  for (const thread of chats) {
    if (added >= ROSTER_MAX_CHATS) break;
    if (offer({ name: cleanName(thread.title), threadId: thread.id, vmAgentId: null })) added++;
  }
  return { entries };
}

/**
 * The participant a chat joins a call as, or why it can't: it must exist,
 * not be archived, and not be internal. An agent's main chat joins under the
 * agent's name; any other chat under its title.
 */
export function callParticipantFor(input: {
  readonly threadId: ThreadId;
  readonly thread: Pick<OrchestrationThreadShell, "title" | "archivedAt"> | null;
  /** The agent whose main chat this is, if any. */
  readonly agent: Pick<VmAgent, "vmAgentId" | "name"> | null;
}): AgentCallParticipant | { readonly refusal: string } {
  const unjoinable = unjoinableThreadReason(input.threadId);
  if (unjoinable !== null) return { refusal: unjoinable };
  if (input.thread === null) return { refusal: "That chat no longer exists." };
  if (input.thread.archivedAt !== null)
    return { refusal: "That chat is archived. Unarchive it to add it to a call." };
  return input.agent === null
    ? { threadId: input.threadId, title: cleanName(input.thread.title), vmAgentId: null }
    : {
        threadId: input.threadId,
        title: cleanName(input.agent.name),
        vmAgentId: input.agent.vmAgentId,
      };
}

const GROUP_WORD = String.raw`(?:everyone|everybody|guys|folks)(?![\p{L}\p{N}'])`;
/** Second person plural: said to everyone on the call wherever it falls. */
const GROUP_YOU = new RegExp(
  String.raw`(?<![\p{L}\p{N}'])(?:all of you|both of you|all (?:two|three|four|five) of you|y'all|you guys|you all(?!\s+(?:set|right|good|done|ok|okay|alright|ready|sorted|clear)(?![\p{L}\p{N}']))|(?:do|did|can|could|would|will|are|were|have|should) you (?:two|three)|you (?:two|three)(?=\s*(?:[,.!?;:]|$)))(?![\p{L}\p{N}'])`,
  "u",
);
const LEAD_WORD = String.raw`(?:hey|hi|hello|ok|okay|alright|all right|right|so|well|now|and|but|thanks|thank you|good morning|good afternoon|good evening|morning|listen|look)`;
/** Words a sentence can open with before turning to the group: "Okay, so everyone, …". */
const LEAD_IN = String.raw`(?:${LEAD_WORD}[,!]?\s+){0,2}`;
/** A greeting before "everyone" says who is spoken to: "Okay everyone listen up". */
const GREETING = String.raw`(?:hey|hi|hello|ok|okay|alright|all right|thanks|thank you|good morning|good afternoon|good evening|morning|listen|look)`;
const SENTENCE_START = String.raw`(?:^|[.!?;:]\s+)`;
const QUESTION_WORD = String.raw`(?:what|what's|whats|how|how's|hows|who|who's|where|when|why|which|any|anything|anyone)(?![\p{L}\p{N}'])`;
/**
 * "Everyone" (or "everybody", "guys", "folks") said to the call, not about
 * other people ("send it to everyone on the team", "Everyone on the team needs
 * access."): opening a sentence as its own words ("Everyone, …", "Everyone
 * ready?", "Okay so everyone what's the status"), after a greeting ("Okay
 * everyone listen up"), set off by a comma ("…, everybody?"), or ending a
 * question or a thank-you ("what do you think everyone", "Thanks everyone").
 */
const GROUP_ADDRESSED = new RegExp(
  [
    String.raw`${SENTENCE_START}${LEAD_IN}${GROUP_WORD}\s*(?:[,!?.;:]|$)`,
    String.raw`${SENTENCE_START}${LEAD_IN}(?:everyone|everybody)(?![\p{L}\p{N}'])[^.!?]*\?`,
    String.raw`${SENTENCE_START}${LEAD_IN}${GROUP_WORD}\s+${QUESTION_WORD}`,
    String.raw`${SENTENCE_START}${GREETING}[,!]?\s+(?:${LEAD_WORD}[,!]?\s+)?${GROUP_WORD}`,
    String.raw`,\s*${GROUP_WORD}\s*(?:[,.!?;:]|$)`,
    String.raw`(?<![\p{L}\p{N}'])(?:thanks|thank you|hi|hello|hey|bye|goodbye|morning|evening|night|cheers|think)\s+${GROUP_WORD}\s*[.!?]*$`,
    String.raw`${SENTENCE_START}(?:what|how|who|where|when|why|which|does|do|did|is|are|can|could|would|should|will|any)(?![\p{L}\p{N}'])[^.!?]*?(?<!(?:^|\s)(?:to|for|with|from|about|of|on|at|by|in)\s)${GROUP_WORD}\s*[.!?]*$`,
  ].join("|"),
  "u",
);
/**
 * "Does everyone …", "What does everyone think?": asked of the group, unless
 * the sentence was opened to one of them by name ("Scout, does everyone on
 * the team have access?") or it limits who ("everyone on the team").
 */
const GROUP_ASKED = new RegExp(
  String.raw`(?<![\p{L}\p{N}'])(?:does|do|did|is|are|was|were|has|have|can|could|will|would|should|may|might)\s+(?:everyone|everybody)(?![\p{L}\p{N}'])(?!\s+(?:on|in|at|from|who|that|whose|outside|inside)(?![\p{L}\p{N}']))`,
  "u",
);

/** Lead-in words before a name that opens what was said ("Hey Gregg, …"). */
const OPENING_LEAD =
  /^(?:(?:hey|hi|hello|ok|okay|alright|right|so|well|now|and|but|um|uh)\s+){0,2}/u;

/**
 * Whether the person spoke to everyone on the call: "you all", "both of you",
 * "you guys" and the like anywhere; "everyone" only when it is said to the
 * call (see GROUP_ADDRESSED). `openingNames` are the call's names as words
 * (`spokenKey`): asking "does everyone …" of one of them by name opening the
 * sentence is said to them, not to the group.
 */
export const addressesEveryone = (text: string, openingNames: ReadonlyArray<string> = []) => {
  const folded = foldSpeech(text);
  if (GROUP_YOU.test(folded) || GROUP_ADDRESSED.test(folded)) return true;
  if (!GROUP_ASKED.test(folded)) return false;
  const opening = spokenKey(text).replace(OPENING_LEAD, "");
  return !openingNames.some((key) => key && (opening === key || opening.startsWith(`${key} `)));
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const wordPattern = (key: string, flags = "u") =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])${key.split(" ").map(escapeRegExp).join("\\s+")}(?![\\p{L}\\p{N}])`,
    flags,
  );

/** Where a name was said in `spokenKey` text. */
interface Span {
  readonly start: number;
  readonly end: number;
}
const spansOf = (key: string, text: string): ReadonlyArray<Span> =>
  [...text.matchAll(wordPattern(key, "gu"))].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));

/** Whether one insertion, deletion or substitution turns `a` into `b`. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let index = 0;
  while (index < short.length && short[index] === long[index]) index += 1;
  return short.length === long.length
    ? short.slice(index + 1) === long.slice(index + 1)
    : short.slice(index) === long.slice(index + 1);
}

const SPOKEN_WORD = String.raw`[\p{L}\p{N}'-]+`;
/**
 * The words said where someone is addressed: opening a sentence (after
 * lead-in words) or set off by commas. `count` words each, as `spokenKey`.
 */
function addressedWords(text: string, count: number): ReadonlyArray<string> {
  const group = `(${SPOKEN_WORD}(?:\\s+${SPOKEN_WORD}){${count - 1}})`;
  const patterns = [
    new RegExp(`${SENTENCE_START}${LEAD_IN}${group}`, "gu"),
    new RegExp(`,\\s*${group}\\s*(?=[,.!?;:]|$)`, "gu"),
  ];
  const folded = foldSpeech(text);
  return patterns.flatMap((pattern) =>
    [...folded.matchAll(pattern)].map((match) => spokenKey(match[1] ?? "")),
  );
}

/** One chat a stretch of the call goes to; `primary` is the agent called. */
export interface CallDelegationTarget {
  readonly threadId: ThreadId;
  readonly name: string;
  readonly primary: boolean;
}

/**
 * Who the person's new words are for on a call, and whether they spoke to
 * everyone (see `callDelegationTargets`).
 */
export function callAddressing(
  userText: string,
  primary: { readonly threadId: ThreadId; readonly name: string },
  participants: ReadonlyArray<AgentCallParticipant>,
  /** Chats on the call with a question the person's words can answer. */
  asking: ReadonlySet<ThreadId> = new Set(),
): { readonly targets: ReadonlyArray<CallDelegationTarget>; readonly everyone: boolean } {
  const onCall = [
    { target: { ...primary, primary: true }, agent: true },
    ...participants
      .filter((participant) => participant.threadId !== primary.threadId)
      .map((participant) => ({
        target: { threadId: participant.threadId, name: participant.title, primary: false },
        agent: participant.vmAgentId !== null,
      })),
  ];
  const everyone: CallDelegationTarget[] = onCall.map(({ target }) => target);
  if (everyone.length === 1) return { targets: everyone, everyone: false };
  const keys = everyone.map((target) => spokenKey(target.name));
  const wordsOf = keys.map((key) => new Set(key.split(" ")));
  // An agent with a name of two or more words also answers to its first word
  // when that word has 4+ letters and no other name on the call shares it.
  const firstWords = keys.map((key, index) => {
    if (onCall[index]?.agent !== true || !key.includes(" ")) return null;
    const first = key.split(" ")[0] ?? "";
    const shared = wordsOf.some((words, other) => other !== index && words.has(first));
    return [...first].length >= 4 && !shared ? first : null;
  });
  const openingNames = [...keys, ...firstWords.flatMap((first) => (first === null ? [] : [first]))];
  if (addressesEveryone(userText, openingNames)) return { targets: everyone, everyone: true };
  const text = spokenKey(userText);
  const spans = keys.map((key, index) => {
    if (!key) return [];
    const first = firstWords[index];
    return [...spansOf(key, text), ...(first ? spansOf(first, text) : [])];
  });
  // A name said only inside a longer name ("Atlas" in "Atlas migration") is not said.
  const said = spans.map((own, index) =>
    own.some(
      (span) =>
        !spans.some(
          (other, at) =>
            at !== index &&
            (keys[at]?.length ?? 0) > (keys[index]?.length ?? 0) &&
            other.some((outer) => outer.start <= span.start && span.end <= outer.end),
        ),
    ),
  );
  // A name the transcriber spelled another way ("Greg" for "Gregg"): one slip
  // in a name of 4+ letters, where the person addresses someone, when no other
  // name on the call fits those words.
  for (const [index, key] of keys.entries()) {
    if ((spans[index]?.length ?? 0) > 0 || [...key.replaceAll(" ", "")].length < 4) continue;
    const count = key.split(" ").length;
    said[index] = addressedWords(userText, count).some(
      (words) =>
        words !== key &&
        withinOneEdit(words, key) &&
        keys.every(
          (other, at) => at === index || (other !== words && !withinOneEdit(words, other)),
        ),
    );
  }
  const named = everyone.filter((_, index) => said[index]);
  if (named.length > 0) return { targets: named, everyone: false };
  const waiting = everyone.filter((target) => asking.has(target.threadId));
  const [only] = waiting;
  return {
    targets:
      only !== undefined && waiting.length === 1 && !only.primary ? [only] : everyone.slice(0, 1),
    everyone: false,
  };
}

/**
 * Which chats on a call the person's new words go to: every one named in
 * them (case, accents, punctuation and word boundaries respected; a name said
 * only inside a longer name on the call is not; an agent whose name has two
 * or more words also by its first word when that word has 4+ letters and no
 * other name on the call shares it, while a chat needs its whole title, which
 * usually opens with an everyday verb; a name of 4+ letters also with one
 * slip where the person addresses someone, "Greg, …" for Gregg, when no other
 * name fits), everyone when they addressed everyone (see
 * `addressesEveryone`), and the agent called when nobody was named, unless
 * exactly one chat in `asking` is a chat added to the call and the agent
 * called isn't asking: then the person is answering that chat's question.
 * With nobody added, always just the agent called. The agent called comes
 * first, then participants in call order.
 */
export function callDelegationTargets(
  userText: string,
  primary: { readonly threadId: ThreadId; readonly name: string },
  participants: ReadonlyArray<AgentCallParticipant>,
  /** Chats on the call with a question the person's words can answer. */
  asking: ReadonlySet<ThreadId> = new Set(),
): ReadonlyArray<CallDelegationTarget> {
  return callAddressing(userText, primary, participants, asking).targets;
}

const withAnd = (names: ReadonlyArray<string>) =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;

/** The line a chat on a group call gets with the person's words. */
export function groupCallNote(input: {
  /** Everyone else on the call besides the person, by name. */
  readonly others: ReadonlyArray<string>;
  readonly everyone: boolean;
}): string {
  return `(Group call: you're on a call with ${withAnd(["the person", ...input.others])}. The person addressed ${input.everyone ? "everyone" : "you"}.)`;
}
