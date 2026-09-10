# Deep Code

Solla Code runs DeepSeek's [Deep Code CLI](https://github.com/lessweb/deepcode-cli) on the environment host. Add the provider instance in Settings, press **Install**, then add a DeepSeek API key. Remote environments need their own installation and `~/.deepcode/settings.json`.

Settings runs the install on the environment host, so the button is the whole step on a remote box too. To do it by hand instead:

```bash
npm install -g @vegamo/deepcode-cli
deepcode --version
```

Create `~/.deepcode/settings.json`:

```json
{
  "env": {
    "MODEL": "deepseek-flash",
    "BASE_URL": "https://api.deepseek.com",
    "API_KEY": "sk-..."
  },
  "thinkingEnabled": true,
  "reasoningEffort": "max"
}
```

Get an API key from the [DeepSeek Platform](https://platform.deepseek.com). The same file is shared with the Deep Code VS Code extension.

## Supported behavior

- Text prompts through `deepcode --exec --prompt`. The CLI prints the final assistant reply when the turn finishes.
- Native session resume across turns using the session UUID Deep Code stores under `~/.deepcode/projects/<projectCode>/sessions-index.json`.
- Per-turn model (`DEEPCODE_MODEL`) and reasoning effort (`DEEPCODE_REASONING_EFFORT`: `low`, `high`, or `max`).
- Turn interruption and session shutdown. Solla owns the spawned child and forces termination after a two-second graceful shutdown window.

The driver probes `deepcode --version` and reads `~/.deepcode/settings.json` (or `DEEPCODE_API_KEY`) for authentication. It never logs the API key. Executable presence is not authentication proof.

## Transport limits

Headless `--exec` cannot confirm permission prompts. Keep `permissions.defaultMode` as `allowAll`, or pre-allow the scopes the agent needs. An `ask` policy fails the turn with Deep Code's exec-mode error.

The current adapter does not support image attachments, live steering, plan-mode toggling, per-task stop, provider-native fork or rollback, interactive approval replies, streamed tool activity, or auxiliary text generation. The driver advertises these limits through capabilities instead of claiming unsupported operations work.

Follow-ups wait for the active turn to finish because exec cannot accept live steering. Solla does not inject its thread-scoped MCP tools into Deep Code; existing CLI MCP configuration remains under the CLI's own control.

Official install notes: [DeepSeek Deep Code integration](https://api-docs.deepseek.com/quick_start/agent_integrations/deepcode/).

## Focused verification

Run the protocol, driver, and adapter test files under `apps/server/src/provider`. Ordinary tests use an owned fixture subprocess and do not call a model.
