export function VoiceTranscriptionResultChip(props: {
  readonly transcript: string;
  readonly onDismiss: () => void;
  readonly onSend: () => void;
}) {
  const send = () => {
    // Dismiss synchronously so the ready result cannot linger or be sent
    // twice while the canonical composer send begins.
    props.onDismiss();
    props.onSend();
  };

  return (
    <div
      aria-label="Transcription ready"
      className="chat-composer-status-chip group/voice-result pointer-events-auto grid max-w-full grid-cols-[minmax(0,1fr)_auto_auto] items-start gap-1.5 rounded-lg border border-border/70 bg-background/95 px-2.5 py-1.5 text-xs text-muted-foreground shadow-sm"
      data-chat-composer-status-chip="voice-result"
      role="group"
    >
      <span aria-live="polite" className="sr-only">
        Transcription ready to send.
      </span>
      <div
        aria-label={`Transcription: ${props.transcript}`}
        className="min-w-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        role="note"
        tabIndex={0}
      >
        <span
          aria-hidden="true"
          className="line-clamp-1 min-w-0 break-words whitespace-pre-wrap group-hover/voice-result:line-clamp-none group-focus-within/voice-result:line-clamp-none"
        >
          {props.transcript}
        </span>
      </div>
      <button
        aria-label="Send transcribed message"
        className="rounded-md bg-primary px-2 py-0.5 font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        onClick={send}
        type="button"
      >
        Send
      </button>
      <button
        aria-label="Dismiss transcription"
        className="inline-flex size-5 items-center justify-center rounded-md text-base leading-none text-foreground/70 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        onClick={props.onDismiss}
        title="Dismiss transcription"
        type="button"
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}
