# Keeping Solla Code in Sync

The Solla Code web or desktop app and the server it connects to work best when they use the same
version. If they do not match, Solla Code shows a warning with the right update option for that server.

## Distribution boundary

Packaged Solla desktop updates come from this fork's release artifacts. A server built from this repository must be rebuilt from the corresponding Solla source revision. The inherited npm self-update and copied `npx t3@<version>` commands target upstream T3 Code, not Solla Code. Do not use those commands to update a Solla source server. See [Fork identity](../reference/fork-identity.md).

The action table below describes the inherited capability UI; availability alone does not establish that a matching Solla package is published.

## Where to Find the Update

You may see the warning in either of these places:

- above the message box in the current conversation
- **Settings** → **Connections**, beside the affected connection

Dismissing the conversation warning only hides that reminder for those two versions. It does not
update the server, and the version difference remains visible in Connections.

## Before You Update

Let active agent work and terminal commands finish first. Updating restarts the server, so the
connection will disappear briefly and work that is still running may be interrupted.

The update does not remove saved threads, settings, or project files.

## Choose the Action You See

| Action                            | What to do                                                                                                                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Update server**                 | Select the button and leave Solla Code open. It prepares the matching version, restarts the server, and reconnects automatically. This can take several minutes.                             |
| **Update the desktop app**        | Open the Solla Code desktop app on the machine that runs the server and install the app update there. The installer relaunches that same app bundle; you should not have to open it by hand. |
| **Install or rebuild Solla Code** | Install the matching fork release, or rebuild the remote server from the corresponding Solla source revision. Preserve its existing startup options and state directory.                     |

The available action depends on how that server was started. Solla Code does not update connected
servers silently in the background.

## Updating the Desktop App Through an Agent

Agents running inside Solla Code Desktop can use the built-in `app_update` MCP tool with an
absolute installer path on the same machine. Solla Code verifies the artifact before presenting a
Yes/No confirmation. Choosing Yes schedules a guarded installer that closes the app, installs the
verified artifact, and relaunches **that installed app path** with `--auto-resume` so interrupted
agent work can continue. It does not look the app up by bundle id or by a PID from before the
swap - those change across the install and would restart the wrong process.

- macOS accepts a Solla Code `.app`, `.dmg`, or `.zip` containing the app.
- Windows accepts a Solla Code NSIS `.exe` installer.
- `force: true` skips the confirmation. It is intended only when the user has already explicitly
  authorized that exact artifact and restart.

The tool is available only from a desktop-managed server on macOS or Windows. Verification or
installer-launch failures leave the running installation unchanged. Installation diagnostics are
written to `desktop-app-update.log` in the server logs directory.

For source-hosted servers, build the matching Solla revision on the host and restart the same launch command with the same state directory and connection options. The inherited systemd installer currently fetches upstream packages; see [Background services](./background-service.md).

## After the Update

Keep the web or desktop app open while the server restarts. When it reconnects with the matching
version, the warning and update action disappear.

If a route change (for example, switching a thread from chat to terminal mode) reaches an old cached
module after an update, Solla Code retries that route once with a fresh app-shell URL. The retry
keeps the same route and runs only once for that app version and path during the recovery window. If
the module still cannot load, the error screen remains available with **Reload app** instead of
reloading in a loop.

If the client reports a timeout, the server may still be finishing the update. Wait a minute, then
reconnect or open **Settings** → **Connections** again. If the warning remains:

1. Retry the offered action once.
2. Make sure you updated the machine named in the warning, not only the device you are using.
3. For a source-hosted Solla server, build the matching fork revision and restart its built entrypoint. Do not substitute an upstream npm package with a similar version number.

For remote connection setup and access troubleshooting, see [Remote Access](./remote-access.md).
