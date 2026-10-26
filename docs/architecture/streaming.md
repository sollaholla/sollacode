# Remote screen and browser streaming

Remote control and remote browser preview have separate capture paths. Neither path changes
provider adapters or persists video in the event log. Both retain older-client fallbacks.

## Remote control

The desktop host captures its screen. WebCodecs encodes it for a binary WebSocket at `/ws/media`,
separate from control RPC. A viewer asks for a short-lived, single-use ticket through authenticated
RPC; the ticket is bound to the approved remote-control session and publisher/subscriber role.
Ending the session invalidates its media lifetime, including pending upgrades. The media connection
uses the saved environment's endpoint and the existing `/ws` development proxy prefix.

The viewer advertises codec support, panel size, density, and zoom. The publisher chooses a compatible
codec and image size and adjusts its byte budget using delivery acknowledgements. The relay bounds
pending video and requests a new keyframe after dropping dependent frames. The viewer decodes into
a canvas without MediaSource playback buffering. Decoder, connection, and first-frame failures fall
back to the existing video/image path. Input coordinates use the source dimensions, not the smaller
encoded image dimensions.

Implementation: [`media`](../../packages/client-runtime/src/media),
[`MediaRelay`](../../apps/server/src/media/MediaRelay.ts), and the web remote-control coordinator/viewer.
Native mobile has no full-screen remote-control entry point; mobile web uses the web viewer.

## Browser preview

Compatible web viewers subscribe to `preview.mediaWatch`. `PreviewMediaBroker` binds an opaque
watch to the authenticated viewer, canonical thread, tab, and selected automation host. Separate
short-lived tickets grant subscriber or publisher access to the existing `/ws/media` relay.
The host must advertise video support and own the current automation connection. Closing the tab,
changing hosts, or removing the last watch invalidates the topic and its pending tickets.
Revoking a paired session closes its existing RPC connections, releasing their scoped watches
and host registrations as well as preventing new ticket requests.

Host demand starts a requester-bound Electron tab capture and the shared video publisher. Codec
negotiation, viewport sizing, congestion feedback, and decoder recovery use the same implementation
as remote control. The native video-source descriptor measures the selected page or OAuth popup
and returns its source identity, CSS viewport, and density together. Capture bounds preserve that
aspect ratio; resize, zoom, and selected-surface changes replace the capture. A padded or mismatched
track is rejected so normalized input cannot land in the wrong place.

URL, loading, title, download approvals, and agent pointer updates travel as
validated media broadcasts. Input continues through `preview.remoteInput` using frame fractions,
which the host maps to its CSS viewport. Encoded pixel dimensions never become input coordinates.

The web viewer keeps the JPEG feed until its first decoded video frame. If video cannot start or
later fails, it retains the last picture until JPEG provides a replacement. Hiding or unmounting
the viewer releases the watch, socket, and decoder. Native mobile continues to use JPEG; video
and JPEG demand are independent, so mixed viewers can watch the same tab.
Capture interruption is an explicit media broadcast. The viewer shows JPEG while retaining its
media subscription for native capture retries, then restores video after a recovered frame decodes.
This does not use frame inactivity as a failure signal, since an unchanged page may send no frames.
Likewise, a first-frame timeout shows JPEG while leaving an established media subscription ready
for a later frame. Codec, decoder, and connection failures still release the unusable video path.
Native source aspect changes reconfigure the encoder even when its target width stays unchanged.

Image viewers subscribe to `preview.remoteFrames`. The relay sends demand to a capable desktop
host through its preview-automation stream. Chromium screencast frames feed a latest-frame pipeline:
one picture is processed at a time, and the newest waiting picture replaces an older waiting one.
A settled-page refresh avoids leaving the final change uncaptured after pacing a busy compositor.

The browser encoder compares decoded image tiles. Small changes become JPEG rectangles; larger
changes, dimension changes, and recovery requests produce whole keyframes. An unchanged picture
produces no image event. The relay keeps a bounded keyframe/patch chain, coalesces covered patches,
and applies a per-viewer byte budget. RPC acknowledgement backpressure prevents a slow viewer from
accumulating an unbounded history. A restarted host clears the previous publisher's image chain.

Web paints keyframes and patches onto a canvas. Native mobile uses whole keyframes on its existing
image surface. Demand is aggregated per tab: the largest requested dimensions win, and any viewer
without patch support makes the shared capture use whole frames. This is not independent encoding
per viewer. The last viewer leaving drops the relay's pictures and releases capture demand.
Hidden panels and background native apps unsubscribe. Unsupported hosts and capture failures use
the existing snapshot path, including unchanged-picture suppression.

Implementation: [`PreviewMediaBroker`](../../apps/server/src/preview/PreviewMediaBroker.ts),
[`remoteMedia`](../../apps/web/src/components/preview/remoteMedia),
[`RemoteFrameRelay`](../../apps/server/src/preview/RemoteFrameRelay.ts),
[`remoteFrames`](../../apps/web/src/components/preview/remoteFrames), and the shared
[`feed`](../../packages/client-runtime/src/preview/remoteFrameFeed.ts).

## Measuring changes

Use the [control benchmark](../../apps/desktop/scripts/remote-control-bench/README.md) and
[preview benchmark](../../scripts/remote-preview-bench/README.md). They retain old and new paths,
synthetic repeatable scenes, throttled connections, and machine-readable timing/byte results.
Run source tests and browser-free builds separately from browser benchmarks.

Compare missed/superseded updates, picture quality, and frame rate alongside p50/p95 latency and
bytes. Sending fewer or blurrier pictures can reduce bandwidth without improving the experience.
Software rendering callbacks and network arrival times are distinct from physical display latency;
emulated links and phone-sized windows do not establish behavior on a physical phone or real tunnel.
The benchmark READMEs state which layer each measurement covers.
