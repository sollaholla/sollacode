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

## Installed Mac 0.1.492

The final archive completed at 14:27:14 UTC. The guarded installer reported healthy at 14:27:42 UTC. Installed Info.plist reads 0.1.492, and the installed server bundle contains the quota rejection, OAuth choice, alternate code prompt, native acceptance, and project-directory changes. The replacement main process launched with `--auto-resume`; its child backend returned HTTP 200 on port 3773. The source change is committed as `dd889b478`. This installed-artifact and startup check does not establish a successful production AGY turn or completed Google account switch.

## Follow-up for 0.1.493

The 14:35 UTC “Hello” turn did hit the new 429 rejection path, but the scheduler treated it as a generic recoverable failure and cleared the session error when retrying. AGY now emits a durable runtime-error activity before its terminal failure, and explicit AGY quota rejection retires automatic recovery on the first failure. Transient upstream timeout retries remain unchanged.

The real 1.1.28 auth screen says “After authenticating, copy the code displayed in the browser and paste it below,” a third wording missed by 0.1.492. The parser now recognizes that wording, including terminal line wrapping. The native `/usage` probe still prints no email on stdout, but its own diagnostic log confirms identity. A scoped temporary log now supplies only the authenticated email to both provider snapshots and completed account switches; an unsuccessful status command cannot publish an identity.

Verification: 76 tests passed across account auth, driver, adapter, and shared Agent-mode handling, including two opt-in native tests. The real native auth runner reached the code-entry state in a disposable HOME and cancelled; the separate read-only probe detected the current signed-in identity. Five focused scheduler tests passed, including one delivered quota failure and existing transient retry paths. Server typecheck passed. Production-file lint passed with an existing schema-hoisting warning; linting the full legacy reactor test file reports existing manual-Effect-runtime violations outside the added case.

The live native usage check reported Gemini weekly quota at 0%. No additional generation retry or real account switch was attempted. Source/native-process proof is not installed-client or completed-OAuth proof. This server-side correction applies to the existing account controls in desktop and web, including mobile browsers using the updated environment. The separate React Native app does not currently have account-switch controls; it was not verified or changed. Other provider adapters, wire contracts, and connection modes do not change. Windows native runtime remains unverified.

Mac 0.1.493 was installed through `app_update` using standing restart authorization. The guarded installer reported healthy at 14:50:36 UTC. Installed Info.plist confirms 0.1.493; the installed ASAR contains the new code wording, email parser, disposable diagnostic log, terminal-refusal recovery check, and durable AGY error emission. The replacement desktop process launched with `--auto-resume`, its child backend served HTTP 200, and a subsequent health read passed. Source commit: `a7ed2e8f6`. The production Google OAuth exchange and visual account-control readback remain unverified; they require a user sign-in through the new flow.

The final completion audit passed 12 additional existing checks for the rendered account-switch overlay, account indicator, and code-submission helper. These are component/service tests, not browser visual acceptance. Inspection of the installed native CLI confirms its success message is `Authentication successful!`, which the completion parser handles. A successful Google OAuth exchange remains the concrete user-only verification step.

## Truncated OAuth link correction for 0.1.494

The user's Google 404 screenshot exposed a separate defect missed by the 0.1.493 native test: that test checked only the URL prefix. A new native probe recorded the first captured link at 78 characters while AGY's completed OSC 8 hyperlink was 704 characters. The early link contained only `access_type` and an incomplete `client_id`; Solla never replaced it when the rest arrived. This was a parser/output-boundary defect, not proof of a Google account problem.

The parser now prefers completed OSC 8 hyperlink destinations, supports both BEL and ST terminators, ignores incomplete OSC frames, and requires a delivered delimiter before accepting a plain URL. Regression coverage checks every character boundary, including a split ST terminator. The native test independently compares the first published link with the complete CLI hyperlink and checks all required OAuth parameters. It then follows that URL over HTTP while the auth process remains alive: Google returned 200 at its sign-in path, without an error-path redirect. No browser session, credentials, consent, or authorization code was used in this request.

All 13 focused auth tests passed, including the native link/HTTP check and read-only email probe. Targeted lint and server typecheck passed. The production code change is limited to AGY's URL parsing; account state, other providers, and client controls are unchanged. A real user-completed OAuth exchange remains unverified.
