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
pixel dimensions and zoom, with a 1.5× sampling margin for fine text, bounded by
the capture resolution and pixel budget. Widths align to four pixels to avoid
observed horizontal distortion in the Mac HEVC to WebKit path. Codec selection
prefers hardware HEVC/H.264 where available, with VP8 as a compatibility option.
A bounded encoder queue and byte budget replace old pending frames with the newest
capture. Relay acknowledgments adapt the bitrate to queueing, and each viewer has
independent flow control. A dropped inter-frame sequence waits for a fresh keyframe.
The decoder also skips excessive backlog and requests a keyframe. Static content
can receive one refinement pass; nothing continuously repaints the canvas.

A magnified viewer also reports the part of the source on screen, once its fingers
settle. When every viewer does, the publisher draws just that part (with a pan
margin) into the encoder, so the pixel budget and bitrate go to what is being read.
A viewer without a region keeps the whole picture for everyone, which is also how
older viewers stay correct: they never send a region, so they never receive a crop.
Each crop starts at a key frame whose configuration names it in fractions of the
source. Moving a crop without resizing it needs that key frame but no new encoder,
and a pan inside the margin needs neither. The viewer paints crops on a second
canvas over its part of the last whole picture, moved in the same task as the paint;
frames still in the decoder stay in the crop they were cut from. The whole picture
is frozen meanwhile, so panning away shows it briefly until the next crop arrives.
It is requested first whenever a viewer opens already magnified.

The capture normally stops at 2560x1600. While a crop is active the host reopens
it at the display's physical size if that is larger, and returns ten seconds after
the crop ends, because full-size capture costs the host on every frame.

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
