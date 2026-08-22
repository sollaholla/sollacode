# Brand icons

The three Icon Composer projects are the source of truth for full application icons:

- `dev/app-icon.icon`
- `nightly/app-icon.icon`
- `prod/app-icon.icon`

Each project uses the textless `solla-code-workflow.png` asset slot for the metallic-gold,
low-poly lightning S. The filename is retained so existing Icon Composer projects and release
automation keep the same stable asset reference. The shared 1024px artwork comes from
`source/solla-code-gold-s-master.png`.

Run `vp run icons:export` from the repository root to regenerate the tracked iOS, Linux, Windows, and web assets. The development web exports are also copied to `apps/web/public` for the browser favicon and splash screen. Run `vp run icons:check` to verify that the generated assets and public copies match their sources without changing files.

Exporting requires Icon Composer on macOS. The script selects the newest exporter from Xcode or a
standalone Icon Composer installation. Icon Composer 2 or newer is pinned to design generation 26;
older exporters use their native design generation. Set `ICON_COMPOSER_TOOL` to the full path of
`Icon Composer.app/Contents/Executables/ictool` to override automatic discovery.

## macOS exports

The approved macOS icon is the standalone transparent gold S rather than an Icon Composer tile.
`icons:export` copies `source/solla-code-gold-s-master.png` into the three channel-specific macOS
paths so later exports cannot restore the previous mark:

- `dev/app-icon.icon` -> `dev/blueprint-macos-1024.png`
- `nightly/app-icon.icon` -> `nightly/nightly-macos-1024.png`
- `prod/app-icon.icon` -> `prod/black-macos-1024.png`

The shared file is 1024×1024 RGBA, with the visible S constrained to an 824×824 safe area and no
background tile, glow, or shadow.

Do not edit the generated PNG or ICO files directly.
