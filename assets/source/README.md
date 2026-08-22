# Solla Code icon source

`solla-code-gold-s-master.png` is the current 1024×1024 RGBA source shared by the development,
preview, and production icon pipelines. It contains only the metallic-gold, low-poly lightning S
on a transparent canvas. The visible mark is centered within an 824×824 macOS safe area.

The source was created with Codex's built-in image-generation workflow in two focused edits:

```text
Use case: precise-object-edit and background-extraction
Asset type: standalone Solla Code application mark
Primary request: remove the red C, preserve the existing metallic-gold low-poly lightning S, and
restore only the S facets previously hidden by the C using the earlier unobstructed geometry
reference
Composition: one centered angular S with its existing orientation, proportions, sharp tips, and
faceted gold highlights
Background: genuine alpha transparency
Constraints: no C, no red, no text, no tile, no checkerboard, no glow, no shadow, no halo, and no
redesign of the S
```

The generated alpha was cleaned, the visible S was fitted to the safe area, and the result was
normalized to an 8-bit 1024×1024 PNG before being copied into each Icon Composer project.
Platform-specific files are regenerated with `vp run icons:export`.

`solla-code-workflow-master.png` is the retained legacy source for the previous workflow-orbit
icon and is no longer used by the active export pipeline.
