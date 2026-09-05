# Background services

The inherited CLI has Linux/systemd user-service commands, but its pinned-runtime installer fetches the upstream npm package `t3`. Running `npx t3@latest service install` installs upstream T3 Code, not this fork.

For Solla Code, run a built checkout on the host or use the packaged desktop app. See [Quick start](../getting-started/quick-start.md). Keep that host running for remote clients to remain connected.

The inherited service commands (`service install`, `status`, `update`, and `uninstall`) are not a supported Solla installation route until the fork has an owned npm distribution and the pinned-runtime installer targets it. Even invoking `service install` from this source tree currently downloads `t3`; changing only the command prefix does not fix that.

The service implementation and self-update behavior are documented in [Server update architecture](../architecture/server-updates.md). See [Fork identity](../reference/fork-identity.md) for the distinction between source, desktop, and npm distributions.
