# Antigravity

Solla Code runs Google's `agy` CLI on the environment host. Install and sign in using the [official CLI instructions](https://www.antigravity.google/docs/cli/), then configure the Antigravity provider instance in Settings. Remote environments need their own installation and credentials.

The driver reads the executable version and available models from the installed CLI. Custom models can also be supplied in provider settings. Authentication status is not inferred from executable presence; if a request fails authentication, sign in through the CLI on that host.

## Supported behavior

- Text prompts, streamed assistant output, and tool activity.
- Native conversation resume across turns using the CLI's conversation ID.
- Plan and build interaction modes, with full-access permission bypass only when the thread explicitly selects full access.
- Turn interruption and session shutdown. Solla owns the spawned child and forces termination after a two-second graceful shutdown window.

## Transport limits

The current headless adapter does not support image attachments, live steering, per-task stop, provider-native fork or rollback, interactive approval replies, or auxiliary text generation. The driver advertises these limits through capabilities instead of claiming unsupported operations work.

Solla does not currently inject its thread-scoped MCP tools into `agy`. Existing CLI MCP configuration remains under the CLI's own control. Workflows requiring Solla's agent workspace, collaboration, or artifact MCP tools should use a provider with that integration.

The integration was exercised against `agy` 1.1.24 with `gemini-3.8-flash-low`. Two real turns through the production web client retained conversation context and returned the session to ready after each turn. The adapter also has a separate opt-in live resume test. These checks ran on macOS; they do not establish Windows runtime behavior or replace verification of a new packaged release.

## Focused verification

Run the protocol, runtime mapper, driver, and adapter test files under `apps/server/src/provider`. The adapter's live test is opt-in with `SOLLA_TEST_LIVE_AGY=1`; it invokes the installed CLI and uses a small amount of model quota. Ordinary tests use an owned fixture subprocess and do not call a model.
