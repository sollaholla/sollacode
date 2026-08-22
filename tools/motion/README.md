# Solla motion

A small deterministic frame renderer for the README media in
`docs/media/readme/`. Compositions are ordinary React components; each is
rendered once per frame with an explicit frame number, screenshotted in headless
Chromium, and encoded to GIF with ffmpeg.

## Why not Remotion

This started on Remotion and was rewritten off it. Remotion is source-available,
not open source: free for individuals, non-profits, and for-profit organizations
with up to three employees, and a paid Company License above that.

Solla Code is MIT and public. A README GIF is not worth pushing a licensing
question onto everyone who clones the repository, so `src/motion` reimplements
the small slice these compositions actually used — `useCurrentFrame`,
`useVideoConfig`, `interpolate`, and `spring` — over MIT dependencies
(`esbuild`, `playwright-core`, React).

`tools/` is deliberately outside the `packages:` globs in
`pnpm-workspace.yaml`, so nothing here is installed, typechecked, or tested by
the root scripts. Rendering is opt-in.

## Rendering

```bash
cd tools/motion
pnpm install --ignore-workspace
pnpm render
```

Requires `ffmpeg` on PATH and a Chromium-family browser. Browser resolution
follows the same policy as the app's own browser VM provider: Playwright's
managed Chromium if installed, then a system Chrome/Chromium/Edge.

## How it works

1. **esbuild** bundles the compositions into one self-contained HTML page, with
   fonts inlined as data URLs so no asset loads late and reflows a clip.
2. **Chromium** loads it and drives `window.__motion.setFrame(n)`, which renders
   through `flushSync` so the commit lands before the screenshot.
3. **ffmpeg** encodes the PNG sequence in two passes: `palettegen` with
   `stats_mode=diff`, then `paletteuse` with `diff_mode=rectangle`. Almost every
   pixel is static chrome, so only changed rectangles need palette entries.

Nothing is time-driven and no CSS transitions are used, so frame N is a pure
function of N and renders are reproducible.

### Two things worth knowing

**No entrance animations on the window.** A GIF loops, so a frame-0 fade from
`opacity: 0` renders one fully black frame that flashes on every loop. It also
changes every pixel for the length of the fade, which defeats the frame-diff
palette and roughly tripled file size. Reveal individual elements instead.

**`spring` substeps.** Explicit Euler on a damped spring diverges once the
timestep exceeds `2*mass/damping`. These configs use `damping: 200` at 30fps —
`dt = 0.0333` against a limit of `0.01` — which does not merely lose accuracy, it
explodes: entrance springs returned ~1e112 instead of a value in `[0, 1]`, so
elements never appeared and clips flickered violently. The integrator derives its
substep count from that stability condition.

## What these are, and are not

**Reconstructions built for documentation**, not screen recordings and not the
shipped components. Nothing here imports from `apps/web`.

They are built to be accurate rather than aspirational. Geometry was measured off
a running client (255px sidebar, 36px thread rows at an 8px radius with 10px left
padding, 32px orchestrator row), and `src/theme/tokens.css` carries the web
client's own dark-theme token values — `oklch()` and `color-mix()` included,
since Chromium resolves them exactly as the app does.

Every state shown is one the product actually produces. If a scene starts
claiming something the app does not do, fix the scene.

Keep `src/theme/tokens.css` in sync with the dark block of
`apps/web/src/index.css` when the palette changes.

## Compositions

Every composition shows something **this fork adds on top of T3 Code**. Projects,
threads, and a chat surface are base T3 behaviour and belong in T3's README, not
this one.

| Composition           | Capability                                                          |
| --------------------- | ------------------------------------------------------------------- |
| `voice-orchestrator`  | Workspace-level voice agent that inspects, creates, and routes work |
| `custom-agents`       | Named agents and bounded delegation with scoped questions           |
| `terminal-workspaces` | Named layouts with retained PTYs across navigation and relaunch     |
| `thread-artifacts`    | Revisioned artifacts reachable over local, LAN, and Tailscale       |
| `provider-failover`   | Typed usage-limit events that resume a queued turn elsewhere        |

The hero still is the final frame of the first composition.
