# Solla motion

The Solla product film and README GIFs combine **recordings of the production
client** with original typography, cursor motion, the owner's gold S geometry,
and an original electronic score. The earlier React interface reconstructions
have been removed. The app screens in these assets are not reimplemented UI.

`tools/motion` is an optional, standalone package outside the main workspace.
It does not add rendering dependencies to the application.

## Render the checked-in recordings

Install Node.js with TypeScript stripping support, FFmpeg, and Chromium. From this
folder:

```sh
pnpm install --ignore-workspace
pnpm typecheck
pnpm render
pnpm render:gifs
```

Set `SOLLA_CHROMIUM` to an explicit Chromium executable for captures and GIFs if
Playwright's managed Chromium or system Chrome is unavailable. The film also
checks system Chrome and Chromium on macOS.

The film is 72 seconds, 1920 × 1080, 30 fps, H.264/AAC. Its nine chapters show the
brand, threads, provider choice, split terminals, artifacts, custom agents, voice,
the workspace, and pricing. It writes the movie, poster, and English captions to
`apps/marketing/public/media/`. The five GIFs go to `docs/media/readme/`.

For selected previews and clips:

```sh
pnpm render --preview --scene=artifacts
pnpm render:gifs --scene=agents,terminals
```

Film preview frames, intermediate videos, and source-digest manifests live in
`out/`, which is ignored by Git. A full render assembles all nine chapters. Inspect
previews before replacing finished assets.

## What each recording establishes

| Recording   | Observed behavior                                                                                | Limits                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `threads`   | Navigation among distinct Lumen, Fieldnotes, and Orbit API conversations                         | Conversation content is illustrative                                                            |
| `providers` | The actual model picker, including Claude and Antigravity                                        | Browsing a model does not establish a successful provider turn                                  |
| `terminals` | Two real shell panes, source inspection, five passing Node tests                                 | The commands run against a small demonstration project                                          |
| `artifact`  | Revision two of a dashboard, maximize and restore                                                | Local authorized rendering; the clip does not demonstrate a remote device                       |
| `agents`    | Code Reviewer conversation, tools menu, and working instructions                                 | It does not depict a completed delegated task                                                   |
| `voice`     | Actual transcription, a live xAI response identifying the projects, and a successful Stop check  | Input comes from eSpeak NG formant synthesis; provider speech is excluded from the film's audio |
| `failover`  | Actual quota-event ingestion, account handoff banner, and continuation on a second Grok instance | Both providers use the ACP fixture; the quota condition and responses are controlled            |

The complete website film was played through its production build in Chromium:
72 seconds, all nine caption cues, and no failed asset requests or playback errors.
The soundtrack has a 48 kHz stereo master and measured peak headroom. Technical
audio checks are not a claim of subjective listening approval.

## Capture a new production workspace

Use the repository's `test-t3-app` workflow to prepare a **disposable** home and a
production web build. Never point a demonstration server or fixture writer at
`~/.solla-code` or `~/.t3`. Keep credentials outside this repository.

The supplied script follows a particular demonstration workspace. It expects:

- A Lumen project with “Build a faster project search”, “Refine the dashboard
  layout”, and “Review keyboard navigation” threads.
- A Fieldnotes thread named “Design a calmer reading view”, plus distinct Orbit
  API and other project threads.
- Code Reviewer and Studio agents. Code Reviewer has saved working instructions.
- A Lumen dashboard artifact at revision two. The illustrative HTML source is in
  `demo/lumen-dashboard.html`.
- `src/search.mjs` and `src/search.test.mjs` in Lumen, with five Node tests.
- `showcase.json` in the disposable home, containing `threadIds`: the search
  thread ID first and dashboard thread ID second. Use IDs from your own fixture.

From the repository root, build and run the production client against that home:

```sh
./node_modules/.bin/vp run --filter @t3tools/web build
NODE_ENV=production node apps/server/src/bin.ts \
  --base-dir /absolute/path/to/disposable-demo \
  --port 13773 --host 127.0.0.1 --no-browser /absolute/path/to/demo-project
```

In another terminal:

```sh
export SOLLA_DEMO_HOME=/absolute/path/to/disposable-demo
export SOLLA_DEMO_ORIGIN=http://127.0.0.1:13773
node tools/motion/src/film/captureApp.ts
node tools/motion/src/film/captureApp.ts --scene=artifact
node tools/motion/src/film/captureApp.ts --scene=terminals
```

The script creates and consumes a one-time pairing link through the supported
`auth pairing create` CLI. It discovers the environment ID from the server,
records lossless Chromium compositor frames, and logs actual pointer-event
coordinates and timestamps. Frame timestamps determine pacing; scripted holds
only provide time to read each shot. A failed recording does not replace an
existing source capture.

`captures/*-source.json` records dimensions, duration, actions, and client errors.
The renderers overlay cursor motion at those action times. They do not replace
screen contents or simulate app state. Capture diagnostics go to the ignored
`output/playwright/` directory.

The failover recording requires two disposable Grok instances named “Grok
primary” and “Grok backup” running `apps/server/scripts/acp-mock-agent.ts` through
a wrapper that answers `--version`. Set `T3_ACP_BILLING_EXHAUST_AFTER_PROMPT=1` only
on the primary and give its billing period a future `T3_ACP_BILLING_PERIOD_END`.
Use separate `T3_ACP_PROMPT_RESPONSE_TEXT` values and disable other providers in
that disposable home so the fallback is deterministic. Restore its settings
afterward. The fixture flag does not change a real provider's billing state.

Voice capture additionally requires a configured voice provider and an explicit
microphone WAV:

```sh
espeak-ng -s 145 -w /tmp/solla-demo-microphone.wav \
  'Which projects are in this workspace? Keep it to one sentence.'
SOLLA_DEMO_MICROPHONE=/tmp/solla-demo-microphone.wav \
  node tools/motion/src/film/captureVoice.ts
```

It waits for real transcription and response text, then verifies Stop closes the
voice session. Trim the resulting recording to the intended shot and update
`voice-source.json` with the source offset and observed result.

## Original graphics and music

`apps/marketing/src/lib/boltRenderer.ts` renders the owner's exported Blender
mesh. Its front surface is mirrored across the depth axis to form the back, with
a joined boundary and matching materials. Lighting, Fresnel response, surface
grain, and glints are mathematical; there are no image textures or ML artwork.
`apps/marketing/public/brand/provenance.json` identifies the source object and
file digest. The source Blender file is not overwritten.

To export from the original model again, supply its path explicitly:

```sh
SOLLA_BRAND_SOURCE=/path/to/SollaCode_LowPoly_S.blend \
  blender --background --python tools/motion/scripts/export_brand.py
```

Regenerate the 120 BPM score from oscillators and seeded noise with Python and
NumPy:

```sh
python3 tools/motion/scripts/compose_score.py
```

No loops, samples, or generated model audio are used in the score. The master is
normalized during film assembly. DM Sans is self-hosted with its Open Font
License beside the font.

The workflow uses Blender, FFmpeg, Chromium, esbuild, Playwright, and NumPy, not
Remotion. Commercial use of these tools is permitted; retain their license
obligations if distributing the tools themselves. Solla's source attribution and
launch boundaries are documented in [commercial launch](../../docs/project/commercial-launch.md).
