# Quick start with Solla Code

Solla Code is a fork of T3 Code. Use [this fork's releases](https://github.com/sollaholla/sollacode/releases) for packaged desktop builds, or build this checkout. The upstream npm package `t3` does not distribute Solla Code.

## Install a packaged build

Download the file for your platform from [the latest release](https://github.com/sollaholla/sollacode/releases/latest). These builds are not signed with a paid Apple or Microsoft certificate, so your system warns you the first time you open one.

- **macOS:** drag Solla Code to Applications and open it. When macOS says it could not verify the app, open **System Settings → Privacy & Security**, scroll down, and choose **Open Anyway**. Pick the `arm64` file for Apple Silicon and `x64` for Intel.
- **Windows:** run the `.exe`. If SmartScreen appears, choose **More info**, then **Run anyway**.
- **Linux:** make the AppImage executable with `chmod +x Solla-Code-*.AppImage`, then run it.

Installed apps do not update themselves from GitHub. To update, download the newer release and install it the same way.

## Run from source

Use the Node.js version in the root `package.json` (`^24.13.1`) and the Vite+ `vp` command. The repository pins pnpm in `packageManager`; `vp i` installs the workspace dependencies.

```sh
git clone https://github.com/sollaholla/sollacode.git
cd sollacode
vp i
vp run dev
```

Open the complete one-time `pairingUrl` printed by the runner. Use the reported ports; occupied ports can shift them. If `vp` is unavailable after installation, invoke `./node_modules/.bin/vp` from the repository root.

A new environment opens [first-run setup](../user/first-run-setup.md), where you choose providers and sign in to them. You can also authenticate a provider's CLI on the server machine yourself. See [Providers](../providers/README.md).

## Desktop and remote development

```sh
vp run dev:desktop

# Give a separate dev instance its own state and port selection.
T3CODE_DEV_INSTANCE=feature-xyz vp run dev:desktop --home-dir /tmp/solla-feature-xyz

# Share the development web client over the machine's tailnet.
vp run dev --share
```

Port isolation alone does not isolate state. Linked Git worktrees default to their own `.t3` directory; the main checkout normally uses `~/.t3/dev`. An explicit `--home-dir` stores runtime state under that directory's `userdata`. Never point a development server at the installed app's live `~/.solla-code/userdata`.

Do not set `VITE_HTTP_URL` or `VITE_WS_URL`: Vite proxies the backend on the same origin, including remote connections. See [Remote access](../user/remote-access.md).

## Build and run

```sh
vp run build
vp run start

# Package a local macOS installer; this does not publish a release.
vp run dist:desktop:dmg
```

The production source command starts the built server from this checkout. For explicit server options, use `node apps/server/dist/bin.mjs --help` after building. See [Scripts](../reference/scripts.md) and [Release operations](../operations/release.md) for other targets.
