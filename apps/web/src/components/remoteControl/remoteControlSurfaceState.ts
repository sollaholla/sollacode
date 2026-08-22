/**
 * What the viewer's desktop surface shows for a given stream state.
 *
 * Extracted from the dialog because the interesting part is not the markup but
 * an invariant that is easy to break by accident: the surface element is the
 * full-screen target and the pointer-lock target, so it must stay mounted for
 * the whole approved session. An earlier version rendered it only once a frame
 * existed, which meant the gap between "video gave up" and "first JPEG arrived"
 * unmounted it — dropping the user out of full screen mid-fallback, and
 * releasing the pointer, for a transition they are not supposed to notice.
 */

/** Which element paints the remote desktop, if any is ready to. */
export type RemoteControlSurfaceMedia = "video" | "image" | "none";

export interface RemoteControlSurfaceState {
  /** Whether to mount the surface element at all. */
  readonly showSurface: boolean;
  readonly media: RemoteControlSurfaceMedia;
  /**
   * Whether to cover the surface with the loading state. The surface is black
   * until something paints, which is indistinguishable from a broken session.
   */
  readonly showLoadingOverlay: boolean;
}

export function resolveRemoteControlSurface(input: {
  readonly isApproved: boolean;
  /** Set once the host has sent an init segment for a codec. */
  readonly videoMimeType: string | null;
  /** Set once video is known undecodable here, permanently selecting JPEG. */
  readonly videoUnavailable: string | null;
  readonly frameData: string | null;
  readonly hasRenderedFrame: boolean;
}): RemoteControlSurfaceState {
  if (!input.isApproved) {
    return { showSurface: false, media: "none", showLoadingOverlay: false };
  }
  const media: RemoteControlSurfaceMedia =
    input.videoMimeType && !input.videoUnavailable ? "video" : input.frameData ? "image" : "none";
  return {
    showSurface: true,
    media,
    showLoadingOverlay: !input.hasRenderedFrame,
  };
}
