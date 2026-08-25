export interface AudioMutableBrowserWebview {
  setAudioMuted?: (muted: boolean) => void;
}

/** Applies the sidebar-owned audio policy directly at the Electron guest boundary. */
export function applyHostedBrowserWebviewAudio(
  webview: AudioMutableBrowserWebview | null,
  audible: boolean,
): void {
  try {
    webview?.setAudioMuted?.(!audible);
  } catch {
    // Electron exposes the method on the element before the guest is attached,
    // but invoking it in that window throws. did-attach/dom-ready reapply the
    // current policy from audibleRef, so failing closed here is temporary.
  }
}
