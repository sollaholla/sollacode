# Scripts

- `vp run dev` - Starts contracts, server, and web in watch mode.
- `vp run dev --share` - Also publishes the web port over HTTPS on this machine's tailnet. The startup pairing URL is built against the shared origin, and the mapping is removed on exit.
- `vp run dev:server` - Starts just the WebSocket server. The server process runs on Bun (`@effect/platform-bun` + `BunPtyAdapter`), but task running uses `vp run`.
- `vp run dev:web` - Starts just the Vite dev server for the web app.
- Dev commands run from a linked **git worktree** default to that worktree's gitignored `.t3`, even when `T3CODE_HOME` is set, storing state in `<worktree>/.t3/userdata`. Pass `--home-dir <path>` to choose another isolated directory explicitly. Submodules are not worktrees and keep the normal precedence.
- From the **main checkout**, dev commands implicitly use `~/.t3/dev`, keeping development state separate from `~/.t3/userdata`. An explicit `--home-dir <path>` stores state under `<path>/userdata`; the base directory remains available for caches, worktrees, and other shared data.
- Web dev commands do not auto-open a browser. Open the one-time pairing URL printed by the server so the first browser navigation is authenticated. Set `T3CODE_NO_BROWSER=0` only when interactive auto-open is intentional.
- Pass dev-runner flags directly after the root task name, for example:
  `vp run dev --home-dir /tmp/t3code-dev`
- `vp run start` - Runs the production server (serves built web app as static files).
- `vp run build` - Builds contracts, web app, and server.
- `vp run typecheck` - Strict TypeScript checks for all packages.
- `vp run test` - Runs workspace tests.
- `node apps/server/scripts/t3-sqlite-state.ts <query|exec> --base-dir <path> ...` - Inspects or seeds an isolated T3 SQLite database; writes create a private backup first.
- `vp run dist:desktop:artifact -- --platform <mac|linux|win> --target <target> --arch <arch>` - Builds a desktop artifact for a specific platform/target/arch.
- `vp run dist:desktop:dmg` - Builds a shareable macOS `.dmg` into `./release`.
- `vp run dist:desktop:dmg:x64` - Builds an Intel macOS `.dmg`.
- `vp run dist:desktop:linux` - Builds a Linux AppImage into `./release`.
- `vp run dist:desktop:win` - Builds a Windows NSIS installer into `./release`.

### Build & Relaunch Release action

The checked-in **Build & Relaunch Release** project action performs an optional Windows release
before the local macOS release. It discovers online Windows peers from `tailscale status`, probes
them using non-interactive SSH key authentication, then builds the Windows x64 NSIS installer,
copies it over SSH, installs it, and relaunches one interactive-session `--auto-resume` process. The
Windows step must pass installed-version, listener, local HTTP, remote HTTP, and post-settle health
checks before its build can be reused by macOS. If the Windows release fails, the action reports the
failure, continues with a full macOS build and relaunch, then exits unsuccessfully so the Windows
problem remains visible. If no Windows SSH target is reachable, the action reports the skip and
continues with macOS.

For a machine that is not discoverable through Tailscale, set
`T3CODE_WINDOWS_SSH_TARGET=user@host`. Multiple comma-separated targets are tried in order;
`T3CODE_WINDOWS_SSH_USER` supplies a username when targets omit one. Set the target to `off` to
disable Windows discovery explicitly.

The Windows package always includes both the Windows x64 resource monitor and the Linux x64
`node-pty` payload required by WSL. By default the action uses the checked Windows resource-monitor
build and creates `pty.node` in an isolated Docker container. If Docker is not already available,
the action creates or reuses a dedicated `t3code-release-build` Colima profile without disturbing
the default profile, stops it when finished if the action started it, and retains its image cache to
avoid repeating the download. The verified `pty.node` is also cached below `release/.native-cache`.
`T3CODE_DESKTOP_RESOURCE_MONITOR_PREBUILD` and
`T3CODE_DESKTOP_WSL_PREBUILD` can point at already verified native payloads instead.

## Desktop `.dmg` packaging notes

- Default build is unsigned/not notarized for local sharing.
- The DMG build uses `assets/prod/black-macos-1024.png` as the production app icon source.
- Desktop production windows load the bundled UI from `t3code://app/index.html` (not a `127.0.0.1` document URL).

- Desktop packaging includes `apps/server/dist` (the `t3` backend) and starts it on loopback with an auth token for WebSocket/API traffic.
- Your tester can still open it on macOS by right-clicking the app and choosing **Open** on first launch.
- To keep staging files for debugging package contents, run: `vp run dist:desktop:dmg -- --keep-stage`
- To allow code-signing/notarization when configured in CI/secrets, add: `--signed`.
- Signed macOS builds also require `T3CODE_APPLE_TEAM_ID` and
  `T3CODE_MACOS_PROVISIONING_PROFILE`.
- Windows `--signed` uses Azure Trusted Signing and expects:
  `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
  `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, and `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`.
- Azure authentication env vars are also required (for example service principal with secret):
  `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.

## Building the Windows installer from macOS

`vp run dist:desktop:win` works on a macOS host and produces
`release/Solla-Code-<version>-x64.exe` (NSIS, unsigned). electron-builder's resource editing is pure
JS on macOS 10.15+, and NSIS uninstaller generation takes its own PE-parsing path there, so **wine is
not needed**. node-pty ships `win32-x64` and `win32-arm64` prebuilds, and `npmRebuild` is off for
Windows, so nothing native is compiled for the app itself.

Two things do not cross-compile, and both degrade rather than fail:

- **The resource monitor** is Rust built for `x86_64-pc-windows-msvc`, which needs the MSVC linker.
  Pass a binary built elsewhere instead of building it here:

  ```
  vp run dist:desktop:artifact -- --platform win --target nsis --arch x64     --resource-monitor-prebuild /path/to/t3-resource-monitor.exe
  ```

  Without it the build fails at the `cargo build` step. With it, the log says
  `Reusing resource-monitor prebuild`.

- **The WSL backend** needs a Linux `pty.node`, which only a Linux host can build. Omitting it is a
  warning, not an error - but the packaged WSL backend will not start. Pass `--wsl-prebuild <path>`
  with the artifact from CI's `build_wsl_node_pty` job to include it.

So a macOS cross-build is a valid smoke artifact and a valid installer for the ordinary Windows
backend. For a release, build on the Windows runner in `release.yml`, where MSVC, the WSL prebuild
handoff and Azure Trusted Signing are all already wired.

## Browser development

`dev` and `dev:web` leave `VITE_HTTP_URL` and `VITE_WS_URL` unset so the browser resolves the backend from `window.location.origin`. Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known` to the server, allowing the same bundle to work from localhost or a tailnet hostname.

Worktrees derive a preferred port offset from their path. The runner shifts both ports together when either is occupied or the web port is blocked by browsers, so treat the `[dev-runner]` output as authoritative.

## Running multiple dev instances

Set `T3CODE_DEV_INSTANCE` to any value to deterministically shift all dev ports together.

- Default ports: server `13773`, web `5733`
- Shifted ports: `base + offset` (offset is hashed from `T3CODE_DEV_INSTANCE`)
- Example: `T3CODE_DEV_INSTANCE=branch-a vp run dev:desktop`

If you want full control instead of hashing, set `T3CODE_PORT_OFFSET` to a numeric offset.
