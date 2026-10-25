# Remote-control media channel

Remote control separates keyboard/pointer/session RPC from video. A capable viewer
uses WebCodecs to decode binary packets from `/ws/media` directly onto a canvas,
without the MediaRecorder container or MediaSource playback clock. The existing
MediaRecorder/JPEG watch stream remains the compatibility path.

The server advertises `remoteControlMediaChannel`. Viewers use the new path only
when this flag is present and they can decode a supported codec. Missing WebCodecs
(including an insecure browser context), repeated connection/decoder failures, or
no decoded frame within five seconds returns the viewer to the legacy watch stream.
The native mobile app does not currently expose remote control; mobile browsers
use the same viewer as web/desktop.

Each approved session owns one relay topic. Host and viewer request short-lived,
single-use tickets through their authenticated RPC connection. The broker checks
session ownership and host connection identity. Ending a session closes its topic
and invalidates outstanding tickets. Binary messages carry frame type, encoder
epoch, sequence, timestamps, and decoder configuration on every keyframe. Control
messages carry viewport, codec support, acknowledgments, and display metadata.
Tickets and media URLs are ephemeral and must not be persisted or logged.

The publisher captures only while subscribed, with a three-second grace period
after the last viewer leaves. It sizes the encoded picture to viewers' visible
pixel dimensions and zoom, bounded by the capture resolution. Codec selection
prefers hardware HEVC/H.264 where available, with VP8 as a compatibility option.
A bounded encoder queue and byte budget replace old pending frames with the newest
capture. Relay acknowledgments adapt the bitrate to queueing, and each viewer has
independent flow control. A dropped inter-frame sequence waits for a fresh keyframe.
The decoder also skips excessive backlog and requests a keyframe. Static content
can receive one refinement pass; nothing continuously repaints the canvas.

Legacy watch demand is counted separately, so the host runs its old encoder only
while a viewer actually needs that path. Display selection restarts both active
capture paths; pointer-lock and cursor changes remain RPC events and do not depend
on video delivery. The same origin and websocket proxy prefix as the environment
connection is used, including remote HTTPS/WSS and the development `/ws` proxy.

## Reproducing measurements

`node apps/desktop/scripts/remote-control-bench/run.ts` runs the production encoder,
relay and decoder against a synthetic desktop with visible frame markers. It
compares the legacy and media paths across idle, typing, scrolling, video and input
scenes with controlled latency/bandwidth. See the script's options and generated
raw logs. This launches isolated Electron/WebKit windows and a test server; it does
not use the installed app's database. Measured results depend on codec availability,
GPU, viewer and link. Unit tests are not a claim of physical-device performance.
