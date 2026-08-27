import { playCueOnce, type VoiceCuePolicy } from "./orchestrator/voiceCues";
import { DEFAULT_NATIVE_TRANSCRIPTION_CONTEXT } from "./pushToTalkTranscription";

export interface PushToTalkShortcutEvent {
  readonly code?: string;
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly repeat?: boolean;
}

export function isPushToTalkShortcut(
  event: PushToTalkShortcutEvent,
  platform = navigator.platform,
): boolean {
  const isMac = /mac|iphone|ipad|ipod/i.test(platform);
  const isD = event.code === "KeyD" || event.key.toLowerCase() === "d";
  return (
    isD && !event.shiftKey && !event.altKey && event.metaKey === isMac && event.ctrlKey === !isMac
  );
}

/**
 * macOS can suppress the letter keyup while Command remains held. Treat
 * release of either half of the chord as the end signal so a held recording
 * cannot get stranded waiting for a KeyD event that Chromium never receives.
 */
export function isPushToTalkReleaseEvent(
  event: Pick<PushToTalkShortcutEvent, "code" | "key">,
  platform = navigator.platform,
): boolean {
  const isMac = /mac|iphone|ipad|ipod/i.test(platform);
  const key = event.key.toLowerCase();
  if (event.code === "KeyD" || key === "d") return true;
  return isMac
    ? event.code === "MetaLeft" || event.code === "MetaRight" || key === "meta"
    : event.code === "ControlLeft" || event.code === "ControlRight" || key === "control";
}

/**
 * Exactly one mounted chat surface may own the global push-to-talk shortcut.
 * The main chat yields whenever the event came from an embedded side chat;
 * an embedded side chat only handles events originating inside itself.
 */
export function shouldHandlePushToTalkForSurface(input: {
  readonly embeddedSideChat: boolean;
  readonly targetWithinOwnSurface: boolean;
  readonly targetWithinEmbeddedSideChat: boolean;
}): boolean {
  return input.embeddedSideChat
    ? input.targetWithinOwnSurface
    : !input.targetWithinEmbeddedSideChat;
}

export interface PushToTalkFocusTarget {
  readonly isConnected: boolean;
  readonly focus: (options?: FocusOptions) => void;
}

/** Restore the control that owned the held chord, falling back to the composer. */
export function restorePushToTalkFocus(
  target: PushToTalkFocusTarget | null,
  fallback: () => void,
): "target" | "fallback" {
  if (target?.isConnected) {
    target.focus({ preventScroll: true });
    return "target";
  }
  fallback();
  return "fallback";
}

/**
 * A held push-to-talk transcript goes to the selected terminal instead of the
 * composer when the chord was pressed with a terminal focused, or while the
 * thread's main surface is the terminal workspace (where no composer is
 * visible to receive it).
 */
export function shouldRouteTranscriptToTerminal(input: {
  readonly targetWithinTerminalSurface: boolean;
  readonly terminalMainSurfaceActive: boolean;
  readonly activeTerminalId: string;
}): boolean {
  if (!input.activeTerminalId) return false;
  return input.targetWithinTerminalSurface || input.terminalMainSurfaceActive;
}

export function downmixAudioChannels(channels: ReadonlyArray<Float32Array>): Float32Array {
  if (channels.length === 0) return new Float32Array();
  if (channels.length === 1) return channels[0]?.slice() ?? new Float32Array();
  const frameCount = Math.min(...channels.map((channel) => channel.length));
  const mono = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sample = 0;
    for (const channel of channels) {
      sample += channel[frame] ?? 0;
    }
    mono[frame] = sample / channels.length;
  }
  return mono;
}

/** Convert Web Audio's normalized floats to the little-endian PCM Apple expects. */
export function encodeFloat32Pcm16(audio: Float32Array): Uint8Array {
  const pcm = new Uint8Array(audio.length * 2);
  const view = new DataView(pcm.buffer);
  for (let index = 0; index < audio.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, audio[index] ?? 0));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return pcm;
}

function transcriptionCancellationError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Local transcription was cancelled.");
}

function createTranscriptionCancellationError(): Error {
  const error = new Error("Local transcription was cancelled.");
  error.name = "AbortError";
  return error;
}

export function isTranscriptionCancellationError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}

export function raceWithTranscriptionCancellation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(transcriptionCancellationError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(transcriptionCancellationError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(cause);
      },
    );
  });
}

async function decodeAudio(blob: Blob, signal: AbortSignal): Promise<Float32Array> {
  const context = new AudioContext({ sampleRate: 16_000 });
  try {
    const encodedAudio = await raceWithTranscriptionCancellation(blob.arrayBuffer(), signal);
    const buffer = await raceWithTranscriptionCancellation(
      context.decodeAudioData(encodedAudio),
      signal,
    );
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) =>
      buffer.getChannelData(index),
    );
    return downmixAudioChannels(channels);
  } finally {
    void context.close().catch(() => undefined);
  }
}

export interface TranscriptionProgress {
  readonly status: "loading" | "transcribing";
  readonly progress?: number;
}

export function resolveVisiblePushToTalkStatus(
  localStatus: "recording" | "loading" | "transcribing" | null,
  backgroundStatus: "loading" | "transcribing" | null,
): "recording" | "loading" | "transcribing" | null {
  // A background task can only exist after recording has stopped. Prefer it
  // over a stale route-local recording value so the UI cannot remain latched
  // on "Release to transcribe" after the microphone has already closed.
  if (backgroundStatus !== null) return backgroundStatus;
  return localStatus === "recording" ? localStatus : null;
}

export const TRANSCRIPTION_DEADLINE_MS = 6 * 60_000;
export const AUDIO_DECODE_DEADLINE_MS = 30_000;

export function withTranscriptionDeadline<T>(
  operation: Promise<T>,
  onTimeout: (error: Error) => void,
  timeoutMs = TRANSCRIPTION_DEADLINE_MS,
  timeoutMessage = "Local transcription took too long and was stopped. Your recording was not added; try recording again.",
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      const error = new Error(timeoutMessage);
      onTimeout(error);
      reject(error);
    }, timeoutMs);

    void operation.then(resolve, reject).finally(() => {
      globalThis.clearTimeout(timeoutId);
    });
  });
}

type RecorderStartTarget = Pick<MediaRecorder, "start" | "state">;

/**
 * The dictation "recording started" sound: the same `mic-open` cue the voice
 * orchestrator plays, from the same table.
 *
 * It used to be a separate 740 Hz blip with its own volume — two different
 * sounds for "the microphone just opened, talk now" depending on which feature
 * opened it. One vocabulary, one sound. Resolves only after the tone has
 * finished, which the desktop caller relies on: it must not mute system audio
 * underneath the very cue that confirms recording began.
 */
export async function playRecordingStartCue(policy?: VoiceCuePolicy): Promise<void> {
  await playCueOnce("mic-open", policy);
}

/**
 * Runs the recording-start cue in full, and only then the system-audio mute.
 *
 * The mute used to be requested before the recorder even existed, so on macOS
 * the one sound that says "recording has started" played into an output that
 * had just been silenced — inaudible exactly where push-to-talk is most used.
 * The cue is still best-effort: a failed tone must not cost the mute, which
 * protects the transcription rather than the ear.
 *
 * The two `recordingActive` checks close a race: a tap-and-release can end the
 * recording while the cue or the mute IPC is still in flight, and a mute that
 * lands after the stop handler already ran would stay until the safety timer.
 */
export async function cueThenMuteSystemAudio(input: {
  readonly playCue: () => Promise<void>;
  /** Null when there is no desktop bridge or the user turned the mute off. */
  readonly muteSystemAudio: (() => Promise<unknown>) | null;
  readonly recordingActive: () => boolean;
  /** Marks the mute as requested, so the recorder's stop path restores it. */
  readonly noteMuteRequested: () => void;
  /** Undoes a mute that landed after the recording already ended. */
  readonly restoreSystemAudio: () => void;
}): Promise<void> {
  await input.playCue().catch(() => undefined);
  if (input.muteSystemAudio === null) return;
  if (!input.recordingActive()) return;
  input.noteMuteRequested();
  await input.muteSystemAudio();
  if (!input.recordingActive()) input.restoreSystemAudio();
}

export function startRecorderWithCue(
  recorder: RecorderStartTarget,
  playCue: () => void | Promise<void> = playRecordingStartCue,
): boolean {
  if (recorder.state !== "inactive") return false;
  recorder.start();
  const activeState: string = recorder.state;
  if (activeState !== "recording") return false;
  void Promise.resolve(playCue()).catch(() => {
    // The cue is best-effort. System sound policy must not break recording.
  });
  return true;
}

interface WorkerResponse {
  readonly id: number;
  readonly text?: string;
  readonly error?: string;
  readonly status?: TranscriptionProgress["status"];
  readonly progress?: number;
}

let transcriptionWorker: Worker | null = null;
let activeTranscriptionController: AbortController | null = null;
let nextRequestId = 0;
const pendingRequests = new Map<
  number,
  {
    readonly resolve: (text: string) => void;
    readonly reject: (error: Error) => void;
    readonly onProgress?: (progress: TranscriptionProgress) => void;
  }
>();

function resetTranscriptionWorker(error: Error, expectedWorker?: Worker): void {
  if (expectedWorker && transcriptionWorker !== expectedWorker) return;
  const worker = transcriptionWorker;
  transcriptionWorker = null;
  for (const pending of pendingRequests.values()) pending.reject(error);
  pendingRequests.clear();
  worker?.terminate();
}

function getTranscriptionWorker(): Worker {
  if (transcriptionWorker) return transcriptionWorker;
  const worker = new Worker(new URL("./pushToTalk.worker.ts", import.meta.url), { type: "module" });
  worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
    const pending = pendingRequests.get(event.data.id);
    if (!pending) return;
    if (event.data.status) {
      pending.onProgress?.({
        status: event.data.status,
        ...(event.data.progress !== undefined ? { progress: event.data.progress } : {}),
      });
      return;
    }
    pendingRequests.delete(event.data.id);
    if (event.data.error) {
      pending.reject(new Error(event.data.error));
      return;
    }
    pending.resolve(event.data.text?.trim() ?? "");
  });
  const rejectWorkerRequests = () => {
    resetTranscriptionWorker(
      new Error("The local transcription worker stopped unexpectedly."),
      worker,
    );
  };
  worker.addEventListener("error", rejectWorkerRequests);
  worker.addEventListener("messageerror", rejectWorkerRequests);
  transcriptionWorker = worker;
  return worker;
}

export function transcribeRecordedAudio(
  blob: Blob,
  onProgress?: (progress: TranscriptionProgress) => void,
): Promise<string> {
  if (activeTranscriptionController) {
    return Promise.reject(new Error("Another voice transcription is already in progress."));
  }

  const controller = new AbortController();
  activeTranscriptionController = controller;
  const operation = (async () => {
    const audio = await withTranscriptionDeadline(
      decodeAudio(blob, controller.signal),
      (error) => {
        controller.abort(error);
        resetTranscriptionWorker(error);
      },
      AUDIO_DECODE_DEADLINE_MS,
      "Audio preparation did not finish and was reset. Try recording again.",
    );
    if (audio.length === 0) return "";
    if (controller.signal.aborted) throw transcriptionCancellationError(controller.signal);

    // macOS 26's SpeechAnalyzer is the primary desktop path: it uses Apple's
    // current on-device model, needs no account or API key, and avoids the
    // smallest Whisper checkpoint that made dictation visibly inaccurate.
    // The bridge is optional so web/mobile/older installs fall through to the
    // local Transformers.js model below without changing their contract.
    const nativeTranscribe =
      typeof window === "undefined" ? undefined : window.desktopBridge?.transcribeVoice;
    if (nativeTranscribe) {
      onProgress?.({ status: "transcribing" });
      try {
        const nativeResult = await raceWithTranscriptionCancellation(
          nativeTranscribe({
            pcm16: encodeFloat32Pcm16(audio),
            sampleRate: 16_000,
            locale: navigator.language?.trim() || "en-US",
            contextualStrings: [...DEFAULT_NATIVE_TRANSCRIPTION_CONTEXT],
          }),
          controller.signal,
        );
        if (nativeResult.status === "success") return nativeResult.text.trim();
      } catch (cause) {
        if (controller.signal.aborted) throw transcriptionCancellationError(controller.signal);
        // A missing native model, older macOS build, or helper failure is not a
        // lost dictation: retry the same PCM through the free local fallback.
      }
    }

    const id = ++nextRequestId;
    const worker = getTranscriptionWorker();
    const workerOperation = new Promise<string>((resolve, reject) => {
      pendingRequests.set(id, {
        resolve,
        reject,
        ...(onProgress !== undefined ? { onProgress } : {}),
      });
      try {
        worker.postMessage({ id, audio }, [audio.buffer]);
      } catch (cause) {
        pendingRequests.delete(id);
        reject(cause instanceof Error ? cause : new Error("Local transcription could not start."));
      }
    });
    return raceWithTranscriptionCancellation(workerOperation, controller.signal);
  })();

  const guardedOperation = withTranscriptionDeadline(
    operation,
    (error) => {
      controller.abort(error);
      resetTranscriptionWorker(error);
    },
    TRANSCRIPTION_DEADLINE_MS,
  );
  return guardedOperation.finally(() => {
    if (activeTranscriptionController === controller) {
      activeTranscriptionController = null;
    }
  });
}

export function cancelActiveTranscription(): boolean {
  const controller = activeTranscriptionController;
  if (!controller) return false;
  const error = createTranscriptionCancellationError();
  controller.abort(error);
  resetTranscriptionWorker(error);
  return true;
}

export function disposeTranscriptionWorker(): void {
  const error = createTranscriptionCancellationError();
  activeTranscriptionController?.abort(error);
  resetTranscriptionWorker(error);
}
