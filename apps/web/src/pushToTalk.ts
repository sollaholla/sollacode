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

async function decodeAudio(blob: Blob): Promise<Float32Array> {
  const context = new AudioContext({ sampleRate: 16_000 });
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) =>
      buffer.getChannelData(index),
    );
    return downmixAudioChannels(channels);
  } finally {
    await context.close();
  }
}

export interface TranscriptionProgress {
  readonly status: "loading" | "transcribing";
  readonly progress?: number;
}

type RecorderStartTarget = Pick<MediaRecorder, "start" | "state">;

export async function playRecordingStartCue(): Promise<void> {
  if (typeof AudioContext === "undefined") return;

  const context = new AudioContext();
  try {
    if (context.state === "suspended") {
      await context.resume();
    }
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(740, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.035, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.055);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.06);
    await new Promise<void>((resolve) => {
      oscillator.addEventListener("ended", () => resolve(), { once: true });
    });
  } finally {
    await context.close();
  }
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
let nextRequestId = 0;
const pendingRequests = new Map<
  number,
  {
    readonly resolve: (text: string) => void;
    readonly reject: (error: Error) => void;
    readonly onProgress?: (progress: TranscriptionProgress) => void;
  }
>();

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
  worker.addEventListener("error", () => {
    const error = new Error("The local transcription worker stopped unexpectedly.");
    for (const pending of pendingRequests.values()) pending.reject(error);
    pendingRequests.clear();
    worker.terminate();
    transcriptionWorker = null;
  });
  transcriptionWorker = worker;
  return worker;
}

export async function transcribeRecordedAudio(
  blob: Blob,
  onProgress?: (progress: TranscriptionProgress) => void,
): Promise<string> {
  const audio = await decodeAudio(blob);
  if (audio.length === 0) return "";
  const id = ++nextRequestId;
  const worker = getTranscriptionWorker();
  return new Promise<string>((resolve, reject) => {
    pendingRequests.set(id, {
      resolve,
      reject,
      ...(onProgress !== undefined ? { onProgress } : {}),
    });
    worker.postMessage({ id, audio }, [audio.buffer]);
  });
}

export function disposeTranscriptionWorker(): void {
  if (!transcriptionWorker) return;
  const worker = transcriptionWorker;
  const error = new Error("Local transcription was cancelled.");
  for (const pending of pendingRequests.values()) pending.reject(error);
  pendingRequests.clear();
  worker.postMessage({ type: "dispose" });
  transcriptionWorker = null;
  window.setTimeout(() => worker.terminate(), 250);
}
