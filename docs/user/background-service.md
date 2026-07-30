# Running Solla Code in the Background

On a Linux host, Solla Code can run as a background service for your user. It starts when the machine
boots and keeps running after you log out.

## Manage the Service

Install it with the latest Solla Code release:

```sh
npx t3@latest service install
```

Check whether it is installed:

```sh
npx t3@latest service status
```

Update or repair it:

```sh
npx t3@latest service update
```

Stop it and remove it from startup:

```sh
npx t3@latest service uninstall
```

Updating restarts Solla Code briefly. Let active agent work and terminal commands finish first.

The background service currently requires Linux with systemd.
