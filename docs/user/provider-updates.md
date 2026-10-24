# Provider updates

Use **Settings > Providers > Update** to update a provider CLI on its environment's
host. The same host operation runs when updating from the provider update notification.
Updates that use the same package manager wait for one another.

If an update request is interrupted while waiting, running, or verifying the result,
its status changes to **Update interrupted. Try again.** You can retry from Settings.
An interrupted install behaves the same way. Interrupting a waiting update does not
stop another provider's update that is already running.

This behavior applies to OpenCode and the other providers with one-click maintenance,
including when using Solla Code remotely. A completed update is still checked against
the detected CLI version before Solla reports success.
