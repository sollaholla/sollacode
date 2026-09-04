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

export function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

export type NativeSpeechDictationSession = {
  /** Stop listening and resolve with everything the recogniser committed. */
  readonly stop: () => Promise<string>;
  /** Give up without delivering a transcript. */
  readonly abort: () => void;
  /** Latest interim text, for showing what is being heard. */
  readonly onInterim: (listener: (interim: string) => void) => void;
};

/**
 * Start listening. Resolves through `stop()` with the committed transcript.
 *
 * iOS ends a recognition session on its own after a stretch of silence, so
 * `onend` resolves whatever has been committed rather than treating it as a
 * failure - a pause mid-sentence should not lose the sentence.
 */
export function startNativeSpeechDictation(options: {
  readonly create: () => SpeechRecognitionLike;
  readonly lang: string;
}): NativeSpeechDictationSession {
  const recognition = options.create();
  recognition.lang = options.lang;
  recognition.continuous = true;
  recognition.interimResults = true;

  let committed = "";
  let interimListener: ((interim: string) => void) | null = null;
  let settle: ((transcript: string) => void) | null = null;
  let failed: ((cause: Error) => void) | null = null;
  // Recorded rather than dispatched, because the recogniser can end or fail
  // before anyone asks it to stop - iOS does exactly that on silence.
  let outcome:
    | { readonly kind: "done" }
    | { readonly kind: "error"; readonly cause: Error }
    | null = null;

  const finish = () => {
    if (outcome !== null) return;
    outcome = { kind: "done" };
    settle?.(committed);
  };
  const fail = (cause: Error) => {
    if (outcome !== null) return;
    outcome = { kind: "error", cause };
    failed?.(cause);
  };

  recognition.onresult = (event) => {
    const folded = foldSpeechRecognitionEvent({ committed, event });
    committed = folded.committed;
    interimListener?.(folded.interim);
  };
  recognition.onerror = (event) => {
    // "no-speech" and "aborted" are ordinary outcomes, not failures: deliver
    // whatever was heard and let the caller decide there was nothing to send.
    const error = event.error ?? "unknown";
    if (error === "no-speech" || error === "aborted") {
      finish();
      return;
    }
    fail(new Error(`Speech recognition failed: ${error}`));
  };
  recognition.onend = () => {
    finish();
  };
  recognition.start();

  return {
    stop: () =>
      new Promise<string>((resolve, reject) => {
        settle = resolve;
        failed = reject;
        if (outcome !== null) {
          if (outcome.kind === "done") resolve(committed);
          else reject(outcome.cause);
          return;
        }
        recognition.stop();
      }),
    abort: () => {
      outcome = { kind: "done" };
      recognition.abort();
    },
    onInterim: (listener) => {
      interimListener = listener;
    },
  };
}
