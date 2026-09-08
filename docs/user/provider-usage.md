# Provider usage and resets

Enable the provider usage pill in **Settings > General** to see account-level quota information
above the composer. The same information appears on each provider in **Settings > Providers**.
On a mouse-and-keyboard desktop, hover opens the details popup and clicking away dismisses it;
it does not reopen when focus returns to the pill. Touch stays tap-to-toggle.
Refresh acts on the selected provider instance, so separate work and personal accounts keep their
own usage state.

Codex readings are stabilized before display. Usage within one reset cycle cannot move backward
from a single report: Solla Code accepts the lower value immediately when the reset timestamp proves
a new cycle, or after a second consistent lower report when reset metadata is incomplete. This keeps
transient 0% responses from replacing real usage while still showing a genuine scheduled or
out-of-band reset promptly. The freshness window includes scheduling headroom beyond battery-saver
mode's refresh cadence, so a healthy provider does not become stale between normal checks.

If an authenticated provider check briefly fails with a network, socket, or server error, Solla Code
keeps the last confirmed account and usage for up to two minutes and retries every 30 seconds. This
reconnect state stays out of the disruptive chat banner. A sustained outage becomes unavailable
after the grace period, while an explicit logout is shown immediately.

Codex and Grok report their scheduled quota reset time. Codex may also grant one or more earned
usage limit resets. When an earned reset is available, Solla Code shows its title and expiration
under **Usage limit resets**. Choose **Use reset**, then confirm, to redeem it for that exact Codex
account. Solla Code refreshes the provider snapshot after Codex reports the result.

An earned reset is not spent when Codex reports that there is nothing to reset. Grok's current
terminal protocol reports the next scheduled rollover but does not expose an earned-reset consume
command, so Grok reset times are informational rather than actionable.
Use **View Grok usage and resets** to open Grok's web usage page, where reset availability that the
CLI does not expose can be reviewed.

Reset redemption is supported over local and remote connections. The server performs the native
provider request using the selected provider instance's credential home; reset credentials or
tokens never cross to the client.
