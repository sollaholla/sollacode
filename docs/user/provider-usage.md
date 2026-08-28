# Provider usage and resets

Enable the provider usage pill in **Settings > General** to see account-level quota information
above the composer. The same information appears on each provider in **Settings > Providers**.
On a mouse-and-keyboard desktop, hover opens the details popup and clicking away dismisses it;
it does not reopen when focus returns to the pill. Touch stays tap-to-toggle.
Refresh acts on the selected provider instance, so separate work and personal accounts keep their
own usage state.

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
