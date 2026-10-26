# Remote preview streaming comparison

From the repository root:

```sh
node scripts/remote-preview-bench/run.ts --out /tmp/preview-bench
```

This launches an isolated Electron process and loopback RPC server. It never opens the live app's
database or tabs. Obtain any browser-launch permission required by the workspace before running.
`--build-only` compiles the encoder page without starting Electron or a server.

Use `--quick` for an eight-second smoke comparison, then longer repeated runs before drawing
performance conclusions. Options include `--modes old,new,new-native,new-video`, `--scenes idle,ticks,caret,spinner,typing,scroll,video`,
`--seconds 20`, `--clicks 15`, `--first-frames 8`, and `--no-slow-link`.
The script writes `results.json`, a generated report, raw timestamp/marker samples, and the host log
to the output directory. Keep each repeated run in its own output directory.

For image modes, `--images` retains one full source JPEG and its decoded PNG per scene under `images/`. After each
timed sample it recompresses that frozen frame as JPEG q50/q75 and WebP q80/q90, saving the encoded
files, decoded PNGs, byte sizes, single-call encode time, and luma PSNR against the decoded source.
This isolates recompression loss; the source already contains capture-JPEG loss. Inspect text and
edges in the PNGs. One-frame scores and encode times do not establish production codec quality or
throughput. The production image fallback remains JPEG; `new-video` uses negotiated interframe
video instead. This option does not change timed frames.

The baseline uses the production snapshot broker, capture/input dispatch, and unchanged-picture
suppression. Its desktop snapshot adapter reproduces the JPEG/size/page-read operations without
the app's foreground leasing and staging, so baseline capture can be faster than the app.
Old polling modes always request one fixed image size, regardless of viewport. They have a single
`shared-node` measurement per scene and network condition, usable as the common baseline for phone
and desktop comparisons. It is not duplicated as separately measured desktop data. Earlier reports
may contain duplicate baseline rows; their original artifacts are retained unchanged.
New mode imports the production stream relay, demand wrapper, screencast pacer, latest-frame
streamer, tile encoder, request sizing, and viewer feed planner. The encoder runs in a separate
Electron renderer through an IPC adapter instead of the app's worker. `new-native` requests keyframes only, like the native Image consumer, without claiming native rendering proof. Both use actual RPC framing
and sockets. The source is a scripted webview, not a user's page.

`new-video` exercises the production preview media broker and generic binary media relay, with
the production preview host lifecycle manager, native tab capture, WebCodecs publisher, and
subscriber. The source id is bound to the isolated requesting Electron renderer. The host uses
the production capture constraints and encoder sizing; no benchmark-only quality preset applies.
Its phone viewer runs in headless Playwright WebKit at the requested viewport/DPR, and its desktop
viewer runs in a separate hidden Electron window. WebKit must already be installed for the repo's
`playwright-core`; `BENCH_WEBKIT_EXECUTABLE` can select its executable. It never substitutes Node
decoding or another browser after a WebKit failure. For a short video-path smoke run:

```sh
node scripts/remote-preview-bench/run.ts --modes new-video --scenes typing,scroll,video --seconds 5 --clicks 1 --first-frames 1 --no-slow-link --images --out /tmp/preview-video-smoke
```

## Evidence boundaries

- Latency is **source marker change to network receipt**, with image pixels decoded offline to determine
  which marker arrived. It excludes viewer decoding, painting, physical display scanout, and native
  mobile image rendering. Do not relabel it input-to-photon or visible-frame latency.
  Video markers are read after the production decoder draws each frame, then matched to the
  original media packet's arrival by its timestamp. `changeToDecoded` records the separate
  source-to-decoder-callback timing, including canvas drawing but not physical display scanout.
- Superseded changes count when a newer marker arrives. Changes never represented are reported
  as `missed`, not silently discarded. Empty latency samples are null, not zero. The final three
  seconds of changes are censored to give baseline polling time to deliver.
- Input measurements include real RPC input dispatch and the subsequent received marker. First
  picture measurements include connection/subscription startup. No-frame runs fail explicitly.
- Bytes come from the receiver TCP socket after message compression, including WebSocket framing.
  They exclude TLS, TCP/IP headers and retransmissions. Static idle retains initial setup costs
  separately from steady-state bytes.
- Phone/desktop describe requested sizes. The receiver is Node, not Safari or React Native.
  This applies to image modes. `new-video` records `viewerStats.engine` as WebKit or Electron;
  desktop WebKit is not a physical iPhone. Its source can capture more native pixels than CDP JPEG.
  `pictureSizes` and the retained marker samples record actual decoded dimensions; requested
  limits do not prove that the source or browser supplied that many pixels.
  The slow-link proxy uses 1.5 Mbit/s, 40 ms each way, and a bounded queue; it does not reproduce a
  real cellular radio or tunnel. Each run has one receiver connection.
  Video has separate RPC and media sockets; both pass through a transparent TCP meter, while
  benchmark assets use an unshaped port. The same slow-link proxy sits upstream for slow samples.
- `hostCounters` reports capture, encoder, and published-picture counts, not CPU utilization.
  There is no legibility score: a bandwidth gain alone does not establish equal visual quality.
  Inspect real-client text, scrolling, video, and recovery before accepting a release.
  `new-video --images` saves one complete decoded PNG per scene after timing, without running
  the image-mode recompression diagnostic. `hostCounters.video` and `viewerStats` retain codec,
  dimensions, frame counts and decoder errors for interpreting these samples.
  `hostCounters.video.source` records the native source's CSS viewport, density, requested
  capture dimensions, and WebContents identity. It never stores the requester-bound source ID.

For an integrated pass through the ordinary development app's Preview panel, use the
[real-server fixture adapter](./INTEGRATION.md). That pass complements these transport samples
with the actual `RemoteBrowserFrame` lifecycle, input, metadata, and JPEG fallback behavior.

Focused non-browser checks:

```sh
pnpm exec vp test run scripts/remote-preview-bench/stats.test.ts
pnpm exec tsgo --noEmit -p scripts/remote-preview-bench/tsconfig.json
node scripts/remote-preview-bench/run.ts --build-only --out /tmp/preview-bench-build
```
