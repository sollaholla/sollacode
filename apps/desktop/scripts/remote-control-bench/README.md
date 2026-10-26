# Remote control streaming comparison

From the repository root:

```sh
node apps/desktop/scripts/remote-control-bench/run.ts --out /tmp/control-bench --images
```

This starts isolated Electron and WebKit processes and loopback relay sockets. It uses a synthetic canvas screen with the production encoder/player modules and relay. It does not access the user's screen or live app state. `--build-only` compiles both pages without launching browsers or servers. Install the WebKit version matching `apps/desktop`'s `playwright-core` before a phone run; `BENCH_WEBKIT_EXECUTABLE` explicitly overrides it and should be recorded with results.

Options accept comma lists: `--pipelines legacy,media`, `--viewers phone,laptop`, `--conditions loopback,wifi,cellular`, `--scenes idle,caret,typing,scroll,video,input`. Defaults omit `caret`. Use `--seconds 12 --warmup 3 --repeats 3` for repeated comparisons. `--viewers laptop` does not require WebKit. Outputs contain per-run JSON with raw clock-corrected marker logs and summary statistics, plus optional reference/received PNGs.

`--viewers phone-mse` preserves WebKit's native MediaSource capability; `phone` explicitly disables
it to exercise image compatibility fallback. Each result records the actual viewer environment,
including MediaSource and VP8 support. The canvas baseline receives two bounded startup repaints
of the same marker so a static capture can emit its first recorder timeslice; neither repaint
adds a source update or changes the steady-state scene.

`--phone-width` sets the WebKit viewport width in CSS pixels (default 390, allowed 240–1024).
Use it for controlled size/alignment diagnostics; each result records `phoneViewportWidth`.

For a separate static-frame diagnostic, add `--native-quality --pipelines media --scenes idle`.
This saves `nativeEncoded.png` from the exact `VideoFrame` handed to `VideoEncoder.encode`,
plus `nativeDecoded.png` before display resizing. The metadata records coded and displayed
dimensions; the run fails if markers or image dimensions do not match. Compare these images
at their native size to separate encoding/decoding loss from the full display-size comparison.
Canvas readback and cross-browser color conversion still apply. The diagnostic retains one
frame clone and restores the encoder method immediately after capture; it closes the clone
on export or shutdown. Keep these diagnostic runs separate from performance measurements.

## What the measurements mean

- `latency`: source draw to the first viewer callback showing that marker **or a later one**. Every source change in the measurement window contributes a latency or `missedUpdates`. Dropped updates remain in the calculation through the newer picture that superseded them.
- `exactFrameLatency`: latency only for updates shown exactly. This is diagnostic; do not use it alone to rank pipelines because dropping frames can improve it artificially.
- `framesShown`, `supersededUpdates`, `missedUpdates`, and `displayedUpdatesPerSecond`: delivery and smoothness alongside latency. A lower byte rate from showing fewer updates is a tradeoff, not a free improvement.
- `outstandingUpdateAge`: sampled every 50 ms, zero while the viewer is current, otherwise time since the first unshown source change. `blackoutSamples` reports samples with no visible marker at all. This catches a frozen viewer even when it produces no new callbacks.
- `inputToViewer`: input send to the first callback showing its resulting marker or a later marker. `missedInputs` reports undelivered inputs.
- Bandwidth counts TCP payload bytes, including WebSocket framing and negotiated message compression. It excludes TLS, TCP/IP headers and retransmissions. The emulator applies each rate **per TCP connection**, not as an aggregate shared mobile link.
- Idle is static. Caret is a separate blinking-caret workload. Static idle has no update-latency samples; check its first visible marker in `rawTiming` and blackout samples.
- Image quality uses luma PSNR at the viewer's displayed device-pixel size for idle/typing scenes. One frame is frozen, then the score and optional PNGs use the same resampled pixels. `legibility` records its marker, decoded dimensions, displayed dimensions, and excluded marker-strip rows, so the PNGs can reproduce the score. This comparison includes encoder resizing and viewer resampling; different browser scalers can affect it. Inspect saved images as well; PSNR is not a text-readability guarantee.

The last second of source changes is censored to allow delivery. Earlier changes still absent at the measurement end are counted as missed, not assigned a fabricated latency. Raw timestamps allow recomputing this window. Runs with missed updates/inputs, blackouts, decoder errors, or missing quality samples must be examined before claiming improvement.

Viewer timing is a software callback after rendering/decoding (requestAnimationFrame for canvas/image and requestVideoFrameCallback for video). It is not physical glass-to-glass or input-to-photon latency. The legacy JPEG benchmark scales and encodes a canvas, avoiding native desktop capture cost; native desktop capture and screen-recording permissions are not exercised. Phone means desktop WebKit with a phone viewport and an explicit no-MediaSource capability simulation; it does not establish behavior on physical iPhone Safari or React Native. Loopback with emulated delay/bandwidth does not prove a real relay/tunnel connection.

`--encode-scale` (1–2, default 1) is a diagnostic override: it requests additional encoded pixels without changing the displayed picture. Results record `requestedEncodeScale`; use the default for production-path performance claims.

Focused checks without launching a browser:

```sh
vp test run apps/desktop/scripts/remote-control-bench
node_modules/.bin/tsgo --noEmit -p apps/desktop/scripts/remote-control-bench/tsconfig.json
node apps/desktop/scripts/remote-control-bench/run.ts --build-only --out /tmp/control-bench-build
```
