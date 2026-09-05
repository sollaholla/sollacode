# Quick start with Solla Code

Solla Code is a fork of T3 Code. Use [this fork's releases](https://github.com/sollaholla/sollacode/releases) for packaged desktop builds, or build this checkout. The upstream npm package `t3` does not distribute Solla Code.

## Run from source

Use the Node.js version in the root `package.json` (`^24.13.1`) and the Vite+ `vp` command. The repository pins pnpm in `packageManager`; `vp i` installs the workspace dependencies.

```sh
git clone https://github.com/sollaholla/sollacode.git
cd sollacode
vp i
vp run dev
```

Open the complete one-time `pairingUrl` printed by the runner. Use the reported ports; occupied ports can shift them. If `vp` is unavailable after installation, invoke `./node_modules/.bin/vp` from the repository root.

Authenticate your chosen provider on the server machine before starting a thread. See [Providers](../providers/README.md).

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
