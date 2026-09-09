# AGY stalled turn and account switching, September 9, 2026

## Incident evidence

The persisted Update Solla Code turn at 14:11 UTC recorded one completed `run_command`, whose default directory was AGY's scratch directory. The native `cli-20260909_101114.log` confirms the backend itself started with the correct project workspace. Immediately after the tool completed, Google returned `RESOURCE_EXHAUSTED (code 429)`. AGY retried seven times with increasing delays until the provider switch stopped its process at 14:15:41 UTC. No completion was emitted during that interval, so subsequent messages remained queued. This was not evidence of lost tool events.

The attached login screenshot uses “paste the authorization code below,” which the old parser did not recognize. A fresh, non-generating native terminal probe also showed `Select login method` with `1. Google OAuth` selected. The old account runner never selected that option. The probe was closed without logging out, entering a code, or changing the account.

The separate invalid-cursor failure follows a persistence defect: an upsert for a new provider without a cursor retained the previous provider's cursor. AGY also returned send acceptance when stdin closed, before its native conversation ID arrived.

## Corrections

- Select the native Google OAuth option and recognize both authorization-code prompts. Keep native completion plus `/usage` as the success gate.
- Clear an omitted cursor when the provider or provider instance changes; preserve it for updates to the same owner.
- Wait for AGY's native user-input receipt before returning delivery acceptance and its conversation cursor.
- Identify the project directory explicitly in the prompt for native command tools.
- On macOS/Linux, route AGY's diagnostic log into its scoped stderr pipe. An explicit model-run quota rejection stops the owned process and emits a visible failed turn. Preserve that rejection ahead of unrelated optional-browser download warnings. Do not publish native diagnostic account details.

## Verification and limits

Focused protocol, runtime, account, and adapter tests passed (71 tests); the new persistent-directory regression passed separately. The quota fixture includes a child that would otherwise retry indefinitely and an unrelated preceding stderr error. Server typecheck and targeted lint passed.

A live AGY 1.1.28 conversation probe on the corrected source received the real quota rejection and emitted the precise `RESOURCE_EXHAUSTED (429)` failure in approximately seven seconds. The successful two-turn/resume test remained failed because Google rejected generation. This proves the live rejection path, not successful model output, tool execution in the intended directory, or a completed account switch. No further generation retries were made after confirming that cause.

No production OAuth exchange or browser interaction was automated. Native login menu and screenshot evidence, plus fixture success/cancellation/rejection coverage, are the authentication proof boundary. Windows log redirection and Windows runtime verification remain open. The changes are server-side and apply to web, desktop, and mobile using the updated environment; attachment and live-steering limits remain unchanged.
