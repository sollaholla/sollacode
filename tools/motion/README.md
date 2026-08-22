# Solla motion

Remotion compositions that reconstruct the Solla Code interface for the README
media in `docs/media/readme/`.

## Why this lives outside the pnpm workspace

Remotion is **not** open source. It is source-available under the
[Remotion License](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md):
free for individuals, non-profits, and for-profit organizations with up to three
employees, and a paid Company License above that.

Solla Code is MIT. If Remotion were a workspace package, every `pnpm install` and
every CI run in this repository would pull it in, pushing that licensing question
onto contributors and downstream users who never asked to render a video.

So `tools/` is deliberately not matched by the `packages:` globs in
`pnpm-workspace.yaml`. Nothing here is installed, typechecked, linted, or tested
by the root scripts. Only someone who deliberately renders media installs
Remotion, and only they need to satisfy its terms.

The committed GIFs and PNG are rendered output, not Remotion source, so they
carry no such condition.

## Rendering

```bash
cd tools/motion
pnpm install --ignore-workspace
pnpm render
```

`scripts/render.sh` writes to `docs/media/readme/`. It needs `ffmpeg` on PATH.

Two stages, on purpose: Remotion's GIF encoder produced ~50 MB files for these
clips, so the script renders a near-lossless H.264 intermediate and converts it
with ffmpeg's two-pass palettegen. `stats_mode=diff` plus `diff_mode=rectangle`
is what does the work — almost every pixel is static chrome, so only changed
rectangles need palette entries. Same clips land under 500 KB.

To iterate on a composition:

```bash
pnpm studio
```

## What these are, and are not

These are **reconstructions built for documentation**, not screen recordings and
not the shipped components. Nothing here imports from `apps/web`.

They are built to be accurate rather than aspirational. Geometry was measured off
a running client (255px sidebar, 36px thread rows at an 8px radius with 10px left
padding, 12px/500 section headers, 32px orchestrator row), and
`src/theme/tokens.css` carries the web client's own dark-theme token values —
`oklch()` and `color-mix()` included, since Remotion renders through headless
Chromium and resolves them exactly as the browser does.

Every state shown is one the product actually produces. If a scene here starts
claiming something the app does not do, fix the scene.

Keep `src/theme/tokens.css` in sync with the dark block of
`apps/web/src/index.css` when the palette changes.

## Compositions

| Composition            | Shows                                                            |
| ---------------------- | ---------------------------------------------------------------- |
| `workspace-tour`       | Sidebar sections, thread list, and a streaming turn              |
| `terminal-workspaces`  | A named four-pane terminal layout with retained sessions         |
| `agents-collaboration` | Delegating to a named agent and the bounded question/answer flow |
