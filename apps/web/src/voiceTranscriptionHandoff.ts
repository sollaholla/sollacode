/**
 * Tracks the "Transcription ready" toast raised for a thread the user has
 * navigated away from.
 *
 * That toast is created with `timeout: 0`, so nothing retires it on its own. It
 * carries a live Send button holding the transcript, and the same transcript is
 * also restored into that thread's composer draft. So a user who simply walks
 * back to the conversation ends up with two ways to send the same words, and
 * tapping both sends the message twice.
 *
 * Returning to the thread is the moment the toast stops being useful — the
 * composer in front of them now holds the text. Registering the toast against
 * its owning thread lets that thread close it on arrival.
 */

const toastIdByThreadKey = new Map<string, string>();

export function registerPendingTranscriptionToast(threadKey: string, toastId: string): void {
  if (threadKey.length === 0) return;
  toastIdByThreadKey.set(threadKey, toastId);
}

/** Returns and forgets the toast owed to this thread, if any. */
export function takePendingTranscriptionToast(threadKey: string): string | null {
  if (threadKey.length === 0) return null;
  const toastId = toastIdByThreadKey.get(threadKey);
  if (toastId === undefined) return null;
  toastIdByThreadKey.delete(threadKey);
  return toastId;
}

/** Forget a toast that has already been closed (Send tapped, or dismissed). */
export function forgetPendingTranscriptionToast(threadKey: string): void {
  toastIdByThreadKey.delete(threadKey);
}

export function resetPendingTranscriptionToastsForTests(): void {
  toastIdByThreadKey.clear();
}
