/**
 * Dictation through the browser's own speech recogniser.
 *
 * On a phone the in-app microphone records audio and hands it to
 * `desktopBridge.transcribeVoice`, which only exists inside Electron. A web
 * client falls back to a Transformers.js model, so the button was hidden on
 * touch devices entirely - which left the iOS keyboard's mic as the only way to
 * dictate, and that route mutates the editor's DOM behind our back. Every word
 * that disappeared mid-sentence came from defending against those mutations.
 *
 * Safari exposes `webkitSpeechRecognition`, backed by the same Apple recogniser
 * the keyboard uses. Driving it ourselves means the transcript arrives as a
 * plain string that we insert through the composer's own draft path: no
 * `beforeinput`, no target ranges, no replacement events to defend against.
 */

type SpeechRecognitionAlternativeLike = { readonly transcript: string };
type SpeechRecognitionResultLike = {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechRecognitionAlternativeLike | undefined;
};
type SpeechRecognitionResultListLike = {
  readonly length: number;
  readonly [index: number]: SpeechRecognitionResultLike | undefined;
};
export type SpeechRecognitionEventLike = {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
};

export type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { readonly error?: string }) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

/**
 * Whether to drive the recogniser ourselves instead of recording audio.
 *
 * Only on a touch client with no desktop bridge - which is exactly where the
 * microphone is hidden today, so nothing that currently works can regress. A
 * desktop install keeps the bridge path, and desktop web keeps its existing
 * local model rather than silently changing recogniser.
 */
export function shouldPreferNativeSpeechDictation(input: {
  readonly hasDesktopBridge: boolean;
  readonly hasCoarsePointer: boolean;
  readonly hasRecognizer: boolean;
}): boolean {
  if (input.hasDesktopBridge) return false;
  if (!input.hasCoarsePointer) return false;
  return input.hasRecognizer;
}

/**
 * Fold recognition results into the text so far.
 *
 * The recogniser re-reports the tail of what it is still deciding on, so only
 * results marked final are committed. Interim text is returned separately for
 * display and is replaced wholesale by the next event - never appended, which
 * is the mistake that produces the same phrase three times.
 */
export function foldSpeechRecognitionEvent(input: {
  readonly committed: string;
  readonly event: SpeechRecognitionEventLike;
}): { readonly committed: string; readonly interim: string } {
  let committed = input.committed;
  let interim = "";
  const results = input.event.results;
  for (let index = input.event.resultIndex; index < results.length; index += 1) {
    const result = results[index];
    if (!result) continue;
    const text = result[0]?.transcript ?? "";
    if (text.length === 0) continue;
    if (result.isFinal) committed = joinSpeechSegments(committed, text);
    else interim = joinSpeechSegments(interim, text);
  }
  return { committed, interim };
}

/** Join two spoken fragments with exactly one space and no leading gap. */
export function joinSpeechSegments(left: string, right: string): string {
  const start = left.trimEnd();
  const end = right.trim();
  if (end.length === 0) return start;
  if (start.length === 0) return end;
  return `${start} ${end}`;
}

/**
 * What a session that ended should deliver.
 *
 * Safari on iOS does not reliably finalise the last phrase: when the user
 * releases the button, `stop()` frequently ends the session with the tail of
 * the sentence still marked interim, and a session it ends on its own can do
 * the same. That interim text is the recogniser's best reading of words that
 * were definitely spoken, so it belongs in the transcript - dropping it is
 * exactly the "my last few words are missing" report.
 */
export function settleSpeechTranscript(input: {
  readonly committed: string;
  readonly interim: string;
}): string {
  return joinSpeechSegments(input.committed, input.interim);
}

/**
 * Whether to start another recognition session after one ended on its own.
 *
 * iOS ends a session after a stretch of silence or roughly a minute of
 * speech, whichever comes first, while the user may well still be holding the
 * microphone. Listening again keeps the dictation going; the accumulated
 * transcript carries across sessions. Two guards keep this from spinning:
 * once the caller has asked to stop nothing restarts, and a session that ends
 * without hearing anything is only retried a bounded number of times before
 * we accept that the microphone has gone quiet for good.
 */
export function shouldRestartSpeechRecognition(input: {
  readonly stopRequested: boolean;
  readonly heardSpeech: boolean;
  readonly silentRestarts: number;
  readonly maxSilentRestarts: number;
}): boolean {
  if (input.stopRequested) return false;
  if (input.heardSpeech) return true;
  return input.silentRestarts < input.maxSilentRestarts;
}

export function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

export type NativeSpeechDictationSession = {
  /** Stop listening and resolve with everything the recogniser heard. */
  readonly stop: () => Promise<string>;
  /** Give up without delivering a transcript. */
  readonly abort: () => void;
  /** Latest interim text, for showing what is being heard. */
  readonly onInterim: (listener: (interim: string) => void) => void;
};

/** How many empty sessions in a row to re-open before treating silence as final. */
export const SPEECH_DICTATION_MAX_SILENT_RESTARTS = 3;
/**
 * How long `stop()` waits for the recogniser's `end` before delivering what
 * it has. Safari has been seen to swallow the `end` after `stop()` when the
 * tab is being backgrounded; without a bound the transcript never arrives and
 * the composer sits on "transcribing" until the page is reloaded.
 */
export const SPEECH_DICTATION_STOP_TIMEOUT_MS = 2_500;

/**
 * Start listening. Resolves through `stop()` with the transcript.
 *
 * The session survives the recogniser's own restarts: iOS ends recognition on
 * silence and on a length limit, so a new recogniser is opened each time one
 * ends while the user is still holding the button, and the committed text is
 * carried across. Only `stop()` (or `abort()`) actually finishes.
 */
export function startNativeSpeechDictation(options: {
  readonly create: () => SpeechRecognitionLike;
  readonly lang: string;
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly stopTimeoutMs?: number;
  readonly maxSilentRestarts?: number;
}): NativeSpeechDictationSession {
  const scheduleTimeout =
    options.setTimeout ??
    ((callback: () => void, ms: number) => globalThis.setTimeout(callback, ms));
  const cancelTimeout =
    options.clearTimeout ??
    ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  const stopTimeoutMs = options.stopTimeoutMs ?? SPEECH_DICTATION_STOP_TIMEOUT_MS;
  const maxSilentRestarts = options.maxSilentRestarts ?? SPEECH_DICTATION_MAX_SILENT_RESTARTS;

  let committed = "";
  let interim = "";
  let interimListener: ((interim: string) => void) | null = null;
  let settle: ((transcript: string) => void) | null = null;
  let failed: ((cause: Error) => void) | null = null;
  let stopRequested = false;
  let stopTimer: unknown = null;
  let silentRestarts = 0;
  // Recorded rather than dispatched, because the recogniser can end or fail
  // before anyone asks it to stop - iOS does exactly that on silence.
  let outcome:
    | { readonly kind: "done" }
    | { readonly kind: "error"; readonly cause: Error }
    | null = null;
  let current: SpeechRecognitionLike | null = null;

  const transcript = () => settleSpeechTranscript({ committed, interim });
  const clearStopTimer = () => {
    if (stopTimer === null) return;
    cancelTimeout(stopTimer);
    stopTimer = null;
  };
  const finish = () => {
    if (outcome !== null) return;
    clearStopTimer();
    outcome = { kind: "done" };
    settle?.(transcript());
  };
  const fail = (cause: Error) => {
    if (outcome !== null) return;
    clearStopTimer();
    outcome = { kind: "error", cause };
    failed?.(cause);
  };

  const listen = (): boolean => {
    let recognition: SpeechRecognitionLike;
    try {
      recognition = options.create();
    } catch (cause) {
      fail(cause instanceof Error ? cause : new Error("Speech recognition is unavailable."));
      return false;
    }
    recognition.lang = options.lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    let heardSpeech = false;
    let detached = false;

    recognition.onresult = (event) => {
      if (detached) return;
      const folded = foldSpeechRecognitionEvent({ committed, event });
      if (folded.committed !== committed || folded.interim.length > 0) heardSpeech = true;
      committed = folded.committed;
      interim = folded.interim;
      interimListener?.(folded.interim);
    };
    recognition.onerror = (event) => {
      if (detached) return;
      // "no-speech" and "aborted" are ordinary outcomes, not failures: they
      // end the session, and `onend` decides whether to listen again.
      const error = event.error ?? "unknown";
      if (error === "no-speech" || error === "aborted") return;
      detached = true;
      fail(new Error(`Speech recognition failed: ${error}`));
    };
    recognition.onend = () => {
      if (detached) return;
      detached = true;
      if (current === recognition) current = null;
      if (outcome !== null) return;
      if (
        !shouldRestartSpeechRecognition({
          stopRequested,
          heardSpeech,
          silentRestarts,
          maxSilentRestarts,
        })
      ) {
        finish();
        return;
      }
      silentRestarts = heardSpeech ? 0 : silentRestarts + 1;
      // Anything still interim when a session ends on its own is a phrase the
      // recogniser will not revisit: commit it before the next session, which
      // starts its result list from scratch.
      committed = transcript();
      interim = "";
      if (!listen()) finish();
    };

    try {
      recognition.start();
    } catch (cause) {
      detached = true;
      // The very first start must succeed for dictation to exist at all;
      // a restart that iOS refuses (it wants a user gesture) simply ends the
      // session with what was heard so far.
      if (current === null && committed.length === 0 && interim.length === 0) {
        fail(cause instanceof Error ? cause : new Error("Speech recognition could not start."));
      }
      return false;
    }
    current = recognition;
    return true;
  };

  if (!listen() && outcome === null) finish();

  return {
    stop: () =>
      new Promise<string>((resolve, reject) => {
        settle = resolve;
        failed = reject;
        stopRequested = true;
        if (outcome !== null) {
          if (outcome.kind === "done") resolve(transcript());
          else reject(outcome.cause);
          return;
        }
        const recognition = current;
        if (recognition === null) {
          finish();
          return;
        }
        stopTimer = scheduleTimeout(() => {
          stopTimer = null;
          if (outcome !== null) return;
          try {
            recognition.abort();
          } catch {
            // Nothing left to release; deliver what was heard regardless.
          }
          finish();
        }, stopTimeoutMs);
        recognition.stop();
      }),
    abort: () => {
      stopRequested = true;
      clearStopTimer();
      outcome = { kind: "done" };
      current?.abort();
      current = null;
    },
    onInterim: (listener) => {
      interimListener = listener;
    },
  };
}
