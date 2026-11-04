import { CheckIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const BAR_WIDTH_PX = 4;
const BAR_GAP_PX = 3;
const MAX_RECORDING_SECONDS = 120;

const formatElapsed = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/**
 * How loud one frame of microphone samples is, 0 to 1. Time-domain bytes sit
 * around 128; speech rarely passes a third of full scale, so the level is
 * stretched to make ordinary talking fill the bar.
 */
export function voiceLevelFromSamples(samples: Uint8Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) {
    const centered = (sample - 128) / 128;
    sum += centered * centered;
  }
  return Math.min(1, Math.sqrt(sum / samples.length) * 3.2);
}

/**
 * Takes over a phone's screen while a voice note records: the sound as it
 * comes in, how long it has run, and the two ways out. Done attaches the note
 * to the draft; Cancel throws it away. The drawing loop runs only while this
 * is mounted, which is only while recording.
 */
export function VoiceNoteRecordingOverlay(props: {
  readonly stream: MediaStream;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(
      () => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)),
      250,
    );
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const AudioContextConstructor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!canvas || !AudioContextConstructor) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    // Reads the microphone without playing it back: the analyser is never
    // connected to the speakers.
    const audioContext = new AudioContextConstructor();
    void audioContext.resume().catch(() => undefined);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    const source = audioContext.createMediaStreamSource(props.stream);
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const levels: number[] = [];
    let frame = 0;

    const draw = () => {
      frame = window.requestAnimationFrame(draw);
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio);
      if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio);
      analyser.getByteTimeDomainData(samples);
      const barCount = Math.max(1, Math.floor(width / (BAR_WIDTH_PX + BAR_GAP_PX)));
      levels.push(voiceLevelFromSamples(samples));
      if (levels.length > barCount) levels.splice(0, levels.length - barCount);

      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = getComputedStyle(canvas).color;
      const middle = height / 2;
      // Newest on the right, the way the sound arrives.
      const offset = width - levels.length * (BAR_WIDTH_PX + BAR_GAP_PX);
      levels.forEach((level, index) => {
        const barHeight = Math.max(BAR_WIDTH_PX, level * height * 0.9);
        const x = offset + index * (BAR_WIDTH_PX + BAR_GAP_PX);
        context.beginPath();
        context.roundRect(x, middle - barHeight / 2, BAR_WIDTH_PX, barHeight, BAR_WIDTH_PX / 2);
        context.fill();
      });
    };
    frame = window.requestAnimationFrame(draw);

    return () => {
      window.cancelAnimationFrame(frame);
      source.disconnect();
      // The recorder owns the microphone tracks; only the analyser goes here.
      void audioContext.close().catch(() => undefined);
    };
  }, [props.stream]);

  const nearLimit = elapsedSeconds >= MAX_RECORDING_SECONDS - 15;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Recording a voice note"
      data-voice-note-recording-overlay
      className="fixed inset-0 z-[200] flex flex-col bg-background px-6 pt-[max(env(safe-area-inset-top),1.5rem)] pb-[max(env(safe-area-inset-bottom),1.5rem)] text-foreground"
    >
      <div className="flex flex-col items-center gap-1 pt-6 text-center">
        <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <span aria-hidden className="size-2 rounded-full bg-destructive" />
          Recording voice note
        </span>
        <span
          className={`text-4xl font-semibold tabular-nums ${nearLimit ? "text-destructive" : ""}`}
          aria-live="off"
        >
          {formatElapsed(elapsedSeconds)}
        </span>
        <span className="text-xs text-muted-foreground">Up to two minutes</span>
      </div>

      <canvas ref={canvasRef} aria-hidden className="my-8 min-h-0 w-full flex-1 text-primary" />

      <div className="flex items-center justify-between gap-6">
        <button
          type="button"
          onClick={props.onCancel}
          className="flex min-h-12 items-center gap-2 rounded-full px-5 text-base font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <XIcon className="size-5" aria-hidden />
          Cancel
        </button>
        <button
          type="button"
          onClick={props.onDone}
          autoFocus
          className="flex min-h-14 items-center gap-2 rounded-full bg-primary px-8 text-lg font-semibold text-primary-foreground shadow-lg transition-transform active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <CheckIcon className="size-5" aria-hidden />
          Done
        </button>
      </div>
    </div>,
    document.body,
  );
}
