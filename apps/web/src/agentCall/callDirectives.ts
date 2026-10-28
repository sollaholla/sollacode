import type { AgentCallParticipant, AgentCallRosterEntry } from "@t3tools/contracts";

import { LIVE_APPEND_CHUNK_BYTES } from "../orchestrator/liveProtocol";

/**
 * What a call's voice said it is doing, for the device holding the call to
 * act on.
 *
 * GPT-Live with client delegation has no tools, so the device teaches the
 * voice exact phrases (`callRosterInstructions`) — "Transferring you to
 * <Name>.", "Adding <Name> to the call.", "Removing <Name> from the call." —
 * and acts on the flushed assistant transcript, the way a spoken goodbye
 * hangs up (`orchestrator/farewell.ts`).
 */
export interface CallDirective {
  readonly kind: "transfer" | "add" | "remove";
  /** The name as spoken; `resolveSpokenNames` finds who it means. */
  readonly name: string;
}

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

const nameList = (names: ReadonlyArray<string>) =>
  names.join(names.some((name) => name.includes(",")) ? "; " : ", ");

/**
 * `names` after `lead` as lines that each fit one instructions append, split
 * only between names, so no name is ever cut across two appends.
 */
function nameLines(lead: string, names: ReadonlyArray<string>): string[] {
  const lines: string[] = [];
  let current: string[] = [];
  const line = (group: ReadonlyArray<string>) => `${lead} ${nameList(group)}.`;
  for (const name of names) {
    if (current.length > 0 && byteLength(line([...current, name])) > LIVE_APPEND_CHUNK_BYTES) {
      lines.push(line(current));
      current = [];
    }
    current.push(name);
  }
  if (current.length > 0) lines.push(line(current));
  return lines;
}

/**
 * What the voice is told, silently, once the device has the call's roster:
 * the exact phrases this device acts on, then who it can transfer the person
 * to or add. Each line fits one instructions append, and the phrases come
 * first, so even a long roster never cuts them off. Empty for an empty
 * roster. A device that can't act on the phrases never sends them, so its
 * voice never claims a transfer or an add that won't happen.
 */
export function callRosterInstructions(
  entries: ReadonlyArray<Pick<AgentCallRosterEntry, "name" | "vmAgentId">>,
): string[] {
  if (entries.length === 0) return [];
  const agents = entries.filter((entry) => entry.vmAgentId !== null).map((entry) => entry.name);
  return [
    ...(agents.length === 0
      ? []
      : [
          "If the person asks to talk to one of the agents on your transfer list, say exactly 'Transferring you to <Name>.' and nothing after it; the call moves to them. If they ask for someone not on that list, say you can't reach them.",
          ...nameLines("Your transfer list:", agents),
        ]),
    "You can also bring anyone on your call list onto this call. To add someone, end what you say with exactly 'Adding <Name> to the call.', one sentence for each person. To drop someone, end with exactly 'Removing <Name> from the call.'",
    "Once someone is on the call, what the person says to them by name, or to everyone, goes to them too, and their replies come back with their name. Read those out as theirs.",
    ...nameLines(
      "Your call list:",
      entries.map((entry) => entry.name),
    ),
  ];
}

/** Short acknowledgements a phrase may follow: "Sure, adding …", "Okay — transferring …". */
const ACKNOWLEDGEMENT = String.raw`(?:sure(?: thing)?|okay|ok|alright|all right|got it|of course|certainly|absolutely|no problem|will do|right|yes|yep|yeah|great|perfect|sounds good|understood|you got it|right away|happy to|gladly|one moment|one sec|hold on)`;
/**
 * Where a phrase may begin: opening the utterance or a sentence, after at
 * most two short acknowledgements. Never mid-sentence, so a reply read out
 * ("…, adding logging to the call.") or a refusal ("I won't be transferring
 * you to Gregg.") is not the phrase.
 */
const PHRASE_OPENING = String.raw`(?:^|[.!?…]["']?\s+)(?:${ACKNOWLEDGEMENT}(?:[,!]|\s*[—–-])?\s+){0,2}`;
const TRANSFER_PHRASE = new RegExp(`${PHRASE_OPENING}transferring you to\\s+`, "giu");
/** "Adding …" opening a sentence, or joined to the one before ("…, and adding …"). */
const ADD_OPENING = new RegExp(`(?:${PHRASE_OPENING}|(,?\\s+and\\s+))adding\\s+`, "giu");
const REMOVE_OPENING = new RegExp(`(?:${PHRASE_OPENING}|(,?\\s+and\\s+))removing\\s+`, "giu");
/** The rest of the phrase, ending what it covers. */
const ADD_ENDING = /^(.+?)\s+to\s+(?:the|this)\s+call["'.!\s]*$/iu;
const REMOVE_ENDING = /^(.+?)\s+from\s+(?:the|this)\s+call["'.!\s]*$/iu;
const TRAILING_QUOTES = /["'\s]+$/u;

/** Curly quotes made straight and runs of spaces made one. */
const foldSpeech = (text: string) =>
  text
    .replace(/[‘’‚‛ʼ]/gu, "'")
    .replace(/[“”„‟«»]/gu, '"')
    .replace(/\s+/gu, " ")
    .trim();

/** A spoken name without the quotes around it or the "." or "!" after it. */
const trimName = (name: string) => name.replace(/^["'\s]+/u, "").replace(/["'\s.!,…]+$/u, "");

/**
 * The transfer phrase, only when it opens its sentence (or follows a short
 * acknowledgement) and ends what was said: the name is all that follows it.
 * Words after the name leave something no roster entry is called, so they
 * transfer nobody; a name with a "." in it ("Dr. Nova") still does.
 */
function readTransfer(text: string): string | null {
  const last = [...text.matchAll(TRANSFER_PHRASE)].at(-1);
  if (last === undefined) return null;
  const rest = text.slice(last.index + last[0].length);
  if (rest.replace(TRAILING_QUOTES, "").endsWith("?")) return null;
  const name = trimName(rest);
  return name.length === 0 ? null : name;
}

interface PhraseOpening {
  readonly kind: "add" | "remove";
  readonly index: number;
  readonly end: number;
  /** Joined to the phrase before it ("…, and adding …"): only counts after one. */
  readonly joined: boolean;
}

/**
 * The adds and removes that end what was said, in the order said: "Adding
 * <Name> to the call." (or Removing … from), each opening a sentence or
 * following a short acknowledgement, or joined to the one before ("…, and
 * adding …"), running to the end of the utterance. Read from the end, so a
 * name may carry its own punctuation ("Why does login fail?") and an earlier
 * sentence never runs into it.
 */
function readClosingPhrases(text: string): CallDirective[] {
  const openings: PhraseOpening[] = (
    [
      ["add", ADD_OPENING],
      ["remove", REMOVE_OPENING],
    ] as const
  )
    .flatMap(([kind, pattern]) =>
      [...text.matchAll(pattern)].map((match) => ({
        kind,
        index: match.index,
        end: match.index + match[0].length,
        joined: match[1] !== undefined,
      })),
    )
    .toSorted((left, right) => left.index - right.index);
  const found: Array<CallDirective & { readonly joined: boolean }> = [];
  let end = text.length;
  for (;;) {
    const region = text.slice(0, end);
    let phrase: { readonly opening: PhraseOpening; readonly name: string } | null = null;
    for (const opening of openings.filter((candidate) => candidate.end <= end).toReversed()) {
      const ending = opening.kind === "add" ? ADD_ENDING : REMOVE_ENDING;
      const name = trimName(ending.exec(region.slice(opening.end))?.[1] ?? "");
      if (name.length > 0) {
        phrase = { opening, name };
        break;
      }
    }
    if (phrase === null) break;
    found.unshift({ kind: phrase.opening.kind, name: phrase.name, joined: phrase.opening.joined });
    end = phrase.opening.index;
  }
  // "…, and adding Nova to the call." after anything but another phrase is none.
  while (found[0]?.joined) found.shift();
  return found.map(({ kind, name }) => ({ kind, name }));
}

/**
 * The directives a flushed assistant utterance ends with: a transfer, or the
 * adds and removes it closes with (one phrase each, or one naming several:
 * "Adding Gregg and Nova to the call."). Each phrase must end the utterance
 * or lead into another that does (the voice is told to end with them), so
 * "adding a timeout to the call in the client" or a question is none, and
 * must open its sentence or follow a short acknowledgement, so a reply read
 * out ("he's adding a timeout to the call") is none either.
 */
export function readCallDirectives(assistantText: string): ReadonlyArray<CallDirective> {
  const text = foldSpeech(assistantText);
  if (text.length === 0) return [];
  const transfer = readTransfer(text);
  if (transfer !== null) return [{ kind: "transfer", name: transfer }];
  return readClosingPhrases(text);
}

/** A name compared without case, accents or punctuation. */
export function foldCallName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Whether one insertion, deletion or substitution turns `a` into `b`. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let index = 0;
  while (index < short.length && short[index] === long[index]) index += 1;
  // Past the first difference the rest must line up: shifted by one for an
  // insertion, in place for a substitution.
  return short.length === long.length
    ? short.slice(index + 1) === long.slice(index + 1)
    : short.slice(index) === long.slice(index + 1);
}

/**
 * Who a name means: the same name ignoring case and accents, else the one
 * entry a single slip away ("Greg" for "Gregg"). Never a prefix: a word from
 * a reply read out must not land on a chat that starts with it. Null when
 * nobody, or more than one, fits. `agentsOnly` skips plain chats: only agents
 * take a transferred call.
 */
export function resolveRosterName<
  Entry extends { readonly name: string; readonly vmAgentId: string | null },
>(
  name: string,
  entries: ReadonlyArray<Entry>,
  options: { readonly agentsOnly?: boolean } = {},
): Entry | null {
  const wanted = foldCallName(name);
  if (wanted.length === 0) return null;
  const candidates = entries.flatMap((entry) =>
    options.agentsOnly && entry.vmAgentId === null
      ? []
      : [{ entry, folded: foldCallName(entry.name) }],
  );
  const exact = candidates.find((candidate) => candidate.folded === wanted);
  if (exact !== undefined) return exact.entry;
  const close = candidates.filter((candidate) => withinOneEdit(candidate.folded, wanted));
  return close.length === 1 ? close[0]!.entry : null;
}

/** A spoken name as the roster has it: without "the" before it or "chat" after it. */
const bareName = (name: string) =>
  name.replace(/^the\s+/iu, "").replace(/\s+(?:chat|thread)$/iu, "");
/** The names in a spoken list: "Gregg and Nova", "Gregg, Nova and Ava". */
const LIST_SEPARATOR = /\s*,\s*(?:and\s+)?|\s+and\s+/iu;

/**
 * Who a name the voice said means, by `resolveRosterName`, also as the
 * roster names it ("the release notes chat"). A name that fits
 * nobody is read as a list ("Gregg and Nova"), each part resolved. `missing`
 * is what fit nobody, for the voice and the screen to hear of.
 */
export function resolveSpokenNames<
  Entry extends { readonly name: string; readonly vmAgentId: string | null },
>(
  name: string,
  entries: ReadonlyArray<Entry>,
  options: { readonly agentsOnly?: boolean } = {},
): { readonly found: ReadonlyArray<Entry>; readonly missing: ReadonlyArray<string> } {
  const resolve = (spoken: string) =>
    resolveRosterName(spoken, entries, options) ??
    resolveRosterName(bareName(spoken), entries, options);
  const whole = resolve(name);
  if (whole !== null) return { found: [whole], missing: [] };
  const parts = name
    .split(LIST_SEPARATOR)
    .map(trimName)
    .filter((part) => part.length > 0);
  if (parts.length < 2) return { found: [], missing: [name] };
  const found: Entry[] = [];
  const missing: string[] = [];
  for (const part of parts) {
    const entry = resolve(part);
    if (entry === null) missing.push(part);
    else if (!found.includes(entry)) found.push(entry);
  }
  return { found, missing };
}

/**
 * What the voice is told, silently, when people join or leave the call,
 * diffed by chat so a repeated snapshot says nothing. Null when nothing
 * changed.
 */
export function callParticipantNotice(
  known: ReadonlyArray<AgentCallParticipant>,
  next: ReadonlyArray<AgentCallParticipant>,
): string | null {
  const knownIds = new Set(known.map((participant) => participant.threadId));
  const nextIds = new Set(next.map((participant) => participant.threadId));
  const lines = [
    ...known
      .filter((participant) => !nextIds.has(participant.threadId))
      .map((participant) => `${participant.title} left the call.`),
    ...next
      .filter((participant) => !knownIds.has(participant.threadId))
      .map(
        (participant) =>
          `${participant.title} joined the call. What the person says to ${participant.title} by name, or to everyone, reaches them too, and their replies come back with their name; read them out as theirs.`,
      ),
  ];
  return lines.length === 0 ? null : lines.join(" ");
}
