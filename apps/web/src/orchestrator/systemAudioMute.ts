import type { VoiceSessionState } from "./realtimeSession";

export function shouldMuteSystemAudioForOrchestrator(input: {
  readonly state: VoiceSessionState;
  readonly working: boolean;
  readonly enabled: boolean;
}): boolean {
  return input.enabled && input.state === "listening" && !input.working;
}

/**
 * Starts one owner-scoped system-audio mute and returns its release function.
 * A late IPC completion is released a second time so a fast state transition
 * cannot leave the machine muted after the microphone has already closed.
 */
export function beginVoiceCaptureSystemAudioMute(input: {
  readonly setMuted: (muted: boolean) => Promise<unknown>;
  /** A newer listening lease owns the same desktop mute now. */
  readonly superseded?: () => boolean;
}): () => void {
  let released = false;
  void input
    .setMuted(true)
    .then(() => {
      if (released && input.superseded?.() !== true) {
        void input.setMuted(false).catch(() => undefined);
      }
    })
    .catch(() => undefined);

  return () => {
    if (released) return;
    released = true;
    void input.setMuted(false).catch(() => undefined);
  };
}
