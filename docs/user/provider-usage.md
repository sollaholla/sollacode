# Provider usage and resets

Enable the provider usage pill in **Settings > General** to see account-level quota information
above the composer. The same information appears on each provider in **Settings > Providers**.
On a mouse-and-keyboard desktop, hover opens the details popup and clicking away dismisses it;
it does not reopen when focus returns to the pill. Touch stays tap-to-toggle.
Refresh acts on the selected provider instance, so separate work and personal accounts keep their
own usage state.

Missing usage appears as an em dash (—) in the compact bar, including for Grok.
Usage details explain when a value is not reported.

The compact AGY chip defaults to Gemini usage. Selecting a Claude or GPT model on that AGY
instance switches its chip to the Claude and GPT pool; switching away returns it to Gemini.
Both pools remain visible in the details popup and Providers settings. A missing reading shows
as not reported rather than substituting the other pool's usage.

Codex readings are stabilized before display. Account-wide quota and model-specific quota buckets
remain separate, so selecting a model with an unused quota cannot replace the account's Weekly row
with 0%. Usage within one reset cycle cannot move backward from a single report: Solla Code accepts
a scheduled reset immediately after the previous boundary passes, and accepts an earlier reset after
a second report confirms the same new boundary. A reset timestamp that keeps moving forward with the
clock is ignored. The freshness window includes scheduling headroom beyond battery-saver mode's
refresh cadence, so a healthy provider does not become stale between normal checks.

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

Claude may grant a bank of usage limit resets (the CLI's `/reset-limits`). Solla Code reads the
bank with the Claude CLI's stored sign-in and shows the next redeemable reset, with the number left,
under **Usage limit resets**. A reset that is marked **Usable once you reach a usage limit** is
refused by Claude until a limit is actually hit; trying before then does not spend it. Claude only lets
the next reset in the bank be used, so only that one is listed. Solla Code never refreshes the
Claude sign-in itself, and checks the bank at most every 10 minutes (15 minutes after Claude says it
is checking too often), so a newly granted reset can take a few minutes to appear. If Claude cannot
confirm whether a reset went through, the redemption shows as failed; trying again reuses the same
request, so it cannot spend a second reset.

Reset redemption is supported over local and remote connections. The server performs the native
provider request using the selected provider instance's credential home; reset credentials or
tokens never cross to the client.

## Deep Code account credit

Deep Code appears in the composer usage pill and **Settings > Providers** when its CLI is installed.
For a direct DeepSeek account, the server reads the official balance endpoint and displays remaining
USD/CNY credit, including granted and topped-up balances. These are credit amounts, not subscription
percentages: DeepSeek supplies neither a quota denominator nor a reset date. An insufficient-credit
response makes that account unavailable as an automatic fallback target while the report is fresh.

Open **Settings > Providers > Deep Code > API-key accounts**, choose **Add key**, and supply an
account name and API key. The default endpoint is DeepSeek. Save separate names such as Personal
and Work, then choose **Use this key**. **Switch account** in chat opens the same manager. You can
rename an account, replace its key, or remove it. Changing the endpoint requires supplying a new
key. Removing the selected account, or choosing **Use CLI credentials**, returns new work to the
CLI's configured credentials.

Named accounts belong to the selected provider instance on that environment. Their keys are saved
in the server's protected secret store; settings snapshots contain only names, endpoints, and a
masked suffix. Keys are never returned to the client. The selected key overrides CLI configuration
for new Deep Code turns, newly launched Deep Code terminal panes, and balance checks. Running turns
and existing terminal panes keep the key they started with.

When using CLI credentials, the check uses the instance's `~/.deepcode/settings.json` environment
and `DEEPCODE_API_KEY` / `DEEPCODE_BASE_URL` overrides, matching the CLI. The pill represents that
instance's base account; a project's `.deepcode/settings.json` can override it for that project.
Named-key management is available in the web and desktop clients, including mobile web; other
providers continue to use their native account sign-in flows.

Use **Refresh** after configuring credentials or topping up. Automatic checks follow the same
foreground/background policy as other providers. A failed check retains the last confirmed credit
and its original timestamp, visibly marked stale. Switching credentials clears the old account's
reading. Without credentials the display links the setup to Providers settings.

Deep Code Plus and custom API endpoints have separate billing. Their CLI support remains available,
but Solla labels account usage unsupported until those services provide a supported balance API.
It does not send their credentials to DeepSeek or invent a 100% reading.

## Muse progress and session spend

Muse's dollar meter reports estimated session spend from model prices and token counts. It does not report the account's remaining credit balance.

If Muse's live notifications stop arriving, Solla checks the same running host's recorded events after one minute of silence and restores missing tool activity, thoughts, and assistant text. Replayed events do not charge usage twice. A failed refresh appears as a warning. New Muse turns retain a display checkpoint for restart recovery; recovered message snapshots replace their earlier partial text.

Some saved Muse sessions cannot attach a live activity stream. Solla refreshes their recorded activity every five seconds through a separate read-only connection. This routine fallback runs silently; previously saved fallback notices are also hidden from the work log. Actual provider and delivery failures remain visible. This avoids stale views in the process that owns the saved session; it does not start another model or take over the work. A completion notification must wait for missing messages to be recovered, so the final report appears before the turn settles. Final delivery has a one-minute recovery budget. If it cannot be verified, Solla finishes any bounded read already in progress and shows an explicit delivery error with a manual retry; it does not silently show success.

Solla allows up to 15 minutes without model progress, or 30 minutes while a tool is open, before stopping the owned Muse runtime after a final recovery attempt. Repeated retry notices have a five-minute budget. Waiting for an approval does not count toward these limits. A stopped turn retains its error and requires a deliberate retry instead of automatically looping.

When a provider recovers the same message into another native turn, startup resume follows the latest attempt. Follow-ups already delivered into that attempt do not cancel its recovery; newer unhandled user messages still supersede it.

Account reveal confirmation stays inside the usage popup so opening a separate dialog cannot dismiss it before the address appears. Cancel keeps it hidden; select the revealed address again to hide it.

## OpenCode session cost

The OpenCode chip shows **Cost**. Open it for the **Session cost** estimate that
OpenCode reports for the current thread. Free-model sessions can show **$0.00**
without signing in; positive costs below one cent show **$<0.01**. Missing usage
shows **—** in the chip and **not reported** in its details. Another thread's cost is never substituted.

The estimate is restored when a session resumes and updates automatically while
OpenCode runs. It is based on model pricing, so your provider's bill may differ.
OpenCode does not expose an account balance, quota percentage, or reset time through
its server API. Check your model provider for those details. In Settings, OpenCode
usage points you to the current thread's bar instead of offering an account refresh.

Available in web, desktop, and mobile web. The native mobile app does not yet have
a provider usage bar.
