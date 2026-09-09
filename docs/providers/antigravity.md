# Antigravity

Solla Code runs Google's `agy` CLI on the environment host. Install and sign in using the [official CLI instructions](https://www.antigravity.google/docs/cli/), then configure the Antigravity provider instance in Settings. Remote environments need their own installation and credentials.

The driver reads the executable version and available models from the installed CLI. Custom models can also be supplied in provider settings. Authentication is verified using the native, non-generating `agy --print /usage` command. Executable presence or a model listing is not authentication proof; a transient status-check failure remains unknown.

## Supported behavior

- Text prompts, streamed assistant output, and tool activity.
- Native conversation resume across turns using the CLI's conversation ID.
- Plan and build interaction modes, with full-access permission bypass only when the thread explicitly selects full access.
- Turn interruption and session shutdown. Solla owns the spawned child and forces termination after a two-second graceful shutdown window.

## Accounts and effort

**Switch user** in the composer account control uses AGY's native Google login. It runs a separate, scoped terminal process in an empty temporary directory, leaving existing provider turns alone. The remote/SSH login flow supplies an authorization link and code entry, so a phone can finish sign-in without opening another browser on the host. Cancellation closes only this auth process. Codes are sent directly to it and are not stored in account-switch state or emitted as tool activity.

Run `agy` on the host once to review its initial terms and optional data-sharing choices. Solla does not accept these for you; an unfinished setup fails before logging out the current account. Gemini API key mode has no Google account to switch and returns an actionable explanation. Solla confirms native login completion and rechecks `/usage` before reporting success. AGY does not report an account email in that command, so the account label is **Google account** rather than an inferred identity.

The model picker shows each native model family once. Its **Effort** selector includes only levels advertised by `agy models`, such as Low/Medium/High for Flash and Low/High for Pro. New selections default to High when supported. Existing saved suffixes such as `gemini-3.8-flash-low` retain Low; an explicit effort choice overrides the suffix. Native models without effort variants keep their existing names and have no invented effort controls.

The account runner and grouped model selection have focused fixture tests against the 1.1.28 command shapes. Native `--model <family> --effort <level> --print /model` resolution was checked without generating a model turn. Fixture authentication success is not proof of a real Google OAuth exchange; that final exchange still requires the account owner's sign-in and one-time CLI setup.

## Transport limits

The current headless adapter does not support image attachments, live steering, per-task stop, provider-native fork or rollback, interactive approval replies, or auxiliary text generation. The driver advertises these limits through capabilities instead of claiming unsupported operations work.

Solla does not currently inject its thread-scoped MCP tools into `agy`. Existing CLI MCP configuration remains under the CLI's own control. Workflows requiring Solla's agent workspace, collaboration, or artifact MCP tools should use a provider with that integration.

The integration was exercised against `agy` 1.1.24 with `gemini-3.8-flash-low`. Two real turns through the production web client retained conversation context and returned the session to ready after each turn. The adapter also has a separate opt-in live resume test. These checks ran on macOS; they do not establish Windows runtime behavior or replace verification of a new packaged release.

## Focused verification

Run the protocol, runtime mapper, driver, and adapter test files under `apps/server/src/provider`. The adapter's live test is opt-in with `SOLLA_TEST_LIVE_AGY=1`; it invokes the installed CLI and uses a small amount of model quota. Ordinary tests use an owned fixture subprocess and do not call a model.
