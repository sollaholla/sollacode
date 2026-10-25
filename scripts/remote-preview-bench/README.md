# Remote preview streaming comparison

From the repository root:

```sh
node scripts/remote-preview-bench/run.ts --out /tmp/preview-bench
```

This launches an isolated Electron process and loopback RPC server. It never opens the live app's
database or tabs. Obtain any browser-launch permission required by the workspace before running.
`--build-only` compiles the encoder page without starting Electron or a server.

Use `--quick` for an eight-second smoke comparison, then longer repeated runs before drawing
performance conclusions. Options include `--modes old,new,new-native`, `--scenes idle,ticks,caret,spinner,typing,scroll,video`,
`--seconds 20`, `--clicks 15`, `--first-frames 8`, and `--no-slow-link`.
The script writes `results.json`, a generated report, raw timestamp/marker samples, and the host log
to the output directory. Keep each repeated run in its own output directory.

The baseline uses the production snapshot broker, capture/input dispatch, and unchanged-picture
suppression. Its desktop snapshot adapter reproduces the JPEG/size/page-read operations without
the app's foreground leasing and staging, so baseline capture can be faster than the app.
New mode imports the production stream relay, demand wrapper, screencast pacer, latest-frame
streamer, tile encoder, request sizing, and viewer feed planner. The encoder runs in a separate
Electron renderer through an IPC adapter instead of the app's worker. `new-native` requests keyframes only, like the native Image consumer, without claiming native rendering proof. Both use actual RPC framing
and sockets. The source is a scripted webview, not a user's page.

## Evidence boundaries

- Latency is **source marker change to network receipt**, with pixels decoded offline to determine
  which marker arrived. It excludes viewer decoding, painting, physical display scanout, and native
  mobile image rendering. Do not relabel it input-to-photon or visible-frame latency.
- Superseded changes count when a newer marker arrives. Changes never represented are reported
  as `missed`, not silently discarded. Empty latency samples are null, not zero. The final three
  seconds of changes are censored to give baseline polling time to deliver.
- Input measurements include real RPC input dispatch and the subsequent received marker. First
  picture measurements include connection/subscription startup. No-frame runs fail explicitly.
- Bytes come from the receiver TCP socket after message compression, including WebSocket framing.
  They exclude TLS, TCP/IP headers and retransmissions. Static idle retains initial setup costs
  separately from steady-state bytes.
- Phone/desktop describe requested sizes. The receiver is Node, not Safari or React Native.
  The slow-link proxy uses 1.5 Mbit/s, 40 ms each way, and a bounded queue; it does not reproduce a
  real cellular radio or tunnel. Each run has one receiver connection.
- `hostCounters` reports capture, encoder, and published-picture counts, not CPU utilization.
  There is no legibility score: a bandwidth gain alone does not establish equal visual quality.
  Inspect real-client text, scrolling, video, and recovery before accepting a release.

Focused non-browser checks:

```sh
pnpm exec vp test run scripts/remote-preview-bench/stats.test.ts
pnpm exec tsgo --noEmit -p scripts/remote-preview-bench/tsconfig.json
node scripts/remote-preview-bench/run.ts --build-only --out /tmp/preview-bench-build
```
