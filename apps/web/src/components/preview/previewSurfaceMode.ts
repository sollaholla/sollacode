/**
 * Which surface a client shows for a preview tab.
 *
 * `local-guest` renders this machine's own Chromium guest. `remote-mirror`
 * renders frames captured on whichever machine is actually hosting the guest.
 */
export type PreviewSurfaceMode = "local-guest" | "remote-mirror";

/**
 * A preview tab is a server-side session, but the guest that backs it is a real
 * browser on exactly one machine — the one the automation broker picked, which
 * prefers the machine that owns the environment so agents inherit its logins.
 *
 * A client that renders its own guest for an environment on another machine is
 * therefore showing a second, divergent browser: same URL, different cookies,
 * and nothing the agent does ever appears in it. Mirror the real guest instead.
 *
 * A client that cannot host a guest at all mirrors unconditionally. Guests are
 * Electron `<webview>`s and the host that renders them is mounted only there,
 * so in a regular browser the local surface is not a worse picture of the page
 * — it is no picture at all.
 *
 * Beyond that, only a positive mismatch switches to the mirror. `environmentLocal`
 * is null while the primary environment is still resolving; that keeps the
 * existing local surface rather than inferring a remote host from an absence.
 */
export function resolvePreviewSurfaceMode(input: {
  readonly canRenderLocalGuest: boolean;
  readonly environmentLocal: boolean | null;
}): PreviewSurfaceMode {
  if (!input.canRenderLocalGuest) return "remote-mirror";
  return input.environmentLocal === false ? "remote-mirror" : "local-guest";
}
