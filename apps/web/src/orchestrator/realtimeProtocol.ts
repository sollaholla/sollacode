import type { OrchestratorAuthority, OrchestratorVoiceProvider } from "@t3tools/contracts";
import { xaiLanguageHint } from "@t3tools/contracts";

/**
 * Pure helpers for the OpenAI Realtime wire protocol.
 *
 * Kept separate from `realtimeSession.ts` so the parts worth testing — which
 * tools are exposed at a given authority, and how incoming events map to
 * transcript/tool-call callbacks — do not require a WebRTC stack to exercise.
 */

export { DESTRUCTIVE_TOOL_NAMES, toolsForAuthority } from "./toolRegistry";

import { toolsForAuthority } from "./toolRegistry";
import { parseRealtimeUsage, type RealtimeUsage } from "./usageTracking";

export interface RealtimeToolDefinition {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/**
 * Human-readable names for the language pin. Codes outside this map still work
 * — the instruction falls back to naming the ISO code itself.
 */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  hi: "Hindi",
  ru: "Russian",
  ar: "Arabic",
};

export function languageDisplayName(code: string): string {
  return LANGUAGE_NAMES[code] ?? `the language with ISO code "${code}"`;
}

export interface RecentConversationEntry {
  readonly role: "user" | "assistant";
  readonly text: string;
}

const MAX_RECENT_HISTORY_CHARS = 2_400;

/**
 * Delimits remembered history from the live conversation.
 *
 * A visible boundary rather than a change of wording: models follow a literal
 * separator far more reliably than an adjective, and this is the one thing that
 * must not be misread — treating memory as the current turn is how a session
 * opens by finishing a sentence nobody is still saying.
 */
export const SESSION_BOUNDARY_MARKER = "--- end of earlier conversation ---";

export function buildInstructions(input: {
  readonly authority: OrchestratorAuthority;
  readonly confirmDestructiveActions: boolean;
  readonly language: string;
  readonly recentHistory?: ReadonlyArray<RecentConversationEntry>;
}): string {
  const languageName = languageDisplayName(input.language);
  const lines = [
    "You are the orchestrator for Solla Code, a workspace where the user runs several coding agents at once, each in its own thread.",
    "Your job is to manage those threads and the agents inside them on the user's behalf: report what they are doing, route work to the right one, and act on them when asked.",
    "You are not the agent doing the coding. You never write code or claim to have done a thread's work yourself.",
    "Be brief and conversational — this is spoken aloud, so answer in one or two sentences unless asked for detail.",
    // It answered "the model appears once the agent starts generating" — an
    // invented explanation for a field it simply could not see.
    'Only state what the tools actually tell you. Never invent an explanation for missing information: if a field is absent or reads "unknown", say you cannot see it.',
    // It told the user a working thread could not be sent to, and the user then
    // sent one by hand. Inventing a restriction is worse than attempting the
    // call and reporting a real failure: it stops work the user could have had.
    "Never claim a limitation you have not hit. In particular, a thread being busy does not stop you sending to it — send_to_thread works while a thread is working, and the message is queued for it. If you think an action is not allowed, try it and report what the tool actually says rather than refusing in advance.",
    // Routing is the step most likely to go wrong and the least recoverable —
    // but confirming every single message made the orchestrator exhausting to
    // talk to, so the tools now resolve names and only stop on real ambiguity.
    // Everything reaching the model has been through a transcriber that has
    // never seen the user's product names and spells them by ear. It was
    // treating "CaraGen" as an unknown word and asking, rather than as the
    // thread called "CareGen" that is sitting in front of it.
    "What you receive is a transcription of speech, not typed text, and it will get unfamiliar names slightly wrong — a swapped vowel, a hard C for a K, a name split into two words or run into one. Read a name that is nearly one you can see as that name: CaraGen is CareGen, Vera Medcal is Vera Medical.",
    "Prefer a name you can actually see over the literal transcript. When a word does not match anything, look at what is on screen and pick the one it sounds like, using what the user has been talking about to choose between similar-sounding candidates. Only ask when two things you can see sound equally alike — never because the spelling differed by a letter.",
    "Never repeat a misheard word back as if it were correct, and never spell a name out to check it. Use the real name and carry on; if you got it wrong the user will say so.",
    // It was reading requests as if they were identifiers to look up: a phrase
    // describing a capability came back as "I do not have one of those",
    // because the words were not the name of anything. Speech is approximate
    // by nature and this is the register people actually talk in.
    "Read what the user means, not the exact words they used. People describe a capability rather than naming it, name a category rather than a specific thing, and say things loosely — none of that is a request for something that does not exist. Map what they said onto what you can actually do, and do it. Never answer that something does not exist merely because their wording did not match a name; if several things fit, choose the most likely and say which you chose.",
    // It was restating the request in full before every lookup, which doubles
    // the time to an answer and sounds like stalling.
    'Before looking something up, say something short — "Checking that", "One moment", "Having a look" — then call the tool. Say it every time you go and do something, including lookups you expect to be instant: silence while you work is indistinguishable from a dead session. Say it *once*, before the work — never again in the answer that follows, which must go straight to what you found. Do not repeat the request back, restate it in your own words, or narrate what you are about to do; the user just said it and is waiting.',
    // Noise-triggered turns are cancelled before they reach the model, but a
    // near-empty one can still get through, and answering it aloud turns every
    // cough in the room into a demand that the user respond.
    "If a turn arrives with nothing intelligible in it, say nothing at all. Never announce that you did not catch something, did not hear anything, or that the audio was unclear — stay silent and keep listening. The user will speak again when they have something to say.",
    "Every message goes to exactly one thread, never several.",
    'Pass the user\'s own words as the thread — "the Solla Code one", "Vera Medical" — rather than an id or a tidied-up version. Names are matched against thread titles, their projects and their folders, so partial and differently-punctuated names work.',
    // The single biggest complaint: it asked permission for everything instead
    // of using the context it already had.
    "Act on the user's behalf. Decide and do, then say what you did — do not walk them through options or ask them to make choices you can make yourself from what you can see.",
    // Handing work back is the expensive failure: the user delegated precisely
    // so they would not have to do it, and being told to do it themselves is
    // worse than a slow answer.
    "Never ask the user to do something by hand until you have established that neither you nor any thread you can reach is able to do it. Before saying a person has to act, check what your own tools can do, and check whether an existing thread already has the access or the context to carry it out — if one does, send it there and say so. Asking the user to perform a task is a last resort, and when you reach it, say what you tried first.",
    "Do not ask which thread as a matter of course. Send, rename or act, and let the tool tell you when a name genuinely matches more than one thread; only then ask, using the project and what each is doing to tell them apart.",
    "Where a request should go is your call, not theirs. If it continues or relates to what a thread is already doing, send it there — keep one piece of work in one thread rather than scattering it. If it is unrelated to every open thread, start a new one with create_thread and write the title yourself.",
    "Only ask when the context genuinely does not decide it: two threads fit equally well, or you would be guessing at something you cannot see. A question you could have answered from list_threads is a question you should not have asked.",
    // "Waiting on a proposed plan" was all it could say, so the user had to go
    // and look at the very thing they asked to avoid looking at.
    'A thread whose waitingOn is "proposed-plan" has stopped in Plan mode and is waiting for the *user* to approve the plan on its latest turn — nothing else can approve it, and it will not move until they do. Having proposed a plan earlier is not this state. Call describe_thread on it: that returns what the plan proposes and how many steps it has. Say what it is and that it needs their go-ahead, rather than only that the thread is waiting.',
    // Side chats do not appear in the sidebar, so a user told only "it is
    // working on X" goes looking for a thread they will never find there.
    "A thread with isSideChat true is a side chat: a fork that lives as a tab beside another conversation rather than as a thread in the sidebar. Say so when you describe it, and name the conversation it belongs to from sideChatOf when that is given, so the user knows where to find it.",
    "Threads report the project they belong to. When several share a title, that project is how you tell them apart — say it rather than reading out an id.",
    // Without a pin the model picks a language from ambiguous audio — it has
    // opened conversations in French unprompted. The transcription hint helps,
    // but the spoken side needs the same anchor.
    `Always speak ${languageName}. Even if the user's audio sounds like another language or a transcript arrives in another language, answer in ${languageName} unless the user explicitly asks you to switch.`,
    "Refer to threads by their title, never by id. Never read an id aloud.",
    "Always call list_threads before answering a question about current state; never guess. That list includes each thread's open terminals.",
    // Status answers were state labels with nothing behind them, so "what is
    // it doing" was answered from nothing or needed a second call every time.
    'describe_thread includes recentMessages — the thread\'s last few messages. Ground a status answer in them: say what the thread actually last said or was last asked, not just its state. A thread is only "working" when its status or isWorking says so right now; never describe a thread as still running from memory of an earlier answer.',
    // It used to have no model field at all and would invent reasons the model
    // was unavailable rather than saying it could not see one.
    'Each thread reports the model and provider it runs on. Answer questions about which model a thread uses from that field, and if it reads "unknown", say so plainly instead of explaining why it might be missing.',
    // The tools are a general interface, not a fixed script. Without this it
    // treated them as four canned lookups and answered from memory instead.
    "Your tools are a general interface, not a fixed script: use them freely and as often as you need, chain several within one turn, and re-check state after you change something rather than assuming it took.",
    "A requested action is unfinished until its action tool succeeds. If you first read a thread or inspect a project to decide how to act, continue in the same turn and call the action tool before answering. In particular, when asked to derive a better thread name from its history, read_thread is research and rename_thread is the completion — never merely suggest the title.",
    "Every tool takes a `reason` — one short phrase in the user's own terms saying why you are calling it. Always supply it; it is what makes the tool log readable later.",
    "Use get_orchestrator_settings for questions about yourself — which model or voice you are running, what language you are pinned to, what you are allowed to do. Use get_runtime_state for questions about the workspace as a whole.",
    // Everything else it can do points inward at threads. Asked to put a video
    // on, it had nothing — and no way to say why.
    "open_website puts a page on the user's screen in their normal browser: name the site and, if they asked to look something up, what to search for. Use it when they say open, pull up, put on or look up. It is the only thing you can do outside this app, and it can only open a page from a fixed list of sites — it cannot run anything, install anything or change any file. Say what you opened in a few words and never read the address out loud.",
    // It had no way to see either number and was answering from nothing.
    "Use get_usage for anything about consumption: how much of a plan is left, whether a limit is close, when a window resets, or what talking to you costs. It reads the same figures as the Providers tab, plus your own voice usage separately. Give the one window that matters rather than reading the whole list, and never present an estimated cost as a bill.",
    // Without these it answered code questions from memory, or said it could
    // not see the project at all.
    "You can read the user's projects: list_project_files to see the layout, read_project_file to read a file, find_project_files to locate one by name, and search_project to find text across it. Use them to answer questions about the code from what it actually says rather than guessing, and to check something before you pass work to a thread.",
    "Those file tools are read-only and confined to the user's projects. run_command can look around the machine; do not use it to change files unless the user just asked you to. When a coding agent should do the work, send it to the thread that owns that work.",
    "Threads can have terminals open — agent CLIs such as Claude, Grok or Codex, or an ordinary shell. list_threads reports them on each thread; list_terminals lists every pane; read_terminal shows what is on screen; write_to_terminal types into a live pane as the user would. Use those when the user asks what a terminal is doing or wants you to type into one. Do not open a new terminal.",
    "create_side_chat opens a side conversation off a running thread, sharing its context, without disturbing it. Prefer it over create_thread for a question or a tangent about work already in progress.",
    "settle_thread marks a thread finished when the user says they are done with it. It records that state only — the thread stays in the sidebar, nothing is hidden or removed, and undo reverses it.",
    "You can rename a thread with rename_thread. Use it on your own initiative when two threads share a name and the user is having to describe which is which — do not make them ask.",
    "When a thread finishes, what it said is read for you where possible — and where it is not, read_thread gets it. Either way, say what it actually did and name any files, branches or links it produced, never just that it finished. If it stopped early or errored, say so plainly instead of implying success. Never tell the user to go and read the thread themselves.",
  ];

  if (input.authority === "read-only") {
    lines.push(
      "You cannot change anything. If the user asks you to act, say you are in read-only mode.",
    );
  }

  if (input.authority === "full") {
    lines.push(
      // The three fields have genuinely different timing and the difference is
      // what the user asks about; stating it wrong is worse than not answering.
      "You can change a thread's settings with update_thread_settings: its model, thinking effort, access permissions, or whether it is in plan, agent or normal mode. Change only the fields the user named and leave the rest alone.",
      "Changing a model or effort takes a turn to reach the agent — the tool handles that for you and applies it. Do not ask whether to apply a change the user just asked for; they asked, so do it.",
      "The tool stops you only for a consequence they did not ask for: a change that would widen an agent's permissions, or one that would stop a turn the thread is running right now. When it does, put every reason in a single question, get one yes, and call again with confirm — never ask twice for the same change.",
    );
  }

  if (input.confirmDestructiveActions && input.authority === "full") {
    lines.push(
      // Deliberately narrow. Sending, renaming and reversible settings changes
      // are not on this list; asking about those was the friction, not the risk.
      "Before interrupting a turn, or stopping a turn in progress to apply a setting, state which thread you are about to affect and wait for the user to confirm. Speech recognition mishears, and that work cannot be recovered.",
    );
  }

  const history = trimRecentHistory(input.recentHistory ?? []);
  if (history.length > 0) {
    // Framed as memory across a boundary, not as the conversation in progress.
    // Told to "pick up where this left off", the model resumed a finished
    // exchange — answering a question that had already been answered, or
    // carrying on a task the user had moved on from. Every voice session is a
    // new conversation; what came before is background it may draw on, not a
    // sentence it is halfway through.
    lines.push(
      SESSION_BOUNDARY_MARKER,
      "Everything between the marker above and the one below is a record of EARLIER conversations with this user, typed and spoken. It is memory, not the conversation you are in.",
      ...history.map((entry) => `${entry.role === "user" ? "User" : "You"}: ${entry.text}`),
      SESSION_BOUNDARY_MARKER,
      "That record has ended. This is a NEW conversation, starting now. Do not resume, repeat or complete anything from it, and do not assume a request in it is still open — the user may have moved on, and anything they still want they will ask for again. Use it only to recognise names, threads and decisions they refer to, so they do not have to re-explain themselves.",
      "Equally, do not greet them as a stranger. Say nothing about the earlier conversation unless they raise it; just answer what they ask now.",
    );
  }

  return lines.join(" ");
}

/** Newest-first budget: keeps the tail of the conversation when trimming. */
function trimRecentHistory(
  history: ReadonlyArray<RecentConversationEntry>,
): ReadonlyArray<RecentConversationEntry> {
  const kept: Array<RecentConversationEntry> = [];
  let total = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry === undefined || entry.text.trim().length === 0) continue;
    if (total + entry.text.length > MAX_RECENT_HISTORY_CHARS && kept.length > 0) break;
    kept.unshift(entry);
    total += entry.text.length;
  }
  return kept;
}

export interface RealtimeSessionConfig {
  readonly type: "session.update";
  readonly session: Record<string, unknown>;
}

// Turn detection, tuned away from the API defaults after the orchestrator kept
// answering coughs, keyboard noise and half-finished sentences.
//
// The default threshold of 0.5 treats brief room noise as speech — which is
// also what fed silence to the transcriber and produced hallucinated foreign
// phrases. Raising it means the orb only wakes for someone actually talking.
const VOICE_ACTIVITY_THRESHOLD = 0.68;
/** Audio kept from just before detection, so raised speech is not clipped. */
const SPEECH_PREFIX_PADDING_MS = 300;
/**
 * How long the user may pause before the model takes its turn. The default of
 * 500ms interrupts anyone who stops to think mid-sentence.
 *
 * Raised twice, to 1,100ms and then 2,200ms, because each was still cutting
 * people off mid-thought. Ordinary speech carries pauses well past a second —
 * reaching for a name, or working out how to phrase something — and the cost of
 * the two settings is asymmetric: waiting too long adds a beat before the reply,
 * while cutting in too early loses the end of the sentence and answers the wrong
 * question. Prefer the beat.
 *
 * This is only the floor. Silence alone cannot tell a pause from an ending, so
 * `endOfSpeech.ts` reads the transcript as well and holds a reply back when the
 * user audibly trailed off.
 */
export const END_OF_SPEECH_SILENCE_MS = 2_200;
/**
 * Grok Voice's server VAD still ends a turn sooner than OpenAI at the same
 * `silence_duration_ms`, but 4s of required silence made turns never close:
 * ordinary speech never stays that quiet, the orb stayed on "listening", and
 * nothing was registered. Sit a little above OpenAI; after VAD stop the client
 * still holds the utterance briefly before the "accepted" cue.
 *
 * xAI caps this at 10s.
 */
export const GROK_END_OF_SPEECH_SILENCE_MS = 2_800;

/**
 * Reasoning effort for the voice model.
 *
 * Only the `gpt-realtime-2` family accepts a `reasoning` block — the original
 * `gpt-realtime` rejects the whole `session.update` if one is present, which
 * would take the session down at startup, so this is gated on the model rather
 * than sent unconditionally.
 *
 * The API default is "low". "high" is worth the extra latency here because the
 * orchestrator's hard part is not talking, it is deciding which single thread
 * owns a request and whether a settings change is safe — the exact judgements
 * that were going wrong at low effort.
 */
const REALTIME_REASONING_EFFORT = "high";

export function supportsReasoningEffort(model: string): boolean {
  const trimmed = model.trim();
  // Every documented Grok Voice model accepts `reasoning.effort`.
  if (trimmed.startsWith("grok-voice")) return true;
  // "gpt-realtime-2", "gpt-realtime-2.1", "gpt-realtime-2.1-mini" — but not
  // plain "gpt-realtime".
  return /^gpt-realtime-2(\b|[.-])/.test(trimmed);
}

export function buildSessionUpdate(input: {
  readonly authority: OrchestratorAuthority;
  readonly confirmDestructiveActions: boolean;
  readonly language: string;
  /** The model the session was minted with; decides reasoning support. */
  readonly model?: string;
  readonly provider?: OrchestratorVoiceProvider;
  /** Applied on Grok `session.update`. OpenAI binds voice at mint time. */
  readonly voice?: string;
  readonly recentHistory?: ReadonlyArray<RecentConversationEntry>;
}): RealtimeSessionConfig {
  const reasoningCapable = input.model !== undefined && supportsReasoningEffort(input.model);
  if (input.provider === "xai") {
    return {
      type: "session.update",
      session: {
        instructions: buildInstructions(input),
        tools: toolsForAuthority(input.authority),
        tool_choice: "auto",
        ...(input.voice !== undefined && input.voice.length > 0 ? { voice: input.voice } : {}),
        ...(reasoningCapable ? { reasoning: { effort: REALTIME_REASONING_EFFORT } } : {}),
        // xAI documents turn detection at the session root, not under audio.input.
        turn_detection: {
          type: "server_vad",
          threshold: VOICE_ACTIVITY_THRESHOLD,
          prefix_padding_ms: SPEECH_PREFIX_PADDING_MS,
          silence_duration_ms: GROK_END_OF_SPEECH_SILENCE_MS,
          idle_timeout_ms: null,
        },
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24_000 },
            // `grok-transcribe` is what emits streaming
            // `conversation.item.input_audio_transcription.updated` events.
            transcription: {
              model: "grok-transcribe",
              language_hint: xaiLanguageHint(input.language),
            },
          },
          output: {
            format: { type: "audio/pcm", rate: 24_000 },
          },
        },
      },
    };
  }
  return {
    type: "session.update",
    session: {
      type: "realtime",
      instructions: buildInstructions(input),
      tools: toolsForAuthority(input.authority),
      tool_choice: "auto",
      ...(reasoningCapable ? { reasoning: { effort: REALTIME_REASONING_EFFORT } } : {}),
      audio: {
        input: {
          // Enabling transcription is what makes the API emit
          // `conversation.item.input_audio_transcription.completed` at all —
          // without it user speech never reaches the transcript. The language
          // hint pins recognition so a mumbled opening cannot flip the whole
          // conversation into another language.
          transcription: {
            model: "gpt-4o-mini-transcribe",
            language: input.language,
          },
          turn_detection: {
            type: "server_vad",
            threshold: VOICE_ACTIVITY_THRESHOLD,
            prefix_padding_ms: SPEECH_PREFIX_PADDING_MS,
            silence_duration_ms: END_OF_SPEECH_SILENCE_MS,
            // The client decides when to cut the assistant off, not the server.
            // Left at its default of true, any input energy past the threshold
            // cancelled the in-flight response — so a cup set down on the desk
            // stopped it mid-sentence. See `bargeIn.ts`: the client watches for
            // speech that actually sustains before interrupting anything.
            interrupt_response: false,
            create_response: true,
            // Off, and pinned off. Left unset the API defaults it to null, but
            // this is the one setting that makes the assistant speak into
            // silence entirely on its own: with a timeout, the server commits
            // the empty audio buffer and generates a response "to prompt the
            // user to continue". That is a phone-call behaviour. Here the user
            // is wearing headphones on a walk, and something that starts
            // talking because they stopped is not company, it is an
            // interruption they did not ask for and cannot predict.
            //
            // Sent explicitly rather than omitted so the behaviour cannot
            // arrive later as a change of default.
            idle_timeout_ms: null,
          },
        },
      },
    },
  };
}

// ── Incoming events ──────────────────────────────────────────────

export type RealtimeInboundEvent =
  | { readonly kind: "user-transcript"; readonly text: string; readonly itemId?: string }
  /** A partial transcript, emitted while the user is still speaking. */
  | { readonly kind: "user-transcript-delta"; readonly text: string; readonly itemId?: string }
  | { readonly kind: "assistant-transcript"; readonly text: string }
  | {
      readonly kind: "tool-call";
      readonly callId: string;
      readonly name: string;
      readonly argumentsJson: string;
    }
  | { readonly kind: "speaking-started" }
  | { readonly kind: "assistant-audio-done" }
  | { readonly kind: "speaking-stopped" }
  | { readonly kind: "user-speech-started" }
  | { readonly kind: "user-speech-stopped" }
  // The server acknowledging `session.update`. Until this arrives the session is
  // running on API defaults — no language pin, no instructions — so it is the
  // signal that the microphone may safely be opened.
  | { readonly kind: "session-configured" }
  // Response lifecycle, tracked so the client never stacks up `response.create`
  // frames — the API accepts a second one once the first finishes, which is how
  // the orchestrator ended up answering the same question repeatedly.
  | { readonly kind: "response-started" }
  | { readonly kind: "response-finished"; readonly usage?: RealtimeUsage }
  | { readonly kind: "error"; readonly message: string }
  /** Base64 PCM from Grok's WebSocket transport. Ignored on OpenAI WebRTC. */
  | { readonly kind: "assistant-audio-delta"; readonly audio: string }
  | { readonly kind: "ignored" };

/**
 * Latin-script languages, for the hallucination filter below.
 *
 * Deliberately a small allow-list rather than a script-detection library: the
 * only question being asked is "should this transcript contain Latin letters?".
 */
const LATIN_SCRIPT_LANGUAGES: ReadonlySet<string> = new Set([
  "en",
  "es",
  "fr",
  "de",
  "it",
  "pt",
  "nl",
  "sv",
  "no",
  "da",
  "fi",
  "pl",
  "cs",
  "tr",
  "id",
  "vi",
  "ro",
  "hu",
]);

/**
 * Whether a user transcript is almost certainly a transcription hallucination.
 *
 * Whisper-family models emit stock phrases when handed silence or room noise —
 * Korean "나도", CJK subtitle credits, and similar. Those arrived as real user
 * messages, and now that spoken turns persist into the orchestrator thread they
 * also reach the text agent's prompt, so they have to be dropped at the door.
 *
 * The test is deliberately narrow: when the session is pinned to a
 * Latin-script language, genuine speech always transcribes with at least one
 * Latin letter. Anything with none is noise. Non-Latin languages opt out
 * entirely rather than guess.
 */
export function isLikelyHallucinatedTranscript(text: string, language: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (!LATIN_SCRIPT_LANGUAGES.has(language.trim().toLowerCase())) return false;
  return !/[A-Za-z]/.test(trimmed);
}

/**
 * Words that are a whole utterance on their own.
 *
 * A one-word transcript is usually an artifact, but not always: these are the
 * ones a person really does say alone, and dropping them would make the
 * orchestrator ignore the clearest instructions it ever gets.
 */
const MEANINGFUL_SHORT_UTTERANCES: ReadonlySet<string> = new Set([
  "yes",
  "no",
  "yeah",
  "yep",
  "nope",
  "stop",
  "wait",
  "cancel",
  "quiet",
  "hush",
  "continue",
  "go",
  "next",
  "ok",
  "okay",
  "done",
  "help",
  "repeat",
  "again",
  "goodbye",
  "bye",
  "thanks",
]);

/**
 * Whether a transcript that arrived *while the assistant was speaking* is an
 * echo fragment rather than something the user said.
 *
 * The assistant's own voice loops back through a phone speaker, and what the
 * transcriber makes of a half-heard word is a one- or two-word fragment
 * attributed to the user. Those fragments were landing in the thread as real
 * messages and reading as interruptions.
 *
 * Only applied while the assistant is talking, and only to very short text: a
 * deliberate "stop" has to keep working, which is exactly what someone says
 * when they want to cut it off, so the words that carry a whole meaning on
 * their own are kept.
 */
export function isLikelyEchoFragment(text: string, assistantSpeaking: boolean): boolean {
  if (!assistantSpeaking) return false;
  const words = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, "")
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return true;
  if (words.length > 2) return false;
  // A short utterance the user plausibly meant on its own is not a fragment.
  return !words.some((word) => MEANINGFUL_SHORT_UTTERANCES.has(word));
}

/**
 * Turns an API error into something worth reading aloud.
 *
 * Most realtime errors are already plain English and are passed through. The
 * exception worth naming is a spent account: the session fails at the moment it
 * connects, every time, for a reason no amount of retrying can fix — and the
 * generic wording gives no hint that the fix is billing rather than the app.
 * This cost a long debugging session that ended at a credit balance.
 */
/**
 * Whether an in-band error is just the user colliding with a reply in flight.
 *
 * The API reports this as an error, but nothing is wrong: a `response.create`
 * arrived while one was already generating, so the new one was dropped. The
 * session stays live and the next turn works. Surfacing it as an error put a
 * dismissible red toast on screen mid-conversation — for a condition the user
 * caused by talking, and can only act on by talking again.
 */
export function isResponseCollisionError(message: string): boolean {
  return /already has an active response|conversation_already_has_active_response/i.test(message);
}

export function describeRealtimeError(input: {
  readonly message: string;
  readonly code: string;
  readonly type: string;
  readonly provider?: OrchestratorVoiceProvider;
}): string {
  if (
    input.code === "credit_balance_exhausted" ||
    input.type === "insufficient_quota" ||
    /insufficient.?credits|no credits remaining/i.test(input.message)
  ) {
    return input.provider === "xai"
      ? "Your xAI account has no credits left, so Grok voice cannot start. Add credits at console.x.ai and try again — nothing is wrong with the app or your settings."
      : "Your OpenAI account has no credits left, so voice cannot start. Add credits at platform.openai.com and try again — nothing is wrong with the app or your settings.";
  }
  return input.message;
}

/**
 * What to tell the user when SDP negotiation is refused.
 *
 * The endpoint answers a refusal with a JSON error that already says exactly
 * what is wrong — a spent account, a bad model, a malformed offer. That body
 * used to be dropped on the floor in favour of "Could not negotiate the voice
 * session", which is true of every possible cause and useful for none of them:
 * an out-of-credits account read the same as a transient network fault, so the
 * only visible advice was to try again, forever.
 */
export function describeNegotiationFailure(
  status: number,
  body: string,
  provider: OrchestratorVoiceProvider = "openai",
): string {
  try {
    const parsed: unknown = JSON.parse(body);
    const error =
      typeof parsed === "object" && parsed !== null && "error" in parsed
        ? ((parsed as { error?: Record<string, unknown> }).error ?? {})
        : {};
    const message = typeof error.message === "string" ? error.message : "";
    const code = typeof error.code === "string" ? error.code : "";
    const type = typeof error.type === "string" ? error.type : "";
    if (message.length > 0) return describeRealtimeError({ message, code, type, provider });
  } catch {
    // Not JSON. Fall through to the status-based wording below.
  }
  // 402 and 429 are the two the API uses for billing and rate limits; both are
  // worth naming, because neither is fixed by trying again in a moment.
  if (status === 402) {
    return provider === "xai"
      ? "Your xAI account cannot be billed for this session — check your credits at console.x.ai."
      : "Your OpenAI account cannot be billed for this session — check your credits and payment method at platform.openai.com.";
  }
  if (status === 429) {
    return provider === "xai"
      ? "xAI is rate-limiting or has run out of quota for this account. Check your credits at console.x.ai before retrying."
      : "OpenAI is rate-limiting or has run out of quota for this account. Check your credits at platform.openai.com before retrying.";
  }
  return `Could not start the voice session (HTTP ${status}).`;
}

/**
 * Maps a raw Realtime server event to the small set this app reacts to.
 *
 * Event names have shifted across API revisions (`response.audio_transcript.done`
 * vs `response.output_audio_transcript.done`), so both spellings are accepted
 * rather than pinning to one and going silent after an upgrade.
 */
function realtimeItemId(event: Record<string, unknown>): { readonly itemId: string } | object {
  if (typeof event.item_id === "string" && event.item_id.length > 0) {
    return { itemId: event.item_id };
  }
  const item = event.item;
  if (typeof item === "object" && item !== null && "id" in item) {
    const id = (item as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) return { itemId: id };
  }
  return {};
}

export function parseRealtimeEvent(
  raw: unknown,
  provider: OrchestratorVoiceProvider = "openai",
): RealtimeInboundEvent {
  if (typeof raw !== "object" || raw === null) return { kind: "ignored" };
  const event = raw as Record<string, unknown>;
  const type = typeof event.type === "string" ? event.type : "";

  if (type === "error") {
    const error = event.error as Record<string, unknown> | undefined;
    const message = typeof error?.message === "string" ? error.message : "Realtime session error.";
    const code = typeof error?.code === "string" ? error.code : "";
    const kind = typeof error?.type === "string" ? error.type : "";
    return {
      kind: "error",
      message: describeRealtimeError({ message, code, type: kind, provider }),
    };
  }

  // The first partial transcript of an utterance is the earliest proof the
  // system turned sound into words. `speech_started` only means "energy above a
  // threshold", which a door does too — this means it actually heard you.
  if (type === "conversation.item.input_audio_transcription.delta") {
    const text = typeof event.delta === "string" ? event.delta.trim() : "";
    return text.length > 0
      ? { kind: "user-transcript-delta", text, ...realtimeItemId(event) }
      : { kind: "ignored" };
  }

  // xAI streams a cumulative transcript on `.updated` before the final
  // `.completed`. Treat it as a delta so the "heard you" cue still fires.
  if (type === "conversation.item.input_audio_transcription.updated") {
    const text =
      typeof event.transcript === "string"
        ? event.transcript.trim()
        : typeof event.delta === "string"
          ? event.delta.trim()
          : "";
    return text.length > 0
      ? { kind: "user-transcript-delta", text, ...realtimeItemId(event) }
      : { kind: "ignored" };
  }

  if (type === "response.output_audio.delta" || type === "response.audio.delta") {
    const audio = typeof event.delta === "string" ? event.delta : "";
    return audio.length > 0 ? { kind: "assistant-audio-delta", audio } : { kind: "ignored" };
  }

  if (type === "response.output_audio.done" || type === "response.audio.done") {
    return provider === "xai" ? { kind: "assistant-audio-done" } : { kind: "speaking-stopped" };
  }

  if (type === "conversation.item.input_audio_transcription.completed") {
    const text = typeof event.transcript === "string" ? event.transcript.trim() : "";
    return text.length > 0
      ? { kind: "user-transcript", text, ...realtimeItemId(event) }
      : { kind: "ignored" };
  }

  if (
    type === "response.audio_transcript.done" ||
    type === "response.output_audio_transcript.done"
  ) {
    const text = typeof event.transcript === "string" ? event.transcript.trim() : "";
    return text.length > 0 ? { kind: "assistant-transcript", text } : { kind: "ignored" };
  }

  if (
    type === "response.function_call_arguments.done" ||
    type === "response.output_item.done.function_call"
  ) {
    const callId = typeof event.call_id === "string" ? event.call_id : "";
    const name = typeof event.name === "string" ? event.name : "";
    const argumentsJson = typeof event.arguments === "string" ? event.arguments : "{}";
    return callId.length > 0 && name.length > 0
      ? { kind: "tool-call", callId, name, argumentsJson }
      : { kind: "ignored" };
  }

  // Input speech, as distinct from the assistant's output. The client did not
  // observe these at all before, which is why barge-in was entirely the
  // server's call and impossible to make noise-robust.
  if (type === "input_audio_buffer.speech_started") {
    return { kind: "user-speech-started" };
  }

  if (type === "input_audio_buffer.speech_stopped") {
    return { kind: "user-speech-stopped" };
  }

  if (type === "session.updated") {
    return { kind: "session-configured" };
  }

  if (type === "output_audio_buffer.started" || type === "response.output_audio.started") {
    return { kind: "speaking-started" };
  }

  if (type === "response.created") {
    return { kind: "response-started" };
  }

  // Carries both meanings: the model stopped talking, and the response slot is
  // free again. The session treats it as both.
  if (type === "response.done") {
    // The only place the API reports what a response actually cost.
    const usage = parseRealtimeUsage(event.response);
    return usage === null ? { kind: "response-finished" } : { kind: "response-finished", usage };
  }

  if (type === "output_audio_buffer.stopped" || type === "output_audio_buffer.cleared") {
    return { kind: "speaking-stopped" };
  }

  return { kind: "ignored" };
}

/** Safely decodes a tool call's argument blob; malformed JSON yields `{}`. */
export function parseToolArguments(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    // Arrays are `typeof "object"` too, but are not a valid argument bag.
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Wire frames for returning a tool result and asking for the spoken follow-up. */
export function buildToolOutputFrame(input: {
  readonly callId: string;
  readonly output: unknown;
}): Record<string, unknown> {
  return {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: input.callId,
      output: JSON.stringify(input.output),
    },
  };
}

/** Stops the in-flight response, and the audio already buffered for it. */
export function buildInterruptFrames(): ReadonlyArray<Record<string, unknown>> {
  // `response.cancel` ends generation; on WebRTC the server also truncates the
  // conversation item to what was actually played, so the model knows where it
  // got to. `output_audio_buffer.clear` stops what is already buffered from
  // continuing to play over the user.
  return [{ type: "response.cancel" }, { type: "output_audio_buffer.clear" }];
}

/**
 * Stops a response's generation while leaving the speaker alone.
 *
 * For the echo-triggered duplicate: the audio still playing belongs to the
 * *previous* response and is the thing being protected, so clearing the output
 * buffer here would commit the exact offence — cutting a sentence off mid-word —
 * that cancelling the duplicate exists to prevent.
 */
export function buildCancelResponseFrames(): ReadonlyArray<Record<string, unknown>> {
  return [{ type: "response.cancel" }];
}

/**
 * Stops a response *and silences what it already queued*.
 *
 * The opposite case to {@link buildCancelResponseFrames}, and the distinction
 * matters more than it looks. There, the audio playing belongs to a response
 * being protected. Here it belongs to the response being thrown away — a reply
 * held back because the user was still mid-sentence, or one the server started
 * for a noise. Cancelling generation alone let the opening words of a discarded
 * answer play out anyway, and the real answer then opened with the same words:
 * the assistant audibly saying "Checking that." twice, once from a response
 * nobody ever wanted.
 */
export function buildDiscardResponseFrames(): ReadonlyArray<Record<string, unknown>> {
  return [{ type: "response.cancel" }, { type: "output_audio_buffer.clear" }];
}

/**
 * Asks the model to speak.
 *
 * Deliberately separate from {@link buildToolOutputFrame}: these used to be
 * emitted together, one pair per tool call, so a turn that called several tools
 * queued several responses and the orchestrator answered the same question four
 * or five times over, rephrasing itself. Returning the output and asking for a
 * reply are different decisions — the caller sends every output, then requests
 * exactly one reply.
 */
export function buildResponseCreateFrame(instructions?: string): Record<string, unknown> {
  return instructions === undefined
    ? { type: "response.create" }
    : { type: "response.create", response: { instructions } };
}

/**
 * Wording for the proactive announcements. Passed as `instructions` on a
 * response request rather than injected as a conversation item, so it does not
 * read as the user having spoken.
 */
/**
 * Wording for the reply that follows a tool result.
 *
 * Sent with no instructions at all until now, which is what made the
 * orchestrator say "Checking that." twice out loud. The acknowledgement exists
 * to cover the silence *before* a lookup; the model is told to say it every
 * time, and with nothing said about this response it opened the answer with it
 * again. The transcript hid the second copy — two identical lines in a row are
 * deduplicated — so the only place it survived was the audio.
 */
export function buildToolReplyInstructions(): string {
  return "You already have the result. Answer the user's question directly and briefly. Do not acknowledge, do not say you are checking or looking — that was said before the lookup and repeating it here is the assistant talking twice.";
}

export function buildAnnouncementInstructions(text: string): string {
  return `Tell the user, briefly and in your own words: ${text}`;
}
