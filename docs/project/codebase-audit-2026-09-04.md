# Codebase audit — 2026-09-04

This audit covers the fork's application structure, connection and cancellation paths, documentation, distribution identity, and confirmed unreferenced modules. It is a record of inspected behavior and source changes, not a certification that every execution path is defect-free.

## Corrected behavior

- Explicit Stop cancels current and already queued turn work. A queued user-delivery obligation can no longer immediately restart the chat after Stop.
- Stop also cancels live-steering deliveries awaiting native acknowledgement. Previously, a failed acknowledgement could move an apparently completed delivery back to pending after Stop and restart the chat. A regression reproduces this ordering and verifies that explicit Stop blocks the fallback while internal handoffs still recover.
- Recovery upserts preserve deliberate cancellation from Stop, deletion, settlement, and agent sign-off. Transient recovery cancellation can still be retried.
- Late provider lifecycle events cannot reopen a stopped or interrupted thread without a new server-owned start. The composer releases a held send when Stop is requested while retaining its draft.
- Desktop/web saved connections expose their address and offer an editor using the shared operation already used by mobile. Disconnected version drift is identified as cached, and update actions require a connected environment.
- Background preview automation retains the environment connection even while Settings is open. Hosts register only after the connection is prepared.
- The manual server-update fallback no longer tells Solla users to install upstream npm `t3`.
- Marketing release discovery validates cached/fetched data and fork ownership, handles unavailable browser storage, and reports failed HTTP responses.

## Queued Codex startup investigation

At 19:45:03 UTC, a user message entered durable pending work but was never claimed.
It remained at attempt zero until the user interrupted it at 19:55:30. The next message
was claimed at 19:57:41.704, 63 milliseconds after another Codex thread became ready.
Six long-running Codex obligations occupied the per-provider scheduler limit. The
client incorrectly described pending admission as provider startup.

Explicit user deliveries now bypass the global and provider background caps while
retaining per-thread exclusion and contributing to active capacity. Automatic tasks
and synthetic resumes remain throttled. Web/desktop status distinguishes pending
admission, retry backoff, and admitted startup. The same server admission change
applies to mobile and remote clients without a wire-contract change.

The new regression failed against the old scheduler and passed after the change.
All twelve scheduler tests and six focused status-label tests passed, as did server
and web typechecks and changed-file lint. The resulting 0.1.426 Mac installation
successfully resumed this thread after the guarded update. Saturated-provider
admission is covered by the scheduler regression; a restart alone does not prove
that saturation case. The five README GIFs have since been replaced with
production-client recordings; their sources and limits are documented in the
media workflow.

## Identity and documentation

README, contributor guidance, marketing copy, and project notices now identify Solla as an independent fork. Upstream testimonials, popularity claims, copied operator policies, and unsupported distribution implications were removed. Original license attribution and compatibility identifiers remain. An unused hosted-pairing path and its upstream service default were removed. Channel selection now requires an explicitly configured hosted app. Desktop staging copies the original MIT license into the packaged application.

The documentation index covers the user and architecture guides. Runtime modes, provider status, connection exports, state directories, build commands, update limitations, and relative source links were reconciled with the implementation. README animations use real client recordings with illustrative workspace data; the controlled provider-failover fixture is explicitly identified. Mobile policy links default to this fork's notices rather than upstream policies.

## Removed code

Reference checks identified nine unused modules: mobile GlassSafeAreaView and diffParser; web CreateDelegationDialog, AuthSurfaceShell, fieldset, historyBootstrap, terminalUiStateCleanup, orchestrationEventEffects, and orchestrationRecovery. Tests that referenced only those removed modules were removed with them. Unused marketing testimonial data, rendering helpers, styles, and avatar assets were also removed. Fifteen obsolete interface-reconstruction modules in the motion package and an uncalled Clerk native-passkey staging helper were removed with their obsolete tests. The app no longer depends on that Clerk package. Obsolete passkey signing validation was also removed: it incorrectly required a Clerk tenant and provisioning profile for signed Mac builds of a fork without Clerk sign-in. Electron execution and microphone entitlements remain. Platform-specific modules were retained when they had runtime callers.

## Validation

Focused runs passed 238 tests across cancellation/projection/persistence, interrupt handlers, composer queues, version presentation, connection onboarding, Tailscale pairing, release discovery, and mobile legal URLs. Server, web, mobile, and marketing package typechecks passed. Changed TypeScript files passed lint, and the marketing production build passed. Relative links in README, contributor guidance, and docs were checked against the checkout. Repo-wide test/build gates were not run; CI owns those gates.

## Runtime findings and verification limits

A Windows connection failure was traced to a saved LAN URL while the intended Tailscale HTTP and HTTPS endpoints remained reachable. The Tailscale proxy and desktop-origin preflight were healthy. Reconnect uses the saved address; it does not automatically migrate LAN profiles to Tailscale. A fresh credential was issued through the Windows installation's supported `auth pairing create` command and consumed through the Mac client's connection screen. The existing Windows environment now shows Connected in the installed Mac app, with its HTTPS tailnet address saved for reconnection. No firewall change or app restart was needed.

A production-client Stop exercise used an owned ACP fixture that held a turn open and emitted a late update after cancellation. Stop canceled the running and queued work, returned the session to stopped, and ignored the late update. A new explicit message then completed normally. The exercise was repeated using the installed 0.1.426 server and its bundled web client against disposable state. Both original obligations remained cancelled, the new explicit message completed in the same thread, and the session returned to ready with no active turn or client errors. Evidence is in `output/playwright/product/packaged-stop/result.json` and its stopped/resumed screenshots. The fixture establishes the application path under those controlled conditions, not every provider's native interrupt behavior.

The final focused batch passed 183 tests covering work obligations, the command reactor, Antigravity discovery, provider icons, and desktop artifact helpers. Additional provider protocol, adapter, scheduler, projection, ingestion, connection, and UI checks are recorded in the task evidence. Website validation covered eight routes at three viewport sizes, interaction controls, and a full 72-second movie playback.

A macOS arm64 0.1.426 ZIP was built from the working tree and passed the installer preflight and strict recursive signature verification. Its embedded MIT license matches the repository byte for byte (1,070 bytes). The guarded installer replaced the Mac application and reported a healthy relaunch at 22:24:49 UTC. The installed About screen and running backend both report 0.1.426. Windows reconnected over the saved HTTPS tailnet address after relaunch; its server remains 0.1.425, and the client correctly displays that version difference. The installed connection screen exposes address editing, and background preview automation succeeded while Settings was open. The checks above do not justify a guarantee that Stop succeeds through every external process or network failure.

Antigravity now has a session adapter, provider snapshot, and built-in registration. A real `agy` two-turn adapter test verified delivery and native conversation resume; focused mock tests cover interruption, malformed output, missing executables, and terminal failure. Both Antigravity (`agy` 1.1.24, `gemini-3.8-flash-low`) and OpenCode (CLI 1.18.28, `opencode/big-pickle`) subsequently completed two real turns through the production web client. Each second turn recalled a marker from the first, and each session returned to ready without an active turn. This verifies client delivery and native conversation continuity on this Mac; it is not Windows provider-runtime proof. See [provider status](../providers/README.md).

The inherited standalone service installer and self-update backend still use upstream npm identity. They are documented as upstream paths, not a Solla distribution channel; an owned package and corresponding runtime changes are needed before advertising Solla CLI self-update.
