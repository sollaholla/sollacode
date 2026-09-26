import { MicIcon, XIcon } from "lucide-react";

/** The recording stays separate from accompanying text, before and after send. */
export function VoiceNoteChip({
  src,
  durationMs,
  transcript,
  pending,
  onRemove,
}: {
  src?: string | undefined;
  durationMs: number;
  transcript?: string | undefined;
  pending?: boolean;
  onRemove?: () => void;
}) {
  const seconds = Math.round(durationMs / 1000);
  return (
    <div className="w-72 max-w-full rounded-2xl border border-border bg-background/70 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium">
        <MicIcon className="size-4 shrink-0 text-gold-600" aria-hidden />
        <span className="flex-1">Voice note</span>
        <span className="tabular-nums text-muted-foreground">
          {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
        </span>
        {onRemove ? (
          <button
            type="button"
            onClick={onRemove}
            aria-label="Remove voice note"
            className="rounded p-1 hover:bg-muted"
          >
            <XIcon className="size-4" />
          </button>
        ) : null}
      </div>
      {src ? (
        <audio
          controls
          preload="metadata"
          src={src}
          aria-label="Play voice note"
          className="h-9 w-full"
        />
      ) : (
        <p className="text-xs text-muted-foreground">Recording unavailable</p>
      )}
      {transcript ? (
        <details className="mt-2 text-xs">
          <summary className="w-fit cursor-pointer rounded-full border border-border px-2 py-1 text-muted-foreground">
            Transcribed
          </summary>
          <p className="mt-2 whitespace-pre-wrap break-words leading-relaxed">{transcript}</p>
        </details>
      ) : pending ? (
        <p className="mt-2 text-xs text-muted-foreground" role="status">
          Transcribing on host…
        </p>
      ) : null}
    </div>
  );
}
